from __future__ import annotations


def test_list_runs_shape(client, known_trade_run):
    run_id, _, _ = known_trade_run
    r = client.get("/api/runs")
    assert r.status_code == 200
    body = r.json()
    assert isinstance(body, list)
    assert len(body) == 1
    run = body[0]
    assert run["run_id"] == run_id
    assert run["instrument"] == "MES"
    assert run["date_from"] == "2025-03-11"
    assert run["date_to"] == "2025-03-11"
    assert run["base_timeframe"] == "1m"
    assert "result" in run and "passed" in run["result"]
    assert run["params_count"] > 0
    assert "config_hash" not in run  # RunSummary omits it; only /runs/{id} has it


def test_get_run_meta_shape(client, known_trade_run):
    run_id, _, _ = known_trade_run
    r = client.get(f"/api/runs/{run_id}")
    assert r.status_code == 200
    body = r.json()
    assert body["run_id"] == run_id
    assert "config_hash" in body
    assert body["is_oos_split_date"] == "2025-06-01"


def test_get_run_meta_404_for_unknown_run(client):
    r = client.get("/api/runs/does-not-exist")
    assert r.status_code == 404


def test_list_runs_empty_when_no_runs(client, monkeypatch, tmp_path):
    monkeypatch.setenv("PROPBT_RUNS_DIR", str(tmp_path / "empty"))
    r = client.get("/api/runs")
    assert r.status_code == 200
    assert r.json() == []
