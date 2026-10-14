"""FXR_SPEC.md phase F6: points the EXISTING run analytics (stats, equity,
drawdown, MAE/MFE, daily-risk, Monte Carlo, the prop-rule visualization) at a
manual session's journaled trades instead of building a second analytics
stack.

The mechanism is a "virtual run": a manual scope is addressed by a run id
that starts with "bt:" --

    bt:<session_id>        one manual session
    bt:all:<INSTRUMENT>    every session of one instrument, pooled
    bt:all                 every session, every instrument (the Analytics page;
                           it filters by instrument itself)

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

import datetime as dt
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

import pandas as pd

from app.backend import models
from app.backend.services import bar_service
from app.backend.services import bt_session_service as bts
from app.backend.services import prop_presets
from app.backend.services.bundle_reader import RunNotFound, filter_trades_frame
from propbt.config import PropRulesConfig, load_contracts, load_sessions
from propbt.data.sessions import trading_day as trading_day_of
from propbt.engine.prop_rules import CombineResult, PropRulesTracker
from propbt.reporting import run_bundle as rb

MANUAL_PREFIX = "bt:"
ALL_PREFIX = "bt:all:"
ALL_RUN_ID = "bt:all"

# `exits` is the trade's exit list (FXR_V2_SPEC.md 3.6): the journal shows ONE trade, but the
# prop replay and the equity timeline walk its exits (see _legs).
EXTRA_COLUMNS = ["source", "bot_segment", "session_id", "session_trade_id", "tags", "setup_name", "grade", "exits", "entry_sl_price", "entry_tp_price"]
FRAME_COLUMNS = rb.TRADE_COLUMNS + EXTRA_COLUMNS


def is_manual_run_id(run_id: str) -> bool:
    return run_id.startswith(MANUAL_PREFIX)


@dataclass(frozen=True)
class Scope:
    kind: str                       # "session" | "all"
    session_id: Optional[str] = None
    instrument: Optional[str] = None


def parse_scope(run_id: str) -> Scope:
    if run_id == ALL_RUN_ID:
        return Scope(kind="all", instrument=None)
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
    # A multi-asset session belongs to the pool of each of its assets (G7).
    return [
        bts.get_session(s.id)
        for s in summaries
        if scope.instrument is None or scope.instrument in (s.assets or [s.instrument])
    ]


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
            # A pooled scope plots one instrument's price scale: only that instrument's trades.
            if scope.kind == "all" and scope.instrument is not None and t.instrument != scope.instrument:
                continue
            d = t.model_dump()
            ts = pd.Timestamp(d["entry_time"], unit="s", tz="UTC")
            day = trading_day_of(ts, sessions_cfg)
            row = {c: d.get(c) for c in rb.TRADE_COLUMNS}
            # The journal doesn't stamp the CME trading day on a trade; it's
            # a pure function of entry_time, derived here exactly as the
            # engine's run bundle derives it.
            row["trading_day"] = day.isoformat() if day else None
            row["source"] = d.get("source") or "manual"      # "manual" | "bot" (Autopilot, server-written)
            row["bot_segment"] = d.get("bot_segment")
            row["session_id"] = s.id
            row["session_trade_id"] = d["trade_id"]
            row["tags"] = list(d.get("tags") or [])
            row["setup_name"] = d.get("setup_name")
            row["grade"] = d.get("grade")
            row["exits"] = list(d.get("exits") or [])
            row["entry_sl_price"] = d.get("entry_sl_price")
            row["entry_tp_price"] = d.get("entry_tp_price")
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

@dataclass(frozen=True)
class Leg:
    """One exit of a trade, as the timeline sees it."""
    ts: pd.Timestamp
    pnl_usd: float
    contracts: int
    mae_points: float


def _legs(t) -> List[Leg]:
    """A trade's exits in time order. A partial exit hits the timeline at ITS
    OWN exit time with its own P&L (so a day-1 partial and a day-2 final land
    on their own trading days, EOD balances and daily-loss tallies), while the
    journal and trade statistics still see one trade. A trade journaled before
    exits existed (or with none) is one leg at its exit time."""
    exits = list(t.exits) if isinstance(t.exits, list) else []
    if not exits:
        return [Leg(t.exit_time, float(t.pnl_usd), int(t.size_contracts), float(t.mae_points))]
    legs = []
    for e in sorted(exits, key=lambda e: e["time"]):
        mae = e.get("mae_points")
        legs.append(Leg(
            pd.Timestamp(e["time"], unit="s", tz="UTC"),
            float(e["pnl_usd"]),
            int(e["contracts"]),
            float(t.mae_points if mae is None else mae),
        ))
    return legs

@dataclass(frozen=True)
class LiveState:
    mll_floor: float
    mll_frozen: bool
    day_start_balance: float
    daily_locked: bool
    daily_pnls: Dict
    in_day: bool
    target_hit: bool
    consistency_passed: Optional[bool]


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
    # PropRulesTracker's state after the walk (and the optional `mark`), read
    # before the day is closed out: what the prop-rules modal reports.
    live: Optional["LiveState"] = None
    balance: float = 0.0


def _unix(ts: pd.Timestamp) -> int:
    return int(ts.value // 1_000_000_000)


def session_engine_config(session: models.BacktestSessionDetail) -> PropRulesConfig:
    """The tracker config a prop session is judged by: its own saved rules (the
    Topstep preset, or a custom rule set) turned into propbt's PropRulesConfig."""
    acct = session.account
    return prop_presets.engine_config(acct.prop_rules, acct.starting_balance, acct.commissions)


