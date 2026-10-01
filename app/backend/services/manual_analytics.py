"""FXR_SPEC.md phase F6: points the EXISTING run analytics (stats, equity,
drawdown, MAE/MFE, daily-risk, Monte Carlo, the prop-rule visualization) at a
manual session's journaled trades instead of building a second analytics
stack.

The mechanism is a "virtual run": a manual scope is addressed by a run id
that starts with "bt:" --

    bt:<session_id>        one manual session
    bt:all:<INSTRUMENT>    every session of one instrument, pooled

-- and bundle_reader dispatches to this module for those ids, so every
/api/runs/{id}/... endpoint (and therefore every panel already built on
them) works on manual trades with no new frontend data path. This module
only ADAPTS: it turns trades.json into the same trades frame a run bundle's
trades.parquet is (FXR_SPEC section 2's schema compatibility, plus
source/session_id/tags/setup_name/grade), then calls the same aggregation
(`run_bundle.compute_run_stats`) and the same rule engine
(`propbt.engine.prop_rules.PropRulesTracker`) the automated backtest uses.
Pooling is per instrument on purpose: the chart panel plots one instrument's
price scale, so a mixed MNQ+MES scope would mis-plot half its trades.

Engine-truth: nothing about a trade's fill/PnL/R/MAE/MFE is recomputed here
-- those came from the sim broker when the trade closed. What IS derived
here (and only here) is what a run bundle's engine would have derived: the
trading_day label, the prop-rule timeline, and aggregates over trades.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

import pandas as pd

from app.backend import models
from app.backend.services import bt_session_service as bts
from app.backend.services.bundle_reader import RunNotFound, filter_trades_frame
from propbt.config import load_contracts, load_prop_rules, load_sessions
from propbt.data.sessions import trading_day as trading_day_of
from propbt.engine.prop_rules import CombineResult, PropRulesTracker
from propbt.reporting import run_bundle as rb

MANUAL_PREFIX = "bt:"
ALL_PREFIX = "bt:all:"

EXTRA_COLUMNS = ["source", "session_id", "session_trade_id", "tags", "setup_name", "grade"]
FRAME_COLUMNS = rb.TRADE_COLUMNS + EXTRA_COLUMNS


def is_manual_run_id(run_id: str) -> bool:
    return run_id.startswith(MANUAL_PREFIX)


@dataclass(frozen=True)
class Scope:
    kind: str                       # "session" | "all"
    session_id: Optional[str] = None
    instrument: Optional[str] = None


def parse_scope(run_id: str) -> Scope:
    if run_id.startswith(ALL_PREFIX):
        instrument = run_id[len(ALL_PREFIX):]
        if instrument not in bts.ALLOWED_INSTRUMENTS:
            raise RunNotFound(run_id)
        return Scope(kind="all", instrument=instrument)
    session_id = run_id[len(MANUAL_PREFIX):]
    if not session_id or session_id == "all":
        raise RunNotFound(run_id)
    return Scope(kind="session", session_id=session_id)


def _sessions_in_scope(run_id: str) -> List[models.BacktestSessionDetail]:
    scope = parse_scope(run_id)
    if scope.kind == "session":
        try:
            return [bts.get_session(scope.session_id)]  # type: ignore[arg-type]
        except bts.SessionNotFound:
            raise RunNotFound(run_id)
    summaries = bts.list_sessions(include_archived=True)
    return [bts.get_session(s.id) for s in summaries if s.instrument == scope.instrument]


def _empty_frame() -> pd.DataFrame:
    df = pd.DataFrame({c: pd.Series(dtype="object") for c in FRAME_COLUMNS})
    df["entry_time"] = pd.to_datetime(df["entry_time"], utc=True)
    df["exit_time"] = pd.to_datetime(df["exit_time"], utc=True)
    return df


def _build_frame(run_id: str, sessions: List[models.BacktestSessionDetail]) -> pd.DataFrame:
    scope = parse_scope(run_id)
    sessions_cfg = load_sessions()
    rows = []
    for s in sessions:
        for t in bts.list_trades(s.id):
            d = t.model_dump()
            ts = pd.Timestamp(d["entry_time"], unit="s", tz="UTC")
            day = trading_day_of(ts, sessions_cfg)
            row = {c: d.get(c) for c in rb.TRADE_COLUMNS}
            # The journal doesn't stamp the CME trading day on a trade; it's
            # a pure function of entry_time, derived here exactly as the
            # engine's run bundle derives it.
            row["trading_day"] = day.isoformat() if day else None
            row["source"] = "manual"
            row["session_id"] = s.id
            row["session_trade_id"] = d["trade_id"]
            row["tags"] = list(d.get("tags") or [])
            row["setup_name"] = d.get("setup_name")
            row["grade"] = d.get("grade")
            rows.append(row)
    if not rows:
        return _empty_frame()

    df = pd.DataFrame(rows, columns=FRAME_COLUMNS)
    df["entry_time"] = pd.to_datetime(df["entry_time"], unit="s", utc=True)
    df["exit_time"] = pd.to_datetime(df["exit_time"], unit="s", utc=True)
    df = df.sort_values(["exit_time", "entry_time", "session_id", "session_trade_id"], kind="stable").reset_index(drop=True)
    if scope.kind == "all":
        # Journal trade ids restart at 1 in every session; the chart/list
        # cross-filter selects by trade_id, so a pooled scope needs ids that
        # are unique across it. The journal's own id stays in session_trade_id.
        df["trade_id"] = range(1, len(df) + 1)
    return df


def load_trades_frame(run_id: str) -> pd.DataFrame:
    return _build_frame(run_id, _sessions_in_scope(run_id))


# ------------------------------- prop replay --------------------------------

@dataclass
class PropReplay:
    combine: CombineResult
    rows: List[dict] = field(default_factory=list)       # equity timeline rows
    samples: List[dict] = field(default_factory=list)    # every tracker observation, for daily risk
    resolved_time: Optional[int] = None
    resolved_trade_id: Optional[int] = None
    trades_to_result: Optional[int] = None
    equity_at_result: Optional[float] = None
    mll_floor_at_result: Optional[float] = None


def _unix(ts: pd.Timestamp) -> int:
    return int(ts.value // 1_000_000_000)


def replay_prop_rules(df: pd.DataFrame, instrument: str) -> PropReplay:
    """Feeds a session's manual trades through the SAME PropRulesTracker the
    automated backtest uses (propbt/engine/prop_rules.py) -- no rule is
    re-implemented here.

    The sim journals closed trades, not a per-bar equity log, so the tracker
    is driven at trade resolution: per trade, once at entry (balance, flat
    equity), once at exit with the trade's worst point (pre-trade balance
    minus its MAE in dollars -- the live-equity low the engine's per-bar
    check would have seen) and once more at exit with the realized balance.
    Because MAE is the trade's lowest equity, this reaches the same MLL-breach
    verdict a per-bar replay would. What it cannot recover is *when inside
    the trade* the low happened, so an intratrade breach is stamped at the
    trade's exit time. Limitations (documented, not hidden): the MAE low
    excludes commission, and a partial-close slice's MAE ignores the
    still-open remainder's float at the moment of the partial.
    """
    cfg = load_prop_rules()
    spec = load_contracts()[instrument]
    tracker = PropRulesTracker(cfg)
    replay = PropReplay(combine=None)  # type: ignore[arg-type]

    balance = cfg.start_balance
    target_level = cfg.start_balance + cfg.profit_target

    def observe(ts: pd.Timestamp, day, bal: float, eq: float):
        st = tracker.on_bar(ts, day, bal, eq)
        row = {
            "time": ts,
            "balance": bal,
            "open_pnl": eq - bal,
            "equity": eq,
            "mll_floor": tracker.mll_floor,
            "daily_loss_floor": tracker.day_start_balance - cfg.daily_loss_limit,
            "target_level": target_level,
            "trading_day": day.isoformat() if day else None,
            "day_start_balance": tracker.day_start_balance,
            "breached": tracker.failed,
            "daily_locked": tracker.daily_locked,
        }
        replay.rows.append(row)
        replay.samples.append(row)
        return st

    sessions_cfg = load_sessions()
    for i, t in enumerate(df.itertuples(index=False), start=1):
        entry_ts, exit_ts = t.entry_time, t.exit_time
        day_in = trading_day_of(entry_ts, sessions_cfg)
        day_out = trading_day_of(exit_ts, sessions_cfg)

        observe(entry_ts, day_in, balance, balance)

        mae_usd = float(t.mae_points) * spec.point_value * int(t.size_contracts)
        st = observe(exit_ts, day_out, balance, balance - mae_usd)
        resolved = st.failed
        if not resolved:
            balance += float(t.pnl_usd)
            # Replace the low-point row's equity with the realized point: the
            # low only feeds the breach verdict and daily-risk samples, it is
            # not a timeline vertex (same timestamp as the exit row below).
            replay.rows.pop()
            st = observe(exit_ts, day_out, balance, balance)
            resolved = st.failed or st.passed
        if resolved:
            last = replay.rows[-1]
            replay.resolved_time = _unix(last["time"])
            replay.resolved_trade_id = int(t.trade_id)
            replay.trades_to_result = i
            replay.equity_at_result = float(last["equity"])
            replay.mll_floor_at_result = float(last["mll_floor"])
            break

    replay.combine = tracker.finalize(balance)
    return replay


def _session_replay(run_id: str) -> Tuple[Optional[models.BacktestSessionDetail], pd.DataFrame, Optional[PropReplay]]:
    sessions = _sessions_in_scope(run_id)
    df = _build_frame(run_id, sessions)
    scope = parse_scope(run_id)
    if scope.kind == "session" and sessions and sessions[0].account.prop_ruleset:
        return sessions[0], df, replay_prop_rules(df, sessions[0].instrument)
    return (sessions[0] if scope.kind == "session" and sessions else None), df, None


def prop_status(session_id: str) -> Optional[models.PropStatus]:
    """passed/failed/incomplete for a prop session (None without a ruleset);
    the same PropRulesTracker verdict the Dashboard's result card shows."""
    _, _, replay = _session_replay(MANUAL_PREFIX + session_id)
    if replay is None:
        return None
    return models.PropStatus(
        status=replay.combine.status,
        fail_reason=replay.combine.fail_reason,
        resolved_trade_id=replay.resolved_trade_id,
        trades_to_result=replay.trades_to_result,
    )


