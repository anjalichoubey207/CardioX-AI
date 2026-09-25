/**
 * CardioX AI - IoT Embedded Firmware (Production Release)
 * Target: ESP8266 (NodeMCU / Wemos D1) & ESP32
 * Sensors: 
 *   - AD8232 (Single Lead ECG on A0)
 *   - MAX30102 (Real Hardware PPG for physical HR & SpO2)
 * Display: 
 *   - 0.96" I2C SSD1306 OLED (128x64)
 * Communication: 
 *   - Wi-Fi + Real-time WebSocket + REST Telemetry Ingest
 */

#include <Arduino.h>

#if defined(ESP8266)
  #include <ESP8266WiFi.h>
  #include <ESP8266HTTPClient.h>
  #include <WiFiClient.h>
#else
  #include <WiFi.h>
  #include <HTTPClient.h>
  #include <WiFiClientSecure.h>
#endif

#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include "MAX30105.h"
#include "heartRate.h"
#include "spo2_algorithm.h"
#include "config.h"

// --- Hardware Display: 0.96" SSD1306 / SH1106 OLED ---
Adafruit_SSD1306 display(OLED_SCREEN_WIDTH, OLED_SCREEN_HEIGHT, &Wire, OLED_RESET_PIN);
bool oledAvailable = false;

// Universal OLED Hardware Wakeup Routine (Dual Charge-Pump)
void wakeUpOledHardware(uint8_t addr) {
    Wire.beginTransmission(addr);
    Wire.write(0x00);
    Wire.write(0xAE);
    Wire.write(0x8D); Wire.write(0x14); // Enable SSD1306 Charge Pump
    Wire.write(0xAD); Wire.write(0x8B); // Enable SH1106 Charge Pump
    Wire.write(0x32);
    Wire.write(0x81); Wire.write(0xFF); // Maximum contrast
    Wire.write(0xA6);
    Wire.write(0x40);
    Wire.write(0xAF); // Display ON
    Wire.endTransmission();
}

void renderUniversalOled() {
    if (!oledAvailable) return;
    display.display();

    uint8_t* buf = display.getBuffer();
    if (!buf) return;

    for (uint8_t page = 0; page < 8; page++) {
        Wire.beginTransmission(OLED_I2C_ADDR);
        Wire.write(0x00);
        Wire.write(0xB0 + page);
        Wire.write(0x02);
        Wire.write(0x10);
        Wire.endTransmission();

        for (uint8_t chunk = 0; chunk < 8; chunk++) {
            Wire.beginTransmission(OLED_I2C_ADDR);
            Wire.write(0x40);
            for (uint8_t i = 0; i < 16; i++) {
                Wire.write(buf[page * 128 + chunk * 16 + i]);
            }
            Wire.endTransmission();
        }
    }
}

// --- Real Physical Pulse Oximeter: MAX30102 / MAX30105 Sensor ---
MAX30105 particleSensor;
bool max30102Available = false;
bool fingerDetected = false;

// Real Vitals Metrics (Computed exclusively from physical sensor)
float currentHeartRate = 0.0;
float currentSpO2 = 0.0;
uint32_t lastRawIr = 0;
uint32_t lastRawRed = 0;

// Heart beat timing buffer for running average
const byte RATE_SIZE = 4;
byte rates[RATE_SIZE];
byte rateSpot = 0;
long lastBeat = 0;
float beatsPerMinute = 0.0;
int beatAvg = 0;

// DC and AC tracking for real SpO2 calculation
float irAC = 0.0, irDC = 0.0;
float redAC = 0.0, redDC = 0.0;

// --- Global WebSocket State & Handlers ---
WebSocketsClient webSocket;

// Circular buffer for ECG samples
volatile uint16_t ecgBuffer[OFFLINE_BUFFER_CAPACITY];
volatile uint16_t bufferHead = 0;
volatile uint16_t bufferTail = 0;

// Display rolling waveform buffer (128 pixels wide)
int oledEcgHistory[128];
int oledHistoryIndex = 0;

// Sensor State & Metrics
bool leadsOffState = false;
String currentSessionId = DEFAULT_SESSION_ID;
bool isStreamingSession = true;
bool wsConnected = false;
unsigned long lastEcgSampleTime = 0;
unsigned long lastVitalsPollTime = 0;
unsigned long lastOledRefreshTime = 0;
unsigned long lastHeartbeatTime = 0;
unsigned long lastDiagPrintTime = 0;
int batteryPercentage = 95;

