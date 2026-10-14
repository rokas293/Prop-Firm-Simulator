"""Autopilot (FXR_V2_SPEC.md section 8, G10a): the propbt strategy trading a replay
session, bar by bar, on the session's own account.

The real engine runs it. One `propbt.engine.stepper.EngineStepper` per session
holds the bot's broker, portfolio and prop-rule tracker; the strategy is the
session-open legs built from a stored config snapshot; the server feeds it the
1-minute bars the replay has revealed (never one past the cursor) and journals
what it books as `source="bot"` trades. The browser renders; it computes
nothing here, and cannot forge a bot trade (the manual-trade request has no
`source`).

Conventions kept exactly as the offline backtest has them (they are the same
code): decide on the CLOSE of bar t, fill at the OPEN of t+1 plus the engine's
slippage, round-turn commission at exit, SL beats TP inside one bar, one
position per symbol, daily-lock / MLL flatten at the bar's close. Parity with
`run_backtest(df[warm-up:end], trading_start_ts=<activation bar>)` is exact for
an uninterrupted run and is tested through this service end to end.

Where the bot and the manual book meet (G10a = a shared ledger):
  * trades, balance, journal, analytics and the verdict are one account's;
  * the bot's own gating (daily lock, MLL, position cap) sees only bot P&L and
    bot contracts -- coupling it to manual exposure is G10b;
  * the verdict for a session with bot activity is a per-bar walk
    (manual_analytics.replay_prop_rules_per_bar): bot exposure marked at the
    bar's close (the engine's rule), manual exposure at the bar's extreme (the
    journal's MAE rule).

State: `session.json["autopilot"]` (the run), `autopilot_equity.jsonl` (one
[time, balance, equity, trading_day] row per bar the engine consumed -- the
engine's own equity log, which the verdict walk reads), and the bot's trades in
`trades.json`. After a restart the stepper is rebuilt from the stored snapshot;
if the rebuilt trades are not exactly the journaled ones the run stops with
status "error" instead of carrying on from a state it cannot account for.
"""
from __future__ import annotations

import dataclasses
import datetime as dt
import hashlib
import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import pandas as pd
import yaml

from app.backend import models
from app.backend.services import bar_service, prop_presets
from app.backend.services import bt_session_service as bts
from propbt.config import CONFIG_DIR, PropRulesConfig, load_contracts, load_execution, load_sessions
from propbt.engine.events import Fill, FillType
from propbt.engine.stepper import EngineStepper
from propbt.reporting import run_bundle as rb
from propbt.reporting.metrics import Trade, pair_trades
from propbt.sim.combine import DEFAULT_WARMUP_DAYS
from propbt.strategy.combined import build_combined_strategy_factory
from propbt.strategy.session_open import SessionOpenRunConfig, parse_session_open_config

SUPPORTED_LEGS = ("continuation", "mean_reversion")
TERMINAL = ("failed", "passed", "error")
EQUITY_FILE = "autopilot_equity.jsonl"

# A practice account has no rules to be judged by; the engine still needs a tracker,
# so it gets one that can never trip (the bot is then limited only by the cap, if any).
_NEVER = 1e12


# ----------------------------------------------------------------------------
# strategy configs
# ----------------------------------------------------------------------------

def _enabled_legs(raw: dict) -> Tuple[List[str], List[str]]:
    """(legs Autopilot can run that the config enables, enabled legs it cannot run)."""
    supported: List[str] = []
    unsupported: List[str] = []
    for name, spec in (raw.get("legs") or {}).items():
        if not isinstance(spec, dict) or not spec.get("enabled", False):
            continue
        if name == "news":
            for sub in ("continuation", "mean_reversion"):
                s = spec.get(sub)
                if isinstance(s, dict) and s.get("enabled", False):
                    unsupported.append(f"news_{sub}")
        elif name in SUPPORTED_LEGS:
            supported.append(name)
        else:
            unsupported.append(name)
    return supported, unsupported


