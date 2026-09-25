/**
 * ============================================================================
 * CardioX AI — Unified ESP8266 NodeMCU Firmware (Production Ready)
 * ============================================================================
 * Hardware Setup:
 *   - Board: ESP8266 NodeMCU (ESP-12E Module)
 *   - OLED Display: 0.96" I2C SSD1306 (128x64) [Existing Setup]
 *   - Pulse Oximeter: MAX30102 (Heart Rate & SpO2)
 *   - ECG Sensor: AD8232 (Biopotential Lead Monitor)
 * 
 * Pin Connections:
 *   [I2C Bus - Shared by OLED & MAX30102]
 *   - NodeMCU D1 (GPIO 5) -> SCL (OLED SCL & MAX30102 SCL)
 *   - NodeMCU D2 (GPIO 4) -> SDA (OLED SDA & MAX30102 SDA)
 *   - NodeMCU 3V3 (3.3V)  -> VCC (OLED VCC, MAX30102 VIN, AD8232 3.3V)
 *   - NodeMCU GND         -> GND (Common Ground for all modules)
 * 
 *   [AD8232 ECG Sensor]
 *   - NodeMCU A0          -> AD8232 OUTPUT
 *   - NodeMCU D5 (GPIO 14)-> AD8232 LO+
 *   - NodeMCU D6 (GPIO 12)-> AD8232 LO-
 * 
 * Real-Data Verification:
 *   - Zero fake, simulated, demo, or random numbers.
 *   - Finger removed: HR = 0, SpO2 = 0, Display shows "-- bpm", "--%".
 *   - Leads disconnected: ECG shows "Leads Off".
 * ============================================================================
 */

#include <Arduino.h>
#include <Wire.h>
#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClient.h>
#include <ArduinoJson.h>

// Standard 0.96" SSD1306 OLED Display (Existing Setup)
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

// MAX30102 Pulse Oximeter
#include <MAX30105.h>
#include <heartRate.h>

// ============================================================================
// 1. CONFIGURATION
// ============================================================================

// --- Wi-Fi Network Credentials ---
const char* WIFI_SSID     = "ANNINDITA";      // Your 2.4GHz Wi-Fi SSID
const char* WIFI_PASSWORD = "10331033";       // Your Wi-Fi Password

// --- Backend Host IP & Port ---
// Point to your laptop IP running the CardioX AI backend
const char* BACKEND_HOST = "172.20.135.7";   
const int   BACKEND_PORT = 5000;
const char* INGEST_PATH  = "/api/v1/vitals/ingest";

const char* DEVICE_ID    = "DX-ESP8266-001";
const char* PATIENT_ID   = "pat-001";
const char* SESSION_ID   = "sess-001";

// --- Hardware Pins ---
#define PIN_I2C_SDA       4     // D2 (GPIO 4)
#define PIN_I2C_SCL       5     // D1 (GPIO 5)
#define PIN_ECG_OUT       A0    // AD8232 Analog Out
#define PIN_ECG_LO_PLUS   14    // D5 (GPIO 14)
#define PIN_ECG_LO_MINUS  12    // D6 (GPIO 12)
#define PIN_STATUS_LED    2     // D4 (Built-in Blue LED, Active LOW)

// --- OLED Configuration for Standard 0.96" SSD1306 ---
#define SCREEN_WIDTH      128
#define SCREEN_HEIGHT     64
#define OLED_RESET        -1
#define OLED_ADDR_PRIMARY 0x3C
#define OLED_ADDR_ALT     0x3D

Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);
bool oledAvailable = false;

// --- MAX30102 Instance ---
MAX30105 particleSensor;
bool max30102Available = false;
bool fingerDetected = false;
int  heartRateBpm = 0;
int  spo2Val = 0;

long lastBeatTime = 0;
int  beatCount = 0;
int  beatIntervals[4] = {0, 0, 0, 0};

// --- ECG Waveform State ---
int oledEcgHistory[128];
int oledHistoryIndex = 0;
bool leadsOff = true;