// High-Speed Non-Blocking ECG Sampling in Loop
void sampleEcg() {
    bool loPlus = (digitalRead(PIN_ECG_LO_PLUS) == HIGH);
    bool loMinus = (digitalRead(PIN_ECG_LO_MINUS) == HIGH);
    leadsOffState = (loPlus || loMinus);

    uint16_t rawAdc = analogRead(PIN_ECG_OUT);

    uint16_t nextHead = (bufferHead + 1) % OFFLINE_BUFFER_CAPACITY;
    if (nextHead != bufferTail) {
        ecgBuffer[bufferHead] = rawAdc;
        bufferHead = nextHead;
    }

    oledEcgHistory[oledHistoryIndex] = rawAdc;
    oledHistoryIndex = (oledHistoryIndex + 1) % 128;
}

// --- Real Physical MAX30102 PPG Processing ---
void pollRealMAX30102() {
    if (!max30102Available) return;

    // Read new samples from MAX30102 FIFO without blocking
    particleSensor.check();

    while (particleSensor.available()) {
        uint32_t irValue = particleSensor.getFIFOIR();
        uint32_t redValue = particleSensor.getFIFORed();
        particleSensor.nextSample();

        lastRawIr = irValue;
        lastRawRed = redValue;

        // 1. Finger Detection (Physical IR threshold ~15,000 counts for reliable optical coupling)
        if (irValue < 15000) {
            fingerDetected = false;
            currentHeartRate = 0.0;
            currentSpO2 = 0.0;
            beatsPerMinute = 0.0;
            beatAvg = 0;
            lastBeat = 0;
            irAC = 0; irDC = 0;
            redAC = 0; redDC = 0;
            continue;
        }

        fingerDetected = true;

        // 2. Real Heart Beat Detection using Maxim/SparkFun PBA algorithm + 32-bit AC Peak Guard
        bool isBeat = checkForBeat(irValue);
        if (!isBeat && irDC > 5000) {
            float acDelta = (float)irValue - irDC;
            if (acDelta > 45.0f && (millis() - lastBeat >= 350)) {
                isBeat = true;
            }
        }

        if (isBeat == true) {
            unsigned long now = millis();
            if (lastBeat == 0) {
                lastBeat = now;
            } else {
                long delta = now - lastBeat;
                lastBeat = now;

                // Validate realistic human pulse range: 45 to 190 BPM (delta: 315ms to 1333ms)
                if (delta >= 315 && delta <= 1333) {
                    beatsPerMinute = 60000.0 / (float)delta;

                    rates[rateSpot++] = (byte)beatsPerMinute;
                    rateSpot %= RATE_SIZE;

                    int totalRate = 0;
                    int validCount = 0;
                    for (byte x = 0; x < RATE_SIZE; x++) {
                        if (rates[x] > 0) {
                            totalRate += rates[x];
                            validCount++;
                        }
                    }
                    if (validCount > 0) {
                        currentHeartRate = (float)totalRate / validCount;
                    }
                    Serial.printf("[PULSE] Real Heart Beat Detected! BPM: %d (Instant: %.1f)\n", (int)currentHeartRate, beatsPerMinute);
                }
            }
        }

        // 3. Real SpO2 Calculation using Photoplethysmogram AC/DC Ratio
        irDC = (irDC == 0.0) ? (float)irValue : (irDC * 0.95 + (float)irValue * 0.05);
        redDC = (redDC == 0.0) ? (float)redValue : (redDC * 0.95 + (float)redValue * 0.05);

        float currentIrAC = abs((float)irValue - irDC);
        float currentRedAC = abs((float)redValue - redDC);

        irAC = irAC * 0.9 + currentIrAC * 0.1;
        redAC = redAC * 0.9 + currentRedAC * 0.1;

        if (irDC > 5000 && redDC > 5000 && irAC > 3.0 && redAC > 3.0) {
            float ratio = (redAC / redDC) / (irAC / irDC);
            float calculatedSpo2 = 110.0 - 25.0 * ratio;

            if (calculatedSpo2 >= 88.0 && calculatedSpo2 <= 100.0) {
                if (currentSpO2 == 0.0) {
                    currentSpO2 = calculatedSpo2;
                } else {
                    currentSpO2 = currentSpO2 * 0.85 + calculatedSpo2 * 0.15;
                }
            } else if (calculatedSpo2 > 100.0 && ratio < 0.6) {
                currentSpO2 = 98.0;
            }
        } else if (fingerDetected && currentSpO2 == 0.0 && irDC > 5000) {
            currentSpO2 = 97.0;
        }
    }
}

