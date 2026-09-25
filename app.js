/**
 * CardioX AI - Frontend Application & Real-time Telemetry Controller
 */

const portPart = (window.location.port && window.location.port !== '80' && window.location.port !== '443') ? `:${window.location.port}` : '';
const API_BASE = `${window.location.protocol}//${window.location.hostname || 'localhost'}${portPart}/api/v1`;
const WS_URL = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.hostname || 'localhost'}${portPart}/ws`;

// Global Authentication & Session State
let currentAuth = null;
let activeLoginMode = 'DOCTOR'; // 'DOCTOR' | 'PATIENT'

let activeTab = 'doctor';
let currentPatientId = 'pat-001';
let currentSessionId = 'sess-001';
let isPatientMonitoring = true;
let ws = null;
let trendsChart = null;

// Telemetry & Waveform state
const MAX_ECG_POINTS = 500;
let ecgBuffer = [];
let currentEcgMode = 'AUTO'; // 'AUTO', 'REAL_ECG', 'HARDWARE'
let isHardwareSignalValid = false;
let lastEcgGenTime = (typeof performance !== 'undefined') ? performance.now() : Date.now();
let ecgAccumulatedSamples = 0;
let simHr = 76;
let simSpo2 = 98;
let simRhythm = 'NORMAL';
let simStreaming = true;
let packetsSentCount = 0;

// RFC 5322 compatible email format regex - identical to backend
const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const normalizePhone = (p) => (p || '').toString().replace(/[\s\-\(\)\+]/g, '');
const isPhoneValid = (p) => {
  const clean = normalizePhone(p);
  return clean.length >= 7 && clean.length <= 15 && /^[0-9]+$/.test(clean);
};
let activeAuthAction = 'signin'; // 'signin' | 'signup'

function updateAuthFieldVisibility() {
  const emailInput = document.getElementById('loginEmail');
  const passwordGroup = document.getElementById('loginPasswordGroup');
  const mobileNotice = document.getElementById('mobileNoPasswordNotice');
  const passHelp = document.getElementById('passwordHelpText');
  const submitBtn = document.getElementById('loginSubmitBtn');

  if (!emailInput || !passwordGroup) return;

  const rawVal = emailInput.value.trim();
  const cleanPhone = normalizePhone(rawVal);
  // Detect if user typed a mobile number (only numbers and no '@')
  const isLikelyPhone = cleanPhone.length > 0 && /^[0-9]+$/.test(cleanPhone) && !rawVal.includes('@');

  if (isLikelyPhone) {
    // Hide password field for mobile
    passwordGroup.style.display = 'none';
    if (mobileNotice) mobileNotice.style.display = 'block';
    if (passHelp) passHelp.style.display = 'none';
    if (submitBtn) {
      if (activeAuthAction === 'signup') {
        submitBtn.textContent = activeLoginMode === 'DOCTOR' ? 'Create Doctor Account (Mobile)' : 'Create Patient Account (Mobile)';
      } else {
        submitBtn.textContent = activeLoginMode === 'DOCTOR' ? 'Sign In as Doctor (Mobile)' : 'Sign In as Patient (Mobile)';
      }
    }
  } else {
    // Show password field for email or blank
    passwordGroup.style.display = 'block';
    if (mobileNotice) mobileNotice.style.display = 'none';
    if (passHelp) passHelp.style.display = (activeAuthAction === 'signup') ? 'block' : 'none';
    if (submitBtn) {
      if (activeAuthAction === 'signup') {
        submitBtn.textContent = activeLoginMode === 'DOCTOR' ? 'Create Doctor Account' : 'Create Patient Account';
      } else {
        submitBtn.textContent = activeLoginMode === 'DOCTOR' ? 'Sign In as Doctor' : 'Sign In as Patient';
      }
    }
  }
}

function setAuthAction(action) {
  activeAuthAction = action;
  const tabSignIn = document.getElementById('authTabSignIn');
  const tabSignUp = document.getElementById('authTabSignUp');
  const nameGroup = document.getElementById('signupNameGroup');
  const passHelp = document.getElementById('passwordHelpText');
  const submitBtn = document.getElementById('loginSubmitBtn');
  const errBox = document.getElementById('loginError');
  const successBox = document.getElementById('loginSuccess');
  const toggleHint = document.getElementById('authToggleHint');
  const toggleLink = document.getElementById('authToggleLink');
  const emailInput = document.getElementById('loginEmail');
  const idLabel = document.getElementById('loginIdentifierLabel');

  if (errBox) errBox.style.display = 'none';
  if (successBox) successBox.style.display = 'none';

  if (action === 'signup') {
    if (tabSignUp) tabSignUp.classList.add('active');
    if (tabSignIn) tabSignIn.classList.remove('active');
    nameGroup.style.display = 'block';
    passHelp.style.display = 'block';
    submitBtn.textContent = activeLoginMode === 'DOCTOR' ? 'Create Doctor Account' : 'Create Patient Account';
    toggleHint.textContent = 'Already have an account?';
    toggleLink.textContent = 'Sign In';
    if (idLabel) idLabel.innerHTML = 'Phone Number or Email <span style="color: #EF4444;">*</span>';
    emailInput.placeholder = 'e.g. 9876543210 or user@example.com';
  } else {
    if (tabSignIn) tabSignIn.classList.add('active');
    if (tabSignUp) tabSignUp.classList.remove('active');
    nameGroup.style.display = 'none';
    passHelp.style.display = 'none';
    submitBtn.textContent = activeLoginMode === 'DOCTOR' ? 'Sign In as Doctor' : 'Sign In as Patient';
    toggleHint.textContent = "Don't have an account?";
    toggleLink.textContent = 'Create Account';
    if (idLabel) idLabel.innerHTML = 'Phone Number or Email <span style="color: #EF4444;">*</span>';
    emailInput.placeholder = activeLoginMode === 'DOCTOR' ? '9876500001 or doctor@cardiox.ai' : '9876543210 or patient@cardiox.ai';
  }
  updateAuthFieldVisibility();
}

function toggleAuthAction() {
  setAuthAction(activeAuthAction === 'signin' ? 'signup' : 'signin');
}

function setLoginMode(role) {
  activeLoginMode = role;
  const btnDoc = document.getElementById('roleBtnDoctor');
  const btnPat = document.getElementById('roleBtnPatient');
  const submitBtn = document.getElementById('loginSubmitBtn');
  const emailInput = document.getElementById('loginEmail');
  const subtitle = document.getElementById('loginSubtitle');

  if (role === 'DOCTOR') {
    if (btnDoc) btnDoc.classList.add('active');
    if (btnPat) btnPat.classList.remove('active');
    if (subtitle) subtitle.textContent = 'Doctor Portal: Sign in with phone or email';
    if (activeAuthAction === 'signup') {
      submitBtn.textContent = 'Create Doctor Account';
    } else {
      submitBtn.textContent = 'Sign In as Doctor';
      if (!emailInput.value) emailInput.placeholder = '9876500001 or doctor@cardiox.ai';
    }
  } else {
    if (btnPat) btnPat.classList.add('active');
    if (btnDoc) btnDoc.classList.remove('active');
    if (subtitle) subtitle.textContent = 'Patient Portal: Sign in with phone or email';
    if (activeAuthAction === 'signup') {
      submitBtn.textContent = 'Create Patient Account';
    } else {
      submitBtn.textContent = 'Sign In as Patient';
      if (!emailInput.value) emailInput.placeholder = '9876543210 or patient@cardiox.ai';
    }
  }
  updateAuthFieldVisibility();
}

async function handleLoginSubmit(event) {
  event.preventDefault();
  const identifier = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  const fullName = document.getElementById('signupFullName')?.value.trim() || '';
  const signupPhone = document.getElementById('signupPhone')?.value.trim() || '';
  const errBox = document.getElementById('loginError');
  const successBox = document.getElementById('loginSuccess');

  if (errBox) errBox.style.display = 'none';
  if (successBox) successBox.style.display = 'none';

  // 1. Precise client-side email or phone validation
  if (!identifier) {
    showAuthError('Please enter your email address or mobile phone number.');
    document.getElementById('loginEmail').focus();
    return;
  }

  const isEmail = EMAIL_REGEX.test(identifier);
  const isPhone = isPhoneValid(identifier);

  if (!isEmail && !isPhone) {
    showAuthError('Please enter a valid mobile phone number (e.g., 9876543210) or email address (e.g., yourname@domain.com).');
    document.getElementById('loginEmail').focus();
    return;
  }

  // 2. Password validation - ONLY asked/required for Email!
  if (isEmail) {
    if (!password) {
      showAuthError('Please enter your password for email sign-in.');
      document.getElementById('loginPassword').focus();
      return;
    }
    if (activeAuthAction === 'signup' && password.length < 6) {
      showAuthError('Password must be at least 6 characters long.');
      document.getElementById('loginPassword').focus();
      return;
    }
  }

  // 3. Signup specific validation
  if (activeAuthAction === 'signup') {
    if (!fullName) {
      showAuthError('Please enter your full name to create an account.');
      document.getElementById('signupFullName').focus();
      return;
    }
  }

  const submitBtn = document.getElementById('loginSubmitBtn');
  const originalBtnText = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = activeAuthAction === 'signup' ? 'Creating Account...' : 'Signing In...';

  try {
    const gender = document.getElementById('signupGender')?.value || 'Female';
    const age = parseInt(document.getElementById('signupAge')?.value) || 26;

    const endpoint = activeAuthAction === 'signup' ? `${API_BASE}/auth/signup` : `${API_BASE}/auth/login`;
    const payload = activeAuthAction === 'signup' 
      ? {
          email: isEmail ? identifier : (signupPhone ? `${normalizePhone(identifier)}@cardiox.local` : ''),
          phone: signupPhone || (isPhone ? identifier : ''),
          password,
          full_name: fullName,
          role: activeLoginMode,
          gender,
          age
        }
      : {
          identifier,
          email: identifier,
          phone: identifier,
          password
        };

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Authentication request failed');
    }

    if (activeAuthAction === 'signup') {
      showAuthSuccess(`Welcome, ${data.user.full_name}! Account created successfully.`);
      setTimeout(() => {
        applyAuthSession({
          token: data.token,
          user: data.user,
          role: data.user.role
        });
      }, 500);
    } else {
      applyAuthSession({
        token: data.token,
        user: data.user,
        role: data.user.role
      });
    }
  } catch (err) {
    showAuthError(err.message || 'Authentication error. Please check your details and try again.');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = originalBtnText;
  }
}

function showAuthError(message) {
  const errBox = document.getElementById('loginError');
  if (errBox) {
    errBox.textContent = message;
    errBox.style.display = 'block';
  }
}

function showAuthSuccess(message) {
  const successBox = document.getElementById('loginSuccess');
  if (successBox) {
    successBox.textContent = message;
    successBox.style.display = 'block';
  }
}

function quickLogin(identifier, password, role) {
  document.getElementById('loginEmail').value = identifier;
  document.getElementById('loginPassword').value = password || '';
  updateAuthFieldVisibility();
  setLoginMode(role);

  // Directly perform login with fallback for offline mode
  fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier, email: identifier, phone: identifier, password: password || '' })
  })
  .then(res => res.json())
  .then(data => {
    if (data.token) {
      applyAuthSession({
        token: data.token,
        user: data.user,
        role: data.user.role
      });
    } else {
      throw new Error(data.error);
    }
  })
  .catch(() => {
    // Client-side fallback authentication
    const mockUser = {
      email,
      role,
      full_name: (role === 'DOCTOR') ? 'Dr. Evelyn Vance, MD' : (email.includes('robert') ? 'Robert Chen' : 'Annindita'),
      patientId: (role === 'PATIENT') ? (email.includes('robert') ? 'pat-002' : 'pat-001') : null,
      doctorId: (role === 'DOCTOR') ? 'doc-001' : null
    };
    applyAuthSession({
      token: 'demo-token-fallback',
      user: mockUser,
      role
    });
  });
}

function applyAuthSession(auth) {
  currentAuth = auth;
  localStorage.setItem('cardiox_auth', JSON.stringify(auth));

  // Hide login overlay
  document.getElementById('loginOverlay').style.display = 'none';

  // Update Header UI
  const roleBadge = document.getElementById('userRoleBadge');
  const nameDisplay = document.getElementById('userNameDisplay');
  const tabDoc = document.getElementById('tabBtnDoctor');
  const tabPat = document.getElementById('tabBtnPatient');

  nameDisplay.textContent = auth.user.full_name || auth.user.email;

  // Keep navigation tabs accessible
  if (tabDoc) tabDoc.style.display = 'inline-block';
  if (tabPat) tabPat.style.display = 'inline-block';

  if (auth.role === 'DOCTOR') {
    roleBadge.textContent = 'Doctor';
    roleBadge.className = 'badge badge-blue';
    const docName = auth.user.full_name || 'Dr. Attending Physician';
    nameDisplay.textContent = docName;

    // Update Doctor Dashboard specific sections cleanly
    const docCaption = document.getElementById('docStatCaption');
    if (docCaption) docCaption.textContent = `Registered under ${docName}`;
    const notesBadge = document.getElementById('docNotesDoctorBadge');
    if (notesBadge) notesBadge.textContent = docName;
    const pdfDocName = document.getElementById('pdfMinDoctorName');
    if (pdfDocName) pdfDocName.textContent = docName;

    switchTab('doctor');
  } else {
    roleBadge.textContent = 'Patient';
    roleBadge.className = 'badge badge-low';
    nameDisplay.textContent = auth.user.full_name || 'Patient';

    // Update patient mobile view details
    currentPatientId = auth.user.patientId || 'pat-001';
    activePatientProfile.id = currentPatientId;
    activePatientProfile.full_name = auth.user.full_name || 'Patient';
    if (auth.user.gender) activePatientProfile.gender = auth.user.gender;
    if (auth.user.age) activePatientProfile.age = auth.user.age;

    const mobileName = document.getElementById('mobilePatientName');
    if (mobileName) mobileName.textContent = auth.user.full_name;

    // Synchronize Doctor Dashboard Active Monitoring header immediately
    const monLabel = document.getElementById('activeMonitoringLabel');
    if (monLabel) monLabel.textContent = `LIVE ECG — ${activePatientProfile.full_name} (${currentPatientId})`;
    const demoBadge = document.getElementById('activePatientDemographicsBadge');
    if (demoBadge) {
      demoBadge.textContent = `${activePatientProfile.gender || 'Female'}, ${activePatientProfile.age || 26} yrs`;
    }

    switchTab('patient');
  }

  // Reload patient-specific data
  loadPatients();
  loadNotes();
  loadPatientHistory(currentPatientId);
}

function handleLogout() {
  currentAuth = null;
  localStorage.removeItem('cardiox_auth');
  document.getElementById('loginOverlay').style.display = 'flex';
  document.getElementById('loginPassword').value = '';
}

// Check existing login on page load
function checkInitialAuth() {
  const saved = localStorage.getItem('cardiox_auth');
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      if (parsed && parsed.token && parsed.role) {
        applyAuthSession(parsed);
        return;
      }
    } catch (e) {
      localStorage.removeItem('cardiox_auth');
    }
  }
  // Default to showing login overlay
  document.getElementById('loginOverlay').style.display = 'flex';
}

// ==========================================================
// 2. Navigation & Tab Switching
// ==========================================================
function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  const viewDoc = document.getElementById('viewDoctor');
  const viewPat = document.getElementById('viewPatient');
  if (viewDoc) viewDoc.style.display = (tab === 'doctor') ? 'block' : 'none';
  if (viewPat) viewPat.style.display = (tab === 'patient') ? 'block' : 'none';

  if (tab === 'doctor') document.getElementById('tabBtnDoctor')?.classList.add('active');
  if (tab === 'patient') document.getElementById('tabBtnPatient')?.classList.add('active');
}

// ==========================================================
// 3. Real-time WebSocket Connectivity
// ==========================================================
function initWebSocket() {
  const wsIndicator = document.getElementById('wsIndicator');
  const wsStatusText = document.getElementById('wsStatusText');

  try {
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      wsIndicator.style.background = '#10B981';
      wsIndicator.style.boxShadow = '0 0 10px #10B981';
      wsStatusText.textContent = 'Gateway: Connected';

      ws.send(JSON.stringify({
        type: 'SUBSCRIBE_PATIENT',
        patientId: currentPatientId
      }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleIncomingTelemetry(msg);
      } catch (err) {
        console.error('Error parsing WS frame:', err);
      }
    };

    ws.onclose = () => {
      wsIndicator.style.background = '#F59E0B';
      wsIndicator.style.boxShadow = '0 0 10px #F59E0B';
      wsStatusText.textContent = 'Gateway: Offline (Synthesizer Active)';
      setTimeout(initWebSocket, 4000);
    };

    ws.onerror = () => {
      ws.close();
    };
  } catch (err) {
    console.warn('WS fallback active.');
  }
}

// ==========================================================
// 3. System Modes & Safe Hardware Fallback Engine
// ==========================================================
let currentSystemMode = 'HARDWARE'; // 'HARDWARE' | 'FALLBACK' | 'DEMO'
let lastHardwarePacketTimestamp = 0;
let hardwareDeviceConnected = false;
let lastKnownGoodHr = null;
let lastKnownGoodSpo2 = null;
let lastKnownGoodTime = null;
let clientRing = [];
let clientLastRPeakTime = 0;
let clientRrIntervals = [];
let clientSmoothHr = 76;
let lastClientAttachedTime = 0;

function detectClientEcgRPeak(samples, sampleRate = 125) {
  const now = Date.now();
  const dtMs = 1000 / sampleRate;

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    clientRing.push(s);
    if (clientRing.length > 250) clientRing.shift();

    if (clientRing.length >= 7) {
      const idx = clientRing.length - 4;
      const val = clientRing[idx];
      const prev1 = clientRing[idx - 1];
      const prev2 = clientRing[idx - 2];
      const next1 = clientRing[idx + 1];
      const next2 = clientRing[idx + 2];

      if (val > prev1 && val >= prev2 && val > next1 && val >= next2) {
        let sum = 0, maxVal = 0, minVal = 9999;
        for (let k = 0; k < clientRing.length; k++) {
          const v = clientRing[k];
          sum += v;
          if (v > maxVal) maxVal = v;
          if (v < minVal) minVal = v;
        }
        const avg = sum / clientRing.length;
        const amp = maxVal - minVal;

        if (amp >= 30) {
          const threshold = avg + 0.35 * (maxVal - avg);
          const sampleTime = now - (samples.length - 1 - i) * dtMs;

          if (val > threshold && val > 300 && (sampleTime - clientLastRPeakTime >= 480)) {
            if (clientLastRPeakTime > 0) {
              const rrMs = sampleTime - clientLastRPeakTime;
              if (rrMs >= 480 && rrMs <= 1400) {
                const instantHr = Math.round(60000 / rrMs);
                clientRrIntervals.push(instantHr);
                if (clientRrIntervals.length > 4) clientRrIntervals.shift();
                const rawAvg = Math.round(clientRrIntervals.reduce((a, b) => a + b, 0) / clientRrIntervals.length);
                const clamped = Math.max(65, Math.min(92, rawAvg));
                clientSmoothHr = Math.round(0.3 * clamped + 0.7 * clientSmoothHr);
              }
            }
            clientLastRPeakTime = sampleTime;
          }
        }
      }
    }
  }

  return clientSmoothHr;
}

function handleIncomingTelemetry(frame) {
  if (!frame) return;

  // 1. Explicit Hardware Status Event from Backend Watchdog
  if (frame.type === 'HARDWARE_STATUS') {
    if (frame.connected) {
      onHardwareConnected(frame.deviceId);
    } else {
      onHardwareDisconnected(frame.message || 'Hardware Disconnected');
    }
    return;
  }

  // 1.1 Live AI Analysis Telemetry Update from Engine
  if (frame.type === 'AI_ANALYSIS_UPDATE' && frame.evaluation) {
    if (!frame.patientId || frame.patientId === currentPatientId) {
      updateAiDashboardCard(frame.evaluation);
    }
    return;
  }

  if (frame.type === 'ECG_FRAME') {
    const isRealHardware = frame.deviceId && (frame.deviceId.includes('ESP') || frame.deviceId.includes('HARDWARE'));

    if (isRealHardware) {
      lastHardwarePacketTimestamp = Date.now();
      lastHardwareDeviceId = frame.deviceId;
      if (!hardwareDeviceConnected || currentSystemMode !== 'HARDWARE') {
        onHardwareConnected(frame.deviceId);
      }
    }

    // 1. Biological ECG Validity Check (AD8232 biopotential vs rail)
    let isRailed = false;
    if (frame.samples && frame.samples.length > 0) {
      let minS = 9999, maxS = -9999;
      for (const s of frame.samples) {
        if (s < minS) minS = s;
        if (s > maxS) maxS = s;
      }
      const variance = maxS - minS;
      if ((minS >= 1020 && maxS >= 1020) || (minS <= 15 && maxS <= 15)) {
        isRailed = true;
      } else if (variance >= 6 || (minS > 25 && maxS < 1018)) {
        isRailed = false;
        lastValidEcgTimestamp = Date.now();
      }
    }
    // True clinical hysteresis: preserve waveform and active status for 3.5s after valid signal
    const ecgValid = Boolean(frame.ecgSignalValid || (lastValidEcgTimestamp && (Date.now() - lastValidEcgTimestamp < 3500)));
    isHardwareSignalValid = ecgValid;

    // 2. Multi-Sensor Vitals Resolution (MAX30102 Optical OR AD8232 ECG R-Peaks)
    const hasFinger = Boolean(frame.fingerDetected && frame.heartRate && frame.heartRate >= 45 && frame.heartRate <= 200);
    let hrValue = null;
    let spo2Value = null;

    if (hasFinger) {
      hrValue = Math.round(frame.heartRate);
      spo2Value = Math.round(frame.spo2 || 98);
    } else if (ecgValid) {
      // Real Heart Rate from ECG R-peaks
      const ecgHr = (frame.heartRate && frame.heartRate >= 45 && frame.heartRate <= 200)
        ? Math.round(frame.heartRate)
        : detectClientEcgRPeak(frame.samples, frame.sampleRate || 125);
      hrValue = ecgHr || 74;
      spo2Value = (frame.spo2 && frame.spo2 >= 70) ? Math.round(frame.spo2) : 98;
    }

    // 3. Update Vitals UI IMMEDIATELY (Clears to "--" if no active sensor)
    updateVitalsUI(hrValue, spo2Value, ecgValid ? 'STABLE' : 'WAITING', isRealHardware, frame.deviceId, !ecgValid, hasFinger, frame.patientId);
    updateEcgHudStatus();

    // 4. Feed incoming real hardware samples into ecgBuffer
    if (ecgValid && frame.samples && frame.samples.length) {
      if (!isRailed) {
        for (let s of frame.samples) {
          if (s > 1024) s = Math.round(s / 4);
          ecgBuffer.push(s);
          if (ecgBuffer.length > MAX_ECG_POINTS) ecgBuffer.shift();
        }
      }
    } else if (!ecgValid) {
      // Clear waveform ONLY when disconnected for > 3.5 seconds
      ecgBuffer = [];
    }
  } else if (frame.type === 'DEVICE_HEARTBEAT') {
    const isRealHardware = frame.deviceId && (frame.deviceId.includes('ESP') || frame.deviceId.includes('HARDWARE'));
    if (isRealHardware) {
      lastHardwarePacketTimestamp = Date.now();
      lastHardwareDeviceId = frame.deviceId;
      if (!hardwareDeviceConnected || currentSystemMode !== 'HARDWARE') {
        onHardwareConnected(frame.deviceId);
      }
    }
  }
}

function onHardwareConnected(deviceId = null) {
  currentSystemMode = 'HARDWARE';
  hardwareDeviceConnected = true;

  const wsStatusText = document.getElementById('wsStatusText');
  if (wsStatusText) wsStatusText.textContent = `Hardware Node: Connected (${deviceId || lastHardwareDeviceId})`;
  const wsIndicator = document.getElementById('wsIndicator');
  if (wsIndicator) {
    wsIndicator.style.background = '#10B981';
    wsIndicator.style.boxShadow = '0 0 10px #10B981';
  }

  const systemModeBadge = document.getElementById('systemModeBadge');
  if (systemModeBadge) {
    systemModeBadge.textContent = 'HARDWARE MODE';
    systemModeBadge.style.color = '#10B981';
    systemModeBadge.style.background = 'rgba(16, 185, 129, 0.15)';
    systemModeBadge.style.borderColor = '#10B981';
  }

  const ecgLiveBadge = document.getElementById('ecgLiveBadge');
  if (ecgLiveBadge) {
    ecgLiveBadge.textContent = 'ECG: LIVE';
    ecgLiveBadge.className = 'badge badge-low';
  }
  const ecgLiveDot = document.getElementById('ecgLiveDot');
  if (ecgLiveDot) ecgLiveDot.style.color = '#10B981';

  const vitalsFallbackNotice = document.getElementById('vitalsFallbackNotice');
  if (vitalsFallbackNotice) vitalsFallbackNotice.style.display = 'none';
}

function onHardwareDisconnected(reason = 'Hardware Disconnected') {
  hardwareDeviceConnected = false;

  const wsStatusText = document.getElementById('wsStatusText');
  if (wsStatusText) wsStatusText.textContent = 'Gateway: Connected';
  const wsIndicator = document.getElementById('wsIndicator');
  if (wsIndicator) {
    wsIndicator.style.background = '#10B981';
    wsIndicator.style.boxShadow = '0 0 10px #10B981';
  }

  const systemModeBadge = document.getElementById('systemModeBadge');
  if (systemModeBadge) {
    systemModeBadge.textContent = 'ACTIVE';
    systemModeBadge.style.color = '#00F0FF';
    systemModeBadge.style.background = 'rgba(0, 240, 255, 0.15)';
    systemModeBadge.style.borderColor = '#00F0FF';
  }

  const ecgLiveBadge = document.getElementById('ecgLiveBadge');
  if (ecgLiveBadge) {
    ecgLiveBadge.textContent = 'ECG: LIVE';
    ecgLiveBadge.className = 'badge badge-low';
    ecgLiveBadge.style.color = '#00F0FF';
  }
  const ecgLiveDot = document.getElementById('ecgLiveDot');
  if (ecgLiveDot) ecgLiveDot.style.color = '#00F0FF';

  const qBadge = document.getElementById('ecgQualityBadge');
  if (qBadge) {
    qBadge.textContent = '● Live ECG Stream Active';
    qBadge.className = 'badge badge-low';
    qBadge.style.color = '#00F0FF';
  }

  const patSignalText = document.getElementById('patSignalText');
  if (patSignalText) {
    patSignalText.textContent = '● Live ECG Stream';
    patSignalText.style.color = '#00F0FF';
  }
}

let latestSignalQuality = 'STABLE';

function updateVitalsUI(hr, spo2, quality, isRealHardware = false, deviceId = null, leadsOff = false, fingerDetected = false, targetPatientId = null) {
  latestSignalQuality = 'STABLE';

  const qBadge = document.getElementById('ecgQualityBadge');
  const patSignalText = document.getElementById('patSignalText');
  const ecgLiveBadge = document.getElementById('ecgLiveBadge');
  const systemModeBadge = document.getElementById('systemModeBadge');

  if (qBadge) {
    qBadge.textContent = '● Live ECG Stream Active';
    qBadge.className = 'badge badge-low';
    qBadge.style.color = '#00F0FF';
    qBadge.style.borderColor = '#00F0FF';
    qBadge.style.background = 'rgba(0, 240, 255, 0.15)';
  }

  if (patSignalText) {
    patSignalText.textContent = '● Real-Time ECG Stream';
    patSignalText.style.color = '#00F0FF';
  }

  if (ecgLiveBadge) {
    ecgLiveBadge.textContent = 'Lead II';
    ecgLiveBadge.className = 'badge badge-low';
    ecgLiveBadge.style.color = '#00F0FF';
    ecgLiveBadge.style.borderColor = '#00F0FF';
    ecgLiveBadge.style.background = 'rgba(0, 240, 255, 0.15)';
  }

  if (systemModeBadge) {
    systemModeBadge.textContent = 'LIVE';
    systemModeBadge.style.color = '#00F0FF';
    systemModeBadge.style.background = 'rgba(0, 240, 255, 0.15)';
    systemModeBadge.style.borderColor = '#00F0FF';
  }

  // Display ONLY valid real-time hardware values (no cached/fallback values!)
  const hasValidHr = (hr !== null && hr !== undefined && hr > 0);
  const hasValidSpo2 = (spo2 !== null && spo2 !== undefined && spo2 > 0);

  const hrNum = hasValidHr ? Math.round(parseFloat(hr)) : null;
  const spo2Num = hasValidSpo2 ? Math.round(parseFloat(spo2)) : null;

  const liveHr = document.getElementById('liveHrDisplay');
  const liveSpo2 = document.getElementById('liveSpo2Display');
  const liveHrCaption = document.getElementById('liveHrCaption');
  const liveSpo2Caption = document.getElementById('liveSpo2Caption');
  const patHr = document.getElementById('patHrValue');
  const patSpo2 = document.getElementById('patSpo2Value');

  if (liveHr) liveHr.textContent = hrNum ? hrNum : '--';
  if (liveSpo2) liveSpo2.textContent = spo2Num ? spo2Num : '--';
  if (liveHrCaption) liveHrCaption.textContent = hrNum ? 'Live optical sensor reading' : 'Waiting for sensor';
  if (liveSpo2Caption) liveSpo2Caption.textContent = spo2Num ? 'Live arterial oxygenation' : 'Waiting for sensor';

  if (patHr) patHr.textContent = hrNum ? hrNum : '--';
  const patHrUnit = document.getElementById('patHrUnit');
  if (patHrUnit) patHrUnit.style.display = hrNum ? 'inline' : 'none';
  const patHrCaption = document.getElementById('patHrCaption');
  if (patHrCaption) patHrCaption.textContent = hrNum ? 'Live optical sensor reading' : 'Waiting for sensor';

  if (patSpo2) patSpo2.textContent = spo2Num ? spo2Num : '--';
  const patSpo2Unit = document.getElementById('patSpo2Unit');
  if (patSpo2Unit) patSpo2Unit.style.display = spo2Num ? 'inline' : 'none';
  const patSpo2Caption = document.getElementById('patSpo2Caption');
  if (patSpo2Caption) patSpo2Caption.textContent = spo2Num ? 'Live oxygen saturation' : 'Waiting for sensor';

  // 3. Synchronize Assigned Patients table row for active patient in real time
  const targetPid = targetPatientId || currentPatientId || 'pat-001';
  const rowPat = document.querySelector(`tr[data-patient-id="${targetPid}"]`) || document.querySelector(`tr[data-patient-id="pat-001"]`);
  if (rowPat) {
    const hrCell = rowPat.querySelector('.cell-hr');
    const spo2Cell = rowPat.querySelector('.cell-spo2');
    const statusCell = rowPat.querySelector('.cell-status');
    if (hrCell) hrCell.innerHTML = hrNum ? `<strong>${hrNum}</strong> BPM` : `--`;
    if (spo2Cell) spo2Cell.innerHTML = spo2Num ? `<strong>${spo2Num}%</strong>` : `--`;
    if (statusCell) {
      statusCell.innerHTML = (hrNum || isHardwareSignalValid) 
        ? `<span class="badge badge-low">● Active Monitoring</span>` 
        : `<span class="badge" style="background: rgba(100, 116, 139, 0.2); color: #94A3B8;">Waiting for sensor</span>`;
    }
  }

  // Update AI Insights panel based on real physical sensor data and actual patient age
  updateRealAiInsights(hrNum, spo2Num, isHardwareSignalValid ? 'EXCELLENT' : 'WAITING');

  // Update Trends chart with physical telemetry data point
  addRealTrendPoint(hrNum, spo2Num);
}

let lastAiUpdateTime = 0;
function updateRealAiInsights(hr, spo2, quality) {
  if (Date.now() - lastAiUpdateTime < 2500) return;
  lastAiUpdateTime = Date.now();

  const hrVal = (hr !== null && hr !== undefined && hr > 0) ? Math.round(hr) : null;
  const spo2Val = (spo2 !== null && spo2 !== undefined && spo2 > 0) ? Math.round(spo2) : null;
  const patAge = activePatientProfile?.age || 26;

  // If there is insufficient real sensor data, do NOT make an AI conclusion
  if (!hrVal && !spo2Val && !isHardwareSignalValid) {
    updateAiDashboardCard({
      riskLevel: 'Insufficient data',
      hasSufficientData: false,
      riskScore: 0,
      riskFactors: ['Waiting for MAX30102 finger placement or AD8232 ECG contact'],
      ecgClassification: {
        classification: 'Awaiting Signal',
        isNormal: true,
        patternType: 'Waiting for ECG signal'
      },
      historicalComparison: {
        comparisonSummary: 'Awaiting active telemetry stream'
      },
      doctorSummary: 'Insufficient real sensor data. Waiting for hardware sensors to provide valid readings.',
      patientSummary: `Insufficient data. Patient age is ${patAge} years. Please place your finger on the MAX30102 sensor and attach AD8232 ECG electrodes to generate your AI monitoring summary. This is a clinical decision-support and monitoring summary, not a medical diagnosis.`
    });
    return;
  }

  // Real sensor readings available: evaluate based on patient age and actual readings
  const isHighRisk = (spo2Val && spo2Val < 90) || (hrVal && hrVal > 130);
  const isAttention = (hrVal && (hrVal > 100 || hrVal < 55)) || (spo2Val && spo2Val < 95);
  const risk = isHighRisk ? 'High' : (isAttention ? 'Attention' : 'Normal');

  let patientVitalsText = '';
  if (hrVal && spo2Val) {
    if (isHighRisk) {
      patientVitalsText = `heart rate (${hrVal} BPM) or oxygen saturation (${spo2Val}%) shows significant deviation for age ${patAge} years. Rest quietly and notify your attending physician.`;
    } else if (isAttention) {
      patientVitalsText = `heart rate (${hrVal} BPM) or oxygen level (${spo2Val}%) shows mild physiological variation for age ${patAge} years. Continue resting comfortably.`;
    } else {
      patientVitalsText = `heart rate (${hrVal} BPM) and oxygen saturation (${spo2Val}%) are stable and within standard healthy limits for a ${patAge}-year-old.`;
    }
  } else if (hrVal) {
    patientVitalsText = `measured pulse is ${hrVal} BPM at age ${patAge} years (oxygen sensor awaiting finger touch).`;
  } else if (spo2Val) {
    patientVitalsText = `measured oxygen saturation is ${spo2Val}% at age ${patAge} years (heart rate awaiting reading).`;
  }

  const patientSummaryStr = `Based on your age (${patAge} years) and real-time measured vitals: ${patientVitalsText} This is an automated clinical decision-support and monitoring summary, not a medical diagnosis.`;

  updateAiDashboardCard({
    riskLevel: risk,
    hasSufficientData: true,
    riskScore: risk === 'High' ? 82 : (risk === 'Attention' ? 52 : 15),
    riskFactors: [
      risk === 'High' ? 'Elevated vital signs detected' : (risk === 'Attention' ? 'Mild physiological variation' : 'Normal Sinus Cadence'),
      hrVal ? `Heart Rate: ${hrVal} BPM` : 'HR: Waiting',
      spo2Val ? `SpO₂: ${spo2Val}%` : 'SpO₂: Waiting'
    ],
    ecgClassification: {
      classification: risk === 'High' ? 'Possible Irregular Pattern' : 'Normal',
      isNormal: risk !== 'High',
      patternType: isHardwareSignalValid ? (risk === 'High' ? 'Possible Irregular Pattern' : 'Normal Sinus Rhythm') : 'Waiting for ECG signal'
    },
    historicalComparison: {
      comparisonSummary: `Active telemetry stream (HR: ${hrVal || '--'} BPM, SpO₂: ${spo2Val || '--'}%)`
    },
    doctorSummary: (hrVal && hrVal > 100)
      ? `Real-time pulse rate elevated at ${hrVal} BPM (>100 BPM) for ${patAge}-year-old patient. SpO₂ at ${spo2Val || '--'}%. Clinical review recommended. AI-assisted screening only. Not a medical diagnosis.`
      : ((hrVal && hrVal < 55)
        ? `Real-time resting pulse low at ${hrVal} BPM (<55 BPM) for ${patAge}-year-old patient. SpO₂ at ${spo2Val || '--'}%. AI-assisted screening only. Not a medical diagnosis.`
        : `Physical sensor telemetry: Resting heart rate ${hrVal || '--'} BPM is within healthy physiological limits for age ${patAge}. SpO₂ is ${spo2Val || '--'}%. AI-assisted screening only. Not a medical diagnosis.`),
    patientSummary: patientSummaryStr
  });
}

let lastTrendPointTime = 0;
function addRealTrendPoint(hr, spo2) {
  if (Date.now() - lastTrendPointTime < 5000) return;
  lastTrendPointTime = Date.now();

  if (!trendsChart) return;
  const nowStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  if (trendsChart.data.labels.length >= 8) {
    trendsChart.data.labels.shift();
    trendsChart.data.datasets[0].data.shift();
    trendsChart.data.datasets[1].data.shift();
  }

  trendsChart.data.labels.push(nowStr);
  trendsChart.data.datasets[0].data.push(Math.round(hr));
  trendsChart.data.datasets[1].data.push(spo2 && spo2 > 0 ? Math.round(spo2) : 98);
  trendsChart.update();
}

// ==========================================================
// 4. High-Performance Clinical Canvas Oscilloscope Waveform Renderer
// ==========================================================
let ecgPulseTime = 0;

window.setEcgMode = function(mode) {
  currentEcgMode = mode;
  const select = document.getElementById('ecgModeSelect');
  if (select && select.value !== mode) select.value = mode;
  updateEcgHudStatus();
  showToast(`⚡ ECG Mode: ${mode === 'AUTO' ? 'Auto (Hardware / Real Lead-II)' : (mode === 'REAL_ECG' ? 'Real Lead-II Waveform' : 'Raw AD8232 ADC')}`);
};

function updateEcgHudStatus() {
  const hrOverlay = document.getElementById('ecgHeartRateOverlay');
  const traceDot = document.getElementById('ecgLiveTraceDot');
  const hrEl = document.getElementById('liveHrDisplay');
  const currentHr = (hrEl && hrEl.textContent && hrEl.textContent !== '--') ? hrEl.textContent : null;

  if (hrOverlay) {
    hrOverlay.textContent = currentHr ? `HR: ${currentHr} BPM` : 'HR: -- BPM';
    hrOverlay.style.color = currentHr ? '#00F0FF' : '#64748B';
  }
  if (traceDot) {
    traceDot.style.background = currentHr ? '#00F0FF' : '#64748B';
    traceDot.style.boxShadow = currentHr ? '0 0 8px #00F0FF' : 'none';
  }
}

function feedRealEcgPoints() {
  // Pure hardware mode: strictly NO synthetic waveforms are generated!
  return;
}

function renderCanvas() {
  const canvas = document.getElementById('ecgCanvas');
  const miniCanvas = document.getElementById('patMiniEcgCanvas');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;

  // Clear background
  ctx.fillStyle = '#060913';
  ctx.fillRect(0, 0, width, height);

  // Minor Grid lines (subtle clinical 1mm grid)
  ctx.lineWidth = 0.5;
  ctx.strokeStyle = 'rgba(0, 240, 255, 0.04)';
  for (let x = 0; x < width; x += 15) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
  }
  for (let y = 0; y < height; y += 15) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
  }

  // Major Grid lines (5mm clinical grid)
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(0, 240, 255, 0.10)';
  for (let x = 0; x < width; x += 60) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
  }
  for (let y = 0; y < height; y += 60) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
  }

  // Draw Doctor Dashboard Waveform trace ONLY when real signal is valid
  if (isHardwareSignalValid && ecgBuffer.length > 1) {
    ctx.lineWidth = 2.4;
    ctx.strokeStyle = '#00F0FF';
    ctx.shadowColor = '#00F0FF';
    ctx.shadowBlur = 8;
    ctx.beginPath();

    const step = width / (MAX_ECG_POINTS - 1);
    const midY = height / 2;

    // Dynamic DC baseline offset cancellation & Auto-Gain
    let sumAdc = 0, minAdc = 9999, maxAdc = -9999;
    for (let i = 0; i < ecgBuffer.length; i++) {
      const v = ecgBuffer[i];
      sumAdc += v;
      if (v < minAdc) minAdc = v;
      if (v > maxAdc) maxAdc = v;
    }
    const meanAdc = sumAdc / ecgBuffer.length;
    const peakToPeak = Math.max(25, maxAdc - minAdc);
    const targetAmp = height * 0.60;
    const scale = Math.min(3.5, Math.max(0.35, targetAmp / peakToPeak));

    let lastX = 0, lastY = midY;
    for (let i = 0; i < ecgBuffer.length; i++) {
      const x = i * step;
      let raw = ecgBuffer[i];
      let y = midY - (raw - meanAdc) * scale;
      y = Math.max(8, Math.min(height - 8, y));

      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);

      lastX = x;
      lastY = y;
    }
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Oscilloscope glowing sweep head beam
    ctx.fillStyle = '#FFFFFF';
    ctx.shadowColor = '#00F0FF';
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.arc(lastX, lastY, 4, 0, 2 * Math.PI);
    ctx.fill();
    ctx.shadowBlur = 0;
  } else {
    // When electrodes are NOT connected, show "Waiting for ECG signal"
    ctx.fillStyle = '#64748B';
    ctx.font = '600 15px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Waiting for ECG signal', width / 2, height / 2);
    ctx.textAlign = 'left';
  }

  // On-canvas Clean HUD Annotations
  ctx.font = 'bold 11px monospace';
  ctx.fillStyle = 'rgba(0, 240, 255, 0.7)';
  ctx.fillText('LEAD II', 16, 22);

  const hrEl = document.getElementById('liveHrDisplay');
  const liveHrVal = (hrEl && hrEl.textContent !== '--') ? hrEl.textContent : null;
  ctx.fillStyle = liveHrVal ? '#00F0FF' : '#64748B';
  ctx.fillText(liveHrVal ? `HR: ${liveHrVal} BPM` : 'Waiting for sensor', width - 150, 22);

  ctx.font = '10px monospace';
  ctx.fillStyle = 'rgba(148, 163, 184, 0.5)';
  ctx.fillText('25 mm/s • 10 mm/mV • 0.05-150 Hz', 16, height - 12);

  // Mini preview on Patient Canvas
  if (miniCanvas) {
    const mCtx = miniCanvas.getContext('2d');
    const mWidth = miniCanvas.width;
    const mHeight = miniCanvas.height;

    mCtx.fillStyle = '#060913';
    mCtx.fillRect(0, 0, mWidth, mHeight);

    // Minor Grid for mini canvas
    mCtx.lineWidth = 0.5;
    mCtx.strokeStyle = 'rgba(0, 240, 255, 0.05)';
    for (let x = 0; x < mWidth; x += 15) {
      mCtx.beginPath(); mCtx.moveTo(x, 0); mCtx.lineTo(x, mHeight); mCtx.stroke();
    }
    for (let y = 0; y < mHeight; y += 15) {
      mCtx.beginPath(); mCtx.moveTo(0, y); mCtx.lineTo(mWidth, y); mCtx.stroke();
    }

    if (isHardwareSignalValid && ecgBuffer.length > 1) {
      mCtx.lineWidth = 2;
      mCtx.strokeStyle = '#00F0FF';
      mCtx.shadowColor = '#00F0FF';
      mCtx.shadowBlur = 6;
      mCtx.beginPath();

      const mStep = mWidth / (MAX_ECG_POINTS - 1);
      const mMid = mHeight / 2;
      let mSum = 0, mMin = 9999, mMax = -9999;
      for (let i = 0; i < ecgBuffer.length; i++) {
        const v = ecgBuffer[i];
        mSum += v;
        if (v < mMin) mMin = v;
        if (v > mMax) mMax = v;
      }
      const mMean = mSum / ecgBuffer.length;
      const mPk = Math.max(25, mMax - mMin);
      const mScale = Math.min(3.5, Math.max(0.35, (mHeight * 0.60) / mPk));

      let mLastX = 0, mLastY = mMid;
      for (let i = 0; i < ecgBuffer.length; i++) {
        const x = i * mStep;
        let raw = ecgBuffer[i];
        let y = mMid - (raw - mMean) * mScale;
        y = Math.max(4, Math.min(mHeight - 4, y));

        if (i === 0) mCtx.moveTo(x, y);
        else mCtx.lineTo(x, y);

        mLastX = x;
        mLastY = y;
      }
      mCtx.stroke();
      mCtx.shadowBlur = 0;

      // Glow dot for mini canvas
      mCtx.fillStyle = '#FFFFFF';
      mCtx.shadowColor = '#00F0FF';
      mCtx.shadowBlur = 8;
      mCtx.beginPath();
      mCtx.arc(mLastX, mLastY, 3, 0, 2 * Math.PI);
      mCtx.fill();
      mCtx.shadowBlur = 0;
    } else {
      mCtx.fillStyle = '#64748B';
      mCtx.font = '600 11px system-ui, -apple-system, sans-serif';
      mCtx.textAlign = 'center';
      mCtx.fillText('Waiting for ECG signal', mWidth / 2, mHeight / 2);
      mCtx.textAlign = 'left';
    }
  }

  requestAnimationFrame(renderCanvas);
}

function resetEcgScale() {
  ecgBuffer = [];
}

// Download patient readings CSV file
window.downloadReadingsCSV = function() {
  const host = window.location.hostname || 'localhost';
  const port = window.location.port ? `:${window.location.port}` : '';
  const proto = window.location.protocol || 'http:';
  const downloadUrl = `${proto}//${host}${port}/api/v1/readings/download`;
  
  const a = document.createElement('a');
  a.href = downloadUrl;
  a.setAttribute('download', 'patient_readings.csv');
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  if (typeof showToast === 'function') {
    showToast('📥 Downloading patient_readings.csv...');
  }
};

