"""Session-open strategy legs (CLAUDE.md section 4):

- SessionOpenContinuation (leg 2): at each configured session open
  (Asia/London/NY), take exactly ONE continuation trade in the direction of
  the opening spike.
- MeanReversionLeg (leg 3): after the opening impulse, once the market
  consolidates, fade (or join) a break of structure back toward fair value.
  Up to N trades per session.

News (leg 4) is a separate, later phase. SessionOpenStrategy combines
whichever of the two legs above are enabled into one Strategy.

Design choices not pinned down explicitly by CLAUDE.md, documented here so
they're easy to revisit:
- Entries are MARKET orders for both legs (a continuation/momentum trade
  wants to be in promptly once direction is confirmed; a mean-reversion
  fade wants to be in promptly once the break is confirmed too, not wait
  for a pullback that may not come).
- All lookback windows (observation window, consolidation lookback, swing
  lookback) are wall-clock/bar-count as documented per-parameter below.
  Consolidation/swing detection is scoped to bars from the session's own
  anchor onward -- this leg is about *intraday* structure following that
  session's open, not multi-day swings.
- A tie (close exactly equal to the reference price) is treated as "no
  clear spike" and skipped, not an arbitrary coin flip.
- "fade the break" vs "join then fade" (CLAUDE.md's own phrasing) is
  operationalized as two STATIC per-run modes -- `fade_break` (counter to
  the break, the literal "fade") and `join_break` (with the break, the
  comparable momentum hypothesis) -- selected once per config/run and
  applied consistently, since CLAUDE.md frames this as "a tested config
  switch" (A/B compared across backtest runs), not a two-phase maneuver
  within a single trade.
- A given confirmed swing level is only ever traded once (whether or not
  consolidation gated it), so a market that grinds past the same broken
  level for many bars doesn't spam trades -- a NEW confirmed swing level
  has to form and break for another attempt.
"""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
from typing import Dict, List, Literal, Optional, Set, Tuple

import numpy as np
import pandas as pd
import yaml

from propbt.config import SessionsConfig
from propbt.data.sessions import fair_value, session_anchor_utc
from propbt.engine.events import Order, OrderType, Side
from propbt.strategy.base import BarState

ALLOWED_RR = (1.0, 1.5, 2.0)


def _bars_from(history: pd.DataFrame, ts: pd.Timestamp) -> pd.DataFrame:
    """bars with index >= ts, via binary search -- O(log n), not a full
    O(n) boolean scan (history can be the whole multi-year backtest)."""
    pos = history.index.searchsorted(ts, side="left")
    return history.iloc[pos:]


# ============================== Leg 2: continuation =========================

DirectionMethod = Literal["close_vs_fair_value", "window_displacement"]


@dataclass(frozen=True)
class ContinuationConfig:
    sessions: Tuple[str, ...]
    direction_method: DirectionMethod
    observation_window_minutes: int
    contracts: int
    sl_points: float
    rr: float

    def __post_init__(self) -> None:
        if self.rr not in ALLOWED_RR:
            raise ValueError(f"rr must be one of {ALLOWED_RR}, got {self.rr}")
        if self.observation_window_minutes < 1:
            raise ValueError("observation_window_minutes must be >= 1")
        if self.sl_points <= 0:
            raise ValueError("sl_points must be positive")
        if self.contracts <= 0:
            raise ValueError("contracts must be positive")
        if self.direction_method not in ("close_vs_fair_value", "window_displacement"):
            raise ValueError(f"Unknown direction_method {self.direction_method!r}")

    @property
    def tp_points(self) -> float:
        return self.sl_points * self.rr


