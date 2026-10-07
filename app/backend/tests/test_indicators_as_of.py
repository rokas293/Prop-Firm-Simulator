"""FXR_V2_SPEC.md section 5 (G5): indicators on the forming candle follow the
engine-truth rule -- the backend computes them, from 1m bars at or before the
cursor only (the partial bar included), and the frontend never recomputes them.

These tests use a synthetic dataset swapped in for the real loader, so a value
that leaked from a later bar would show up as a difference rather than hide in
real prices.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from app.backend.services import indicator_service
from propbt.config import load_sessions
from propbt.data.indicators import atr_series, ema_series, session_vwap
from propbt.data.resample import resample_ohlcv

ALL = ["vwap", "ema20", "ema50", "atr14"]
START = pd.Timestamp("2025-03-10 00:00:00", tz="UTC")
MINUTES = 4 * 24 * 60  # four days of 1m bars, so every indicator is warm


def _synthetic(seed: int = 7) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    idx = pd.date_range(START, periods=MINUTES, freq="1min", tz="UTC", name="ts_event")
    close = 20000 + np.cumsum(rng.normal(0, 3, MINUTES))
    open_ = np.concatenate([[20000.0], close[:-1]])
    spread = np.abs(rng.normal(0, 2, MINUTES)) + 0.25
    return pd.DataFrame(
        {
            "open": open_,
            "high": np.maximum(open_, close) + spread,
            "low": np.minimum(open_, close) - spread,
            "close": close,
            "volume": pd.array(rng.integers(10, 500, MINUTES), dtype="uint64"),
        },
        index=idx,
    )


@pytest.fixture()
def dataset(monkeypatch):
    df = _synthetic()
    monkeypatch.setattr(indicator_service, "_load_raw", lambda instrument: df)
    return df


def _ts(t: pd.Timestamp) -> int:
    return int(t.timestamp())


def _as_of(tf: str, cursor: pd.Timestamp, since: pd.Timestamp, from_: pd.Timestamp = START + pd.Timedelta(days=2)):
    return indicator_service.get_indicators_as_of("MNQ", tf, _ts(from_), _ts(cursor), _ts(since), ALL)


def _flat(result) -> dict:
    return {name: [(p.time, p.value) for p in pts] for name, pts in result.items()}


def test_a_value_on_the_partial_candle_never_uses_a_later_bar(monkeypatch):
    """Randomised: poison every bar AFTER the cursor and the answer must not move
    by a single bit, on every timeframe, wherever in the candle the cursor is."""
    clean = _synthetic()
    rng = np.random.default_rng(11)
    for _ in range(40):
        tf = ["1min", "5min", "15min", "1h", "4h"][int(rng.integers(0, 5))]
        cursor = START + pd.Timedelta(days=2) + pd.Timedelta(minutes=int(rng.integers(30, 1500)))
        since = cursor - pd.Timedelta(hours=int(rng.integers(0, 6)))

        monkeypatch.setattr(indicator_service, "_load_raw", lambda instrument: clean)
        expected = _flat(_as_of(tf, cursor, since))

        poisoned = clean.copy()
        after = poisoned.index > cursor
        poisoned.loc[after, ["open", "high", "low", "close"]] = rng.choice([1e7, -5e6, 1.0], size=(int(after.sum()), 4))
        monkeypatch.setattr(indicator_service, "_load_raw", lambda instrument: poisoned)
        got = _flat(_as_of(tf, cursor, since))

        assert got == expected, (tf, cursor)


def test_the_partial_candle_equals_the_engine_run_on_exactly_the_bars_up_to_the_cursor(dataset):
    cursor = pd.Timestamp("2025-03-12 14:37:00", tz="UTC")  # 37 minutes into the 14:00 hour
    from_ = START + pd.Timedelta(days=2)
    result = _as_of("1h", cursor, cursor - pd.Timedelta(hours=1), from_)

    start = from_ - pd.Timedelta(minutes=indicator_service.WARMUP_MINUTES)
    truncated = dataset.loc[start:cursor]
    bars = resample_ohlcv(truncated, "1h")
    assert bars.index[-1] == pd.Timestamp("2025-03-12 14:00:00", tz="UTC")
    # That last candle is the partial one: 14:00 .. 14:37 only.
    assert bars["close"].iloc[-1] == dataset.loc["2025-03-12 14:37:00", "close"]
    expected = {
        "ema20": ema_series(bars["close"], 20),
        "ema50": ema_series(bars["close"], 50),
        "atr14": atr_series(bars, 14),
    }
    for name, series in expected.items():
        pts = {p.time: p.value for p in result[name]}
        assert pts[_ts(bars.index[-1])] == series.iloc[-1], name
    # VWAP over the same truncated 1h bars.
    vwap = session_vwap(bars, load_sessions())
    assert {p.time: p.value for p in result["vwap"]}[_ts(bars.index[-1])] == pytest.approx(vwap.iloc[-1], abs=1e-9)


def test_the_newest_point_is_the_forming_candle_and_moves_with_the_cursor(dataset):
    """Stepping the cursor inside one candle changes ITS value (it is built from
    more minutes) and none of the completed candles before it."""
    since = pd.Timestamp("2025-03-12 12:00:00", tz="UTC")
    a = _as_of("1h", pd.Timestamp("2025-03-12 14:10:00", tz="UTC"), since)
    b = _as_of("1h", pd.Timestamp("2025-03-12 14:40:00", tz="UTC"), since)
    forming = _ts(pd.Timestamp("2025-03-12 14:00:00", tz="UTC"))
    for name in ("ema20", "ema50", "atr14"):
        pa, pb = {p.time: p.value for p in a[name]}, {p.time: p.value for p in b[name]}
        assert max(pa) == max(pb) == forming
        assert pa[forming] != pb[forming], name
        assert {t: v for t, v in pa.items() if t < forming} == {t: v for t, v in pb.items() if t < forming}


@pytest.mark.parametrize("tf", ["1min", "5min", "15min", "1h"])
def test_it_matches_the_history_endpoint_bit_for_bit_wherever_both_have_a_bar(dataset, tf):
    """A replay's history (loaded once) and its tail (asked for each step) must
    join without a seam: the same bar gets the same number from either."""
    from_ = START + pd.Timedelta(days=2)
    cursor = pd.Timestamp("2025-03-12 14:59:00", tz="UTC")  # the end of a candle on every timeframe
    since = cursor - pd.Timedelta(hours=3)
    tail = _flat(_as_of(tf, cursor, since, from_))
    full = indicator_service.get_indicators("MNQ", tf, _ts(from_), _ts(cursor), ALL)
    for name in ALL:
        reference = {p.time: p.value for p in full[name] if p.time >= _ts(since)}
        got = dict(tail[name])
        assert got.keys() == reference.keys(), name
        for t, v in reference.items():
            assert got[t] == pytest.approx(v, abs=1e-9, rel=0), (name, t)


def test_only_points_at_or_after_since_come_back(dataset):
    cursor = pd.Timestamp("2025-03-12 14:30:00", tz="UTC")
    since = pd.Timestamp("2025-03-12 14:00:00", tz="UTC")
    result = _as_of("5min", cursor, since)
    for pts in result.values():
        assert pts and all(p.time >= _ts(since) for p in pts)
        assert pts[-1].time == _ts(cursor - pd.Timedelta(minutes=30 - 30))  # 14:30 candle opens at 14:30


def test_unknown_indicator_is_refused(dataset):
    with pytest.raises(indicator_service.UnknownIndicator):
        indicator_service.get_indicators_as_of("MNQ", "1h", 0, 100, 0, ["rsi"])


def test_the_replay_endpoint_serves_the_same_points(client, dataset):
    cursor = pd.Timestamp("2025-03-12 14:37:00", tz="UTC")
    from_ = START + pd.Timedelta(days=2)
    since = cursor - pd.Timedelta(hours=2)
    r = client.get(
        "/api/indicators/replay",
        params={"instrument": "MNQ", "tf": "1h", "from": _ts(from_), "cursor": _ts(cursor), "since": _ts(since), "which": "ema20,atr14"},
    )
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"ema20", "atr14"}
    direct = indicator_service.get_indicators_as_of("MNQ", "1h", _ts(from_), _ts(cursor), _ts(since), ["ema20", "atr14"])
    for name in body:
        assert [(p["time"], p["value"]) for p in body[name]] == [(p.time, p.value) for p in direct[name]]
    bad = client.get(
        "/api/indicators/replay",
        params={"instrument": "MNQ", "from": _ts(from_), "cursor": _ts(cursor), "since": _ts(since), "which": "rsi"},
    )
    assert bad.status_code == 400
