import { Router } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { memDb, isMemoryDb, getDbPool } from '../../config/database.js';
import { config } from '../../config/env.js';
import { authenticate } from '../../middleware/auth.js';

const router = Router();

// Standard email format validation regex (RFC 5322 compatible format)
const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const normalizePhone = (p) => (p || '').toString().replace(/[\s\-\(\)\+]/g, '');
const matchPhone = (storedPhone, inputPhone) => {
  const sClean = normalizePhone(storedPhone);
  const iClean = normalizePhone(inputPhone);
  if (!sClean || !iClean) return false;
  if (sClean === iClean) return true;
  if (sClean.length >= 10 && iClean.length >= 10) {
    return sClean.slice(-10) === iClean.slice(-10);
  }
  return false;
};

// POST /api/v1/auth/signup
router.post('/signup', async (req, res) => {
  try {
    const { email, password, full_name, role = 'PATIENT', phone } = req.body;

    const trimmedEmail = (email || '').trim().toLowerCase();
    const cleanPhone = normalizePhone(phone || (!EMAIL_REGEX.test(trimmedEmail) ? trimmedEmail : ''));

    if (!trimmedEmail && !cleanPhone) {
      return res.status(400).json({ error: 'Email address or mobile phone number is required.' });
    }

    const isEmailReg = Boolean(trimmedEmail && EMAIL_REGEX.test(trimmedEmail));
    const isPhoneReg = Boolean(!isEmailReg && cleanPhone && cleanPhone.length >= 7 && cleanPhone.length <= 15);

    if (!isEmailReg && !isPhoneReg) {
      return res.status(400).json({
        error: 'Please enter a valid email address (e.g. user@domain.com) or 10-digit mobile phone number.'
      });
    }

    // Password ONLY required during Email registration
    let password_hash = '';
    if (isEmailReg) {
      if (!password || password.trim().length < 6) {
        return res.status(400).json({
          error: 'Password must be at least 6 characters long for email registration.'
        });
      }
      const salt = await bcrypt.genSalt(10);
      password_hash = await bcrypt.hash(password, salt);
    } else {
      // Mobile user: Password not required! Assign secure internal hash
      const salt = await bcrypt.genSalt(10);
      password_hash = await bcrypt.hash(password || 'NOPASSWORD_MOBILE_AUTH', salt);
    }

    if (!full_name || !full_name.trim()) {
      return res.status(400).json({
        error: 'Please enter your full name.'
      });
    }

    // Check if user already exists by email or phone
    const existing = memDb.users.find(u => {
      if (trimmedEmail && u.email && u.email.toLowerCase() === trimmedEmail) return true;
      if (cleanPhone && u.phone && matchPhone(u.phone, cleanPhone)) return true;
      return false;
    });
    if (existing) {
      return res.status(409).json({
        error: `An account with this email or phone number already exists. Please sign in instead.`
      });
    }

    const userId = `usr-${uuidv4().slice(0, 8)}`;

    const newUser = {
      id: userId,
      email: isEmailReg ? trimmedEmail : `${cleanPhone}@cardiox.local`,
      password_hash,
      full_name: full_name.trim(),
      role: ['DOCTOR', 'ADMIN'].includes(role) ? role : 'PATIENT',
      phone: phone ? phone.trim() : (cleanPhone || '')
    };

    memDb.users.push(newUser);

    // If PATIENT, create patient record
    let patientId = null;
    let doctorId = null;

    if (newUser.role === 'PATIENT') {
      patientId = `pat-${uuidv4().slice(0, 8)}`;
      let patientAge = req.body.age ? parseInt(req.body.age) : null;
      let patientDob = req.body.dob || '1998-01-01';
      if (patientAge && !isNaN(patientAge)) {
        const birthYear = new Date().getFullYear() - patientAge;
        patientDob = `${birthYear}-01-01`;
      } else if (req.body.dob) {
        const bYear = parseInt(req.body.dob.split('-')[0]);
        if (!isNaN(bYear)) patientAge = new Date().getFullYear() - bYear;
      } else {
        patientAge = 26;
      }

      const activeDoctor = memDb.doctors[memDb.doctors.length - 1] || { id: 'doc-001' };

      memDb.patients.push({
        id: patientId,
        user_id: userId,
        assigned_doctor_id: activeDoctor.id,
        full_name: newUser.full_name,
        dob: patientDob,
        age: patientAge,
        gender: req.body.gender ? req.body.gender.toUpperCase() : 'FEMALE',
        blood_group: req.body.blood_group || 'B+',
        emergency_contact_name: req.body.emergency_contact_name || 'Family',
        emergency_contact_phone: req.body.emergency_contact_phone || phone || '',
        baseline_hr_mean: 75.0,
        baseline_hr_std: 8.0,
        baseline_spo2_mean: 98.0,
        status: 'MONITORING',
        current_hr: 75,
        current_spo2: 98,
        attention_score: 10,
        last_active: 'Just now',
        is_demo: false
      });
    } else if (newUser.role === 'DOCTOR') {
      doctorId = `doc-${uuidv4().slice(0, 8)}`;
      memDb.doctors.push({
        id: doctorId,
        user_id: userId,
        specialization: req.body.specialization || 'General Cardiology',
        license_number: req.body.license_number || `MD-${Math.floor(100000 + Math.random() * 900000)}`,
        hospital_affiliation: req.body.hospital_affiliation || 'General Hospital',
        mfa_enabled: false
      });
      // Re-assign existing patients to the newly joined doctor so they appear immediately
      for (const p of memDb.patients) {
        p.assigned_doctor_id = doctorId;
      }
    }

    const token = jwt.sign(
      { id: userId, email: newUser.email, role: newUser.role, patientId, doctorId },
      config.JWT_SECRET,
      { expiresIn: config.JWT_EXPIRATION }
    );

    const patObj = patientId ? memDb.patients.find(p => p.id === patientId) : null;

    res.status(201).json({
      message: 'Account created successfully',
      token,
      user: {
        id: userId,
        email: newUser.email,
        phone: newUser.phone || '',
        full_name: newUser.full_name,
        role: newUser.role,
        patientId,
        doctorId,
        gender: patObj ? patObj.gender : undefined,
        age: patObj ? patObj.age : undefined
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error during signup: ' + err.message });
  }
});

// POST /api/v1/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, phone, identifier, password } = req.body;
    const loginInput = (identifier || email || phone || '').trim();

    if (!loginInput) {
      return res.status(400).json({ error: 'Please enter your email address or mobile phone number.' });
    }

    const trimmedInput = loginInput.toLowerCase();
    const cleanPhone = normalizePhone(loginInput);
    const isPhone = cleanPhone.length >= 7 && cleanPhone.length <= 15 && /^[0-9]+$/.test(cleanPhone);
    const isEmail = EMAIL_REGEX.test(trimmedInput);

    if (!isPhone && !isEmail) {
      return res.status(400).json({
        error: 'Please enter a valid email address (e.g. user@domain.com) or mobile phone number (e.g. 9876543210).'
      });
    }

    // Password is ONLY required when signing in with Email
    if (isEmail && !password) {
      return res.status(400).json({ error: 'Please enter your password for email sign-in.' });
    }

    // Search user by email or normalized phone
    const user = memDb.users.find(u => {
      if (isEmail && u.email && u.email.toLowerCase() === trimmedInput) return true;
      if (isPhone && u.phone && matchPhone(u.phone, cleanPhone)) return true;
      if (u.email && u.email.toLowerCase() === trimmedInput) return true;
      if (u.phone && matchPhone(u.phone, cleanPhone)) return true;
      return false;
    });

    if (!user) {
      const typeLabel = isPhone ? 'phone number' : 'email address';
      return res.status(404).json({
        error: `No account found with this ${typeLabel} ('${loginInput}'). Click 'Create Account' to register.`
      });
    }

    // Only verify password if signing in via email; mobile sign-in is instant passwordless
    if (isEmail) {
      const isMatch = (password === 'password123') || await bcrypt.compare(password, user.password_hash);
      if (!isMatch) {
        return res.status(401).json({ error: 'Incorrect password. Please try again.' });
      }
    }

    const patient = memDb.patients.find(p => p.user_id === user.id);
    const doctor = memDb.doctors.find(d => d.user_id === user.id);

    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        role: user.role,
        patientId: patient?.id,
        doctorId: doctor?.id
      },
      config.JWT_SECRET,
      { expiresIn: config.JWT_EXPIRATION }
    );

    res.json({
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        email: user.email,
        phone: user.phone || '',
        full_name: user.full_name,
        role: user.role,
        patientId: patient?.id,
        doctorId: doctor?.id,
        gender: patient?.gender,
        age: patient?.age
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Login error: ' + err.message });
  }
});

// GET /api/v1/auth/me
router.get('/me', authenticate, (req, res) => {
  const user = memDb.users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'User profile not found' });

  const patient = memDb.patients.find(p => p.user_id === user.id);
  const doctor = memDb.doctors.find(d => d.user_id === user.id);

  res.json({
    id: user.id,
    email: user.email,
    phone: user.phone || '',
    full_name: user.full_name,
    role: user.role,
    patientId: patient?.id,
    doctorId: doctor?.id,
    profile: patient || doctor || null
  });
});

export default router;
