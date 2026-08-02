from __future__ import annotations

from typing import List, Optional

from fastapi import APIRouter, HTTPException, Query

from app.backend import models
from app.backend.services import bundle_reader

router = APIRouter(prefix="/api/runs", tags=["equity"])


@router.get("/{run_id}/equity", response_model=List[models.EquityPoint])
def get_equity(
    run_id: str,
    from_: Optional[int] = Query(None, alias="from", description="unix seconds"),
    to: Optional[int] = Query(None, description="unix seconds"),
) -> List[models.EquityPoint]:
    try:
        return bundle_reader.list_equity(run_id, ts_from=from_, ts_to=to)
    except bundle_reader.RunNotFound as e:
        raise HTTPException(status_code=404, detail=str(e))
