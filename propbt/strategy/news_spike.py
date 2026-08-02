"""News-spike legs (CLAUDE.md section 4): the same continuation and
mean-reversion logic as strategy/session_open.py, applied around scheduled
high-impact news events instead of session opens.

"Same logic" is literal at the algorithmic level -- spike-direction, swing
detection, consolidation, and break-of-structure all reuse the exact same
pure functions from session_open.py (imported, not copied). What differs
is only the anchor: a session anchor is a fixed daily wall-clock time that
recurs every trading day; a news anchor is a one-off timestamp from
news_events.csv, active for a configurable `event_window_minutes` after it
fires (there's no natural "next session" to bound the window the way
session_windows() does, so it needs its own explicit duration).

Design choices, consistent with session_open.py's:
- Entries are MARKET orders.
- Exactly one continuation trade per event; up to N mean-reversion trades
  per event, each against a distinct confirmed swing level.
- High-impact filtering happens in data/news.py before any of this runs
  (CLAUDE.md: "high-impact only by default").
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Tuple, Union

import pandas as pd
import yaml

from propbt.config import PROJECT_ROOT
from propbt.data.news import DEFAULT_HIGH_IMPACT_VALUES, filter_impact, load_news_events
from propbt.data.sessions import fair_value
from propbt.engine.events import Order, OrderType, Side
from propbt.strategy.base import BarState
from propbt.strategy.session_open import (
    ALLOWED_RR,
    CompressionMethod,
    DirectionMethod,
    DirectionMode,
    _bars_from,
    is_consolidating,
    most_recent_confirmed_swing,
)


def _active_event(bar_ts: pd.Timestamp, event_timestamps: pd.DatetimeIndex, window_minutes: int) -> Optional[pd.Timestamp]:
    """The most recent event at/before `bar_ts` whose window
    [event_ts, event_ts + window_minutes) still contains `bar_ts`, or None."""
    pos = event_timestamps.searchsorted(bar_ts, side="right") - 1
    if pos < 0:
        return None
    event_ts = event_timestamps[pos]
    if bar_ts < event_ts + pd.Timedelta(minutes=window_minutes):
        return event_ts
    return None


# ============================== continuation leg =============================

@dataclass(frozen=True)
class NewsContinuationConfig:
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


class NewsSpikeContinuation:
    """Strategy: on_bar(state) -> orders (propbt/strategy/base.py)."""

    def __init__(self, config: NewsContinuationConfig, event_timestamps: pd.DatetimeIndex, event_window_minutes: int):
        self.config = config
        self._event_timestamps = event_timestamps
        self._event_window_minutes = event_window_minutes
        self._handled: set = set()

    def on_bar(self, state: BarState) -> List[Order]:
        event_ts = _active_event(state.bar.ts, self._event_timestamps, self._event_window_minutes)
        if event_ts is None or event_ts in self._handled:
            return []

        window_end = event_ts + pd.Timedelta(minutes=self.config.observation_window_minutes - 1)
        if state.bar.ts < window_end:
            return []

        self._handled.add(event_ts)  # exactly one attempt per event, regardless of outcome below

        fv = fair_value(state.history, event_ts)
        if fv is None:
            return []
        _, fair_value_price = fv

        direction = self._spike_direction(state, event_ts, fair_value_price)
        if direction == 0:
            return []

        side = Side.LONG if direction > 0 else Side.SHORT
        order = Order(
            ts=state.bar.ts, symbol=state.symbol, side=side, order_type=OrderType.MARKET,
            contracts=self.config.contracts, sl_points=self.config.sl_points,
            tp_points=self.config.tp_points, reason=f"news_continuation:{state.bar.session}",
        )
        return [order]

    def _spike_direction(self, state: BarState, event_ts: pd.Timestamp, fair_value_price: float) -> int:
        if self.config.direction_method == "close_vs_fair_value":
            diff = state.bar.close - fair_value_price
        else:  # window_displacement
            window = _bars_from(state.history, event_ts)
            if len(window) == 0:
                return 0
            window_open = float(window.iloc[0]["open"])
            diff = state.bar.close - window_open
        return 1 if diff > 0 else (-1 if diff < 0 else 0)


# ============================== mean-reversion leg ============================

@dataclass(frozen=True)
class NewsMeanReversionConfig:
    max_trades_per_event: int
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
        if self.max_trades_per_event < 1:
            raise ValueError("max_trades_per_event must be >= 1")
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


class NewsSpikeMeanReversion:
    """Strategy: on_bar(state) -> orders (propbt/strategy/base.py)."""

    def __init__(self, config: NewsMeanReversionConfig, event_timestamps: pd.DatetimeIndex, event_window_minutes: int):
        self.config = config
        self._event_timestamps = event_timestamps
        self._event_window_minutes = event_window_minutes
        self._trade_count: Dict[pd.Timestamp, int] = {}
        self._last_broken_level: Dict[pd.Timestamp, float] = {}

    def on_bar(self, state: BarState) -> List[Order]:
        event_ts = _active_event(state.bar.ts, self._event_timestamps, self._event_window_minutes)
        if event_ts is None:
            return []
        if self._trade_count.get(event_ts, 0) >= self.config.max_trades_per_event:
            return []

        event_bars = _bars_from(state.history, event_ts)

        swing_high, swing_low = most_recent_confirmed_swing(event_bars, self.config.swing_lookback_bars)
        close = state.bar.close
        if swing_high is not None and close > swing_high:
            bos_direction, level = 1, swing_high
        elif swing_low is not None and close < swing_low:
            bos_direction, level = -1, swing_low
        else:
            return []

        if self._last_broken_level.get(event_ts) == level:
            return []
        self._last_broken_level[event_ts] = level

        if not is_consolidating(event_bars.iloc[:-1], self.config):
            return []

        self._trade_count[event_ts] = self._trade_count.get(event_ts, 0) + 1

        if self.config.direction_mode == "fade_break":
            side = Side.SHORT if bos_direction > 0 else Side.LONG
        else:  # join_break
            side = Side.LONG if bos_direction > 0 else Side.SHORT

        order = Order(
            ts=state.bar.ts, symbol=state.symbol, side=side, order_type=OrderType.MARKET,
            contracts=self.config.contracts, sl_points=self.config.sl_points,
            tp_points=self.config.tp_points, reason=f"news_mean_reversion:{state.bar.session}",
        )
        return [order]


# ============================== config loading ================================

@dataclass(frozen=True)
class NewsSpikeConfig:
    events_path: Path
    high_impact_only: bool
    impact_values: Tuple[str, ...]
    event_window_minutes: int
    continuation: Optional[NewsContinuationConfig]
    mean_reversion: Optional[NewsMeanReversionConfig]


def load_news_spike_config(path: Union[str, Path]) -> Optional[NewsSpikeConfig]:
    """Read the `legs.news` section of a strategy run config. Returns None
    if that leg isn't present or isn't enabled."""
    with open(path, "r", encoding="utf-8") as f:
        raw = yaml.safe_load(f)
    news = raw.get("legs", {}).get("news")
    if not news or not news.get("enabled", False):
        return None

    events_path = Path(news["events_path"])
    if not events_path.is_absolute():
        events_path = PROJECT_ROOT / events_path

    continuation_cfg = None
    c = news.get("continuation")
    if c and c.get("enabled", False):
        direction, risk = c["direction"], c["risk"]
        continuation_cfg = NewsContinuationConfig(
            direction_method=direction["method"],
            observation_window_minutes=int(direction["observation_window_minutes"]),
            contracts=int(risk["contracts"]), sl_points=float(risk["sl_points"]), rr=float(risk["rr"]),
        )

    mean_reversion_cfg = None
    m = news.get("mean_reversion")
    if m and m.get("enabled", False):
        cons, swing, risk = m["consolidation"], m["swing"], m["risk"]
        mean_reversion_cfg = NewsMeanReversionConfig(
            max_trades_per_event=int(m["max_trades_per_event"]),
            compression_method=cons["compression_method"],
            compression_lookback_bars=int(cons["lookback_bars"]),
            compression_threshold_points=float(cons["threshold_points"]),
            require_volume_confirmation=bool(cons["require_volume_confirmation"]),
            volume_lookback_bars=int(cons["volume_lookback_bars"]),
            volume_baseline_bars=int(cons["volume_baseline_bars"]),
            volume_ratio_threshold=float(cons["volume_ratio_threshold"]),
            swing_lookback_bars=int(swing["lookback_bars"]),
            direction_mode=m["direction_mode"],
            contracts=int(risk["contracts"]), sl_points=float(risk["sl_points"]), rr=float(risk["rr"]),
        )

    return NewsSpikeConfig(
        events_path=events_path,
        high_impact_only=bool(news.get("high_impact_only", True)),
        impact_values=tuple(news.get("impact_values", DEFAULT_HIGH_IMPACT_VALUES)),
        event_window_minutes=int(news["event_window_minutes"]),
        continuation=continuation_cfg, mean_reversion=mean_reversion_cfg,
    )


def build_news_legs(config: NewsSpikeConfig, start: Optional[str] = None, end: Optional[str] = None) -> List:
    """Load & filter the news calendar, then build whichever news legs are
    configured. `start`/`end` (if given) scope events to the backtest's own
    date range -- no point carrying years of irrelevant event timestamps.
    """
    events = load_news_events(config.events_path)
    if config.high_impact_only:
        events = filter_impact(events, config.impact_values)
    if start is not None:
        events = events.loc[events.index >= pd.Timestamp(start, tz="UTC")]
    if end is not None:
        events = events.loc[events.index <= pd.Timestamp(end, tz="UTC") + pd.Timedelta(days=1)]

    event_timestamps = events.index

    legs = []
    if config.continuation is not None:
        legs.append(NewsSpikeContinuation(config.continuation, event_timestamps, config.event_window_minutes))
    if config.mean_reversion is not None:
        legs.append(NewsSpikeMeanReversion(config.mean_reversion, event_timestamps, config.event_window_minutes))
    return legs
