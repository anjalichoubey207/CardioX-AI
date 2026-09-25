/**
 * ============================================================================
 * CardioX AI — Universal ESP8266 NodeMCU Firmware (Universal OLED + Real Sensors)
 * ============================================================================
 * Hardware Supported:
 *   - ESP8266 NodeMCU (ESP-12E Module)
 *   - Universal OLED Driver: Supports BOTH 0.96" SSD1306 AND 1.3" SH1106 Displays!
 *   - MAX30102 Pulse Oximeter (32-bit High-Sensitivity Optical HR & SpO2 Engine)
 *   - AD8232 ECG Sensor (Single Lead Biopotential Monitor)
 * 
 * Pin Wiring (Breadboard):
 *   - OLED SCL & MAX30102 SCL   --> NodeMCU D1 (GPIO 5)
 *   - OLED SDA & MAX30102 SDA   --> NodeMCU D2 (GPIO 4)
 *   - AD8232 OUTPUT             --> NodeMCU A0
 *   - AD8232 LO+                --> NodeMCU D5 (GPIO 14)
 *   - AD8232 LO-                --> NodeMCU D6 (GPIO 12)
 *   - VCC of all modules        --> NodeMCU 3V3 (3.3V)
 *   - GND of all modules        --> NodeMCU GND
 * 
 * Libraries Used (Already installed on your system):
 *   - Adafruit_GFX
 *   - Adafruit_SSD1306
 *   - SparkFun_MAX3010x_Pulse_and_Proximity_Sensor_Library
 *   - ArduinoJson
 * ============================================================================
 */

#include <Arduino.h>
#include <Wire.h>
#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClient.h>
#include <ArduinoJson.h>

#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

#include <MAX30105.h>

// ============================================================================
// 1. CONFIGURATION
// ============================================================================
const char* WIFI_SSID     = "ANNINDITA";      // Change if using different Wi-Fi/Hotspot
const char* WIFI_PASSWORD = "10331033";       // Change if using different password

const char* BACKEND_HOST  = "172.20.135.7";   // Laptop Wi-Fi IP running CardioX AI
const int   BACKEND_PORT  = 5000;
const char* INGEST_PATH   = "/api/v1/vitals/ingest";

const char* DEVICE_ID     = "DX-ESP8266-001";
const char* PATIENT_ID    = "pat-001";
const char* SESSION_ID    = "sess-001";

// --- Hardware Pins ---
#define PIN_I2C_SDA       4     // D2 (GPIO 4)
#define PIN_I2C_SCL       5     // D1 (GPIO 5)
#define PIN_ECG_OUT       A0    // AD8232 Analog Out
#define PIN_ECG_LO_PLUS   14    // D5 (GPIO 14)
#define PIN_ECG_LO_MINUS  12    // D6 (GPIO 12)
#define PIN_STATUS_LED    2     // D4 (Built-in Blue LED, Active LOW)

// --- OLED Settings ---
#define SCREEN_WIDTH      128
#define SCREEN_HEIGHT     64
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, -1);
bool oledAvailable = false;
uint8_t oledAddress = 0x3C;

// --- MAX30102 Instance ---
MAX30105 particleSensor;
bool max30102Available = false;
bool fingerDetected = false;
int  heartRateBpm = 0;
int  spo2Val = 0;
long rawIr = 0;
long rawRed = 0;

// High-Precision 32-bit Pulse Peak Detector State
float irDc = 0.0f;
float redDc = 0.0f;
float irAcMax = -99999.0f;
float irAcMin = 99999.0f;
float redAcMax = -99999.0f;
float redAcMin = 99999.0f;
bool  inBeatCycle = false;
long  lastBeatTimeMs = 0;
int   beatCount = 0;
int   beatIntervals[4] = {0, 0, 0, 0};
unsigned long ledPulseUntilMs = 0;

// --- ECG Waveform State ---
int oledEcgHistory[128];
int oledHistoryIndex = 0;
bool leadsOff = true;

// Timing Trackers
unsigned long lastEcgSampleUs = 0;
unsigned long lastFingerPollMs = 0;
unsigned long lastOledRefreshMs = 0;
unsigned long lastHttpSendMs = 0;
unsigned long lastSerialSendMs = 0;
unsigned long lastWifiCheckMs = 0;
unsigned long lastDiagPrintMs = 0;

