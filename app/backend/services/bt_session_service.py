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

import base64
import binascii
import datetime as dt
import json
import os
import random
import re
import threading
import uuid
from functools import wraps
from pathlib import Path
from typing import List, Optional

from app.backend import models
from app.backend.config import get_bt_sessions_dir
from app.backend.services import bar_service, news_service, prop_presets

# FXR_SPEC.md section 1: "scoped to MNQ + MES (expandable later)" -- this
# platform's own restriction, independent of data.yaml's active symbols
# (which also includes ZN for the separate automated-backtest side of the
# app; ZN is deliberately not offered here).
ALLOWED_INSTRUMENTS = ("MNQ", "MES")

# Every timeframe a session may chart or step by (FXR_V2_SPEC.md section 5:
# "any timeframe at or above 1m"). All are whole multiples of a minute that
# divide the day on the epoch grid, so a candle's bucket is the same one
# propbt.data.resample builds. Matches the frontend's chart/replayBars.ts.
TIMEFRAME_SECONDS = {
    "1min": 60,
    "2min": 120,
    "3min": 180,
    "5min": 300,
    "10min": 600,
    "15min": 900,
    "30min": 1800,
    "1h": 3600,
    "2h": 7200,
    "4h": 14400,
}
ALLOWED_TIMEFRAMES = tuple(TIMEFRAME_SECONDS)

# The replay always counts in 1-minute bars (the only data there is).
ONE_MINUTE = 60

# FXR_SPEC.md phase F6 / FXR_V2_SPEC.md section 4 (G6): a prop session is the
# Topstep preset (propbt/config/prop_rules.yaml) or a custom rule set; either way
# the account carries the concrete `prop_rules` the PropRulesTracker enforces.
ALLOWED_PROP_RULESETS = (prop_presets.TOPSTEP_50K, prop_presets.CUSTOM)

# Commission per contract when the setup form does not set one (round turn).
DEFAULT_COMMISSION = 1.3

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


class TradeNotFound(Exception):
    def __init__(self, session_id: str, trade_id: int):
        super().__init__(f"trade {trade_id} not found in session {session_id!r}")
        self.session_id = session_id
        self.trade_id = trade_id


class ScreenshotNotFound(Exception):
    def __init__(self, session_id: str, screenshot_ref: str):
        super().__init__(f"screenshot {screenshot_ref!r} not found in session {session_id!r}")
        self.session_id = session_id


class InvalidSessionRequest(ValueError):
    """Bad instrument/timeframe/start_time -- a 400, not a 404 or 500."""


# FXR_SPEC.md section C: grade is a fixed A/B/C picker in the UI (unlike
# tags, which are deliberately freeform) -- validated here so a bad value
# surfaces as a 400 at the journal-update boundary, not a silently stored
# typo.
ALLOWED_GRADES = ("A", "B", "C")

# What ChartKL.captureScreenshot's getConvertPictureUrl call can actually
# produce ("png" | "jpeg" | "webp" per klinecharts' own type declarations,
# plus "jpg" for a bare-eyes-friendly extension) -- anchored and requiring
# the "data:image/...;base64," prefix so this can't be tricked into
# decoding an arbitrary non-image payload as one.
_DATA_URL_RE = re.compile(r"^data:image/(?P<ext>png|jpe?g|webp);base64,(?P<data>.+)$", re.DOTALL)


# Every mutator below is a read-modify-write of the same session.json/trades.json,
# and FastAPI runs these sync endpoints on a thread pool. The browser fires
# several in quick succession (a cursor save per replay step, a trade POST, a
# Quick-quantity PATCH), so without serialising them one request's write can
# silently overwrite another's. One process-wide re-entrant lock is enough for
# this single-user app (the frontend's own awaiting only ordered two of them).
_WRITE_LOCK = threading.RLock()


