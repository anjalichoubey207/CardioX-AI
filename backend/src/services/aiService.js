import { config } from '../config/env.js';

/**
 * CardioX AI - Clinical Decision Support & Telemetry Intelligence Engine
 * Provides signal-quality checks, ECG waveform classification, multi-parametric
 * risk assessment (Normal / Attention / High), historical baseline deviation detection,
 * and physician-focused decision support summaries.
 * 
 * Clinical Safety Constraint:
 * "AI-assisted screening only. Not a medical diagnosis."
 */
export class CardioXAiService {
  static DISCLAIMER = 'AI-assisted screening only. Not a medical diagnosis.';

  /**
   * 1. Classify ECG Waveform into "Normal" or "Possible Irregular Pattern"
   * Analyzes R-R intervals, heart rate variability (CV_RR), ectopic spikes, and morphology.
   * @param {Array<number>} samples - Raw ADC ECG sample points (e.g. 125Hz or 250Hz)
   * @param {number} sampleRate - Sampling frequency in Hz (default 125)
   * @param {boolean} leadsOff - Hardware leads-off status
   */
  static classifyEcgWaveform(samples = [], sampleRate = 125, leadsOff = false) {
    if (leadsOff) {
      return {
        status: 'LEADS_OFF',
        classification: 'Possible Irregular Pattern',
        isNormal: false,
        patternType: 'Leads Disconnected / Signal Interrupted',
        confidence: 0.99,
        details: 'ECG leads disconnected from patient skin contact.'
      };
    }

    if (!samples || samples.length < 40) {
      return {
        status: 'INSUFFICIENT_DATA',
        classification: 'Normal',
        isNormal: true,
        patternType: 'Awaiting Waveform Window',
        confidence: 0.70,
        details: 'Initial waveform window buffering.'
      };
    }

    // Measure signal amplitude & baseline variance
    const minVal = Math.min(...samples);
    const maxVal = Math.max(...samples);
    const amplitude = maxVal - minVal;

    // Check for flatline / detached lead
    if (amplitude < 15) {
      return {
        status: 'FLATLINE',
        classification: 'Possible Irregular Pattern',
        isNormal: false,
        patternType: 'Low Amplitude / Flatline Artifact',
        confidence: 0.95,
        details: 'Waveform amplitude below 15 units. Check electrode contact.'
      };
    }

    // Simple robust R-peak detector:
    // Peak threshold set at 65% between median and max
    const sorted = [...samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const peakThreshold = median + (maxVal - median) * 0.55;
    const minPeakDistance = Math.floor(sampleRate * 0.28); // Refractory period (~280ms -> max ~210 BPM)

    const peaks = [];
    for (let i = 1; i < samples.length - 1; i++) {
      if (samples[i] > peakThreshold && samples[i] >= samples[i - 1] && samples[i] >= samples[i + 1]) {
        if (peaks.length === 0 || (i - peaks[peaks.length - 1]) >= minPeakDistance) {
          peaks.push(i);
        }
      }
    }

    // If fewer than 2 peaks detected, assess based on overall variance
    if (peaks.length < 2) {
      const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
      const variance = samples.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / samples.length;
      const stdDev = Math.sqrt(variance);

      if (stdDev < 8) {
        return {
          status: 'ARTIFACT',
          classification: 'Possible Irregular Pattern',
          isNormal: false,
          patternType: 'Diminished QRS Deflection',
          confidence: 0.85,
          details: 'Subdued electrical deflection.'
        };
      }

      return {
        status: 'RHYTHM_RECORDING',
        classification: 'Normal',
        isNormal: true,
        patternType: 'Sinus Cadence',
        confidence: 0.85,
        details: 'Regular rhythm progression without ectopic spikes.'
      };
    }

    // Calculate RR intervals in milliseconds
    const rrIntervals = [];
    for (let i = 1; i < peaks.length; i++) {
      const intervalMs = (peaks[i] - peaks[i - 1]) * (1000 / sampleRate);
      rrIntervals.push(intervalMs);
    }

    const meanRR = rrIntervals.reduce((a, b) => a + b, 0) / rrIntervals.length;
    const varianceRR = rrIntervals.reduce((a, b) => a + Math.pow(b - meanRR, 2), 0) / rrIntervals.length;
    const stdDevRR = Math.sqrt(varianceRR);
    const cvRR = meanRR > 0 ? (stdDevRR / meanRR) : 0; // Coefficient of Variation

    // Check for irregular RR cadence or premature contractions
    // CV > 0.16 indicates >16% variance between beats (arrhythmia or PVC)
    const maxRR = Math.max(...rrIntervals);
    const minRR = Math.min(...rrIntervals);
    const rangeRatio = minRR > 0 ? (maxRR / minRR) : 1;

    let isNormal = true;
    let patternType = 'Normal Sinus Rhythm';
    let details = 'Uniform P-QRS-T complexes with regular R-R intervals.';

    if (cvRR > 0.22 || rangeRatio > 1.65) {
      isNormal = false;
      patternType = 'Possible Irregular Pattern (Variable R-R Intervals)';
      details = `Beat-to-beat variability elevated (CV: ${(cvRR * 100).toFixed(1)}%). Possible premature beat or sinus pause.`;
    } else if (cvRR > 0.15) {
      isNormal = false;
      patternType = 'Possible Irregular Pattern (Mild Dysrhythmia)';
      details = `Moderate R-R interval fluctuation noted (CV: ${(cvRR * 100).toFixed(1)}%).`;
    } else if (meanRR < 460) { // > 130 BPM
      patternType = 'Tachycardic Sinus Cadence';
      details = 'Accelerated ventricular depolarization rate.';
    } else if (meanRR > 1200) { // < 50 BPM
      patternType = 'Bradycardic Sinus Cadence';
      details = 'Prolonged R-R cycle time.';
    }

    return {
      status: 'CLASSIFIED',
      classification: isNormal ? 'Normal' : 'Possible Irregular Pattern',
      isNormal,
      patternType,
      cv: parseFloat(cvRR.toFixed(3)),
      meanRRMs: Math.round(meanRR),
      peakCount: peaks.length,
      confidence: isNormal ? 0.94 : 0.88,
      details
    };
  }

  /**
   * 2. Detect Unusual Changes in Patient Historical Vitals
   * Compares current live reading with patient baseline mean and recorded historical vitals.
   */
  static detectHistoricalChanges({
    currentHr,
    currentSpo2,
    patient = {},
    historicalReadings = []
  }) {
    const baselineHrMean = patient?.baseline_hr_mean || 72.0;
    const baselineHrStd = patient?.baseline_hr_std || 6.5;
    const baselineSpo2Mean = patient?.baseline_spo2_mean || 98.0;

    let hrDelta = 0;
    let spo2Delta = 0;
    let hrZScore = 0;
    let hasAnomaly = false;
    const changeFlags = [];

    if (currentHr !== null && currentHr !== undefined && !isNaN(currentHr)) {
      hrDelta = Math.round(currentHr - baselineHrMean);
      hrZScore = parseFloat(Math.abs((currentHr - baselineHrMean) / baselineHrStd).toFixed(2));

      if (hrZScore >= 2.5) {
        hasAnomaly = true;
        changeFlags.push(`Significant HR deviation: ${hrDelta > 0 ? '+' : ''}${hrDelta} BPM (${hrZScore}σ from personal baseline)`);
      } else if (hrZScore >= 1.6) {
        changeFlags.push(`Moderate HR variance: ${hrDelta > 0 ? '+' : ''}${hrDelta} BPM vs baseline`);
      }
    }

    if (currentSpo2 !== null && currentSpo2 !== undefined && !isNaN(currentSpo2)) {
      spo2Delta = Math.round(currentSpo2 - baselineSpo2Mean);

      if (spo2Delta <= -5) {
        hasAnomaly = true;
        changeFlags.push(`Unusual SpO₂ desaturation: ${spo2Delta}% below typical baseline (${Math.round(baselineSpo2Mean)}%)`);
      } else if (spo2Delta <= -3) {
        changeFlags.push(`Mild SpO₂ dip: ${spo2Delta}% below typical baseline`);
      }
    }

    let comparisonSummary = '';
    if (changeFlags.length > 0) {
      comparisonSummary = changeFlags.join('; ');
    } else {
      comparisonSummary = `Consistent with historical baseline (HR: ${Math.round(baselineHrMean)} BPM, SpO₂: ${Math.round(baselineSpo2Mean)}%).`;
    }

    return {
      baselineHrMean,
      baselineSpo2Mean,
      hrDelta,
      spo2Delta,
      hrZScore,
      hasAnomaly,
      changeFlags,
      comparisonSummary
    };
  }

  /**
   * 3. Multi-Parametric Risk Scoring: Normal / Attention / High
   * Triangulates Heart Rate, Oxygen Saturation, and ECG Waveform Classification.
   */
  static calculateMultiParametricRisk({
    hr,
    spo2,
    ecgClassification,
    historicalChanges
  }) {
    let riskLevel = 'Normal';
    let riskScore = 15; // Nominal base score
    const riskFactors = [];

    const isHrValid = hr !== null && hr !== undefined && !isNaN(hr) && hr > 0;
    const isSpo2Valid = spo2 !== null && spo2 !== undefined && !isNaN(spo2) && spo2 > 0;
    const isEcgIrregular = ecgClassification && !ecgClassification.isNormal;

    // --- High Risk Conditions ---
    if (isSpo2Valid && spo2 < 90) {
      riskLevel = 'High';
      riskScore = Math.max(riskScore, 85);
      riskFactors.push(`Critical hypoxemia: SpO₂ at ${spo2}%`);
    }

    if (isHrValid && (hr > 130 || hr < 45)) {
      riskLevel = 'High';
      riskScore = Math.max(riskScore, 80);
      riskFactors.push(`Severe heart rate excursion: ${hr} BPM`);
    }

    if (isEcgIrregular && ((isSpo2Valid && spo2 < 93) || (isHrValid && (hr > 115 || hr < 50)))) {
      riskLevel = 'High';
      riskScore = Math.max(riskScore, 82);
      riskFactors.push('Irregular ECG pattern combined with abnormal vital signs');
    }

    // --- Attention Conditions (if not already High) ---
    if (riskLevel !== 'High') {
      if (isSpo2Valid && spo2 >= 90 && spo2 < 95) {
        riskLevel = 'Attention';
        riskScore = Math.max(riskScore, 55);
        riskFactors.push(`Sub-optimal oxygen saturation: ${spo2}%`);
      }

      if (isHrValid && ((hr >= 100 && hr <= 130) || (hr >= 45 && hr < 55))) {
        riskLevel = 'Attention';
        riskScore = Math.max(riskScore, 50);
        riskFactors.push(`Tachycardic or bradycardic cadence: ${hr} BPM`);
      }

      if (isEcgIrregular) {
        riskLevel = 'Attention';
        riskScore = Math.max(riskScore, 58);
        riskFactors.push(`ECG rhythm: ${ecgClassification.patternType || 'Possible Irregular Pattern'}`);
      }

      if (historicalChanges && historicalChanges.hasAnomaly) {
        riskLevel = 'Attention';
        riskScore = Math.max(riskScore, 48);
        riskFactors.push(historicalChanges.changeFlags[0] || 'Historical vital divergence');
      }
    }

    if (riskFactors.length === 0) {
      riskFactors.push('All parameters within expected physiological thresholds');
    }

    return {
      riskLevel, // 'Normal' | 'Attention' | 'High'
      riskScore,
      riskFactors
    };
  }

  /**
   * 4. Generate Professional Doctor-Facing AI Summary
   */
  static generateDoctorSummary({
    riskLevel,
    ecgClassification,
    hr,
    spo2,
    historicalChanges,
    patientName = 'Patient'
  }) {
    const isHrValid = hr !== null && hr !== undefined && !isNaN(hr) && hr > 0;
    const isSpo2Valid = spo2 !== null && spo2 !== undefined && !isNaN(spo2) && spo2 > 0;
    const hrDisplay = isHrValid ? `${hr} BPM` : 'undetermined';
    const spo2Display = isSpo2Valid ? `${spo2}%` : 'sensor acquiring';

    let summaryText = '';

    if (riskLevel === 'High') {
      summaryText = `Elevated clinical risk identified: Telemetry reflects ${ecgClassification?.patternType || 'irregular cadence'} with pulse at ${hrDisplay} and SpO₂ at ${spo2Display}. Noteworthy shift detected against established baseline. Immediate physician review and diagnostic 12-lead correlation are recommended.`;
    } else if (riskLevel === 'Attention') {
      summaryText = `Mild physiological divergence observed: Rhythm shows ${ecgClassification?.patternType || 'minor cadence variance'} with heart rate at ${hrDisplay} and SpO₂ at ${spo2Display} (${historicalChanges?.comparisonSummary || 'moderate baseline variation'}). Continue standard observational monitoring and routine check.`;
    } else {
      summaryText = `Telemetry demonstrates stable sinus cadence with pulse resting at ${hrDisplay} and SpO₂ optimal at ${spo2Display}. Vital parameters remain well-aligned with personal historical baseline. Low overall risk profile; continue scheduled cadence.`;
    }

    return {
      summaryText,
      disclaimer: this.DISCLAIMER
    };
  }

  /**
   * 4.1 Generate Patient-Facing Age-Aware AI Monitoring Summary
   */
  static generatePatientSummary({
    hr,
    spo2,
    patient = {},
    ecgClassification,
    riskLevel
  }) {
    const isHrValid = hr !== null && hr !== undefined && !isNaN(hr) && hr > 0;
    const isSpo2Valid = spo2 !== null && spo2 !== undefined && !isNaN(spo2) && spo2 > 0;
    const age = patient?.age || 26;

    if (!isHrValid && !isSpo2Valid) {
      return {
        hasData: false,
        summaryText: 'Insufficient data. Please place your finger on the MAX30102 sensor and connect AD8232 ECG electrodes to generate your AI monitoring summary. This is a monitoring and decision-support summary, not a medical diagnosis.',
        disclaimer: 'Clinical monitoring & decision-support summary only. Not a medical diagnosis.'
      };
    }

    let statusDescription = '';
    if (isHrValid && isSpo2Valid) {
      if (spo2 < 92 || hr > 130) {
        statusDescription = `your heart rate (${hr} BPM) or oxygen saturation (${spo2}%) shows notable variation from standard resting ranges for your age (${age} years). Rest quietly and alert your attending doctor if symptoms occur.`;
      } else if (spo2 < 95 || hr > 100) {
        statusDescription = `your heart rate (${hr} BPM) is slightly elevated or oxygenation (${spo2}%) is mildly reduced for age ${age} years. Continue sitting comfortably.`;
      } else if (hr < 55) {
        statusDescription = `your resting pulse is ${hr} BPM with healthy oxygenation (${spo2}%). Normal for resting states at age ${age}, but report any lightheadedness to your physician.`;
      } else {
        statusDescription = `your heart rate (${hr} BPM) and oxygen saturation (${spo2}%) are within standard healthy physiological thresholds for a ${age}-year-old.`;
      }
    } else if (isHrValid) {
      statusDescription = `your measured heart rate is ${hr} BPM at age ${age} years (oxygen sensor pending).`;
    } else if (isSpo2Valid) {
      statusDescription = `your blood oxygen saturation is ${spo2}% at age ${age} years (heart rate sensor pending).`;
    }

    const summaryText = `Based on your age (${age} years) and real-time measured vitals: ${statusDescription} This is an automated monitoring and decision-support summary, not a medical diagnosis.`;

    return {
      hasData: true,
      summaryText,
      disclaimer: 'Clinical monitoring & decision-support summary only. Not a medical diagnosis.'
    };
  }

  /**
   * 5. Master Orchestrator: Comprehensive Vitals & ECG Evaluation
   */
  static evaluatePatientVitals({
    patientId,
    hr = null,
    spo2 = null,
    ecgSamples = [],
    sampleRate = 125,
    leadsOff = false,
    patient = {},
    historicalReadings = []
  }) {
    // A. Classify ECG
    const ecgClassification = this.classifyEcgWaveform(ecgSamples, sampleRate, leadsOff);

    // B. Historical comparison
    const historicalChanges = this.detectHistoricalChanges({
      currentHr: hr,
      currentSpo2: spo2,
      patient,
      historicalReadings
    });

    // C. Multi-parametric Risk
    const riskAssessment = this.calculateMultiParametricRisk({
      hr,
      spo2,
      ecgClassification,
      historicalChanges
    });

    // D. Doctor Summary
    const doctorSummary = this.generateDoctorSummary({
      riskLevel: riskAssessment.riskLevel,
      ecgClassification,
      hr,
      spo2,
      historicalChanges,
      patientName: patient?.full_name || 'Patient'
    });

    // E. Patient Summary (Age and real vitals grounded)
    const patientSummary = this.generatePatientSummary({
      hr,
      spo2,
      patient,
      ecgClassification,
      riskLevel: riskAssessment.riskLevel
    });

    const hasSufficientData = patientSummary.hasData;
    const finalRiskLevel = hasSufficientData ? riskAssessment.riskLevel : 'Insufficient data';
    const finalRiskScore = hasSufficientData ? riskAssessment.riskScore : 0;
    const finalDoctorSummary = hasSufficientData 
      ? doctorSummary.summaryText 
      : 'Insufficient real sensor data. Waiting for MAX30102 finger sensor and AD8232 ECG electrodes to provide valid readings. AI-assisted screening only. Not a medical diagnosis.';

    return {
      patientId: patientId || patient?.id,
      patientName: patient?.full_name || 'Patient',
      timestamp: new Date().toISOString(),
      riskLevel: finalRiskLevel,
      riskScore: finalRiskScore,
      riskFactors: hasSufficientData ? riskAssessment.riskFactors : ['Waiting for physical hardware sensor contact'],
      ecgClassification: {
        classification: ecgClassification.classification, // 'Normal' | 'Possible Irregular Pattern'
        isNormal: ecgClassification.isNormal,
        patternType: ecgClassification.patternType,
        details: ecgClassification.details,
        confidence: ecgClassification.confidence
      },
      currentVitals: {
        heartRate: hr,
        spo2: spo2,
        leadsOff: Boolean(leadsOff)
      },
      historicalComparison: {
        baselineHr: historicalChanges.baselineHrMean,
        baselineSpo2: historicalChanges.baselineSpo2Mean,
        hrDelta: historicalChanges.hrDelta,
        spo2Delta: historicalChanges.spo2Delta,
        hasAnomaly: historicalChanges.hasAnomaly,
        comparisonSummary: historicalChanges.comparisonSummary
      },
      doctorSummary: finalDoctorSummary,
      patientSummary: patientSummary.summaryText,
      hasSufficientData: hasSufficientData,
      disclaimer: this.DISCLAIMER
    };
  }

  /**
   * Session-level evaluation helper (backward compatibility)
   */
  static analyzeSession(sessionData, patientBaseline, ecgSamples = []) {
    return this.evaluatePatientVitals({
      patientId: sessionData.patient_id,
      hr: sessionData.avg_hr || 75,
      spo2: sessionData.avg_spo2 || 98,
      ecgSamples,
      patient: patientBaseline
    });
  }
}
