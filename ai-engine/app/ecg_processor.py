"""
ECG Signal Processing & Feature Extraction Module
Applies digital bandpass filtering, Pan-Tompkins QRS detection, and RR interval computation.
"""
from typing import List, Dict, Any
import numpy as np
from scipy import signal

def bandpass_filter(samples: np.ndarray, lowcut: float = 0.5, highcut: float = 40.0, fs: float = 250.0, order: int = 2) -> np.ndarray:
    """Applies a 2nd order Butterworth bandpass filter to isolate ECG bandwidth."""
    nyq = 0.5 * fs
    low = lowcut / nyq
    high = highcut / nyq
    b, a = signal.butter(order, [low, high], btype='band')
    return signal.filtfilt(b, a, samples)

def detect_r_peaks(filtered_ecg: np.ndarray, fs: float = 250.0) -> List[int]:
    """Finds R-peaks using derivative, squaring, and peak detection."""
    # Derivative
    diff = np.diff(filtered_ecg)
    # Squaring
    squared = diff ** 2
    # Moving window integrator (approx 120ms = 30 samples at 250Hz)
    window_size = int(0.12 * fs)
    kernel = np.ones(window_size) / window_size
    integrated = np.convolve(squared, kernel, mode='same')
    
    # Peak detection with refractory period (minimum 250ms between beats)
    min_distance = int(0.25 * fs)
    threshold = 0.35 * np.max(integrated) if np.max(integrated) > 0 else 1.0
    peaks, _ = signal.find_peaks(integrated, height=threshold, distance=min_distance)
    return peaks.tolist()

def process_ecg(samples: List[float], fs: float = 250.0) -> Dict[str, Any]:
    if not samples or len(samples) < int(fs * 2): # At least 2 seconds
        return {
            "r_peaks_count": 0,
            "estimated_hr": 0.0,
            "rr_intervals_ms": [],
            "hrv_rmssd": 0.0
        }
    
    raw = np.array(samples, dtype=float)
    filtered = bandpass_filter(raw, fs=fs)
    r_peaks = detect_r_peaks(filtered, fs=fs)
    
    if len(r_peaks) < 2:
        return {
            "r_peaks_count": len(r_peaks),
            "estimated_hr": 0.0,
            "rr_intervals_ms": [],
            "hrv_rmssd": 0.0
        }
    
    # Compute RR intervals in milliseconds
    rr_intervals = (np.diff(r_peaks) / fs) * 1000.0
    mean_rr = np.mean(rr_intervals)
    estimated_hr = 60000.0 / mean_rr if mean_rr > 0 else 0.0
    
    # HRV Metric (RMSSD)
    rmssd = float(np.sqrt(np.mean(np.diff(rr_intervals) ** 2))) if len(rr_intervals) > 1 else 0.0

    return {
        "r_peaks_count": len(r_peaks),
        "estimated_hr": round(float(estimated_hr), 1),
        "rr_intervals_ms": [round(float(x), 1) for x in rr_intervals],
        "hrv_rmssd": round(rmssd, 1)
    }
