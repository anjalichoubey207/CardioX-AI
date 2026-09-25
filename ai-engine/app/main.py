"""
CardioX AI Microservice - FastAPI Entry Point
Exposes REST endpoints for telemetry processing, signal quality assessment, and session evaluation.
"""
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import List, Optional, Dict, Any

from app.signal_quality import assess_signal_quality
from app.ecg_processor import process_ecg
from app.anomaly_detector import calculate_anomaly_attention
from app.summary_generator import generate_summary, MANDATORY_DISCLAIMER

app = FastAPI(
    title="CardioX AI Clinical Decision Support Engine",
    version="1.0.0",
    description="Microservice for ECG filtering, signal quality analysis, baseline deviations, and attention scoring."
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class SessionAnalysisRequest(BaseModel):
    sessionId: str
    patientId: str
    avgHr: float
    minHr: float
    maxHr: float
    avgSpo2: float
    minSpo2: float
    baselineHrMean: Optional[float] = 75.0
    baselineHrStd: Optional[float] = 8.0
    baselineSpo2Mean: Optional[float] = 98.0
    ecgSamples: Optional[List[float]] = Field(default_factory=list)
    leadsOff: Optional[bool] = False

@app.get("/health")
def health_check():
    return {
        "status": "HEALTHY",
        "service": "CardioX AI Python Inference Engine",
        "version": "1.0.0",
        "disclaimer": MANDATORY_DISCLAIMER
    }

@app.post("/analyze")
def analyze_session(req: SessionAnalysisRequest):
    # 1. Evaluate Signal Quality
    signal_res = assess_signal_quality(req.ecgSamples, leads_off=req.leadsOff)
    
    # 2. Extract ECG Features (Pan-Tompkins)
    ecg_features = process_ecg(req.ecgSamples) if req.ecgSamples else {}

    # 3. Anomaly & Attention Scoring
    baseline = {
        "hr_mean": req.baselineHrMean,
        "hr_std": req.baselineHrStd,
        "spo2_mean": req.baselineSpo2Mean
    }
    
    session_data = {
        "avg_hr": req.avgHr,
        "min_hr": req.minHr,
        "max_hr": req.maxHr,
        "avg_spo2": req.avgSpo2,
        "min_spo2": req.minSpo2
    }
    
    attention_res = calculate_anomaly_attention(session_data, baseline, signal_quality=signal_res["quality"])

    # 4. Generate Non-diagnostic clinical summary
    narrative = generate_summary(
        attention_level=attention_res["attention_level"],
        avg_hr=req.avgHr,
        avg_spo2=req.avgSpo2,
        flags=attention_res["flags"]
    )

    return {
        "sessionId": req.sessionId,
        "patientId": req.patientId,
        "attentionScore": attention_res["attention_score"],
        "attentionLevel": attention_res["attention_level"],
        "signalQuality": signal_res["quality"],
        "signalConfidence": signal_res["confidence"],
        "ecgFeatures": ecg_features,
        "observedPatterns": attention_res["flags"],
        "summary": narrative["summary"],
        "disclaimer": narrative["disclaimer"]
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
