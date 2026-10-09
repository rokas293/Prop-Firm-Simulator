"""FXR_V2_SPEC.md section 4 (G6): prop rule sets, presets and the setup form's
server side.

The load-bearing test is the Topstep regression: sessions saved BEFORE the rule
builder (real v1 sessions plus synthetic ones covering pass / consistency
dilution / MLL breach / daily lock + freeze / partial exits across two days) are
replayed through today's code -- migrated onto the "Topstep 50k" preset -- and
every verdict, stat, equity vertex and daily-risk row must equal the golden
recorded from the pre-G6 engine (tests/fixtures/topstep_regression).
"""
from __future__ import annotations

import json
import shutil
from dataclasses import replace
from pathlib import Path

import pandas as pd
import pytest

from app.backend import models
from app.backend.services import bt_session_service as bts
from app.backend.services import home_service
from app.backend.services import manual_analytics as ma
from app.backend.services import prop_presets
from propbt.config import load_prop_rules

FIXTURES = Path(__file__).parent / "fixtures" / "topstep_regression"


@pytest.fixture()
def bt_client(client, tmp_path, monkeypatch):
    monkeypatch.setenv("PROPBT_BT_SESSIONS_DIR", str(tmp_path / "bt_sessions"))
    return client


def _start() -> int:
    return int(pd.Timestamp("2025-03-10 14:30:00", tz="UTC").timestamp())


def _create(client, **overrides):
    body = {"instrument": "MES", "base_timeframe": "5min", "start_time": _start(), "starting_balance": 50000.0}
    body.update(overrides)
    return client.post("/api/bt-sessions", json=body)


CUSTOM_RULES = {
    "profit_target": 2500.0,
    "max_loss_type": "static",
    "max_loss": 1500.0,
    "daily_loss_limit": 600.0,
    "consistency_pct": 40.0,
    "max_contracts": 3,
    "no_overnight": True,
    "no_weekend": True,
    "no_news": True,
    "close_time": "15:45",
}


# ------------------------------ Topstep regression ------------------------------

def _snapshot(session_id: str) -> dict:
    run_id = ma.MANUAL_PREFIX + session_id
    stats = ma.get_stats(run_id)
    eq = ma.build_equity_frame(run_id)
    return {
        "status": ma.prop_status(session_id).model_dump(),
        "result": stats.result.model_dump() if stats.result else None,
        "overall": stats.overall.model_dump(),
        "equity": json.loads(eq.to_json(orient="records", date_format="epoch")),
        "daily_risk": [r.model_dump() for r in ma.list_daily_risk(run_id)],
    }


def test_existing_topstep_sessions_keep_their_exact_verdicts(tmp_path, monkeypatch):
    sessions_dir = tmp_path / "bt_sessions"
    shutil.copytree(FIXTURES / "sessions", sessions_dir)
    monkeypatch.setenv("PROPBT_BT_SESSIONS_DIR", str(sessions_dir))
    golden = json.loads((FIXTURES / "golden.json").read_text(encoding="utf-8"))

    ids = sorted(s.id for s in bts.list_sessions(include_archived=True))
    assert ids == sorted(golden), "fixture sessions and golden verdicts must cover the same sessions"
    outcomes = set()
    for sid in ids:
        # Every one is a v1 file: no prop_rules on disk, the preset arrives by migration.
        raw = json.loads((sessions_dir / sid / "session.json").read_text(encoding="utf-8"))
        assert "prop_rules" not in raw["account"]
        got = json.loads(json.dumps(_snapshot(sid)))
        assert got == golden[sid], f"{sid}: verdict changed"
        outcomes.add((got["status"]["status"], got["status"]["fail_reason"]))
    # The set is worth something only if it covers more than one outcome.
    assert {("passed", None), ("failed", "mll_breach"), ("incomplete", None)} <= outcomes


def test_a_saved_topstep_session_is_mapped_onto_the_preset_on_load(tmp_path, monkeypatch):
    sessions_dir = tmp_path / "bt_sessions"
    shutil.copytree(FIXTURES / "sessions", sessions_dir)
    monkeypatch.setenv("PROPBT_BT_SESSIONS_DIR", str(sessions_dir))
    s = bts.get_session("real_20261003T200033Z_fbb5d32f")
    assert s.account.prop_ruleset == "topstep_50k"
    assert s.account.prop_rules == prop_presets.topstep_50k().rules
    assert s.account.max_contracts == 5
    assert s.account.commissions == {"MES": 1.3}
    assert s.account.prop_rules.no_overnight is False and s.account.prop_rules.no_weekend is False  # as it always was