def _trade_span(t) -> Tuple[pd.Timestamp, pd.Timestamp]:
    """First entry to last exit of a trade."""
    return t.entry_time, max(l.ts for l in _legs(t))


def _units(rows: List) -> List[List[int]]:
    """Positions of `rows` grouped into time-disjoint units, oldest first. A unit
    is one trade, or -- when positions in two instruments were open together --
    all the trades that overlap one another (their open P&L adds up, so they are
    walked as a whole). Same-instrument trades never overlap (one position at a
    time), so a single-asset session is always one trade per unit."""
    spans = [_trade_span(t) for t in rows]
    order = sorted(range(len(rows)), key=lambda i: (spans[i][0], i))
    units: List[List[int]] = []
    unit_end = None
    for i in order:
        start, end = spans[i]
        if units and unit_end is not None and start < unit_end:
            units[-1].append(i)
            unit_end = max(unit_end, end)
        else:
            units.append([i])
            unit_end = end
    return units


def _minute_marks(instrument: str, start: pd.Timestamp, end: pd.Timestamp) -> Optional[pd.DataFrame]:
    """The instrument's 1m bars over [start, end] (high / low / close), or None
    when there is no data to mark against."""
    try:
        raw = bar_service._load_raw(instrument)
    except bar_service.UnknownInstrument:
        return None
    return raw.loc[start:end, ["high", "low", "close"]]