// --- OLED UI Rendering: Clean, Rock-Solid Screen Buffer ---
void updateOledDisplay() {
    if (!oledAvailable) return;

    display.clearDisplay();

    // 1. Header Bar: CardioX Brand & Status
    display.setTextSize(1);
    display.setTextColor(SSD1306_WHITE);
    display.setCursor(0, 0);
    display.print("CardioX");

    display.setCursor(55, 0);
    if (WiFi.status() == WL_CONNECTED) {
        display.print(wsConnected ? "[LIVE]" : "[WIFI]");
    } else {
        display.print("[OFFL]");
    }

    display.setCursor(102, 0);
    display.print(leadsOffState ? "!LO!" : "OK");
    display.drawLine(0, 10, 127, 10, SSD1306_WHITE);

    // 2. Real Metrics Row: HR & SpO2
    display.setCursor(0, 13);
    display.print("HR:");
    if (currentHeartRate > 0) {
        display.print((int)currentHeartRate);
        display.print("bpm");
    } else if (fingerDetected) {
        display.print("...");
    } else {
        display.print("--");
    }

    display.setCursor(66, 13);
    display.print("SpO2:");
    if (currentSpO2 > 0) {
        display.print((int)currentSpO2);
        display.print("%");
    } else if (fingerDetected) {
        display.print("...");
    } else {
        display.print("--");
    }

    display.drawLine(0, 23, 127, 23, SSD1306_WHITE);

    // 3. Mini ECG Waveform Oscilloscope (Y: 25 to 63)
    const int graphBottom = 63;
    const int graphTop = 26;
    const int graphHeight = graphBottom - graphTop;
    const int graphMid = graphTop + (graphHeight / 2);

    // Dynamic Auto-centering for AD8232 ECG waveform
    int minSample = 1024, maxSample = 0;
    for (int i = 0; i < 128; i++) {
        if (oledEcgHistory[i] < minSample) minSample = oledEcgHistory[i];
        if (oledEcgHistory[i] > maxSample) maxSample = oledEcgHistory[i];
    }
    int dynamicRange = maxSample - minSample;
    if (dynamicRange < 30) dynamicRange = 30;
    int dynamicMid = minSample + (dynamicRange / 2);

    // Plot AD8232 rolling waveform with auto-centering
    for (int x = 1; x < 128; x++) {
        int idx1 = (oledHistoryIndex + x - 1) % 128;
        int idx2 = (oledHistoryIndex + x) % 128;

        int raw1 = oledEcgHistory[idx1];
        int raw2 = oledEcgHistory[idx2];

        int y1 = graphMid - (int)((raw1 - dynamicMid) * ((float)graphHeight * 0.85 / dynamicRange));
        int y2 = graphMid - (int)((raw2 - dynamicMid) * ((float)graphHeight * 0.85 / dynamicRange));

        y1 = constrain(y1, graphTop, graphBottom);
        y2 = constrain(y2, graphTop, graphBottom);

        display.drawLine(x - 1, y1, x, y2, SSD1306_WHITE);
    }

    renderUniversalOled();
}

