import { Router } from 'express';
import { memDb } from '../../config/database.js';
import { authenticate } from '../../middleware/auth.js';

const router = Router();

// GET /api/v1/vitals/patient/:id
router.get('/patient/:id', authenticate, (req, res) => {
  const { id } = req.params;
  const { range = '24h' } = req.query;

  const hrReadings = memDb.heart_rate_readings.filter(r => r.patient_id === id);
  const spo2Readings = memDb.spo2_readings.filter(r => r.patient_id === id);

  res.json({
    patientId: id,
    range,
    heartRate: hrReadings,
    spo2: spo2Readings
  });
});

// POST /api/v1/vitals/ingest (Direct ingestion from HTTP-based devices or gateways)
router.post('/ingest', (req, res) => {
  const { patientId, sessionId, heartRate, spo2, signalQuality = 'GOOD' } = req.body;

  if (!patientId || heartRate === undefined || spo2 === undefined) {
    return res.status(400).json({ error: 'Missing required fields: patientId, heartRate, spo2' });
  }

  const ts = new Date().toISOString();
  const source = req.body.source || 'hardware';

  memDb.heart_rate_readings.push({
    id: `hr-${Date.now()}`,
    session_id: sessionId || 'sess-active',
    patient_id: patientId,
    value_bpm: parseFloat(heartRate),
    confidence: 0.95,
    signal_quality: signalQuality,
    source,
    timestamp: ts
  });

  memDb.spo2_readings.push({
    id: `spo2-${Date.now()}`,
    session_id: sessionId || 'sess-active',
    patient_id: patientId,
    value_pct: parseFloat(spo2),
    confidence: 0.98,
    signal_quality: signalQuality,
    source,
    timestamp: ts
  });

  // Update patient snapshot
  const patient = memDb.patients.find(p => p.id === patientId);
  if (patient) {
    patient.current_hr = Math.round(heartRate);
    patient.current_spo2 = Math.round(spo2);
    patient.last_active = 'Just now';
    patient.status = signalQuality === 'LEADS_OFF' ? 'LEADS_OFF' : 'MONITORING';
  }

  // Real-time broadcast to all connected Patient and Doctor web clients
  const hub = req.app.locals.realtimeHub;
  if (hub) {
    hub.lastHardwarePacketTime = Date.now();
    hub.isHardwareActive = true;
    const hasValidHr = (heartRate > 0);
    const frame = {
      type: 'ECG_FRAME',
      deviceId: req.body.deviceId || 'DX-ESP8266-001',
      sessionId: sessionId || 'sess-001',
      patientId,
      timestamp: Date.now(),
      leadsOff: signalQuality === 'LEADS_OFF',
      signalQuality,
      heartRate: hasValidHr ? Math.round(heartRate) : 0,
      spo2: (spo2 > 0) ? Math.round(spo2) : 0,
      fingerDetected: (req.body.fingerDetected !== undefined) ? Boolean(req.body.fingerDetected) : hasValidHr,
      samples: (req.body.samples && Array.isArray(req.body.samples)) ? req.body.samples : []
    };
    hub.broadcast(`patient:${patientId}`, frame);
    if (sessionId) {
      hub.broadcast(`session:${sessionId}`, frame);
    }
    hub.broadcastAll(frame);
  }

  res.status(201).json({ status: 'INGESTED', timestamp: ts });
});

export default router;
