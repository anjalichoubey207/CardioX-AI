import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { memDb } from '../../config/database.js';
import { authenticate } from '../../middleware/auth.js';
import { CardioXAiService } from '../../services/aiService.js';

const router = Router();

// POST /api/v1/ai/analyze (Direct telemetry evaluation)
router.post('/analyze', authenticate, (req, res) => {
  const sessionId = req.body.sessionId || 'sess-001';
  const session = memDb.monitoring_sessions.find(s => s.id === sessionId) || memDb.monitoring_sessions[0];
  const patient = memDb.patients.find(p => p.id === (req.body.patientId || (session && session.patient_id))) || memDb.patients[0];
  const ecgRecords = memDb.ecg_samples.filter(e => e.session_id === sessionId);
  const allSamples = (req.body.samples && Array.isArray(req.body.samples)) ? req.body.samples : ecgRecords.flatMap(e => e.samples || e.samples_data || []);

  const aiResult = CardioXAiService.analyzeSession(session, patient, allSamples);

  res.json({
    message: 'AI analysis complete',
    analysis: aiResult
  });
});

// POST /api/v1/ai/analyze/:sessionId
router.post('/analyze/:sessionId', authenticate, (req, res) => {
  const { sessionId } = req.params;
  const session = memDb.monitoring_sessions.find(s => s.id === sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const patient = memDb.patients.find(p => p.id === session.patient_id);
  const ecgRecords = memDb.ecg_samples.filter(e => e.session_id === sessionId);
  const allSamples = ecgRecords.flatMap(e => e.samples_data || []);

  const aiResult = CardioXAiService.analyzeSession(session, patient, allSamples);

  // Update session record
  session.attention_score = aiResult.attentionScore;

  // Store in ai_analyses
  let analysis = memDb.ai_analyses.find(a => a.session_id === sessionId);
  if (!analysis) {
    analysis = {
      id: `ai-${uuidv4().slice(0, 8)}`,
      session_id: sessionId,
      patient_id: session.patient_id,
      ...aiResult,
      created_at: new Date().toISOString()
    };
    memDb.ai_analyses.push(analysis);
  } else {
    Object.assign(analysis, aiResult);
  }

  res.json({
    message: 'AI session evaluation complete',
    analysis
  });
});

// POST /api/v1/ai/evaluate-vitals (Real-time live multi-parametric AI evaluation)
router.post('/evaluate-vitals', authenticate, (req, res) => {
  const { patientId = 'pat-001', hr = null, spo2 = null, ecgSamples = [], leadsOff = false } = req.body;

  const patient = memDb.patients.find(p => p.id === patientId) || memDb.patients[0] || {};
  const patientHrHistory = memDb.heart_rate_readings.filter(r => r.patient_id === patientId);
  const patientSpo2History = memDb.spo2_readings.filter(r => r.patient_id === patientId);

  // If no live samples passed in request body, check if recent samples exist in memory DB
  let samplesToAnalyze = ecgSamples;
  if ((!samplesToAnalyze || samplesToAnalyze.length === 0) && memDb.ecg_samples.length > 0) {
    const recentEcg = memDb.ecg_samples.filter(e => e.patient_id === patientId).slice(-4);
    samplesToAnalyze = recentEcg.flatMap(e => e.samples || e.samples_data || []);
  }

  const effectiveHr = (hr !== null && hr !== undefined) ? parseInt(hr) : patient.current_hr;
  const effectiveSpo2 = (spo2 !== null && spo2 !== undefined) ? parseInt(spo2) : patient.current_spo2;
  const effectiveLeadsOff = (leadsOff !== undefined) ? Boolean(leadsOff) : Boolean(patient.leads_off);

  const evaluation = CardioXAiService.evaluatePatientVitals({
    patientId: patient.id || patientId,
    hr: effectiveHr,
    spo2: effectiveSpo2,
    ecgSamples: samplesToAnalyze,
    sampleRate: 125,
    leadsOff: effectiveLeadsOff,
    patient,
    historicalReadings: {
      hr: patientHrHistory,
      spo2: patientSpo2History
    }
  });

  // Update patient's attention score
  if (patient) {
    patient.attention_score = evaluation.riskScore;
  }

  res.json({
    message: 'AI evaluation complete',
    evaluation
  });
});

// GET /api/v1/ai/summary/:sessionId
router.get('/summary/:sessionId', authenticate, (req, res) => {
  const { sessionId } = req.params;
  const analysis = memDb.ai_analyses.find(a => a.session_id === sessionId);

  if (!analysis) {
    return res.status(404).json({ error: 'AI summary not found for this session' });
  }

  res.json({ analysis });
});

export default router;
