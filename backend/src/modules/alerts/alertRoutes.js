import { Router } from 'express';
import { memDb } from '../../config/database.js';
import { authenticate, requireRole } from '../../middleware/auth.js';

const router = Router();

// GET /api/v1/alerts
router.get('/', authenticate, (req, res) => {
  let list = memDb.alerts.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  // If patient, only show their own alerts
  if (req.user.role === 'PATIENT') {
    list = list.filter(a => a.patient_id === req.user.patientId);
  }

  const enriched = list.map(a => {
    const patient = memDb.patients.find(p => p.id === a.patient_id);
    return {
      ...a,
      patient_name: patient ? patient.full_name : 'Patient'
    };
  });

  res.json({ alerts: enriched });
});

// PATCH /api/v1/alerts/:id/ack (Doctor acknowledge alert)
router.patch('/:id/ack', authenticate, requireRole('DOCTOR', 'ADMIN'), (req, res) => {
  const { id } = req.params;
  const alert = memDb.alerts.find(a => a.id === id);

  if (!alert) return res.status(404).json({ error: 'Alert not found' });

  alert.is_acknowledged = true;
  alert.acknowledged_by = req.user.id;
  alert.acknowledged_at = new Date().toISOString();

  res.json({ message: 'Alert acknowledged', alert });
});

export default router;
