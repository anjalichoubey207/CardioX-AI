import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { memDb } from '../../config/database.js';
import { authenticate } from '../../middleware/auth.js';
import { CardioXAiService } from '../../services/aiService.js';

const router = Router();

// POST /api/v1/sessions/start
router.post('/start', authenticate, (req, res) => {
  const patientId = req.body.patientId || req.user.patientId;
  if (!patientId) return res.status(400).json({ error: 'patientId is required' });

  // Find patient
  const patient = memDb.patients.find(p => p.id === patientId);
  if (!patient) return res.status(404).json({ error: 'Patient not found' });

  // Check if session already active
  let active = memDb.monitoring_sessions.find(s => s.patient_id === patientId && s.status === 'MONITORING');
  if (active) {
    return res.json({ message: 'Session already in progress', session: active });
  }

  const newSession = {
    id: `sess-${uuidv4().slice(0, 8)}`,
    patient_id: patientId,
    device_id: 'dev-001',
    status: 'MONITORING',
    started_at: new Date().toISOString(),
    ended_at: null,
    duration_seconds: 0,
    avg_hr: 75.0,
    min_hr: 70.0,
    max_hr: 82.0,
    avg_spo2: 98.0,
    min_spo2: 97.0,
    attention_score: 12
  };

  memDb.monitoring_sessions.push(newSession);
  patient.status = 'MONITORING';

  res.status(201).json({
    message: 'Monitoring session initiated',
    session: newSession
  });
});

// POST /api/v1/sessions/:id/stop
router.post('/:id/stop', authenticate, (req, res) => {
  const { id } = req.params;
  const session = memDb.monitoring_sessions.find(s => s.id === id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const patient = memDb.patients.find(p => p.id === session.patient_id);

  const startTime = new Date(session.started_at).getTime();
  const endTime = Date.now();
  const durationSec = Math.max(120, Math.floor((endTime - startTime) / 1000));

  session.status = 'COMPLETED';
  session.ended_at = new Date(endTime).toISOString();
  session.duration_seconds = durationSec;

  if (patient) {
    patient.status = 'OFFLINE';
  }

  // Automatically trigger AI Analysis pipeline
  const aiResult = CardioXAiService.analyzeSession(session, patient, []);
  session.attention_score = aiResult.attentionScore;

  const analysisRecord = {
    id: `ai-${uuidv4().slice(0, 8)}`,
    session_id: session.id,
    patient_id: session.patient_id,
    attention_score: aiResult.attentionScore,
    attention_level: aiResult.attentionLevel,
    signal_quality_score: aiResult.signalConfidence,
    hr_trend: aiResult.hrTrend,
    spo2_trend: aiResult.spo2Trend,
    baseline_deviation: aiResult.baselineDeviation,
    observed_patterns: aiResult.observedPatterns,
    summary_text: aiResult.summaryText,
    disclaimer_text: aiResult.disclaimer,
    created_at: new Date().toISOString()
  };

  memDb.ai_analyses.push(analysisRecord);

  res.json({
    message: 'Session completed and AI analysis generated',
    session,
    analysis: analysisRecord
  });
});

// GET /api/v1/sessions/:id
router.get('/:id', authenticate, (req, res) => {
  const { id } = req.params;
  const session = memDb.monitoring_sessions.find(s => s.id === id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const analysis = memDb.ai_analyses.find(a => a.session_id === id);
  const patient = memDb.patients.find(p => p.id === session.patient_id);

  res.json({
    session,
    patientName: patient?.full_name,
    analysis: analysis || null
  });
});

// GET /api/v1/sessions/patient/:patientId
router.get('/patient/:patientId', authenticate, (req, res) => {
  const { patientId } = req.params;
  const sessions = memDb.monitoring_sessions
    .filter(s => s.patient_id === patientId)
    .map(s => {
      const analysis = memDb.ai_analyses.find(a => a.session_id === s.id);
      return {
        ...s,
        analysis: analysis || null
      };
    });

  res.json({ sessions });
});

export default router;
