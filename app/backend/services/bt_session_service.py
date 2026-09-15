"""Manual-backtest sessions (FXR_SPEC.md section 2, phase F1: "sessions +
account only, no trading yet"). Persistence mirrors the run-bundle
durability shape (propbt/reporting/run_bundle.py) -- one directory per id,
survives reload/restart -- but each session is small enough (no trades/
equity yet; those land in F2+) that a single `session.json` per directory
is the whole bundle, not a family of files.

    bt_sessions/<session_id>/session.json

SimAccount is embedded in the session's own JSON rather than a separate
file: FXR_SPEC's data model gives it its own `id` (kept here, so it reads
as a real referenced entity, not just a nested settings blob), but F1 has
no scenario where two sessions share one account, so a second top-level
file/store would be complexity with no current payoff -- split it out if a
later phase actually needs account reuse across sessions.
"""
from __future__ import annotations

import datetime as dt
import json
import random
import uuid
from pathlib import Path
from typing import List, Optional

from app.backend import models
from app.backend.config import get_bt_sessions_dir
from app.backend.services import bar_service

# FXR_SPEC.md section 1: "scoped to MNQ + MES (expandable later)" -- this
# platform's own restriction, independent of data.yaml's active symbols
# (which also includes ZN for the separate automated-backtest side of the
# app; ZN is deliberately not offered here).
ALLOWED_INSTRUMENTS = ("MNQ", "MES")

# Matches uiStore.ts's Timeframe union exactly -- the base timeframe a
# session replays at must be one the chart can actually render.
ALLOWED_TIMEFRAMES = ("1min", "5min", "15min", "1h")

# Random start deliberately never lands in the data's own final stretch --
# otherwise "kill snooping bias" (FXR_SPEC section F) could hand back a
# point with almost no forward room to replay at all. Not a hard product
# requirement, just an obviously-better default; three days is generous
# slack against even the coarsest allowed base timeframe (1h).
RANDOM_START_END_BUFFER_SECONDS = 3 * 24 * 3600


class SessionNotFound(Exception):
    def __init__(self, session_id: str):
        super().__init__(f"session {session_id!r} not found")
        self.session_id = session_id


class InvalidSessionRequest(ValueError):
    """Bad instrument/timeframe/start_time -- a 400, not a 404 or 500."""


def _session_dir(session_id: str) -> Path:
    return get_bt_sessions_dir() / session_id


def _generate_session_id(created_at: dt.datetime) -> str:
    # Same visual shape as run_bundle.generate_run_id (timestamp + short
    # random suffix) for consistency across the two "pick one from a list"
    # screens, even though the id itself isn't a config hash here.
    return f"{created_at:%Y%m%dT%H%M%S}Z_{uuid.uuid4().hex[:8]}"


def _validate_instrument(instrument: str) -> None:
    if instrument not in ALLOWED_INSTRUMENTS:
        raise InvalidSessionRequest(
            f"instrument must be one of {ALLOWED_INSTRUMENTS}, got {instrument!r}"
        )


def _validate_timeframe(tf: str) -> None:
    if tf not in ALLOWED_TIMEFRAMES:
        raise InvalidSessionRequest(f"base_timeframe must be one of {ALLOWED_TIMEFRAMES}, got {tf!r}")


def _resolve_start_time(instrument: str, req: models.CreateSessionRequest) -> int:
    try:
        lo, hi = bar_service.get_instrument_range(instrument)
    except bar_service.UnknownInstrument as e:
        raise InvalidSessionRequest(str(e))

    if req.random_start:
        # Client never sees or influences this -- FXR_SPEC section F's
        # "kill snooping bias" only holds if the server, not the browser,
        # makes the pick.
        buffered_hi = max(lo, hi - RANDOM_START_END_BUFFER_SECONDS)
        return random.randint(lo, buffered_hi)

    if req.start_time is None:
        raise InvalidSessionRequest("start_time is required unless random_start is true")
    if not (lo <= req.start_time <= hi):
        raise InvalidSessionRequest(
            f"start_time {req.start_time} is outside {instrument}'s available data range [{lo}, {hi}]"
        )
    return req.start_time


def _account_from_request(req: models.CreateSessionRequest) -> models.SimAccountModel:
    if req.risk_per_trade_percent is None and req.risk_per_trade_usd is None:
        raise InvalidSessionRequest("one of risk_per_trade_percent/risk_per_trade_usd is required")
    if req.risk_per_trade_percent is not None and req.risk_per_trade_usd is not None:
        raise InvalidSessionRequest("set only one of risk_per_trade_percent/risk_per_trade_usd, not both")
    if req.starting_balance <= 0:
        raise InvalidSessionRequest("starting_balance must be positive")
    if req.default_contracts < 1:
        raise InvalidSessionRequest("default_contracts must be at least 1")
    if req.commission_per_contract < 0:
        raise InvalidSessionRequest("commission_per_contract cannot be negative")

    return models.SimAccountModel(
        id=uuid.uuid4().hex,
        starting_balance=req.starting_balance,
        balance=req.starting_balance,
        currency="USD",
        risk_per_trade_percent=req.risk_per_trade_percent,
        risk_per_trade_usd=req.risk_per_trade_usd,
        default_contracts=req.default_contracts,
        commission_per_contract=req.commission_per_contract,
    )


def _trades_path(session_id: str) -> Path:
    return _session_dir(session_id) / "trades.json"


def _read_trades(session_id: str) -> list:
    path = _trades_path(session_id)
    if not path.exists():
        return []
    return json.loads(path.read_text(encoding="utf-8"))