def test_the_topstep_preset_is_the_yaml_config_to_the_last_field():
    cfg = load_prop_rules()
    preset = prop_presets.topstep_50k()
    built = prop_presets.engine_config(preset.rules, preset.starting_balance, cfg.commissions)
    assert built == cfg
    assert (preset.rules.max_loss_type, preset.rules.max_loss, preset.rules.max_contracts) == ("eod_trailing", 2000.0, 5)
    assert preset.rules.consistency_pct == 50.0


# ----------------------------- creating prop sessions -----------------------------

def test_the_topstep_preset_session_gets_the_preset_rules(bt_client):
    r = _create(bt_client, prop_ruleset="topstep_50k")
    assert r.status_code == 200, r.text
    a = r.json()["account"]
    assert a["prop_ruleset"] == "topstep_50k" and a["max_contracts"] == 5
    assert a["prop_rules"] == prop_presets.topstep_50k().rules.model_dump()


def test_custom_rules_are_stored_and_labelled_custom(bt_client):
    r = _create(bt_client, prop_ruleset="custom", prop_rules=CUSTOM_RULES, quick_quantity=2)
    assert r.status_code == 200, r.text
    a = r.json()["account"]
    assert a["prop_ruleset"] == "custom"
    assert a["max_contracts"] == 3
    assert a["prop_rules"]["max_loss_type"] == "static" and a["prop_rules"]["close_time"] == "15:45"
    assert a["prop_rules"]["no_overnight"] and a["prop_rules"]["no_weekend"] and a["prop_rules"]["no_news"]
    # ... and they survive a reload from disk.
    again = bt_client.get(f"/api/bt-sessions/{r.json()['id']}").json()
    assert again["account"]["prop_rules"] == a["prop_rules"]


def test_custom_rules_that_equal_the_preset_are_labelled_with_it(bt_client):
    rules = prop_presets.topstep_50k().rules.model_dump()
    r = _create(bt_client, prop_ruleset="custom", prop_rules=rules)
    assert r.json()["account"]["prop_ruleset"] == "topstep_50k"


def test_an_edited_preset_becomes_custom(bt_client):
    rules = {**prop_presets.topstep_50k().rules.model_dump(), "profit_target": 4000.0}
    r = _create(bt_client, prop_ruleset="topstep_50k", prop_rules=rules)
    assert r.status_code == 200
    assert r.json()["account"]["prop_ruleset"] == "custom"


@pytest.mark.parametrize(
    "overrides, message",
    [
        ({"prop_ruleset": "custom"}, "needs prop_rules"),
        ({"prop_rules": CUSTOM_RULES}, "needs a prop_ruleset"),
        ({"prop_ruleset": "nope"}, "prop_ruleset must be one of"),
        ({"prop_ruleset": "topstep_50k", "starting_balance": 100000.0}, "requires starting_balance == 50000"),
        ({"prop_ruleset": "custom", "prop_rules": {**CUSTOM_RULES, "max_loss": 60000.0}}, "max loss must be smaller"),
        ({"prop_ruleset": "custom", "prop_rules": {**CUSTOM_RULES, "daily_loss_limit": 2000.0}}, "daily loss limit cannot be larger"),
        ({"prop_ruleset": "custom", "prop_rules": CUSTOM_RULES, "quick_quantity": 4}, "exceeds the custom prop rules position limit of 3"),
        ({"prop_ruleset": "custom", "prop_rules": {**CUSTOM_RULES, "close_time": "17:30"}}, "close time must be between 09:30 and 17:00"),
        ({"prop_ruleset": "custom", "prop_rules": {**CUSTOM_RULES, "close_time": "03:00"}}, "close time must be between 09:30 and 17:00"),
    ],
)
def test_invalid_prop_setups_are_refused_with_a_reason(bt_client, overrides, message):
    r = _create(bt_client, **overrides)
    assert r.status_code == 400
    assert message in r.json()["detail"]


def test_an_out_of_range_rule_is_a_422(bt_client):
    r = _create(bt_client, prop_ruleset="custom", prop_rules={**CUSTOM_RULES, "close_time": "25:99"})
    assert r.status_code == 422
    r = _create(bt_client, prop_ruleset="custom", prop_rules={**CUSTOM_RULES, "consistency_pct": 150})
    assert r.status_code == 422


def test_optional_rules_may_be_left_out(bt_client):
    minimal = {"profit_target": 1000.0, "max_loss": 500.0}
    r = _create(bt_client, prop_ruleset="custom", prop_rules=minimal)
    assert r.status_code == 200, r.text
    rules = r.json()["account"]["prop_rules"]
    assert rules["daily_loss_limit"] is None and rules["consistency_pct"] is None and rules["max_contracts"] is None
    assert r.json()["account"]["max_contracts"] is None  # uncapped


# --------------------------- how custom rules are judged ---------------------------

DAY = 86400
MON = 1741617000  # Mon 2025-03-10 14:30Z (09:30 ET)


