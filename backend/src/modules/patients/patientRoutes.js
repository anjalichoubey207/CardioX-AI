import { Router } from 'express';
import { memDb } from '../../config/database.js';
import { authenticate, requireRole } from '../../middleware/auth.js';

const router = Router();

// GET /api/v1/patients (Doctor/Admin/Authenticated listing with filters)
router.get('/', authenticate, (req, res) => {
  const { status, attention, search } = req.query;

  let list = memDb.patients.map(p => {
    const user = memDb.users.find(u => u.id === p.user_id);
    const activeSession = memDb.monitoring_sessions.find(s => s.patient_id === p.id && s.status === 'MONITORING');
    
    return {
      ...p,
      is_demo: Boolean(p.is_demo),
      email: user?.email || '',
      full_name: p.full_name || user?.full_name || 'Patient',
      phone: user?.phone || '',
      hasActiveSession: !!activeSession,
      activeSessionId: activeSession?.id || null
    };
  });

  // Sort real patients first, demo patient at bottom
  list.sort((a, b) => {
    if (a.is_demo === b.is_demo) return 0;
    return a.is_demo ? 1 : -1;
  });

  if (status) {
    list = list.filter(p => p.status.toLowerCase() === status.toLowerCase());
  }

  if (attention) {
    list = list.filter(p => {
      if (attention === 'LOW') return p.attention_score <= 30;
      if (attention === 'MODERATE') return p.attention_score > 30 && p.attention_score <= 60;
      if (attention === 'HIGH') return p.attention_score > 60;
      return true;
    });
  }

  if (search) {
    const term = search.toLowerCase();
    list = list.filter(p => p.full_name.toLowerCase().includes(term) || p.id.toLowerCase().includes(term));
  }

  res.json({ count: list.length, patients: list });
});

// GET /api/v1/patients/:id (Patient detail)
router.get('/:id', authenticate, (req, res) => {
  const { id } = req.params;

  // Authorization: A patient can only read their own record; Doctors can read any assigned patient
  if (req.user.role === 'PATIENT' && req.user.patientId !== id) {
    return res.status(403).json({ error: 'Access denied: You can only view your own records' });
  }

  const patient = memDb.patients.find(p => p.id === id);
  if (!patient) return res.status(404).json({ error: 'Patient not found' });

  const user = memDb.users.find(u => u.id === patient.user_id);
  const activeSession = memDb.monitoring_sessions.find(s => s.patient_id === id && s.status === 'MONITORING');
  const pastSessions = memDb.monitoring_sessions.filter(s => s.patient_id === id && s.status === 'COMPLETED');
  const recentAlerts = memDb.alerts.filter(a => a.patient_id === id).slice(-5);
  const doctorNotes = memDb.doctor_notes.filter(n => n.patient_id === id).slice(-10);

  res.json({
    ...patient,
    email: user?.email,
    full_name: patient.full_name || user?.full_name,
    activeSession,
    pastSessionsCount: pastSessions.length,
    recentAlerts,
    doctorNotes
  });
});

// PATCH /api/v1/patients/:id (Update patient profile / name)
router.patch('/:id', authenticate, (req, res) => {
  const { id } = req.params;
  const { full_name, gender, dob, age, blood_group } = req.body;

  const patient = memDb.patients.find(p => p.id === id);
  if (!patient) return res.status(404).json({ error: 'Patient not found' });

  if (full_name) {
    patient.full_name = full_name;
    const user = memDb.users.find(u => u.id === patient.user_id);
    if (user) user.full_name = full_name;
  }
  if (gender) patient.gender = gender.toUpperCase();
  if (dob) patient.dob = dob;
  if (age !== undefined && !isNaN(parseInt(age))) {
    patient.age = parseInt(age);
    const birthYear = new Date().getFullYear() - patient.age;
    patient.dob = `${birthYear}-01-01`;
  }
  if (blood_group) patient.blood_group = blood_group;

  res.json({ message: 'Patient profile updated', patient });
});