# --------------------------------- meta ------------------------------------

def get_meta(run_id: str) -> models.RunMetaResponse:
    sessions = _sessions_in_scope(run_id)
    scope = parse_scope(run_id)
    session, df, replay = _session_replay(run_id)

    instrument = sessions[0].instrument if scope.kind == "session" and sessions else scope.instrument
    if len(df):
        date_from = df["entry_time"].min().date().isoformat()
        date_to = df["exit_time"].max().date().isoformat()
    elif sessions:
        date_from = date_to = pd.Timestamp(sessions[0].start_time, unit="s", tz="UTC").date().isoformat()
    else:
        date_from = date_to = ""

    passed, fail_reason, days_to_fail = False, None, None
    if replay is not None:
        passed = replay.combine.status == "passed"
        fail_reason = replay.combine.fail_reason
        days_to_fail = len(replay.combine.day_logs) if replay.combine.status == "failed" else None

    if scope.kind == "session" and sessions:
        s = sessions[0]
        name = f"Manual session {s.instrument} {s.base_timeframe}"
        created_at, timeframe = s.created_at, s.base_timeframe
    else:
        name = f"All {scope.instrument} manual sessions"
        created_at = max((s.updated_at for s in sessions), default="")
        timeframe = sessions[0].base_timeframe if sessions else "5min"

    return models.RunMetaResponse(
        run_id=run_id,
        created_at=created_at,
        config_name=name,
        instrument=instrument or "",
        base_timeframe=timeframe,
        date_from=date_from,
        date_to=date_to,
        is_oos_split_date=None,
        result=models.RunResultModel(passed=passed, fail_reason=fail_reason, days_to_fail=days_to_fail),
        params_count=0,
        config_hash="",
        source="manual",
        prop_ruleset=session.account.prop_ruleset if session else None,
        session_ids=[s.id for s in sessions],
    )