def _trade(i: int, day: int, pnl: float, mae: float = 0.0, mfe: float = 0.0) -> dict:
    t0 = MON + day * DAY
    return {
        "trade_id": i, "entry_time": t0, "exit_time": t0 + 600, "instrument": "MES", "side": "long",
        "size_contracts": 1, "entry_price": 5500.0, "exit_price": 5500.0 + pnl / 5, "exit_type": "manual",
        "pnl_usd": pnl, "commission_usd": 0.0, "mae_points": mae, "mfe_points": mfe, "bars_held": 2,
        "source": "manual", "session_id": "x", "tags": [], "screenshots": [], "notes": "",
    }


def _verdict(client, rules: dict, trades: list) -> dict:
    sid = _create(client, prop_ruleset="custom", prop_rules=rules).json()["id"]
    bts._write_trades(sid, [{**t, "session_id": sid} for t in trades])
    return ma.prop_status(sid).model_dump()


def test_a_static_floor_does_not_trail_where_eod_trailing_would(bt_client):
    base = {"profit_target": 4000.0, "max_loss": 1000.0, "max_loss_locks_at_start": False}
    # +800 (balance 50,800), then a trade that dips 200 points ($1,000): equity 49,800.
    # EOD-trailing floor after day 1 is 49,800 (50,800 - 1,000): breached.
    # Static floor stays 49,000: alive.
    trades = [_trade(1, 0, 800.0), _trade(2, 1, 0.0, mae=200.0)]
    assert _verdict(bt_client, {**base, "max_loss_type": "eod_trailing"}, trades)["status"] == "failed"
    assert _verdict(bt_client, {**base, "max_loss_type": "static"}, trades)["status"] == "incomplete"


def test_intraday_trailing_takes_the_trades_high_into_account(bt_client):
    base = {"profit_target": 4000.0, "max_loss": 1000.0, "max_loss_locks_at_start": False}
    # One trade rises 250 points ($1,250) then ends at a loss after dipping 150 points ($750)
    # below entry. Its high lifted the intraday floor to 50,250; the low (49,250) is under it.
    trades = [_trade(1, 0, -100.0, mae=150.0, mfe=250.0)]
    assert _verdict(bt_client, {**base, "max_loss_type": "intraday_trailing"}, trades)["status"] == "failed"
    # EOD trailing never saw the high mid-day: floor 49,000, the low 49,250 survives.
    assert _verdict(bt_client, {**base, "max_loss_type": "eod_trailing"}, trades)["status"] == "incomplete"


def test_no_consistency_rule_lets_one_big_day_pass(bt_client):
    rules = {"profit_target": 1000.0, "max_loss": 1500.0, "max_loss_type": "static"}
    trades = [_trade(1, 0, 1200.0)]
    assert _verdict(bt_client, rules, trades)["status"] == "passed"
    held_back = {**rules, "consistency_pct": 50.0}
    assert _verdict(bt_client, held_back, trades)["status"] == "incomplete"


def test_the_daily_loss_limit_is_optional_in_the_equity_timeline(bt_client):
    sid = _create(bt_client, prop_ruleset="custom", prop_rules={"profit_target": 1000.0, "max_loss": 1500.0}).json()["id"]
    bts._write_trades(sid, [{**_trade(1, 0, -300.0), "session_id": sid}])
    eq = bt_client.get(f"/api/runs/bt:{sid}/equity")
    assert eq.status_code == 200
    points = eq.json()
    assert len(points) >= 2
    # No daily limit = no floor to draw (null, not a made-up number), and no lock.
    assert all(p["daily_loss_floor"] is None and p["daily_locked"] is False for p in points)
    assert points[-1]["mll_floor"] == 48500.0  # the static floor: 50,000 - 1,500


# --------------------------------- the date range ---------------------------------

def test_end_date_must_be_after_the_start_and_inside_the_data(bt_client):
    lo, hi = bts.bar_service.get_instrument_range("MES")
    assert _create(bt_client, end_date=_start() - 60).status_code == 400
    r = _create(bt_client, end_date=hi + DAY)
    assert r.status_code == 400 and "after MES's last available data" in r.json()["detail"]
    assert _create(bt_client, end_date=_start() + DAY).status_code == 200


def test_random_start_with_a_duration_derives_the_end_inside_the_data(bt_client):
    lo, hi = bts.bar_service.get_instrument_range("MES")
    r = _create(bt_client, random_start=True, start_time=None, random_duration_seconds=7 * DAY)
    assert r.status_code == 200, r.text
    s = r.json()
    assert s["end_date"] - s["start_time"] == 7 * DAY
    assert lo <= s["start_time"] and s["end_date"] <= hi