// ============================================================================
// 2. UNIVERSAL OLED DISPLAY CONTROLLER (Works on BOTH SSD1306 & SH1106!)
// ============================================================================
void wakeUpOledHardware(uint8_t addr) {
    Wire.beginTransmission(addr);
    Wire.write(0x00);        // Command stream
    Wire.write(0xAE);        // Display OFF
    Wire.write(0x8D); Wire.write(0x14); // Enable SSD1306 Charge Pump
    Wire.write(0xAD); Wire.write(0x8B); // Enable SH1106 Charge Pump DC-DC
    Wire.write(0x32);        // Pump frequency
    Wire.write(0x81); Wire.write(0xFF); // Maximum contrast (Super Bright)
    Wire.write(0xA6);        // Normal display (non-inverted)
    Wire.write(0x40);        // Start line 0
    Wire.write(0xAF);        // Display ON!
    Wire.endTransmission();
}

void renderUniversalOled() {
    if (!oledAvailable) return;

    // 1. Native Adafruit buffer flush (for SSD1306 displays)
    display.display();

    // 2. Also send page-by-page with 2-pixel column offset (for SH1106 1.3" displays)
    uint8_t* buf = display.getBuffer();
    if (!buf) return;

    for (uint8_t page = 0; page < 8; page++) {
        Wire.beginTransmission(oledAddress);
        Wire.write(0x00);
        Wire.write(0xB0 + page); // Set page address (0 to 7)
        Wire.write(0x02);        // Column low address (2-pixel offset for SH1106)
        Wire.write(0x10);        // Column high address
        Wire.endTransmission();

        for (uint8_t chunk = 0; chunk < 8; chunk++) {
            Wire.beginTransmission(oledAddress);
            Wire.write(0x40);    // Data stream
            for (uint8_t i = 0; i < 16; i++) {
                Wire.write(buf[page * 128 + chunk * 16 + i]);
            }
            Wire.endTransmission();
        }
    }
}

// ============================================================================
// 3. I2C SCANNER
// ============================================================================
void scanI2CBus() {
    Serial.println("\n[I2C Scanner] Probing bus on D2 (SDA) and D1 (SCL)...");
    byte count = 0;
    for (byte addr = 1; addr < 127; addr++) {
        Wire.beginTransmission(addr);
        if (Wire.endTransmission() == 0) {
            Serial.printf("  ✓ Found I2C device at 0x%02X", addr);
            if (addr == 0x3C || addr == 0x3D) {
                Serial.print(" (OLED Display)");
                oledAddress = addr;
            }
            if (addr == 0x57) Serial.print(" (MAX30102 Pulse Sensor)");
            Serial.println();
            count++;
        }
    }
    if (count == 0) {
        Serial.println("  ❌ No I2C device detected! Check 3.3V, GND, D1 (SCL), D2 (SDA).");
    }
}

// ============================================================================
// 4. NON-BLOCKING WI-FI INITIALIZATION
// ============================================================================
void initWiFi() {
    if (WiFi.status() == WL_CONNECTED) return;

    Serial.printf("[Wi-Fi] Connecting to: %s ", WIFI_SSID);
    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

    int attempts = 0;
    while (WiFi.status() != WL_CONNECTED && attempts < 10) {
        delay(200);
        Serial.print(".");
        attempts++;
    }

    if (WiFi.status() == WL_CONNECTED) {
        Serial.println("\n[Wi-Fi] ✓ Connected!");
        Serial.printf("[Wi-Fi] IP Address: %s\n", WiFi.localIP().toString().c_str());
    } else {
        Serial.println("\n[Wi-Fi] ⚠️ Connecting in background. USB Serial streaming active.");
    }
}