def replay_prop_rules(
    df: pd.DataFrame,
    instrument: str,
    cfg: PropRulesConfig,
    mark: Optional[Tuple[pd.Timestamp, float]] = None,
) -> PropReplay:
    """Feeds a session's manual trades through the SAME PropRulesTracker the
    automated backtest uses (propbt/engine/prop_rules.py) -- no rule is
    re-implemented here.

    The rules are judged on ONE account: the balance, the trailing floor, the daily
    loss and the consistency day are shared by every instrument the session trades
    (FXR_V2_SPEC.md section 4, G7). `instrument` is only the fallback for a trade
    that carries none.

    The sim journals closed trades, not a per-bar equity log, so the tracker
    is driven at trade resolution: per trade, once at entry (balance, flat
    equity), once at exit with the trade's worst point (pre-trade balance
    minus its MAE in dollars -- the live-equity low the engine's per-bar
    check would have seen) and once more at exit with the realized balance.
    Because MAE is the trade's lowest equity, this reaches the same MLL-breach
    verdict a per-bar replay would. An INTRADAY-trailing floor also rises with
    the trade's best point (its MFE), which is observed first: the journal does
    not record whether the high or the low came first inside a trade, so it
    assumes the high did -- the stricter order, which can only fail a session
    a per-bar replay would have passed, never the reverse. What it cannot recover is *when inside
    the trade* the low happened, so an intratrade breach is stamped at the
    trade's exit time. Limitations (documented, not hidden): the MAE low
    excludes commission, and a partial-close slice's MAE ignores the
    still-open remainder's float at the moment of the partial.

    Partial exits (3.6): the same walk is done PER EXIT -- each exit observes
    its low point (that exit's own MAE x the contracts still open until it) and
    then its realized balance at its own time and trading day. So the day
    boundary closes with the balance as it really stood (the EOD balance that
    trails/freezes the MLL), and the daily-loss limit sees each exit's loss on
    the day it happened.

    Positions open in two instruments at once (G7) are one drawdown: a trade's
    own MAE says nothing about what the other position was doing then, so a unit
    of overlapping trades is walked minute by minute on the 1m bars
    (`_replay_overlap`), adding both positions' open P&L into the account's equity.

    `mark` = (time, open P&L): once every journaled trade has been walked and the
    Combine is still open, the account is observed ONE more time at that moment
    with the open position's float added to the realized balance -- the live
    reading the prop-rules modal shows mid-session. The float is the sim broker's
    own number; the tracker judges it (a floor breach or a daily-loss lock
    included).
    """
    specs = load_contracts()
    tracker = PropRulesTracker(cfg)
    replay = PropReplay(combine=None)  # type: ignore[arg-type]

    balance = cfg.start_balance
    target_level = cfg.start_balance + cfg.profit_target
    sessions_cfg = load_sessions()

    def observe(ts: pd.Timestamp, day, bal: float, eq: float, keep_row: bool = True):
        st = tracker.on_bar(ts, day, bal, eq)
        row = {
            "time": ts,
            "balance": bal,
            "open_pnl": eq - bal,
            "equity": eq,
            "mll_floor": tracker.mll_floor,
            "daily_loss_floor": (
                float("nan") if cfg.daily_loss_limit is None else tracker.day_start_balance - cfg.daily_loss_limit
            ),
            "target_level": target_level,
            "trading_day": day.isoformat() if day else None,
            "day_start_balance": tracker.day_start_balance,
            "breached": tracker.failed,
            "daily_locked": tracker.daily_locked,
        }
        if keep_row:
            replay.rows.append(row)
        replay.samples.append(row)
        return st

    def spec_of(t):
        return specs[getattr(t, "instrument", None) or instrument]

    rows = list(df.itertuples(index=False))
    for unit in _units(rows):
        if len(unit) > 1:
            balance, resolved_by = _replay_overlap([(i, rows[i]) for i in unit], spec_of, cfg, balance, observe, sessions_cfg)
            if resolved_by is not None:
                i, t, ts = resolved_by
                last = replay.samples[-1]
                replay.resolved_time = _unix(ts)
                replay.resolved_trade_id = int(t.trade_id)
                replay.trades_to_result = i + 1
                replay.equity_at_result = float(last["equity"])
                replay.mll_floor_at_result = float(last["mll_floor"])
                break
            continue

        i = unit[0]
        t = rows[i]
        spec = spec_of(t)
        entry_ts = t.entry_time
        day_in = trading_day_of(entry_ts, sessions_cfg)

        observe(entry_ts, day_in, balance, balance)

        resolved = False
        open_contracts = int(t.size_contracts)
        first_leg = True
        for leg in _legs(t):
            leg_day = trading_day_of(leg.ts, sessions_cfg)
            if first_leg and cfg.mll_type == "intraday_trailing" and float(t.mfe_points) > 0:
                # The trade's high: lifts the trailing floor before the low is seen.
                mfe_usd = float(t.mfe_points) * spec.point_value * open_contracts
                observe(leg.ts, leg_day, balance, balance + mfe_usd)
                replay.rows.pop()
            first_leg = False
            mae_usd = leg.mae_points * spec.point_value * open_contracts
            st = observe(leg.ts, leg_day, balance, balance - mae_usd)
            resolved = st.failed
            if not resolved:
                balance += leg.pnl_usd
                # Replace the low-point row's equity with the realized point: the
                # low only feeds the breach verdict and daily-risk samples, it is
                # not a timeline vertex (same timestamp as the exit row below).
                replay.rows.pop()
                st = observe(leg.ts, leg_day, balance, balance)
                resolved = st.failed or st.passed
            open_contracts -= leg.contracts
            if resolved:
                break
        if resolved:
            last = replay.rows[-1]
            replay.resolved_time = _unix(last["time"])
            replay.resolved_trade_id = int(t.trade_id)
            replay.trades_to_result = i + 1
            replay.equity_at_result = float(last["equity"])
            replay.mll_floor_at_result = float(last["mll_floor"])
            break

    if mark is not None and replay.resolved_time is None and not (tracker.failed or tracker.passed):
        ts, open_pnl = mark
        observe(ts, trading_day_of(ts, sessions_cfg), balance, balance + open_pnl, keep_row=False)
        if tracker.failed:
            replay.resolved_time = _unix(ts)

    # `finalize` closes the open trading day (trailing the floor, logging it), which
    # is right for the verdict but would misreport "where things stand right now":
    # snapshot the live state first.
    replay.live = LiveState(
        mll_floor=tracker.mll_floor,
        mll_frozen=tracker.mll_frozen,
        day_start_balance=tracker.day_start_balance,
        daily_locked=tracker.daily_locked,
        daily_pnls=dict(tracker.daily_pnls),
        in_day=tracker.current_trading_day is not None,
        target_hit=tracker.target_hit,
        consistency_passed=tracker.consistency_passed,
    )
    replay.combine = tracker.finalize(balance)
    replay.balance = balance
    return replay