def _serialised(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        with _WRITE_LOCK:
            return fn(*args, **kwargs)

    return wrapper


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


def _validate_timeframe(tf: str, field: str = "base_timeframe") -> None:
    if tf not in ALLOWED_TIMEFRAMES:
        raise InvalidSessionRequest(f"{field} must be one of {ALLOWED_TIMEFRAMES}, got {tf!r}")


def bucket_last_minute(t: int, bucket_seconds: int) -> int:
    """Open time of the LAST 1-minute bar of the `bucket_seconds` candle that
    contains `t` -- the cursor at which that candle is fully revealed."""
    return (t // bucket_seconds) * bucket_seconds + bucket_seconds - ONE_MINUTE


def _resolve_assets(req: models.CreateSessionRequest) -> List[str]:
    """The session's asset list; assets[0] is its primary instrument."""
    assets = list(req.assets) if req.assets else ([req.instrument] if req.instrument else [])
    if not assets:
        raise InvalidSessionRequest("at least one asset (assets or instrument) is required")
    if len(set(assets)) != len(assets):
        raise InvalidSessionRequest(f"assets must not repeat, got {assets}")
    for a in assets:
        _validate_instrument(a)
    if req.instrument is not None and req.instrument not in assets:
        raise InvalidSessionRequest(f"instrument {req.instrument!r} must be one of assets {assets}")
    if req.instrument is not None:
        assets.remove(req.instrument)
        assets.insert(0, req.instrument)
    return assets


def _resolve_window(assets: List[str], req: models.CreateSessionRequest) -> tuple:
    """(start_time, end_date) for the new session; end_date is None for an open-ended one.

    The assets share one cursor, so the window must lie inside the data every one
    of them has: the latest first bar to the earliest last bar (G7)."""
    try:
        ranges = [bar_service.get_instrument_range(a) for a in assets]
    except bar_service.UnknownInstrument as e:
        raise InvalidSessionRequest(str(e))
    lo = max(r[0] for r in ranges)
    hi = min(r[1] for r in ranges)
    instrument = " and ".join(assets) if len(assets) > 1 else assets[0]
    if lo > hi:
        raise InvalidSessionRequest(f"{instrument} have no overlapping data")

    if req.random_start:
        # Client never sees or influences this -- FXR_SPEC section F's
        # "kill snooping bias" only holds if the server, not the browser,
        # makes the pick.
        if req.end_date is not None:
            raise InvalidSessionRequest("end_date cannot be combined with random_start (give random_duration_seconds)")
        duration = req.random_duration_seconds
        if duration is None:
            buffered_hi = max(lo, hi - RANDOM_START_END_BUFFER_SECONDS)
            return random.randint(lo, buffered_hi), None
        if duration < ONE_MINUTE:
            raise InvalidSessionRequest("random_duration_seconds must be at least one minute")
        if lo + duration > hi:
            raise InvalidSessionRequest(f"a {duration}-second session is longer than {instrument}'s data")
        start = random.randint(lo, hi - duration)
        return start, start + duration

    if req.random_duration_seconds is not None:
        raise InvalidSessionRequest("random_duration_seconds only applies with random_start")
    if req.start_time is None:
        raise InvalidSessionRequest("start_time is required unless random_start is true")
    if not (lo <= req.start_time <= hi):
        raise InvalidSessionRequest(
            f"start_time {req.start_time} is outside {instrument}'s available data range [{lo}, {hi}]"
        )
    if req.end_date is not None:
        if req.end_date <= req.start_time:
            raise InvalidSessionRequest(f"end_date {req.end_date} must be after start_time {req.start_time}")
        if req.end_date > hi:
            raise InvalidSessionRequest(
                f"end_date {req.end_date} is after {instrument}'s last available data at {hi}"
            )
    return req.start_time, req.end_date


def _resolve_prop(req: models.CreateSessionRequest):
    """(label, rules) for a prop session, (None, None) for a practice account."""
    if req.prop_ruleset is None:
        if req.prop_rules is not None:
            raise InvalidSessionRequest("prop_rules needs a prop_ruleset ('custom' or a preset id)")
        return None, None
    if req.prop_ruleset not in ALLOWED_PROP_RULESETS:
        raise InvalidSessionRequest(f"prop_ruleset must be one of {ALLOWED_PROP_RULESETS}, got {req.prop_ruleset!r}")
    if req.prop_ruleset == prop_presets.CUSTOM:
        if req.prop_rules is None:
            raise InvalidSessionRequest("prop_ruleset 'custom' needs prop_rules")
        rules = req.prop_rules
    else:
        preset = prop_presets.get_preset(req.prop_ruleset)
        # The preset's levels are absolute dollars off its own balance: a session
        # on a different balance would silently report a nonsense pass/fail.
        if req.starting_balance != preset.starting_balance:
            raise InvalidSessionRequest(
                f"{req.prop_ruleset} requires starting_balance == {preset.starting_balance:g}, got {req.starting_balance:g}"
            )
        rules = req.prop_rules if req.prop_rules is not None else preset.rules
    return prop_presets.label_for(rules, req.starting_balance), rules


def _validate_rules(rules: models.PropRules, starting_balance: float) -> None:
    if rules.max_loss >= starting_balance:
        raise InvalidSessionRequest("the max loss must be smaller than the account balance")
    if rules.daily_loss_limit is not None and rules.daily_loss_limit > rules.max_loss:
        raise InvalidSessionRequest("the daily loss limit cannot be larger than the max loss")
    # The close the no-overnight / no-weekend rules flatten at: inside the trading
    # day, before the 17:00 ET maintenance halt.
    if not ("09:30" <= rules.close_time <= "17:00"):
        raise InvalidSessionRequest("the close time must be between 09:30 and 17:00 ET")


def _commissions_from_request(req: models.CreateSessionRequest, assets: List[str]) -> dict:
    """Per-instrument commissions covering every asset; `commission_per_contract`
    (what the single-asset replay charges) is the primary asset's."""
    given = dict(req.commissions or {})
    for sym, value in given.items():
        if sym not in assets:
            raise InvalidSessionRequest(f"commission given for {sym!r}, which is not one of the session's assets {assets}")
        if value < 0:
            raise InvalidSessionRequest("commission cannot be negative")
    return {a: given.get(a, req.commission_per_contract) for a in assets}


def _account_from_request(req: models.CreateSessionRequest, assets: List[str]) -> models.SimAccountModel:
    if req.risk_per_trade_percent is None and req.risk_per_trade_usd is None:
        raise InvalidSessionRequest("one of risk_per_trade_percent/risk_per_trade_usd is required")
    if req.risk_per_trade_percent is not None and req.risk_per_trade_usd is not None:
        raise InvalidSessionRequest("set only one of risk_per_trade_percent/risk_per_trade_usd, not both")
    if req.starting_balance <= 0:
        raise InvalidSessionRequest("starting_balance must be positive")
    if req.quick_quantity < 1:
        raise InvalidSessionRequest("quick_quantity must be at least 1")
    if req.commission_per_contract < 0:
        raise InvalidSessionRequest("commission_per_contract cannot be negative")

    label, rules = _resolve_prop(req)
    max_contracts = None
    if rules is not None:
        _validate_rules(rules, req.starting_balance)
        max_contracts = rules.max_contracts
        if max_contracts is not None and req.quick_quantity > max_contracts:
            raise InvalidSessionRequest(
                f"quick_quantity {req.quick_quantity} exceeds the {_rules_label({'prop_ruleset': label})} position limit of {max_contracts} contracts"
            )

    commissions = _commissions_from_request(req, assets)
    return models.SimAccountModel(
        id=uuid.uuid4().hex,
        starting_balance=req.starting_balance,
        balance=req.starting_balance,
        currency="USD",
        risk_per_trade_percent=req.risk_per_trade_percent,
        risk_per_trade_usd=req.risk_per_trade_usd,
        commission_per_contract=commissions[assets[0]],
        commissions=commissions,
        prop_ruleset=label,
        prop_rules=rules,
        max_contracts=max_contracts,
    )


# FXR_V2_SPEC.md section 3.5/4 (G3): the strategy checklist is a short list of
# free-text rules, shown as tick-boxes in the Place Order dialog.
MAX_CHECKLIST_ITEMS = 30
MAX_CHECKLIST_ITEM_LENGTH = 200


def _clean_checklist(items: Optional[List[str]]) -> List[str]:
    """Trims each rule, drops blanks and repeats, and bounds the list's size."""
    cleaned: List[str] = []
    for raw in items or []:
        text = raw.strip()
        if not text or text in cleaned:
            continue
        if len(text) > MAX_CHECKLIST_ITEM_LENGTH:
            raise InvalidSessionRequest(f"a checklist rule may be at most {MAX_CHECKLIST_ITEM_LENGTH} characters")
        cleaned.append(text)
    if len(cleaned) > MAX_CHECKLIST_ITEMS:
        raise InvalidSessionRequest(f"a checklist may have at most {MAX_CHECKLIST_ITEMS} rules")
    return cleaned


def _contract_cap(data: dict):
    """The session's position limit, or None (uncapped). _migrate has already
    filled it from the rules of a session saved before G6."""
    return data["account"].get("max_contracts")


def _rules_label(account: dict) -> str:
    return prop_presets.PRESET_LABELS.get(account.get("prop_ruleset") or "", "custom prop rules")


def _check_cap(data: dict, contracts: int, what: str) -> None:
    cap = _contract_cap(data)
    if cap is not None and contracts > cap:
        raise InvalidSessionRequest(
            f"{what} of {contracts} contracts would put the position over this session's "
            f"{_rules_label(data['account'])} limit of {cap} contracts"
        )


def _check_book(data: dict, req: models.UpdateCursorRequest) -> None:
    """The broker state a client wants saved, against the account's rules (G7).

    The position cap is ONE number for the whole account, counted across every
    instrument -- Topstep gives a micro no discount, so 3 MNQ + 2 MES is 5
    contracts (propbt/config/prop_rules.yaml, position_limit.max_open_contracts,
    carried onto the session as account.max_contracts). The no-news restriction
    refuses a position that was entered inside a high-impact event's window.
    """
    primary, assets = data["instrument"], data["assets"]
    seen = set()
    for p in req.positions:
        sym = p.instrument or primary
        if sym not in assets:
            raise InvalidSessionRequest(f"position in {sym!r}, which is not one of the session's assets {assets}")
        if sym in seen:
            raise InvalidSessionRequest(f"more than one open position in {sym}: the broker holds one position per asset")
        seen.add(sym)
    for o in req.working_orders:
        sym = o.instrument or primary
        if sym not in assets:
            raise InvalidSessionRequest(f"working order in {sym!r}, which is not one of the session's assets {assets}")
        _check_cap(data, o.contracts, "working order")

    total = sum(p.contracts for p in req.positions)
    _check_cap(data, total, "positions" if len(req.positions) > 1 else "position")

    rules = data["account"].get("prop_rules")
    if rules and rules.get("no_news"):
        before = {((p.get("instrument") or primary), p["entry_time"]) for p in data.get("positions", [])}
        window = rules.get("news_window_minutes", 5)
        for p in req.positions:
            if ((p.instrument or primary), p.entry_time) in before:
                continue
            reason = news_service.window_refusal(p.entry_time, window)
            if reason:
                raise InvalidSessionRequest(f"no news trading: {reason}")


def _trades_path(session_id: str) -> Path:
    return _session_dir(session_id) / "trades.json"


def _screenshots_dir(session_id: str) -> Path:
    d = _session_dir(session_id) / "screenshots"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _screenshot_url(session_id: str, filename: str) -> str:
    return f"/api/bt-sessions/{session_id}/screenshots/{filename}"


def _read_trades(session_id: str) -> list:
    path = _trades_path(session_id)
    if not path.exists():
        return []
    return json.loads(path.read_text(encoding="utf-8"))


def _write_atomic(path: Path, text: str) -> None:
    """Write-then-rename, so a concurrent reader (the browser's stats / trades GETs
    are not behind the write lock) sees the old file or the new one, never half of one."""
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def _write_trades(session_id: str, trades: list) -> None:
    _write_atomic(_trades_path(session_id), json.dumps(trades, indent=2))


def _write(session_id: str, data: dict) -> None:
    session_dir = _session_dir(session_id)
    session_dir.mkdir(parents=True, exist_ok=True)
    _write_atomic(session_dir / "session.json", json.dumps(data, indent=2))


def _migrate(data: dict) -> dict:
    """Lifts a v1 session.json to the v2 shape in memory (FXR_V2_SPEC.md
    section 4); the next write persists it. Nothing is dropped:
      - account.default_contracts becomes the session's quick_quantity,
      - the single `instrument` becomes the one-element `assets` list,
      - end_date/name are simply absent (None) -- a v1 session never ended.
    Idempotent, so already-migrated files pass through unchanged.
    """
    account = data.get("account", {})
    legacy_contracts = account.pop("default_contracts", None)
    if "quick_quantity" not in data:
        data["quick_quantity"] = legacy_contracts if legacy_contracts is not None else 1
    if not data.get("assets"):
        data["assets"] = [data["instrument"]]
    data.setdefault("end_date", None)
    data.setdefault("name", None)
    data.setdefault("checklist", [])
    # G7: a session holds one position per asset. One saved before multi-asset had
    # the single `position` (always in its only asset, which is the primary).
    legacy_position = data.pop("position", None)
    if "positions" not in data:
        data["positions"] = [legacy_position] if legacy_position else []
    for item in (*data["positions"], *data.get("working_orders", [])):
        if not item.get("instrument"):
            item["instrument"] = data["instrument"]
    # G6: a prop session carries its concrete rules. One saved before the rule
    # builder was judged by the Topstep config, which is exactly the "Topstep 50k"
    # preset (derived from the same prop_rules.yaml), so mapping it onto the preset
    # changes no verdict (tests/test_prop_presets.py). Restrictions stay off, as they
    # always were; the cap the old code read from the yaml moves onto the account.
    if account.get("prop_ruleset") and not account.get("prop_rules"):
        rules = prop_presets.legacy_rules(account["prop_ruleset"])
        account["prop_rules"] = rules.model_dump()
        if account.get("max_contracts") is None:
            account["max_contracts"] = rules.max_contracts
    # G6: commissions are per instrument; a saved session had one number for its instrument.
    if not account.get("commissions"):
        account["commissions"] = {a: account["commission_per_contract"] for a in (data.get("assets") or [data["instrument"]])}
    # G5: the chart timeframe and the step size are their own settings now; a
    # session saved before them charted and stepped by its base timeframe.
    data.setdefault("chart_timeframe", data["base_timeframe"])
    data.setdefault("step_size", data["base_timeframe"])
    # G5: the cursor counts in 1-minute bars. Before, it was the open time of
    # the last revealed BASE bar, which was always revealed whole -- so the same
    # state in the new count is that bar's last minute. This keeps an existing
    # session showing exactly what it showed (same candles, same position in the
    # replay). A 1m session needs no change. Saved once, then marked.
    if "replay_version" not in data:
        base_seconds = TIMEFRAME_SECONDS.get(data["base_timeframe"], ONE_MINUTE)
        data["cursor_time"] = _clamp_to_end(bucket_last_minute(data["cursor_time"], base_seconds), data["end_date"])
        if data.get("lock_floor_time") is not None:
            data["lock_floor_time"] = _clamp_to_end(bucket_last_minute(data["lock_floor_time"], base_seconds), data["end_date"])
        data["replay_version"] = 2
    return data


def _clamp_to_end(t: int, end_date: Optional[int]) -> int:
    return t if end_date is None else min(t, end_date)


def _read(session_id: str) -> dict:
    path = _session_dir(session_id) / "session.json"
    try:
        return _migrate(json.loads(path.read_text(encoding="utf-8")))
    except FileNotFoundError:
        raise SessionNotFound(session_id)


@_serialised
def create_session(req: models.CreateSessionRequest) -> models.BacktestSessionDetail:
    assets = _resolve_assets(req)
    instrument = assets[0]
    _validate_timeframe(req.base_timeframe)
    chart_timeframe = req.chart_timeframe or req.base_timeframe
    step_size = req.step_size or req.base_timeframe
    _validate_timeframe(chart_timeframe, "chart_timeframe")
    _validate_timeframe(step_size, "step_size")
    start_time, end_date = _resolve_window(assets, req)
    account = _account_from_request(req, assets)

    checklist = _clean_checklist(req.checklist)

    now = dt.datetime.now(dt.timezone.utc)
    session_id = _generate_session_id(now)
    data = {
        "id": session_id,
        "name": (req.name or "").strip() or None,
        "instrument": instrument,
        "assets": assets,
        "base_timeframe": req.base_timeframe,
        "chart_timeframe": chart_timeframe,
        "step_size": step_size,
        "replay_version": 2,
        "start_time": start_time,
        "end_date": end_date,
        "quick_quantity": req.quick_quantity,
        "checklist": checklist,
        "created_at": now.isoformat(),
        "updated_at": now.isoformat(),
        # Replay always begins exactly at the anchor -- resuming with no
        # steps taken yet must restore to the same bar the session opened
        # on, not somewhere else.
        "cursor_time": start_time,
        "status": "active",
        "account": account.model_dump(),
        "settings": {"random_start": req.random_start},
        "discipline_lock": req.discipline_lock,
        "lock_floor_time": None,
        "positions": [],
        "working_orders": [],
        "notes": None,
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


@_serialised
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
    # Prop sessions cannot be rewound at all (FXR_V2_SPEC.md section 4/5, like
    # a live Combine): the cursor only ever moves forward, enforced here so a
    # stale or hand-built client can't step back either.
    if data["account"].get("prop_ruleset") and req.cursor_time < data["cursor_time"]:
        raise InvalidSessionRequest(
            f"prop session: the replay cannot be rewound (cursor_time {req.cursor_time} is before the saved cursor {data['cursor_time']})"
        )
    # The session ends at end_date: the cursor never goes past it (the same
    # no-look-ahead boundary, enforced at persistence like start_time above).
    if data.get("end_date") is not None and req.cursor_time > data["end_date"]:
        raise InvalidSessionRequest(
            f"cursor_time {req.cursor_time} is after this session's end_date {data['end_date']}"
        )
    # Defense in depth: the sim broker lives in the browser and refuses an
    # over-cap order itself (positionCap.ts); this keeps a hand-built or
    # stale client from persisting one anyway.
    _check_book(data, req)
    # FXR_SPEC.md section F, phase F7b: with the discipline lock on, the
    # cursor never goes back past where the first trade was placed -- enforced
    # here too (not just in the UI), so a stale or hand-built client can't
    # rewind a locked session. The floor is set the first time a position or
    # working order is persisted, at that save's cursor time (the moment of
    # placement), and stays even if the order is later cancelled.
    if data.get("discipline_lock"):
        floor = data.get("lock_floor_time")
        if floor is not None and req.cursor_time < floor:
            raise InvalidSessionRequest(
                f"discipline lock: cursor_time {req.cursor_time} is before the first placed trade at {floor}"
            )
        if floor is None and (req.positions or req.working_orders):
            data["lock_floor_time"] = req.cursor_time
    data["cursor_time"] = req.cursor_time
    primary = data["instrument"]
    data["positions"] = [{**p.model_dump(), "instrument": p.instrument or primary} for p in req.positions]
    data["working_orders"] = [{**o.model_dump(), "instrument": o.instrument or primary} for o in req.working_orders]
    data["updated_at"] = dt.datetime.now(dt.timezone.utc).isoformat()
    _write(session_id, data)
    return models.BacktestSessionDetail.model_validate(data)


@_serialised
def archive_session(session_id: str) -> models.BacktestSessionDetail:
    data = _read(session_id)
    data["status"] = "archived"
    data["updated_at"] = dt.datetime.now(dt.timezone.utc).isoformat()
    _write(session_id, data)
    return models.BacktestSessionDetail.model_validate(data)


@_serialised
def update_session_notes(session_id: str, req: models.UpdateSessionNotesRequest) -> models.BacktestSessionDetail:
    """FXR_SPEC.md section C: "Session-level notes too" -- a free-text
    field on the session itself, separate from any one trade's journal.
    """
    data = _read(session_id)
    data["notes"] = req.notes
    data["updated_at"] = dt.datetime.now(dt.timezone.utc).isoformat()
    _write(session_id, data)
    return models.BacktestSessionDetail.model_validate(data)


@_serialised
def update_session_settings(session_id: str, req: models.UpdateSessionSettingsRequest) -> models.BacktestSessionDetail:
    """Per-session settings the workspace edits in place: the display name, the
    Quick Buy/Sell quantity (FXR_V2_SPEC.md section 3.1: "persists per
    session"), the strategy checklist (3.5), Scalper Mode (3.4) and (G5) the chart
    timeframe and the step size. Only the fields actually sent change."""
    data = _read(session_id)
    updates = req.model_dump(exclude_unset=True)
    if "quick_quantity" in updates:
        qty = updates["quick_quantity"]
        if qty is None or qty < 1:
            raise InvalidSessionRequest("quick_quantity must be at least 1")
        _check_cap(data, qty, "quick quantity")
        data["quick_quantity"] = qty
    if "name" in updates:
        data["name"] = (updates["name"] or "").strip() or None
    if "checklist" in updates:
        data["checklist"] = _clean_checklist(updates["checklist"])
    if "scalper" in updates:
        # Validated and normalised by models.ScalperConfig (already applied to `req`).
        data["scalper"] = req.scalper.model_dump() if req.scalper is not None else None
    for field in ("chart_timeframe", "step_size"):
        if field in updates:
            if updates[field] is None:
                raise InvalidSessionRequest(f"{field} cannot be cleared")
            _validate_timeframe(updates[field], field)
            data[field] = updates[field]
    data["updated_at"] = dt.datetime.now(dt.timezone.utc).isoformat()
    _write(session_id, data)
    return models.BacktestSessionDetail.model_validate(data)


def list_trades(session_id: str) -> List[models.ManualTrade]:
    _read(session_id)  # raises SessionNotFound if the session itself doesn't exist
    return [models.ManualTrade.model_validate(t) for t in _read_trades(session_id)]


def _exit_from_request(req: models.CreateManualTradeRequest) -> dict:
    return models.TradeExit(
        time=req.exit_time,
        price=req.exit_price,
        contracts=req.size_contracts,
        pnl_usd=req.pnl_usd,
        commission_usd=req.commission_usd,
        exit_type=req.exit_type,
        risk_usd=req.risk_usd,
        mae_points=req.mae_points,
    ).model_dump()


def _merge_exits(trade: dict) -> dict:
    """Recomputes a trade's aggregates from its `exits` (FXR_V2_SPEC.md 3.6).

    Order-independent on purpose (exits are folded by time, not arrival), so
    two exits that reach the server in either order give the same trade. The
    per-exit numbers themselves come from the sim broker -- this only sums them:
      pnl/commission = sums, exit_price = contract-weighted average,
      exit_time/exit_type = the latest exit's, R = total P&L / total risk (only
      when every exit carries its frozen risk share).
    """
    exits = sorted(trade["exits"], key=lambda e: e["time"])
    contracts = sum(e["contracts"] for e in exits)
    trade["pnl_usd"] = sum(e["pnl_usd"] for e in exits)
    trade["commission_usd"] = sum(e["commission_usd"] for e in exits)
    trade["exit_price"] = sum(e["price"] * e["contracts"] for e in exits) / contracts
    trade["exit_time"] = exits[-1]["time"]
    trade["exit_type"] = exits[-1]["exit_type"]
    risks = [e.get("risk_usd") for e in exits]
    if all(r for r in risks):
        trade["r_multiple"] = trade["pnl_usd"] / sum(risks)
    else:
        trade["r_multiple"] = None
    return trade


@_serialised
def record_trade(session_id: str, req: models.CreateManualTradeRequest) -> models.RecordTradeResponse:
    """Journals a closed manual trade and applies its net PnL to the
    session's account balance, atomically (one write to each file, both
    happening here so they can never drift apart). The frontend sim broker
    already computed every number deterministically from (bars, orders)
    (FXR_SPEC.md section 6) -- this endpoint is durable storage, not a
    second source of truth, so it does not recompute pnl/r/mae/mfe itself.

    Partial exits (FXR_V2_SPEC.md 3.6): the request describes ONE exit. When
    its `trade_key` matches an already-journaled trade it becomes one more
    exit of that trade (the trade stays one row; its aggregates are folded
    from all exits, and only THIS exit's P&L is added to the balance).
    """
    data = _read(session_id)
    if req.instrument not in data["assets"]:
        raise InvalidSessionRequest(
            f"trade instrument {req.instrument!r} is not one of the session's assets {data['assets']}"
        )
    if req.side not in ("long", "short"):
        raise InvalidSessionRequest(f"side must be 'long' or 'short', got {req.side!r}")

    size = req.initial_contracts if req.initial_contracts is not None else req.size_contracts
    _check_cap(data, size, "trade")

    existing = _read_trades(session_id)
    new_exit = _exit_from_request(req)
    match_idx = (
        next((i for i, t in enumerate(existing) if t.get("trade_key") == req.trade_key), None)
        if req.trade_key
        else None
    )
    if match_idx is None:
        body = req.model_dump(exclude={"initial_contracts", "risk_usd"})
        body["size_contracts"] = size
        trade = models.ManualTrade(trade_id=len(existing) + 1, session_id=session_id, exits=[new_exit], **body)
        trade_dict = _merge_exits(trade.model_dump())
        # The slice's own R stands until a second exit arrives.
        if req.risk_usd is None:
            trade_dict["r_multiple"] = req.r_multiple
        existing.append(trade_dict)
        out = trade_dict
    else:
        t = existing[match_idx]
        if sum(e["contracts"] for e in t["exits"]) + req.size_contracts > t["size_contracts"]:
            raise InvalidSessionRequest(
                f"exit of {req.size_contracts} contracts exceeds the {t['size_contracts']}-contract trade"
            )
        t["exits"] = [*t["exits"], new_exit]
        t = _merge_exits(t)
        # The deepest excursion over the whole hold wins (each exit's own
        # numbers span entry..that exit, so the later one already covers more).
        t["mae_points"] = max(t["mae_points"], req.mae_points)
        t["mfe_points"] = max(t["mfe_points"], req.mfe_points)
        t["mae_r"] = max((v for v in (t.get("mae_r"), req.mae_r) if v is not None), default=None)
        t["mfe_r"] = max((v for v in (t.get("mfe_r"), req.mfe_r) if v is not None), default=None)
        t["bars_held"] = max(t["bars_held"], req.bars_held)
        existing[match_idx] = t
        out = t
    _write_trades(session_id, existing)

    data["account"]["balance"] += req.pnl_usd
    data["updated_at"] = dt.datetime.now(dt.timezone.utc).isoformat()
    _write(session_id, data)

    return models.RecordTradeResponse(
        trade=models.ManualTrade.model_validate(out), session=models.BacktestSessionDetail.model_validate(data)
    )


def _find_trade_index(session_id: str, trades: list, trade_id: int) -> int:
    idx = next((i for i, t in enumerate(trades) if t["trade_id"] == trade_id), None)
    if idx is None:
        raise TradeNotFound(session_id, trade_id)
    return idx


@_serialised
def update_trade_journal(
    session_id: str, trade_id: int, req: models.UpdateTradeJournalRequest
) -> models.ManualTrade:
    """FXR_SPEC.md section C: notes/tags/setup_name/grade on an already-
    journaled trade. Merges only the fields the caller actually set
    (exclude_unset, not exclude_none) -- e.g. a grade-only PATCH must never
    null out notes/tags it didn't intend to touch. Screenshots are handled
    by add_trade_screenshot/delete_trade_screenshot below, not here -- see
    their own comment for why. The frontend is still the one place these
    values originate (a note the user typed, a tag they added); this is
    durable storage, same division of responsibility as record_trade.
    """
    _read(session_id)  # raises SessionNotFound if the session itself doesn't exist
    if req.grade is not None and req.grade not in ALLOWED_GRADES:
        raise InvalidSessionRequest(f"grade must be one of {ALLOWED_GRADES}, got {req.grade!r}")

    trades = _read_trades(session_id)
    idx = _find_trade_index(session_id, trades, trade_id)

    updates = req.model_dump(exclude_unset=True)
    trades[idx] = {**trades[idx], **updates}
    _write_trades(session_id, trades)
    return models.ManualTrade.model_validate(trades[idx])


@_serialised
def add_trade_screenshot(
    session_id: str, trade_id: int, req: models.AddScreenshotRequest
) -> models.ManualTrade:
    """FXR_SPEC.md section C: a screenshot's BYTES are written to their own
    file under this session's screenshots/ directory -- never embedded in
    trades.json (see Screenshot's own comment on the model for why: that
    file gets rewritten on every journal edit for EVERY trade in the
    session, so embedding image data there would mean re-writing every
    other trade's screenshots, in full, on every single edit). Only the
    lightweight Screenshot reference (id/caption/moment/url) lands in
    trades.json; the bytes are served back by get_screenshot_path below.
    """
    _read(session_id)  # raises SessionNotFound if the session itself doesn't exist
    match = _DATA_URL_RE.match(req.data_url)
    if not match:
        raise InvalidSessionRequest("data_url must be a base64-encoded data:image/{png,jpeg,jpg,webp};base64,... URL")
    ext = "jpg" if match.group("ext") in ("jpg", "jpeg") else match.group("ext")
    try:
        raw = base64.b64decode(match.group("data"), validate=True)
    except (binascii.Error, ValueError) as e:
        raise InvalidSessionRequest(f"data_url is not valid base64: {e}")

    trades = _read_trades(session_id)
    idx = _find_trade_index(session_id, trades, trade_id)

    screenshot_id = uuid.uuid4().hex
    filename = f"{trade_id}_{screenshot_id}.{ext}"
    (_screenshots_dir(session_id) / filename).write_bytes(raw)

    screenshot = models.Screenshot(
        id=screenshot_id,
        caption=req.caption,
        moment=req.moment,
        url=_screenshot_url(session_id, filename),
        created_at=dt.datetime.now(dt.timezone.utc).isoformat(),
    )
    trades[idx] = {**trades[idx], "screenshots": [*trades[idx]["screenshots"], screenshot.model_dump()]}
    _write_trades(session_id, trades)
    return models.ManualTrade.model_validate(trades[idx])


@_serialised
def delete_trade_screenshot(session_id: str, trade_id: int, screenshot_id: str) -> models.ManualTrade:
    _read(session_id)
    trades = _read_trades(session_id)
    idx = _find_trade_index(session_id, trades, trade_id)

    shots = trades[idx]["screenshots"]
    remaining = [s for s in shots if s["id"] != screenshot_id]
    if len(remaining) == len(shots):
        raise ScreenshotNotFound(session_id, screenshot_id)

    removed = next(s for s in shots if s["id"] == screenshot_id)
    filename = removed["url"].rsplit("/", 1)[-1]
    (_screenshots_dir(session_id) / filename).unlink(missing_ok=True)

    trades[idx] = {**trades[idx], "screenshots": remaining}
    _write_trades(session_id, trades)
    return models.ManualTrade.model_validate(trades[idx])


def get_screenshot_path(session_id: str, filename: str) -> Path:
    _read(session_id)  # raises SessionNotFound if the session itself doesn't exist
    # Path-traversal guard: strip any directory components so a filename
    # like "../../secrets.txt" can only ever resolve inside this session's
    # OWN screenshots dir, never outside it.
    safe_name = Path(filename).name
    path = _screenshots_dir(session_id) / safe_name
    if not path.is_file():
        raise ScreenshotNotFound(session_id, filename)
    return path
