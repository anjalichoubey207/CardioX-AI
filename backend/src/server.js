import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { readingsLogger } from './services/readingsLogger.js';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

import { config } from './config/env.js';
import { initDatabase } from './config/database.js';
import { auditLogger } from './middleware/audit.js';
import { RealtimeHub } from './realtime/websocketHub.js';

// Route Handlers
import authRoutes from './modules/auth/authRoutes.js';
import patientRoutes from './modules/patients/patientRoutes.js';
import doctorRoutes from './modules/doctors/doctorRoutes.js';
import sessionRoutes from './modules/sessions/sessionRoutes.js';
import vitalsRoutes from './modules/vitals/vitalsRoutes.js';
import alertRoutes from './modules/alerts/alertRoutes.js';
import noteRoutes from './modules/notes/noteRoutes.js';
import reportRoutes from './modules/reports/reportRoutes.js';
import aiRoutes from './modules/ai/aiRoutes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const frontendPath = path.resolve(__dirname, '../../frontend');

process.on('uncaughtException', (err) => {
  console.error('[CardioX Core UNCAUGHT EXCEPTION]:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[CardioX Core UNHANDLED REJECTION]:', reason);
});

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);

// 1. Security & Parsing Middlewares
app.use(helmet({
  contentSecurityPolicy: false
}));
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-device-token', 'x-device-id']
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// JSON parse error guard
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'Malformed JSON payload' });
  }
  next();
});

// 2. Serve Static Frontend (Dashboard, Patient View & IoT Simulator)
app.use(express.static(frontendPath));

// 3. Rate Limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests from this IP, please try again after 15 minutes.' }
});
app.use('/api/', apiLimiter);

// 4. Clinical Audit Logging
app.use(auditLogger);

// 5. Initialize Realtime WebSocket Hub
export const realtimeHub = new RealtimeHub(server);
app.locals.realtimeHub = realtimeHub;

// 6. API Routes Mounting
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/patients', patientRoutes);
app.use('/api/v1/doctors', doctorRoutes);
app.use('/api/v1/sessions', sessionRoutes);
app.use('/api/v1/vitals', vitalsRoutes);
app.use('/api/v1/alerts', alertRoutes);
app.use('/api/v1/notes', noteRoutes);
app.use('/api/v1/reports', reportRoutes);
app.use('/api/v1/ai', aiRoutes);

// Health Check Endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'HEALTHY',
    service: 'CardioX AI Core Telemetry Backend',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    safetyDisclaimer: config.DISCLAIMER
  });
});

// API Directory
app.get('/api', (req, res) => {
  res.json({
    name: 'CardioX AI Platform API',
    endpoints: {
      auth: '/api/v1/auth',
      patients: '/api/v1/patients',
      doctors: '/api/v1/doctors',
      sessions: '/api/v1/sessions',
      vitals: '/api/v1/vitals',
      alerts: '/api/v1/alerts',
      notes: '/api/v1/notes',
      reports: '/api/v1/reports',
      ai: '/api/v1/ai',
      websocket: `ws://localhost:${config.PORT}/ws`
    }
  });
});

// Hardware Diagnostics & Status Endpoint
let lastSerialPacketTime = 0;
let lastReceivedHardwareFrame = null;

app.get('/api/v1/hardware/status', (req, res) => {
  res.json({
    serialPort: process.env.SERIAL_PORT || 'COM3',
    baudRate: 115200,
    hardwareActive: (Date.now() - lastSerialPacketTime < 4000),
    lastPacketReceivedAt: lastSerialPacketTime ? new Date(lastSerialPacketTime).toISOString() : null,
    activeMonitoringPatientId: realtimeHub.activePatientId || 'pat-001',
    lastFrame: lastReceivedHardwareFrame || null
  });
});

// Download patient readings CSV file for Excel
app.get('/api/v1/readings/download', (req, res) => {
  const filePath = readingsLogger.getFilePath();
  if (fs.existsSync(filePath)) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="patient_readings.csv"');
    return res.sendFile(filePath);
  }
  res.status(404).json({ error: 'No readings file found yet' });
});

app.get('/api/v1/readings/csv', (req, res) => {
  const filePath = readingsLogger.getFilePath();
  if (fs.existsSync(filePath)) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="patient_readings.csv"');
    return res.sendFile(filePath);
  }
  res.status(404).json({ error: 'No readings file found yet' });
});

