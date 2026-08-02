from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from app.backend import models
from app.backend.services import bundle_reader

router = APIRouter(prefix="/api/runs", tags=["stats"])


@router.get("/{run_id}/stats", response_model=models.StatsResponse)
def get_stats(
    run_id: str,
    scope: str = Query("all", description="all | is | oos -- CLAUDE.md section 7: OOS is the number that matters"),
) -> models.StatsResponse:
    try:
        return bundle_reader.get_stats(run_id, scope=scope)
    except bundle_reader.RunNotFound as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
