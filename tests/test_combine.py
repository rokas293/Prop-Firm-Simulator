from __future__ import annotations

import datetime as dt

import pandas as pd
import pytest

from propbt.config import load_contracts, load_prop_rules, load_sessions
from propbt.data.sessions import session_anchor_utc
from propbt.sim.combine import run_combine_attempt
from propbt.strategy.placeholder import AlwaysFlatStrategy
from tests.conftest import make_ohlcv


def flat_df(start: str, n_days: int, price: float = 5000.0) -> pd.DataFrame:
    idx = pd.date_range(start, periods=n_days * 1440, freq="1min", tz="UTC")
    n = len(idx)
    return make_ohlcv(idx, [price] * n, [price + 0.5] * n, [price - 0.5] * n, [price] * n, [100] * n)


@pytest.fixture(scope="module")
def sessions_cfg():
    return load_sessions()


@pytest.fixture(scope="module")
def contracts():
    return load_contracts()


@pytest.fixture(scope="module")
def prop_cfg():
    return load_prop_rules()


def test_equity_curve_starts_at_or_after_trading_start(sessions_cfg, contracts, prop_cfg):
    df = flat_df("2025-01-01 00:00:00", n_days=10)
    start_date = dt.date(2025, 1, 6)
    attempt = run_combine_attempt(df, "MES", AlwaysFlatStrategy, contracts, prop_cfg, sessions_cfg,
                                   start_date=start_date, warmup_days=3, max_calendar_days=3)
    trading_start = session_anchor_utc(start_date, "globex_reopen", sessions_cfg)
    assert attempt.equity_curve
    assert attempt.equity_curve[0][0] >= trading_start


def test_no_fills_or_pnl_from_warmup_bars(sessions_cfg, contracts, prop_cfg):
    df = flat_df("2025-01-01 00:00:00", n_days=10)
    start_date = dt.date(2025, 1, 6)
    attempt = run_combine_attempt(df, "MES", AlwaysFlatStrategy, contracts, prop_cfg, sessions_cfg,
                                   start_date=start_date, warmup_days=3, max_calendar_days=3)
    assert attempt.fills == []
    assert attempt.combine.final_balance == prop_cfg.start_balance


def test_max_calendar_days_bounds_the_attempt(sessions_cfg, contracts, prop_cfg):
    df = flat_df("2025-01-01 00:00:00", n_days=20)
    start_date = dt.date(2025, 1, 6)
    attempt = run_combine_attempt(df, "MES", AlwaysFlatStrategy, contracts, prop_cfg, sessions_cfg,
                                   start_date=start_date, warmup_days=2, max_calendar_days=5)
    assert attempt.combine.status == "incomplete"
    assert attempt.n_trading_days <= 6  # ~5 calendar days, plus a little slack


def test_fresh_strategy_instance_per_attempt(sessions_cfg, contracts, prop_cfg):
    call_count = {"n": 0}

    def factory():
        call_count["n"] += 1
        return AlwaysFlatStrategy()

    df = flat_df("2025-01-01 00:00:00", n_days=10)
    run_combine_attempt(df, "MES", factory, contracts, prop_cfg, sessions_cfg,
                         start_date=dt.date(2025, 1, 6), warmup_days=2, max_calendar_days=2)
    assert call_count["n"] == 1


def test_raises_when_no_data_available_for_start_date(sessions_cfg, contracts, prop_cfg):
    df = flat_df("2025-01-01 00:00:00", n_days=3)
    with pytest.raises(ValueError):
        run_combine_attempt(df, "MES", AlwaysFlatStrategy, contracts, prop_cfg, sessions_cfg,
                             start_date=dt.date(2030, 1, 1), warmup_days=2)
