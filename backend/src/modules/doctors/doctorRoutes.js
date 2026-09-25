import { Router } from 'express';
import { memDb } from '../../config/database.js';
import { authenticate, requireRole } from '../../middleware/auth.js';

const router = Router();

// GET /api/v1/doctors/overview-stats
router.get('/overview-stats', authenticate, requireRole('DOCTOR', 'ADMIN'), (req, res) => {
  const totalPatients = memDb.patients.length;
  const activeMonitoring = memDb.monitoring_sessions.filter(s => s.status === 'MONITORING').length;
  const activeAlerts = memDb.alerts.filter(a => !a.is_acknowledged).length;

  const recentAlerts = memDb.alerts
    .slice()
    .reverse()
    .slice(0, 5)
    .map(a => {
      const patient = memDb.patients.find(p => p.id === a.patient_id);
      return {
        ...a,
        patient_name: patient ? patient.full_name : 'Unknown Patient'
      };
    });

  const activeSessions = memDb.monitoring_sessions
    .filter(s => s.status === 'MONITORING')
    .map(s => {
      const patient = memDb.patients.find(p => p.id === s.patient_id);
      return {
        sessionId: s.id,
        patientId: s.patient_id,
        patientName: patient ? patient.full_name : 'Patient',
        currentHr: patient?.current_hr || 75,
        currentSpo2: patient?.current_spo2 || 98,
        attentionScore: patient?.attention_score || 15,
        durationSeconds: s.duration_seconds || 600,
        startedAt: s.started_at
      };
    });

  res.json({
    stats: {
      totalPatients,
      activeMonitoring,
      activeAlerts
    },
    activeSessions,
    recentAlerts
  });
});

export default router;