class SessionOpenContinuation:
    """Strategy: on_bar(state) -> orders (propbt/strategy/base.py)."""

    def __init__(self, config: ContinuationConfig, sessions_config: SessionsConfig):
        self.config = config
        self.sessions_config = sessions_config
        self._handled: Set[Tuple[dt.date, str]] = set()

    def on_bar(self, state: BarState) -> List[Order]:
        session = state.bar.session
        if session is None or session not in self.config.sessions:
            return []

        key = (state.trading_day, session)
        if key in self._handled:
            return []

        anchor_ts = session_anchor_utc(state.trading_day, session, self.sessions_config)
        if state.bar.ts < anchor_ts:
            return []  # defensive; tag_sessions windows shouldn't allow this

        window_end = anchor_ts + pd.Timedelta(minutes=self.config.observation_window_minutes - 1)
        if state.bar.ts < window_end:
            return []  # observation window hasn't fully elapsed yet

        # exactly one attempt per session-open, regardless of what happens below
        self._handled.add(key)

        fv = fair_value(state.history, anchor_ts)
        if fv is None:
            return []  # no prior bar (e.g. very start of the dataset) -- can't compute fair value
        _, fair_value_price = fv

        direction = self._spike_direction(state, anchor_ts, fair_value_price)
        if direction == 0:
            return []  # no clear spike -- skip this session-open

        side = Side.LONG if direction > 0 else Side.SHORT
        order = Order(
            ts=state.bar.ts, symbol=state.symbol, side=side, order_type=OrderType.MARKET,
            contracts=self.config.contracts, sl_points=self.config.sl_points,
            tp_points=self.config.tp_points, reason=f"continuation:{session}",
        )
        return [order]

    def _spike_direction(self, state: BarState, anchor_ts: pd.Timestamp, fair_value_price: float) -> int:
        if self.config.direction_method == "close_vs_fair_value":
            diff = state.bar.close - fair_value_price
        else:  # window_displacement
            window = _bars_from(state.history, anchor_ts)
            if len(window) == 0:
                return 0
            window_open = float(window.iloc[0]["open"])
            diff = state.bar.close - window_open
        return 1 if diff > 0 else (-1 if diff < 0 else 0)


# ============================== Leg 3: mean-reversion ========================

CompressionMethod = Literal["range", "atr"]
DirectionMode = Literal["fade_break", "join_break"]


def range_compression(bars: pd.DataFrame, lookback_bars: int) -> Optional[float]:
    """High-low range over the last `lookback_bars` bars, in points."""
    if len(bars) < lookback_bars:
        return None
    window = bars.iloc[-lookback_bars:]
    return float(window["high"].max() - window["low"].min())


def atr(bars: pd.DataFrame, lookback_bars: int) -> Optional[float]:
    """Average true range over the last `lookback_bars` bars, in points."""
    if len(bars) < lookback_bars + 1:
        return None
    window = bars.iloc[-(lookback_bars + 1):]
    highs = window["high"].to_numpy()[1:]
    lows = window["low"].to_numpy()[1:]
    prev_closes = window["close"].to_numpy()[:-1]
    tr = np.maximum(highs - lows, np.maximum(np.abs(highs - prev_closes), np.abs(lows - prev_closes)))
    return float(tr.mean())


def volume_ratio(bars: pd.DataFrame, recent_bars: int, baseline_bars: int) -> Optional[float]:
    """recent average volume / longer-baseline average volume. <1 means
    volume has dried up relative to the baseline."""
    if len(bars) < baseline_bars:
        return None
    recent_avg = bars["volume"].iloc[-recent_bars:].mean()
    baseline_avg = bars["volume"].iloc[-baseline_bars:].mean()
    if baseline_avg == 0:
        return None
    return float(recent_avg / baseline_avg)


def is_consolidating(bars: pd.DataFrame, config: "MeanReversionConfig") -> bool:
    """Range/ATR compression below a threshold, optionally confirmed by
    volume below its rolling baseline. `bars` should be the window ENDING
    just before the candidate breakout bar (i.e. exclude the breakout bar
    itself -- it isn't part of the quiet period by definition)."""
    if config.compression_method == "range":
        compression = range_compression(bars, config.compression_lookback_bars)
    else:
        compression = atr(bars, config.compression_lookback_bars)
    if compression is None or compression > config.compression_threshold_points:
        return False

    if config.require_volume_confirmation:
        ratio = volume_ratio(bars, config.volume_lookback_bars, config.volume_baseline_bars)
        if ratio is None or ratio > config.volume_ratio_threshold:
            return False
    return True


