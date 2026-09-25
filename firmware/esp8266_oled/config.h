#ifndef CARDIOX_CONFIG_H
#define CARDIOX_CONFIG_H

// ============================================================================
// CARDIOX AI — UNIFIED FIRMWARE CONFIGURATION
// Target Hardware: ESP8266 (NodeMCU / Wemos D1) or ESP32 (DevKit V1)
// Sensors:
//   - AD8232 (Single-Lead ECG Front-End)
//   - MAX30102 (Pulse Oximetry & Heart Rate)
// Display:
//   - 0.96" I2C SSD1306 OLED (128x64)
// ============================================================================

// --- 1. Wi-Fi Credentials ---
// Configure your local 2.4GHz Wi-Fi network here:
#define WIFI_SSID           "ANNINDITA"
#define WIFI_PASSWORD       "10331033"
#define WIFI_RECONNECT_MS   5000

// --- 2. Backend Server Endpoints ---
// Set BACKEND_HOST to your computer's local IP (e.g., "10.123.157.183")
#define BACKEND_HOST        "172.20.135.7"
#define BACKEND_PORT        5000
#define BACKEND_WS_PATH     "/ws"
#define BACKEND_HTTP_URL    "http://172.20.135.7:5000/api/v1/vitals/ingest"

// --- 3. Device Identification ---
#if defined(ESP8266)
  #define DEVICE_ID         "DX-ESP8266-001"
  #define DEVICE_TOKEN      "dx_token_sec_esp8266"
  #define FIRMWARE_VERSION  "1.2.0-esp8266"
#else
  #define DEVICE_ID         "DX-ESP32-001"
  #define DEVICE_TOKEN      "dx_token_sec_99a823f0"
  #define FIRMWARE_VERSION  "1.2.0-esp32"
#endif

#define PATIENT_ID          "pat-001"
#define DEFAULT_SESSION_ID  "sess-001"

// --- 4. Hardware Pin Definitions ---
#if defined(ESP8266)
  // AD8232 ECG Sensor on ESP8266
  #define PIN_ECG_OUT       A0    // Analog input (0 - 1023)
  #define PIN_ECG_LO_PLUS   14    // D5 (GPIO14) Leads-Off detection (LO+)
  #define PIN_ECG_LO_MINUS  12    // D6 (GPIO12) Leads-Off detection (LO-)
  #define PIN_STATUS_LED    2     // D4 (GPIO2) Built-in LED (Active LOW)

  // I2C Bus on ESP8266 (Shared by MAX30102 and SSD1306 OLED)
  #define PIN_I2C_SDA       4     // D2 (GPIO4)
  #define PIN_I2C_SCL       5     // D1 (GPIO5)
#else
  // AD8232 ECG Sensor on ESP32
  #define PIN_ECG_OUT       34    // ADC1_CH6 (Analog input 0 - 4095)
  #define PIN_ECG_LO_PLUS   32    // Leads-Off detection (LO+)
  #define PIN_ECG_LO_MINUS  33    // Leads-Off detection (LO-)
  #define PIN_STATUS_LED    2     // Built-in Blue LED

  // I2C Bus on ESP32
  #define PIN_I2C_SDA       21
  #define PIN_I2C_SCL       22
#endif

// --- 5. I2C Device Addresses ---
#define OLED_I2C_ADDR       0x3C  // Standard 0.96" SSD1306 OLED address (or 0x3D)
#define OLED_SCREEN_WIDTH   128
#define OLED_SCREEN_HEIGHT  64
#define OLED_RESET_PIN      -1

#define MAX30102_I2C_ADDR   0x57  // Standard MAX30102 I2C address

// --- 6. Sampling & Batching Rates ---
#if defined(ESP8266)
  #define ECG_SAMPLE_RATE_HZ  125   // 125 Hz sampling (8ms) optimal for ESP8266 single-core throughput
  #define ECG_BATCH_SIZE      25    // 25 samples (~200ms per WebSocket packet)
#else
  #define ECG_SAMPLE_RATE_HZ  250   // 250 Hz sampling on dual-core ESP32
  #define ECG_BATCH_SIZE      50    // 50 samples (~200ms per WebSocket packet)
#endif

#define ECG_TIMER_INTERVAL_US (1000000 / ECG_SAMPLE_RATE_HZ)
#define ECG_SAMPLE_INTERVAL_MS (1000 / ECG_SAMPLE_RATE_HZ)
#define VITALS_POLL_MS      1000  // MAX30102 HR & SpO2 polled every 1000ms
#define OLED_REFRESH_MS     100   // Refresh OLED every 100ms (10 FPS oscilloscope waveform)
#define TELEMETRY_SEND_MS   2500  // Heartbeat & status ping every 2500ms

// --- 7. Local Offline Ring Buffer ---
#if defined(ESP8266)
  #define OFFLINE_BUFFER_CAPACITY 512
#else
  #define OFFLINE_BUFFER_CAPACITY 2000
#endif

#endif // CARDIOX_CONFIG_H