def replay_prop_rules_per_bar(
    df: pd.DataFrame,
    instrument: str,
    cfg: PropRulesConfig,
    bot_rows: List[Tuple[int, float, float, str]],
    bot_balance: float,
    mark: Optional[Tuple[pd.Timestamp, float]] = None,
) -> PropReplay:
    """The verdict of a session with an Autopilot run on it (G10): ONE account walked bar
    by bar through the SAME PropRulesTracker, per source.

    Bot exposure is what the engine already marked: `bot_rows` is the engine's own
    per-bar log (balance, close-marked equity, trading day), observed as it is. Manual
    exposure is marked the way the journal always has been -- at the bar's extreme
    against the position (a long's low, a short's high), the MAE convention, with an
    intraday-trailing floor seeing the favourable extreme first and exits realizing
    after the bar's low. The account's balance is bot balance + manual realized; its
    equity is bot equity + manual float. So with no manual trade the observations are
    exactly the engine's (the same numbers into the same tracker), and a session with
    no bot keeps `replay_prop_rules`, untouched.

    Minutes on the grid: every bar the engine consumed, plus the bars of each manual
    trade's life. `bot_balance` is the engine portfolio's final balance (it includes a
    forced flatten booked after the last logged bar).
    """
    specs = load_contracts()
    sessions_cfg = load_sessions()
    tracker = PropRulesTracker(cfg)
    replay = PropReplay(combine=None)  # type: ignore[arg-type]
    target_level = cfg.start_balance + cfg.profit_target

    def observe(ts: pd.Timestamp, day, bal: float, eq: float, keep_row: bool = True):
        st = tracker.on_bar(ts, day, bal, eq)
        row = {
            "time": ts, "balance": bal, "open_pnl": eq - bal, "equity": eq, "mll_floor": tracker.mll_floor,
            "daily_loss_floor": (
                float("nan") if cfg.daily_loss_limit is None else tracker.day_start_balance - cfg.daily_loss_limit
            ),
            "target_level": target_level,
            "trading_day": day.isoformat() if day else None,
            "day_start_balance": tracker.day_start_balance,
            "breached": tracker.failed, "daily_locked": tracker.daily_locked,
        }
        if keep_row:
            replay.rows.append(row)
        replay.samples.append(row)
        return st

    all_rows = list(df.itertuples(index=False))
    infos = []
    for t in all_rows:
        if getattr(t, "source", "manual") == "bot":
            continue
        legs = _legs(t)
        sym = getattr(t, "instrument", None) or instrument
        end = max(l.ts for l in legs)
        infos.append({
            "t": t, "spec": specs[sym], "legs": legs, "sign": 1 if t.side == "long" else -1,
            "entry": t.entry_time, "end": end, "size": int(t.size_contracts),
            "entry_price": float(t.entry_price), "mark": float(t.entry_price),
            "bars": _minute_marks(sym, t.entry_time, end),
        })

    bot_by_ts = {pd.Timestamp(r[0], unit="s", tz="UTC"): r for r in bot_rows}
    grid = set(bot_by_ts)
    for x in infos:
        grid.add(x["entry"])
        grid.update(l.ts for l in x["legs"])
        if x["bars"] is not None:
            grid.update(x["bars"].index)

    def open_before(x, m):  # contracts open while minute m trades (exits at m not yet taken)
        return x["size"] - sum(l.contracts for l in x["legs"] if l.ts < m)

    def open_after(x, m):  # contracts still open once minute m's exits are taken
        return x["size"] - sum(l.contracts for l in x["legs"] if l.ts <= m)

    def float_at(x, price, contracts):
        return x["sign"] * (price - x["entry_price"]) * x["spec"].point_value * contracts

    bot_b = bot_e = cfg.start_balance
    manual_realized = 0.0
    last_bot_ts = max(bot_by_ts) if bot_by_ts else None
    resolved_at: Optional[pd.Timestamp] = None

    for m in sorted(grid):
        r = bot_by_ts.get(m)
        if r is not None:
            bot_b, bot_e, day = r[1], r[2], dt.date.fromisoformat(r[3])
        else:
            day = trading_day_of(m, sessions_cfg)
        balance = bot_b + manual_realized

        for x in infos:  # a manual entry: the account's first sight of the position
            if x["entry"] == m:
                carried = sum(float_at(y, y["mark"], open_after(y, m)) for y in infos if y is not x and y["entry"] < m < y["end"])
                observe(m, day, balance, bot_e + carried, keep_row=False)

        worst = best = 0.0
        for x in infos:
            if not (x["entry"] < m <= x["end"]):
                continue
            n = open_before(x, m)
            bars = x["bars"]
            if bars is not None and m in bars.index:
                bar = bars.loc[m]
                x["mark"] = float(bar["close"])
                adverse, favourable = (bar["low"], bar["high"]) if x["sign"] == 1 else (bar["high"], bar["low"])
                w, b = float_at(x, float(adverse), n), float_at(x, float(favourable), n)
            elif bars is None:
                mae = max((l.mae_points for l in x["legs"] if l.ts >= m), default=0.0)
                w, b = -mae * x["spec"].point_value * n, 0.0
            else:  # a gap in this instrument's bars: the open P&L where it last was
                w = b = float_at(x, x["mark"], n)
            worst += w
            best += b

        if cfg.mll_type == "intraday_trailing" and best > 0:
            observe(m, day, balance, bot_e + best, keep_row=False)
        st = observe(m, day, balance, bot_e + worst)
        if st.failed or st.passed:
            resolved_at = m
            break

        exits = [l for x in infos for l in x["legs"] if l.ts == m]
        if exits:
            for l in exits:
                manual_realized += l.pnl_usd
            carried = sum(float_at(y, y["mark"], open_after(y, m)) for y in infos if y["entry"] < m and open_after(y, m) > 0)
            st = observe(m, day, bot_b + manual_realized, bot_e + carried)
            if st.failed or st.passed:
                resolved_at = m
                break

    if resolved_at is not None:
        order = sorted(all_rows, key=lambda t: (t.exit_time, t.entry_time))
        live_now = [t for t in all_rows if t.entry_time <= resolved_at <= t.exit_time]
        pick = max(live_now, key=lambda t: t.entry_time) if live_now else next(
            (t for t in reversed(order) if t.exit_time <= resolved_at), None)
        last = replay.rows[-1]
        replay.resolved_time = _unix(resolved_at)
        replay.resolved_trade_id = int(pick.trade_id) if pick is not None else None
        replay.trades_to_result = 1 + sum(1 for t in all_rows if t.exit_time < resolved_at)
        replay.equity_at_result = float(last["equity"])
        replay.mll_floor_at_result = float(last["mll_floor"])
    elif mark is not None and not (tracker.failed or tracker.passed):
        ts, open_pnl = mark
        observe(ts, trading_day_of(ts, sessions_cfg), bot_b + manual_realized, bot_b + manual_realized + open_pnl, keep_row=False)
        if tracker.failed:
            replay.resolved_time = _unix(ts)

    # The tracker's live state before `finalize` closes the day.
    replay.live = LiveState(
        mll_floor=tracker.mll_floor, mll_frozen=tracker.mll_frozen, day_start_balance=tracker.day_start_balance,
        daily_locked=tracker.daily_locked, daily_pnls=dict(tracker.daily_pnls),
        in_day=tracker.current_trading_day is not None, target_hit=tracker.target_hit,
        consistency_passed=tracker.consistency_passed,
    )
    # The engine's final balance counts a flatten booked at its last logged bar; a verdict
    # reached earlier (by the manual side) is the bot's balance as of that bar.
    use_final_bot = resolved_at is None or (last_bot_ts is not None and resolved_at >= last_bot_ts)
    final_balance = (bot_balance if use_final_bot else bot_b) + manual_realized
    replay.combine = tracker.finalize(final_balance)
    replay.balance = final_balance
    return replay


