from __future__ import annotations

from fastapi import APIRouter, HTTPException

from app.backend import models
from app.backend.services import drawings_service

# G9b: drawing state that belongs to no single session (the shared layer, style
# templates) and the one-off import of what browser storage used to hold. A
# session's own drawings are under /api/bt-sessions/{id}/drawings.
router = APIRouter(prefix="/api/drawings", tags=["drawings"])


@router.get("", response_model=models.WorkspaceDrawings)
def get_workspace_drawings() -> models.WorkspaceDrawings:
    return drawings_service.get_workspace_drawings()


@router.patch("", response_model=models.WorkspaceDrawings)
def update_workspace_drawings(req: models.UpdateWorkspaceDrawingsRequest) -> models.WorkspaceDrawings:
    try:
        return drawings_service.update_workspace_drawings(req)
    except drawings_service.InvalidDrawings as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/import-browser", response_model=models.BrowserDrawingsImportResult)
def import_browser_data(req: models.BrowserDrawingsImport) -> models.BrowserDrawingsImportResult:
    try:
        return drawings_service.import_browser_data(req)
    except drawings_service.InvalidDrawings as e:
        raise HTTPException(status_code=400, detail=str(e))