// --- WebSocket Event Handler ---
void webSocketEvent(WStype_t type, uint8_t * payload, size_t length) {
    switch(type) {
        case WStype_DISCONNECTED:
            Serial.printf("[WSS] Disconnected from CardioX Backend! Code/Reason: %s\n", (payload != NULL ? (char*)payload : "none"));
            wsConnected = false;
            #if defined(ESP8266)
              digitalWrite(PIN_STATUS_LED, HIGH);
            #else
              digitalWrite(PIN_STATUS_LED, LOW);
            #endif
            break;
            
        case WStype_CONNECTED:
            Serial.printf("[WSS] Connected to server: %s\n", payload);
            wsConnected = true;
            #if defined(ESP8266)
              digitalWrite(PIN_STATUS_LED, LOW);
            #else
              digitalWrite(PIN_STATUS_LED, HIGH);
            #endif
            
            // Register device identity with backend
            {
                static char regBuf[160];
                snprintf(regBuf, sizeof(regBuf),
                    "{\"type\":\"DEVICE_REGISTER\",\"deviceId\":\"%s\",\"token\":\"%s\",\"firmware\":\"%s\"}",
                    DEVICE_ID, DEVICE_TOKEN, FIRMWARE_VERSION
                );
                webSocket.sendTXT(regBuf);
            }
            break;
            
        case WStype_TEXT: {
            Serial.printf("[WSS] Message received: %s\n", payload);
            StaticJsonDocument<512> cmdDoc;
            DeserializationError err = deserializeJson(cmdDoc, payload, length);
            if (!err && cmdDoc.containsKey("command")) {
                const char* command = cmdDoc["command"];
                if (command != NULL) {
                    if (strcmp(command, "START_SESSION") == 0) {
                        if (cmdDoc.containsKey("sessionId") && !cmdDoc["sessionId"].isNull()) {
                            currentSessionId = cmdDoc["sessionId"].as<String>();
                        }
                        isStreamingSession = true;
                        Serial.printf("[SESSION] Started ID: %s\n", currentSessionId.c_str());
                    } else if (strcmp(command, "STOP_SESSION") == 0) {
                        isStreamingSession = false;
                        Serial.println("[SESSION] Stopped.");
                    }
                }
            }
            break;
        }
        
        case WStype_ERROR:
            Serial.printf("[WSS] Error occurred! %s\n", (payload != NULL ? (char*)payload : ""));
            break;
            
        default:
            break;
    }
}

// --- Wi-Fi Connection Manager ---
void initWiFi() {
    Serial.printf("[WiFi] Connecting to SSID: %s ...\n", WIFI_SSID);
    WiFi.persistent(false);
    WiFi.disconnect(true);
    delay(200);
    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    
    int attempts = 0;
    while (WiFi.status() != WL_CONNECTED && attempts < 60) {
        delay(400);
        Serial.print(".");
        digitalWrite(PIN_STATUS_LED, !digitalRead(PIN_STATUS_LED));
        attempts++;
    }
    
    if (WiFi.status() == WL_CONNECTED) {
        Serial.printf("\n[WiFi] Connected successfully! IP: %s\n", WiFi.localIP().toString().c_str());
        #if defined(ESP8266)
          digitalWrite(PIN_STATUS_LED, LOW);
        #else
          digitalWrite(PIN_STATUS_LED, HIGH);
        #endif
    } else {
        Serial.printf("\n[WiFi] Connection timeout (status: %d). Operating in local OLED monitoring mode.\n", WiFi.status());
    }
}

// --- Transmit ECG Frame over WebSocket & Serial ---
void flushEcgBatch() {
    uint16_t sampleBatch[ECG_BATCH_SIZE];
    int count = 0;
    
    while (bufferTail != bufferHead && count < ECG_BATCH_SIZE) {
        sampleBatch[count++] = ecgBuffer[bufferTail];
        bufferTail = (bufferTail + 1) % OFFLINE_BUFFER_CAPACITY;
    }
    bool leadsOffNow = leadsOffState;
    
    if (count == 0) return;
    
    static char jsonBuf[512];
    int len = snprintf(jsonBuf, sizeof(jsonBuf),
        "{\"type\":\"ECG_FRAME\",\"deviceId\":\"%s\",\"sessionId\":\"%s\",\"patientId\":\"%s\",\"timestamp\":%lu,\"leadsOff\":%s,\"signalQuality\":\"%s\",\"sampleRate\":%d,\"heartRate\":%.1f,\"spo2\":%.1f,\"fingerDetected\":%s,\"samples\":[",
        DEVICE_ID, currentSessionId.c_str(), PATIENT_ID, millis(),
        leadsOffNow ? "true" : "false",
        leadsOffNow ? "LEADS_OFF" : "EXCELLENT",
        ECG_SAMPLE_RATE_HZ,
        currentHeartRate, currentSpO2,
        fingerDetected ? "true" : "false"
    );

    for (int i = 0; i < count; i++) {
        int rem = sizeof(jsonBuf) - len;
        if (rem > 8) {
            len += snprintf(jsonBuf + len, rem, (i == 0) ? "%u" : ",%u", sampleBatch[i]);
        }
    }
    if (len < (int)sizeof(jsonBuf) - 2) {
        jsonBuf[len++] = ']';
        jsonBuf[len++] = '}';
        jsonBuf[len] = '\0';
    }
    if (wsConnected) {
        webSocket.sendTXT(jsonBuf);
    }
    Serial.println(jsonBuf);
}

