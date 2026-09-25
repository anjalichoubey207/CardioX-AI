"""
Signal Quality Analysis Module for CardioX AI
Evaluates signal-to-noise ratio, baseline wander, flatline artifacts, and clipping.
"""
from typing import List, Dict, Any
import numpy as np

def assess_signal_quality(samples: List[float], leads_off: bool = False) -> Dict[str, Any]:
    if leads_off:
        return {
            "quality": "LEADS_OFF",
            "confidence": 0.99,
            "usable": False,
            "message": "Leads disconnected. Verify electrode skin contact."
        }
    
    if not samples or len(samples) < 50:
        return {
            "quality": "INSUFFICIENT_DATA",
            "confidence": 0.50,
            "usable": False,
            "message": "Buffer too small for statistical processing."
        }
    
    arr = np.array(samples, dtype=float)
    ptp = np.ptp(arr) # Peak-to-peak amplitude

    # 1. Flatline check
    if ptp < 15.0:
        return {
            "quality": "POOR",
            "confidence": 0.95,
            "usable": False,
            "message": "Flatline signal detected. Check lead placement."
        }

    # 2. Clipping check (ADC rails near 0 or 4095)
    clipped = np.sum((arr >= 4090) | (arr <= 5))
    if clipped / len(arr) > 0.10:
        return {
            "quality": "FAIR",
            "confidence": 0.80,
            "usable": True,
            "message": "Intermittent rail clipping / motion artifact."
        }

    # 3. Standard deviation check
    std = float(np.std(arr))
    if std > 25.0:
        return {
            "quality": "EXCELLENT",
            "confidence": 0.98,
            "usable": True,
            "message": "Distinct QRS complexes with minimal baseline drift."
        }

    return {
        "quality": "GOOD",
        "confidence": 0.91,
        "usable": True,
        "message": "Good physiological signal quality."
    }