def most_recent_confirmed_swing(bars: pd.DataFrame, w: int) -> Tuple[Optional[float], Optional[float]]:
    """The most recent CONFIRMED swing high and swing low in `bars` (the
    last row is treated as "now"). A bar at position j is a confirmed swing
    high/low once w bars exist on both sides of it and it's the max/min
    high/low in that 2w+1-bar window. Independent search per side -- the
    most recent swing high and the most recent swing low need not be at the
    same bar.
    """
    m = len(bars)
    last_confirmable = m - 1 - w  # need w bars strictly after position j to confirm it
    if last_confirmable < w:
        return None, None

    highs = bars["high"].to_numpy()
    lows = bars["low"].to_numpy()
    swing_high: Optional[float] = None
    swing_low: Optional[float] = None
    for j in range(last_confirmable, w - 1, -1):
        lo, hi = j - w, j + w + 1
        if swing_high is None and highs[j] == highs[lo:hi].max():
            swing_high = float(highs[j])
        if swing_low is None and lows[j] == lows[lo:hi].min():
            swing_low = float(lows[j])
        if swing_high is not None and swing_low is not None:
            break
    return swing_high, swing_low


@dataclass(frozen=True)
class MeanReversionConfig:
    sessions: Tuple[str, ...]
    max_trades_per_session: int
    compression_method: CompressionMethod
    compression_lookback_bars: int
    compression_threshold_points: float
    require_volume_confirmation: bool
    volume_lookback_bars: int
    volume_baseline_bars: int
    volume_ratio_threshold: float
    swing_lookback_bars: int
    direction_mode: DirectionMode
    contracts: int
    sl_points: float
    rr: float

    def __post_init__(self) -> None:
        if self.rr not in ALLOWED_RR:
            raise ValueError(f"rr must be one of {ALLOWED_RR}, got {self.rr}")
        if self.max_trades_per_session < 1:
            raise ValueError("max_trades_per_session must be >= 1")
        if self.compression_method not in ("range", "atr"):
            raise ValueError(f"Unknown compression_method {self.compression_method!r}")
        if self.compression_lookback_bars < 2:
            raise ValueError("compression_lookback_bars must be >= 2")
        if self.compression_threshold_points <= 0:
            raise ValueError("compression_threshold_points must be positive")
        if self.swing_lookback_bars < 1:
            raise ValueError("swing_lookback_bars must be >= 1")
        if self.direction_mode not in ("fade_break", "join_break"):
            raise ValueError(f"Unknown direction_mode {self.direction_mode!r}")
        if self.sl_points <= 0:
            raise ValueError("sl_points must be positive")
        if self.contracts <= 0:
            raise ValueError("contracts must be positive")
        if self.require_volume_confirmation and self.volume_baseline_bars <= self.volume_lookback_bars:
            raise ValueError("volume_baseline_bars must be longer than volume_lookback_bars")

    @property
    def tp_points(self) -> float:
        return self.sl_points * self.rr


class MeanReversionLeg:
    """Strategy: on_bar(state) -> orders (propbt/strategy/base.py)."""

    def __init__(self, config: MeanReversionConfig, sessions_config: SessionsConfig):
        self.config = config
        self.sessions_config = sessions_config
        self._trade_count: Dict[Tuple[dt.date, str], int] = {}
        self._last_broken_level: Dict[Tuple[dt.date, str], float] = {}

    def on_bar(self, state: BarState) -> List[Order]:
        session = state.bar.session
        if session is None or session not in self.config.sessions:
            return []

        key = (state.trading_day, session)
        if self._trade_count.get(key, 0) >= self.config.max_trades_per_session:
            return []

        anchor_ts = session_anchor_utc(state.trading_day, session, self.sessions_config)
        if state.bar.ts < anchor_ts:
            return []  # defensive; tag_sessions windows shouldn't allow this
        session_bars = _bars_from(state.history, anchor_ts)

        swing_high, swing_low = most_recent_confirmed_swing(session_bars, self.config.swing_lookback_bars)
        close = state.bar.close
        if swing_high is not None and close > swing_high:
            bos_direction, level = 1, swing_high
        elif swing_low is not None and close < swing_low:
            bos_direction, level = -1, swing_low
        else:
            return []  # no break of structure right now

        if self._last_broken_level.get(key) == level:
            return []  # already handled (traded or skipped) this exact swing level
        self._last_broken_level[key] = level

        if not is_consolidating(session_bars.iloc[:-1], self.config):
            return []  # broke structure, but there wasn't a genuine consolidation into it

        self._trade_count[key] = self._trade_count.get(key, 0) + 1

        if self.config.direction_mode == "fade_break":
            side = Side.SHORT if bos_direction > 0 else Side.LONG
        else:  # join_break
            side = Side.LONG if bos_direction > 0 else Side.SHORT

        order = Order(
            ts=state.bar.ts, symbol=state.symbol, side=side, order_type=OrderType.MARKET,
            contracts=self.config.contracts, sl_points=self.config.sl_points,
            tp_points=self.config.tp_points, reason=f"mean_reversion:{session}",
        )
        return [order]


