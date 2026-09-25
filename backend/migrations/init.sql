-- CardioX AI Database Schema
-- Target: MySQL 8.0+ / MariaDB / Compatible SQL engines

CREATE DATABASE IF NOT EXISTS cardiox_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE cardiox_db;

-- 1. USERS TABLE
CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(36) PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(150) NOT NULL,
    role ENUM('PATIENT', 'DOCTOR', 'ADMIN') NOT NULL DEFAULT 'PATIENT',
    phone VARCHAR(30),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_users_email (email),
    INDEX idx_users_role (role)
) ENGINE=InnoDB;

-- 2. DOCTORS TABLE
CREATE TABLE IF NOT EXISTS doctors (
    id VARCHAR(36) PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL UNIQUE,
    specialization VARCHAR(100) DEFAULT 'Cardiology',
    license_number VARCHAR(100) NOT NULL UNIQUE,
    hospital_affiliation VARCHAR(150),
    mfa_enabled BOOLEAN DEFAULT FALSE,
    mfa_secret VARCHAR(100) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 3. PATIENTS TABLE
CREATE TABLE IF NOT EXISTS patients (
    id VARCHAR(36) PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL UNIQUE,
    assigned_doctor_id VARCHAR(36) NULL,
    dob DATE,
    gender ENUM('MALE', 'FEMALE', 'OTHER', 'UNDISCLOSED') DEFAULT 'UNDISCLOSED',
    blood_group VARCHAR(10),
    emergency_contact_name VARCHAR(100),
    emergency_contact_phone VARCHAR(30),
    baseline_hr_mean FLOAT DEFAULT 75.0,
    baseline_hr_std FLOAT DEFAULT 8.0,
    baseline_spo2_mean FLOAT DEFAULT 98.0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (assigned_doctor_id) REFERENCES doctors(id) ON DELETE SET NULL,
    INDEX idx_patients_doctor (assigned_doctor_id)
) ENGINE=InnoDB;

-- 4. DEVICES TABLE (ESP32 IoT Nodes)
CREATE TABLE IF NOT EXISTS devices (
    id VARCHAR(36) PRIMARY KEY,
    patient_id VARCHAR(36) NULL,
    device_identifier VARCHAR(64) NOT NULL UNIQUE, -- e.g. DX-001 or MAC
    device_token_hash VARCHAR(255) NOT NULL,
    firmware_version VARCHAR(32) DEFAULT '1.0.0',
    battery_level INT DEFAULT 100,
    status ENUM('ONLINE', 'OFFLINE', 'STREAMING', 'ERROR') DEFAULT 'OFFLINE',
    last_heartbeat TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE SET NULL,
    INDEX idx_devices_patient (patient_id)
) ENGINE=InnoDB;

-- 5. MONITORING SESSIONS TABLE
CREATE TABLE IF NOT EXISTS monitoring_sessions (
    id VARCHAR(36) PRIMARY KEY,
    patient_id VARCHAR(36) NOT NULL,
    device_id VARCHAR(36) NULL,
    status ENUM('NOT_STARTED', 'CONNECTING', 'MONITORING', 'PROCESSING', 'COMPLETED', 'INTERRUPTED') NOT NULL DEFAULT 'NOT_STARTED',
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    ended_at TIMESTAMP NULL,
    duration_seconds INT DEFAULT 0,
    avg_hr FLOAT NULL,
    min_hr FLOAT NULL,
    max_hr FLOAT NULL,
    avg_spo2 FLOAT NULL,
    min_spo2 FLOAT NULL,
    attention_score INT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE,
    FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE SET NULL,
    INDEX idx_sessions_patient (patient_id),
    INDEX idx_sessions_started_at (started_at)
) ENGINE=InnoDB;

-- 6. HEART RATE READINGS TABLE
CREATE TABLE IF NOT EXISTS heart_rate_readings (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    session_id VARCHAR(36) NOT NULL,
    patient_id VARCHAR(36) NOT NULL,
    value_bpm FLOAT NOT NULL,
    confidence FLOAT DEFAULT 1.0,
    signal_quality ENUM('EXCELLENT', 'GOOD', 'FAIR', 'POOR', 'LEADS_OFF') DEFAULT 'GOOD',
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES monitoring_sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE,
    INDEX idx_hr_session_ts (session_id, timestamp),
    INDEX idx_hr_patient_ts (patient_id, timestamp)
) ENGINE=InnoDB;

-- 7. SPO2 READINGS TABLE
CREATE TABLE IF NOT EXISTS spo2_readings (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    session_id VARCHAR(36) NOT NULL,
    patient_id VARCHAR(36) NOT NULL,
    value_pct FLOAT NOT NULL,
    confidence FLOAT DEFAULT 1.0,
    signal_quality ENUM('EXCELLENT', 'GOOD', 'FAIR', 'POOR', 'LEADS_OFF') DEFAULT 'GOOD',
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES monitoring_sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE,
    INDEX idx_spo2_session_ts (session_id, timestamp),
    INDEX idx_spo2_patient_ts (patient_id, timestamp)
) ENGINE=InnoDB;

-- 8. ECG SAMPLES TABLE (Raw or chunked arrays for waveform playback)
CREATE TABLE IF NOT EXISTS ecg_samples (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    session_id VARCHAR(36) NOT NULL,
    patient_id VARCHAR(36) NOT NULL,
    sample_rate INT DEFAULT 250, -- in Hz
    samples_count INT NOT NULL,
    samples_data JSON NOT NULL, -- Array of millivolt or ADC values: [512, 518, 525, ...]
    signal_quality ENUM('EXCELLENT', 'GOOD', 'FAIR', 'POOR', 'LEADS_OFF') DEFAULT 'GOOD',
    leads_off BOOLEAN DEFAULT FALSE,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES monitoring_sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE,
    INDEX idx_ecg_session_ts (session_id, timestamp)
) ENGINE=InnoDB;

-- 9. AI ANALYSES TABLE
CREATE TABLE IF NOT EXISTS ai_analyses (
    id VARCHAR(36) PRIMARY KEY,
    session_id VARCHAR(36) NOT NULL UNIQUE,
    patient_id VARCHAR(36) NOT NULL,
    attention_score INT NOT NULL, -- 0-100
    attention_level ENUM('LOW', 'MODERATE', 'HIGH', 'VERY_HIGH') NOT NULL,
    signal_quality_score FLOAT NOT NULL, -- 0.0 - 1.0
    hr_trend VARCHAR(50),
    spo2_trend VARCHAR(50),
    baseline_deviation FLOAT,
    observed_patterns JSON,
    summary_text TEXT NOT NULL,
    disclaimer_text VARCHAR(255) NOT NULL DEFAULT 'This is AI-assisted monitoring support and not a medical diagnosis.',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES monitoring_sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE,
    INDEX idx_ai_patient (patient_id)
) ENGINE=InnoDB;

-- 10. ALERTS TABLE
CREATE TABLE IF NOT EXISTS alerts (
    id VARCHAR(36) PRIMARY KEY,
    patient_id VARCHAR(36) NOT NULL,
    session_id VARCHAR(36) NULL,
    category ENUM('SIGNAL_QUALITY', 'VITAL_TREND', 'SYSTEM', 'AI_ATTENTION') NOT NULL,
    severity ENUM('INFO', 'LOW', 'MEDIUM', 'HIGH') NOT NULL,
    title VARCHAR(150) NOT NULL,
    message TEXT NOT NULL,
    is_acknowledged BOOLEAN DEFAULT FALSE,
    acknowledged_by VARCHAR(36) NULL,
    acknowledged_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE,
    FOREIGN KEY (session_id) REFERENCES monitoring_sessions(id) ON DELETE SET NULL,
    INDEX idx_alerts_patient (patient_id),
    INDEX idx_alerts_severity (severity),
    INDEX idx_alerts_ack (is_acknowledged)
) ENGINE=InnoDB;

-- 11. DOCTOR NOTES TABLE
CREATE TABLE IF NOT EXISTS doctor_notes (
    id VARCHAR(36) PRIMARY KEY,
    patient_id VARCHAR(36) NOT NULL,
    doctor_id VARCHAR(36) NOT NULL,
    session_id VARCHAR(36) NULL,
    note_text TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE,
    FOREIGN KEY (doctor_id) REFERENCES doctors(id) ON DELETE CASCADE,
    FOREIGN KEY (session_id) REFERENCES monitoring_sessions(id) ON DELETE SET NULL,
    INDEX idx_notes_patient (patient_id)
) ENGINE=InnoDB;

-- 12. REPORTS TABLE
CREATE TABLE IF NOT EXISTS reports (
    id VARCHAR(36) PRIMARY KEY,
    patient_id VARCHAR(36) NOT NULL,
    generated_by VARCHAR(36) NOT NULL,
    report_title VARCHAR(200) NOT NULL,
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    summary_data JSON NOT NULL,
    doctor_notes_snapshot TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE,
    FOREIGN KEY (generated_by) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_reports_patient (patient_id)
) ENGINE=InnoDB;

-- 13. AUDIT LOGS TABLE
CREATE TABLE IF NOT EXISTS audit_logs (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id VARCHAR(36) NULL,
    action VARCHAR(100) NOT NULL,
    resource_type VARCHAR(50) NOT NULL,
    resource_id VARCHAR(64) NULL,
    ip_address VARCHAR(45),
    user_agent VARCHAR(255),
    details JSON NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_audit_user (user_id),
    INDEX idx_audit_action (action),
    INDEX idx_audit_created (created_at)
) ENGINE=InnoDB;