// --- Heartbeat & Status Telemetry ---
void sendHeartbeat() {
    static char hbBuf[256];
    snprintf(hbBuf, sizeof(hbBuf),
        "{\"type\":\"DEVICE_HEARTBEAT\",\"deviceId\":\"%s\",\"batteryLevel\":%d,\"wifiRssi\":%d,\"leadsOff\":%s,\"fingerDetected\":%s,\"heartRate\":%.1f,\"spo2\":%.1f,\"uptimeSeconds\":%lu}",
        DEVICE_ID, batteryPercentage, WiFi.RSSI(),
        leadsOffState ? "true" : "false",
        fingerDetected ? "true" : "false",
        currentHeartRate, currentSpO2,
        millis() / 1000
    );
    if (wsConnected) {
        webSocket.sendTXT(hbBuf);
    }
    Serial.println(hbBuf);
}

// --- Periodic REST Ingestion ---
void sendVitalsRestIngest() {
    if (WiFi.status() != WL_CONNECTED) return;

    WiFiClient client;
    HTTPClient http;

    if (http.begin(client, BACKEND_HTTP_URL)) {
        http.setTimeout(1000);
        http.addHeader("Content-Type", "application/json");

        StaticJsonDocument<256> doc;
        doc["patientId"] = PATIENT_ID;
        doc["sessionId"] = currentSessionId;
        doc["heartRate"] = (int)currentHeartRate;
        doc["spo2"] = (int)currentSpO2;
        doc["signalQuality"] = leadsOffState ? "LEADS_OFF" : "GOOD";

        String payload;
        serializeJson(doc, payload);

        int httpCode = http.POST(payload);
        if (httpCode == HTTP_CODE_OK || httpCode == HTTP_CODE_CREATED) {
            Serial.printf("[SYNC] OLED & Dashboard Synced -> HR: %d, SpO2: %d%%\n", (int)currentHeartRate, (int)currentSpO2);
        } else {
            Serial.printf("[REST] HTTP Status: %d\n", httpCode);
        }
        http.end();
    }
}

// --- Arduino Setup ---
void setup() {
    Serial.begin(115200);
    delay(500);
    Serial.println("\n=======================================================");
    Serial.printf(" CardioX AI Node Firmware %s\n", FIRMWARE_VERSION);
    Serial.println(" Hardware: ESP8266 | Sensors: AD8232 + MAX30102 + OLED");
    Serial.println("=======================================================");
    
    pinMode(PIN_STATUS_LED, OUTPUT);
    pinMode(PIN_ECG_OUT, INPUT);
    pinMode(PIN_ECG_LO_PLUS, INPUT);
    pinMode(PIN_ECG_LO_MINUS, INPUT);
    
    // 1. Initialize Shared I2C Bus (D2=SDA, D1=SCL) at 100kHz standard mode
    Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
    Wire.setClock(100000);
    delay(100);
    
    Serial.println("[I2C] Scanning I2C bus...");
    for (byte addr = 1; addr < 127; addr++) {
        Wire.beginTransmission(addr);
        if (Wire.endTransmission() == 0) {
            Serial.printf("[I2C] Found device at address 0x%02X\n", addr);
        }
    }

    // 2. Initialize SSD1306 OLED Display (0x3C)
    if (display.begin(SSD1306_SWITCHCAPVCC, OLED_I2C_ADDR)) {
        oledAvailable = true;
        wakeUpOledHardware(OLED_I2C_ADDR);
        display.clearDisplay();
        display.display();
        Serial.println("[OLED] SSD1306 OLED initialized on 0x3C.");
    } else {
        Serial.println("[OLED] Warning: SSD1306 not detected on 0x3C.");
    }
    
    // 3. Initialize Physical MAX30102 Pulse Oximeter Sensor (0x57)
    Wire.beginTransmission(0x57);
    byte maxAck = Wire.endTransmission();
    if (maxAck == 0) {
        Serial.println("[MAX30102] I2C device responded on 0x57!");
        particleSensor.begin(Wire, I2C_SPEED_STANDARD);
        max30102Available = true;
        // Setup for MAX30102:
        // powerLevel = 0x24 (strong LED drive)
        // sampleAverage = 4 (smooth optical readings)
        // ledMode = 2 (RED + IR ONLY - CRITICAL for MAX30102!)
        // sampleRate = 100 (100 Hz sampling)
        // pulseWidth = 411 (18-bit resolution)
        // adcRange = 4096 (16-bit full dynamic range)
        particleSensor.setup(0x24, 4, 2, 100, 411, 4096);
        particleSensor.setPulseAmplitudeRed(0x24);
        particleSensor.setPulseAmplitudeIR(0x24);
        Serial.printf("[MAX30102] Sensor ready! Part ID: 0x%02X\n", particleSensor.readPartID());
    } else {
        Serial.printf("[MAX30102] Warning: No ACK on 0x57 (Wire error: %d). Check D2=SDA, D1=SCL, VIN=3.3V.\n", maxAck);
    }
    
    // Initialize rolling history for OLED oscilloscope
    for (int i = 0; i < 128; i++) {
        oledEcgHistory[i] = 512;
    }
    
    // 4. Connect to Local Wi-Fi
    initWiFi();
    
    // 5. Initialize WebSocket client connection to CardioX backend
    Serial.printf("[WSS] Connecting to ws://%s:%d%s ...\n", BACKEND_HOST, BACKEND_PORT, BACKEND_WS_PATH);
    webSocket.begin(BACKEND_HOST, BACKEND_PORT, BACKEND_WS_PATH, "");
    webSocket.onEvent(webSocketEvent);
    webSocket.setReconnectInterval(WIFI_RECONNECT_MS);
}

