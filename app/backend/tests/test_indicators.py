from __future__ import annotations

import pandas as pd
import pytest

from propbt.config import load_data_paths


def _skip_if_no_mes_data():
    paths = load_data_paths()
    if "MES" not in paths or not paths["MES"].exists():
        pytest.skip("MES data file not present")


def test_indicators_shape(client):
    _skip_if_no_mes_data()
    ts_from = int(pd.Timestamp("2025-03-10 13:30:00", tz="UTC").timestamp())
    ts_to = int(pd.Timestamp("2025-03-10 15:00:00", tz="UTC").timestamp())
    r = client.get(
        "/api/indicators",
        params={"instrument": "MES", "tf": "1min", "from": ts_from, "to": ts_to, "which": "vwap,ema20,ema50,atr14"},
    )
    assert r.status_code == 200
    body = r.json()
    assert set(body.keys()) == {"vwap", "ema20", "ema50", "atr14"}
    for name, points in body.items():
        assert len(points) > 0, name
        for p in points:
            assert "time" in p and "value" in p
        times = [p["time"] for p in points]
        assert times == sorted(times)
        assert times[0] >= ts_from


def test_indicators_vwap_resets_at_ny_open(client):
    """2025-03-10 NY open is 13:30 UTC (EDT). The first VWAP point at/after
    the NY session start must equal just that first bar's own typical
    price (H+L+C)/3 -- proof the session reset actually happened and isn't
    carrying over London's accumulated VWAP."""
    _skip_if_no_mes_data()
    ny_open = int(pd.Timestamp("2025-03-10 13:30:00", tz="UTC").timestamp())
    ts_to = int(pd.Timestamp("2025-03-10 14:00:00", tz="UTC").timestamp())

    r_bars = client.get("/api/bars", params={"instrument": "MES", "tf": "1min", "from": ny_open, "to": ts_to})
    bars = r_bars.json()
    first_bar = bars[0]
    assert first_bar["time"] == ny_open
    expected_typical = (first_bar["high"] + first_bar["low"] + first_bar["close"]) / 3

    r = client.get(
        "/api/indicators",
        params={"instrument": "MES", "tf": "1min", "from": ny_open, "to": ts_to, "which": "vwap"},
    )
    points = r.json()["vwap"]
    first_vwap = points[0]
    assert first_vwap["time"] == ny_open
    assert first_vwap["value"] == pytest.approx(expected_typical)


def test_indicators_unknown_indicator_400(client):
    _skip_if_no_mes_data()
    ts_from = int(pd.Timestamp("2025-03-10", tz="UTC").timestamp())
    ts_to = int(pd.Timestamp("2025-03-11", tz="UTC").timestamp())
    r = client.get(
        "/api/indicators", params={"instrument": "MES", "from": ts_from, "to": ts_to, "which": "bogus"}
    )
    assert r.status_code == 400


def test_indicators_unknown_instrument_404(client):
    ts_from = int(pd.Timestamp("2025-03-10", tz="UTC").timestamp())
    ts_to = int(pd.Timestamp("2025-03-11", tz="UTC").timestamp())
    r = client.get(
        "/api/indicators", params={"instrument": "NOPE", "from": ts_from, "to": ts_to, "which": "vwap"}
    )
    assert r.status_code == 404
