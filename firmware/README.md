# CardioX AI — Hardware & Firmware Guide (ESP8266 & ESP32)

CardioX AI firmware supports both **ESP8266** (NodeMCU / Wemos D1 Mini / ESP-12E) and **ESP32** (DevKit V1) with real-time **AD8232 ECG**, **MAX30102 Heart Rate & SpO₂**, and a **0.96" SSD1306 I2C OLED Display** showing live oscilloscope waveforms and vitals.

---

## 1. Hardware Architecture & Bill of Materials (BOM)

| Component | Function | Interface | Pins on ESP8266 (NodeMCU) | Pins on ESP32 |
|---|---|---|---|---|
| **ESP8266 / ESP32** | IoT Microcontroller, Wi-Fi, WebSocket client | Core | USB / 3.3V power | USB / 3.3V power |
| **AD8232** | Single-Lead ECG Front-End Sensor | Analog + GPIO | **OUT** -> **A0** (ADC0)<br>**LO+** -> **D5** (GPIO 14)<br>**LO-** -> **D6** (GPIO 12)<br>**3.3V** -> 3V3, **GND** -> GND | **OUT** -> GPIO 34 (ADC1_CH6)<br>**LO+** -> GPIO 32<br>**LO-** -> GPIO 33<br>**3.3V** -> 3V3, **GND** -> GND |
| **MAX30102** | Pulse Oximetry & Heart Rate (PPG) | I²C Bus | **SDA** -> **D2** (GPIO 4)<br>**SCL** -> **D1** (GPIO 5)<br>**VIN** -> 3V3 / 5V, **GND** -> GND | **SDA** -> GPIO 21<br>**SCL** -> GPIO 22<br>**VIN** -> 3V3, **GND** -> GND |
| **0.96" SSD1306 OLED** | 128x64 Live Waveform & Vitals Display | I²C Bus (`0x3C`) | **SDA** -> **D2** (GPIO 4)<br>**SCL** -> **D1** (GPIO 5)<br>**VCC** -> 3V3, **GND** -> GND | **SDA** -> GPIO 21<br>**SCL** -> GPIO 22<br>**VCC** -> 3V3, **GND** -> GND |
| **Status LED** | Wi-Fi / Gateway status | Digital Out | **D4** (GPIO 2, Built-in LED) | GPIO 2 (Built-in Blue LED) |
| **3-Lead ECG Cable** | Electrodes (RA, LA, RL) | 3.5mm Jack | RA (Red), LA (Yellow), RL (Green) | RA (Red), LA (Yellow), RL (Green) |

---

## 2. Wiring & Pinout Diagram (ESP8266 NodeMCU)

> **Note on I²C Bus**: Both the **MAX30102** (`0x57`) and the **SSD1306 OLED** (`0x3C`) connect in parallel to the exact same I²C pins (**D2/SDA** and **D1/SCL**).

```
                      +-----------------------------+
                      |       ESP8266 NodeMCU       |
                      |                             |
AD8232 (ECG)          |                             |     MAX30102 & OLED (I2C)
[ 3.3V ] -------------| 3V3                     3V3 |----- [ VIN / VCC (3.3V) ]
[ GND  ] -------------| GND                     GND |----- [ GND ]
[ OUT  ] -------------| A0 (ADC)                    |
[ LO+  ] -------------| D5 (GPIO 14)       D2 (SDA) |==== [ SDA (MAX30102 & OLED) ]
[ LO-  ] -------------| D6 (GPIO 12)       D1 (SCL) |==== [ SCL (MAX30102 & OLED) ]
[ SDN  ] -------------| N/C                         |
                      +-----------------------------+
```

---

## 3. OLED Display Layout

The 0.96" SSD1306 OLED (128x64) renders three dedicated sections:
```
+------------------------------------+
| CardioX        [LIVE]          OK  |  <- Top Bar: Brand, Gateway status, Leads-off
|------------------------------------|
| HR: 76 bpm          SpO2: 98%      |  <- Metrics Row: Live Heart Rate & Oxygenation
|------------------------------------|
|      _/\_                 _/\_     |  <- Bottom Area: Real-time ECG Oscilloscope
| ___/     \____/\________/     \___ |     Rolling waveform (128 horizontal pixels)
+------------------------------------+
```

---

## 4. How to Compile & Flash

### Arduino IDE Setup
1. **Add ESP8266 Board Support**:
   - In Arduino IDE, go to **File** -> **Preferences**.
   - In *Additional Boards Manager URLs*, add:
     `http://arduino.esp8266.com/stable/package_esp8266com_index.json`
   - Open **Tools** -> **Board** -> **Boards Manager**, search `esp8266`, and click **Install**.

2. **Install Required Libraries** (Tools -> Manage Libraries):
   - `WebSockets` by Markus Sattler
   - `ArduinoJson` (v6 or v7) by Benoît Blanchon
   - `Adafruit SSD1306` by Adafruit
   - `Adafruit GFX Library` by Adafruit
   - `SparkFun MAX3010x Pulse and Proximity Sensor Library` by SparkFun

3. **Configure Settings**:
   - Open `firmware/include/config.h`.
   - Update `WIFI_SSID` and `WIFI_PASSWORD` with your Wi-Fi credentials.
   - Set `BACKEND_HOST` to your computer's IP address on the local network (e.g., `"192.168.1.100"`).

4. **Upload to Hardware**:
   - Board: **NodeMCU 1.0 (ESP-12E Module)** or **LOLIN(WEMOS) D1 R2 & mini**
   - Upload Speed: `115200` or `921600`
   - Port: Select your USB COM port
   - Click **Upload** (➡️).

---

## 5. Electrode Placement (Lead I Configuration)
- **RA (Red)**: Right collarbone or inner right wrist.
- **LA (Yellow)**: Left collarbone or inner left wrist.
- **RL (Green - Ground Reference)**: Lower right abdomen or right ankle.

---

## 6. Real-time End-to-End Flow
1. When powered on, the ESP8266 connects to Wi-Fi and the CardioX backend WebSocket (`ws://<IP>:5000/ws`).
2. The OLED initializes and displays `CardioX AI Initializing IoT...`.
3. The AD8232 is sampled on `A0` via hardware ticker interrupt at 125 Hz.
4. Live ECG trace and MAX30102 vitals are continuously rendered on the OLED screen.
5. Telemetry packets (`ECG_FRAME`) stream over WebSocket to the backend.
6. The backend stores the ECG samples and vitals in the database and broadcasts to the Doctor Dashboard and Patient App.
7. If Wi-Fi drops, the local OLED continues monitoring uninterrupted and reconnects automatically.

