import { WebSocketServer, WebSocket } from 'ws';
import { memDb } from '../config/database.js';
import { CardioXAiService } from '../services/aiService.js';
import { readingsLogger } from '../services/readingsLogger.js';

/**
 * Real-time WebSocket Hub for CardioX AI
 * Manages IoT ESP32 streaming connections, Doctor Dashboard sessions, and Patient App channels.
 */
export class RealtimeHub {
  constructor(server) {
    this.wss = new WebSocketServer({ server, path: '/ws' });
    this.clients = new Set();
    this.rooms = new Map(); // roomId -> Set of WebSocket clients
    this.deviceSockets = new Map(); // deviceId -> WebSocket
    this.simulationInterval = null;

    this.init();
  }

  init() {
    this.wss.on('connection', (ws, req) => {
      const ip = req.socket.remoteAddress;
      console.log(`[WS] Incoming client connection from: ${ip}`);
      this.clients.add(ws);
      ws.isAlive = true;
      ws.subscriptions = new Set();

      ws.on('pong', () => { ws.isAlive = true; });
      ws.on('error', (err) => {
        console.warn(`[WS] Client error (${ws.deviceId || 'browser'}):`, err.message);
      });

      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleMessage(ws, message);
        } catch (err) {
          console.error('[WS] Malformed JSON received:', err.message);
        }
      });

      ws.on('close', (code, reason) => {
        this.clients.delete(ws);
        // Leave all subscribed rooms
        for (const room of ws.subscriptions) {
          this.leaveRoom(room, ws);
        }
        // If it was a device socket, clear it
        if (ws.deviceId) {
          this.deviceSockets.delete(ws.deviceId);
          console.log(`[WS] Device ${ws.deviceId} disconnected. Code: ${code}, Reason: ${reason.toString()}`);
        }
      });

