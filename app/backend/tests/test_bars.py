from __future__ import annotations

import pandas as pd
import pytest

from propbt.config import load_data_paths


def _skip_if_no_mes_data():
    paths = load_data_paths()
    if "MES" not in paths or not paths["MES"].exists():
        pytest.skip("MES data file not present")


def test_bars_shape_1min(client):
    _skip_if_no_mes_data()
    ts_from = int(pd.Timestamp("2025-03-10 14:30:00", tz="UTC").timestamp())
    ts_to = int(pd.Timestamp("2025-03-10 15:00:00", tz="UTC").timestamp())
    r = client.get("/api/bars", params={"instrument": "MES", "tf": "1min", "from": ts_from, "to": ts_to})
    assert r.status_code == 200
    bars = r.json()
    assert len(bars) > 0
    for b in bars:
        for key in ("time", "open", "high", "low", "close", "volume"):
            assert key in b
    times = [b["time"] for b in bars]
    assert times == sorted(times)  # ascending
    assert times[0] >= ts_from


def test_bars_downsamples_wide_window_honestly(client):
    _skip_if_no_mes_data()
    ts_from = int(pd.Timestamp("2025-01-01 00:00:00", tz="UTC").timestamp())
    ts_to = int(pd.Timestamp("2025-06-01 00:00:00", tz="UTC").timestamp())
    r = client.get("/api/bars", params={
        "instrument": "MES", "tf": "1min", "from": ts_from, "to": ts_to, "max_points": 500,
    })
    assert r.status_code == 200
    bars = r.json()
    assert 0 < len(bars) <= 600  # some slack: the ladder steps to the next coarser tf that fits, not exactly 500
    # never dumps the full ~5 months of 1-minute bars (~200k+) for a 500-point budget
    assert len(bars) < 5000


def test_bars_unknown_instrument_404(client):
    ts_from = int(pd.Timestamp("2025-03-10", tz="UTC").timestamp())
    ts_to = int(pd.Timestamp("2025-03-11", tz="UTC").timestamp())
    r = client.get("/api/bars", params={"instrument": "NOPE", "from": ts_from, "to": ts_to})
    assert r.status_code == 404


def test_bars_missing_required_params_422(client):
    r = client.get("/api/bars", params={"instrument": "MES"})
    assert r.status_code == 422
