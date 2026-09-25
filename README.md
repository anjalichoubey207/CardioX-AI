# ❤️ CardioX AI — Intelligent Remote Cardiac Monitoring Platform

**CardioX AI** is a remote cardiac monitoring platform that connects wearable/portable IoT hardware (ESP32 + AD8232 + MAX30102) with a patient mobile application, doctor clinical web dashboard, and an AI/ML decision-support layer.

```
AD8232 (ECG) ─────┐
                  │
MAX30102 (Vitals) ┼──> ESP32 Microcontroller
                  │      │
                  │     Wi-Fi (HTTPS + WSS)
                  │      ↓
                  │   Node.js Core Backend (Express + WS)
                  │      ↓
                  │   MySQL Database (13 Relational Tables)
                  │      ↓
                  │   AI / ML Clinical Intelligence Engine
                  │      ↓
       ┌──────────┴───────────────┐
       ↓                          ↓
Patient Mobile App       Doctor Web Dashboard
(Vitals, Live Rhythm)    (Oscilloscope, AI Decision Support)
```

---

## 🚀 Live Demo & Quickstart

The entire platform is already built, configured, and running locally.

### Accessing the Web Application

Open your web browser and navigate to:
👉 **[http://localhost:5000](http://localhost:5000)**

The unified interface features 3 integrated views accessible via the top navigation tabs:

1. **👨‍⚕️ Doctor Dashboard**:
   - High-level metrics: Total Patients, Active Streams, Pending Alerts.
   - **Real-Time ECG Oscilloscope Monitor**: High-precision 250 Hz canvas with cyan glowing phosphor trace, BPM counter, and SpO₂ telemetry.
   - **AI Clinical Decision Support Box**: Attention Score (0–100), baseline deviation analysis, signal SNR evaluation, and non-diagnostic narrative.
   - **Patient Directory**: Search and filter assigned patients with live status tags.
   - **Clinical Notes Editor**: Add doctor notes with auditable timestamps.
   - **Printable Health Report Generator**: One-click summary for clinical review.
2. **📱 Patient Mobile App**:
   - Live heart rate & SpO₂ vitals card.
   - Mini rhythm monitor.
   - Start / Stop Monitoring session toggle.
   - AI Monitoring Summary card with safety disclaimers.
3. **⚡ IoT Hardware Simulator**:
   - Interactive ESP32 + AD8232 + MAX30102 telemetry emulator.
   - Sliders for Heart Rate (40–180 BPM) and SpO₂ (80–100%).
   - Waveform selector: Normal Sinus Rhythm, Sinus Arrhythmia, PVC (Premature Ventricular Contractions), High-Frequency Noise, or Leads-Off.

---

## 📁 Codebase Architecture

```
CardioX-AI/
├── firmware/                 # Phase 1: Embedded IoT Firmware
│   ├── src/main.cpp          # ESP32 250Hz timer ISR, circular buffer, WebSocket streamer
│   ├── include/config.h      # Pinouts, Wi-Fi configuration, timing parameters
│   └── README.md             # Wiring schematics, AD8232 & MAX30102 pin table, flashing guide
│
├── backend/                  # Phase 2: Node.js Telemetry API & Real-time Gateway
│   ├── migrations/init.sql   # 13 relational tables (users, patients, sessions, ecg, etc.)
│   ├── src/
│   │   ├── server.js         # Express + WebSocket HTTP server & static frontend serving
│   │   ├── config/           # Database pool (MySQL + high-speed memory fallback), env
│   │   ├── middleware/       # JWT verification, RBAC guard, audit logger, rate limiter
│   │   ├── services/aiService.js  # Clinical baseline engine & attention scoring
│   │   ├── realtime/websocketHub.js # WebSocket telemetry router & broadcast hub
│   │   └── modules/          # REST endpoints (auth, patients, doctors, vitals, alerts, notes, reports)
│   └── package.json
│
├── ai-engine/                # Phase 4: Python AI/ML Microservice
│   ├── app/
│   │   ├── main.py           # FastAPI entry point (/analyze, /health)
│   │   ├── signal_quality.py # SNR calculation, flatline & saturation detection
│   │   ├── ecg_processor.py  # 0.5-40Hz bandpass filter, Pan-Tompkins R-peak detector
│   │   ├── baseline_manager.py # Longitudinal patient baseline with 10% cautious EMA
│   │   ├── anomaly_detector.py # Z-score deviation & excursion thresholds
│   │   └── summary_generator.py # Non-diagnostic narrative generation with disclaimers
│   └── requirements.txt
│
└── frontend/                 # Phase 3: Web Dashboard & Patient App
    ├── index.html            # Unified Doctor Portal, Patient App, and Hardware Simulator
    ├── styles.css            # Medical dark-theme stylesheet
    └── app.js                # Canvas oscilloscope engine & WebSocket client
```

---

## 🔌 Hardware Pinouts & Wiring (ESP32)

| Sensor                 | Sensor Pin | ESP32 Pin        | Note                                       |
| ---------------------- | ---------- | ---------------- | ------------------------------------------ |
| **AD8232 (ECG)**       | OUT        | GPIO 34 (ADC1_6) | Analog output (Do not use ADC2 with Wi-Fi) |
|                        | LO+        | GPIO 32          | Leads-Off positive detection               |
|                        | LO-        | GPIO 33          | Leads-Off negative detection               |
|                        | 3.3V       | 3V3              | Regulated 3.3V power                       |
|                        | GND        | GND              | Ground                                     |
| **MAX30102 (HR/SpO₂)** | SDA        | GPIO 21          | I²C Data                                   |
|                        | SCL        | GPIO 22          | I²C Clock                                  |
|                        | VIN        | 3V3              | Power                                      |
|                        | GND        | GND              | Ground                                     |

---

## 🔒 Security & Medical Safety Principles

1. **Role-Based Access Control (RBAC)**: Patients are strictly restricted to their personal telemetry. Doctors have access to assigned patient cohorts.
2. **Audit Logging**: Every mutating healthcare action, login, and telemetry query is timestamped and recorded with actor ID and IP.
3. **Mandatory Non-Diagnostic Disclaimer**:
   > _"This is AI-assisted monitoring support and not a medical diagnosis. Consult a qualified physician for clinical care."_
   > The system categorizes findings by Attention Scores (0–100) and deviation bands rather than issuing diagnostic labels.

---

## 🛠️ CLI Operations & Restart

To restart or run the backend manually:

```bash
cd CardioX-AI/backend
npm start
```

To run the Python AI service independently (optional):

```bash
cd CardioX-AI/ai-engine
pip install -r requirements.txt
python -m uvicorn app.main:app --port 8000 --reload
```
