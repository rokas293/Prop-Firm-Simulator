"""FXR_V2_SPEC.md section 6 (G8): the RR simulator, "what if my target had been nR".

For every journaled trade that carried a stop-loss AT ENTRY, the real 1-minute
path from the entry is replayed with the trade's own stop and a target at
n x the entry risk, for n = 1..10. A counterfactual trade ends at the first of

  * the stop (the stop the position was opened with, never one added or moved
    later -- `entry_sl_price`, see models.TradeRecord),
  * the new target,
  * the session's end-of-day flatten (below),

and a minute that touches both the stop and the target resolves as the stop,
the same ambiguity rule the sim broker and the engine use.

What it does NOT do: invent fills. Prices come from the instrument's own 1m bars
(`bar_service`), exits fill at the stop / target price or at the flatten bar's
close, and the path never runs past the last bar the session revealed
(`cursor_time`), so an unfinished session is not judged on data it has not
shown. Nothing here feeds back into a trade, a balance or a prop rule.

End-of-day flatten, per session:
  * a prop session with no-overnight / no-weekend flattens at its `close_time`
    ET (every weekday / Fridays only) -- the same arithmetic as the replay's
    chart/holdingRestrictions.ts: a close is reached by the first bar that ENDS at
    or after it, which is then the exit bar (filled at its close); a close that
    falls in a gap goes to the last bar before it;
  * any other session flattens at the CME trading-day close (17:00 ET), so a
    counterfactual never runs on for days.

Entry bar: a market entry fills at its bar's close (the bar is already fully
revealed), so the path starts on the NEXT bar. A resting order that filled
intrabar (entry price is not the entry bar's close) is still inside its entry
bar, whose own range is judged too -- otherwise a trade the real sim stopped out
in its entry bar could be "won" by the counterfactual.
"""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np
import pandas as pd
from zoneinfo import ZoneInfo

from app.backend import models
from app.backend.services import bar_service
from propbt.config import load_contracts, load_sessions

MIN_TRADES = 3
MAX_R = 10
ET = ZoneInfo("America/New_York")

EXCLUDE_NO_STOP = "no_stop_at_entry"
EXCLUDE_NO_DATA = "no_price_data"
EXCLUDE_OPEN = "still_open"
EXCLUDE_BAD_STOP = "stop_on_wrong_side"


# ------------------------------ end-of-day flatten ------------------------------

@dataclass(frozen=True)
class FlattenRule:
    """The instant of day a position must be flat, in ET, and on which weekdays
    (Monday = 0) that close applies."""
    hour: int
    minute: int
    weekdays: Tuple[int, ...]


def flatten_rule(rules: Optional[models.PropRules]) -> FlattenRule:
    if rules is not None and (rules.no_overnight or rules.no_weekend):
        hh, mm = rules.close_time.split(":")
        # No-overnight closes every trading day, no-weekend only the Friday close.
        return FlattenRule(int(hh), int(mm), (0, 1, 2, 3, 4) if rules.no_overnight else (4,))
    b = load_sessions().trading_day_boundary
    return FlattenRule(b.close_hour, b.close_minute, (0, 1, 2, 3, 4))


def next_close_after(rule: FlattenRule, t: pd.Timestamp) -> pd.Timestamp:
    """The first close instant strictly after `t` (UTC)."""
    et_date = t.tz_convert(ET).date()
    for k in range(10):
        day = et_date + dt.timedelta(days=k)
        cand = pd.Timestamp(dt.datetime.combine(day, dt.time(rule.hour, rule.minute)), tz=ET)
        if cand > t and cand.weekday() in rule.weekdays:
            return cand.tz_convert("UTC")
    return pd.Timestamp.max.tz_localize("UTC")


def _flatten_position(index: pd.DatetimeIndex, close: pd.Timestamp) -> int:
    """Position in `index` of the bar a close at `close` is applied to: the first
    bar that ends at or after it, or -- when the close falls in a gap -- the last
    bar before it. May equal len(index) when the data ends before the close."""
    pos = int(index.searchsorted(close - pd.Timedelta(seconds=60), side="left"))
    if pos < len(index) and index[pos] < close:
        return pos
    return pos - 1 if pos > 0 else 0


# ------------------------------- the simulation --------------------------------

@dataclass(frozen=True)
class TradeOutcome:
    pnl_usd: float
    drawdown_points: float
    drawdown_usd: float
    drawdown_r: float


def _path_for(trade: models.ManualTrade, cursor_time: int, rule: FlattenRule) -> Optional[Tuple[pd.DataFrame, bool]]:
    """The 1m bars a counterfactual of `trade` may use, as (bars, entry_bar_included),
    or None when the instrument has no data for it."""
    try:
        raw = bar_service._load_raw(trade.instrument)
    except bar_service.UnknownInstrument:
        return None
    entry = pd.Timestamp(trade.entry_time, unit="s", tz="UTC")
    last_allowed = pd.Timestamp(cursor_time, unit="s", tz="UTC")
    close = next_close_after(rule, entry)

    idx = raw.index
    start = int(idx.searchsorted(entry, side="left"))
    if start >= len(idx) or idx[start] != entry:
        return None  # the entry bar is not in the data: nothing to anchor a path to
    entry_close = float(raw["close"].iloc[start])
    include_entry = abs(float(trade.entry_price) - entry_close) > 1e-9

    end = _flatten_position(idx, close)
    end = min(end, int(idx.searchsorted(last_allowed, side="right")) - 1)
    first = start if include_entry else start + 1
    cols = raw[["high", "low", "close"]]
    if end < first:
        return cols.iloc[0:0], include_entry
    return cols.iloc[first:end + 1], include_entry


