from __future__ import annotations

from typing import List

from fastapi import APIRouter, HTTPException, Query

from app.backend import models
from app.backend.services import bar_service

router = APIRouter(prefix="/api/bars", tags=["bars"])


@router.get("", response_model=List[models.Bar])
def get_bars(
    instrument: str,
    tf: str = Query("1min", description="pandas offset alias, e.g. 1min/5min/15min/1h/1D"),
    from_: int = Query(..., alias="from", description="unix seconds"),
    to: int = Query(..., description="unix seconds"),
    max_points: int = Query(2000, ge=10, le=20000),
) -> List[models.Bar]:
    try:
        return bar_service.get_bars(instrument, tf, from_, to, max_points=max_points)
    except bar_service.UnknownInstrument as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