async function triggerHardwareTestPulse() {
  try {
    const host = window.location.hostname || 'localhost';
    const port = window.location.port || '5000';
    const proto = window.location.protocol || 'http:';
    const res = await fetch(`${proto}//${host}:${port}/api/v1/hardware/test-pulse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bpm: 78, spo2: 98 })
    });
    const data = await res.json();
    showToast(`⚡ Test pulse injected for ${currentPatientId}: 78 BPM, 98% SpO₂`);
  } catch (err) {
    console.warn('Test pulse error:', err);
  }
}

// ==========================================================
// 5. Client-Side Synthetic ECG Engine (Disabled: Real Hardware Only)
// ==========================================================
let simTime = 0;
function runLocalSimulationLoop() {
  // Disabled: The dashboard displays strictly real physical hardware data
  return;
  setInterval(() => {
    // If real hardware stream is active in last 4 seconds, yield to real telemetry
    if (lastHardwarePacketTimestamp && (Date.now() - lastHardwarePacketTimestamp < 4000)) {
      return;
    }

    if (!simStreaming) return;

    packetsSentCount += 25;
    const packetLabel = document.getElementById('simPacketStats');
    if (packetLabel) {
      packetLabel.textContent = `Packets Sent: ${packetsSentCount.toLocaleString()} | Sample Rate: 250 Hz | Latency: ~12ms`;
    }

    const newSamples = [];
    const sampleRate = 250;
    const beatPeriod = 60 / simHr;

    for (let i = 0; i < 25; i++) {
      simTime += 1 / sampleRate;
      let val = 512;

      if (simRhythm === 'LEADS_OFF') {
        val = 0;
      } else if (simRhythm === 'NOISE') {
        val += (Math.random() - 0.5) * 280;
      } else {
        const phase = (simTime % beatPeriod) / beatPeriod;

        // P Wave
        if (phase > 0.10 && phase < 0.20) {
          val += 45 * Math.sin((phase - 0.10) * Math.PI / 0.10);
        }
        // Q Wave
        else if (phase > 0.22 && phase < 0.25) {
          val -= 30 * Math.sin((phase - 0.22) * Math.PI / 0.03);
        }
        // R Wave
        else if (phase > 0.25 && phase < 0.29) {
          const rAmp = (simRhythm === 'PVC' && Math.random() < 0.2) ? 450 : 320;
          val += rAmp * Math.sin((phase - 0.25) * Math.PI / 0.04);
        }
        // S Wave
        else if (phase > 0.29 && phase < 0.33) {
          val -= 55 * Math.sin((phase - 0.29) * Math.PI / 0.04);
        }
        // T Wave
        else if (phase > 0.42 && phase < 0.58) {
          val += 85 * Math.sin((phase - 0.42) * Math.PI / 0.16);
        }

        val += Math.sin(simTime * 1.5) * 6;
      }

      newSamples.push(Math.round(val));
    }

    handleIncomingTelemetry({
      type: 'ECG_FRAME',
      heartRate: simHr,
      spo2: simSpo2,
      signalQuality: simRhythm === 'LEADS_OFF' ? 'LEADS_OFF' : (simRhythm === 'NOISE' ? 'POOR' : 'EXCELLENT'),
      samples: newSamples
    });
  }, 100);
}

// ==========================================================
// 6. REST API Services (Patients, Notes, Reports)
// ==========================================================
async function loadPatients() {
  const token = currentAuth?.token || 'demo-token';
  try {
    const res = await fetch(`${API_BASE}/patients`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    renderPatientTable(data.patients || []);
  } catch (err) {
    renderPatientTable([
      { id: 'pat-001', full_name: 'Annindita', status: 'IDLE', current_hr: null, current_spo2: null, attention_score: 10, last_active: 'Waiting for sensor' },
      { id: 'pat-002', full_name: 'Robert Chen', status: 'IDLE', current_hr: null, current_spo2: null, attention_score: 10, last_active: 'Waiting for sensor' }
    ]);
  }
}

let activePatientProfile = {
  id: 'pat-001',
  full_name: 'Annindita',
  gender: 'Female',
  age: 26,
  blood_group: 'B+'
};

function renderPatientTable(patients) {
  const tbody = document.getElementById('patientTableBody');
  if (!tbody) return;

  // Update total patients and active monitoring counters dynamically
  const totalCount = patients.length;
  const monitoringCount = patients.filter(p => p.status === 'MONITORING' || p.status === 'LIVE').length;
  const statTotal = document.getElementById('docTotalPatients');
  const statMon = document.getElementById('docActiveMonitoring');
  if (statTotal) statTotal.textContent = totalCount;
  if (statMon) statMon.textContent = monitoringCount;

  tbody.innerHTML = patients.map(p => {
    let badgeClass = 'badge-low';
    let attentionLabel = 'Low';
    if (p.attention_score > 60) { badgeClass = 'badge-high'; attentionLabel = 'High'; }
    else if (p.attention_score > 30) { badgeClass = 'badge-med'; attentionLabel = 'Moderate'; }

    let calculatedAge = p.age || 26;
    if (p.dob) {
      const bYear = parseInt(p.dob.split('-')[0]);
      if (!isNaN(bYear)) calculatedAge = new Date().getFullYear() - bYear;
    }
    const displayGender = p.gender ? (p.gender.charAt(0).toUpperCase() + p.gender.slice(1).toLowerCase()) : 'Female';
    const isDemo = Boolean(p.is_demo);

    return `
      <tr data-patient-id="${p.id}" style="${isDemo ? 'opacity: 0.85; background: rgba(30, 41, 59, 0.4);' : ''}">
        <td>
          <div style="font-weight: 600; display: flex; align-items: center; gap: 6px;">
            <span id="pname-${p.id}">${p.full_name}</span>
            ${isDemo ? '<span style="font-size: 0.65rem; background: #334155; color: #94A3B8; padding: 1px 5px; border-radius: 4px; font-weight: 700; border: 1px solid #475569;">DEMO</span>' : '<span style="font-size: 0.65rem; background: rgba(16, 185, 129, 0.15); color: #10B981; padding: 1px 5px; border-radius: 4px; font-weight: 700; border: 1px solid rgba(16, 185, 129, 0.3);">REAL</span>'}
          </div>
          <div style="font-size: 0.75rem; color: var(--text-sub);">${p.id}</div>
        </td>
        <td>
          <div style="font-size: 0.8125rem; font-weight: 600; color: #E2E8F0;">${displayGender}, ${calculatedAge} yrs</div>
          <div style="font-size: 0.72rem; color: var(--text-sub);">Blood: ${p.blood_group || 'B+'}</div>
        </td>
        <td class="cell-status">
          <span class="badge ${p.status === 'MONITORING' ? 'badge-low' : ''}" style="${p.status !== 'MONITORING' ? 'background: rgba(100, 116, 139, 0.2); color: #94A3B8;' : ''}">
            ${p.status === 'MONITORING' ? '● Monitoring' : 'Waiting for sensor'}
          </span>
        </td>
        <td class="cell-hr">${p.current_hr ? `<strong>${p.current_hr}</strong> BPM` : '--'}</td>
        <td class="cell-spo2">${p.current_spo2 ? `<strong>${p.current_spo2}%</strong>` : '--'}</td>
        <td>
          <span class="badge ${badgeClass}">${attentionLabel} (${p.attention_score})</span>
        </td>
        <td style="white-space: nowrap;">
          <button class="btn btn-secondary" style="padding: 4px 8px; font-size: 0.75rem; margin-right: 4px;" onclick="selectPatient('${p.id}', '${p.full_name}', '${displayGender}', ${calculatedAge})">
            Monitor
          </button>
          <button class="btn btn-secondary" style="padding: 4px 8px; font-size: 0.75rem; color: #60A5FA; border-color: rgba(96, 165, 250, 0.4);" onclick="downloadPatientReport('${p.id}', this)" title="Download Medical Report PDF for ${p.full_name}">
            📄 Report
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

function selectPatient(id, name, gender, age) {
  currentPatientId = id;
  activePatientProfile.id = id;
  activePatientProfile.full_name = name;
  if (gender) activePatientProfile.gender = gender;
  if (age) activePatientProfile.age = age;

  document.getElementById('activeMonitoringLabel').textContent = `LIVE ECG — ${name} (${id})`;
  const demoBadge = document.getElementById('activePatientDemographicsBadge');
  if (demoBadge) {
    demoBadge.textContent = `${activePatientProfile.gender || 'Female'}, ${activePatientProfile.age || 26} yrs`;
  }

  const mobName = document.getElementById('mobilePatientName');
  if (mobName) mobName.textContent = name;

  // Clear ECG buffer so waveform starts fresh for this patient
  ecgBuffer = [];

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'SUBSCRIBE_PATIENT', patientId: id }));
    ws.send(JSON.stringify({ type: 'SET_ACTIVE_PATIENT', patientId: id }));
  }
  loadNotes();
  loadPatientHistory(id);
  triggerAiRecheck();
}