def _summary_lines(run_cfg: SessionOpenRunConfig) -> List[str]:
    out = []
    c = run_cfg.continuation
    if c is not None:
        out.append(
            f"continuation · {'/'.join(c.sessions)} · {c.direction_method}, {c.observation_window_minutes} min window"
            f" · SL {c.sl_points:g} pt · RR {c.rr:g} · {c.contracts} ct"
        )
    m = run_cfg.mean_reversion
    if m is not None:
        out.append(
            f"mean reversion · {'/'.join(m.sessions)} · {m.direction_mode}, up to {m.max_trades_per_session}/session"
            f" · SL {m.sl_points:g} pt · RR {m.rr:g} · {m.contracts} ct"
        )
    return out


def _check_config(raw: dict, config_id: str) -> Tuple[Optional[SessionOpenRunConfig], List[str], Optional[str]]:
    """(parsed config, enabled supported legs, reason it cannot run or None)."""
    if not isinstance(raw, dict) or not isinstance(raw.get("legs"), dict) or "symbol" not in raw:
        return None, [], f"{config_id}.yaml is not a strategy config (no `symbol` / `legs`)"
    supported, unsupported = _enabled_legs(raw)
    if unsupported:
        return None, supported, (
            f"{config_id}.yaml enables {', '.join(unsupported)}, which Autopilot cannot run yet, and it will not "
            f"run a subset. Turn those legs off in the config (strategy_session_open.yaml is strategy.yaml with the news legs off)."
        )
    if not supported:
        return None, supported, f"{config_id}.yaml enables no leg Autopilot can run (continuation, mean_reversion)"
    try:
        return parse_session_open_config(raw), supported, None
    except (KeyError, ValueError, TypeError) as e:
        return None, supported, f"{config_id}.yaml could not be read: {e}"


def list_configs() -> List[models.AutopilotConfigInfo]:
    out: List[models.AutopilotConfigInfo] = []
    for path in sorted(CONFIG_DIR.glob("*.yaml")):
        try:
            raw = yaml.safe_load(path.read_text(encoding="utf-8"))
        except yaml.YAMLError:
            continue
        if not isinstance(raw, dict) or not isinstance(raw.get("legs"), dict) or "symbol" not in raw:
            continue  # contracts.yaml, sessions.yaml, ... are not strategies
        run_cfg, legs, reason = _check_config(raw, path.stem)
        _, unsupported = _enabled_legs(raw)
        out.append(models.AutopilotConfigInfo(
            id=path.stem, label=path.stem.replace("_", " "), symbol=str(raw["symbol"]),
            legs=legs + unsupported, summary=_summary_lines(run_cfg) if run_cfg else [],
            supported=reason is None, reason=reason,
        ))
    return out


def _config_text(config_id: str) -> str:
    if "/" in config_id or "\\" in config_id or config_id.startswith("."):
        raise bts.InvalidSessionRequest(f"unknown strategy config {config_id!r}")
    path = CONFIG_DIR / f"{config_id}.yaml"
    if not path.is_file():
        raise bts.InvalidSessionRequest(f"unknown strategy config {config_id!r}")
    return path.read_text(encoding="utf-8")


def _snapshot(config_id: str, text: str) -> dict:
    raw = yaml.safe_load(text)
    run_cfg, _, reason = _check_config(raw, config_id)
    if reason is not None or run_cfg is None:
        raise bts.InvalidSessionRequest(f"Autopilot cannot start: {reason}")
    return {
        "config_id": config_id,
        "config_label": config_id.replace("_", " "),
        "config_hash": hashlib.sha256(text.encode("utf-8")).hexdigest()[:12],
        "config_yaml": text,
        "symbol": run_cfg.symbol,
    }


@lru_cache(maxsize=32)
def _parsed(text: str) -> SessionOpenRunConfig:
    return parse_session_open_config(yaml.safe_load(text))


