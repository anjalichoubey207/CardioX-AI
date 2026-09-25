import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Primary path: CardioX-AI/data/patient_readings.csv
// Secondary path: CardioX-AI/backend/data/patient_readings.csv
const projectRoot = path.resolve(__dirname, '../../../');
const dataDir = path.join(projectRoot, 'data');
const csvFilePath = path.join(dataDir, 'patient_readings.csv');

const backendDataDir = path.resolve(__dirname, '../../data');
const backendCsvFilePath = path.join(backendDataDir, 'patient_readings.csv');

const CSV_HEADER = 'Date,Time,Patient ID,Patient Name,Heart Rate (BPM),SpO2 (%),ECG Signal (ADC)\r\n';

class ReadingsLogger {
  constructor() {
    this.ensureDirectoryAndHeader();
  }

  ensureDirectoryAndHeader() {
    try {
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      if (!fs.existsSync(backendDataDir)) {
        fs.mkdirSync(backendDataDir, { recursive: true });
      }

      // If project CSV does not exist, initialize with header + UTF-8 BOM for Excel compatibility
      if (!fs.existsSync(csvFilePath)) {
        fs.writeFileSync(csvFilePath, '\uFEFF' + CSV_HEADER, 'utf8');
      }

      if (!fs.existsSync(backendCsvFilePath)) {
        fs.writeFileSync(backendCsvFilePath, '\uFEFF' + CSV_HEADER, 'utf8');
      }
    } catch (err) {
      console.error('[ReadingsLogger] Error ensuring CSV file existence:', err.message);
    }
  }

  /**
   * Append real hardware sensor readings to CSV
   * @param {Object} entry 
   */
  logReading({ patientId, patientName, heartRate, spo2, ecgSamples, timestamp }) {
    try {
      const now = timestamp ? new Date(timestamp) : new Date();
      
      // Format Date: YYYY-MM-DD
      const dateStr = now.toISOString().slice(0, 10);
      
      // Format Time: HH:MM:SS
      const hours = String(now.getHours()).padStart(2, '0');
      const mins = String(now.getMinutes()).padStart(2, '0');
      const secs = String(now.getSeconds()).padStart(2, '0');
      const timeStr = `${hours}:${mins}:${secs}`;

      const safePatientId = (patientId || 'pat-001').replace(/,/g, '');
      const safePatientName = (patientName || 'Unknown Patient').replace(/,/g, '');
      const hrVal = (heartRate && heartRate > 0) ? Math.round(heartRate) : '';
      const spo2Val = (spo2 && spo2 > 0) ? Math.round(spo2) : '';

      let rows = '';

      if (Array.isArray(ecgSamples) && ecgSamples.length > 0) {
        // Record samples with millisecond timing for Excel waveform charting
        const sampleCount = ecgSamples.length;
        const dtMs = sampleCount > 1 ? Math.floor(200 / sampleCount) : 0;
        
        for (let i = 0; i < sampleCount; i++) {
          const sampleMs = (now.getMilliseconds() + (i * dtMs)) % 1000;
          const exactTime = `${timeStr}.${String(sampleMs).padStart(3, '0')}`;
          const ecgVal = Math.round(ecgSamples[i]);
          rows += `${dateStr},${exactTime},${safePatientId},"${safePatientName}",${hrVal},${spo2Val},${ecgVal}\r\n`;
        }
      } else {
        rows = `${dateStr},${timeStr},${safePatientId},"${safePatientName}",${hrVal},${spo2Val},\r\n`;
      }

      if (rows.length > 0) {
        fs.appendFileSync(csvFilePath, rows, 'utf8');
        try {
          fs.appendFileSync(backendCsvFilePath, rows, 'utf8');
        } catch (_) {}
      }
    } catch (err) {
      console.error('[ReadingsLogger] Failed to append reading to CSV:', err.message);
    }
  }

  getFilePath() {
    return csvFilePath;
  }

  getContent() {
    if (fs.existsSync(csvFilePath)) {
      return fs.readFileSync(csvFilePath, 'utf8');
    }
    return CSV_HEADER;
  }
}

export const readingsLogger = new ReadingsLogger();
export default readingsLogger;
