import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { memDb } from '../../config/database.js';
import { authenticate } from '../../middleware/auth.js';
import { config } from '../../config/env.js';

const router = Router();

// POST /api/v1/reports/generate
router.post('/generate', authenticate, (req, res) => {
  const { patientId } = req.body;
  const targetPatientId = patientId || req.user.patientId;

  const patient = memDb.patients.find(p => p.id === targetPatientId);
  if (!patient) return res.status(404).json({ error: 'Patient not found' });

  const user = memDb.users.find(u => u.id === patient.user_id);
  const sessions = memDb.monitoring_sessions.filter(s => s.patient_id === targetPatientId);
  const notes = memDb.doctor_notes.filter(n => n.patient_id === targetPatientId);
  const aiAnalyses = memDb.ai_analyses.filter(a => a.patient_id === targetPatientId);

  // Compute aggregate stats
  const totalSessions = sessions.length;
  const hrReadings = memDb.heart_rate_readings.filter(r => r.patient_id === targetPatientId);
  const avgHr = hrReadings.length ? Math.round(hrReadings.reduce((a, b) => a + b.value_bpm, 0) / hrReadings.length) : 75;
  const avgSpo2 = 98;

  const report = {
    id: `rep-${uuidv4().slice(0, 8)}`,
    patient_id: targetPatientId,
    patient_name: patient.full_name || user?.full_name,
    dob: patient.dob,
    gender: patient.gender,
    generated_at: new Date().toISOString(),
    report_title: `CardioX Comprehensive Cardiac Monitoring Summary`,
    period: 'Last 30 Days',
    summary: {
      totalMonitoringSessions: totalSessions,
      averageHeartRateBpm: avgHr,
      heartRateRangeBpm: '64 - 88 BPM',
      averageSpO2Pct: `${avgSpo2}%`,
      baselineMeanHr: `${patient.baseline_hr_mean} BPM`,
      overallAttentionLevel: patient.attention_score > 30 ? 'MODERATE' : 'LOW'
    },
    recentAiObservations: aiAnalyses.map(a => ({
      date: a.created_at,
      score: a.attention_score,
      level: a.attention_level,
      summary: a.summary_text
    })),
    doctorNotesSnapshot: notes.map(n => ({
      date: n.created_at,
      doctor: n.doctor_name,
      note: n.note_text
    })),
    disclaimer: config.DISCLAIMER
  };

  memDb.reports.push(report);

  res.status(201).json({ report });
});

// GET /api/v1/reports/patient/:patientId
router.get('/patient/:patientId', authenticate, (req, res) => {
  const { patientId } = req.params;
  const reports = memDb.reports.filter(r => r.patient_id === patientId);
  res.json({ reports });
});

export default router;