def _run_cfg(ap: dict) -> SessionOpenRunConfig:
    return _parsed(ap["config_yaml"])


# Static config files, read once (every cursor save would otherwise re-parse them).
@lru_cache(maxsize=None)
def _contracts():
    return load_contracts()


@lru_cache(maxsize=None)
def _sessions_cfg():
    return load_sessions()


def _new_strategy(ap: dict):
    """A FRESH strategy: legs keep per-session state that must not carry over."""
    return build_combined_strategy_factory(_run_cfg(ap), _sessions_cfg(), None)()


# ----------------------------------------------------------------------------
# the engine for one session
# ----------------------------------------------------------------------------

@dataclass
class _Live:
    stepper: EngineStepper
    rows_written: int = 0       # equity_log rows already in autopilot_equity.jsonl
    fills_seen: int = 0         # engine fills already looked at for closed trades


_LIVE: Dict[Tuple[str, str], _Live] = {}


def _key(session_id: str) -> Tuple[str, str]:
    return (str(bts._session_dir(session_id).parent), session_id)


def forget(session_id: str) -> None:
    _LIVE.pop(_key(session_id), None)


def engine_config(data: dict) -> PropRulesConfig:
    """What the bot's tracker enforces: the session's own rules (the same config
    the verdict is judged by), or a never-tripping one on a practice account."""
    acct = data["account"]
    start = float(acct["starting_balance"])
    commissions = dict(acct.get("commissions") or {})
    rules = prop_presets.rules_for_saved_account(acct)
    if rules is not None:
        return prop_presets.engine_config(rules, start, commissions)
    return PropRulesConfig(
        start_balance=start, profit_target=_NEVER, mll_initial_offset=_NEVER,
        mll_freeze_trigger_balance=None, mll_freeze_floor=None, daily_loss_limit=None,
        consistency_max_pct=None, max_open_contracts=acct.get("max_contracts"),
        commissions=commissions, mll_type="static",
    )


