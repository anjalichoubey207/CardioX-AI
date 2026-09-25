"""
Patient Baseline Manager
Computes longitudinal patient baseline patterns and adapts cautiously (10% learning rate).
"""
from typing import Dict, Any, List
import numpy as np

class BaselineManager:
    @staticmethod
    def compute_initial_baseline(sessions: List[Dict[str, Any]]) -> Dict[str, Any]:
        """Calculates baseline from historical sessions. Minimum 3 sessions required."""
        if len(sessions) < 3:
            return {
                "established": False,
                "sessions_count": len(sessions),
                "hr_mean": 75.0, # Population fallback
                "hr_std": 8.0,
                "spo2_mean": 98.0
            }
        
        hrs = [s.get("avg_hr", 75.0) for s in sessions if s.get("avg_hr")]
        spo2s = [s.get("avg_spo2", 98.0) for s in sessions if s.get("avg_spo2")]
        
        return {
            "established": True,
            "sessions_count": len(sessions),
            "hr_mean": round(float(np.mean(hrs)), 1),
            "hr_std": round(float(np.std(hrs)), 1) if np.std(hrs) > 2.0 else 5.0,
            "spo2_mean": round(float(np.mean(spo2s)), 1)
        }
    
    @staticmethod
    def update_baseline_cautiously(current_baseline: Dict[str, Any], new_session: Dict[str, Any], alpha: float = 0.10) -> Dict[str, Any]:
        """Cautious Exponential Moving Average update (10% weight) so sudden anomalies do not warp normal baseline."""
        if not current_baseline.get("established", False):
            return current_baseline
        
        new_hr = new_session.get("avg_hr", current_baseline["hr_mean"])
        new_spo2 = new_session.get("avg_spo2", current_baseline["spo2_mean"])
        
        updated_hr_mean = (1 - alpha) * current_baseline["hr_mean"] + alpha * new_hr
        updated_spo2_mean = (1 - alpha) * current_baseline["spo2_mean"] + alpha * new_spo2

        return {
            "established": True,
            "hr_mean": round(updated_hr_mean, 1),
            "hr_std": current_baseline["hr_std"],
            "spo2_mean": round(updated_spo2_mean, 1)
        }