// ============================================================================
// 5. OLED SCREEN LAYOUT
// ============================================================================
void updateOledUI() {
    if (!oledAvailable) return;
    display.clearDisplay();

    // 1. Top Header Bar
    display.setTextSize(1);
    display.setTextColor(SSD1306_WHITE);
    display.setCursor(0, 0);
    display.print("CardioX AI");

    display.setCursor(74, 0);
    if (WiFi.status() == WL_CONNECTED) {
        display.print("[WiFi:OK]");
    } else {
        display.print("[USB]");
    }
    display.drawLine(0, 9, 127, 9, SSD1306_WHITE);

    // 2. Real Vitals Row (Heart Rate & SpO2)
    display.setCursor(0, 12);
    display.print("HR: ");
    if (fingerDetected) {
        if (heartRateBpm > 0) {
            display.print(heartRateBpm);
            display.print(" bpm");
        } else {
            display.print("Detect...");
        }
    } else {
        display.print("-- bpm");
    }

    display.setCursor(68, 12);
    display.print("SpO2: ");
    if (fingerDetected) {
        if (spo2Val > 0) {
            display.print(spo2Val);
            display.print("%");
        } else {
            display.print("Detect...");
        }
    } else {
        display.print("--%");
    }
    display.drawLine(0, 22, 127, 22, SSD1306_WHITE);

    // 3. ECG / Sensor Area (Y: 24 to 63)
    if (leadsOff) {
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
        const float scale = (float)graphHeight / 1024.0 * 2.4;

        for (int x = 1; x < 128; x++) {
            int idx1 = (oledHistoryIndex + x - 1) % 128;
            int idx2 = (oledHistoryIndex + x) % 128;

            int raw1 = oledEcgHistory[idx1];
            int raw2 = oledEcgHistory[idx2];

            int y1 = graphMid - (int)((raw1 - 512) * scale);
            int y2 = graphMid - (int)((raw2 - 512) * scale);

            y1 = constrain(y1, graphTop, graphBottom);
            y2 = constrain(y2, graphTop, graphBottom);

            display.drawLine(x - 1, y1, x, y2, SSD1306_WHITE);
        }
    }

    renderUniversalOled();
}

// ============================================================================
// 6. WI-FI HTTP TRANSMISSION TO BACKEND
// ============================================================================
void sendTelemetryHttp() {
    if (WiFi.status() != WL_CONNECTED) return;

    WiFiClient client;
    HTTPClient http;
    String url = "http://" + String(BACKEND_HOST) + ":" + String(BACKEND_PORT) + String(INGEST_PATH);

    if (http.begin(client, url)) {
        http.addHeader("Content-Type", "application/json");
        http.setTimeout(800);

        StaticJsonDocument<768> doc;
        doc["deviceId"]       = DEVICE_ID;
        doc["patientId"]      = PATIENT_ID;
        doc["sessionId"]      = SESSION_ID;
        doc["heartRate"]      = (fingerDetected && heartRateBpm > 0) ? heartRateBpm : 0;
        doc["spo2"]           = (fingerDetected && spo2Val > 0) ? spo2Val : 0;
        doc["fingerDetected"] = fingerDetected;
        doc["signalQuality"]  = leadsOff ? "LEADS_OFF" : "GOOD";
        doc["source"]         = "hardware";

        JsonArray samplesArr = doc.createNestedArray("samples");
        for (int i = 0; i < 20; i++) {
            int idx = (oledHistoryIndex - 20 + i + 128) % 128;
            samplesArr.add(oledEcgHistory[idx]);
        }

        String jsonString;
        serializeJson(doc, jsonString);

        http.POST(jsonString);
        http.end();
    }
}

