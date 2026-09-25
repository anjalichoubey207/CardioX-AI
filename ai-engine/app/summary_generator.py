"""
Clinical Decision Support Summary Generator
Generates patient-accessible and doctor-informative monitoring observations with strict medical disclaimers.
"""
from typing import Dict, Any

MANDATORY_DISCLAIMER = "This is AI-assisted monitoring support and not a medical diagnosis. Consult a qualified physician for clinical care."

def generate_summary(
    attention_level: str,
    avg_hr: float,
    avg_spo2: float,
    flags: list
) -> Dict[str, str]:
    if attention_level == "LOW":
        summary = (
            f"Your vital signs were generally consistent with your recent baseline during this monitoring period. "
            f"Average heart rate was {round(avg_hr)} BPM and SpO₂ maintained at {round(avg_spo2)}%. "
            f"No notable deviations from your normal personal pattern were detected."
        )
    elif attention_level == "MODERATE":
        summary = (
            f"Your vitals showed slight variance from your established baseline with an average heart rate of {round(avg_hr)} BPM. "
            f"Measurements diverged moderately but remained within expected daytime variability ranges. "
            f"Routine continuing observation is recommended."
        )
    else:
        summary = (
            f"Monitoring observed notable deviations from your typical resting baseline during this session. "
            f"Sustained variations in heart rate or oxygen saturation were recorded. "
            f"Your attending physician has access to these metrics for timely clinical review."
        )

    return {
        "summary": summary,
        "disclaimer": MANDATORY_DISCLAIMER
    }
