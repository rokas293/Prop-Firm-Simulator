from __future__ import annotations

from app.backend.services import compass_service


def test_ai_status_unconfigured_by_default(client, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    r = client.get("/api/ai/status")
    assert r.status_code == 200
    assert r.json() == {"available": False}


def test_summarize_503_when_unconfigured(client, known_trade_run, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    run_id, _, _ = known_trade_run
    r = client.post(f"/api/runs/{run_id}/summarize")
    assert r.status_code == 503


def test_ai_status_configured_when_key_present(client, monkeypatch):
    # Only checks the env-var gate -- does not make a real network call.
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-fake-for-test")
    r = client.get("/api/ai/status")
    assert r.json() == {"available": True}


# --- format_stats_for_prompt: pure, no network call -----------------------

_SAMPLE_STATS = {
    "overall": {
        "trades": 42,
        "net_pnl_usd": 1234.5,
        "net_r": 12.3,
        "win_rate": 0.55,
        "expectancy_usd": 29.4,
        "expectancy_r": 0.29,
        "profit_factor": 1.8,
        "max_drawdown_usd": 500.0,
    },
    "by_leg": {
        "continuation": {
            "trades": 20,
            "net_pnl_usd": 600.0,
            "net_r": 6.0,
            "win_rate": 0.5,
            "expectancy_usd": 30.0,
            "expectancy_r": 0.3,
            "profit_factor": 1.5,
            "max_drawdown_usd": 200.0,
        }
    },
    "by_session": {
        "ny": {
            "trades": 30,
            "net_pnl_usd": 900.0,
            "net_r": 9.0,
            "win_rate": 0.6,
            "expectancy_usd": 30.0,
            "expectancy_r": 0.3,
            "profit_factor": 2.0,
            "max_drawdown_usd": 150.0,
        }
    },
    "result": {
        "status": "passed",
        "fail_reason": None,
        "target_hit": True,
        "consistency_passed": True,
        "final_balance": 53100.0,
        "trading_days": 18,
    },
}


def test_format_stats_for_prompt_includes_all_sections():
    text = compass_service.format_stats_for_prompt(_SAMPLE_STATS, "oos")
    assert "Scope: oos" in text
    assert "42 trades" in text
    assert "win rate 55.0%" in text
    assert "Result: passed" in text
    assert "target hit: yes" in text
    assert "consistency: passed" in text
    assert "By leg:" in text
    assert "continuation:" in text
    assert "By session:" in text
    assert "ny:" in text


def test_format_stats_for_prompt_handles_missing_result_and_none_fields():
    stats = {
        "overall": {**_SAMPLE_STATS["overall"], "win_rate": None, "profit_factor": None},
        "by_leg": {},
        "by_session": {},
        "result": None,
    }
    text = compass_service.format_stats_for_prompt(stats, "all")
    assert "win rate n/a" in text
    assert "By leg:" not in text
    assert "Result:" not in text
