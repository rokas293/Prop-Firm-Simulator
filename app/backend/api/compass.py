"""Compass analytics endpoints (POLISH_ROADMAP Phase P5): the optional
"Summarize this run" AI insight. Everything else Compass needs -- pattern
breakdowns, the transparency score -- is computed entirely client-side from
already-fetched trades/stats (frontend/src/compass/), matching this app's
existing DashboardPanel histogram/scatter pattern. This is the one piece
that needs a server hop, since it talks to the Anthropic API.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from app.backend import models
from app.backend.services import bundle_reader, compass_service

router = APIRouter(prefix="/api", tags=["compass"])


@router.get("/ai/status", response_model=models.AiStatusResponse)
def ai_status() -> models.AiStatusResponse:
    return models.AiStatusResponse(available=compass_service.is_configured())


@router.post("/runs/{run_id}/summarize", response_model=models.SummarizeResponse)
def summarize_run(
    run_id: str,
    scope: str = Query("oos", description="all | is | oos -- which stats scope to summarize"),
) -> models.SummarizeResponse:
    if not compass_service.is_configured():
        raise HTTPException(
            status_code=503,
            detail="AI summary is not configured (set ANTHROPIC_API_KEY on the backend to enable it).",
        )

    try:
        stats = bundle_reader.get_stats(run_id, scope=scope)
    except bundle_reader.RunNotFound as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    try:
        summary = compass_service.summarize_stats(stats.model_dump(), scope)
    except compass_service.SummarizeError as e:
        raise HTTPException(status_code=502, detail=str(e))

    return models.SummarizeResponse(summary=summary)