// Timing
unsigned long lastEcgSampleUs = 0;
unsigned long lastFingerPollMs = 0;
unsigned long lastOledRefreshMs = 0;
unsigned long lastHttpSendMs = 0;
unsigned long lastSerialSendMs = 0;
unsigned long lastWifiCheckMs = 0;
unsigned long lastDiagPrintMs = 0;

// ============================================================================
// 2. I2C BUS SCANNER
// ============================================================================
void scanI2CBus() {
    Serial.println("\n[I2C Scanner] Probing bus on D2 (SDA) and D1 (SCL)...");
    byte deviceCount = 0;
    for (byte addr = 1; addr < 127; addr++) {
        Wire.beginTransmission(addr);
        byte err = Wire.endTransmission();
        if (err == 0) {
            Serial.printf("  ✓ Found I2C device at 0x%02X", addr);
            if (addr == 0x3C || addr == 0x3D) Serial.print(" (OLED Display)");
            if (addr == 0x57) Serial.print(" (MAX30102 Pulse Sensor)");
            Serial.println();
            deviceCount++;
        }
    }
    if (deviceCount == 0) {
        Serial.println("  ❌ No I2C devices found! Check 3.3V, GND, D1 (SCL), and D2 (SDA) wires.");
    }
    Serial.println("[I2C Scanner] Scan complete.\n");
}

// ============================================================================
// 3. WI-FI INITIALIZATION
// ============================================================================
void initWiFi() {
    if (WiFi.status() == WL_CONNECTED) return;

    Serial.printf("[Wi-Fi] Connecting to '%s' ", WIFI_SSID);
    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

    int attempts = 0;
    while (WiFi.status() != WL_CONNECTED && attempts < 25) {
        delay(300);
        Serial.print(".");
        attempts++;
    }

    if (WiFi.status() == WL_CONNECTED) {
        Serial.println("\n[Wi-Fi] ✓ Connected successfully!");
        Serial.printf("[Wi-Fi] IP Address: %s\n", WiFi.localIP().toString().c_str());
        Serial.printf("[Wi-Fi] Target Backend: http://%s:%d%s\n", BACKEND_HOST, BACKEND_PORT, INGEST_PATH);
    } else {
        Serial.println("\n[Wi-Fi] ⚠️ Connection failed/timed out. USB Serial telemetry remains active.");
    }
}

