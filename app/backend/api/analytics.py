"""FXR_V2_SPEC.md section 6 (G8): the manual-session Analytics page's own
aggregates (stat tiles, charts, heat, the RR simulator) and the prop-rules
modal's live status. Everything is read from the journal / PropRulesTracker; see
services/manual_analytics.py."""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException, Query

from app.backend import models
from app.backend.services import bt_session_service, manual_analytics
from app.backend.services.bundle_reader import RunNotFound

router = APIRouter(prefix="/api/manual-analytics", tags=["manual-analytics"])


@router.get("/{run_id}/summary", response_model=models.AnalyticsSummary)
def summary(run_id: str, instrument: Optional[str] = None) -> models.AnalyticsSummary:
    if not manual_analytics.is_manual_run_id(run_id):
        raise HTTPException(status_code=404, detail=f"{run_id!r} is not a manual scope")
    try:
        return manual_analytics.analytics_summary(run_id, instrument)
    except RunNotFound as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.get("/{run_id}/rr-simulator", response_model=models.RrSimulatorResponse)
def rr_simulator(run_id: str, instrument: Optional[str] = None) -> models.RrSimulatorResponse:
    if not manual_analytics.is_manual_run_id(run_id):
        raise HTTPException(status_code=404, detail=f"{run_id!r} is not a manual scope")
    try:
        return manual_analytics.rr_simulation(run_id, instrument)
    except RunNotFound as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.get("/sessions/{session_id}/prop-rules", response_model=models.PropRulesStatus)
def prop_rules(
    session_id: str,
    open_pnl: float = Query(0.0, description="the open position's float, from the sim broker"),
    cursor_time: Optional[int] = Query(None, description="the cursor the float was marked at (unix seconds)"),
) -> models.PropRulesStatus:
    try:
        return manual_analytics.prop_rules_status(session_id, open_pnl=open_pnl, cursor_time=cursor_time)
    except bt_session_service.SessionNotFound as e:
        raise HTTPException(status_code=404, detail=str(e))
    except manual_analytics.NotAPropSession:
        raise HTTPException(status_code=400, detail="not a prop session")