def _replay_overlap(members, spec_of, cfg, balance, observe, sessions_cfg):
    """Walks trades in different instruments that were open at the same time, one
    1m bar at a time, as ONE account. `members` is [(position in the frame, trade)].

    Each minute the account's equity low is the realized balance plus every open
    position's worst open P&L that minute (a long's bar low, a short's bar high, x
    the contracts still open x the point value) -- the same excursion convention
    as a trade's MAE, summed across instruments. Two positions' extremes are not
    known to coincide inside one minute, so summing them is the conservative
    reading, as the journal's MAE ordering already is. An intraday-trailing floor
    sees the minute's high first. An exit realizes at its own minute, after that
    minute's low. A combined breach (the daily loss or the MLL) is stamped at the
    minute it happened, not at the end of a trade. Commission is realized with an
    exit's P&L (it is in pnl_usd), as everywhere else.

    Returns (balance after the unit, (frame position, trade, time) of what resolved
    the Combine, or None). With no 1m data to mark against it falls back to each
    trade's own MAE, as a single-instrument trade is judged."""
    infos = []
    for i, t in members:
        legs = _legs(t)
        infos.append({
            "i": i, "t": t, "spec": spec_of(t), "legs": legs, "sign": 1 if t.side == "long" else -1,
            "entry": t.entry_time, "end": max(l.ts for l in legs), "size": int(t.size_contracts),
            "entry_price": float(t.entry_price), "mark": float(t.entry_price),
        })
    start = min(x["entry"] for x in infos)
    end = max(x["end"] for x in infos)
    by_symbol = {}
    for x in infos:
        sym = getattr(x["t"], "instrument", None)
        if sym not in by_symbol:
            by_symbol[sym] = _minute_marks(sym, start, end)
        x["bars"] = by_symbol[sym]

    grid = {x["entry"] for x in infos} | {l.ts for x in infos for l in x["legs"]}
    for b in by_symbol.values():
        if b is not None:
            grid |= set(b.index)

    def open_before(x, m):  # contracts open while minute m trades (exits at m not yet taken)
        return x["size"] - sum(l.contracts for l in x["legs"] if l.ts < m)

    def open_after(x, m):  # contracts still open once minute m's exits are taken
        return x["size"] - sum(l.contracts for l in x["legs"] if l.ts <= m)

    def float_at(x, price, contracts):
        return x["sign"] * (price - x["entry_price"]) * x["spec"].point_value * contracts

    for m in sorted(grid):
        day = trading_day_of(m, sessions_cfg)
        for x in infos:  # an entry: the account's first sight of the position
            if x["entry"] == m:
                carried = sum(float_at(y, y["mark"], open_after(y, m)) for y in infos if y is not x and y["entry"] < m < y["end"])
                observe(m, day, balance, balance + carried)

        live = [x for x in infos if x["entry"] < m <= x["end"]]
        if live:
            worst = best = 0.0
            deepest, deepest_loss = live[0], 0.0
            for x in live:
                n = open_before(x, m)
                bars = x["bars"]
                if bars is not None and m in bars.index:
                    bar = bars.loc[m]
                    x["mark"] = float(bar["close"])
                    adverse, favourable = (bar["low"], bar["high"]) if x["sign"] == 1 else (bar["high"], bar["low"])
                    w, b = float_at(x, float(adverse), n), float_at(x, float(favourable), n)
                elif bars is None:
                    mae = max((l.mae_points for l in x["legs"] if l.ts >= m), default=0.0)
                    w, b = -mae * x["spec"].point_value * n, 0.0
                else:  # a gap in this instrument's bars: the open P&L where it last was
                    w = b = float_at(x, x["mark"], n)
                worst += w
                best += b
                if w < deepest_loss:
                    deepest, deepest_loss = x, w
            if cfg.mll_type == "intraday_trailing" and best > 0:
                observe(m, day, balance, balance + best, keep_row=False)
            if observe(m, day, balance, balance + worst, keep_row=False).failed:
                return balance, (deepest["i"], deepest["t"], m)

        for x in infos:  # exits realize after the minute's low
            for leg in x["legs"]:
                if leg.ts != m:
                    continue
                balance += leg.pnl_usd
                carried = sum(float_at(y, y["mark"], open_after(y, m)) for y in infos if y["entry"] < m and open_after(y, m) > 0)
                st = observe(m, day, balance, balance + carried)
                if st.failed or st.passed:
                    return balance, (x["i"], x["t"], m)
    return balance, None


