from __future__ import annotations

import pandas as pd
import pytest


def test_trades_shape(client, known_trade_run):
    run_id, _, _ = known_trade_run
    r = client.get(f"/api/runs/{run_id}/trades")
    assert r.status_code == 200
    body = r.json()
    assert isinstance(body, list)
    assert len(body) == 1
    t = body[0]
    for key in ("trade_id", "entry_time", "exit_time", "side", "leg", "session", "pnl_usd",
                "r_multiple", "mae_points", "mfe_points", "mae_r", "mfe_r", "sl_price", "tp_price"):
        assert key in t
    assert isinstance(t["entry_time"], int)  # unix seconds, not a string
    assert isinstance(t["exit_time"], int)


def test_trades_known_value_spot_check(client, known_trade_run):
    """Hand-verified against KNOWN_BARS in conftest.py: LONG, entry 5006
    (bar @ 13:31 UTC), TP exit at 5021 (bar @ 13:33 UTC), sl=10pt/rr=1.5,
    MES point_value=$5, commission=$1.30."""
    run_id, _, _ = known_trade_run
    r = client.get(f"/api/runs/{run_id}/trades")
    t = r.json()[0]

    expected_entry_ts = int(pd.Timestamp("2025-03-11 13:31:00", tz="UTC").timestamp())
    expected_exit_ts = int(pd.Timestamp("2025-03-11 13:33:00", tz="UTC").timestamp())

    assert t["entry_time"] == expected_entry_ts
    assert t["exit_time"] == expected_exit_ts
    assert t["side"] == "long"
    assert t["leg"] == "continuation"
    assert t["session"] == "ny"
    assert t["entry_price"] == pytest.approx(5006)
    assert t["exit_price"] == pytest.approx(5021)
    assert t["sl_price"] == pytest.approx(4996)
    assert t["tp_price"] == pytest.approx(5021)
    assert t["sl_points"] == pytest.approx(10)
    assert t["tp_points"] == pytest.approx(15)
    assert t["rr_planned"] == pytest.approx(1.5)
    assert t["exit_type"] == "tp"
    assert t["pnl_usd"] == pytest.approx(73.70)             # (5021-5006)*5*1 - 1.30
    assert t["r_multiple"] == pytest.approx(73.70 / 50)      # risk = 10pt * $5 * 1 contract
    assert t["commission_usd"] == pytest.approx(1.30)
    assert t["mae_points"] == pytest.approx(9)                # 5006 - 4997
    assert t["mfe_points"] == pytest.approx(19)                # 5025 - 5006
    assert t["mae_r"] == pytest.approx(0.9)
    assert t["mfe_r"] == pytest.approx(1.9)
    assert t["bars_held"] == 3


def test_trades_filter_by_leg_matches(client, known_trade_run):
    run_id, _, _ = known_trade_run
    r = client.get(f"/api/runs/{run_id}/trades", params={"leg": "continuation"})
    assert len(r.json()) == 1
    r2 = client.get(f"/api/runs/{run_id}/trades", params={"leg": "mean_reversion"})
    assert r2.json() == []


def test_trades_filter_by_result(client, known_trade_run):
    run_id, _, _ = known_trade_run
    r = client.get(f"/api/runs/{run_id}/trades", params={"result": "win"})
    assert len(r.json()) == 1
    r2 = client.get(f"/api/runs/{run_id}/trades", params={"result": "loss"})
    assert r2.json() == []


def test_trades_filter_by_time_range_excludes(client, known_trade_run):
    run_id, _, _ = known_trade_run
    far_future = int(pd.Timestamp("2030-01-01", tz="UTC").timestamp())
    r = client.get(f"/api/runs/{run_id}/trades", params={"from": far_future})
    assert r.json() == []


def test_trades_404_for_unknown_run(client):
    r = client.get("/api/runs/does-not-exist/trades")
    assert r.status_code == 404
