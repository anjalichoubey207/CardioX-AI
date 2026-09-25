import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { memDb } from '../../config/database.js';
import { authenticate, requireRole } from '../../middleware/auth.js';

const router = Router();

// GET /api/v1/notes/patient/:patientId
router.get('/patient/:patientId', authenticate, (req, res) => {
  const { patientId } = req.params;

  // Patients can view notes for themselves, doctors can view any assigned patient notes
  if (req.user.role === 'PATIENT' && req.user.patientId !== patientId) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const notes = memDb.doctor_notes
    .filter(n => n.patient_id === patientId)
    .slice()
    .reverse();

  res.json({ notes });
});

// POST /api/v1/notes (Doctor add note)
router.post('/', authenticate, requireRole('DOCTOR', 'ADMIN'), (req, res) => {
  const { patient_id, session_id, note_text } = req.body;

  if (!patient_id || !note_text) {
    return res.status(400).json({ error: 'patient_id and note_text are required' });
  }

  const doctor = memDb.doctors.find(d => d.user_id === req.user.id) || { id: 'doc-001' };
  const user = memDb.users.find(u => u.id === req.user.id);

  const newNote = {
    id: `not-${uuidv4().slice(0, 8)}`,
    patient_id,
    doctor_id: doctor.id,
    doctor_name: user ? user.full_name : 'Dr. Evelyn Vance, MD',
    session_id: session_id || null,
    note_text,
    created_at: new Date().toISOString()
  };

  memDb.doctor_notes.push(newNote);

  res.status(201).json({ message: 'Doctor note recorded', note: newNote });
});

export default router;