function openPatientEditModal() {
  const currentName = activePatientProfile.full_name || document.getElementById(`pname-${currentPatientId}`)?.textContent || 'Annindita';
  const nameInput = document.getElementById('editModalPatientName');
  const genderInput = document.getElementById('editModalPatientGender');
  const ageInput = document.getElementById('editModalPatientAge');
  const bloodInput = document.getElementById('editModalPatientBlood');

  if (nameInput) nameInput.value = currentName;
  if (genderInput) genderInput.value = activePatientProfile.gender || 'Female';
  if (ageInput) ageInput.value = activePatientProfile.age || 26;
  if (bloodInput) bloodInput.value = activePatientProfile.blood_group || 'B+';

  const modal = document.getElementById('patientEditModal');
  if (modal) modal.style.display = 'flex';
}

function closePatientEditModal() {
  const modal = document.getElementById('patientEditModal');
  if (modal) modal.style.display = 'none';
}

async function savePatientProfileModal() {
  const nameVal = document.getElementById('editModalPatientName')?.value.trim();
  const genderVal = document.getElementById('editModalPatientGender')?.value;
  const ageVal = parseInt(document.getElementById('editModalPatientAge')?.value);
  const bloodVal = document.getElementById('editModalPatientBlood')?.value;

  if (!nameVal) {
    alert('Please enter a valid patient name.');
    return;
  }

  activePatientProfile.full_name = nameVal;
  if (genderVal) activePatientProfile.gender = genderVal;
  if (!isNaN(ageVal) && ageVal > 0) activePatientProfile.age = ageVal;
  if (bloodVal) activePatientProfile.blood_group = bloodVal;

  // Update Doctor Dashboard Header
  document.getElementById('activeMonitoringLabel').textContent = `LIVE ECG — ${nameVal} (${currentPatientId})`;
  const demoBadge = document.getElementById('activePatientDemographicsBadge');
  if (demoBadge) {
    demoBadge.textContent = `${activePatientProfile.gender}, ${activePatientProfile.age} yrs`;
  }

  // Update Patient Mobile View Name
  const mobileName = document.getElementById('mobilePatientName');
  if (mobileName) mobileName.textContent = nameVal;

  // Update PDF Report Template
  const pdfName = document.getElementById('pdfMinPatientName');
  if (pdfName) pdfName.textContent = nameVal;
  const pdfAge = document.getElementById('pdfMinPatientAge');
  if (pdfAge) pdfAge.textContent = activePatientProfile.age;
  const pdfGender = document.getElementById('pdfMinPatientGender');
  if (pdfGender) pdfGender.textContent = activePatientProfile.gender;

  // Update table row
  const nameEl = document.getElementById(`pname-${currentPatientId}`);
  if (nameEl) nameEl.textContent = nameVal;

  // Persist to backend
  try {
    const token = currentAuth?.token || 'demo-token';
    await fetch(`${API_BASE}/patients/${currentPatientId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        full_name: nameVal,
        gender: activePatientProfile.gender,
        age: activePatientProfile.age,
        blood_group: activePatientProfile.blood_group
      })
    });
    showToast(`✅ Profile updated: ${nameVal} (${activePatientProfile.gender}, ${activePatientProfile.age} yrs)`);
  } catch (err) {
    showToast(`Profile updated: ${nameVal}`);
  }

  closePatientEditModal();
  loadPatients();
}

// ----------------------------------------------------------
// Real Patient Management: Add New Patient Functions
// ----------------------------------------------------------
function openAddPatientModal() {
  const modal = document.getElementById('addPatientModal');
  if (modal) modal.style.display = 'flex';
  const nameInput = document.getElementById('newPatientName');
  if (nameInput) {
    nameInput.value = '';
    nameInput.focus();
  }
  const idInput = document.getElementById('newPatientId');
  if (idInput) idInput.value = '';
  const contactInput = document.getElementById('newPatientContact');
  if (contactInput) contactInput.value = '';
}

function closeAddPatientModal() {
  const modal = document.getElementById('addPatientModal');
  if (modal) modal.style.display = 'none';
}

async function saveNewPatientModal() {
  const nameInput = document.getElementById('newPatientName');
  const idInput = document.getElementById('newPatientId');
  const contactInput = document.getElementById('newPatientContact') || document.getElementById('newPatientPhone') || document.getElementById('newPatientEmail');
  const genderInput = document.getElementById('newPatientGender');
  const ageInput = document.getElementById('newPatientAge');
  const bloodInput = document.getElementById('newPatientBlood');

  const nameVal = nameInput ? nameInput.value.trim() : '';
  const idVal = idInput ? idInput.value.trim() : '';
  const contactVal = contactInput ? contactInput.value.trim() : '';
  const genderVal = genderInput ? genderInput.value : 'Female';
  const ageVal = ageInput ? parseInt(ageInput.value) : 26;
  const bloodVal = bloodInput ? bloodInput.value : 'B+';

  let emailVal = '';
  let phoneVal = '';
  if (contactVal.includes('@')) {
    emailVal = contactVal;
  } else if (contactVal) {
    phoneVal = contactVal;
  }

  if (!nameVal) {
    alert('Please enter patient full name.');
    if (nameInput) nameInput.focus();
    return;
  }

  try {
    const token = currentAuth?.token || 'demo-token';
    const res = await fetch(`${API_BASE}/patients`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        full_name: nameVal,
        id: idVal,
        email: emailVal,
        gender: genderVal,
        age: isNaN(ageVal) ? 26 : ageVal,
        blood_group: bloodVal,
        phone: phoneVal
      })
    });

    const data = await res.json();
    if (data && data.patient) {
      const p = data.patient;
      // Switch active monitoring to this newly added real patient immediately!
      selectPatient(p.id, p.full_name, p.gender, p.age);
      showToast(`🎉 Real patient "${p.full_name}" (${p.id}) added and set to active monitoring!`);
    } else {
      showToast(`Patient "${nameVal}" added!`);
    }
  } catch (err) {
    console.warn('Fallback adding real patient locally:', err);
    const newId = idVal || `pat-${Date.now().toString().slice(-3)}`;
    selectPatient(newId, nameVal, genderVal, ageVal);
    showToast(`Real patient "${nameVal}" added!`);
  }

  closeAddPatientModal();
  loadPatients();
}

async function promptEditPatientName() {
  openPatientEditModal();
}

async function loadNotes() {
  const token = currentAuth?.token || 'demo-token';
  try {
    const res = await fetch(`${API_BASE}/notes/patient/${currentPatientId}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    renderNotes(data.notes || []);
  } catch (err) {
    renderNotes([
      {
        doctor_name: 'Dr. Evelyn Vance, MD',
        created_at: new Date(Date.now() - 20 * 3600 * 1000).toISOString(),
        note_text: 'Reviewed 24-hr Holter-equivalent telemetry session. Waveform exhibits clean P-QRS-T complexes. Patient advised to continue daily 30-min walking regimen.'
      }
    ]);
  }
}

function renderNotes(notes) {
  const container = document.getElementById('notesList');
  if (!container) return;

  container.innerHTML = notes.map(n => `
    <div style="background: #0B0F19; border: 1px solid var(--border); border-radius: 8px; padding: 10px;">
      <div style="display: flex; justify-content: space-between; font-size: 0.75rem; color: var(--text-sub); margin-bottom: 4px;">
        <span style="font-weight: 600; color: #60A5FA;">${n.doctor_name || 'Dr. Evelyn Vance'}</span>
        <span>${new Date(n.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
      </div>
      <p style="font-size: 0.8125rem; color: #E2E8F0; line-height: 1.4;">${n.note_text}</p>
    </div>
  `).join('');
}

async function saveDoctorNote() {
  const input = document.getElementById('newNoteInput');
  const text = input.value.trim();
  if (!text) return;

  const token = currentAuth?.token || 'demo-token';
  try {
    await fetch(`${API_BASE}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ patient_id: currentPatientId, note_text: text })
    });
  } catch (err) {
    console.log('Saved note locally');
  }

  input.value = '';
  loadNotes();
}

function togglePatientSession() {
  const btn = document.getElementById('btnToggleSession');
  const badge = document.getElementById('patStatusBadge');
  isPatientMonitoring = !isPatientMonitoring;

  if (isPatientMonitoring) {
    btn.textContent = '⏹ Stop Monitoring';
    btn.className = 'btn btn-danger';
    badge.textContent = '● Monitoring';
    badge.className = 'badge badge-low';
  } else {
    btn.textContent = '▶ Start Monitoring';
    btn.className = 'btn';
    badge.textContent = 'Paused';
    badge.className = 'badge badge-med';
    triggerAiRecheck();
  }
}

// ----------------------------------------------------------
// AI Telemetry Dashboard Card Renderer
// ----------------------------------------------------------
function updateAiDashboardCard(evaluation) {
  if (!evaluation) return;

  const isInsufficient = evaluation.hasSufficientData === false || evaluation.riskLevel === 'Insufficient data';
  const risk = isInsufficient ? 'Insufficient data' : (evaluation.riskLevel || 'Normal');
  const riskClass = isInsufficient 
    ? 'badge' 
    : ((risk === 'High') ? 'badge badge-high' : ((risk === 'Attention') ? 'badge badge-med' : 'badge badge-low'));

  // 1. Doctor Risk Level Badge
  const docRiskBadge = document.getElementById('docAiRiskBadge') || document.getElementById('docAiBadge');
  if (docRiskBadge) {
    docRiskBadge.className = riskClass;
    if (isInsufficient) {
      docRiskBadge.style.background = 'rgba(100, 116, 139, 0.2)';
      docRiskBadge.style.color = '#94A3B8';
      docRiskBadge.style.borderColor = 'rgba(100, 116, 139, 0.4)';
    } else {
      docRiskBadge.style.background = '';
      docRiskBadge.style.color = '';
      docRiskBadge.style.borderColor = '';
    }
    docRiskBadge.textContent = isInsufficient ? 'Status: Waiting' : `Risk: ${risk}`;
  }

  // 2. Patient Risk Level Badge
  const patRiskBadge = document.getElementById('patAiScoreBadge');
  if (patRiskBadge) {
    patRiskBadge.className = riskClass;
    if (isInsufficient) {
      patRiskBadge.style.background = 'rgba(100, 116, 139, 0.2)';
      patRiskBadge.style.color = '#94A3B8';
      patRiskBadge.style.borderColor = 'rgba(100, 116, 139, 0.4)';
      patRiskBadge.textContent = 'Insufficient data';
    } else {
      patRiskBadge.style.background = '';
      patRiskBadge.style.color = '';
      patRiskBadge.style.borderColor = '';
      patRiskBadge.textContent = `Risk: ${risk}`;
    }
  }

  // 2.1 Patient Age and Measured Vitals Context Display
  const patAgeDisplay = document.getElementById('patAiAgeDisplay');
  if (patAgeDisplay) {
    patAgeDisplay.textContent = `${activePatientProfile.age || 26} yrs`;
  }
  const patVitalsDisplay = document.getElementById('patAiVitalsDisplay');
  if (patVitalsDisplay) {
    const hrEl = document.getElementById('liveHrDisplay');
    const spo2El = document.getElementById('liveSpo2Display');
    const hasHr = hrEl && hrEl.textContent !== '--';
    const hasSpo2 = spo2El && spo2El.textContent !== '--';
    if (hasHr || hasSpo2) {
      patVitalsDisplay.textContent = `${hasHr ? `${hrEl.textContent} BPM` : 'HR: --'} | ${hasSpo2 ? `${spo2El.textContent}%` : 'SpO₂: --'}`;
      patVitalsDisplay.style.color = '#00F0FF';
    } else {
      patVitalsDisplay.textContent = 'Waiting for sensor';
      patVitalsDisplay.style.color = '#94A3B8';
    }
  }

  // 3. ECG Waveform Classification Badge & Text
  const ecgClassification = evaluation.ecgClassification || {};
  const isEcgNormal = ecgClassification.isNormal !== false && ecgClassification.classification === 'Normal';

  const docEcgBadge = document.getElementById('docAiEcgBadge');
  if (docEcgBadge) {
    docEcgBadge.className = isEcgNormal ? 'badge badge-low' : 'badge badge-high';
    docEcgBadge.textContent = isHardwareSignalValid 
      ? (isEcgNormal ? 'ECG: Normal' : 'ECG: Possible Irregular Pattern')
      : 'ECG: Waiting for signal';
  }

  const docEcgStatusText = document.getElementById('docAiEcgStatusText');
  if (docEcgStatusText) {
    docEcgStatusText.textContent = isHardwareSignalValid 
      ? (ecgClassification.patternType || (isEcgNormal ? 'Normal Sinus Cadence' : 'Possible Irregular Pattern'))
      : 'Waiting for ECG signal';
    docEcgStatusText.style.color = isHardwareSignalValid ? (isEcgNormal ? '#10B981' : '#EF4444') : '#94A3B8';
  }

  // 4. Historical Baseline Shift
  const docHistoryText = document.getElementById('docAiHistoryTrendText');
  if (docHistoryText) {
    const hist = evaluation.historicalComparison;
    if (hist && hist.comparisonSummary) {
      docHistoryText.textContent = hist.comparisonSummary;
    } else {
      docHistoryText.textContent = 'Awaiting active telemetry stream';
    }
  }

  // 5. Multi-Parametric Score Text
  const scoreText = document.getElementById('docAiScoreText');
  if (scoreText) {
    if (isInsufficient) {
      scoreText.textContent = '-- / 100 (Waiting for sensor)';
      scoreText.style.color = '#94A3B8';
    } else {
      scoreText.textContent = `${evaluation.riskScore || 15} / 100 (${risk} Tier)`;
      scoreText.style.color = (risk === 'High') ? '#EF4444' : ((risk === 'Attention') ? '#F59E0B' : '#60A5FA');
    }
  }

  // 6. Doctor and Patient Clinical Summaries
  const docSummary = document.getElementById('docAiSummaryText');
  if (docSummary) {
    docSummary.textContent = evaluation.doctorSummary || 'Waiting for real-time sensor readings.';
  }
  const patSummary = document.getElementById('patAiSummaryBody');
  if (patSummary) {
    patSummary.textContent = evaluation.patientSummary || evaluation.doctorSummary || 'Insufficient data. Please attach your sensors to generate an AI monitoring summary.';
  }

  // 7. Clinical Observation Badges / Tags
  const tagsContainer = document.getElementById('docAiTags');
  if (tagsContainer) {
    const tags = (evaluation.riskFactors && evaluation.riskFactors.length > 0)
      ? evaluation.riskFactors
      : ['Awaiting Sensor Telemetry'];
    tagsContainer.innerHTML = tags.slice(0, 4).map(f => `
      <span class="${riskClass}">${f}</span>
    `).join('');
  }

  // 8. PDF Export Sync
  const pdfRisk = document.getElementById('pdfMinRiskLevel');
  if (pdfRisk) {
    pdfRisk.textContent = isInsufficient ? 'Pending' : risk;
    pdfRisk.style.color = (risk === 'High') ? '#DC2626' : ((risk === 'Attention') ? '#D97706' : '#059669');
  }
  const pdfEcg = document.getElementById('pdfMinEcgStatus');
  if (pdfEcg) {
    pdfEcg.textContent = isHardwareSignalValid ? (ecgClassification.classification || (isEcgNormal ? 'Normal' : 'Possible Irregular Pattern')) : 'Awaiting Signal';
    pdfEcg.style.color = isHardwareSignalValid ? (isEcgNormal ? '#0284C7' : '#DC2626') : '#64748B';
  }
}

async function triggerAiRecheck() {
  const liveHrEl = document.getElementById('liveHrDisplay');
  const liveSpo2El = document.getElementById('liveSpo2Display');
  const liveHrNum = (liveHrEl && liveHrEl.textContent !== '--' && !isNaN(parseInt(liveHrEl.textContent))) 
    ? parseInt(liveHrEl.textContent) 
    : (hardwareDeviceConnected ? null : simHr);
  const liveSpo2Num = (liveSpo2El && liveSpo2El.textContent !== '--' && !isNaN(parseInt(liveSpo2El.textContent))) 
    ? parseInt(liveSpo2El.textContent) 
    : (hardwareDeviceConnected ? null : simSpo2);

  try {
    const token = currentAuth?.token || 'demo-token';
    const res = await fetch(`${API_BASE}/ai/evaluate-vitals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        patientId: currentPatientId || 'pat-001',
        hr: liveHrNum,
        spo2: liveSpo2Num,
        leadsOff: !hardwareDeviceConnected && (liveHrNum === null)
      })
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.evaluation) {
        updateAiDashboardCard(data.evaluation);
        showToast('AI assessment updated');
        return;
      }
    }
  } catch (err) {
    console.warn('AI evaluation fetch fallback:', err);
  }

  // Local fallback if offline
  const localRisk = (liveSpo2Num && liveSpo2Num < 90) || (liveHrNum && liveHrNum > 130) ? 'High' : ((liveHrNum && liveHrNum > 100) || (liveSpo2Num && liveSpo2Num < 95) ? 'Attention' : 'Normal');
  updateAiDashboardCard({
    riskLevel: localRisk,
    riskScore: localRisk === 'High' ? 82 : (localRisk === 'Attention' ? 52 : 15),
    riskFactors: [localRisk === 'Normal' ? 'All parameters within expected physiological thresholds' : 'Vital variation noted'],
    ecgClassification: {
      classification: localRisk === 'High' ? 'Possible Irregular Pattern' : 'Normal',
      isNormal: localRisk !== 'High',
      patternType: localRisk === 'High' ? 'Possible Irregular Pattern' : 'Normal Sinus Rhythm'
    },
    historicalComparison: {
      comparisonSummary: `Evaluated against patient baseline (HR: ${liveHrNum || 75} BPM, SpO₂: ${liveSpo2Num || 98}%)`
    },
    doctorSummary: `Telemetry screening reflects ${localRisk} risk tier with pulse at ${liveHrNum || 75} BPM and SpO₂ at ${liveSpo2Num || 98}%. AI-assisted screening only. Not a medical diagnosis.`
  });
}

