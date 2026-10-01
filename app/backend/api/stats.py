from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException, Query

from app.backend import models
from app.backend.services import bundle_reader

router = APIRouter(prefix="/api/runs", tags=["stats"])


@router.get("/{run_id}/stats", response_model=models.StatsResponse)
def get_stats(
    run_id: str,
    scope: str = Query("all", description="all | is | oos -- CLAUDE.md section 7: OOS is the number that matters"),
    tag: Optional[str] = Query(None, description="manual runs only: restrict the stats to trades carrying this tag"),
    setup: Optional[str] = Query(None, description="manual runs only: setup_name"),
    grade: Optional[str] = Query(None, description="manual runs only: A | B | C"),
    session: Optional[str] = Query(None, description="manual runs only: trading session (asia/london/ny/...)"),
    session_id: Optional[str] = Query(None, description="manual runs only: backtest session id"),
    hour_ny: Optional[int] = Query(None, ge=0, le=23, description="manual runs only: entry hour, America/New_York"),
) -> models.StatsResponse:
    try:
        return bundle_reader.get_stats(
            run_id, scope=scope, tag=tag, setup=setup, grade=grade, session=session, session_id=session_id, hour_ny=hour_ny,
        )
    except bundle_reader.RunNotFound as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
