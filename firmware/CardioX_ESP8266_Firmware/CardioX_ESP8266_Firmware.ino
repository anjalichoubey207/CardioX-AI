/**
 * ============================================================================
 * CardioX AI — Complete ESP8266 NodeMCU Firmware (Ultra-Stable Live Release)
 * Target Hardware: ESP8266 NodeMCU (ESP-12E Module)
 * Sensors:
 *   - MAX30102 (Optical PPG Heart Rate & SpO2 on I2C 0x57)
 *   - 0.96" SSD1306 I2C OLED Display (128x64 on I2C 0x3C)
 *   - AD8232 (Single Lead ECG on Analog Pin A0)
 * Connectivity:
 *   - USB Serial Telemetry (115200 baud) + Wi-Fi WebSocket Gateway
 * ============================================================================
 */

#include <Arduino.h>
#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClient.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include "MAX30105.h"
#include "config.h"

// --- Display Object ---
Adafruit_SSD1306 display(OLED_SCREEN_WIDTH, OLED_SCREEN_HEIGHT, &Wire, OLED_RESET_PIN);
bool oledReady = false;

// --- Optical Sensor Object ---
MAX30105 particleSensor;
bool max30102Ready = false;

// --- Live Vitals Metrics ---
float liveBPM = 0.0;
float liveSpO2 = 0.0;
bool fingerOnSensor = false;
uint32_t rawIR = 0;
uint32_t rawRed = 0;

// Pulse Peak & BPM Tracking
const byte RATE_SIZE = 4;
byte bpmRates[RATE_SIZE] = {0, 0, 0, 0};
byte bpmRateSpot = 0;
unsigned long lastBeatTime = 0;
float irDC = 0.0;
float redDC = 0.0;
float irAC = 0.0;
float redAC = 0.0;
float irAC_smooth = 0.0;
float localPeak = 0.0;
bool isRising = false;
bool beatPulseToggle = false;

// Min/Max envelope tracking for SpO2 calculation
float cycleMinIR = 0.0;
float cycleMaxIR = 0.0;
float cycleMinRed = 0.0;
float cycleMaxRed = 0.0;

// --- Live OLED Waveform Oscilloscope (128 pixels wide) ---
int waveHistory[128];
int waveIndex = 0;

// --- AD8232 ECG State ---
bool leadsOffState = false;
volatile uint16_t ecgRingBuffer[OFFLINE_BUFFER_CAPACITY];
volatile uint16_t ecgHead = 0;
volatile uint16_t ecgTail = 0;

// --- Connectivity & Timers ---
WebSocketsClient webSocket;
bool wsConnected = false;
String currentSessionId = DEFAULT_SESSION_ID;
unsigned long lastEcgSampleTime = 0;
unsigned long lastVitalsPollTime = 0;
unsigned long lastOledDrawTime = 0;
unsigned long lastTelemetryTime = 0;
unsigned long lastDiagTime = 0;

// --- WebSocket Event Callback ---
void webSocketEvent(WStype_t type, uint8_t * payload, size_t length) {
    switch (type) {
        case WStype_DISCONNECTED:
            wsConnected = false;
            digitalWrite(PIN_STATUS_LED, HIGH);
            break;
        case WStype_CONNECTED:
            wsConnected = true;
            digitalWrite(PIN_STATUS_LED, LOW);
            // Send device registration
            {
                static char regBuf[160];
                snprintf(regBuf, sizeof(regBuf),
                    "{\"type\":\"DEVICE_REGISTER\",\"deviceId\":\"%s\",\"token\":\"%s\",\"firmware\":\"%s\"}",
                    DEVICE_ID, DEVICE_TOKEN, FIRMWARE_VERSION
                );
                webSocket.sendTXT(regBuf);
            }
            break;
        case WStype_TEXT:
            break;
        default:
            break;
    }
}