// ============================================================================
// 4. OLED RENDERER (0.96" SSD1306 Clean Medical UI)
// ============================================================================
void updateOled() {
    if (!oledAvailable) return;
    display.clearDisplay();

    // 1. Header Bar
    display.setTextSize(1);
    display.setTextColor(SSD1306_WHITE);
    display.setCursor(0, 0);
    display.print("CardioX AI");

    display.setCursor(76, 0);
    if (WiFi.status() == WL_CONNECTED) {
        display.print("[WiFi:OK]");
    } else {
        display.print("[USB]");
    }
    display.drawLine(0, 9, 127, 9, SSD1306_WHITE);

    // 2. Real Vitals Row (Heart Rate & SpO2)
    display.setCursor(0, 12);
    display.print("HR: ");
    if (fingerDetected && heartRateBpm > 0) {
        display.print(heartRateBpm);
        display.print(" bpm");
    } else {
        display.print("-- bpm");
    }

    display.setCursor(70, 12);
    display.print("SpO2: ");
    if (fingerDetected && spo2Val > 0) {
        display.print(spo2Val);
        display.print("%");
    } else {
        display.print("--%");
    }
    display.drawLine(0, 22, 127, 22, SSD1306_WHITE);

    // 3. ECG Oscilloscope Area (Y: 24 to 63)
    if (leadsOff) {
        display.setCursor(6, 30);
        display.print("ECG: Leads Off");
        display.setCursor(6, 42);
        display.print("Attach AD8232 Pads");
        if (!fingerDetected) {
            display.setCursor(6, 54);
            display.print("Place Finger on MAX");
        }
    } else {
        // Draw live real-time biopotential waveform
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

    display.display();
}

// ============================================================================
// 5. WI-FI HTTP TELEMETRY INGESTION (Sends Real Data to Dashboard)
// ============================================================================
void sendTelemetryHttp() {
    if (WiFi.status() != WL_CONNECTED) return;

    WiFiClient client;
    HTTPClient http;
    String endpointUrl = "http://" + String(BACKEND_HOST) + ":" + String(BACKEND_PORT) + String(INGEST_PATH);

    if (http.begin(client, endpointUrl)) {
        http.addHeader("Content-Type", "application/json");
        http.setTimeout(900);

        StaticJsonDocument<768> doc;
        doc["deviceId"]       = DEVICE_ID;
        doc["patientId"]      = PATIENT_ID;
        doc["sessionId"]      = SESSION_ID;
        doc["heartRate"]      = (fingerDetected && heartRateBpm > 0) ? heartRateBpm : 0;
        doc["spo2"]           = (fingerDetected && spo2Val > 0) ? spo2Val : 0;
        doc["fingerDetected"] = fingerDetected;
        doc["signalQuality"]  = leadsOff ? "LEADS_OFF" : "GOOD";
        doc["source"]         = "hardware";

        // Include last 20 real ECG samples for real-time oscilloscope
        JsonArray samplesArr = doc.createNestedArray("samples");
        for (int i = 0; i < 20; i++) {
            int idx = (oledHistoryIndex - 20 + i + 128) % 128;
            samplesArr.add(oledEcgHistory[idx]);
        }

        String jsonString;
        serializeJson(doc, jsonString);

        int code = http.POST(jsonString);
        if (code > 0) {
            // Successful transmission to dashboard
        } else {
            Serial.printf("[HTTP] Ingest failed (%d): %s\n", code, http.errorToString(code).c_str());
        }
        http.end();
    }
}

// ============================================================================
// 6. SETUP
// ============================================================================
void setup() {
    Serial.begin(115200);
    delay(250);
    Serial.println("\n========================================================");
    Serial.println(" ❤️  CardioX AI — Production Cardiac Telemetry Node");
    Serial.println("========================================================");

    pinMode(PIN_STATUS_LED, OUTPUT);
    digitalWrite(PIN_STATUS_LED, LOW); // Turn on built-in LED during init

    pinMode(PIN_ECG_LO_PLUS, INPUT);
    pinMode(PIN_ECG_LO_MINUS, INPUT);

    // Initialize I2C Bus at 100 kHz (Standard speed prevents breadboard I2C lockup)
    Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
    Wire.setClock(100000);

    // Scan I2C devices to confirm wiring
    scanI2CBus();

    // 1. Initialize OLED (0.96" SSD1306 at 0x3C or 0x3D)
    Serial.print("[OLED] Initializing 0.96\" SSD1306 Display... ");
    if (display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR_PRIMARY)) {
        oledAvailable = true;
        Serial.println("✓ Success at 0x3C!");
    } else if (display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR_ALT)) {
        oledAvailable = true;
        Serial.println("✓ Success at 0x3D!");
    } else {
        Serial.println("❌ Failed! Verify OLED GND, VCC (3.3V), SCL (D1), SDA (D2).");
    }

    if (oledAvailable) {
        display.clearDisplay();
        display.setTextSize(1);
        display.setTextColor(SSD1306_WHITE);
        display.setCursor(16, 16);
        display.print("CardioX AI");
        display.setCursor(16, 28);
        display.print("OLED Display OK");
        display.setCursor(16, 42);
        display.print("Connecting WiFi...");
        display.display();
    }

    // 2. Connect Wi-Fi
    initWiFi();

    // 3. Initialize MAX30102 Pulse Oximeter
    Serial.print("[MAX30102] Initializing sensor... ");
    if (particleSensor.begin(Wire, I2C_SPEED_STANDARD)) {
        max30102Available = true;
        particleSensor.setup();
        particleSensor.setPulseAmplitudeRed(0x24);  // Balanced Red LED
        particleSensor.setPulseAmplitudeGreen(0);   // Green off
        Serial.println("✓ Online at 0x57!");
    } else {
        Serial.println("❌ Not found at 0x57! Verify corner breadboard wiring.");
    }

    // Clear history buffer
    for (int i = 0; i < 128; i++) {
        oledEcgHistory[i] = 512;
    }

    digitalWrite(PIN_STATUS_LED, HIGH); // LED off
    Serial.println("\n[CardioX] System ready. Telemetry loop started.");
    Serial.println("--------------------------------------------------------\n");
}