def _session_replay(run_id: str) -> Tuple[Optional[models.BacktestSessionDetail], pd.DataFrame, Optional[PropReplay]]:
    sessions = _sessions_in_scope(run_id)
    df = _build_frame(run_id, sessions)
    scope = parse_scope(run_id)
    if scope.kind == "session" and sessions and sessions[0].account.prop_ruleset:
        return sessions[0], df, replay_for_session(sessions[0], df)
    return (sessions[0] if scope.kind == "session" and sessions else None), df, None


def replay_for_session(session: models.BacktestSessionDetail, df: pd.DataFrame, mark=None) -> PropReplay:
    """A prop session's replay: the trade-resolution walk, or -- once Autopilot has run on it --
    the per-bar walk over the engine's log (see replay_prop_rules_per_bar)."""
    cfg = session_engine_config(session)
    ap = session.autopilot
    if ap is not None:
        from app.backend.services import autopilot_service

        # The per-bar walk is O(bars): every stats / equity / meta request and the home list's
        # prop status would repeat it. A live `mark` is a one-off reading and is never cached;
        # the cached walk is keyed by the three files it is a function of.
        key = _walk_key(session.id) if mark is None else None
        if key is not None and key in _WALK_CACHE:
            return _WALK_CACHE[key]
        replay = replay_prop_rules_per_bar(
            df, session.instrument, cfg, autopilot_service.read_equity_rows(session.id), ap.bot_balance, mark=mark,
        )
        if key is not None:
            if len(_WALK_CACHE) >= 16:
                _WALK_CACHE.pop(next(iter(_WALK_CACHE)))
            _WALK_CACHE[key] = replay
        return replay
    return replay_prop_rules(df, session.instrument, cfg, mark=mark)


_WALK_CACHE: Dict[tuple, PropReplay] = {}


def _walk_key(session_id: str) -> Optional[tuple]:
    """(dir, id, and the size + mtime of session.json / trades.json / autopilot_equity.jsonl): any
    save, journal write or engine step changes it. None if a file cannot be read."""
    d = bts._session_dir(session_id)
    try:
        parts = []
        for name in ("session.json", "trades.json", "autopilot_equity.jsonl"):
            f = d / name
            if f.exists():
                st = f.stat()
                parts.append((name, st.st_size, st.st_mtime_ns))
            else:
                parts.append((name, 0, 0))
        return (str(d), *parts)
    except OSError:
        return None


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
        name = s.name or f"Manual session {'/'.join(s.assets or [s.instrument])} {s.base_timeframe}"
        created_at, timeframe = s.created_at, s.base_timeframe
    else:
        name = f"All {scope.instrument} manual sessions" if scope.instrument else "All manual sessions"
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
        instruments=(
            list(sessions[0].assets or [sessions[0].instrument])
            if scope.kind == "session" and sessions
            else ([scope.instrument] if scope.instrument else sorted({a for x in sessions for a in (x.assets or [x.instrument])}))
        ),
        autopilot_sessions=sum(1 for x in sessions if x.autopilot is not None),
        autopilot_interrupted=any(x.autopilot is not None and x.autopilot.interrupted for x in sessions),
        autopilot_interruptions=sum(max(0, len(x.autopilot.segments) - 1) for x in sessions if x.autopilot is not None),
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
        sessions_cfg = load_sessions()
        for t in df.itertuples(index=False):
            legs = _legs(t)
            for leg in legs:
                balance += leg.pnl_usd
                if len(legs) == 1:
                    day = t.trading_day
                else:  # each exit of a split trade sits on its own trading day
                    d = trading_day_of(leg.ts, sessions_cfg)
                    day = d.isoformat() if d else None
                rows.append(_plain_row(leg.ts, balance, day))
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
    instrument: Optional[str] = None,
    source: Optional[str] = None,
) -> models.StatsResponse:
    _, df_all, replay = _session_replay(run_id)
    df = filter_trades_frame(
        df_all, session=session, tag=tag, setup=setup, grade=grade, session_id=session_id, hour_ny=hour_ny,
        instrument=instrument, source=source,
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
        by_source=_breakdown(df, df["source"].fillna("manual")) if len(df) else {},
        by_backtest_session=_breakdown(df, df["session_id"]) if multi_session else {},
        result=result,
    )


