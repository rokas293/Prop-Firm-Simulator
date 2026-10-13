from __future__ import annotations

from typing import List, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, Response

from app.backend import models
from app.backend.services import bt_session_service, home_service, trades_csv

# Routed under /api/bt-sessions, not /api/sessions -- that prefix already
# means "trading-session windows" (see api/sessions.py, models.SessionWindow),
# an unrelated concept from FXR_SPEC's BacktestSession.
router = APIRouter(prefix="/api/bt-sessions", tags=["bt-sessions"])


@router.post("", response_model=models.BacktestSessionDetail)
def create_session(req: models.CreateSessionRequest) -> models.BacktestSessionDetail:
    try:
        return bt_session_service.create_session(req)
    except bt_session_service.InvalidSessionRequest as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("", response_model=List[models.BacktestSessionSummary])
def list_sessions(include_archived: bool = False) -> List[models.BacktestSessionSummary]:
    from app.backend.services import manual_analytics

    sessions = bt_session_service.list_sessions(include_archived=include_archived)
    for s in sessions:
        if s.account.prop_ruleset:
            s.prop_status = manual_analytics.prop_status(s.id)
    home_service.attach_progress(sessions)
    return sessions


# Fixed paths: declared before "/{session_id}" so they are not read as an id.
@router.get("/setup-options", response_model=models.SessionSetupOptions)
def setup_options() -> models.SessionSetupOptions:
    return home_service.setup_options()


@router.get("/home", response_model=models.HomeOverview)
def home_overview() -> models.HomeOverview:
    return home_service.home_overview()


def _csv_response(session_id: Optional[str]) -> Response:
    try:
        body = trades_csv.render(session_id)
    except bt_session_service.SessionNotFound as e:
        raise HTTPException(status_code=404, detail=str(e))
    return Response(
        content=body,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{trades_csv.filename(session_id)}"'},
    )


# G9: every session's trades (declared before "/{session_id}"), or one session's below.
@router.get("/export.csv")
def export_all_trades_csv() -> Response:
    return _csv_response(None)


@router.get("/{session_id}", response_model=models.BacktestSessionDetail)
def get_session(session_id: str) -> models.BacktestSessionDetail:
    try:
        return bt_session_service.get_session(session_id)
    except bt_session_service.SessionNotFound as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.patch("/{session_id}/cursor", response_model=models.BacktestSessionDetail)
def update_cursor(session_id: str, req: models.UpdateCursorRequest) -> models.BacktestSessionDetail:
    try:
        return bt_session_service.update_cursor(session_id, req)
    except bt_session_service.SessionNotFound as e:
        raise HTTPException(status_code=404, detail=str(e))
    except bt_session_service.InvalidSessionRequest as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/{session_id}/archive", response_model=models.BacktestSessionDetail)
def archive_session(session_id: str) -> models.BacktestSessionDetail:
    try:
        return bt_session_service.archive_session(session_id)
    except bt_session_service.SessionNotFound as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.patch("/{session_id}/notes", response_model=models.BacktestSessionDetail)
def update_session_notes(session_id: str, req: models.UpdateSessionNotesRequest) -> models.BacktestSessionDetail:
    try:
        return bt_session_service.update_session_notes(session_id, req)
    except bt_session_service.SessionNotFound as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.patch("/{session_id}/settings", response_model=models.BacktestSessionDetail)
def update_session_settings(session_id: str, req: models.UpdateSessionSettingsRequest) -> models.BacktestSessionDetail:
    try:
        return bt_session_service.update_session_settings(session_id, req)
    except bt_session_service.SessionNotFound as e:
        raise HTTPException(status_code=404, detail=str(e))
    except bt_session_service.InvalidSessionRequest as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/{session_id}/trades", response_model=List[models.ManualTrade])
def list_trades(session_id: str) -> List[models.ManualTrade]:
    try:
        return bt_session_service.list_trades(session_id)
    except bt_session_service.SessionNotFound as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.get("/{session_id}/trades.csv")
def export_session_trades_csv(session_id: str) -> Response:
    return _csv_response(session_id)


@router.post("/{session_id}/trades", response_model=models.RecordTradeResponse)
def record_trade(session_id: str, req: models.CreateManualTradeRequest) -> models.RecordTradeResponse:
    try:
        return bt_session_service.record_trade(session_id, req)
    except bt_session_service.SessionNotFound as e:
        raise HTTPException(status_code=404, detail=str(e))
    except bt_session_service.InvalidSessionRequest as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.patch("/{session_id}/trades/{trade_id}", response_model=models.ManualTrade)
def update_trade_journal(
    session_id: str, trade_id: int, req: models.UpdateTradeJournalRequest
) -> models.ManualTrade:
    try:
        return bt_session_service.update_trade_journal(session_id, trade_id, req)
    except bt_session_service.SessionNotFound as e:
        raise HTTPException(status_code=404, detail=str(e))
    except bt_session_service.TradeNotFound as e:
        raise HTTPException(status_code=404, detail=str(e))
    except bt_session_service.InvalidSessionRequest as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/{session_id}/trades/{trade_id}/screenshots", response_model=models.ManualTrade)
def add_trade_screenshot(
    session_id: str, trade_id: int, req: models.AddScreenshotRequest
) -> models.ManualTrade:
    try:
        return bt_session_service.add_trade_screenshot(session_id, trade_id, req)
    except bt_session_service.SessionNotFound as e:
        raise HTTPException(status_code=404, detail=str(e))
    except bt_session_service.TradeNotFound as e:
        raise HTTPException(status_code=404, detail=str(e))
    except bt_session_service.InvalidSessionRequest as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/{session_id}/trades/{trade_id}/screenshots/{screenshot_id}", response_model=models.ManualTrade)
def delete_trade_screenshot(session_id: str, trade_id: int, screenshot_id: str) -> models.ManualTrade:
    try:
        return bt_session_service.delete_trade_screenshot(session_id, trade_id, screenshot_id)
    except bt_session_service.SessionNotFound as e:
        raise HTTPException(status_code=404, detail=str(e))
    except (bt_session_service.TradeNotFound, bt_session_service.ScreenshotNotFound) as e:
        raise HTTPException(status_code=404, detail=str(e))


# Unprefixed by trade_id -- a screenshot's filename (trade_id embedded in
# it, see add_trade_screenshot) is already unique within the session, and
# the frontend reaches this straight from a Screenshot's own `url` field.
@router.get("/{session_id}/screenshots/{filename}")
def get_screenshot(session_id: str, filename: str) -> FileResponse:
    try:
        path = bt_session_service.get_screenshot_path(session_id, filename)
    except (bt_session_service.SessionNotFound, bt_session_service.ScreenshotNotFound) as e:
        raise HTTPException(status_code=404, detail=str(e))
    return FileResponse(path)