# -------------------------------- equity -----------------------------------

def build_equity_frame(run_id: str) -> pd.DataFrame:
    """Equity timeline in the same shape as a run bundle's equity.parquet.

    Prop session: the rule engine's timeline (floors/target/breach). Plain
    session or pooled scope: realized-balance steps only, with the floor
    columns null -- there is no rule floor to draw, and inventing one would
    violate engine-truth.
    """
    session, df, replay = _session_replay(run_id)
    if replay is not None:
        out = pd.DataFrame(replay.rows, columns=rb.EQUITY_COLUMNS)
        out["time"] = pd.to_datetime(out["time"], utc=True)
        # One vertex per timestamp: a trade entered the instant the previous
        # one exited (or a partial close sharing an exit bar) must not hand
        # the chart duplicate times.
        return out.drop_duplicates("time", keep="last").reset_index(drop=True)

    start_balance = session.account.starting_balance if session is not None else 0.0
    rows = []
    if len(df):
        first = df["entry_time"].min()
        rows.append(_plain_row(first, start_balance, None))
        balance = start_balance
        for t in df.itertuples(index=False):
            balance += float(t.pnl_usd)
            rows.append(_plain_row(t.exit_time, balance, t.trading_day))
    out = pd.DataFrame(rows, columns=rb.EQUITY_COLUMNS)
    out["time"] = pd.to_datetime(out["time"], utc=True)
    return out.drop_duplicates("time", keep="last").reset_index(drop=True)


