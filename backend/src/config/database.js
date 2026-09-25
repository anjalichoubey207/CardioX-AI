import mysql from 'mysql2/promise';
import { config } from './env.js';

let pool = null;
let useMemoryFallback = false;

// In-Memory Database Store (Mirror of tables for frictionless development/demo)
export const memDb = {
  users: [
    {
      id: 'usr-doc-001',
      email: 'doctor@cardiox.ai',
      password_hash: '$2a$10$9Z3s0Gf5sQZf1N1C6dJ8QeNqL1K2M3P4R5T6V7W8X9Y0Z1A2B3C4D', // password123
      full_name: 'Dr. Evelyn Vance, MD',
      role: 'DOCTOR',
      phone: '9876500001'
    },
    {
      id: 'usr-pat-001',
      email: 'annindita@cardiox.ai',
      password_hash: '$2a$10$9Z3s0Gf5sQZf1N1C6dJ8QeNqL1K2M3P4R5T6V7W8X9Y0Z1A2B3C4D', // password123
      full_name: 'Annindita (Demo Patient)',
      role: 'PATIENT',
      phone: '9876543210'
    },
    {
      id: 'usr-pat-002',
      email: 'patient@cardiox.ai',
      password_hash: '$2a$10$9Z3s0Gf5sQZf1N1C6dJ8QeNqL1K2M3P4R5T6V7W8X9Y0Z1A2B3C4D', // password123
      full_name: 'Annindita Mukherjee',
      role: 'PATIENT',
      phone: '9876543210'
    },
    {
      id: 'usr-pat-003',
      email: 'robert@cardiox.ai',
      password_hash: '$2a$10$9Z3s0Gf5sQZf1N1C6dJ8QeNqL1K2M3P4R5T6V7W8X9Y0Z1A2B3C4D', // password123
      full_name: 'Robert Chen',
      role: 'PATIENT',
      phone: '9876500002'
    }
  ],
  doctors: [
    {
      id: 'doc-001',
      user_id: 'usr-doc-001',
      specialization: 'Interventional Cardiology',
      license_number: 'MD-NY-849204',
      hospital_affiliation: 'Metropolitan Cardiac Institute',
      mfa_enabled: false
    }
  ],
  patients: [
    {
      id: 'pat-001',
      user_id: 'usr-pat-001',
      assigned_doctor_id: 'doc-001',
      full_name: 'Annindita',
      dob: '1998-05-20',
      gender: 'FEMALE',
      blood_group: 'B+',
      emergency_contact_name: 'Family',
      emergency_contact_phone: '+91-98765-43210',
      baseline_hr_mean: 72.0,
      baseline_hr_std: 6.5,
      baseline_spo2_mean: 98.2,
      status: 'IDLE',
      current_hr: null,
      current_spo2: null,
      attention_score: 10,
      last_active: 'Waiting for sensor',
      is_demo: true,
      conditions: [
        'Mild Sinus Arrhythmia (Diagnosed 2024)',
        'Occasional post-exercise palpitations',
        'No prior myocardial infarction or stroke'
      ],
      medications: [
        'Metoprolol Succinate 25mg (Once daily morning)',
        'Omega-3 Fatty Acids 1000mg',
        'Multivitamin Daily'
      ],
      allergies: [
        'Penicillin (Causes mild cutaneous rash)',
        'No known food allergies'
      ],
      history_timeline: [
        {
          date: '2026-09-20',
          type: 'Continuous Holter Telemetry',
          doctor: 'Dr. Evelyn Vance, MD',
          summary: '24-hour baseline evaluation. Sinus cadence normal with healthy heart rate variability (HRV).'
        },
        {
          date: '2026-08-14',
          type: 'Cardiology Follow-up',
          doctor: 'Dr. Evelyn Vance, MD',
          summary: 'Routine cardiac review. ECG Lead II clean, resting BP 118/76 mmHg. Advised active hydration.'
        },
        {
          date: '2026-05-10',
          type: 'Initial Intake Electrocardiogram',
          doctor: 'Dr. Evelyn Vance, MD',
          summary: 'Baseline 12-lead equivalent recorded. No ischemic changes. P-QRS-T complexes within normal limits.'
        }
      ]
    },
    {
      id: 'pat-002',
      user_id: 'usr-pat-003',
      assigned_doctor_id: 'doc-001',
      full_name: 'Robert Chen',
      dob: '1964-11-04',
      gender: 'MALE',
      blood_group: 'O+',
      emergency_contact_name: 'Linda Chen (Spouse)',
      emergency_contact_phone: '+91-98765-00002',
      baseline_hr_mean: 64.0,
      baseline_hr_std: 5.2,
      baseline_spo2_mean: 97.8,
      status: 'STABLE',
      current_hr: 65,
      current_spo2: 98,
      attention_score: 22,
      last_active: '2 hrs ago',
      is_demo: false,
      conditions: [
        'Essential Hypertension (Stage 1, Controlled)',
        'Hyperlipidemia (Dietary management)',
        'Mild Sinus Bradycardia at rest'
      ],
      medications: [
        'Amlodipine 5mg (Once daily morning)',
        'Atorvastatin 10mg (Once daily bedtime)',
        'Aspirin 75mg'
      ],
      allergies: [
        'Sulfa Antibiotics (Severe skin rash)',
        'NSAIDs (Mild gastric discomfort)'
      ],
      history_timeline: [
        {
          date: '2026-09-10',
          type: 'Hypertension & Lipid Review',
          doctor: 'Dr. Evelyn Vance, MD',
          summary: 'Blood pressure 126/80 mmHg. Resting pulse 62 BPM. Lipid panel stable on statin therapy.'
        },
        {
          date: '2026-06-04',
          type: 'Cardiac Stress Assessment',
          doctor: 'Dr. Evelyn Vance, MD',
          summary: 'Exercise tolerance test completed with normal hemodynamic recovery. No ST elevation.'
        }
      ]
    }
  ],
  devices: [
    {
      id: 'dev-001',
      patient_id: 'pat-001',
      device_identifier: 'DX-ESP32-001',
      firmware_version: '1.0.4-prod',
      battery_level: 88,
      status: 'ONLINE',
      last_heartbeat: new Date().toISOString()
    }
  ],
  monitoring_sessions: [
    {
      id: 'sess-001',
      patient_id: 'pat-001',
      device_id: 'dev-001',
      status: 'MONITORING',
      started_at: new Date(Date.now() - 25 * 60 * 1000).toISOString(),
      duration_seconds: 1500,
      avg_hr: 75.4,
      min_hr: 68.0,
      max_hr: 84.0,
      avg_spo2: 98.1,
      min_spo2: 96.0,
      attention_score: 18
    },
    {
      id: 'sess-000',
      patient_id: 'pat-001',
      device_id: 'dev-001',
      status: 'COMPLETED',
      started_at: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
      ended_at: new Date(Date.now() - 23 * 3600 * 1000).toISOString(),
      duration_seconds: 3600,
      avg_hr: 72.8,
      min_hr: 64.0,
      max_hr: 88.0,
      avg_spo2: 98.5,
      min_spo2: 97.0,
      attention_score: 15
    }
  ],
  heart_rate_readings: [],
  spo2_readings: [],
  ecg_samples: [],
  ai_analyses: [
    {
      id: 'ai-001',
      session_id: 'sess-000',
      patient_id: 'pat-001',
      attention_score: 15,
      attention_level: 'LOW',
      signal_quality_score: 0.96,
      hr_trend: 'STABLE',
      spo2_trend: 'STABLE',
      baseline_deviation: 0.08,
      observed_patterns: ['Normal sinus cadence', 'Stable oxygenation', 'Good R-peak amplitude'],
      summary_text: 'Your readings were consistent with your established baseline during this session. Sinus cadence remained regular with minor normal physiological variation. No significant deviation detected.',
      disclaimer_text: config.DISCLAIMER,
      created_at: new Date(Date.now() - 23 * 3600 * 1000).toISOString()
    }
  ],
  alerts: [
    {
      id: 'alt-001',
      patient_id: 'pat-002',
      session_id: null,
      category: 'VITAL_TREND',
      severity: 'MEDIUM',
      title: 'Elevated Baseline Deviation',
      message: 'Resting heart rate averaged 84 BPM over the last 30 minutes, which is +1.8 standard deviations above patient baseline.',
      is_acknowledged: false,
      created_at: new Date(Date.now() - 45 * 60 * 1000).toISOString()
    },
    {
      id: 'alt-002',
      patient_id: 'pat-001',
      session_id: 'sess-001',
      category: 'SIGNAL_QUALITY',
      severity: 'INFO',
      title: 'Transient Electrode Movement',
      message: 'Brief high-frequency noise observed on AD8232 lead interface. Signal quality self-resolved to EXCELLENT.',
      is_acknowledged: true,
      acknowledged_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      created_at: new Date(Date.now() - 18 * 60 * 1000).toISOString()
    }
  ],
  doctor_notes: [
    {
      id: 'not-001',
      patient_id: 'pat-001',
      doctor_id: 'doc-001',
      session_id: 'sess-000',
      doctor_name: 'Dr. Evelyn Vance, MD',
      note_text: 'Reviewed 24-hr Holter-equivalent telemetry session. Waveform exhibits clean P-QRS-T complexes. Patient advised to continue daily 30-min walking regimen. Follow-up scheduled in 2 weeks.',
      created_at: new Date(Date.now() - 20 * 3600 * 1000).toISOString()
    }
  ],
  reports: [],
  audit_logs: []
};

