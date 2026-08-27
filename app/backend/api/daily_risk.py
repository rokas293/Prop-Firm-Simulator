from __future__ import annotations

from typing import List

from fastapi import APIRouter, HTTPException

from app.backend import models
from app.backend.services import bundle_reader

router = APIRouter(prefix="/api/runs", tags=["daily_risk"])


@router.get("/{run_id}/daily_risk", response_model=List[models.DailyRiskPoint])
def get_daily_risk(run_id: str) -> List[models.DailyRiskPoint]:
    try:
        return bundle_reader.list_daily_risk(run_id)
    except bundle_reader.RunNotFound as e:
        raise HTTPException(status_code=404, detail=str(e))
