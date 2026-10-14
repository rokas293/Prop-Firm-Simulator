"""Autopilot (FXR_V2_SPEC.md section 8, G10a): which strategy configs can run, and
switching it on/off for a session. The bot itself advances with the cursor
(PATCH /api/bt-sessions/{id}/cursor), not through its own polling endpoint."""
from __future__ import annotations

from typing import List

from fastapi import APIRouter, HTTPException

from app.backend import models
from app.backend.services import autopilot_service, bt_session_service

router = APIRouter(tags=["autopilot"])


@router.get("/api/autopilot/configs", response_model=List[models.AutopilotConfigInfo])
def list_configs() -> List[models.AutopilotConfigInfo]:
    return autopilot_service.list_configs()


@router.post("/api/bt-sessions/{session_id}/autopilot", response_model=models.BacktestSessionDetail)
def set_autopilot(session_id: str, req: models.SetAutopilotRequest) -> models.BacktestSessionDetail:
    try:
        return autopilot_service.set_enabled(session_id, req)
    except bt_session_service.SessionNotFound as e:
        raise HTTPException(status_code=404, detail=str(e))
    except bt_session_service.InvalidSessionRequest as e:
        raise HTTPException(status_code=400, detail=str(e))
