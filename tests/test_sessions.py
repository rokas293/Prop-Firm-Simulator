from __future__ import annotations

import datetime as dt

import pandas as pd
import pytest

from propbt.config import load_sessions
from propbt.data.sessions import (
    fair_value,
    session_anchor_utc,
    session_windows,
    tag_sessions,
    trading_day,
)
from tests.conftest import make_ohlcv


@pytest.fixture(scope="module")
def cfg():
    return load_sessions()


def test_trading_day_groups_asia_london_ny_together(cfg):
    # Asia Monday 20:00 ET, London Tuesday 03:00 ET, NY Tuesday 09:30 ET
    # must all resolve to the SAME trading day (Tuesday) -- CLAUDE.md section 3.
    asia = session_anchor_utc(dt.date(2025, 3, 11), "asia", cfg)
    london = session_anchor_utc(dt.date(2025, 3, 11), "london", cfg)
    ny = session_anchor_utc(dt.date(2025, 3, 11), "ny", cfg)

    assert trading_day(asia, cfg) == dt.date(2025, 3, 11)
    assert trading_day(london, cfg) == dt.date(2025, 3, 11)
    assert trading_day(ny, cfg) == dt.date(2025, 3, 11)
    # sanity: Asia's UTC timestamp is actually on the calendar day before NY/London's
    assert asia.tz_convert(cfg.timezone).date() == dt.date(2025, 3, 10)


def test_trading_day_maintenance_halt_returns_none(cfg):
    halt_ts = pd.Timestamp("2025-03-10 17:30:00", tz=cfg.timezone).tz_convert("UTC")
    assert trading_day(halt_ts, cfg) is None


def test_trading_day_boundary_edges(cfg):
    just_before_close = pd.Timestamp("2025-03-10 16:59:00", tz=cfg.timezone).tz_convert("UTC")
    at_reopen = pd.Timestamp("2025-03-10 18:00:00", tz=cfg.timezone).tz_convert("UTC")
    assert trading_day(just_before_close, cfg) == dt.date(2025, 3, 10)
    assert trading_day(at_reopen, cfg) == dt.date(2025, 3, 11)


def test_session_anchor_utc_handles_dst(cfg):
    # NY 09:30 ET in January (EST, UTC-5) vs July (EDT, UTC-4)
    winter = session_anchor_utc(dt.date(2025, 1, 15), "ny", cfg)
    summer = session_anchor_utc(dt.date(2025, 7, 15), "ny", cfg)
    assert winter.hour == 14 and winter.minute == 30  # 09:30 + 5h
    assert summer.hour == 13 and summer.minute == 30  # 09:30 + 4h


def test_fair_value_is_close_of_prior_bar_strictly_before_anchor():
    idx = pd.date_range("2025-03-10 09:25:00", periods=10, freq="1min", tz="UTC")
    closes = [100.0 + i for i in range(10)]
    df = make_ohlcv(idx, closes, closes, closes, closes, [1] * 10)

    anchor = pd.Timestamp("2025-03-10 09:29:00", tz="UTC")  # exactly a bar's own timestamp
    ts, close = fair_value(df, anchor)
    assert ts == pd.Timestamp("2025-03-10 09:28:00", tz="UTC")  # the bar BEFORE, not at, anchor
    assert close == closes[3]

    anchor_mid = pd.Timestamp("2025-03-10 09:29:30", tz="UTC")
    ts2, close2 = fair_value(df, anchor_mid)
    assert ts2 == pd.Timestamp("2025-03-10 09:29:00", tz="UTC")


def test_fair_value_none_when_no_prior_data():
    idx = pd.date_range("2025-03-10 09:25:00", periods=3, freq="1min", tz="UTC")
    df = make_ohlcv(idx, [1, 1, 1], [1, 1, 1], [1, 1, 1], [1, 1, 1], [1, 1, 1])
    assert fair_value(df, pd.Timestamp("2025-03-10 09:00:00", tz="UTC")) is None


def test_session_windows_cover_trading_day_without_overlap(cfg):
    windows = session_windows(dt.date(2025, 3, 11), cfg)
    ordered = sorted(windows.values(), key=lambda w: w[0])
    for (start, end), (next_start, _) in zip(ordered, ordered[1:]):
        assert start < end
        assert end == next_start  # contiguous, no gap/overlap between sessions
    # last window ends at trading-day close (17:00 ET)
    close_ny = ordered[-1][1].tz_convert(cfg.timezone)
    assert (close_ny.hour, close_ny.minute) == (17, 0)


def test_tag_sessions_vectorized_matches_scalar(cfg):
    # span a full trading day plus the halt, across the fixed NY session anchors
    idx = pd.date_range("2025-03-10 18:00:00", "2025-03-11 17:05:00", freq="7min", tz="UTC")
    n = len(idx)
    df = make_ohlcv(idx, [1] * n, [1] * n, [1] * n, [1] * n, [1] * n)

    tagged = tag_sessions(df, cfg)

    for ts in idx[::5]:  # sample every 5th bar to keep the test fast
        expected_day = trading_day(ts, cfg)
        got_day = tagged.loc[ts, "trading_day"]
        if expected_day is None:
            assert got_day is None
        else:
            assert got_day == expected_day