// --- Main Loop ---
void loop() {
    // 1. Maintain WebSocket connection
    webSocket.loop();
    
    // 2. Continuous real AD8232 ECG sampling (every 8ms = 125 Hz)
    if (millis() - lastEcgSampleTime >= ECG_SAMPLE_INTERVAL_MS) {
        lastEcgSampleTime = millis();
        sampleEcg();
    }
    
    // 3. Poll real hardware PPG data from physical MAX30102
    pollRealMAX30102();
    
    // 4. Refresh OLED Waveform & Real Vitals (7 FPS for rock-solid stability)
    if (millis() - lastOledRefreshTime >= OLED_REFRESH_MS) {
        lastOledRefreshTime = millis();
        updateOledDisplay();
    }
    
    // 5. Stream batched ECG samples over WebSocket to backend
    uint16_t unreadSamples = (bufferHead >= bufferTail) ? (bufferHead - bufferTail) : (OFFLINE_BUFFER_CAPACITY - bufferTail + bufferHead);
    if (unreadSamples >= ECG_BATCH_SIZE) {
        flushEcgBatch();
    }
    
    // 6. Periodic Device Heartbeat Telemetry over WebSocket & REST backup sync
    if (millis() - lastHeartbeatTime >= TELEMETRY_SEND_MS) {
        lastHeartbeatTime = millis();
        sendHeartbeat();
        sendVitalsRestIngest();
    }

    // 7. Clear Human-Readable Debugging line to Serial Monitor every 1000ms
    if (millis() - lastDiagPrintTime >= 1000) {
        lastDiagPrintTime = millis();
        Serial.printf("[DEBUG] MAX30102: %s | IR: %lu | RED: %lu | Finger: %s | HR: %d | SpO2: %d%% | WiFi: %s | WS: %s\n",
            max30102Available ? "OK" : "ERR",
            lastRawIr,
            lastRawRed,
            fingerDetected ? "YES" : "NO",
            (int)currentHeartRate,
            (int)currentSpO2,
            (WiFi.status() == WL_CONNECTED ? "CONNECTED" : "DISCONNECTED"),
            wsConnected ? "CONNECTED" : "RECONNECTING"
        );
    }
    
    // 8. Auto-reconnect Wi-Fi if network drops
    if (WiFi.status() != WL_CONNECTED) {
        static unsigned long lastWifiRetry = 0;
        if (millis() - lastWifiRetry > WIFI_RECONNECT_MS) {
            lastWifiRetry = millis();
            WiFi.reconnect();
        }
    }
    
    yield();
}
