"""Open-spike continuation leg (CLAUDE.md section 4, leg 2): at each
configured session open (Asia/London/NY), take exactly ONE continuation
trade in the direction of the opening spike. Mean-reversion (leg 3) and
news (leg 4) are separate, later phases.

Design choices not pinned down explicitly by CLAUDE.md, documented here so
they're easy to revisit:
- Entries are MARKET orders (a continuation/momentum trade wants to be in
  promptly once direction is confirmed, not wait for a better price).
- The observation window is wall-clock TIME, not a bar count (CLAUDE.md
  section 2: "where a window is meant to represent elapsed time, define it
  in minutes"), so this is robust to sparse bars (e.g. ZN) even though the
  leg is only exercised on MES/MNQ for now.
- A tie (close exactly equal to the reference price) is treated as "no
  clear spike" and skipped, not an arbitrary coin flip.
"""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
from typing import List, Literal, Set, Tuple

import pandas as pd
import yaml

from propbt.config import SessionsConfig
from propbt.data.sessions import fair_value, session_anchor_utc
from propbt.engine.events import Order, OrderType, Side
from propbt.strategy.base import BarState

DirectionMethod = Literal["close_vs_fair_value", "window_displacement"]
ALLOWED_RR = (1.0, 1.5, 2.0)


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


@dataclass(frozen=True)
class ContinuationRunConfig:
    symbol: str
    start: str
    end: str
    strategy: ContinuationConfig


def load_continuation_config(path: str) -> ContinuationRunConfig:
    with open(path, "r", encoding="utf-8") as f:
        raw = yaml.safe_load(f)
    direction = raw["direction"]
    risk = raw["risk"]
    strategy = ContinuationConfig(
        sessions=tuple(raw["sessions"]),
        direction_method=direction["method"],
        observation_window_minutes=int(direction["observation_window_minutes"]),
        contracts=int(risk["contracts"]),
        sl_points=float(risk["sl_points"]),
        rr=float(risk["rr"]),
    )
    bt = raw["backtest"]
    return ContinuationRunConfig(symbol=raw["symbol"], start=str(bt["start"]), end=str(bt["end"]), strategy=strategy)


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
            window = state.history.loc[state.history.index >= anchor_ts]
            if len(window) == 0:
                return 0
            window_open = float(window.iloc[0]["open"])
            diff = state.bar.close - window_open
        return 1 if diff > 0 else (-1 if diff < 0 else 0)