// Seed baseline vitals history for pat-001 (last 24 hours)
const now = Date.now();
for (let i = 24; i >= 0; i--) {
  const ts = new Date(now - i * 3600 * 1000).toISOString();
  const hr = 70 + Math.floor(Math.sin(i / 3) * 8) + Math.floor(Math.random() * 4);
  const spo2 = 98 + Math.floor(Math.random() * 2);
  memDb.heart_rate_readings.push({
    id: `hr-${i}`,
    session_id: 'sess-000',
    patient_id: 'pat-001',
    value_bpm: hr,
    confidence: 0.98,
    signal_quality: 'GOOD',
    timestamp: ts
  });
  memDb.spo2_readings.push({
    id: `spo2-${i}`,
    session_id: 'sess-000',
    patient_id: 'pat-001',
    value_pct: spo2,
    confidence: 0.99,
    signal_quality: 'GOOD',
    timestamp: ts
  });
}

// Initializer
export async function initDatabase() {
  try {
    pool = mysql.createPool({
      host: config.DB.HOST,
      port: config.DB.PORT,
      user: config.DB.USER,
      password: config.DB.PASSWORD,
      database: config.DB.NAME,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0
    });

    const conn = await pool.getConnection();
    console.log('✅ Connected to MySQL database:', config.DB.NAME);
    conn.release();
    useMemoryFallback = false;
  } catch (err) {
    console.warn('⚠️  MySQL connection not available (' + err.message + ').');
    console.log('🚀 Running with built-in high-speed clinical Memory DB with full seed data!');
    useMemoryFallback = true;
  }
}

export function isMemoryDb() {
  return useMemoryFallback;
}

export function getDbPool() {
  return pool;
}
