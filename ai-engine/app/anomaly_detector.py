"""
Anomaly Detection & Attention Scoring Module
Calculates composite attention score (0 - 100) and triggers clinical attention flags.
"""
from typing import Dict, Any, List

def calculate_anomaly_attention(
    session_data: Dict[str, Any],
    baseline: Dict[str, Any],
    signal_quality: str = "GOOD"
) -> Dict[str, Any]:
    score = 10.0 # Nominal base score
    flags = []

    avg_hr = session_data.get("avg_hr", 75.0)
    max_hr = session_data.get("max_hr", 85.0)
    min_hr = session_data.get("min_hr", 65.0)
    avg_spo2 = session_data.get("avg_spo2", 98.0)
    min_spo2 = session_data.get("min_spo2", 96.0)

    b_hr_mean = baseline.get("hr_mean", 75.0)
    b_hr_std = baseline.get("hr_std", 8.0)

    # 1. Z-Score Deviation from baseline
    z_score = abs(avg_hr - b_hr_mean) / (b_hr_std or 8.0)
    if z_score > 2.5:
        score += 35.0
        flags.append(f"Significant HR divergence (+{z_score:.1f}σ from personal baseline)")
    elif z_score > 1.5:
        score += 20.0
        flags.append(f"Moderate HR divergence (+{z_score:.1f}σ from personal baseline)")

    # 2. Excursion thresholds
    if max_hr > 130.0:
        score += 25.0
        flags.append(f"Tachycardic rate event (Peak: {int(max_hr)} BPM)")
    elif min_hr < 50.0:
        score += 25.0
        flags.append(f"Bradycardic rate event (Low: {int(min_hr)} BPM)")

    # 3. SpO2 Oxygenation
    if min_spo2 < 90.0:
        score += 40.0
        flags.append(f"Significant desaturation event (Min SpO₂: {int(min_spo2)}%)")
    elif avg_spo2 < 94.0 or min_spo2 < 93.0:
        score += 20.0
        flags.append(f"Depressed oxygen saturation (Session Mean: {avg_spo2:.1f}%)")

    # 4. Signal Artifacts
    if signal_quality in ["POOR", "LEADS_OFF"]:
        score += 15.0
        flags.append("Lead artifact / signal degradation during acquisition")

    clamped_score = int(min(100, max(5, round(score))))

    # Map to clinical attention tiers
    if clamped_score >= 81:
        level = "VERY_HIGH"
    elif clamped_score >= 61:
        level = "HIGH"
    elif clamped_score >= 31:
        level = "MODERATE"
    else:
        level = "LOW"

    return {
        "attention_score": clamped_score,
        "attention_level": level,
        "z_score": round(z_score, 2),
        "flags": flags
    }