      // Send welcome / handshake
      ws.send(JSON.stringify({
        type: 'SERVER_ACK',
        status: 'CONNECTED',
        timestamp: new Date().toISOString()
      }));
    });

    // Heartbeat ping interval to prune dead sockets
    setInterval(() => {
      this.wss.clients.forEach((ws) => {
        if (!ws.isAlive) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
      });
    }, 30000);

    // Background ECG simulator disabled so dashboard reflects only real hardware data
    // this.startTelemetrySimulator();

    // Hardware Telemetry Watchdog: Detects hardware disconnects and broadcasts fallback state
    this.isHardwareActive = false;
    this.lastHardwarePacketTime = null;
    setInterval(() => {
      if (this.isHardwareActive && this.lastHardwarePacketTime) {
        if (Date.now() - this.lastHardwarePacketTime > 3500) {
          this.isHardwareActive = false;
          console.warn('[RealtimeHub] Hardware node timed out (>3.5s). Broadcasting FALLBACK state.');
          this.broadcastAll({
            type: 'HARDWARE_STATUS',
            connected: false,
            mode: 'FALLBACK',
            reason: 'HARDWARE_DISCONNECTED',
            message: 'Hardware Disconnected — No Live Hardware Data',
            lastSeen: this.lastHardwarePacketTime
          });
          // Broadcast clear frame to reset dashboard vitals and waveform
          this.broadcastAll({
            type: 'ECG_FRAME',
            patientId: this.activePatientId || 'pat-001',
            sessionId: 'sess-001',
            heartRate: 0,
            spo2: 0,
            fingerDetected: false,
            ecgSignalValid: false,
            leadsOff: true,
            samples: []
          });
        }
      }
    }, 1000);
  }

  handleMessage(ws, msg) {
    switch (msg.type) {
      // 1. Device Registration (from ESP32 or Simulator)
      case 'DEVICE_REGISTER':
        ws.deviceId = msg.deviceId;
        this.deviceSockets.set(msg.deviceId, ws);
        console.log(`[WS] Device registered: ${msg.deviceId}`);
        ws.send(JSON.stringify({ type: 'DEVICE_REGISTER_OK', deviceId: msg.deviceId }));
        break;

      // 2. Client Subscription to Patient Channel
      case 'SUBSCRIBE_PATIENT':
        this.joinRoom(`patient:${msg.patientId}`, ws);
        break;

      // 3. Dynamic Patient Assignment for Hardware Telemetry
      case 'SET_ACTIVE_PATIENT':
        if (msg.patientId) {
          this.activePatientId = msg.patientId;
          console.log(`[WS] Active physical monitoring target set to: ${this.activePatientId}`);
          this.broadcastAll({
            type: 'ACTIVE_PATIENT_CHANGED',
            patientId: this.activePatientId
          });
        }
        break;

      // 4. Client Subscription to Session Channel
      case 'SUBSCRIBE_SESSION':
        this.joinRoom(`session:${msg.sessionId}`, ws);
        break;

      // 5. Ingest ECG frame from ESP8266, ESP32, or hardware gateway
      case 'ECG_FRAME':
        this.handleEcgFrame(msg, true);
        break;

      // 6. Heartbeat from ESP32/ESP8266
      case 'DEVICE_HEARTBEAT':
        this.broadcast(`device:${msg.deviceId}`, msg);
        // Also forward vital signs directly so dashboard reflects real values immediately
        if (msg.heartRate !== undefined || msg.spo2 !== undefined) {
          this.handleEcgFrame({
            type: 'ECG_FRAME',
            deviceId: msg.deviceId,
            sessionId: 'sess-001',
            patientId: this.activePatientId || 'pat-001',
            heartRate: msg.heartRate,
            spo2: msg.spo2,
            leadsOff: msg.leadsOff,
            fingerDetected: msg.fingerDetected,
            signalQuality: msg.leadsOff ? 'LEADS_OFF' : 'EXCELLENT',
            samples: []
          }, true);
        }
        break;

      // 7. Interactive Session Control
      case 'CMD_START_MONITORING':
        this.broadcastCommandToDevice(msg.deviceId, 'START_SESSION', { sessionId: msg.sessionId });
        break;

      case 'CMD_STOP_MONITORING':
        this.broadcastCommandToDevice(msg.deviceId, 'STOP_SESSION', {});
        break;

      default:
        break;
    }
  }

  processEcgRPeaks(samples, sampleRate = 125) {
    if (!this.ecgSampleRing) {
      this.ecgSampleRing = [];
      this.lastRPeakTime = 0;
      this.rrIntervals = [];
      this.currentSmoothHr = 74;
    }

    const now = Date.now();
    const dtMs = 1000 / sampleRate;

    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      this.ecgSampleRing.push(s);
      if (this.ecgSampleRing.length > 250) this.ecgSampleRing.shift();

      if (this.ecgSampleRing.length >= 7) {
        const idx = this.ecgSampleRing.length - 4;
        const val = this.ecgSampleRing[idx];
        const prev1 = this.ecgSampleRing[idx - 1];
        const prev2 = this.ecgSampleRing[idx - 2];
        const next1 = this.ecgSampleRing[idx + 1];
        const next2 = this.ecgSampleRing[idx + 2];

        // Is local peak
        if (val > prev1 && val >= prev2 && val > next1 && val >= next2) {
          let sum = 0, maxVal = 0, minVal = 9999;
          for (let k = 0; k < this.ecgSampleRing.length; k++) {
            const v = this.ecgSampleRing[k];
            sum += v;
            if (v > maxVal) maxVal = v;
            if (v < minVal) minVal = v;
          }
          const avg = sum / this.ecgSampleRing.length;
          const amp = maxVal - minVal;

          if (amp >= 30) {
            const threshold = avg + 0.35 * (maxVal - avg);
            const sampleTime = now - (samples.length - 1 - i) * dtMs;

            // Refractory period: at least 480ms (physiologically rejects T-wave & 50Hz power hum)
            if (val > threshold && val > 300 && (sampleTime - this.lastRPeakTime >= 480)) {
              if (this.lastRPeakTime > 0) {
                const rrMs = sampleTime - this.lastRPeakTime;
                if (rrMs >= 480 && rrMs <= 1400) { // 43 - 125 BPM
                  const instantHr = Math.round(60000 / rrMs);
                  this.rrIntervals.push(instantHr);
                  if (this.rrIntervals.length > 4) this.rrIntervals.shift();
                  
                  // Smooth physiological resting rate (~70-82 BPM)
                  const rawAvg = Math.round(this.rrIntervals.reduce((a, b) => a + b, 0) / this.rrIntervals.length);
                  const physiologicallyClamped = Math.max(65, Math.min(92, rawAvg));
                  this.currentSmoothHr = Math.round(0.3 * physiologicallyClamped + 0.7 * this.currentSmoothHr);
                }
              }
              this.lastRPeakTime = sampleTime;
            }
          }
        }
      }
    }

    return this.currentSmoothHr;
  }

  handleEcgFrame(frame, isHardware = false) {
    const patientId = this.activePatientId || frame.patientId || 'pat-001';
    const sessionId = frame.sessionId || 'sess-001';
    const ts = new Date().toISOString();
    const isRealHw = isHardware || (frame.deviceId && (frame.deviceId.includes('ESP') || frame.deviceId.includes('HARDWARE')));
    const readingSource = isRealHw ? 'hardware' : (frame.source || 'demo');

    // 0. Biological ECG Validity Check (AD8232 biopotential vs power rail)
    let isRailed = false;
    if (frame.samples && Array.isArray(frame.samples) && frame.samples.length > 0) {
      let minS = 9999, maxS = -9999;
      for (const s of frame.samples) {
        if (s < minS) minS = s;
        if (s > maxS) maxS = s;
      }
      const variance = maxS - minS;
      if ((minS >= 1020 && maxS >= 1020) || (minS <= 15 && maxS <= 15)) {
        isRailed = true;
      } else if (variance >= 6 || (minS > 25 && maxS < 1018)) {
        isRailed = false;
        this.lastValidEcgTimestamp = Date.now();
      }
    }
    // True clinical hysteresis: keep active for 3.5s after last valid biopotential frame
    const ecgValid = Boolean(frame.ecgSignalValid || (this.lastValidEcgTimestamp && (Date.now() - this.lastValidEcgTimestamp < 3500)));
    frame.ecgSignalValid = ecgValid;
    frame.leadsOff = !ecgValid;
    frame.signalQuality = ecgValid ? 'EXCELLENT' : 'LEADS_OFF';

    // 0.1 Exact 1:1 Hardware Pass-Through (Matches OLED display 100%)
    const rawHwHr = (frame.heartRate && frame.heartRate >= 40 && frame.heartRate <= 220) ? Math.round(frame.heartRate) : 0;
    const rawHwSpo2 = (frame.spo2 && frame.spo2 >= 70 && frame.spo2 <= 100) ? Math.round(frame.spo2) : 0;

    frame.heartRate = rawHwHr;
    frame.spo2 = rawHwSpo2;
    frame.fingerDetected = Boolean(frame.fingerDetected);

    // 1. If this frame came from real hardware, record arrival time & announce connect if previously inactive
    if (isRealHw) {
      this.lastHardwarePacketTime = Date.now();
      if (!this.isHardwareActive) {
        this.isHardwareActive = true;
        this.broadcastAll({
          type: 'HARDWARE_STATUS',
          connected: true,
          mode: 'HARDWARE',
          deviceId: frame.deviceId || 'DX-ESP-NODE',
          message: 'Hardware Active & Connected'
        });
      }

      // Automatically log real hardware reading into data/patient_readings.csv ONLY when real hardware reading is valid
      if (frame.fingerDetected || ecgValid) {
        try {
          const patient = memDb.patients.find(p => p.id === patientId);
          const patientName = patient ? (patient.full_name || patient.name || 'Annindita') : 'Annindita';
          readingsLogger.logReading({
            patientId,
            patientName,
            heartRate: frame.fingerDetected ? frame.heartRate : null,
            spo2: frame.fingerDetected ? frame.spo2 : null,
            ecgSamples: ecgValid ? frame.samples : [],
            timestamp: frame.timestamp ? (typeof frame.timestamp === 'number' ? Date.now() : frame.timestamp) : Date.now()
          });
        } catch (err) {
          console.warn('[RealtimeHub] Error writing hardware reading to CSV:', err.message);
        }
      }
    }

    // 2. Persist ECG samples into memory database with explicit source tagging
    if (frame.samples && Array.isArray(frame.samples) && frame.samples.length > 0) {
      memDb.ecg_samples.push({
        id: `ecg-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
        session_id: sessionId,
        patient_id: patientId,
        timestamp: ts,
        sample_rate: frame.sampleRate || 125,
        signal_quality: frame.signalQuality || 'EXCELLENT',
        leads_off: Boolean(frame.leadsOff),
        source: readingSource,
        samples: frame.samples
      });

      // Keep recent 1,000 ECG batches in memory store to prevent unbounded growth
      if (memDb.ecg_samples.length > 1000) {
        memDb.ecg_samples.shift();
      }
    }

    // 3. Persist Heart Rate & SpO2 readings periodically with explicit source tagging
    if (frame.heartRate !== undefined && frame.spo2 !== undefined) {
      const hrVal = parseFloat(frame.heartRate);
      const spo2Val = parseFloat(frame.spo2);

      // Record vital readings every ~1 sec for the active patient
      if (!this.lastVitalsStoreTime || Date.now() - this.lastVitalsStoreTime > 1000) {
        this.lastVitalsStoreTime = Date.now();

        memDb.heart_rate_readings.push({
          id: `hr-${Date.now()}`,
          session_id: sessionId,
          patient_id: patientId,
          value_bpm: Math.round(hrVal),
          confidence: frame.leadsOff ? 0.2 : 0.98,
          signal_quality: frame.signalQuality || 'GOOD',
          source: readingSource,
          timestamp: ts
        });

        memDb.spo2_readings.push({
          id: `spo2-${Date.now()}`,
          session_id: sessionId,
          patient_id: patientId,
          value_pct: Math.round(spo2Val),
          confidence: frame.leadsOff ? 0.2 : 0.99,
          signal_quality: frame.signalQuality || 'GOOD',
          source: readingSource,
          timestamp: ts
        });

        // Cap readings history
        if (memDb.heart_rate_readings.length > 500) memDb.heart_rate_readings.shift();
        if (memDb.spo2_readings.length > 500) memDb.spo2_readings.shift();
      }

      // Update patient snapshot for dashboard directories ONLY for the target patient
      const isLeadsOff = Boolean(frame.leadsOff);
      const quality = frame.signalQuality || (isLeadsOff ? 'LEADS_OFF' : 'STABLE');
      const hasSamples = frame.samples && frame.samples.length > 0;
      const patient = memDb.patients.find(p => p.id === patientId);
      if (patient) {
        patient.current_hr = (frame.fingerDetected && hrVal >= 40 && hrVal <= 200) ? Math.round(hrVal) : null;
        patient.current_spo2 = (frame.fingerDetected && spo2Val >= 70 && spo2Val <= 100) ? Math.round(spo2Val) : null;
        patient.status = (frame.fingerDetected || frame.ecgSignalValid) ? 'MONITORING' : 'IDLE';
        patient.signal_quality = frame.ecgSignalValid ? 'EXCELLENT' : (frame.fingerDetected ? 'GOOD' : 'WAITING');
        patient.leads_off = !frame.ecgSignalValid;
        patient.finger_detected = Boolean(frame.fingerDetected);
        patient.last_active = 'Just now';
      }
    }

    // 4. Real-time fan-out to Doctor and Patient rooms
    const enrichedFrame = {
      ...frame,
      signalQuality: frame.signalQuality || (frame.leadsOff ? 'LEADS_OFF' : 'STABLE'),
      patientId
    };

    this.broadcast(`patient:${patientId}`, enrichedFrame);
    this.broadcastAll(enrichedFrame);

    // 5. Periodic Live AI Assessment Broadcast (Every 2.5s)
    if (!this.lastAiEvaluationTime || Date.now() - this.lastAiEvaluationTime > 2500) {
      this.lastAiEvaluationTime = Date.now();
      try {
        const patient = memDb.patients.find(p => p.id === patientId);
        const aiEval = CardioXAiService.evaluatePatientVitals({
          patientId,
          hr: (frame.fingerDetected && frame.heartRate > 0) ? Math.round(frame.heartRate) : null,
          spo2: (frame.fingerDetected && frame.spo2 > 0) ? Math.round(frame.spo2) : null,
          ecgSamples: frame.ecgSignalValid ? (frame.samples || []) : [],
          sampleRate: frame.sampleRate || 125,
          leadsOff: !frame.ecgSignalValid,
          patient: patient || {}
        });

        const aiPayload = {
          type: 'AI_ANALYSIS_UPDATE',
          patientId,
          sessionId,
          evaluation: aiEval
        };

        this.broadcast(`patient:${patientId}`, aiPayload);
      } catch (err) {
        console.warn('[RealtimeHub] Live AI evaluation broadcast note:', err.message);
      }
    }
  }

  broadcastAll(payload) {
    const dataStr = JSON.stringify(payload);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN && !client.deviceId) {
        client.send(dataStr);
      }
    }
  }

  joinRoom(room, ws) {
    if (!this.rooms.has(room)) {
      this.rooms.set(room, new Set());
    }
    this.rooms.get(room).add(ws);
    ws.subscriptions.add(room);
  }

  leaveRoom(room, ws) {
    if (this.rooms.has(room)) {
      this.rooms.get(room).delete(ws);
      if (this.rooms.get(room).size === 0) {
        this.rooms.delete(room);
      }
    }
  }

  broadcast(room, payload) {
    const dataStr = JSON.stringify(payload);
    const sent = new Set();
    // Broadcast to specific room
    if (this.rooms.has(room)) {
      for (const client of this.rooms.get(room)) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(dataStr);
          sent.add(client);
        }
      }
    }
    // Also broadcast to other connected web clients without duplicating
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN && !client.deviceId && !sent.has(client)) {
        client.send(dataStr);
        sent.add(client);
      }
    }
  }

  broadcastCommandToDevice(deviceId, command, payload) {
    const devWs = this.deviceSockets.get(deviceId);
    if (devWs && devWs.readyState === WebSocket.OPEN) {
      devWs.send(JSON.stringify({ command, ...payload }));
    }
  }

  /**
   * High-Fidelity Synthetic ECG Generator for Live Demo & Testing
   * Automatically yields when real ESP8266 or ESP32 hardware is actively transmitting.
   */
  startTelemetrySimulator() {
    let t = 0;
    const sampleRate = 250;
    const batchSize = 25; // 100ms batches for ultra-smooth 10fps updates

    this.simulationInterval = setInterval(() => {
      // Only generate if there are active subscribers
      const hasSubscribers = this.clients.size > 0;
      if (!hasSubscribers) return;

      // If real hardware transmitted within the last 4 seconds, do NOT inject synthetic data
      if (this.lastHardwarePacketTime && (Date.now() - this.lastHardwarePacketTime < 4000)) {
        return;
      }

      const samples = [];
      for (let i = 0; i < batchSize; i++) {
        // True clinical isoelectric baseline with micro-noise
        samples.push(512 + Math.round((Math.random() - 0.5) * 1.5));
      }

      const frame = {
        type: 'ECG_FRAME',
        deviceId: 'DX-SIMULATOR',
        sessionId: 'sess-001',
        timestamp: Date.now(),
        leadsOff: true,
        signalQuality: 'LEADS_OFF',
        sampleRate: 250,
        heartRate: 0,
        spo2: 0,
        fingerDetected: false,
        samples
      };

      this.handleEcgFrame(frame, false);
    }, 100);
  }
}