// Hardware Self-Test & Direct Clinical Demo Condition Trigger
app.post('/api/v1/hardware/test-pulse', (req, res) => {
  const condition = (req.body && req.body.condition) ? String(req.body.condition).toUpperCase() : 'NORMAL';
  const patientId = realtimeHub.activePatientId || 'pat-001';

  if (condition === 'RESET' || condition === 'REAL' || condition === 'LIVE') {
    const resetFrame = {
      type: 'ECG_FRAME',
      deviceId: 'DX-ESP8266-001',
      sessionId: 'sess-001',
      patientId: patientId,
      timestamp: Date.now(),
      leadsOff: true,
      signalQuality: 'LEADS_OFF',
      sampleRate: 125,
      heartRate: 0,
      spo2: 0,
      fingerDetected: false,
      samples: []
    };
    realtimeHub.handleEcgFrame(resetFrame, true);
    return res.json({ message: 'Reset to live hardware listening mode', condition: 'LIVE' });
  }

  let bpm = 74;
  let spo2 = 98;
  let isIrregular = false;

  if (condition === 'TACHYCARDIA') {
    bpm = req.body.bpm || 132;
    spo2 = req.body.spo2 || 97;
  } else if (condition === 'BRADYCARDIA') {
    bpm = req.body.bpm || 44;
    spo2 = req.body.spo2 || 98;
  } else if (condition === 'HYPOXEMIA') {
    bpm = req.body.bpm || 88;
    spo2 = req.body.spo2 || 86;
  } else if (condition === 'ARRHYTHMIA') {
    bpm = req.body.bpm || 84;
    spo2 = req.body.spo2 || 96;
    isIrregular = true;
  } else { // NORMAL
    bpm = req.body.bpm || 74;
    spo2 = req.body.spo2 || 99;
  }

  // Generate realistic 125 Hz Lead II ECG wave buffer (125 samples = 1 full second)
  const samples = [];
  const sampleRate = 125;
  const numSamples = 125;

  if (isIrregular) {
    // Uneven RR intervals with premature ectopic complexes
    const peakIndices = [12, 48, 88, 108];
    for (let i = 0; i < numSamples; i++) {
      let val = 512 + Math.round((Math.random() - 0.5) * 4);
      for (const p of peakIndices) {
        const dist = Math.abs(i - p);
        if (dist === 0) val = 950;
        else if (dist === 1) val = 780;
        else if (dist === 2) val = 340;
        else if (dist >= 3 && dist <= 6) val = 512 + Math.round(70 * Math.sin((dist - 3) * Math.PI / 4));
      }
      samples.push(Math.round(val));
    }
  } else {
    // Sinus rhythm at specified BPM
    const samplesPerBeat = Math.max(25, Math.round((60 / bpm) * sampleRate));
    for (let i = 0; i < numSamples; i++) {
      const beatPhase = (i % samplesPerBeat) / samplesPerBeat;
      let val = 512 + Math.round((Math.random() - 0.5) * 3);
      if (beatPhase >= 0.12 && beatPhase < 0.20) {
        val += 45 * Math.sin((beatPhase - 0.12) * Math.PI / 0.08); // P-wave
      } else if (beatPhase >= 0.23 && beatPhase < 0.25) {
        val -= 50; // Q-wave
      } else if (beatPhase >= 0.25 && beatPhase < 0.31) {
        val += 380 * Math.sin((beatPhase - 0.25) * Math.PI / 0.06); // R-peak
      } else if (beatPhase >= 0.31 && beatPhase < 0.34) {
        val -= 70; // S-wave
      } else if (beatPhase >= 0.42 && beatPhase < 0.60) {
        val += 85 * Math.sin((beatPhase - 0.42) * Math.PI / 0.18); // T-wave
      }
      samples.push(Math.round(val));
    }
  }

  const testFrame = {
    type: 'ECG_FRAME',
    deviceId: 'DX-ESP8266-001',
    sessionId: 'sess-001',
    patientId: patientId,
    timestamp: Date.now(),
    leadsOff: false,
    signalQuality: 'EXCELLENT',
    ecgSignalValid: true,
    sampleRate: 125,
    heartRate: bpm,
    spo2: spo2,
    fingerDetected: true,
    samples
  };

  realtimeHub.handleEcgFrame(testFrame, true);
  res.json({ message: `Injected demo condition: ${condition}`, condition, patientId, bpm, spo2 });
});

