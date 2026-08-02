from __future__ import annotations

import pandas as pd
import pytest

from propbt.config import load_data_paths


def _skip_if_no_mes_data():
    paths = load_data_paths()
    if "MES" not in paths or not paths["MES"].exists():
        pytest.skip("MES data file not present")


def test_sessions_shape_and_known_ny_anchor(client):
    """2025-03-10 is an EDT date: NY 09:30 ET = 13:30 UTC (matches the
    Phase 0 CLI audit of this exact date)."""
    _skip_if_no_mes_data()
    ts_from = int(pd.Timestamp("2025-03-10 00:00:00", tz="UTC").timestamp())
    ts_to = int(pd.Timestamp("2025-03-11 00:00:00", tz="UTC").timestamp())
    r = client.get("/api/sessions", params={"instrument": "MES", "from": ts_from, "to": ts_to})
    assert r.status_code == 200
    windows = r.json()
    assert len(windows) > 0
    for w in windows:
        for key in ("trading_day", "session", "start", "end"):
            assert key in w

    ny_windows = [w for w in windows if w["session"] == "ny" and w["trading_day"] == "2025-03-10"]
    assert len(ny_windows) == 1
    expected_start = int(pd.Timestamp("2025-03-10 13:30:00", tz="UTC").timestamp())
    assert ny_windows[0]["start"] == expected_start
    assert ny_windows[0]["fair_value"] is not None


def test_sessions_unknown_instrument_404(client):
    ts_from = int(pd.Timestamp("2025-03-10", tz="UTC").timestamp())
    ts_to = int(pd.Timestamp("2025-03-11", tz="UTC").timestamp())
    r = client.get("/api/sessions", params={"instrument": "NOPE", "from": ts_from, "to": ts_to})
    assert r.status_code == 404
