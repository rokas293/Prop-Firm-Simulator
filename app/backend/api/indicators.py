from __future__ import annotations

from typing import Dict, List

from fastapi import APIRouter, HTTPException, Query

from app.backend import models
from app.backend.services import bar_service, indicator_service

router = APIRouter(prefix="/api/indicators", tags=["indicators"])


@router.get("", response_model=Dict[str, List[models.IndicatorPoint]])
def get_indicators(
    instrument: str,
    from_: int = Query(..., alias="from", description="unix seconds"),
    to: int = Query(..., description="unix seconds"),
    tf: str = Query("1min", description="pandas offset alias, e.g. 1min/5min/15min/1h"),
    which: str = Query(..., description="comma-separated: vwap,ema20,ema50,atr14"),
) -> Dict[str, List[models.IndicatorPoint]]:
    names = [w.strip() for w in which.split(",") if w.strip()]
    try:
        return indicator_service.get_indicators(instrument, tf, from_, to, names)
    except bar_service.UnknownInstrument as e:
        raise HTTPException(status_code=404, detail=str(e))
    except indicator_service.UnknownIndicator as e:
        raise HTTPException(status_code=400, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
