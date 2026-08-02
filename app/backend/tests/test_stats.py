from __future__ import annotations

import pytest


def test_stats_shape_and_known_values(client, known_trade_run):
    run_id, _, _ = known_trade_run
    r = client.get(f"/api/runs/{run_id}/stats")
    assert r.status_code == 200
    body = r.json()
    assert body["scope"] == "all"
    for key in ("overall", "by_leg", "by_session", "result"):
        assert key in body

    overall = body["overall"]
    assert overall["trades"] == 1
    assert overall["net_pnl_usd"] == pytest.approx(73.70)
    assert overall["win_rate"] == 1.0
    assert overall["expectancy_usd"] == pytest.approx(73.70)

    assert "continuation" in body["by_leg"]
    assert body["by_leg"]["continuation"]["trades"] == 1
    assert "ny" in body["by_session"]

    assert body["result"]["status"] in ("passed", "failed", "incomplete")


def test_stats_scope_is_oos_split(client, known_trade_run):
    """The fixture's single trade (2025-03-11) is before the fixture's
    is_oos_split_date (2025-06-01) -- so it should show up entirely
    in-sample and be empty out-of-sample."""
    run_id, _, _ = known_trade_run

    r_is = client.get(f"/api/runs/{run_id}/stats", params={"scope": "is"})
    assert r_is.json()["overall"]["trades"] == 1
    assert r_is.json()["scope"] == "is"

    r_oos = client.get(f"/api/runs/{run_id}/stats", params={"scope": "oos"})
    assert r_oos.json()["overall"]["trades"] == 0
    assert r_oos.json()["scope"] == "oos"

    # pass/fail result is scope-invariant -- it's a property of the whole run
    assert r_is.json()["result"] == r_oos.json()["result"]


def test_stats_invalid_scope_400(client, known_trade_run):
    run_id, _, _ = known_trade_run
    r = client.get(f"/api/runs/{run_id}/stats", params={"scope": "bogus"})
    assert r.status_code == 400


def test_stats_404_for_unknown_run(client):
    r = client.get("/api/runs/does-not-exist/stats")
    assert r.status_code == 404
