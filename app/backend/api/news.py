"""FXR_V2_SPEC.md section 6 (G7): the economic calendar's schedule."""
from __future__ import annotations

from typing import List

from fastapi import APIRouter, Query

from app.backend import models
from app.backend.services import news_service

router = APIRouter(prefix="/api/news-events", tags=["news"])


@router.get("", response_model=List[models.NewsEvent])
def get_news_events(
    from_: int = Query(..., alias="from", description="unix seconds"),
    to: int = Query(..., description="unix seconds"),
) -> List[models.NewsEvent]:
    return news_service.events_between(from_, to)