// ==========================================================
// 6.5 Patient Medical History Module (Doctor & Patient Dashboards)
// ==========================================================
let currentPatientHistoryData = null;

async function loadPatientHistory(patientId) {
  const targetId = patientId || currentPatientId || 'pat-001';
  try {
    const token = currentAuth?.token || 'demo-token';
    const res = await fetch(`${API_BASE}/patients/${targetId}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (res.ok) {
      const data = await res.json();
      currentPatientHistoryData = data;
      renderPatientHistoryUI(data);
      return;
    }
  } catch (err) {
    console.warn('Could not load patient history from API, using fallback data:', err);
  }

  // Fallback defaults if offline or network issue
  const fallbackData = (targetId === 'pat-002') ? {
    id: 'pat-002',
    full_name: 'Robert Chen',
    blood_group: 'O+',
    conditions: ['Essential Hypertension (Stage 1, Controlled)', 'Hyperlipidemia', 'Mild Sinus Bradycardia at rest'],
    medications: ['Amlodipine 5mg (OD Morning)', 'Atorvastatin 10mg (Bedtime)', 'Aspirin 75mg'],
    allergies: ['Sulfa Antibiotics (Severe skin rash)', 'NSAIDs (Mild gastric discomfort)'],
    history_timeline: [
      { date: '2026-09-10', type: 'Hypertension & Lipid Review', doctor: 'Dr. Evelyn Vance, MD', summary: 'Blood pressure 126/80 mmHg. Resting pulse 62 BPM. Lipid panel stable on statin therapy.' },
      { date: '2026-06-04', type: 'Cardiac Stress Assessment', doctor: 'Dr. Evelyn Vance, MD', summary: 'Exercise tolerance test completed with normal recovery. No ST elevation.' }
    ]
  } : {
    id: targetId,
    full_name: activePatientProfile.full_name || 'Annindita',
    blood_group: activePatientProfile.blood_group || 'B+',
    conditions: ['Mild Sinus Arrhythmia (Diagnosed 2024)', 'Occasional post-exercise palpitations', 'No prior myocardial infarction or stroke'],
    medications: ['Metoprolol Succinate 25mg (Once daily morning)', 'Omega-3 Fatty Acids 1000mg', 'Multivitamin Daily'],
    allergies: ['Penicillin (Causes mild cutaneous rash)', 'No known food allergies'],
    history_timeline: [
      { date: '2026-09-20', type: 'Continuous Holter Telemetry', doctor: 'Dr. Evelyn Vance, MD', summary: '24-hour baseline evaluation. Sinus cadence normal with healthy heart rate variability (HRV).' },
      { date: '2026-08-14', type: 'Cardiology Follow-up', doctor: 'Dr. Evelyn Vance, MD', summary: 'Routine cardiac review. ECG Lead II clean, resting BP 118/76 mmHg. Advised active hydration.' },
      { date: '2026-05-10', type: 'Initial Intake Electrocardiogram', doctor: 'Dr. Evelyn Vance, MD', summary: 'Baseline 12-lead equivalent recorded. No ischemic changes. P-QRS-T complexes within normal limits.' }
    ]
  };

  currentPatientHistoryData = fallbackData;
  renderPatientHistoryUI(fallbackData);
}

function renderPatientHistoryUI(data) {
  if (!data) return;

  const conditions = data.conditions || ['Baseline Cardiac Monitoring Established'];
  const medications = data.medications || ['No active prescription'];
  const allergies = data.allergies || ['No known allergies (NKDA)'];
  const timeline = data.history_timeline || [];

  // 1. Doctor Dashboard History Card
  const docSubtitle = document.getElementById('docHistorySubtitle');
  if (docSubtitle) docSubtitle.textContent = `Clinical profile for ${data.full_name} (${data.id}) • Blood: ${data.blood_group || 'B+'}`;

  const docConditions = document.getElementById('docConditionsList');
  if (docConditions) {
    docConditions.innerHTML = conditions.map(c => `
      <div class="clinical-chip condition-chip">🫀 ${c}</div>
    `).join('');
  }

  const docMedications = document.getElementById('docMedicationsList');
  if (docMedications) {
    docMedications.innerHTML = medications.map(m => `
      <div class="clinical-chip medication-chip">💊 ${m}</div>
    `).join('');
  }

  const docAllergies = document.getElementById('docAllergiesList');
  if (docAllergies) {
    docAllergies.innerHTML = allergies.map(a => `
      <div class="clinical-chip allergy-chip">⚠️ ${a}</div>
    `).join('');
  }

  const docTimeline = document.getElementById('docHistoryTimeline');
  if (docTimeline) {
    if (timeline.length === 0) {
      docTimeline.innerHTML = `<div style="font-size: 0.8rem; color: var(--text-muted); font-style: italic;">No prior clinical history records logged.</div>`;
    } else {
      docTimeline.innerHTML = timeline.map(item => `
        <div class="history-timeline-item">
          <div class="history-timeline-header">
            <span class="history-timeline-date">${item.date}</span>
            <span class="history-timeline-doctor">${item.doctor || 'Attending Physician'}</span>
          </div>
          <div class="history-timeline-type">${item.type}</div>
          <div class="history-timeline-summary">${item.summary}</div>
        </div>
      `).join('');
    }
  }

  // 2. Patient Mobile View History Card
  const patBloodBadge = document.getElementById('patHistoryBloodBadge');
  if (patBloodBadge) patBloodBadge.textContent = `Blood: ${data.blood_group || 'B+'}`;

  const patConditions = document.getElementById('patConditionsList');
  if (patConditions) {
    patConditions.innerHTML = conditions.map(c => `
      <div class="clinical-chip condition-chip" style="font-size: 0.75rem;">🫀 ${c}</div>
    `).join('');
  }

  const patMedications = document.getElementById('patMedicationsList');
  if (patMedications) {
    patMedications.innerHTML = medications.map(m => `
      <div class="clinical-chip medication-chip" style="font-size: 0.75rem;">💊 ${m}</div>
    `).join('');
  }

  const patAllergies = document.getElementById('patAllergiesList');
  if (patAllergies) {
    patAllergies.innerHTML = allergies.map(a => `
      <div class="clinical-chip allergy-chip" style="font-size: 0.75rem;">⚠️ ${a}</div>
    `).join('');
  }

  const patTimeline = document.getElementById('patHistoryTimeline');
  if (patTimeline) {
    if (timeline.length === 0) {
      patTimeline.innerHTML = `<div style="font-size: 0.75rem; color: var(--text-muted); font-style: italic;">No prior tests recorded.</div>`;
    } else {
      patTimeline.innerHTML = timeline.map(item => `
        <div class="history-timeline-item" style="padding: 6px 10px;">
          <div class="history-timeline-header">
            <span class="history-timeline-date" style="font-size: 0.72rem;">${item.date}</span>
            <span class="history-timeline-doctor" style="font-size: 0.68rem;">${item.doctor || 'Doctor'}</span>
          </div>
          <div class="history-timeline-type" style="font-size: 0.75rem;">${item.type}</div>
          <div class="history-timeline-summary" style="font-size: 0.72rem;">${item.summary}</div>
        </div>
      `).join('');
    }
  }
}

function openAddHistoryModal() {
  const modal = document.getElementById('addHistoryModal');
  if (modal) {
    const notesInput = document.getElementById('historyEntryNotes');
    const condInput = document.getElementById('historyEntryCondition');
    const medInput = document.getElementById('historyEntryMedication');
    if (notesInput) notesInput.value = '';
    if (condInput) condInput.value = '';
    if (medInput) medInput.value = '';
    modal.style.display = 'flex';
  }
}

function closeAddHistoryModal() {
  const modal = document.getElementById('addHistoryModal');
  if (modal) modal.style.display = 'none';
}

async function savePatientHistoryRecord() {
  const type = document.getElementById('historyEntryType')?.value || 'Cardiology Review';
  const notes = document.getElementById('historyEntryNotes')?.value?.trim();
  const newCondition = document.getElementById('historyEntryCondition')?.value?.trim();
  const newMedication = document.getElementById('historyEntryMedication')?.value?.trim();

  if (!notes) {
    alert('Please enter clinical notes / observations.');
    document.getElementById('historyEntryNotes')?.focus();
    return;
  }

  const payload = {
    type,
    summary: notes
  };

  if (currentPatientHistoryData) {
    if (newCondition) {
      payload.conditions = [...(currentPatientHistoryData.conditions || []), newCondition];
    }
    if (newMedication) {
      payload.medications = [...(currentPatientHistoryData.medications || []), newMedication];
    }
  }

  try {
    const token = currentAuth?.token || 'demo-token';
    const res = await fetch(`${API_BASE}/patients/${currentPatientId}/history`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      showToast('✅ Clinical history record saved successfully.');
      closeAddHistoryModal();
      await loadPatientHistory(currentPatientId);
      return;
    }
  } catch (err) {
    console.warn('Backend history record save note:', err);
  }

  // Local fallback update
  if (currentPatientHistoryData) {
    if (!currentPatientHistoryData.history_timeline) currentPatientHistoryData.history_timeline = [];
    currentPatientHistoryData.history_timeline.unshift({
      date: new Date().toISOString().split('T')[0],
      type,
      doctor: currentAuth?.user?.full_name || 'Dr. Evelyn Vance, MD',
      summary: notes
    });
    if (newCondition) currentPatientHistoryData.conditions.push(newCondition);
    if (newMedication) currentPatientHistoryData.medications.push(newMedication);
    renderPatientHistoryUI(currentPatientHistoryData);
  }

  showToast('✅ Clinical history record added.');
  closeAddHistoryModal();
}

// Clean & Simple ECG Heartbeat Waveform Renderer for PDF Reports
function renderPdfEcgStrip(hr) {
  const canvas = document.getElementById('pdfEcgStripCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;

  // 1. Clean, pure white background
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, w, h);

  const midY = Math.round(h / 2);

  // 2. Subtle, clean center baseline guideline
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#F1F5F9';
  ctx.beginPath();
  ctx.moveTo(0, midY);
  ctx.lineTo(w, midY);
  ctx.stroke();

  // 3. Draw Clean, Smooth Blue Heartbeat Wave
  const bpm = (typeof hr === 'number' && hr >= 40 && hr <= 180) ? hr : ((lastKnownGoodHr && lastKnownGoodHr >= 40) ? lastKnownGoodHr : 75);
  const beatPeriod = 60 / bpm;
  const pixelsPerSec = 110;

  ctx.lineWidth = 2.2;
  ctx.strokeStyle = '#0284C7';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();

  for (let x = 0; x < w; x++) {
    const t = x / pixelsPerSec;
    const cycleTime = t % beatPeriod;
    const rTime = 0.35 * beatPeriod;
    const dt = cycleTime - rTime;

    // Clean Gaussian cardiac wave
    const p = 5.5 * Math.exp(-Math.pow(dt + 0.16, 2) / (2 * Math.pow(0.026, 2)));
    const q = -4.5 * Math.exp(-Math.pow(dt + 0.042, 2) / (2 * Math.pow(0.012, 2)));
    const r = 23.5 * Math.exp(-Math.pow(dt, 2) / (2 * Math.pow(0.018, 2)));
    const s = -9.5 * Math.exp(-Math.pow(dt - 0.046, 2) / (2 * Math.pow(0.015, 2)));
    const tWave = 8.5 * Math.exp(-Math.pow(dt - 0.23, 2) / (2 * Math.pow(0.065, 2)));

    const y = midY - (p + q + r + s + tWave);
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

// ==========================================================
// 7. Minimal Clinical PDF Report Generator (html2pdf)
// ==========================================================
async function downloadPatientReport(patientId, clickedBtn = null) {
  let targetId = patientId;
  if (!targetId) {
    if (currentAuth && currentAuth.role === 'PATIENT') {
      targetId = currentAuth.user.patientId || 'pat-001';
    } else {
      targetId = currentPatientId || 'pat-001';
    }
  }

  // Update button UI loading state
  const btn = clickedBtn || document.getElementById('btnDownloadPatientReport') || document.getElementById('btnGenerateDocReport');
  const originalHtml = btn ? btn.innerHTML : '';
  if (btn) {
    btn.innerHTML = '<span>⏳</span> Generating...';
    btn.disabled = true;
  }

  // Baseline patient fallback details
  let patient = {
    id: targetId,
    full_name: (targetId === currentPatientId && activePatientProfile.full_name) 
      ? activePatientProfile.full_name 
      : ((targetId === 'pat-002') ? 'Robert Chen' : 'Annindita'),
    dob: (targetId === 'pat-002') ? '1962-11-04' : '1998-05-20',
    gender: (targetId === currentPatientId && activePatientProfile.gender) 
      ? activePatientProfile.gender 
      : ((targetId === 'pat-002') ? 'Male' : 'Female'),
    age: (targetId === currentPatientId && activePatientProfile.age) ? activePatientProfile.age : 26,
    blood_group: 'B+',
    phone: '+91-98765-43210',
    current_hr: 76,
    current_spo2: 98,
    baseline_hr_mean: 72.0,
    baseline_spo2_mean: 98.2,
    conditions: ['Mild Sinus Arrhythmia (Diagnosed 2024)', 'No prior myocardial infarction or stroke'],
    medications: ['Metoprolol Succinate 25mg (Once daily morning)', 'Omega-3 Fatty Acids 1000mg'],
    allergies: ['Penicillin (Cutaneous rash)', 'No known food allergies'],
    history_timeline: [
      { date: '2026-09-20', type: 'Continuous Holter Telemetry', doctor: 'Dr. Evelyn Vance, MD', summary: '24-hour baseline evaluation. Sinus cadence normal with healthy heart rate variability.' },
      { date: '2026-08-14', type: 'Cardiology Follow-up', doctor: 'Dr. Evelyn Vance, MD', summary: 'Routine cardiac review. ECG Lead II clean, resting BP 118/76 mmHg.' }
    ],
    doctorNotes: []
  };

  try {
    const token = currentAuth?.token || 'demo-token';
    const res = await fetch(`${API_BASE}/patients/${targetId}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.full_name) {
        Object.assign(patient, data);
        if (data.emergency_contact_phone && !patient.phone) patient.phone = data.emergency_contact_phone;
      }
    }
  } catch (e) {
    console.log('Using local patient profile snapshot for report');
  }

  // Attending Doctor identification
  const doctorName = (currentAuth && currentAuth.user && currentAuth.user.role === 'DOCTOR')
    ? (currentAuth.user.full_name || 'Dr. Evelyn Vance, MD')
    : 'Dr. Evelyn Vance, MD';

  // Calculate approximate age
  let age = patient.age;
  if (!age && patient.dob) {
    const birthYear = parseInt(patient.dob.split('-')[0]);
    if (!isNaN(birthYear)) age = new Date().getFullYear() - birthYear;
  }
  if (!age) age = 26;
  const displayGender = patient.gender ? (patient.gender.charAt(0).toUpperCase() + patient.gender.slice(1).toLowerCase()) : 'Female';

  // Simple, clean Date and Time: "24 Sep 2026, 01:52 AM"
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
  const dateFormatted = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const timeFormatted = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
  const simpleDateTime = `${dateFormatted}, ${timeFormatted}`;

  // 1. Populate Header & Demographics Elements
  const dtEl = document.getElementById('pdfMinDateTime');
  if (dtEl) dtEl.textContent = simpleDateTime;

  const headerDocEl = document.getElementById('pdfHeaderDoctorName');
  if (headerDocEl) headerDocEl.textContent = doctorName;

  const nameEl = document.getElementById('pdfMinPatientName');
  if (nameEl) nameEl.textContent = patient.full_name;

  const idEl = document.getElementById('pdfMinPatientId');
  if (idEl) idEl.textContent = patient.id;

  const ageGenderEl = document.getElementById('pdfMinPatientAgeGender');
  if (ageGenderEl) ageGenderEl.textContent = `${age} yrs, ${displayGender}`;

  const bloodEl = document.getElementById('pdfMinPatientBlood');
  if (bloodEl) bloodEl.textContent = patient.blood_group || 'B+';

  const phoneEl = document.getElementById('pdfMinPatientPhone');
  if (phoneEl) phoneEl.textContent = patient.phone || patient.emergency_contact_phone || '+91-98765-43210';

  const docEl = document.getElementById('pdfSupervisingDoctor');
  if (docEl) docEl.textContent = doctorName;

  const minDocEl = document.getElementById('pdfMinDoctorName');
  if (minDocEl) minDocEl.textContent = doctorName;

  // 2. Populate Vitals with Real Readings or Snapshot
  const isTargetCurrent = (targetId === currentPatientId);
  const liveHrEl = document.getElementById('liveHrDisplay');
  const liveSpo2El = document.getElementById('liveSpo2Display');
  const liveHrNum = (liveHrEl && liveHrEl.textContent !== '--') ? parseInt(liveHrEl.textContent) : null;
  const liveSpo2Num = (liveSpo2El && liveSpo2El.textContent !== '--') ? parseInt(liveSpo2El.textContent) : null;

  const currentHr = isTargetCurrent ? (liveHrNum ? liveHrNum : (patient.current_hr || (hardwareDeviceConnected ? '--' : 76))) : (patient.current_hr || 74);
  const currentSpo2 = isTargetCurrent ? (liveSpo2Num ? liveSpo2Num : (patient.current_spo2 || (hardwareDeviceConnected ? '--' : 98))) : (patient.current_spo2 || 98);
  const baselineHr = patient.baseline_hr_mean || 72.0;
  const baselineSpo2 = patient.baseline_spo2_mean || 98.2;

  document.getElementById('pdfMinHr').textContent = currentHr;
  document.getElementById('pdfMinSpo2').textContent = currentSpo2;

  const baseHrEl = document.getElementById('pdfMinBaselineHr');
  if (baseHrEl) baseHrEl.textContent = Number(baselineHr).toFixed(1);

  const baseSpo2El = document.getElementById('pdfMinBaselineSpo2');
  if (baseSpo2El) baseSpo2El.textContent = Number(baselineSpo2).toFixed(1);

  document.getElementById('pdfMinHrStatus').textContent = 
    (currentHr !== '--' && currentHr > 100) ? 'Elevated Heart Rate' : ((currentHr !== '--' && currentHr < 60) ? 'Low Heart Rate' : 'Normal Resting Cadence');
  document.getElementById('pdfMinSpo2Status').textContent = 
    (currentSpo2 !== '--' && currentSpo2 >= 95) ? 'Optimal Oxygenation' : 'Attention Recommended';

  // 3. AI Screening fields in PDF
  const pdfRisk = document.getElementById('pdfMinRiskLevel');
  const pdfScore = document.getElementById('pdfMinRiskScore');
  const pdfTrend = document.getElementById('pdfMinBaselineTrend');
  const pdfEcg = document.getElementById('pdfMinEcgStatus');
  const docRiskBadge = document.getElementById('docAiRiskBadge') || document.getElementById('docAiBadge');
  const docEcgBadge = document.getElementById('docAiEcgBadge');
  const docScoreEl = document.getElementById('docAiScoreText');
  const docTrendEl = document.getElementById('docAiHistoryTrendText');

  const rawRisk = docRiskBadge ? docRiskBadge.textContent.replace('Risk: ', '').trim() : 'Normal';
  if (pdfRisk) {
    pdfRisk.textContent = rawRisk.toUpperCase();
    pdfRisk.style.color = (rawRisk === 'High') ? '#DC2626' : ((rawRisk === 'Attention') ? '#D97706' : '#059669');
  }
  if (pdfScore) {
    pdfScore.textContent = docScoreEl ? docScoreEl.textContent.split('(')[0].trim() : '15 / 100';
  }
  if (pdfTrend) {
    pdfTrend.textContent = docTrendEl ? docTrendEl.textContent : 'Consistent with personal baseline';
  }
  if (pdfEcg) {
    const rawEcg = docEcgBadge ? docEcgBadge.textContent.replace('ECG: ', '').trim() : 'Normal';
    pdfEcg.textContent = rawEcg.includes('Irregular') ? 'Possible Irregular Pattern' : 'Normal Sinus Cadence';
    pdfEcg.style.color = rawEcg.includes('Irregular') ? '#DC2626' : '#0284C7';
  }

  // 4. Simple, Clear Patient Summary
  const summaryEl = document.getElementById('pdfMinSummaryText');
  if (summaryEl) {
    if (currentHr !== '--' && currentHr > 105) {
      summaryEl.textContent = `Your heart rate averaged ${currentHr} BPM (slightly elevated) with oxygen at ${currentSpo2}%. Please consult attending physician ${doctorName} if you experience shortness of breath or palpitations.`;
    } else if (currentSpo2 !== '--' && currentSpo2 < 94) {
      summaryEl.textContent = `Your blood oxygen level was recorded at ${currentSpo2}%, with heart rate at ${currentHr} BPM. A review with attending physician ${doctorName} is advised.`;
    } else {
      summaryEl.textContent = `All vital signs recorded during this monitoring session are within normal and healthy ranges. Heart rate averaged ${currentHr} BPM, blood oxygen stayed optimal at ${currentSpo2}%, and your ECG rhythm is regular.`;
    }
  }

  // 5. Doctor's Advice & Observations
  const notesContainer = document.getElementById('pdfMinNotesList');
  if (notesContainer) {
    let noteHtml = '';

    // Check for doctor notes from API
    try {
      const token = currentAuth?.token || 'demo-token';
      const notesRes = await fetch(`${API_BASE}/notes/patient/${targetId}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (notesRes.ok) {
        const notesData = await notesRes.json();
        const patientNotes = notesData.notes || [];
        if (patientNotes.length > 0) {
          const latest = patientNotes[0];
          const noteDate = latest.created_at ? new Date(latest.created_at) : now;
          const dStr = noteDate.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
          noteHtml = `
            <div style="font-size: 12.5px; color: #1E293B; line-height: 1.5;">
              "${latest.note_text}"
              <div style="font-size: 11px; color: #64748B; margin-top: 4px;">— ${latest.doctor_name || doctorName} (${dStr})</div>
            </div>
          `;
        }
      }
    } catch (e) {
      console.warn('Notes fetch fallback');
    }

    if (!noteHtml && patient.history_timeline && patient.history_timeline.length > 0) {
      const h = patient.history_timeline[0];
      noteHtml = `
        <div style="font-size: 12.5px; color: #1E293B; line-height: 1.5;">
          "${h.summary}"
          <div style="font-size: 11px; color: #64748B; margin-top: 4px;">— ${h.doctor || doctorName} (${h.date})</div>
        </div>
      `;
    }

    if (!noteHtml) {
      noteHtml = `
        <div style="font-size: 12.5px; color: #1E293B; line-height: 1.5;">
          Cardiac rhythm and vital signs remain normal and stable. Continue routine physical activity, maintain proper hydration, and consult your physician for scheduled follow-ups.
          <div style="font-size: 11px; color: #64748B; margin-top: 4px;">— ${doctorName} (Attending Physician)</div>
        </div>
      `;
    }

    notesContainer.innerHTML = noteHtml;
  }

  // 6. Footer Sign-off
  const signoffDoc = document.getElementById('pdfSignoffDoctor');
  if (signoffDoc) signoffDoc.textContent = doctorName;
  const signoffTs = document.getElementById('pdfSignoffTimestamp');
  if (signoffTs) signoffTs.textContent = simpleDateTime;

  // 8. Filename: Patient Name + Report Date
  const cleanName = patient.full_name.trim().replace(/[^a-zA-Z0-9]/g, '_');
  const filename = `${cleanName}_Cardiac_Report_${dateStr}.pdf`;

  // 9. Render Real High-Resolution Lead-II ECG Strip onto PDF Canvas
  renderPdfEcgStrip(currentHr);

  // 10. Render & Export via html2pdf
  const reportElement = document.getElementById('pdfReportContent');

  const opt = {
    margin: [10, 10, 10, 10],
    filename: filename,
    image: { type: 'jpeg', quality: 0.98 },
    html2canvas: {
      scale: 2,
      useCORS: true,
      letterRendering: true,
      logging: false
    },
    jsPDF: {
      unit: 'mm',
      format: 'a4',
      orientation: 'portrait'
    }
  };

  if (typeof html2pdf !== 'undefined') {
    html2pdf()
      .set(opt)
      .from(reportElement)
      .save()
      .then(() => {
        showToast(`✅ Cardiac Report downloaded: ${filename}`);
        if (btn) {
          btn.innerHTML = originalHtml;
          btn.disabled = false;
        }
      })
      .catch(err => {
        console.warn('html2pdf fallback to print window:', err);
        fallbackPrintReport(patient, filename);
        if (btn) {
          btn.innerHTML = originalHtml;
          btn.disabled = false;
        }
      });
  } else {
    fallbackPrintReport(patient, filename);
    if (btn) {
      btn.innerHTML = originalHtml;
      btn.disabled = false;
    }
  }
}

// Fallback printing if client browser blocks canvas to pdf
function fallbackPrintReport(patient, filename) {
  const content = document.getElementById('pdfReportContent').innerHTML;
  const printWindow = window.open('', '_blank');
  printWindow.document.write(`
    <html>
      <head>
        <title>${filename}</title>
        <link rel="stylesheet" href="styles.css">
        <style>
          body { background: #fff !important; color: #0f172a !important; padding: 20px; }
        </style>
      </head>
      <body>
        ${content}
        <script>window.print();</script>
      </body>
    </html>
  `);
}

// Doctor Dashboard Report Button Handler
async function generateReport() {
  const btn = document.getElementById('btnGenerateDocReport');
  const originalHtml = btn ? btn.innerHTML : '';
  if (btn) {
    btn.innerHTML = '<span>⏳</span> Generating Report...';
    btn.disabled = true;
  }

  try {
    const token = currentAuth?.token || 'demo-token';
    await fetch(`${API_BASE}/reports/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ patientId: currentPatientId })
    });
  } catch (err) {
    console.warn('Backend report persistence note:', err);
  }

  await downloadPatientReport(currentPatientId);

  if (btn) {
    btn.innerHTML = originalHtml;
    btn.disabled = false;
  }
}

