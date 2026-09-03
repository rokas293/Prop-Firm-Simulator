from __future__ import annotations

from typing import List

from fastapi import APIRouter, HTTPException

from app.backend import models
from app.backend.services import bt_session_service

# Routed under /api/bt-sessions, not /api/sessions -- that prefix already
# means "trading-session windows" (see api/sessions.py, models.SessionWindow),
# an unrelated concept from FXR_SPEC's BacktestSession.
router = APIRouter(prefix="/api/bt-sessions", tags=["bt-sessions"])


@router.post("", response_model=models.BacktestSessionDetail)
def create_session(req: models.CreateSessionRequest) -> models.BacktestSessionDetail:
    try:
        return bt_session_service.create_session(req)
    except bt_session_service.InvalidSessionRequest as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("", response_model=List[models.BacktestSessionSummary])
def list_sessions(include_archived: bool = False) -> List[models.BacktestSessionSummary]:
    return bt_session_service.list_sessions(include_archived=include_archived)


@router.get("/{session_id}", response_model=models.BacktestSessionDetail)
def get_session(session_id: str) -> models.BacktestSessionDetail:
    try:
        return bt_session_service.get_session(session_id)
    except bt_session_service.SessionNotFound as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.patch("/{session_id}/cursor", response_model=models.BacktestSessionDetail)
def update_cursor(session_id: str, req: models.UpdateCursorRequest) -> models.BacktestSessionDetail:
    try:
        return bt_session_service.update_cursor(session_id, req.cursor_time)
    except bt_session_service.SessionNotFound as e:
        raise HTTPException(status_code=404, detail=str(e))
    except bt_session_service.InvalidSessionRequest as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/{session_id}/archive", response_model=models.BacktestSessionDetail)
def archive_session(session_id: str) -> models.BacktestSessionDetail:
    try:
        return bt_session_service.archive_session(session_id)
    except bt_session_service.SessionNotFound as e:
        raise HTTPException(status_code=404, detail=str(e))
