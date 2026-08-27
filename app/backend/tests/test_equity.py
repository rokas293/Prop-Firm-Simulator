from __future__ import annotations

import pandas as pd

from app.backend.services import bundle_reader


def _synthetic_equity_df(n: int, breach_at: int) -> pd.DataFrame:
    """n bars, mostly flat balance/mll_floor (like a real run between
    trades), with a single bar where `breached` flips True -- a Combine
    attempt fails and stops on the bar it breaches (confirmed against the
    real MNQ run bundle: exactly one True row in `breached`), not a
    sustained state. That single bar is the exact scenario stride-sampling
    must not be allowed to drop."""
    idx = pd.date_range("2024-01-01", periods=n, freq="1min", tz="UTC")
    balance = [50000.0] * n
    equity = [50000.0 - (i % 7) for i in range(n)]  # wiggles every bar, like open PnL
    breached = [i == breach_at for i in range(n)]
    return pd.DataFrame(
        {
            "time": idx,
            "balance": balance,
            "open_pnl": [equity[i] - balance[i] for i in range(n)],
            "equity": equity,
            "mll_floor": [48000.0] * n,
            "daily_loss_floor": [49000.0] * n,
            "target_level": [53000.0] * n,
            "trading_day": ["2024-01-01"] * n,
            "day_start_balance": [50000.0] * n,
            "breached": breached,
            "daily_locked": [False] * n,
        }
    )


def test_list_equity_downsamples_large_run_and_keeps_breach_bar(tmp_path, monkeypatch):
    n, breach_at, max_points = 20_000, 12_345, 500
    run_dir = tmp_path / "synthetic_run"
    run_dir.mkdir()
    _synthetic_equity_df(n, breach_at).to_parquet(run_dir / "equity.parquet", index=False)
    monkeypatch.setenv("PROPBT_RUNS_DIR", str(tmp_path))

    rows = bundle_reader.list_equity("synthetic_run", max_points=max_points)

    assert len(rows) <= max_points + 5  # the always-kept breach bar can push it slightly over
    assert len(rows) < n
    assert any(r.breached for r in rows), "the exact bar the run breached on must survive decimation"
    assert rows[0].time == int(pd.Timestamp("2024-01-01", tz="UTC").timestamp())


def test_drawdown_usd_is_running_peak_minus_equity(tmp_path, monkeypatch):
    """Hand-verified sequence: equity 50000 -> 50100 -> 50050 -> 49900 -> 50200.
    Running peak: 50000, 50100, 50100, 50100, 50200.
    Expected drawdown_usd: 0, 0, 50, 200, 0."""
    equity_values = [50000.0, 50100.0, 50050.0, 49900.0, 50200.0]
    n = len(equity_values)
    df = pd.DataFrame(
        {
            "time": pd.date_range("2024-01-01", periods=n, freq="1min", tz="UTC"),
            "balance": [50000.0] * n,
            "open_pnl": [v - 50000.0 for v in equity_values],
            "equity": equity_values,
            "mll_floor": [48000.0] * n,
            "daily_loss_floor": [49000.0] * n,
            "target_level": [53000.0] * n,
            "trading_day": ["2024-01-01"] * n,
            "day_start_balance": [50000.0] * n,
            "breached": [False] * n,
            "daily_locked": [False] * n,
        }
    )
    run_dir = tmp_path / "dd_run"
    run_dir.mkdir()
    df.to_parquet(run_dir / "equity.parquet", index=False)
    monkeypatch.setenv("PROPBT_RUNS_DIR", str(tmp_path))

    rows = bundle_reader.list_equity("dd_run", max_points=100)

    assert [r.drawdown_usd for r in rows] == [0.0, 0.0, 50.0, 200.0, 0.0]


def test_equity_shape(client, known_trade_run):
    run_id, _, _ = known_trade_run
    r = client.get(f"/api/runs/{run_id}/equity")
    assert r.status_code == 200
    body = r.json()
    assert isinstance(body, list)
    assert len(body) > 0
    row = body[0]
    for key in ("time", "balance", "open_pnl", "equity", "mll_floor", "daily_loss_floor",
                "target_level", "day_start_balance", "breached", "daily_locked", "drawdown_usd"):
        assert key in row
    assert isinstance(row["time"], int)
    assert isinstance(row["breached"], bool)


def test_equity_reflects_target_level_and_no_breach(client, known_trade_run):
    run_id, _, _ = known_trade_run
    r = client.get(f"/api/runs/{run_id}/equity")
    rows = r.json()
    assert all(row["target_level"] == 53000.0 for row in rows)  # 50000 start + 3000 target
    assert all(row["breached"] is False for row in rows)  # this fixture never breaches


def test_equity_filter_by_time_range(client, known_trade_run):
    run_id, _, _ = known_trade_run
    r_all = client.get(f"/api/runs/{run_id}/equity")
    all_rows = r_all.json()
    assert len(all_rows) >= 2

    midpoint = all_rows[len(all_rows) // 2]["time"]
    r_filtered = client.get(f"/api/runs/{run_id}/equity", params={"from": midpoint})
    filtered = r_filtered.json()
    assert all(row["time"] >= midpoint for row in filtered)
    assert len(filtered) < len(all_rows)


def test_equity_404_for_unknown_run(client):
    r = client.get("/api/runs/does-not-exist/equity")
    assert r.status_code == 404