// Fallback for Single Page App
app.get('*', (req, res) => {
  res.sendFile(path.join(frontendPath, 'index.html'));
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('[EXPRESS ERROR]:', err.message);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// 7. Hardware USB Serial Telemetry Bridge (Active when device connects via USB)
function startHardwareSerialBridge() {
  const comPort = process.env.SERIAL_PORT || 'COM3';
  const baudRate = 115200;

  console.log(`[Hardware Bridge] Initializing continuous serial listener on ${comPort} (${baudRate} baud)...`);

  const localScriptPath = path.resolve(__dirname, '../scripts/serialReader.ps1');
  const fallbackScriptPath = 'C:\\Users\\91790\\.gemini\\antigravity\\brain\\7750c1fd-2b52-4ac6-aab4-2cb2af56e0b4\\scratch\\serialReader.ps1';
  const scriptPath = fs.existsSync(localScriptPath) ? localScriptPath : fallbackScriptPath;

  try {
    const ps = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-PortName', comPort, '-BaudRate', String(baudRate)]);
    let leftover = '';

    ps.stdout.on('data', (chunk) => {
      const text = leftover + chunk.toString();
      const lines = text.split(/\r?\n/);
      leftover = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length > 0 && !trimmed.startsWith('{')) {
          console.log('[ESP8266]:', trimmed);
        }
        if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue;

        try {
          const parsed = JSON.parse(trimmed);
          if (parsed.type === 'ECG_FRAME') {
            lastSerialPacketTime = Date.now();
            lastReceivedHardwareFrame = parsed;
            realtimeHub.handleEcgFrame(parsed, true);
          } else if (parsed.type === 'DEVICE_HEARTBEAT') {
            lastSerialPacketTime = Date.now();
            console.log(`[HARDWARE TELEMETRY] Heartbeat: HR=${parsed.heartRate} SpO2=${parsed.spo2}% Finger=${parsed.fingerDetected}`);
            realtimeHub.broadcast(`device:${parsed.deviceId}`, parsed);
            realtimeHub.broadcastAll(parsed);

            // Forward to dashboard vitals stream
            realtimeHub.handleEcgFrame({
              type: 'ECG_FRAME',
              deviceId: parsed.deviceId || 'DX-ESP8266-001',
              sessionId: 'sess-001',
              patientId: realtimeHub.activePatientId || 'pat-001',
              timestamp: Date.now(),
              leadsOff: Boolean(parsed.leadsOff),
              fingerDetected: Boolean(parsed.fingerDetected),
              heartRate: parsed.heartRate || 0,
              spo2: parsed.spo2 || 0,
              signalQuality: parsed.leadsOff ? 'LEADS_OFF' : 'EXCELLENT',
              samples: []
            }, true);
          }
        } catch (e) {
          // Ignore non-JSON output
        }
      }
    });

    ps.stderr.on('data', (err) => {
      console.warn('[Hardware Bridge STDERR]:', err.toString());
    });

    ps.on('exit', (code) => {
      console.warn(`[Hardware Bridge] Serial process exited with code ${code}. Reconnecting in 5s...`);
      setTimeout(startHardwareSerialBridge, 5000);
    });

    ps.on('error', (err) => {
      console.warn('[Hardware Bridge] Error:', err.message);
    });
  } catch (err) {
    console.warn('[Hardware Bridge] Failed to spawn serial listener:', err.message);
  }
}

// 8. Start Server
async function startServer() {
  await initDatabase();

  server.listen(config.PORT, () => {
    console.log('\n======================================================');
    console.log(`❤️  CardioX AI Platform running at http://localhost:${config.PORT}`);
    console.log(`📡 WebSocket Telemetry Gateway: ws://localhost:${config.PORT}/ws`);
    console.log(`👨‍⚕️ Doctor Dashboard & 📱 Patient App: http://localhost:${config.PORT}`);
    console.log(`🔒 Security: JWT Auth + Clinical RBAC Active`);
    console.log(`🩺 AI Engine: Non-Diagnostic Clinical Decision Support`);
    console.log('======================================================\n');

    // Automatically bind hardware serial stream from COM3
    startHardwareSerialBridge();
  });
}

startServer().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