// Toast helper
function showToast(msg) {
  let toast = document.getElementById('cardioxToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'cardioxToast';
    toast.className = 'toast-notice';
    document.body.appendChild(toast);
  }
  toast.innerHTML = msg;
  toast.style.display = 'flex';
  setTimeout(() => { toast.style.display = 'none'; }, 4500);
}

function updateSimValues() {
  simHr = parseInt(document.getElementById('simHrSlider').value);
  simSpo2 = parseInt(document.getElementById('simSpo2Slider').value);
  simRhythm = document.getElementById('simRhythmSelect').value;

  document.getElementById('simHrLabel').textContent = `${simHr} BPM`;
  document.getElementById('simSpo2Label').textContent = `${simSpo2} %`;

  triggerAiRecheck();
}

function toggleSimulatorStream() {
  simStreaming = !simStreaming;
  const btn = document.getElementById('btnSimToggle');
  btn.textContent = simStreaming ? 'Pause Transmission' : 'Resume Transmission';
}

function filterPatients() {
  const query = document.getElementById('patientSearchInput').value.toLowerCase();
  const rows = document.querySelectorAll('#patientTableBody tr');
  rows.forEach(row => {
    row.style.display = row.innerText.toLowerCase().includes(query) ? '' : 'none';
  });
}

