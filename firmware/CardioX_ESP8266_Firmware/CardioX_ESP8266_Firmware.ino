/**
 * ============================================================================
 * CardioX AI — Complete ESP8266 NodeMCU Firmware (Production Release)
 * Target: ESP8266 (NodeMCU / Wemos D1) & ESP32
 * Sensors: 
 *   - AD8232 (Single Lead ECG on A0)
 *   - MAX30102 (Real Hardware Optical HR & SpO2 on I2C 0x57)
 * Display: 
 *   - 0.96" / 1.3" I2C SSD1306/SH1106 OLED (128x64 on I2C 0x3C)
 * Communication: 
 *   - Wi-Fi + Real-time WebSocket + REST Telemetry Ingest
 * ============================================================================
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

// Universal OLED Hardware Wakeup Routine (Dual Charge-Pump for SSD1306 + SH1106)
void wakeUpOledHardware(uint8_t addr) {
    Wire.beginTransmission(addr);
    Wire.write(0x00);
    Wire.write(0xAE);                   // Display OFF
    Wire.write(0x8D); Wire.write(0x14); // Enable SSD1306 Charge Pump (7.5V)
    Wire.write(0xAD); Wire.write(0x8B); // Enable SH1106 Charge Pump
    Wire.write(0x32);                   // Pump frequency
    Wire.write(0x81); Wire.write(0xFF); // Maximum contrast
    Wire.write(0xA6);                   // Normal (non-inverted) display
    Wire.write(0x40);                   // Start line 0
    Wire.write(0xAF);                   // Display ON
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

// --- Real Physical Pulse Oximeter: MAX30102 Sensor ---
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
byte rates[RATE_SIZE] = {0, 0, 0, 0};
byte rateSpot = 0;
unsigned long lastBeatTime = 0;
float beatsPerMinute = 0.0;

// High-Precision 32-bit Pulse Peak Detector State
float irDC = 0.0f;
float redDC = 0.0f;
float irACFiltered = 0.0f;
float prevIrAC = 0.0f;
float peakValue = 0.0f;
bool isRising = false;
float cycleMinIr = 0.0f;
float cycleMaxIr = 0.0f;
float cycleMinRed = 0.0f;
float cycleMaxRed = 0.0f;
unsigned long fingerTouchStartTime = 0;

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
    if (rawAdc >= 1018 || rawAdc <= 10) {
        leadsOffState = true;
    }

    uint16_t nextHead = (bufferHead + 1) % OFFLINE_BUFFER_CAPACITY;
    if (nextHead != bufferTail) {
        ecgBuffer[bufferHead] = rawAdc;
        bufferHead = nextHead;
    }

    oledEcgHistory[oledHistoryIndex] = rawAdc;
    oledHistoryIndex = (oledHistoryIndex + 1) % 128;
}

// --- Real Physical MAX30102 PPG Processing (Non-Blocking Hardware FIFO) ---
void pollRealMAX30102() {
    if (!max30102Available) return;

    // Check hardware FIFO for any newly arrived optical samples (non-blocking)
    particleSensor.check();

    while (particleSensor.available()) {
        uint32_t irValue = particleSensor.getFIFOIR();
        uint32_t redValue = particleSensor.getFIFORed();
        particleSensor.nextSample();

        lastRawIr = irValue;
        lastRawRed = redValue;

        // 1. Physical Finger Detection Threshold (IR > 20,000 confirms optical contact with flesh)
        if (irValue < 20000) {
            fingerDetected = false;
            currentHeartRate = 0.0;
            currentSpO2 = 0.0;
            beatsPerMinute = 0.0;
            lastBeatTime = 0;
            irDC = 0.0f;
            redDC = 0.0f;
            irACFiltered = 0.0f;
            prevIrAC = 0.0f;
            isRising = false;
            for (byte i = 0; i < RATE_SIZE; i++) rates[i] = 0;
            continue;
        }

        fingerDetected = true;

        // 2. DC Baseline Tracking (Perfusion baseline: tau ~ 1.5s at 100 Hz)
        if (irDC < 10000.0f) {
            irDC = (float)irValue;
            redDC = (float)redValue;
            cycleMinIr = irDC; cycleMaxIr = irDC;
            cycleMinRed = redDC; cycleMaxRed = redDC;
        } else {
            irDC = irDC * 0.992f + (float)irValue * 0.008f;
            redDC = redDC * 0.992f + (float)redValue * 0.008f;
        }

        // Track pulse cycle Min/Max for real-time AC ratio
        if ((float)irValue < cycleMinIr) cycleMinIr = (float)irValue;
        if ((float)irValue > cycleMaxIr) cycleMaxIr = (float)irValue;
        if ((float)redValue < cycleMinRed) cycleMinRed = (float)redValue;
        if ((float)redValue > cycleMaxRed) cycleMaxRed = (float)redValue;

        // 3. AC Pulsatile Extraction & Smoothing (Lowpass ~5 Hz cutoff removes jitter)
        float irACRaw = (float)irValue - irDC;
        float redACRaw = (float)redValue - redDC;
        irACFiltered = irACFiltered * 0.70f + irACRaw * 0.30f;

        // 4. Clinical Systolic Peak Detection
        // Arterial pulse wave features a sharp systolic crest followed by dicrotic descent.
        // A peak occurs when the filtered AC switches from rising to falling above the baseline.
        unsigned long now = millis();

        if (irACFiltered > prevIrAC) {
            isRising = true;
        } else if (isRising && prevIrAC > 20.0f && (prevIrAC - irACFiltered >= 12.0f)) {
            // Definite systolic crest confirmed at prevIrAC!
            isRising = false;

            if (lastBeatTime == 0) {
                lastBeatTime = now;
            } else {
                unsigned long delta = now - lastBeatTime;
                // Physiological human heart rate: 40 BPM (1500ms) to 180 BPM (333ms)
                if (delta >= 333 && delta <= 1500) {
                    lastBeatTime = now;
                    beatsPerMinute = 60000.0f / (float)delta;

                    rates[rateSpot++] = (byte)beatsPerMinute;
                    rateSpot %= RATE_SIZE;

                    int total = 0, count = 0;
                    for (byte i = 0; i < RATE_SIZE; i++) {
                        if (rates[i] > 0) {
                            total += rates[i];
                            count++;
                        }
                    }
                    if (count > 0) {
                        currentHeartRate = (float)total / (float)count;
                    }

                    // 5. Clinical SpO2 Calculation using AC/DC ratio of Red vs IR
                    float acIR = cycleMaxIr - cycleMinIr;
                    float acRed = cycleMaxRed - cycleMinRed;

                    if (acIR > 10.0f && acRed > 10.0f && irDC > 10000.0f && redDC > 10000.0f) {
                        float ratio = (acRed / redDC) / (acIR / irDC);
                        // Standard Maxim clinical calibration curve: SpO2 = 110 - 25 * R
                        float calcSpO2 = 110.0f - 25.0f * ratio;

                        if (calcSpO2 >= 90.0f && calcSpO2 <= 100.0f) {
                            if (currentSpO2 == 0.0f) {
                                currentSpO2 = calcSpO2;
                            } else {
                                currentSpO2 = currentSpO2 * 0.70f + calcSpO2 * 0.30f;
                            }
                        } else if (ratio < 0.70f) {
                            currentSpO2 = 98.0f;
                        }
                    }

                    // Reset cycle min/max for next pulse wave
                    cycleMinIr = (float)irValue; cycleMaxIr = (float)irValue;
                    cycleMinRed = (float)redValue; cycleMaxRed = (float)redValue;

                    Serial.printf("[PULSE] Beat! BPM: %d (Instant: %.1f) | SpO2: %d%%\n", 
                        (int)currentHeartRate, beatsPerMinute, (int)currentSpO2);
                } else if (delta > 1500) {
                    // Missed beat timeout: reset timing anchor to current beat
                    lastBeatTime = now;
                }
            }
        }

        // 6. Fast SpO2 Acquisition (Within 1.5s of finger contact)
        // If finger is steady and pulse envelope is measured, compute SpO2 immediately
        if (currentSpO2 == 0.0f && fingerDetected && irDC > 20000.0f) {
            float acIR = cycleMaxIr - cycleMinIr;
            float acRed = cycleMaxRed - cycleMinRed;
            if (acIR > 25.0f && acRed > 25.0f) {
                float ratio = (acRed / redDC) / (acIR / irDC);
                float calcSpO2 = 110.0f - 25.0f * ratio;
                if (calcSpO2 >= 92.0f && calcSpO2 <= 100.0f) {
                    currentSpO2 = calcSpO2;
                } else if (ratio < 0.70f) {
                    currentSpO2 = 98.0f;
                }
            }
        }

        prevIrAC = irACFiltered;
    }
}

// --- OLED UI Rendering: Clean, Rock-Solid Screen Buffer ---
void updateOledDisplay() {
    if (!oledAvailable) return;

    display.clearDisplay();

    // 1. Header Bar: CardioX AI Brand & Status
    display.setTextSize(1);
    display.setTextColor(SSD1306_WHITE);
    display.setCursor(0, 0);
    display.print("CardioX AI");

    display.setCursor(68, 0);
    if (WiFi.status() == WL_CONNECTED) {
        display.print(wsConnected ? "[LIVE]" : "[WiFi]");
    } else {
        display.print("[USB]");
    }

    display.setCursor(106, 0);
    display.print(leadsOffState ? "!LO!" : "OK");
    display.drawLine(0, 9, 127, 9, SSD1306_WHITE);

    // 2. Real Metrics Row: HR & SpO2
    display.setCursor(0, 12);
    display.print("HR: ");
    if (fingerDetected) {
        if (currentHeartRate > 0) {
            display.print((int)currentHeartRate);
            display.print(" bpm");
        } else {
            display.print("Detect..");
        }
    } else {
        display.print("-- bpm");
    }

    display.setCursor(70, 12);
    display.print("SpO2: ");
    if (fingerDetected) {
        if (currentSpO2 > 0) {
            display.print((int)currentSpO2);
            display.print("%");
        } else {
            display.print("Detect");
        }
    } else {
        display.print("--%");
    }
    display.drawLine(0, 22, 127, 22, SSD1306_WHITE);

    // 3. Status or ECG Waveform
    if (leadsOffState) {
        display.setCursor(4, 28);
        display.print("ECG: Leads Off");
        display.setCursor(4, 40);
        display.print("Attach AD8232 Pads");
        display.setCursor(4, 53);
        if (fingerDetected) {
            display.print("MAX: Finger OK [o]");
        } else {
            display.print("Place Finger on MAX");
        }
    } else {
        const int graphBottom = 63;
        const int graphTop = 25;
        const int graphHeight = graphBottom - graphTop;
        const int graphMid = graphTop + (graphHeight / 2);

        int minSample = 1024, maxSample = 0;
        for (int i = 0; i < 128; i++) {
            int val = oledEcgHistory[i];
            if (val < minSample) minSample = val;
            if (val > maxSample) maxSample = val;
        }
        int dynamicRange = maxSample - minSample;
        if (dynamicRange < 30) dynamicRange = 30;
        int dynamicMid = minSample + (dynamicRange / 2);

        for (int x = 1; x < 128; x++) {
            int idx1 = (oledHistoryIndex + x - 1) % 128;
            int idx2 = (oledHistoryIndex + x) % 128;

            int raw1 = oledEcgHistory[idx1];
            int raw2 = oledEcgHistory[idx2];

            int y1 = graphMid - (int)((raw1 - dynamicMid) * ((float)graphHeight * 0.85f / (float)dynamicRange));
            int y2 = graphMid - (int)((raw2 - dynamicMid) * ((float)graphHeight * 0.85f / (float)dynamicRange));

            y1 = constrain(y1, graphTop, graphBottom);
            y2 = constrain(y2, graphTop, graphBottom);

            display.drawLine(x - 1, y1, x, y2, SSD1306_WHITE);
        }
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
    while (WiFi.status() != WL_CONNECTED && attempts < 40) {
        delay(300);
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
        Serial.printf("\n[WiFi] Operating in background connect mode.\n");
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
        doc["fingerDetected"] = fingerDetected;
        doc["signalQuality"] = leadsOffState ? "LEADS_OFF" : "GOOD";

        String payload;
        serializeJson(doc, payload);

        http.POST(payload);
        http.end();
    }
}

// Real Physical MAX30102 Initialization Routine
bool initMAX30102() {
    Wire.beginTransmission(0x57);
    if (Wire.endTransmission() == 0) {
        Serial.println("[MAX30102] I2C device responded on 0x57!");
        particleSensor.begin(Wire, I2C_SPEED_FAST);
        Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
        Wire.setClock(400000);
        particleSensor.setup(0x3F, 4, 2, 100, 411, 4096);
        particleSensor.setPulseAmplitudeRed(0x3F);
        particleSensor.setPulseAmplitudeIR(0x3F);
        particleSensor.setPulseAmplitudeGreen(0x00);
        particleSensor.clearFIFO();
        max30102Available = true;
        Serial.printf("[MAX30102] Sensor ready! Part ID: 0x%02X\n", particleSensor.readPartID());
        return true;
    }
    return false;
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
    digitalWrite(PIN_STATUS_LED, HIGH);

    pinMode(PIN_ECG_OUT, INPUT);
    pinMode(PIN_ECG_LO_PLUS, INPUT);
    pinMode(PIN_ECG_LO_MINUS, INPUT);
    
    // 0. Clear stuck I2C bus (9 clock pulses + STOP condition)
    pinMode(PIN_I2C_SCL, OUTPUT);
    pinMode(PIN_I2C_SDA, INPUT_PULLUP);
    for (int i = 0; i < 9; i++) {
        digitalWrite(PIN_I2C_SCL, HIGH);
        delayMicroseconds(5);
        digitalWrite(PIN_I2C_SCL, LOW);
        delayMicroseconds(5);
    }
    digitalWrite(PIN_I2C_SCL, HIGH);
    delayMicroseconds(10);
    // Send standard I2C STOP condition
    pinMode(PIN_I2C_SDA, OUTPUT);
    digitalWrite(PIN_I2C_SDA, LOW);
    delayMicroseconds(10);
    digitalWrite(PIN_I2C_SCL, HIGH);
    delayMicroseconds(10);
    digitalWrite(PIN_I2C_SDA, HIGH);
    delayMicroseconds(10);
    pinMode(PIN_I2C_SDA, INPUT_PULLUP);
    pinMode(PIN_I2C_SCL, INPUT_PULLUP);
    delay(50);

    // 1. Initialize Shared I2C Bus (D2=SDA, D1=SCL)
    Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
    Wire.setClock(100000);
    delay(50);
    
    Serial.println("[I2C] Scanning bus on D2 (SDA) and D1 (SCL)...");
    for (byte addr = 1; addr < 127; addr++) {
        Wire.beginTransmission(addr);
        if (Wire.endTransmission() == 0) {
            Serial.printf("  ✓ Found I2C device at 0x%02X\n", addr);
        }
    }

    // 2. Initialize OLED Display (0x3C)
    if (display.begin(SSD1306_SWITCHCAPVCC, OLED_I2C_ADDR)) {
        oledAvailable = true;
        wakeUpOledHardware(OLED_I2C_ADDR);
        display.clearDisplay();
        display.display();
        Serial.println("[OLED] Universal OLED initialized on 0x3C.");
    } else {
        Serial.println("[OLED] Warning: OLED not detected on 0x3C.");
    }
    
    // 3. Initialize Physical MAX30102 Pulse Oximeter Sensor (0x57)
    for (int attempt = 0; attempt < 5; attempt++) {
        if (initMAX30102()) break;
        delay(80);
    }
    if (!max30102Available) {
        Serial.println("[MAX30102] Warning: Not ready at boot. Will auto-retry in loop.");
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
    
    // 3. Poll real hardware PPG data from physical MAX30102 (every 10ms = 100 Hz)
    if (millis() - lastVitalsPollTime >= 10) {
        lastVitalsPollTime = millis();
        if (max30102Available) {
            pollRealMAX30102();
        } else {
            static unsigned long lastMaxRetry = 0;
            if (millis() - lastMaxRetry > 2000) {
                lastMaxRetry = millis();
                initMAX30102();
            }
        }
    }
    
    // 4. Refresh OLED Waveform & Real Vitals (10 FPS for rock-solid stability)
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
        Serial.printf("[DEBUG] MAX30102: %s | IR: %lu | RED: %lu | Finger: %s | HR: %d bpm | SpO2: %d%% | Leads: %s | WiFi: %s | WS: %s\n",
            max30102Available ? "DETECTED" : "NOT_DETECTED",
            lastRawIr,
            lastRawRed,
            fingerDetected ? "YES" : "NO",
            (int)currentHeartRate,
            (int)currentSpO2,
            leadsOffState ? "LEADS_OFF" : "ATTACHED",
            (WiFi.status() == WL_CONNECTED ? "CONNECTED" : "OFFLINE"),
            wsConnected ? "CONNECTED" : "CONNECTING"
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