def _write_trades(session_id: str, trades: list) -> None:
    _trades_path(session_id).write_text(json.dumps(trades, indent=2), encoding="utf-8")


def _write(session_id: str, data: dict) -> None:
    session_dir = _session_dir(session_id)
    session_dir.mkdir(parents=True, exist_ok=True)
    (session_dir / "session.json").write_text(json.dumps(data, indent=2), encoding="utf-8")


def _read(session_id: str) -> dict:
    path = _session_dir(session_id) / "session.json"
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise SessionNotFound(session_id)


def create_session(req: models.CreateSessionRequest) -> models.BacktestSessionDetail:
    _validate_instrument(req.instrument)
    _validate_timeframe(req.base_timeframe)
    start_time = _resolve_start_time(req.instrument, req)
    account = _account_from_request(req)

    now = dt.datetime.now(dt.timezone.utc)
    session_id = _generate_session_id(now)
    data = {
        "id": session_id,
        "instrument": req.instrument,
        "base_timeframe": req.base_timeframe,
        "start_time": start_time,
        "created_at": now.isoformat(),
        "updated_at": now.isoformat(),
        # Replay always begins exactly at the anchor -- resuming with no
        # steps taken yet must restore to the same bar the session opened
        # on, not somewhere else.
        "cursor_time": start_time,
        "status": "active",
        "account": account.model_dump(),
        "settings": {"random_start": req.random_start},
        "position": None,
        "working_orders": [],
    }
    _write(session_id, data)
    return models.BacktestSessionDetail.model_validate(data)


def list_sessions(include_archived: bool = False) -> List[models.BacktestSessionSummary]:
    sessions_dir = get_bt_sessions_dir()
    if not sessions_dir.exists():
        return []

    out: List[models.BacktestSessionSummary] = []
    for child in sessions_dir.iterdir():
        if not child.is_dir() or not (child / "session.json").exists():
            continue
        try:
            data = _read(child.name)
        except SessionNotFound:
            continue
        if not include_archived and data.get("status") == "archived":
            continue
        out.append(models.BacktestSessionSummary.model_validate(data))

    out.sort(key=lambda s: s.created_at, reverse=True)
    return out


def get_session(session_id: str) -> models.BacktestSessionDetail:
    data = _read(session_id)
    return models.BacktestSessionDetail.model_validate(data)


def update_cursor(session_id: str, req: models.UpdateCursorRequest) -> models.BacktestSessionDetail:
    """Advances the cursor AND persists the full current broker state
    (F4) in one write -- also called with cursor_time left unchanged by
    every OTHER position-changing action (Buy/Sell/Confirm/Close/partial-
    close/cancel-order/drag-modify), so a reload never has to wait for the
    next replay step to see the latest trade (F2/F3's own flagged gap).
    """
    data = _read(session_id)
    # No-look-ahead sanity check at the persistence boundary too (VIZ_SPEC
    # section 0's rule isn't just a chart-rendering concern): a session can
    # never save a cursor before its own replay anchor.
    if req.cursor_time < data["start_time"]:
        raise InvalidSessionRequest(
            f"cursor_time {req.cursor_time} is before this session's start_time {data['start_time']}"
        )
    data["cursor_time"] = req.cursor_time
    data["position"] = req.position.model_dump() if req.position is not None else None
    data["working_orders"] = [o.model_dump() for o in req.working_orders]
    data["updated_at"] = dt.datetime.now(dt.timezone.utc).isoformat()
    _write(session_id, data)
    return models.BacktestSessionDetail.model_validate(data)


def archive_session(session_id: str) -> models.BacktestSessionDetail:
    data = _read(session_id)
    data["status"] = "archived"
    data["updated_at"] = dt.datetime.now(dt.timezone.utc).isoformat()
    _write(session_id, data)
    return models.BacktestSessionDetail.model_validate(data)


def list_trades(session_id: str) -> List[models.ManualTrade]:
    _read(session_id)  # raises SessionNotFound if the session itself doesn't exist
    return [models.ManualTrade.model_validate(t) for t in _read_trades(session_id)]


def record_trade(session_id: str, req: models.CreateManualTradeRequest) -> models.RecordTradeResponse:
    """Journals a closed manual trade and applies its net PnL to the
    session's account balance, atomically (one write to each file, both
    happening here so they can never drift apart). The frontend sim broker
    already computed every number deterministically from (bars, orders)
    (FXR_SPEC.md section 6) -- this endpoint is durable storage, not a
    second source of truth, so it does not recompute pnl/r/mae/mfe itself.
    """
    data = _read(session_id)
    if req.instrument != data["instrument"]:
        raise InvalidSessionRequest(
            f"trade instrument {req.instrument!r} does not match session instrument {data['instrument']!r}"
        )
    if req.side not in ("long", "short"):
        raise InvalidSessionRequest(f"side must be 'long' or 'short', got {req.side!r}")

    existing = _read_trades(session_id)
    trade = models.ManualTrade(
        trade_id=len(existing) + 1,
        session_id=session_id,
        **req.model_dump(),
    )
    existing.append(trade.model_dump())
    _write_trades(session_id, existing)

    data["account"]["balance"] += req.pnl_usd
    data["updated_at"] = dt.datetime.now(dt.timezone.utc).isoformat()
    _write(session_id, data)

    return models.RecordTradeResponse(trade=trade, session=models.BacktestSessionDetail.model_validate(data))