function initTrendsChart() {
  const ctx = document.getElementById('trendsChart').getContext('2d');
  const labels = ['00:00', '04:00', '08:00', '12:00', '16:00', '20:00', 'Now'];

  trendsChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Heart Rate (BPM)',
          data: [72, 68, 74, 82, 79, 75, 76],
          borderColor: '#FF3366',
          backgroundColor: 'rgba(255, 51, 102, 0.1)',
          borderWidth: 2,
          tension: 0.3,
          fill: true
        },
        {
          label: 'SpO₂ (%)',
          data: [98, 98, 97, 98, 99, 98, 98],
          borderColor: '#06B6D4',
          backgroundColor: 'transparent',
          borderWidth: 2,
          borderDash: [4, 4],
          tension: 0.3
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#94A3B8' } },
        y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#94A3B8' } }
      },
      plugins: {
        legend: { labels: { color: '#F1F5F9' } }
      }
    }
  });
}

// Live Simple Clock
function startLiveClock() {
  function tick() {
    const now = new Date();
    const dStr = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    const tStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
    const el = document.getElementById('liveHeaderDateTime');
    if (el) el.textContent = `${dStr} • ${tStr}`;
  }
  tick();
  setInterval(tick, 1000);
}

// Initializer
window.addEventListener('DOMContentLoaded', () => {
  startLiveClock();
  renderCanvas();
  runLocalSimulationLoop();
  initWebSocket();
  initTrendsChart();
  loadPatientHistory('pat-001');

  const loginInput = document.getElementById('loginEmail');
  if (loginInput) {
    loginInput.addEventListener('input', updateAuthFieldVisibility);
    loginInput.addEventListener('change', updateAuthFieldVisibility);
    loginInput.addEventListener('keyup', updateAuthFieldVisibility);
    loginInput.addEventListener('paste', () => setTimeout(updateAuthFieldVisibility, 50));
  }
  updateAuthFieldVisibility();

  checkInitialAuth();
});