// POST /api/v1/patients (Add new real patient directly from dashboard)
router.post('/', authenticate, (req, res) => {
  const { 
    id, 
    patient_id, 
    email, 
    full_name, 
    gender = 'FEMALE', 
    age, 
    dob, 
    blood_group = 'B+', 
    phone = '' 
  } = req.body;

  if (!full_name || !full_name.trim()) {
    return res.status(400).json({ error: 'Patient full name is required' });
  }

  let calculatedAge = age ? parseInt(age) : 26;
  let patientDob = dob || '1998-01-01';
  if (age && !isNaN(parseInt(age))) {
    calculatedAge = parseInt(age);
    const birthYear = new Date().getFullYear() - calculatedAge;
    patientDob = `${birthYear}-01-01`;
  } else if (dob) {
    const bYear = parseInt(dob.split('-')[0]);
    if (!isNaN(bYear)) calculatedAge = new Date().getFullYear() - bYear;
  }

  // Support user-specified patient ID or auto-generate
  let newPatientId = (patient_id || id || '').trim();
  if (!newPatientId) {
    const nextNum = memDb.patients.length + 1;
    newPatientId = `pat-${String(nextNum).padStart(3, '0')}`;
  }

  // Ensure unique patient ID
  const existingPatient = memDb.patients.find(p => p.id.toLowerCase() === newPatientId.toLowerCase());
  if (existingPatient) {
    return res.status(409).json({ error: `Patient ID '${newPatientId}' already exists. Please choose a different ID.` });
  }

  const newUserId = `usr-${newPatientId}`;
  const patientEmail = (email && email.trim()) 
    ? email.trim().toLowerCase() 
    : `${newPatientId.toLowerCase()}@cardiox.ai`;

  const activeDoctor = memDb.doctors[memDb.doctors.length - 1] || { id: 'doc-001' };

  const newPatient = {
    id: newPatientId,
    user_id: newUserId,
    assigned_doctor_id: activeDoctor.id,
    full_name: full_name.trim(),
    dob: patientDob,
    age: calculatedAge,
    gender: gender.toUpperCase(),
    blood_group: blood_group,
    emergency_contact_name: 'Family',
    emergency_contact_phone: phone || '+91-98765-43210',
    baseline_hr_mean: 72.0,
    baseline_hr_std: 6.5,
    baseline_spo2_mean: 98.2,
    status: 'OFFLINE',
    current_hr: null,
    current_spo2: null,
    attention_score: 10,
    last_active: 'Never',
    is_demo: false,
    conditions: ['Baseline Cardiac Monitoring Established'],
    medications: ['None currently prescribed'],
    allergies: ['No known drug allergies (NKDA)'],
    history_timeline: [
      {
        date: new Date().toISOString().split('T')[0],
        type: 'Intake Registration',
        doctor: req.user.full_name || 'Dr. Evelyn Vance, MD',
        summary: 'Patient registered to CardioX continuous monitoring telemetry.'
      }
    ]
  };

  memDb.users.push({
    id: newUserId,
    email: patientEmail,
    password_hash: '$2a$10$9Z3s0Gf5sQZf1N1C6dJ8QeNqL1K2M3P4R5T6V7W8X9Y0Z1A2B3C4D',
    full_name: full_name.trim(),
    role: 'PATIENT',
    phone: phone
  });

  memDb.patients.push(newPatient);

  res.status(201).json({ 
    message: 'Patient added successfully', 
    patient: {
      ...newPatient,
      email: patientEmail
    } 
  });
});

// POST /api/v1/patients/:id/history (Doctor appends clinical history or updates medical conditions/medications)
router.post('/:id/history', authenticate, (req, res) => {
  const { id } = req.params;
  const { type, summary, conditions, medications, allergies } = req.body;

  const patient = memDb.patients.find(p => p.id === id);
  if (!patient) return res.status(404).json({ error: 'Patient not found' });

  if (conditions && Array.isArray(conditions)) patient.conditions = conditions;
  if (medications && Array.isArray(medications)) patient.medications = medications;
  if (allergies && Array.isArray(allergies)) patient.allergies = allergies;

  if (summary && summary.trim()) {
    if (!patient.history_timeline) patient.history_timeline = [];
    const entry = {
      date: new Date().toISOString().split('T')[0],
      type: type || 'Clinical Telemetry Review',
      doctor: req.user.full_name || 'Dr. Evelyn Vance, MD',
      summary: summary.trim()
    };
    patient.history_timeline.unshift(entry);
  }

  res.status(201).json({ 
    message: 'Patient history updated successfully', 
    patient 
  });
});

export default router;
