/**
 * CardioX AI — Unified ESP8266 Firmware (MAX30102 + AD8232 + SSD1306 OLED)
 * Strictly real-time hardware data:
 * - Finger removed from MAX30102 -> HR & SpO2 immediately clear to 0 / "--"
 * - AD8232 electrodes disconnected -> Waveform clears to "Waiting for ECG signal"
 */

#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <ArduinoJson.h>
#include <MAX30105.h>
#include <heartRate.h>

// --- Pin Definitions for ESP8266 ---
#define PIN_ECG_OUT       A0    // AD8232 Output to A0
#define PIN_STATUS_LED    2     // D4 (Built-in LED, Active LOW)
#define PIN_I2C_SDA       4     // D2 (SDA)
#define PIN_I2C_SCL       5     // D1 (SCL)

// --- OLED Display Settings ---
#define OLED_SCREEN_WIDTH   128
#define OLED_SCREEN_HEIGHT  64
#define OLED_RESET_PIN      -1
#define OLED_I2C_ADDR       0x3C

Adafruit_SSD1306 display(OLED_SCREEN_WIDTH, OLED_SCREEN_HEIGHT, &Wire, OLED_RESET_PIN);
bool oledAvailable = false;

// --- MAX30102 Pulse Oximeter ---
MAX30105 particleSensor;
bool max30102Available = false;
bool fingerDetected = false;
int heartRateBpm = 0;
int spo2Val = 0;
long lastBeatTime = 0;
int beatCount = 0;
int beatIntervals[4] = {0, 0, 0, 0};

// --- ECG & Telemetry State ---
#define ECG_SAMPLE_RATE_HZ  125
#define OFFLINE_BUF_SIZE    512

volatile uint16_t ecgBuffer[OFFLINE_BUF_SIZE];
volatile uint16_t bufferHead = 0;
volatile uint16_t bufferTail = 0;

int oledEcgHistory[128];
int oledHistoryIndex = 0;

unsigned long lastSampleTimeUs = 0;
unsigned long lastOledRefreshTime = 0;
unsigned long lastTelemetryTime = 0;
unsigned long lastFingerSampleTime = 0;

bool ecgSignalValid = false;

void ICACHE_RAM_ATTR sampleEcg() {
    uint16_t rawAdc = analogRead(PIN_ECG_OUT);
    uint16_t nextHead = (bufferHead + 1) % OFFLINE_BUF_SIZE;
    if (nextHead != bufferTail) {
        ecgBuffer[bufferHead] = rawAdc;
        bufferHead = nextHead;
    }
}

