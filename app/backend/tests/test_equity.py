from __future__ import annotations


def test_equity_shape(client, known_trade_run):
    run_id, _, _ = known_trade_run
    r = client.get(f"/api/runs/{run_id}/equity")
    assert r.status_code == 200
    body = r.json()
    assert isinstance(body, list)
    assert len(body) > 0
    row = body[0]
    for key in ("time", "balance", "open_pnl", "equity", "mll_floor", "daily_loss_floor",
                "target_level", "day_start_balance", "breached", "daily_locked"):
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
