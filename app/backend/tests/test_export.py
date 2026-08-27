from __future__ import annotations


def test_export_snapshot_html_shape(client, known_trade_run):
    run_id, _, _ = known_trade_run
    r = client.get(f"/api/runs/{run_id}/export.html")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/html")
    body = r.text
    assert run_id in body
    assert "continuation" in body  # the fixture's known leg
    assert "73.70" in body  # the fixture's hand-verified pnl_usd


def test_export_snapshot_404_for_unknown_run(client):
    r = client.get("/api/runs/does-not-exist/export.html")
    assert r.status_code == 404