def test_random_start_rules(bt_client):
    assert _create(bt_client, random_start=True, end_date=_start() + DAY).status_code == 400
    assert _create(bt_client, random_duration_seconds=DAY).status_code == 400
    assert _create(bt_client, random_start=True, random_duration_seconds=10).status_code == 400
    assert _create(bt_client, random_start=True, random_duration_seconds=10 ** 10).status_code == 400
    # No duration: an open-ended random session, as before.
    r = _create(bt_client, random_start=True, start_time=None)
    assert r.status_code == 200 and r.json()["end_date"] is None


# ------------------------------ commissions and options ------------------------------

def test_commission_per_instrument_prices_the_primary_asset(bt_client):
    r = _create(bt_client, assets=["MES"], commissions={"MES": 0.62})
    a = r.json()["account"]
    assert a["commissions"] == {"MES": 0.62} and a["commission_per_contract"] == 0.62
    assert _create(bt_client, commissions={"MNQ": 1.0}).status_code == 400
    assert _create(bt_client, commissions={"MES": -1.0}).status_code == 400


def test_setup_options_list_the_ranges_and_presets(bt_client):
    r = bt_client.get("/api/bt-sessions/setup-options")
    assert r.status_code == 200
    body = r.json()
    lo, hi = bts.bar_service.get_instrument_range("MES")
    assert body["ranges"]["MES"] == {"min": lo, "max": hi}
    assert set(body["ranges"]) == {"MNQ", "MES"}
    assert [p["id"] for p in body["presets"]] == ["topstep_50k"]
    assert body["presets"][0]["starting_balance"] == 50000.0
    assert body["default_commissions"]["MES"] == bts.DEFAULT_COMMISSION


# ------------------------------------ home page ------------------------------------

def test_home_overview_counts_trades_wins_and_weekdays(bt_client):
    sid = _create(bt_client).json()["id"]
    trades = [_trade(1, 0, 100.0), _trade(2, 0, -50.0), {**_trade(3, 1, 80.0), "side": "short"}, _trade(4, 1, 30.0)]
    bts._write_trades(sid, [{**t, "session_id": sid} for t in trades])
    body = bt_client.get("/api/bt-sessions/home").json()
    k = body["kpis"]
    assert (k["trades"], k["buys"], k["sells"], k["wins"]) == (4, 3, 1, 3)
    assert k["win_rate"] == 0.75 and k["avg_time_in_trade_seconds"] == 600
    by = {d["label"]: d for d in body["weekday"]}
    assert (by["Mon"]["trades"], by["Mon"]["win_rate"]) == (2, 0.5)
    assert (by["Tue"]["trades"], by["Tue"]["win_rate"]) == (2, 1.0)
    assert by["Wed"]["trades"] == 0 and by["Wed"]["win_rate"] is None


def test_home_overview_is_empty_without_trades(bt_client):
    body = bt_client.get("/api/bt-sessions/home").json()
    assert body["kpis"]["trades"] == 0 and body["kpis"]["win_rate"] is None
    assert len(body["weekday"]) == 5 and all(d["win_rate"] is None for d in body["weekday"])


def test_archived_sessions_do_not_count_on_the_home_page(bt_client):
    sid = _create(bt_client).json()["id"]
    bts._write_trades(sid, [{**_trade(1, 0, 100.0), "session_id": sid}])
    bt_client.post(f"/api/bt-sessions/{sid}/archive")
    assert bt_client.get("/api/bt-sessions/home").json()["kpis"]["trades"] == 0


def test_the_session_list_carries_progress(bt_client):
    start = _start()
    r = _create(bt_client, end_date=start + 5 * DAY)
    sid = r.json()["id"]
    row = next(s for s in bt_client.get("/api/bt-sessions").json() if s["id"] == sid)
    p = row["progress"]
    assert p["fraction"] == 0.0 and p["complete"] is False
    assert p["trading_days_total"] >= 4 and p["trading_days_remaining"] == p["trading_days_total"] - 1
    # An open-ended session has no progress bar to show.
    open_id = _create(bt_client).json()["id"]
    row = next(s for s in bt_client.get("/api/bt-sessions").json() if s["id"] == open_id)
    assert row["progress"]["fraction"] is None and row["progress"]["trading_days_remaining"] is None


def test_progress_is_complete_when_the_cursor_reaches_the_last_bar_of_the_end_date(bt_client):
    start = _start()
    end = start + 2 * DAY
    sid = _create(bt_client, end_date=end).json()["id"]
    last = bts.bar_service.last_bar_time_at_or_before("MES", end)
    bt_client.patch(f"/api/bt-sessions/{sid}/cursor", json={"cursor_time": last, "position": None, "working_orders": []})
    p = next(s for s in bt_client.get("/api/bt-sessions").json() if s["id"] == sid)["progress"]
    assert p["complete"] is True and p["fraction"] > 0.99 and p["trading_days_remaining"] == 0