def _unix(ts: pd.Timestamp) -> int:
    return int(ts.value // 1_000_000_000)


def _ts(t: int) -> pd.Timestamp:
    return pd.Timestamp(t, unit="s", tz="UTC")


def _new_stepper(data: dict, ap: dict, trading_start: Optional[pd.Timestamp]) -> EngineStepper:
    return EngineStepper(
        symbol=ap["symbol"], contracts=_contracts(), prop_rules_config=engine_config(data),
        sessions_config=_sessions_cfg(), slippage_ticks=int(ap["slippage_ticks"]),
        strategy=None, trading_start_ts=trading_start,
    )


def _reveal(frame: pd.DataFrame, after: Optional[pd.Timestamp], upto: pd.Timestamp) -> pd.DataFrame:
    """Bars with after < ts <= upto. `upto` is the cursor: this is the only place the
    server reads bars for a bot, and it can never hand over a bar past it."""
    lo = 0 if after is None else int(frame.index.searchsorted(after, side="right"))
    hi = int(frame.index.searchsorted(upto, side="right"))
    chunk = frame.iloc[lo:hi]
    assert len(chunk) == 0 or chunk.index[-1] <= upto
    return chunk


def _equity_path(session_id: str) -> Path:
    return bts._session_dir(session_id) / EQUITY_FILE


def read_equity_rows(session_id: str) -> List[Tuple[int, float, float, str]]:
    """The engine's per-bar log of the bot's account: (time, balance, equity, trading_day)."""
    path = _equity_path(session_id)
    if not path.exists():
        return []
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line:
            t, b, e, d = json.loads(line)
            out.append((int(t), float(b), float(e), d))
    return out


def _row_json(r) -> str:
    return json.dumps([_unix(r.ts), float(r.balance), float(r.equity), r.trading_day.isoformat()])


def _flush_equity(session_id: str, live: _Live) -> None:
    rows = live.stepper.equity_log[live.rows_written:]
    if not rows:
        return
    with open(_equity_path(session_id), "a", encoding="utf-8") as f:
        f.write("\n".join(_row_json(r) for r in rows) + "\n")
    live.rows_written += len(rows)


def _rewrite_equity(session_id: str, live: _Live) -> None:
    path = _equity_path(session_id)
    log = live.stepper.equity_log
    path.write_text("".join(_row_json(r) + "\n" for r in log), encoding="utf-8")
    live.rows_written = len(log)


# ---- trades ------------------------------------------------------------------

def _risk_by_leg(run_cfg: SessionOpenRunConfig, symbol: str) -> Dict[str, float]:
    spec = _contracts()[symbol]
    out: Dict[str, float] = {}
    if run_cfg.continuation is not None:
        c = run_cfg.continuation
        out["continuation"] = c.sl_points * spec.point_value * c.contracts
    if run_cfg.mean_reversion is not None:
        m = run_cfg.mean_reversion
        out["mean_reversion"] = m.sl_points * spec.point_value * m.contracts
    return out


def _closed_trades(stepper: EngineStepper, risk_by_leg: Dict[str, float]) -> List[Tuple[Trade, Fill]]:
    """The run's round trips in order, each with its entry fill (for the order's
    decision time). Pairing is metrics.pair_trades itself, one entry/exit at a time."""
    session_by_ts = stepper.frame["session"] if stepper.frame is not None else None
    out: List[Tuple[Trade, Fill]] = []
    entry: Optional[Fill] = None
    for f in stepper.portfolio.fills:
        if f.fill_type is FillType.ENTRY:
            entry = f
        elif entry is not None:
            [trade] = pair_trades([entry, f], session_by_ts, risk_by_leg)
            out.append((trade, entry))
            entry = None
    return out


def _segment_of(ap: dict, decided: Optional[pd.Timestamp]) -> int:
    if decided is None:
        return 0
    t = _unix(decided)
    idx = 0
    for i, seg in enumerate(ap["segments"]):
        if seg["on_time"] <= t:
            idx = i
    return idx


def _trade_dict(session_id: str, ap: dict, stepper: EngineStepper, trade: Trade, entry: Fill, trade_id: int) -> dict:
    row = rb.build_trades_frame([trade], stepper.frame, trade.symbol, _sessions_cfg()).iloc[0]

    def opt(v):
        return None if pd.isna(v) else float(v)

    exit_price = float(trade.exit_price)
    exit_t = _unix(trade.exit_ts)
    t = models.ManualTrade(
        trade_id=trade_id, session_id=session_id, source="bot", bot_segment=_segment_of(ap, entry.order_ts),
        entry_time=_unix(trade.entry_ts), exit_time=exit_t, instrument=trade.symbol, side=trade.side.value,
        leg=trade.leg, session=row["session"], trading_day=row["trading_day"],
        size_contracts=int(trade.contracts), entry_price=float(trade.entry_price), exit_price=exit_price,
        sl_price=opt(trade.sl_price), tp_price=opt(trade.tp_price),
        entry_sl_price=opt(trade.sl_price), entry_tp_price=opt(trade.tp_price),
        sl_points=opt(row["sl_points"]), tp_points=opt(row["tp_points"]), rr_planned=opt(row["rr_planned"]),
        exit_type=trade.exit_type.value, pnl_usd=float(trade.realized_pnl), r_multiple=opt(row["r_multiple"]),
        commission_usd=float(trade.commission), mae_points=float(row["mae_points"]), mfe_points=float(row["mfe_points"]),
        mae_r=opt(row["mae_r"]), mfe_r=opt(row["mfe_r"]), bars_held=int(row["bars_held"]),
        trade_key=f"bot:{_unix(trade.entry_ts)}",
        exits=[models.TradeExit(
            time=exit_t, price=exit_price, contracts=int(trade.contracts), pnl_usd=float(trade.realized_pnl),
            commission_usd=float(trade.commission), exit_type=trade.exit_type.value,
            risk_usd=opt(trade.risk_dollars), mae_points=float(row["mae_points"]),
        )],
    )
    return t.model_dump()


def _journal_new_trades(session_id: str, data: dict, live: _Live) -> int:
    """Append the bot trades the engine has closed since the last call. Returns how many."""
    ap = data["autopilot"]
    stepper = live.stepper
    if len(stepper.portfolio.fills) == live.fills_seen:
        return 0                      # nothing booked since the last look: no trade can have closed
    live.fills_seen = len(stepper.portfolio.fills)
    closed = _closed_trades(stepper, _risk_by_leg(_run_cfg(ap), ap["symbol"]))
    existing = bts._read_trades(session_id)
    have = sum(1 for t in existing if t.get("source") == "bot")
    new = closed[have:]
    if not new:
        return 0
    for trade, entry in new:
        existing.append(_trade_dict(session_id, ap, stepper, trade, entry, trade_id=len(existing) + 1))
    bts._write_trades(session_id, existing)
    return len(new)


def recompute_balance(data: dict, trades: List[dict]) -> float:
    """The account balance with a bot in the picture: the engine portfolio's own balance
    plus the manual trades' realized P&L, so a bot-only session's balance IS the engine's
    (no re-summation). A session without a bot keeps record_trade's running sum."""
    ap = data.get("autopilot")
    if not ap:
        return float(data["account"]["balance"])
    manual = 0.0
    for t in trades:
        if t.get("source", "manual") != "bot":
            manual += float(t["pnl_usd"])
    return float(ap["bot_balance"]) + manual


# ---- the run's stored state ---------------------------------------------------------

def _refresh_block(data: dict, live: _Live, cursor_ts: Optional[pd.Timestamp] = None) -> None:
    ap = data["autopilot"]
    stepper = live.stepper
    spec = _contracts()[ap["symbol"]]
    ap["bot_balance"] = float(stepper.portfolio.balance)
    ap["slippage_ticks"] = int(ap["slippage_ticks"])
    ap["rejections"] = len(stepper.rejections)
    last = stepper.equity_log[-1] if stepper.equity_log else None
    ap["daily_locked"] = bool(last.daily_locked) if last else False
    if stepper.last_held_ts is not None:
        # The last bar the engine HOLDS (halt bars included), not the last it traded: the
        # next chunk must start strictly after it.
        ap["processed_to"] = _unix(stepper.last_held_ts)

    pos = stepper.broker.open_positions.get(ap["symbol"])
    if pos is None:
        ap["position"] = None
    else:
        entry = next((f for f in reversed(stepper.portfolio.fills) if f.fill_type is FillType.ENTRY), None)
        mark = float(stepper.frame.loc[last.ts, "close"]) if last else pos.entry_price
        ap["position"] = {
            "instrument": pos.symbol, "side": pos.side.value, "contracts": int(pos.contracts),
            "entry_price": float(pos.entry_price), "entry_time": _unix(pos.entry_ts),
            "sl_price": None if pos.sl_price is None else float(pos.sl_price),
            "tp_price": None if pos.tp_price is None else float(pos.tp_price),
            "leg": (entry.reason.split(":", 1)[0] if entry and entry.reason else None),
            "unrealized_usd": float(pos.unrealized_pnl(mark, spec.point_value)),
        }
    ap["pending"] = [
        {"instrument": o.symbol, "side": o.side.value, "contracts": int(o.contracts), "decided_time": _unix(o.ts),
         "reason": o.reason, "sl_points": o.sl_points, "tp_points": o.tp_points}
        for o in stepper.broker.pending_orders
    ]
    if stepper.finished in ("failed", "passed"):
        ap["status"] = stepper.finished
        if ap["enabled"]:
            ap["enabled"] = False
            if ap["segments"] and ap["segments"][-1]["off_time"] is None:
                ap["segments"][-1]["off_time"] = ap["processed_to"]
    elif ap["status"] not in TERMINAL:
        ap["status"] = "running" if ap["enabled"] else "off"


def _fail(data: dict, detail: str) -> None:
    ap = data["autopilot"]
    ap["status"] = "error"
    ap["status_detail"] = detail
    ap["enabled"] = False
    if ap["segments"] and ap["segments"][-1]["off_time"] is None:
        ap["segments"][-1]["off_time"] = ap["processed_to"]


# ---- building / rebuilding -------------------------------------------------------------

def _rebuild(session_id: str, data: dict) -> _Live:
    """Replay the stored run: warm-up .. processed_to, attaching a fresh strategy at each
    segment start and detaching (cancelling pending orders) at each end -- exactly what
    the live toggles did. Then check it against the journal."""
    ap = data["autopilot"]
    frame = bar_service.raw_bars(ap["symbol"])
    end = _ts(ap["processed_to"])
    start = _ts(ap["warmup_from"])
    first = frame.index.searchsorted(start, side="left")
    stepper = _new_stepper(data, ap, _ts(ap["trading_start"]))

    events: List[Tuple[int, str]] = []
    for i, seg in enumerate(ap["segments"]):
        if i > 0:
            events.append((seg["on_time"], "on"))
        if seg["off_time"] is not None:
            events.append((seg["off_time"], "off"))

    stepper.set_strategy(_new_strategy(ap))
    held_to: Optional[pd.Timestamp] = None
    cursor_frame = frame.iloc[first:]
    for t, kind in events:
        te = _ts(t)
        stepper.append(_reveal(cursor_frame, held_to, min(te, end)))
        held_to = min(te, end)
        stepper.run()
        if kind == "off":
            stepper.set_strategy(None)
            stepper.broker.cancel_pending(ap["symbol"])
        else:
            stepper.set_strategy(_new_strategy(ap))
    stepper.append(_reveal(cursor_frame, held_to, end))
    stepper.run()
    if not ap["segments"] or ap["segments"][-1]["off_time"] is not None or ap["status"] in TERMINAL:
        stepper.set_strategy(None)

    live = _Live(stepper, fills_seen=len(stepper.portfolio.fills))
    return live


def _verify_rebuilt(session_id: str, data: dict, live: _Live) -> Optional[str]:
    """None when the rebuilt run is exactly what was journaled, else why not."""
    ap = data["autopilot"]
    closed = _closed_trades(live.stepper, _risk_by_leg(_run_cfg(ap), ap["symbol"]))
    saved = [t for t in bts._read_trades(session_id) if t.get("source") == "bot"]
    if len(closed) != len(saved):
        return f"rebuilt {len(closed)} bot trades, {len(saved)} journaled"
    for (trade, _), s in zip(closed, saved):
        got = (_unix(trade.entry_ts), _unix(trade.exit_ts), trade.side.value, int(trade.contracts),
               float(trade.entry_price), float(trade.exit_price), float(trade.realized_pnl))
        want = (s["entry_time"], s["exit_time"], s["side"], s["size_contracts"],
                s["entry_price"], s["exit_price"], s["pnl_usd"])
        if got != want:
            return f"a rebuilt trade differs from the journal ({got} != {want})"
    if float(live.stepper.portfolio.balance) != float(ap["bot_balance"]):
        return "rebuilt balance differs from the stored one"
    return None


def _live_for(session_id: str, data: dict) -> Optional[_Live]:
    """The session's engine, from memory or rebuilt from the stored run. None when the
    run cannot be trusted (then `data` already carries status "error")."""
    ap = data["autopilot"]
    key = _key(session_id)
    live = _LIVE.get(key)
    if live is not None and live.stepper.last_held_ts is not None             and _unix(live.stepper.last_held_ts) == ap["processed_to"]:
        return live
    try:
        live = _rebuild(session_id, data)
    except Exception as e:  # noqa: BLE001 -- a run that cannot be rebuilt must stop, not crash the save
        _fail(data, f"could not rebuild the run: {e}")
        return None
    problem = _verify_rebuilt(session_id, data, live)
    if problem is not None:
        _fail(data, f"the stored run does not rebuild to what was journaled: {problem}")
        return None
    _rewrite_equity(session_id, live)
    _LIVE[key] = live
    return live


# ----------------------------------------------------------------------------
# advancing with the cursor
# ----------------------------------------------------------------------------

def has_run(data: dict) -> bool:
    return bool(data.get("autopilot"))


def rewind_floor(data: dict) -> Optional[int]:
    """The earliest cursor a save may carry: the engine has consumed bars up to here,
    and a position it holds could not un-fill."""
    ap = data.get("autopilot")
    return int(ap["processed_to"]) if ap else None


def advance(session_id: str, data: dict, cursor: int) -> int:
    """Feed the engine the bars revealed up to `cursor` (unix seconds) and journal what
    it books. Mutates `data` (the autopilot block, the account balance); the caller
    writes it. Returns the number of new bot trades."""
    ap = data.get("autopilot")
    if not ap or ap["status"] in TERMINAL or cursor <= ap["processed_to"]:
        return 0
    live = _live_for(session_id, data)
    if live is None:
        return 0
    try:
        frame = bar_service.raw_bars(ap["symbol"])
        chunk = _reveal(frame, _ts(ap["processed_to"]), _ts(cursor))
        if len(chunk) == 0:
            return 0
        live.stepper.append(chunk)
        live.stepper.run()
        n = _journal_new_trades(session_id, data, live)
        _flush_equity(session_id, live)
        _refresh_block(data, live)
        if n:
            # The balance moves only when a trade closes (entries carry no commission).
            ap["trades"] = int(ap.get("trades", 0)) + n
            data["account"]["balance"] = recompute_balance(data, bts._read_trades(session_id))
        return n
    except Exception as e:  # noqa: BLE001
        forget(session_id)
        _fail(data, f"the engine stopped: {e}")
        return 0


# ----------------------------------------------------------------------------
# on / off
# ----------------------------------------------------------------------------

def _check_session_can_run(data: dict) -> None:
    if data.get("status") == "archived":
        raise bts.InvalidSessionRequest("Autopilot cannot start on an archived session")
    rules = data["account"].get("prop_rules") or {}
    held = [name for name, key in (("no overnight holding", "no_overnight"), ("no weekend holding", "no_weekend"),
                                   ("no news trading", "no_news")) if rules.get(key)]
    if held:
        raise bts.InvalidSessionRequest(
            f"Autopilot cannot start: this session's rules include {', '.join(held)}, which the bot's "
            f"orders are not held to yet (the engine does not enforce them), so it would break them silently."
        )


def _enable(session_id: str, data: dict, config_id: Optional[str]) -> None:
    _check_session_can_run(data)
    ap = data.get("autopilot")
    cursor = int(data["cursor_time"])

    if ap is not None and ap["status"] in TERMINAL:
        raise bts.InvalidSessionRequest(
            f"this session's Autopilot run has ended ({ap['status']}"
            f"{': ' + ap['status_detail'] if ap.get('status_detail') else ''}); it cannot be switched on again"
        )

    if ap is not None and ap["enabled"]:
        return

    if ap is None:
        if not config_id:
            raise bts.InvalidSessionRequest("choose a strategy config to start Autopilot")
        snap = _snapshot(config_id, _config_text(config_id))
        if snap["symbol"] not in data["assets"]:
            raise bts.InvalidSessionRequest(
                f"Autopilot cannot start: {config_id}.yaml trades {snap['symbol']}, "
                f"which is not one of this session's assets {data['assets']}"
            )
        frame = bar_service.raw_bars(snap["symbol"])
        last_open = bar_service.last_bar_time_at_or_before(snap["symbol"], cursor)
        if last_open is None:
            raise bts.InvalidSessionRequest("no bars at or before the cursor to start from")
        start = _ts(last_open)
        warm_from = max(frame.index[0], start - pd.Timedelta(days=DEFAULT_WARMUP_DAYS))
        ap = {
            **snap, "enabled": True, "status": "running", "status_detail": None, "daily_locked": False,
            "interrupted": False, "segments": [{"on_time": _unix(start), "off_time": None}],
            "trading_start": _unix(start), "warmup_from": _unix(warm_from), "processed_to": _unix(start),
            "bot_balance": float(data["account"]["starting_balance"]),
            "position": None, "pending": [], "trades": 0, "rejections": 0,
            "slippage_ticks": int(load_execution().slippage_ticks),
            "commission_per_contract": float((data["account"].get("commissions") or {}).get(snap["symbol"], 0.0)),
        }
        data["autopilot"] = ap
        try:
            stepper = _new_stepper(data, ap, start)
            stepper.set_strategy(_new_strategy(ap))
            # warm-up history, then the activation bar itself: it is revealed whole, so the bot may
            # decide on its close (and fill at the next bar's open, when the cursor gets there).
            stepper.append(_reveal(frame.iloc[frame.index.searchsorted(warm_from, side="left"):], None, start))
            stepper.run()
            live = _Live(stepper)
            _LIVE[_key(session_id)] = live
            _equity_path(session_id).write_text("", encoding="utf-8")
            _flush_equity(session_id, live)
            n = _journal_new_trades(session_id, data, live)
            _refresh_block(data, live)
            ap["trades"] = n
            data["account"]["balance"] = recompute_balance(data, bts._read_trades(session_id))
        except Exception:
            forget(session_id)
            _equity_path(session_id).unlink(missing_ok=True)
            raise
        return

    # switched off earlier: carry on from the engine as it is, with a fresh strategy
    # (its per-session memory of what it already traded is gone -- the run is "interrupted")
    advance(session_id, data, cursor)
    if ap["status"] in TERMINAL:
        raise bts.InvalidSessionRequest(f"Autopilot could not be resumed: {ap.get('status_detail') or ap['status']}")
    if config_id and config_id != ap["config_id"]:
        snap = _snapshot(config_id, _config_text(config_id))
        if snap["symbol"] != ap["symbol"]:
            raise bts.InvalidSessionRequest(
                f"this session's run trades {ap['symbol']}; {config_id}.yaml trades {snap['symbol']}"
            )
        ap.update({k: snap[k] for k in ("config_id", "config_label", "config_hash", "config_yaml")})
    live = _live_for(session_id, data)
    if live is None:
        raise bts.InvalidSessionRequest(f"Autopilot could not be resumed: {ap.get('status_detail')}")
    live.stepper.set_strategy(_new_strategy(ap))
    ap["segments"].append({"on_time": ap["processed_to"], "off_time": None})
    ap["interrupted"] = True
    ap["enabled"] = True
    ap["status"] = "running"
    _refresh_block(data, live)


def _disable(session_id: str, data: dict) -> None:
    ap = data.get("autopilot")
    if ap is None or not ap["enabled"]:
        return
    advance(session_id, data, int(data["cursor_time"]))
    live = _live_for(session_id, data)
    if live is None:
        return
    live.stepper.set_strategy(None)
    live.stepper.broker.cancel_pending(ap["symbol"])
    if ap["segments"] and ap["segments"][-1]["off_time"] is None:
        ap["segments"][-1]["off_time"] = ap["processed_to"]
    ap["enabled"] = False
    ap["status"] = "off"
    _refresh_block(data, live)


@bts._serialised
def set_enabled(session_id: str, req: models.SetAutopilotRequest) -> models.BacktestSessionDetail:
    data = bts._read(session_id)
    if req.enabled:
        _enable(session_id, data, req.config_id)
    else:
        _disable(session_id, data)
    data["updated_at"] = dt.datetime.now(dt.timezone.utc).isoformat()
    bts._write(session_id, data)
    return models.BacktestSessionDetail.model_validate(data)