def simulate_trade(
    side: str,
    entry: float,
    stop: float,
    point_value: float,
    contracts: int,
    commission_usd: float,
    highs: np.ndarray,
    lows: np.ndarray,
    last_close: Optional[float],
    r_values: Sequence[int] = tuple(range(1, MAX_R + 1)),
) -> Dict[int, TradeOutcome]:
    """One trade replayed over `highs`/`lows` (its 1m path, in order) with a
    target at each n x risk. `last_close` is where an unfinished path is
    flattened (the final bar's close; None for an empty path = flat at entry).

    Pure over its arguments -- the path selection above is the only part that
    touches data -- so it is tested on hand-built paths."""
    sign = 1.0 if side == "long" else -1.0
    risk = abs(entry - stop)
    adverse = np.maximum(0.0, (entry - lows) if sign > 0 else (highs - entry))
    favourable = (highs - entry) if sign > 0 else (entry - lows)
    stop_hit = (lows <= stop) if sign > 0 else (highs >= stop)
    stop_idx = int(np.argmax(stop_hit)) if stop_hit.any() else None
    exit_flat = entry if last_close is None else float(last_close)

    out: Dict[int, TradeOutcome] = {}
    for n in r_values:
        target_hit = favourable >= n * risk - 1e-12
        tgt_idx = int(np.argmax(target_hit)) if target_hit.any() else None
        # The stop wins a minute that touches both.
        if stop_idx is not None and (tgt_idx is None or stop_idx <= tgt_idx):
            end, exit_price = stop_idx, stop
        elif tgt_idx is not None:
            end, exit_price = tgt_idx, entry + sign * n * risk
        else:
            end, exit_price = (len(highs) - 1 if len(highs) else None), exit_flat
        if end is None:
            dd = 0.0
        else:
            dd = float(adverse[: end + 1].max())
            # A stopped trade was out at the stop: it cannot have carried more than 1R.
            if exit_price == stop:
                dd = min(dd, risk)
        gross = sign * (exit_price - entry) * point_value * contracts
        out[n] = TradeOutcome(
            pnl_usd=gross - commission_usd,
            drawdown_points=dd,
            drawdown_usd=dd * point_value * contracts,
            drawdown_r=dd / risk if risk else 0.0,
        )
    return out


def _row(n: Optional[int], outcomes: List[Tuple[float, float, float]]) -> models.RrRow:
    """`outcomes` = (pnl_usd, drawdown_usd, drawdown_r) per trade."""
    pnls = np.array([o[0] for o in outcomes])
    wins = int((pnls > 0).sum())
    gross_win = float(pnls[pnls > 0].sum())
    gross_loss = float(-pnls[pnls < 0].sum())
    return models.RrRow(
        n=n,
        trades=len(outcomes),
        wins=wins,
        win_rate=wins / len(outcomes) if outcomes else None,
        net_pnl_usd=float(pnls.sum()),
        profit_factor=(gross_win / gross_loss) if gross_loss > 0 else None,
        avg_drawdown_usd=float(np.mean([o[1] for o in outcomes])) if outcomes else None,
        avg_drawdown_r=float(np.mean([o[2] for o in outcomes])) if outcomes else None,
    )


def simulate(
    sessions: Sequence[models.BacktestSessionDetail],
    instrument: Optional[str] = None,
    scope: str = "",
) -> models.RrSimulatorResponse:
    specs = load_contracts()
    excluded: Dict[str, int] = {}
    total = 0
    per_n: Dict[int, List[Tuple[float, float, float]]] = {n: [] for n in range(1, MAX_R + 1)}
    actual: List[Tuple[float, float, float]] = []

    def exclude(reason: str) -> None:
        excluded[reason] = excluded.get(reason, 0) + 1

    from app.backend.services import bt_session_service as bts

    for s in sessions:
        rule = flatten_rule(s.account.prop_rules)
        for t in bts.list_trades(s.id):
            if instrument and t.instrument != instrument:
                continue
            total += 1
            if t.entry_sl_price is None:
                exclude(EXCLUDE_NO_STOP)
                continue
            if t.exits and sum(e.contracts for e in t.exits) < t.size_contracts:
                exclude(EXCLUDE_OPEN)
                continue
            sign = 1.0 if t.side == "long" else -1.0
            risk = sign * (t.entry_price - t.entry_sl_price)
            if not risk > 0:
                exclude(EXCLUDE_BAD_STOP)
                continue
            path = _path_for(t, s.cursor_time, rule)
            if path is None:
                exclude(EXCLUDE_NO_DATA)
                continue
            bars, _ = path
            spec = specs[t.instrument]
            outs = simulate_trade(
                t.side, t.entry_price, t.entry_sl_price, spec.point_value, t.size_contracts,
                t.commission_usd,
                bars["high"].to_numpy(dtype=float), bars["low"].to_numpy(dtype=float),
                float(bars["close"].iloc[-1]) if len(bars) else None,
            )
            for n, o in outs.items():
                per_n[n].append((o.pnl_usd, o.drawdown_usd, o.drawdown_r))
            # The trade as actually taken, for the same qualifying set.
            actual.append((t.pnl_usd, t.mae_points * spec.point_value * t.size_contracts, t.mae_points / risk))

    qualified = len(actual)
    enough = qualified >= MIN_TRADES
    return models.RrSimulatorResponse(
        scope=scope,
        instrument=instrument,
        total_trades=total,
        qualified=qualified,
        excluded=excluded,
        min_trades=MIN_TRADES,
        enough=enough,
        rows=[_row(n, per_n[n]) for n in range(1, MAX_R + 1)] if enough else [],
        actual=_row(None, actual) if enough else None,
    )
