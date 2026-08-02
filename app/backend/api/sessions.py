from __future__ import annotations

from typing import List

from fastapi import APIRouter, HTTPException, Query

from app.backend import models
from app.backend.services import bar_service, session_service

router = APIRouter(prefix="/api/sessions", tags=["sessions"])


@router.get("", response_model=List[models.SessionWindow])
def get_sessions(
    instrument: str,
    from_: int = Query(..., alias="from", description="unix seconds"),
    to: int = Query(..., description="unix seconds"),
) -> List[models.SessionWindow]:
    try:
        return session_service.get_sessions(instrument, from_, to)
    except bar_service.UnknownInstrument as e:
        raise HTTPException(status_code=404, detail=str(e))
