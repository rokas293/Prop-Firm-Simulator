from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException, Query

from app.backend import models
from app.backend.services import bundle_reader

router = APIRouter(prefix="/api/runs", tags=["monte_carlo"])


@router.get("/{run_id}/monte-carlo", response_model=models.MonteCarloResponse)
def get_monte_carlo(
    run_id: str,
    n_sims: int = Query(1000, ge=10, le=10000),
    method: str = Query("bootstrap", description="bootstrap (resample with replacement) | shuffle (reorder the same trades)"),
    seed: int = Query(0, ge=0),
    drawdown_budget_usd: Optional[float] = Query(None, gt=0, description="defaults to the Topstep MLL distance"),
    tag: Optional[str] = None,
    setup: Optional[str] = None,
    grade: Optional[str] = None,
    session: Optional[str] = None,
    session_id: Optional[str] = None,
    hour_ny: Optional[int] = Query(None, ge=0, le=23),
) -> models.MonteCarloResponse:
    if method not in ("bootstrap", "shuffle"):
        raise HTTPException(status_code=400, detail=f"method must be bootstrap or shuffle, got {method!r}")
    try:
        return bundle_reader.get_monte_carlo(
            run_id, n_sims=n_sims, method=method, seed=seed, drawdown_budget_usd=drawdown_budget_usd,
            tag=tag, setup=setup, grade=grade, session=session, session_id=session_id, hour_ny=hour_ny,
        )
    except bundle_reader.RunNotFound as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