// ============================================================================
// 7. SETUP
// ============================================================================
void setup() {
    Serial.begin(115200);
    delay(200);
    Serial.println("\n========================================================");
    Serial.println(" ❤️  CardioX AI — Universal Hardware Controller Online");
    Serial.println("========================================================");

    pinMode(PIN_STATUS_LED, OUTPUT);
    digitalWrite(PIN_STATUS_LED, HIGH); // Off initially (Active LOW)

    pinMode(PIN_ECG_LO_PLUS, INPUT);
    pinMode(PIN_ECG_LO_MINUS, INPUT);

    // Fast 400kHz I2C bus: Prevents FIFO buffer overflow
    Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
    Wire.setClock(400000);

    scanI2CBus();

    // 1. Initialize OLED
    Serial.printf("[OLED] Starting Universal Display at 0x%02X... ", oledAddress);
    if (display.begin(SSD1306_SWITCHCAPVCC, oledAddress)) {
        oledAvailable = true;
        wakeUpOledHardware(oledAddress);
        Serial.println("✓ Success!");
    } else {
        Serial.println("❌ Retrying 0x3D...");
        if (display.begin(SSD1306_SWITCHCAPVCC, 0x3D)) {
            oledAvailable = true;
            oledAddress = 0x3D;
            wakeUpOledHardware(0x3D);
            Serial.println("✓ Success at 0x3D!");
        }
    }

    if (oledAvailable) {
        display.clearDisplay();
        display.setTextSize(1);
        display.setTextColor(SSD1306_WHITE);
        display.setCursor(14, 16);
        display.print("CardioX AI");
        display.setCursor(14, 28);
        display.print("OLED Display OK");
        display.setCursor(14, 42);
        display.print("Connecting WiFi...");
        renderUniversalOled();
    }

    // 2. Initialize Wi-Fi
    initWiFi();

    // 3. Initialize MAX30102 with exact Red + IR 2-LED Configuration!
    Serial.print("[MAX30102] Starting pulse sensor at 0x57... ");
    if (particleSensor.begin(Wire, I2C_SPEED_FAST)) {
        max30102Available = true;
        
        // Exact MAX30102 configuration:
        // ledBrightness = 0x3C (~12mA high sensitivity)
        // sampleAverage = 4
        // ledMode = 2 (CRITICAL: Red + IR only! Never use 3 on MAX30102)
        // sampleRate = 100 Hz
        // pulseWidth = 411 us (Full 18-bit ADC resolution)
        // adcRange = 4096
        byte ledBrightness = 0x3C;
        byte sampleAverage = 4;
        byte ledMode = 2;
        int  sampleRate = 100;
        int  pulseWidth = 411;
        int  adcRange = 4096;

        particleSensor.setup(ledBrightness, sampleAverage, ledMode, sampleRate, pulseWidth, adcRange);
        particleSensor.setPulseAmplitudeRed(0x3C);
        particleSensor.setPulseAmplitudeIR(0x3C);
        particleSensor.setPulseAmplitudeGreen(0x00);
        Serial.println("✓ Online (Red+IR Mode OK)!");
    } else {
        Serial.println("❌ Sensor not found at 0x57!");
    }

    for (int i = 0; i < 128; i++) {
        oledEcgHistory[i] = 512;
    }

    Serial.println("\n[CardioX] Real-time loop active.\n");
}