# ============================== combined strategy + config ==================

class SessionOpenStrategy:
    """Combines whichever of the two legs are enabled. Strategy:
    on_bar(state) -> orders (propbt/strategy/base.py)."""

    def __init__(
        self,
        continuation: Optional[SessionOpenContinuation] = None,
        mean_reversion: Optional[MeanReversionLeg] = None,
    ):
        self.continuation = continuation
        self.mean_reversion = mean_reversion

    def on_bar(self, state: BarState) -> List[Order]:
        orders: List[Order] = []
        if self.continuation is not None:
            orders.extend(self.continuation.on_bar(state))
        if self.mean_reversion is not None:
            orders.extend(self.mean_reversion.on_bar(state))
        return orders


@dataclass(frozen=True)
class SessionOpenRunConfig:
    symbol: str
    start: str
    end: str
    continuation: Optional[ContinuationConfig]
    mean_reversion: Optional[MeanReversionConfig]


def load_session_open_config(path: str) -> SessionOpenRunConfig:
    with open(path, "r", encoding="utf-8") as f:
        raw = yaml.safe_load(f)
    legs = raw["legs"]

    continuation_cfg = None
    c = legs.get("continuation")
    if c and c.get("enabled", False):
        direction, risk = c["direction"], c["risk"]
        continuation_cfg = ContinuationConfig(
            sessions=tuple(c["sessions"]),
            direction_method=direction["method"],
            observation_window_minutes=int(direction["observation_window_minutes"]),
            contracts=int(risk["contracts"]),
            sl_points=float(risk["sl_points"]),
            rr=float(risk["rr"]),
        )

    mean_reversion_cfg = None
    m = legs.get("mean_reversion")
    if m and m.get("enabled", False):
        cons, swing, risk = m["consolidation"], m["swing"], m["risk"]
        mean_reversion_cfg = MeanReversionConfig(
            sessions=tuple(m["sessions"]),
            max_trades_per_session=int(m["max_trades_per_session"]),
            compression_method=cons["compression_method"],
            compression_lookback_bars=int(cons["lookback_bars"]),
            compression_threshold_points=float(cons["threshold_points"]),
            require_volume_confirmation=bool(cons["require_volume_confirmation"]),
            volume_lookback_bars=int(cons["volume_lookback_bars"]),
            volume_baseline_bars=int(cons["volume_baseline_bars"]),
            volume_ratio_threshold=float(cons["volume_ratio_threshold"]),
            swing_lookback_bars=int(swing["lookback_bars"]),
            direction_mode=m["direction_mode"],
            contracts=int(risk["contracts"]),
            sl_points=float(risk["sl_points"]),
            rr=float(risk["rr"]),
        )

    bt = raw["backtest"]
    return SessionOpenRunConfig(
        symbol=raw["symbol"], start=str(bt["start"]), end=str(bt["end"]),
        continuation=continuation_cfg, mean_reversion=mean_reversion_cfg,
    )


def build_strategy(run_config: SessionOpenRunConfig, sessions_config: SessionsConfig) -> SessionOpenStrategy:
    continuation = (
        SessionOpenContinuation(run_config.continuation, sessions_config)
        if run_config.continuation is not None else None
    )
    mean_reversion = (
        MeanReversionLeg(run_config.mean_reversion, sessions_config)
        if run_config.mean_reversion is not None else None
    )
    return SessionOpenStrategy(continuation=continuation, mean_reversion=mean_reversion)