# ------------------------ the Analytics page (G8) ---------------------------

MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri"]


def _scoped_frame(run_id: str, instrument: Optional[str]) -> pd.DataFrame:
    df = load_trades_frame(run_id)
    if instrument and len(df):
        df = df[df["instrument"] == instrument].reset_index(drop=True)
    return df


def _bucket(trades: int, wins: int, pnl: float, key: str, label: str) -> models.PeriodBucket:
    return models.PeriodBucket(
        key=key, label=label, trades=trades, wins=wins, net_pnl_usd=pnl,
        win_rate=(wins / trades) if trades else None,
    )


def _period_average(total: float, periods: int) -> models.PeriodAverage:
    return models.PeriodAverage(value=(total / periods) if periods else None, periods=periods)


def analytics_summary(run_id: str, instrument: Optional[str] = None) -> models.AnalyticsSummary:
    """Everything the Analytics page's stat tiles and charts show, aggregated
    server-side from the same trades frame `/trades` serves -- so the page and
    the trades table can never disagree.

    Day / week / month are the CME trading day of the trade's ENTRY (the label the
    journal frame already carries), so every trade sits in exactly one bucket and
    the buckets sum to the total. An "average gain per period" is the total net
    P&L over the periods that have at least one trade (a day with no trade is not
    a day of the sample)."""
    sessions = _sessions_in_scope(run_id)
    df = _scoped_frame(run_id, instrument)
    base = rb.compute_run_stats(df)["overall"]

    stats = models.AnalyticsStats(
        trades=base["trades"],
        net_pnl_usd=base["net_pnl_usd"],
        win_rate=base["win_rate"],
        profit_factor=base["profit_factor"],
        avg_r=base["expectancy_r"],
    )
    monthly: List[models.PeriodBucket] = []
    weekday: List[models.PeriodBucket] = [
        _bucket(0, 0, 0.0, str(i), label) for i, label in enumerate(WEEKDAY_LABELS)
    ]
    heat = models.HeatOnWinners()
    equity: List[models.EquityStep] = []

    if len(df):
        pnl = df["pnl_usd"].astype(float)
        wins_mask = pnl > 0
        stats.wins = int(wins_mask.sum())
        stats.losses = int((pnl < 0).sum())
        stats.gross_profit_usd = float(pnl[wins_mask].sum())
        stats.gross_loss_usd = float(-pnl[pnl < 0].sum())
        stats.avg_win_usd = float(pnl[wins_mask].mean()) if stats.wins else None
        stats.avg_loss_usd = float(pnl[pnl < 0].mean()) if stats.losses else None
        stats.r_trades = int(df["r_multiple"].notna().sum())
        # Planned R:R at entry, from the stop AND target the position was opened with
        # (a level moved or added later is not an entry level). A level on the wrong
        # side of the entry is not a plan and is left out.
        both = df.dropna(subset=["entry_sl_price", "entry_tp_price"])
        if len(both):
            sign = both["side"].map({"long": 1.0, "short": -1.0})
            risk = sign * (both["entry_price"] - both["entry_sl_price"].astype(float))
            reward = sign * (both["entry_tp_price"].astype(float) - both["entry_price"])
            ok = (risk > 0) & (reward > 0)
            if ok.any():
                stats.planned_rr_trades = int(ok.sum())
                stats.avg_planned_rr = float((reward[ok] / risk[ok]).mean())

        days = pd.to_datetime(df["trading_day"], errors="coerce")
        dated = df.assign(_day=days, _pnl=pnl, _win=wins_mask).dropna(subset=["_day"])
        total_dated = float(dated["_pnl"].sum())
        stats.avg_gain_day = _period_average(total_dated, int(dated["_day"].nunique()))
        iso = dated["_day"].dt.isocalendar()
        stats.avg_gain_week = _period_average(total_dated, int(len(set(zip(iso["year"], iso["week"])))))
        months = dated["_day"].dt.strftime("%Y-%m")
        stats.avg_gain_month = _period_average(total_dated, int(months.nunique()))

        for key, g in dated.groupby(months, sort=True):
            y, m = str(key).split("-")
            monthly.append(_bucket(len(g), int(g["_win"].sum()), float(g["_pnl"].sum()), str(key), f"{MONTH_LABELS[int(m) - 1]} {y}"))
        for wd, g in dated.groupby(dated["_day"].dt.weekday):
            if 0 <= wd < 5:
                weekday[int(wd)] = _bucket(len(g), int(g["_win"].sum()), float(g["_pnl"].sum()), str(int(wd)), WEEKDAY_LABELS[int(wd)])

        winners_heat = df.loc[wins_mask & df["mae_r"].notna(), "mae_r"].astype(float)
        if len(winners_heat):
            heat = models.HeatOnWinners(
                sample=int(len(winners_heat)), avg_r=float(winners_heat.mean()),
                max_r=float(winners_heat.max()), min_r=float(winners_heat.min()),
            )

        # Cumulative realized P&L, one step per exit (a partial exit steps on its own time).
        steps = sorted((l.ts, l.pnl_usd) for t in df.itertuples(index=False) for l in _legs(t))
        running = 0.0
        for ts, p in steps:
            running += p
            equity.append(models.EquityStep(time=_unix(ts), pnl_usd=running))

    instruments = sorted({a for s in sessions for a in (s.assets or [s.instrument])})
    scope = parse_scope(run_id)
    return models.AnalyticsSummary(
        run_id=run_id,
        instrument=instrument,
        instruments=instruments,
        sessions=[
            models.AnalyticsSession(id=s.id, name=s.name or f"{'/'.join(s.assets or [s.instrument])} · {s.id[:6]}", assets=list(s.assets or [s.instrument]))
            for s in sessions
        ],
        starting_balance=sessions[0].account.starting_balance if scope.kind == "session" and sessions else None,
        stats=stats,
        equity=equity,
        monthly=monthly,
        weekday=weekday,
        heat=heat,
    )


