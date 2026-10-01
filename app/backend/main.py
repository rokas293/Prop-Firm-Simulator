"""FastAPI app (VIZ_SPEC.md section 1). Run with:
    uvicorn app.backend.main:app --reload --port 8000
"""
from __future__ import annotations

from fastapi import FastAPI

from app.backend.api import bars, bt_sessions, compass, daily_risk, equity, export, indicators, monte_carlo, runs, sessions, stats, trades

app = FastAPI(title="propbt viz backend", version="0.1.0")

app.include_router(runs.router)
app.include_router(trades.router)
app.include_router(equity.router)
app.include_router(stats.router)
app.include_router(bars.router)
app.include_router(sessions.router)
app.include_router(daily_risk.router)
app.include_router(indicators.router)
app.include_router(export.router)
app.include_router(compass.router)
app.include_router(monte_carlo.router)
app.include_router(bt_sessions.router)


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok"}