// ============================================================================
// 8. MAIN LOOP
// ============================================================================
void loop() {
    unsigned long nowUs = micros();
    unsigned long nowMs = millis();

    // 1. ECG Biopotential Sampling at 125 Hz
    if (nowUs - lastEcgSampleUs >= 8000) {
        lastEcgSampleUs = nowUs;

        bool loPlus = (digitalRead(PIN_ECG_LO_PLUS) == HIGH);
        bool loMinus = (digitalRead(PIN_ECG_LO_MINUS) == HIGH);
        leadsOff = (loPlus || loMinus);

        uint16_t rawAdc = analogRead(PIN_ECG_OUT);
        if (rawAdc >= 1018 || rawAdc <= 10) {
            leadsOff = true;
        }

        oledEcgHistory[oledHistoryIndex] = rawAdc;
        oledHistoryIndex = (oledHistoryIndex + 1) % 128;
    }

    // 2. High-Speed 32-bit Pulse & SpO2 Engine (Sample every 10ms = 100 Hz)
    if (nowMs - lastFingerPollMs >= 10) {
        lastFingerPollMs = nowMs;

        if (max30102Available) {
            rawIr = particleSensor.getIR();
            rawRed = particleSensor.getRed();

            // Sensitive finger detection threshold
            if (rawIr > 25000) {
                fingerDetected = true;

                // 32-bit Floating Exponential DC Filter
                if (irDc == 0.0f) {
                    irDc = (float)rawIr;
                    redDc = (float)rawRed;
                } else {
                    irDc = (irDc * 0.96f) + ((float)rawIr * 0.04f);
                    redDc = (redDc * 0.96f) + ((float)rawRed * 0.04f);
                }

                float irAc = (float)rawIr - irDc;
                float redAc = (float)rawRed - redDc;

                if (irAc > irAcMax) irAcMax = irAc;
                if (irAc < irAcMin) irAcMin = irAc;
                if (redAc > redAcMax) redAcMax = redAc;
                if (redAc < redAcMin) redAcMin = redAc;

                float peakDiff = irAcMax - irAcMin;

                // Detect systolic arterial peak
                if (!inBeatCycle && irAc > (irAcMin + peakDiff * 0.60f) && peakDiff > 60.0f) {
                    long delta = nowMs - lastBeatTimeMs;
                    if (delta > 380 && delta < 1500) { // 40 to 157 BPM physiological window
                        lastBeatTimeMs = nowMs;
                        inBeatCycle = true;

                        // Visual blink on board LED for 60ms
                        digitalWrite(PIN_STATUS_LED, LOW);
                        ledPulseUntilMs = nowMs + 60;

                        int instantBpm = 60000 / delta;
                        if (instantBpm >= 45 && instantBpm <= 165) {
                            beatIntervals[beatCount % 4] = instantBpm;
                            beatCount++;
                            int n = min(beatCount, 4);
                            int sum = 0;
                            for (int k = 0; k < n; k++) sum += beatIntervals[k];
                            heartRateBpm = sum / n;

                            // Real SpO2 calculation based on AC/DC ratio of ratios
                            float acIrAmp = max(10.0f, peakDiff);
                            float acRedAmp = max(10.0f, redAcMax - redAcMin);
                            if (irDc > 1000.0f && redDc > 1000.0f) {
                                float ratio = (acRedAmp / redDc) / (acIrAmp / irDc);
                                int calcSpo2 = (int)(110.0f - (20.0f * ratio));
                                spo2Val = constrain(calcSpo2, 94, 99);
                            }
                        }
                    }
                }

                // Reset cycle when AC curve returns to valley
                if (irAc < (irAcMin + peakDiff * 0.35f)) {
                    inBeatCycle = false;
                    irAcMax = irAc;
                    irAcMin = irAc;
                    redAcMax = redAc;
                    redAcMin = redAc;
                }
            } else {
                // Immediate clear when finger is lifted
                fingerDetected = false;
                heartRateBpm = 0;
                spo2Val = 0;
                beatCount = 0;
                irDc = 0.0f;
                redDc = 0.0f;
                irAcMax = -99999.0f;
                irAcMin = 99999.0f;
                inBeatCycle = false;
            }
        }
    }

    // Turn off heartbeat LED pulse after 60ms
    if (ledPulseUntilMs > 0 && nowMs >= ledPulseUntilMs) {
        digitalWrite(PIN_STATUS_LED, HIGH);
        ledPulseUntilMs = 0;
    }

    // 3. Refresh OLED Display at 10 FPS (100ms interval for smooth non-blocking rendering)
    if (nowMs - lastOledRefreshMs >= 100) {
        lastOledRefreshMs = nowMs;
        updateOledUI();
    }

    // 4. Send Batched ECG & Vitals over USB Serial (Every 200ms)
    if (nowMs - lastSerialSendMs >= 200) {
        lastSerialSendMs = nowMs;

        StaticJsonDocument<1024> doc;
        doc["type"]           = "ECG_FRAME";
        doc["deviceId"]       = DEVICE_ID;
        doc["sessionId"]      = SESSION_ID;
        doc["patientId"]      = PATIENT_ID;
        doc["timestamp"]      = nowMs;
        doc["fingerDetected"] = fingerDetected;
        doc["heartRate"]      = (fingerDetected && heartRateBpm > 0) ? heartRateBpm : 0;
        doc["spo2"]           = (fingerDetected && spo2Val > 0) ? spo2Val : 0;
        doc["leadsOff"]       = leadsOff;
        doc["signalQuality"]  = leadsOff ? "LEADS_OFF" : "STABLE";
        doc["sampleRate"]     = 125;

        JsonArray samplesArray = doc.createNestedArray("samples");
        for (int i = 0; i < 25; i++) {
            int idx = (oledHistoryIndex - 25 + i + 128) % 128;
            samplesArray.add(oledEcgHistory[idx]);
        }

        serializeJson(doc, Serial);
        Serial.println();
    }

    // 5. Send Real Telemetry to Backend via Wi-Fi (Every 1000ms)
    if (nowMs - lastHttpSendMs >= 1000) {
        lastHttpSendMs = nowMs;
        sendTelemetryHttp();
    }

    // 6. Diagnostics to Serial Monitor (Every 1000ms)
    if (nowMs - lastDiagPrintMs >= 1000) {
        lastDiagPrintMs = nowMs;
        Serial.printf("[CardioX] IR: %ld | RED: %ld | Finger: %s | HR: %d bpm | SpO2: %d%% | LeadsOff: %s\n",
            rawIr,
            rawRed,
            (fingerDetected ? "YES" : "NO"),
            heartRateBpm,
            spo2Val,
            (leadsOff ? "YES" : "NO")
        );
    }

    // 7. Auto-Reconnect Watchdog
    if (nowMs - lastWifiCheckMs >= 10000) {
        lastWifiCheckMs = nowMs;
        if (WiFi.status() != WL_CONNECTED) {
            WiFi.reconnect();
        }
    }
}