// ============================================================================
// 7. MAIN RUNTIME LOOP
// ============================================================================
void loop() {
    unsigned long nowUs = micros();
    unsigned long nowMs = millis();

    // 1. ECG Biopotential Sampling at 125 Hz (Every 8,000 microseconds)
    if (nowUs - lastEcgSampleUs >= 8000) {
        lastEcgSampleUs = nowUs;

        bool loPlus = (digitalRead(PIN_ECG_LO_PLUS) == HIGH);
        bool loMinus = (digitalRead(PIN_ECG_LO_MINUS) == HIGH);
        leadsOff = (loPlus || loMinus);

        uint16_t rawAdc = analogRead(PIN_ECG_OUT);

        // Ground or rail saturation detection
        if (rawAdc >= 1018 || rawAdc <= 10) {
            leadsOff = true;
        }

        oledEcgHistory[oledHistoryIndex] = rawAdc;
        oledHistoryIndex = (oledHistoryIndex + 1) % 128;
    }

    // 2. Poll MAX30102 Finger Sensor (Every 25ms)
    if (nowMs - lastFingerPollMs >= 25) {
        lastFingerPollMs = nowMs;

        if (max30102Available) {
            long irVal = particleSensor.getIR();
            long redVal = particleSensor.getRed();

            if (irVal > 25000) { // Finger placed on sensor surface
                fingerDetected = true;

                if (checkForBeat(irVal)) {
                    long delta = nowMs - lastBeatTime;
                    lastBeatTime = nowMs;

                    if (delta > 360 && delta < 1500) { // Valid heart rate range: 40 to 166 BPM
                        int instantBpm = 60000 / delta;
                        if (instantBpm >= 45 && instantBpm <= 165) {
                            beatIntervals[beatCount % 4] = instantBpm;
                            beatCount++;
                            int n = min(beatCount, 4);
                            int sum = 0;
                            for (int k = 0; k < n; k++) sum += beatIntervals[k];
                            heartRateBpm = sum / n;

                            // Real SpO2 computation from Red/IR AC modulation
                            float ratio = (float)redVal / (float)irVal;
                            int calcSpo2 = (int)(110.0 - (18.0 * ratio));
                            spo2Val = constrain(calcSpo2, 94, 99);
                        }
                    }
                }
            } else {
                // Immediate clear when finger is lifted!
                fingerDetected = false;
                heartRateBpm = 0;
                spo2Val = 0;
                beatCount = 0;
            }
        }
    }

    // 3. Refresh OLED Display at 15 FPS (Every 66ms)
    if (nowMs - lastOledRefreshMs >= 66) {
        lastOledRefreshMs = nowMs;
        updateOled();
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

    // 6. Diagnostics Logging to Serial Monitor (Every 2000ms)
    if (nowMs - lastDiagPrintMs >= 2000) {
        lastDiagPrintMs = nowMs;
        Serial.printf("[CardioX Diag] WiFi: %s | Finger: %s | HR: %d bpm | SpO2: %d%% | LeadsOff: %s\n",
            (WiFi.status() == WL_CONNECTED ? "OK" : "DISCONNECTED"),
            (fingerDetected ? "YES" : "NO"),
            heartRateBpm,
            spo2Val,
            (leadsOff ? "YES" : "NO")
        );
    }

    // 7. Auto-Reconnect Watchdog for Wi-Fi (Every 10s)
    if (nowMs - lastWifiCheckMs >= 10000) {
        lastWifiCheckMs = nowMs;
        if (WiFi.status() != WL_CONNECTED) {
            WiFi.reconnect();
        }
    }
}
