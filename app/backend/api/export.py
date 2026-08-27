from __future__ import annotations

from fastapi import APIRouter, HTTPException
from fastapi.responses import HTMLResponse

from app.backend.services import bundle_reader, export_service

router = APIRouter(prefix="/api/runs", tags=["export"])


@router.get("/{run_id}/export.html", response_class=HTMLResponse)
def export_snapshot(run_id: str) -> HTMLResponse:
    try:
        html = export_service.render_snapshot_html(run_id)
    except bundle_reader.RunNotFound as e:
        raise HTTPException(status_code=404, detail=str(e))
    return HTMLResponse(content=html)
