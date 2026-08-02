from __future__ import annotations

from typing import List

from fastapi import APIRouter, HTTPException

from app.backend import models
from app.backend.services import bundle_reader

router = APIRouter(prefix="/api/runs", tags=["runs"])


@router.get("", response_model=List[models.RunSummary])
def list_runs() -> List[models.RunSummary]:
    return bundle_reader.list_runs()


@router.get("/{run_id}", response_model=models.RunMetaResponse)
def get_run(run_id: str) -> models.RunMetaResponse:
    try:
        return bundle_reader.get_run_meta(run_id)
    except bundle_reader.RunNotFound as e:
        raise HTTPException(status_code=404, detail=str(e))