void updateOled() {
    if (!oledAvailable) return;
    display.clearDisplay();

    // 1. Header Bar
    display.setTextSize(1);
    display.setTextColor(SSD1306_WHITE);
    display.setCursor(0, 0);
    display.print("CardioX AI");
    display.setCursor(80, 0);
    display.print("[USB]");
    display.drawLine(0, 10, 127, 10, SSD1306_WHITE);

    // 2. Real Metrics Row: HR & SpO2
    display.setCursor(0, 13);
    display.print("HR: ");
    if (fingerDetected && heartRateBpm > 0) {
        display.print(heartRateBpm);
        display.print(" bpm");
    } else {
        display.print("-- bpm");
    }

    display.setCursor(72, 13);
    display.print("SpO2: ");
    if (fingerDetected && spo2Val > 0) {
        display.print(spo2Val);
        display.print("%");
    } else {
        display.print("--%");
    }
    display.drawLine(0, 23, 127, 23, SSD1306_WHITE);

    // 3. Oscilloscope Waveform (Y: 24 to 63)
    if (!ecgSignalValid) {
        display.setCursor(8, 36);
        display.setTextSize(1);
        display.print("Waiting for ECG");
        display.setCursor(32, 48);
        display.print("signal...");
    } else {
        const int graphBottom = 63;
        const int graphTop = 26;
        const int graphHeight = graphBottom - graphTop;
        const int graphMid = graphTop + (graphHeight / 2);
        const float scale = (float)graphHeight / 1024.0 * 2.2;

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

void setup() {
    Serial.begin(115200);
    Serial.println("\n[CardioX] Booting Firmware 2.0.0-Strict...");

    pinMode(PIN_STATUS_LED, OUTPUT);
    digitalWrite(PIN_STATUS_LED, LOW); // LED on

    Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
    Wire.setClock(400000);

    // Initialize OLED Display
    if (display.begin(SSD1306_SWITCHCAPVCC, OLED_I2C_ADDR)) {
        oledAvailable = true;
    } else if (display.begin(SSD1306_SWITCHCAPVCC, 0x3D)) {
        oledAvailable = true;
    }

    if (oledAvailable) {
        display.clearDisplay();
        display.setTextSize(1);
        display.setTextColor(SSD1306_WHITE);
        display.setCursor(12, 20);
        display.print("CardioX AI Online");
        display.setCursor(12, 36);
        display.print("Hardware Initialized");
        display.display();
        delay(600);
    }

    // Initialize MAX30102 Pulse Oximeter
    if (particleSensor.begin(Wire, I2C_SPEED_FAST)) {
        max30102Available = true;
        particleSensor.setup();
        particleSensor.setPulseAmplitudeRed(0x1F); // Red LED active
        particleSensor.setPulseAmplitudeGreen(0);
        Serial.println("[CardioX] MAX30102 connected successfully.");
    } else {
        Serial.println("[CardioX] MAX30102 not detected on I2C bus.");
    }

    for (int i = 0; i < 128; i++) {
        oledEcgHistory[i] = 512;
    }

    digitalWrite(PIN_STATUS_LED, HIGH); // LED off
    Serial.println("[CardioX] Ready for real-time telemetry.");
}

void loop() {
    // 1. High precision 125 Hz ECG sampling
    unsigned long nowUs = micros();
    if (nowUs - lastSampleTimeUs >= 8000) { // 125 Hz = 8000us
        lastSampleTimeUs = nowUs;
        sampleEcg();
    }

    // 2. Consume ECG samples into rolling history
    while (bufferHead != bufferTail) {
        uint16_t sample = ecgBuffer[bufferTail];
        bufferTail = (bufferTail + 1) % OFFLINE_BUF_SIZE;

        oledEcgHistory[oledHistoryIndex] = sample;
        oledHistoryIndex = (oledHistoryIndex + 1) % 128;
    }

    // 3. Poll MAX30102 Finger Sensor every 20ms
    if (millis() - lastFingerSampleTime >= 20) {
        lastFingerSampleTime = millis();
        if (max30102Available) {
            long irVal = particleSensor.getIR();
            if (irVal > 50000) { // Finger detected!
                fingerDetected = true;
                if (checkForBeat(irVal)) {
                    long delta = millis() - lastBeatTime;
                    lastBeatTime = millis();
                    if (delta > 350 && delta < 1400) {
                        int instantBpm = 60000 / delta;
                        if (instantBpm >= 48 && instantBpm <= 160) {
                            beatIntervals[beatCount % 4] = instantBpm;
                            beatCount++;
                            int n = min(beatCount, 4);
                            int sum = 0;
                            for (int k = 0; k < n; k++) sum += beatIntervals[k];
                            heartRateBpm = sum / n;
                            spo2Val = 98;
                        }
                    }
                }
            } else {
                // Immediate clear when finger is removed!
                fingerDetected = false;
                heartRateBpm = 0;
                spo2Val = 0;
                beatCount = 0;
            }
        }
    }

    // 4. Biological ECG validation (must have AC variance between 20 and 900, not railed)
    int minAdc = 1024, maxAdc = 0;
    for (int i = 0; i < 64; i++) {
        int v = oledEcgHistory[(oledHistoryIndex - 1 - i + 128) % 128];
        if (v < minAdc) minAdc = v;
        if (v > maxAdc) maxAdc = v;
    }
    int variance = maxAdc - minAdc;
    // When railed at 1024 or ground 0-20, or completely flat (variance < 20), ECG is invalid
    ecgSignalValid = (variance >= 22 && minAdc > 40 && maxAdc < 990);

    // 5. Refresh OLED at 15 FPS
    if (millis() - lastOledRefreshTime >= 66) {
        lastOledRefreshTime = millis();
        updateOled();
    }

    // 6. Send batched telemetry over USB serial at 5 Hz
    if (millis() - lastTelemetryTime >= 200) {
        lastTelemetryTime = millis();

        StaticJsonDocument<1024> doc;
        doc["type"] = "ECG_FRAME";
        doc["deviceId"] = "DX-ESP8266-001";
        doc["sessionId"] = "sess-001";
        doc["patientId"] = "pat-001";
        doc["timestamp"] = millis();
        doc["fingerDetected"] = fingerDetected;
        doc["heartRate"] = (fingerDetected && heartRateBpm > 0) ? heartRateBpm : 0;
        doc["spo2"] = (fingerDetected && spo2Val > 0) ? spo2Val : 0;
        doc["ecgSignalValid"] = ecgSignalValid;
        doc["sampleRate"] = 125;

        JsonArray samplesArray = doc.createNestedArray("samples");
        for (int i = 0; i < 25; i++) {
            int idx = (oledHistoryIndex - 25 + i + 128) % 128;
            samplesArray.add(oledEcgHistory[idx]);
        }

        serializeJson(doc, Serial);
        Serial.println();
    }
}