def _plain_row(ts: pd.Timestamp, balance: float, trading_day: Optional[str]) -> dict:
    nan = float("nan")
    return {
        "time": ts, "balance": balance, "open_pnl": 0.0, "equity": balance,
        "mll_floor": nan, "daily_loss_floor": nan, "target_level": nan,
        "trading_day": trading_day, "day_start_balance": balance,
        "breached": False, "daily_locked": False,
    }


def list_daily_risk(run_id: str) -> List[models.DailyRiskPoint]:
    """Same per-trading-day "closest approach to the MLL" the engine path
    computes, from the replay's observations (which include each trade's
    worst-point sample). Empty without a prop ruleset -- there is no floor
    to measure distance to."""
    _, df, replay = _session_replay(run_id)
    if replay is None or not replay.samples:
        return []

    samples = pd.DataFrame(replay.samples)
    samples = samples[samples["trading_day"].notna()].copy()
    samples["distance_to_mll"] = samples["equity"] - samples["mll_floor"]
    out: List[models.DailyRiskPoint] = []
    for day, group in samples.groupby("trading_day", sort=True):
        worst = group.loc[group["distance_to_mll"].idxmin()]
        breached = group[group["breached"]]
        locked = group[group["daily_locked"]]
        out.append(models.DailyRiskPoint(
            trading_day=str(day),
            min_distance_to_mll_usd=float(worst["distance_to_mll"]),
            min_distance_time=_unix(worst["time"]),
            breached=not breached.empty,
            breach_time=_unix(breached.iloc[0]["time"]) if not breached.empty else None,
            daily_locked=not locked.empty,
            daily_lock_time=_unix(locked.iloc[0]["time"]) if not locked.empty else None,
            trades=int((df["trading_day"] == day).sum()) if len(df) else 0,
        ))
    return out


# --------------------------------- stats -----------------------------------

def _group_stats(d: dict) -> models.GroupStats:
    return models.GroupStats(**d)


def _breakdown(df: pd.DataFrame, key: pd.Series) -> Dict[str, models.GroupStats]:
    out: Dict[str, models.GroupStats] = {}
    for k, g in df.groupby(key):
        out[str(k)] = _group_stats(rb.compute_run_stats(g)["overall"])
    return out


def get_stats(
    run_id: str,
    tag: Optional[str] = None,
    setup: Optional[str] = None,
    grade: Optional[str] = None,
    session: Optional[str] = None,
    session_id: Optional[str] = None,
    hour_ny: Optional[int] = None,
) -> models.StatsResponse:
    _, df_all, replay = _session_replay(run_id)
    df = filter_trades_frame(
        df_all, session=session, tag=tag, setup=setup, grade=grade, session_id=session_id, hour_ny=hour_ny,
    )

    base = rb.compute_run_stats(df, replay.combine if replay is not None else None)

    by_tag: Dict[str, models.GroupStats] = {}
    if len(df):
        exploded = df.explode("tags").reset_index(drop=True)
        exploded = exploded[exploded["tags"].notna() & (exploded["tags"] != "")]
        if len(exploded):
            by_tag = _breakdown(exploded, exploded["tags"])

    result = None
    if replay is not None:
        locked_days = {s["trading_day"] for s in replay.samples if s["daily_locked"] and s["trading_day"]}
        result = models.StatsResult(
            **base["result"],
            resolved_time=replay.resolved_time,
            resolved_trade_id=replay.resolved_trade_id,
            trades_to_result=replay.trades_to_result,
            equity_at_result=replay.equity_at_result,
            mll_floor_at_result=replay.mll_floor_at_result,
            daily_loss_lock_days=len(locked_days),
        )

    multi_session = len(df) and df["session_id"].nunique() > 1
    return models.StatsResponse(
        scope="all",
        overall=_group_stats(base["overall"]),
        by_leg={k: _group_stats(v) for k, v in base["by_leg"].items()},
        by_session={k: _group_stats(v) for k, v in base["by_session"].items()},
        by_setup=_breakdown(df, df["setup_name"].fillna("(no setup)")) if len(df) else {},
        by_tag=by_tag,
        by_grade=_breakdown(df, df["grade"].fillna("ungraded")) if len(df) else {},
        by_backtest_session=_breakdown(df, df["session_id"]) if multi_session else {},
        result=result,
    )
