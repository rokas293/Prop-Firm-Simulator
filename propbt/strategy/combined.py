"""Builds the full combined Strategy (session-open legs + news-spike legs)
from their configs. Lives above both session_open.py and news_spike.py
(each already talks to the other's pure functions/types one-directionally;
this module is where they get wired together, so neither has to import
the other back).
"""
from __future__ import annotations

from typing import Callable, Optional

from propbt.config import SessionsConfig
from propbt.strategy.base import MultiLegStrategy, Strategy
from propbt.strategy.news_spike import NewsSpikeConfig, build_news_legs
from propbt.strategy.session_open import SessionOpenRunConfig, build_strategy


def build_combined_strategy_factory(
    run_config: SessionOpenRunConfig,
    sessions_config: SessionsConfig,
    news_config: Optional[NewsSpikeConfig] = None,
    news_start: Optional[str] = None,
    news_end: Optional[str] = None,
) -> Callable[[], Strategy]:
    """Returns a factory (not a shared instance!) -- each call builds a
    FRESH set of leg objects with no state carried over, since Monte Carlo
    attempts must not leak per-session/per-event state into each other.
    """

    def factory() -> Strategy:
        session_open_strategy = build_strategy(run_config, sessions_config)
        legs = []
        if session_open_strategy.continuation is not None:
            legs.append(session_open_strategy.continuation)
        if session_open_strategy.mean_reversion is not None:
            legs.append(session_open_strategy.mean_reversion)
        if news_config is not None:
            legs.extend(build_news_legs(news_config, start=news_start, end=news_end))
        return MultiLegStrategy(legs)

    return factory