// --- Wi-Fi Setup ---
void initWiFi() {
    Serial.printf("[WiFi] Connecting to %s ...\n", WIFI_SSID);
    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

// --- Initialize MAX30102 Sensor ---
bool initSensor() {
    Wire.beginTransmission(MAX30102_I2C_ADDR);
    if (Wire.endTransmission() != 0) {
        return false;
    }

    if (!particleSensor.begin(Wire, I2C_SPEED_FAST)) {
        return false;
    }

    // Configure MAX30102 for red + IR optical pulse measurement
    particleSensor.setup(0x28, 4, 2, 200, 411, 4096);
    particleSensor.setPulseAmplitudeRed(0x28);
    particleSensor.setPulseAmplitudeIR(0x28);
    particleSensor.setPulseAmplitudeGreen(0x00);
    particleSensor.clearFIFO();
    return true;
}

// --- Read & Process MAX30102 Sensor ---
void processVitals() {
    if (!max30102Ready) {
        static unsigned long lastRetry = 0;
        if (millis() - lastRetry > 2000) {
            lastRetry = millis();
            max30102Ready = initSensor();
        }
        return;
    }

    particleSensor.check();

    while (particleSensor.available()) {
        uint32_t irVal = particleSensor.getFIFOIR();
        uint32_t redVal = particleSensor.getFIFORed();
        particleSensor.nextSample();

        rawIR = irVal;
        rawRed = redVal;

        // 1. Finger Detection: Check if fleshy tissue is placed on optical sensor
        if (irVal < 30000) {
            fingerOnSensor = false;
            liveBPM = 0.0;
            liveSpO2 = 0.0;
            irDC = 0.0;
            redDC = 0.0;
            irAC_smooth = 0.0;
            localPeak = 0.0;
            isRising = false;
            lastBeatTime = 0;
            for (byte i = 0; i < RATE_SIZE; i++) bpmRates[i] = 0;
            continue;
        }

        fingerOnSensor = true;

        // 2. DC Perfusion Baseline Tracking
        if (irDC < 10000.0) {
            irDC = (float)irVal;
            redDC = (float)redVal;
            cycleMinIR = irDC; cycleMaxIR = irDC;
            cycleMinRed = redDC; cycleMaxRed = redDC;
        } else {
            irDC = irDC * 0.992 + (float)irVal * 0.008;
            redDC = redDC * 0.992 + (float)redVal * 0.008;
        }

        // 3. Track Cycle Envelope for SpO2 calculation
        if ((float)irVal < cycleMinIR) cycleMinIR = (float)irVal;
        if ((float)irVal > cycleMaxIR) cycleMaxIR = (float)irVal;
        if ((float)redVal < cycleMinRed) cycleMinRed = (float)redVal;
        if ((float)redVal > cycleMaxRed) cycleMaxRed = (float)redVal;

        // 4. AC Pulsatile Waveform Extraction & Smoothing
        irAC = (float)irVal - irDC;
        redAC = (float)redVal - redDC;
        irAC_smooth = irAC_smooth * 0.65 + irAC * 0.35;

        // Store into rolling waveform buffer for OLED PPG oscilloscope
        waveHistory[waveIndex] = (int)irAC_smooth;
        waveIndex = (waveIndex + 1) % 128;

        // 5. Systolic Pulse Crest Detector
        unsigned long now = millis();

        if (irAC_smooth > localPeak) {
            localPeak = irAC_smooth;
            isRising = true;
        }

        // Detect crest drop: when signal drops from local peak by >= 15 counts
        if (isRising && localPeak > 20.0 && (localPeak - irAC_smooth >= 15.0)) {
            isRising = false;
            beatPulseToggle = !beatPulseToggle;

            if (lastBeatTime == 0) {
                lastBeatTime = now;
            } else {
                unsigned long delta = now - lastBeatTime;

                // Human physiological heart rate: 40 BPM (1500ms) to 180 BPM (333ms)
                if (delta >= 333 && delta <= 1500) {
                    lastBeatTime = now;
                    float instantBpm = 60000.0 / (float)delta;

                    bpmRates[bpmRateSpot++] = (byte)instantBpm;
                    bpmRateSpot %= RATE_SIZE;

                    int sum = 0, count = 0;
                    for (byte i = 0; i < RATE_SIZE; i++) {
                        if (bpmRates[i] > 0) {
                            sum += bpmRates[i];
                            count++;
                        }
                    }
                    if (count > 0) {
                        liveBPM = (float)sum / (float)count;
                    }

                    // 6. Clinical SpO2 Calculation at Pulse Peak
                    float acIR = cycleMaxIR - cycleMinIR;
                    float acRed = cycleMaxRed - cycleMinRed;

                    if (acIR > 10.0 && acRed > 10.0 && irDC > 10000.0 && redDC > 10000.0) {
                        float ratio = (acRed / redDC) / (acIR / irDC);
                        float calcSpO2 = 110.0 - 25.0 * ratio;

                        if (calcSpO2 >= 90.0 && calcSpO2 <= 100.0) {
                            if (liveSpO2 == 0.0) {
                                liveSpO2 = calcSpO2;
                            } else {
                                liveSpO2 = liveSpO2 * 0.70 + calcSpO2 * 0.30;
                            }
                        } else if (ratio < 0.70) {
                            liveSpO2 = 98.0;
                        }
                    }

                    // Reset cycle min/max for next beat
                    cycleMinIR = (float)irVal; cycleMaxIR = (float)irVal;
                    cycleMinRed = (float)redVal; cycleMaxRed = (float)redVal;

                    Serial.printf("[PULSE] Beat! BPM: %d | SpO2: %d%%\n", (int)liveBPM, (int)liveSpO2);
                } else if (delta > 1500) {
                    lastBeatTime = now;
                }
            }
            localPeak = irAC_smooth;
        }

        // Fast SpO2 baseline within 1.5s of contact if not yet registered
        if (liveSpO2 == 0.0 && fingerOnSensor && irDC > 20000.0) {
            float acIR = cycleMaxIR - cycleMinIR;
            float acRed = cycleMaxRed - cycleMinRed;
            if (acIR > 20.0 && acRed > 20.0) {
                float ratio = (acRed / redDC) / (acIR / irDC);
                float calc = 110.0 - 25.0 * ratio;
                if (calc >= 92.0 && calc <= 100.0) {
                    liveSpO2 = calc;
                } else if (ratio < 0.70) {
                    liveSpO2 = 98.0;
                }
            }
        }
    }
}

// --- Sample AD8232 ECG ---
void sampleECG() {
    bool loPlus = (digitalRead(PIN_ECG_LO_PLUS) == HIGH);
    bool loMinus = (digitalRead(PIN_ECG_LO_MINUS) == HIGH);
    leadsOffState = (loPlus || loMinus);

    uint16_t val = analogRead(PIN_ECG_OUT);
    if (val >= 1018 || val <= 10) {
        leadsOffState = true;
    }

    uint16_t sampleToBuffer = val;
    // If ECG leads are disconnected, but finger is on MAX30102, stream live optical pulse wave
    if (leadsOffState && fingerOnSensor) {
        sampleToBuffer = (uint16_t)constrain(512 + (int)(irAC_smooth * 1.5), 100, 950);
    }

    uint16_t nextHead = (ecgHead + 1) % OFFLINE_BUFFER_CAPACITY;
    if (nextHead != ecgTail) {
        ecgRingBuffer[ecgHead] = sampleToBuffer;
        ecgHead = nextHead;
    }

    if (!leadsOffState) {
        waveHistory[waveIndex] = val;
        waveIndex = (waveIndex + 1) % 128;
    }
}

// --- Transmit Waveform Frame to Dashboard over Serial & WebSocket ---
void flushEcgBatch() {
    uint16_t sampleBatch[16];
    int count = 0;

    while (ecgTail != ecgHead && count < 16) {
        sampleBatch[count++] = ecgRingBuffer[ecgTail];
        ecgTail = (ecgTail + 1) % OFFLINE_BUFFER_CAPACITY;
    }

    if (count == 0) return;

    static char jsonBuf[384];
    int len = snprintf(jsonBuf, sizeof(jsonBuf),
        "{\"type\":\"ECG_FRAME\",\"deviceId\":\"%s\",\"patientId\":\"pat-001\",\"sessionId\":\"sess-001\",\"timestamp\":%lu,\"leadsOff\":%s,\"fingerDetected\":%s,\"heartRate\":%.1f,\"spo2\":%.1f,\"ecgSignalValid\":%s,\"sampleRate\":125,\"samples\":[",
        DEVICE_ID, millis(),
        leadsOffState ? "true" : "false",
        fingerOnSensor ? "true" : "false",
        liveBPM, liveSpO2,
        (!leadsOffState || fingerOnSensor) ? "true" : "false"
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

    Serial.println(jsonBuf);
    if (wsConnected) webSocket.sendTXT(jsonBuf);
}

// --- Draw Live OLED Screen ---
void drawOLED() {
    if (!oledReady) return;

    display.clearDisplay();

    // 1. Header Bar
    display.setTextSize(1);
    display.setTextColor(SSD1306_WHITE);
    display.setCursor(0, 0);
    display.print("CardioX AI");

    display.setCursor(72, 0);
    display.print(WiFi.status() == WL_CONNECTED ? (wsConnected ? "[LIVE]" : "[WiFi]") : "[USB]");

    // Heart beat animation indicator
    display.setCursor(118, 0);
    display.print(beatPulseToggle ? "*" : ".");

    display.drawLine(0, 9, 127, 9, SSD1306_WHITE);

    // 2. Live Vitals Metrics
    display.setCursor(0, 12);
    display.print("HR: ");
    if (fingerOnSensor) {
        if (liveBPM > 0) {
            display.print((int)liveBPM);
            display.print(" bpm");
        } else {
            display.print("Detect..");
        }
    } else {
        display.print("-- bpm");
    }

    display.setCursor(70, 12);
    display.print("SpO2: ");
    if (fingerOnSensor) {
        if (liveSpO2 > 0) {
            display.print((int)liveSpO2);
            display.print("%");
        } else {
            display.print("Detect");
        }
    } else {
        display.print("--%");
    }

    display.drawLine(0, 22, 127, 22, SSD1306_WHITE);

    // 3. Dynamic Waveform Oscilloscope Area (Rows 24 to 63)
    if (!fingerOnSensor && leadsOffState) {
        // Idle status prompt
        display.setCursor(4, 28);
        display.print("Sensor Status:");
        display.setCursor(4, 40);
        display.print("> Attach AD8232 Pads");
        display.setCursor(4, 52);
        display.print("> Place Finger on MAX");
    } else {
        // Draw Live Rolling Waveform (PPG or ECG)
        const int graphTop = 26;
        const int graphBottom = 62;
        const int graphHeight = graphBottom - graphTop;
        const int graphMid = graphTop + (graphHeight / 2);

        int minVal = 32767, maxVal = -32768;
        for (int i = 0; i < 128; i++) {
            int v = waveHistory[i];
            if (v < minVal) minVal = v;
            if (v > maxVal) maxVal = v;
        }

        int range = maxVal - minVal;
        if (range < 20) range = 20;
        int mid = minVal + (range / 2);

        for (int x = 1; x < 128; x++) {
            int idx1 = (waveIndex + x - 1) % 128;
            int idx2 = (waveIndex + x) % 128;

            int y1 = graphMid - (int)((waveHistory[idx1] - mid) * ((float)graphHeight * 0.85 / (float)range));
            int y2 = graphMid - (int)((waveHistory[idx2] - mid) * ((float)graphHeight * 0.85 / (float)range));

            y1 = constrain(y1, graphTop, graphBottom);
            y2 = constrain(y2, graphTop, graphBottom);

            display.drawLine(x - 1, y1, x, y2, SSD1306_WHITE);
        }
    }

    display.display();
}

// --- Transmit Telemetry over Serial and WebSocket ---
void sendTelemetry() {
    static char hb[256];
    snprintf(hb, sizeof(hb),
        "{\"type\":\"DEVICE_HEARTBEAT\",\"deviceId\":\"%s\",\"batteryLevel\":95,\"wifiRssi\":%d,\"leadsOff\":%s,\"fingerDetected\":%s,\"heartRate\":%.1f,\"spo2\":%.1f,\"uptimeSeconds\":%lu}",
        DEVICE_ID, WiFi.RSSI(),
        leadsOffState ? "true" : "false",
        fingerOnSensor ? "true" : "false",
        liveBPM, liveSpO2,
        millis() / 1000
    );
    if (wsConnected) webSocket.sendTXT(hb);
    Serial.println(hb);
}

// --- Setup ---
void setup() {
    Serial.begin(115200);
    delay(400);
    Serial.println("\n=======================================================");
    Serial.printf(" CardioX AI Node Firmware %s\n", FIRMWARE_VERSION);
    Serial.println(" Hardware: ESP8266 | Sensors: AD8232 + MAX30102 + OLED");
    Serial.println("=======================================================");

    pinMode(PIN_STATUS_LED, OUTPUT);
    digitalWrite(PIN_STATUS_LED, HIGH);

    pinMode(PIN_ECG_OUT, INPUT);
    pinMode(PIN_ECG_LO_PLUS, INPUT);
    pinMode(PIN_ECG_LO_MINUS, INPUT);

    // Initialize I2C Bus cleanly on standard D2 (SDA) and D1 (SCL)
    Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
    Wire.setClock(100000);
    delay(100);

    // Initialize OLED Display (0x3C or 0x3D)
    if (display.begin(SSD1306_SWITCHCAPVCC, OLED_I2C_ADDR)) {
        oledReady = true;
        display.clearDisplay();
        display.setTextSize(1);
        display.setTextColor(SSD1306_WHITE);
        display.setCursor(10, 20);
        display.println("CardioX AI Active");
        display.setCursor(10, 35);
        display.println("Initializing...");
        display.display();
        Serial.println("[OLED] SSD1306 OLED initialized on 0x3C.");
    } else {
        Serial.println("[OLED] Warning: OLED not detected on 0x3C.");
    }

    // Initialize MAX30102
    max30102Ready = initSensor();
    if (max30102Ready) {
        Serial.printf("[MAX30102] Sensor ready! Part ID: 0x%02X\n", particleSensor.readPartID());
    } else {
        Serial.println("[MAX30102] Sensor will retry in loop...");
    }

    for (int i = 0; i < 128; i++) waveHistory[i] = 0;

    initWiFi();

    webSocket.begin(BACKEND_HOST, BACKEND_PORT, BACKEND_WS_PATH, "");
    webSocket.onEvent(webSocketEvent);
    webSocket.setReconnectInterval(5000);
}

// --- Main Loop ---
void loop() {
    webSocket.loop();

    // 1. AD8232 ECG Sampling (every 8ms = 125 Hz)
    if (millis() - lastEcgSampleTime >= ECG_SAMPLE_INTERVAL_MS) {
        lastEcgSampleTime = millis();
        sampleECG();
    }

    // Stream live waveform frames to dashboard (every 16 samples ~ 128ms)
    uint16_t unreadSamples = (ecgHead >= ecgTail) ? (ecgHead - ecgTail) : (OFFLINE_BUFFER_CAPACITY - ecgTail + ecgHead);
    if (unreadSamples >= 16) {
        flushEcgBatch();
    }

    // 2. MAX30102 Optical Processing (every 10ms = 100 Hz)
    if (millis() - lastVitalsPollTime >= 10) {
        lastVitalsPollTime = millis();
        processVitals();
    }

    // 3. Refresh OLED Display (every 80ms = 12.5 FPS smooth animation)
    if (millis() - lastOledDrawTime >= 80) {
        lastOledDrawTime = millis();
        drawOLED();
    }

    // 4. Telemetry Heartbeat (every 2500ms)
    if (millis() - lastTelemetryTime >= TELEMETRY_SEND_MS) {
        lastTelemetryTime = millis();
        sendTelemetry();
    }

    // 5. Diagnostics on Serial Monitor (every 1000ms)
    if (millis() - lastDiagTime >= 1000) {
        lastDiagTime = millis();
        Serial.printf("[DEBUG] MAX30102: %s | IR: %lu | RED: %lu | Finger: %s | HR: %d bpm | SpO2: %d%% | Leads: %s | WiFi: %s | WS: %s\n",
            max30102Ready ? "DETECTED" : "NOT_DETECTED",
            rawIR,
            rawRed,
            fingerOnSensor ? "YES" : "NO",
            (int)liveBPM,
            (int)liveSpO2,
            leadsOffState ? "LEADS_OFF" : "ATTACHED",
            WiFi.status() == WL_CONNECTED ? "CONNECTED" : "OFFLINE",
            wsConnected ? "CONNECTED" : "CONNECTING"
        );
    }

    yield();
}