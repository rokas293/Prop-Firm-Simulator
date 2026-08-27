from __future__ import annotations

from typing import List, Optional

from fastapi import APIRouter, HTTPException, Query

from app.backend import models
from app.backend.services import bundle_reader

router = APIRouter(prefix="/api/runs", tags=["trades"])


@router.get("/{run_id}/trades", response_model=List[models.TradeRecord])
def get_trades(
    run_id: str,
    leg: Optional[str] = None,
    session: Optional[str] = None,
    side: Optional[str] = None,
    result: Optional[str] = Query(None, description="win | loss"),
    exit_type: Optional[str] = Query(None, description="tp | sl | time | eod | daily_lock"),
    from_: Optional[int] = Query(None, alias="from", description="unix seconds, entry_time >="),
    to: Optional[int] = Query(None, description="unix seconds, entry_time <="),
) -> List[models.TradeRecord]:
    try:
        return bundle_reader.list_trades(
            run_id, leg=leg, session=session, side=side, result=result, exit_type=exit_type,
            ts_from=from_, ts_to=to,
        )
    except bundle_reader.RunNotFound as e:
        raise HTTPException(status_code=404, detail=str(e))
