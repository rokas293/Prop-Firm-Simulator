from __future__ import annotations

import pandas as pd

from app.backend.services import bundle_reader


def _write_synthetic_run(tmp_path):
    """Three trading days, hand-verified:
    - 2024-01-01: equity flat at 50000, mll_floor 48000 -> distance 2000 all day. No lock, no breach.
    - 2024-01-02: equity dips to 49200 mid-day (mll_floor 48000) -> min distance 1200. Daily-locked
      on the dip bar (simulating the day's -$1000 loss limit triggering), never breaches.
    - 2024-01-03: equity dips to 47990 (mll_floor 48000) -> min distance -10 -> breached.
    """
    rows = []

    def add_day(day, equities, mll_floor, breached_at=None, locked_at=None):
        idx = pd.date_range(f"{day} 00:00", periods=len(equities), freq="1min", tz="UTC")
        for i, (t, e) in enumerate(zip(idx, equities)):
            rows.append(
                {
                    "time": t,
                    "balance": 50000.0,
                    "open_pnl": e - 50000.0,
                    "equity": e,
                    "mll_floor": mll_floor,
                    "daily_loss_floor": 49000.0,
                    "target_level": 53000.0,
                    "trading_day": day,
                    "day_start_balance": 50000.0,
                    "breached": breached_at is not None and i == breached_at,
                    "daily_locked": locked_at is not None and i == locked_at,
                }
            )

    add_day("2024-01-01", [50000.0] * 5, 48000.0)
    add_day("2024-01-02", [50000.0, 49600.0, 49200.0, 49500.0, 49800.0], 48000.0, locked_at=2)
    add_day("2024-01-03", [50000.0, 48500.0, 47990.0], 48000.0, breached_at=2)

    equity_df = pd.DataFrame(rows)

    trades_df = pd.DataFrame(
        {
            "trading_day": ["2024-01-01", "2024-01-01", "2024-01-02", "2024-01-02", "2024-01-02", "2024-01-03"],
        }
    )

    run_dir = tmp_path / "risk_run"
    run_dir.mkdir()
    equity_df.to_parquet(run_dir / "equity.parquet", index=False)
    trades_df.to_parquet(run_dir / "trades.parquet", index=False)
    return run_dir


def test_list_daily_risk_hand_verified(tmp_path, monkeypatch):
    _write_synthetic_run(tmp_path)
    monkeypatch.setenv("PROPBT_RUNS_DIR", str(tmp_path))

    rows = {r.trading_day: r for r in bundle_reader.list_daily_risk("risk_run")}

    assert set(rows.keys()) == {"2024-01-01", "2024-01-02", "2024-01-03"}

    d1 = rows["2024-01-01"]
    assert d1.min_distance_to_mll_usd == 2000.0
    assert d1.breached is False
    assert d1.daily_locked is False
    assert d1.trades == 2

    d2 = rows["2024-01-02"]
    assert d2.min_distance_to_mll_usd == 1200.0
    assert d2.breached is False
    assert d2.breach_time is None
    assert d2.daily_locked is True
    assert d2.daily_lock_time == int(pd.Timestamp("2024-01-02 00:02", tz="UTC").timestamp())
    assert d2.trades == 3

    d3 = rows["2024-01-03"]
    assert d3.min_distance_to_mll_usd == -10.0
    assert d3.breached is True
    assert d3.breach_time == int(pd.Timestamp("2024-01-03 00:02", tz="UTC").timestamp())
    assert d3.daily_locked is False
    assert d3.daily_lock_time is None
    assert d3.trades == 1
    assert d3.min_distance_time == int(pd.Timestamp("2024-01-03 00:02", tz="UTC").timestamp())


def test_daily_risk_endpoint_shape(client, known_trade_run):
    run_id, _, _ = known_trade_run
    r = client.get(f"/api/runs/{run_id}/daily_risk")
    assert r.status_code == 200
    body = r.json()
    assert isinstance(body, list)
    assert len(body) >= 1
    for key in ("trading_day", "min_distance_to_mll_usd", "min_distance_time", "breached", "daily_locked", "trades"):
        assert key in body[0]


def test_daily_risk_404_for_unknown_run(client):
    r = client.get("/api/runs/does-not-exist/daily_risk")
    assert r.status_code == 404