def rr_simulation(run_id: str, instrument: Optional[str] = None) -> models.RrSimulatorResponse:
    from app.backend.services import rr_simulator

    return rr_simulator.simulate(_sessions_in_scope(run_id), instrument=instrument, scope=run_id)


# ---------------------- the prop-rules modal (G8) ---------------------------

class NotAPropSession(Exception):
    pass


def prop_rules_status(session_id: str, open_pnl: float = 0.0, cursor_time: Optional[int] = None) -> models.PropRulesStatus:
    """The session's standing against its rules, read from PropRulesTracker after
    replaying the journaled trades, plus one observation at the cursor with
    `open_pnl` (the open position's float, a sim-broker number) added to the
    realized balance. `used` / `left` are differences of tracker values -- the
    floor, the day's starting balance, the realized balance -- computed here so the
    frontend only draws them."""
    session = bts.get_session(session_id)
    acct = session.account
    if acct.prop_rules is None:
        raise NotAPropSession(session_id)
    cfg = session_engine_config(session)
    df = load_trades_frame(MANUAL_PREFIX + session_id)
    at = cursor_time if cursor_time is not None else session.cursor_time
    # The open float is the manual position's (a sim-broker number the browser sends) plus
    # the bot's, which the engine marked at its last bar.
    bot_float = float(session.autopilot.position.unrealized_usd) if session.autopilot and session.autopilot.position else 0.0
    open_pnl = float(open_pnl) + bot_float
    replay = replay_for_session(session, df, mark=(pd.Timestamp(at, unit="s", tz="UTC"), float(open_pnl)))
    combine, live = replay.combine, replay.live
    assert live is not None

    start = cfg.start_balance
    balance = replay.balance
    # A resolved Combine stops being marked: the float no longer counts.
    live_open = 0.0 if combine.status != "incomplete" else float(open_pnl)
    equity = balance + live_open

    profit_used = balance - start
    loss_budget = float(cfg.mll_initial_offset)
    to_floor = max(0.0, equity - live.mll_floor)
    loss_used = min(loss_budget, max(0.0, loss_budget - to_floor))
    if combine.status == "failed":
        loss_used, to_floor = loss_budget, 0.0

    daily_limit = cfg.daily_loss_limit
    if daily_limit is None:
        daily = models.PropProgress()
    else:
        used = min(float(daily_limit), max(0.0, live.day_start_balance - equity))
        daily = models.PropProgress(
            limit=float(daily_limit), used=used, left=float(daily_limit) - used, fraction=used / daily_limit,
        )

    best_day = None
    if live.daily_pnls or live.in_day:
        today = balance - live.day_start_balance if live.in_day else 0.0
        best_day = max([today, *live.daily_pnls.values()])

    return models.PropRulesStatus(
        status=combine.status,
        fail_reason=combine.fail_reason,
        label="Topstep $50k Combine" if acct.prop_ruleset == prop_presets.TOPSTEP_50K else "Custom prop rules",
        starting_balance=start,
        balance=balance,
        open_pnl=live_open,
        equity=equity,
        profit=models.PropProgress(
            limit=float(cfg.profit_target),
            used=profit_used,
            left=max(0.0, cfg.profit_target - profit_used),
            fraction=min(1.0, max(0.0, profit_used / cfg.profit_target)),
        ),
        max_loss=models.PropProgress(
            limit=loss_budget, used=loss_used, left=to_floor, fraction=(loss_used / loss_budget) if loss_budget else 0.0,
        ),
        max_loss_floor=float(live.mll_floor),
        max_loss_type=cfg.mll_type,
        max_loss_frozen=bool(live.mll_frozen),
        daily_loss=daily,
        daily_locked=bool(live.daily_locked),
        day_start_balance=float(live.day_start_balance),
        target_hit=bool(live.target_hit),
        consistency_pct=None if cfg.consistency_max_pct is None else cfg.consistency_max_pct * 100,
        consistency_passed=live.consistency_passed,
        best_day_pnl=best_day,
        best_day_share=(best_day / profit_used) if best_day is not None and profit_used > 0 else None,
        trading_days=len(combine.day_logs),
        rules=prop_presets.rules_rows(cfg, acct.prop_rules),
        restrictions=prop_presets.restriction_rows(acct.prop_rules),
    )
