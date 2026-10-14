"""FXR_V2_SPEC.md section 8 (G10a): Autopilot's behaviour around the engine --
what it refuses, what it records when it is switched off and on, what survives a
restart, how a bot and a human share one account. (The exact-equality gate with
the offline backtest lives in test_autopilot_parity.py; these reuse its helpers.)
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path

import pandas as pd
import pytest
import yaml
from fastapi.testclient import TestClient

from app.backend.services import autopilot_service, bt_session_service as bts, manual_analytics
from app.backend.tests.test_autopilot_parity import (  # noqa: F401 -- fixtures + helpers
    CONFIG_ID, SYMBOL, _unix, api, compare_account, compare_equity, compare_trades, create_session, cursor_plan,
    drive, mnq, move_cursor, offline_run, reopen, switch_on,
)
from propbt.config import CONFIG_DIR, load_prop_rules

H = pd.Timedelta(hours=1)


def get(api: TestClient, sid: str) -> dict:
    return api.get(f"/api/bt-sessions/{sid}").json()


def trades(api: TestClient, sid: str) -> list:
    return api.get(f"/api/bt-sessions/{sid}/trades").json()


def window_of(mnq, start, hours):
    return mnq.loc[start:start + hours * H].index


# ---------------------------------------------------------------------------
# configs and refusals
# ---------------------------------------------------------------------------

def test_the_default_strategy_config_is_refused_because_it_enables_the_news_legs(api):
    infos = {c["id"]: c for c in api.get("/api/autopilot/configs").json()}
    assert infos["strategy"]["supported"] is False
    assert "news_continuation" in infos["strategy"]["reason"] and "will not run a subset" in infos["strategy"]["reason"]
    assert infos["strategy_session_open"]["supported"] is True
    assert infos["strategy_session_open"]["legs"] == ["continuation", "mean_reversion"]
    assert len(infos["strategy_session_open"]["summary"]) == 2


def test_starting_with_an_unsupported_config_is_a_400_and_changes_nothing(api, mnq):
    start = reopen("2023-03-07")
    sid = create_session(api, start, start + H)["id"]
    r = api.post(f"/api/bt-sessions/{sid}/autopilot", json={"enabled": True, "config_id": "strategy"})
    assert r.status_code == 400
    assert "news_continuation" in r.json()["detail"] and "subset" in r.json()["detail"]
    assert get(api, sid)["autopilot"] is None
    assert not (bts._session_dir(sid) / autopilot_service.EQUITY_FILE).exists()


def test_a_config_with_a_leg_that_is_not_known_is_refused_too(api, monkeypatch, tmp_path):
    cfg_dir = tmp_path / "cfg"
    cfg_dir.mkdir()
    raw = yaml.safe_load((CONFIG_DIR / "strategy_session_open.yaml").read_text(encoding="utf-8"))
    raw["legs"]["breakout"] = {"enabled": True}
    (cfg_dir / "odd.yaml").write_text(yaml.safe_dump(raw), encoding="utf-8")
    monkeypatch.setattr(autopilot_service, "CONFIG_DIR", cfg_dir)
    info = {c.id: c for c in autopilot_service.list_configs()}["odd"]
    assert not info.supported and "breakout" in info.reason


def test_unknown_config_and_wrong_symbol_and_missing_config_are_400(api, mnq):
    start = reopen("2023-03-07")
    sid = create_session(api, start, start + H)["id"]
    assert api.post(f"/api/bt-sessions/{sid}/autopilot", json={"enabled": True}).status_code == 400
    assert api.post(f"/api/bt-sessions/{sid}/autopilot", json={"enabled": True, "config_id": "nope"}).status_code == 400
    assert api.post(f"/api/bt-sessions/{sid}/autopilot", json={"enabled": True, "config_id": "../prop_rules"}).status_code == 400

    mes = api.post("/api/bt-sessions", json={
        "instrument": "MES", "base_timeframe": "1min", "start_time": _unix(start), "end_date": _unix(start + H),
        "starting_balance": 50000.0, "risk_per_trade_percent": 1.0, "commission_per_contract": 1.3,
    }).json()
    r = api.post(f"/api/bt-sessions/{mes['id']}/autopilot", json={"enabled": True, "config_id": CONFIG_ID})
    assert r.status_code == 400 and "MNQ" in r.json()["detail"] and "assets" in r.json()["detail"]


def test_a_session_with_holding_or_news_restrictions_is_refused(api, mnq):
    start = reopen("2023-03-07")
    rules = {"profit_target": 3000, "max_loss": 2000, "no_overnight": True, "close_time": "16:00"}
    r = api.post("/api/bt-sessions", json={
        "instrument": SYMBOL, "base_timeframe": "1min", "start_time": _unix(start), "end_date": _unix(start + H),
        "starting_balance": 50000.0, "risk_per_trade_percent": 1.0, "commission_per_contract": 1.3,
        "prop_ruleset": "custom", "prop_rules": rules,
    })
    assert r.status_code == 200, r.text
    sid = r.json()["id"]
    r = api.post(f"/api/bt-sessions/{sid}/autopilot", json={"enabled": True, "config_id": CONFIG_ID})
    assert r.status_code == 400 and "no overnight holding" in r.json()["detail"]


def test_a_client_cannot_forge_a_bot_trade(api, mnq):
    start = reopen("2023-03-07")
    sid = create_session(api, start, start + H, prop=False)["id"]
    body = {
        "entry_time": _unix(start), "exit_time": _unix(start) + 600, "instrument": SYMBOL, "side": "long",
        "size_contracts": 1, "entry_price": 15000.0, "exit_price": 15010.0, "exit_type": "manual_close",
        "pnl_usd": 20.0, "commission_usd": 1.3, "mae_points": 0.0, "mfe_points": 10.0, "bars_held": 10,
        "source": "bot", "bot_segment": 0,
    }
    r = api.post(f"/api/bt-sessions/{sid}/trades", json=body)
    assert r.status_code == 200
    assert r.json()["trade"]["source"] == "manual" and r.json()["trade"]["bot_segment"] is None


# ---------------------------------------------------------------------------
# practice sessions (no rules, no daily limit): the path the build_equity_frame fix is for
# ---------------------------------------------------------------------------

def test_a_practice_account_runs_the_bot_and_every_view_still_builds(api, mnq):
    start = reopen("2023-03-07")
    window = window_of(mnq, start, 14)
    sid = create_session(api, start, window[-1], prop=False)["id"]
    switch_on(api, sid)
    drive(api, sid, window, "hour")

    s = get(api, sid)
    ap = s["autopilot"]
    assert ap["status"] == "running" and ap["trades"] >= 2 and not ap["interrupted"]
    bot = trades(api, sid)
    assert len(bot) == ap["trades"] and {t["source"] for t in bot} == {"bot"}
    assert s["account"]["balance"] == ap["bot_balance"]                      # bot-only: the engine's own number
    assert abs(ap["bot_balance"] - (50000.0 + sum(t["pnl_usd"] for t in bot))) < 1e-6   # and the journal adds up
    # analytics, equity, stats, meta, csv: none of them trips over the missing rules
    assert api.get(f"/api/runs/bt:{sid}/stats").status_code == 200
    assert api.get(f"/api/runs/bt:{sid}/equity").status_code == 200
    meta = api.get(f"/api/runs/bt:{sid}").json()
    assert meta["autopilot_sessions"] == 1 and meta["autopilot_interrupted"] is False
    csv = api.get(f"/api/bt-sessions/{sid}/trades.csv").text.splitlines()
    assert csv[0].endswith("source,autopilot_segment") and csv[1].endswith("bot,0")
    # the engine's tracker on a practice account can never trip
    assert ap["daily_locked"] is False


def test_the_equity_frame_builder_accepts_a_rule_set_without_a_daily_limit():
    import dataclasses

    cfg = dataclasses.replace(autopilot_service.engine_config({"account": {"starting_balance": 50000.0, "commissions": {}}}))
    assert cfg.daily_loss_limit is None and cfg.max_open_contracts is None


# ---------------------------------------------------------------------------
# off and on: interrupted
# ---------------------------------------------------------------------------

def test_switching_off_and_on_marks_the_run_interrupted_everywhere(api, mnq):
    start = reopen("2023-03-07")
    window = window_of(mnq, start, 20)
    sid = create_session(api, start, window[-1], prop=False)["id"]
    switch_on(api, sid)
    plan = cursor_plan(window, "hour")
    third = len(plan) // 3
    for t in plan[:third]:
        move_cursor(api, sid, t)
    before = get(api, sid)["autopilot"]
    assert before["interrupted"] is False and len(before["segments"]) == 1

    off = api.post(f"/api/bt-sessions/{sid}/autopilot", json={"enabled": False}).json()["autopilot"]
    assert off["status"] == "off" and off["enabled"] is False and off["pending"] == []
    assert off["segments"][0]["off_time"] == off["processed_to"] and off["interrupted"] is False
    n_off = off["trades"]
    for t in plan[third:2 * third]:       # while off: no new entries, but an open position is still managed
        move_cursor(api, sid, t)
    mid = get(api, sid)["autopilot"]
    assert mid["trades"] <= n_off + 1    # at most the position that was already open closing

    on = api.post(f"/api/bt-sessions/{sid}/autopilot", json={"enabled": True}).json()["autopilot"]
    assert on["interrupted"] is True and on["status"] == "running" and len(on["segments"]) == 2
    assert on["segments"][1]["on_time"] == on["processed_to"] and on["segments"][1]["off_time"] is None
    for t in plan[2 * third:]:
        move_cursor(api, sid, t)

    final = get(api, sid)["autopilot"]
    assert final["interrupted"] is True
    segs = [t["bot_segment"] for t in trades(api, sid)]
    assert segs == sorted(segs) and set(segs) <= {0, 1} and 1 in segs
    meta = api.get(f"/api/runs/bt:{sid}").json()
    assert meta["autopilot_interrupted"] is True and meta["autopilot_interruptions"] == 1
    by_source = api.get(f"/api/runs/bt:{sid}/stats").json()["by_source"]
    assert set(by_source) == {"bot"}
    csv_rows = api.get(f"/api/bt-sessions/{sid}/trades.csv").text.splitlines()[1:]
    assert any(r.endswith("bot,1") for r in csv_rows)


def test_an_uninterrupted_run_stays_uninterrupted_and_equals_offline_after_a_restart(api, mnq):
    """The engine is rebuilt from the stored snapshot after a restart; the run then carries on
    exactly as if it never stopped (still equal to the offline backtest)."""
    start = reopen("2023-03-07")
    window = window_of(mnq, start, 18)
    sid = create_session(api, start, window[-1])["id"]
    switch_on(api, sid)
    plan = cursor_plan(window, "hour")
    half = len(plan) // 2
    for t in plan[:half]:
        move_cursor(api, sid, t)
    autopilot_service.forget(sid)            # a restart: nothing in memory
    for t in plan[half:]:
        move_cursor(api, sid, t)
    ref = offline_run(mnq, window[0], window[-1])
    compare_trades(api, sid, ref)
    compare_account(api, sid, ref)
    compare_equity(sid, ref)
    assert get(api, sid)["autopilot"]["interrupted"] is False


def test_a_run_that_does_not_rebuild_to_its_journal_stops_instead_of_diverging(api, mnq):
    start = reopen("2023-03-07")
    window = window_of(mnq, start, 20)
    sid = create_session(api, start, window[-1], prop=False)["id"]
    switch_on(api, sid)
    plan = cursor_plan(window, "hour")
    for t in plan[: len(plan) // 2]:
        move_cursor(api, sid, t)
    path = bts._trades_path(sid)
    saved = json.loads(path.read_text(encoding="utf-8"))
    assert saved
    saved[0]["exit_price"] += 1.0                      # the journal no longer matches what the engine did
    saved[0]["pnl_usd"] += 2.0
    path.write_text(json.dumps(saved), encoding="utf-8")
    autopilot_service.forget(sid)

    r = move_cursor(api, sid, plan[len(plan) // 2 + 1])
    ap = r["autopilot"]
    assert ap["status"] == "error" and ap["enabled"] is False
    assert "journal" in ap["status_detail"]
    n = len(trades(api, sid))
    move_cursor(api, sid, plan[-1])                    # the replay itself carries on; the bot does not
    assert len(trades(api, sid)) == n
    assert api.post(f"/api/bt-sessions/{sid}/autopilot", json={"enabled": True, "config_id": CONFIG_ID}).status_code == 400


def test_an_engine_exception_stops_the_run_but_not_the_save(api, mnq, monkeypatch):
    start = reopen("2023-03-07")
    window = window_of(mnq, start, 6)
    sid = create_session(api, start, window[-1], prop=False)["id"]
    switch_on(api, sid)
    from propbt.engine.stepper import EngineStepper

    def boom(self):
        raise RuntimeError("strategy blew up")

    monkeypatch.setattr(EngineStepper, "run", boom)
    r = move_cursor(api, sid, _unix(window[100]))
    assert r["cursor_time"] == _unix(window[100])
    assert r["autopilot"]["status"] == "error" and "blew up" in r["autopilot"]["status_detail"]


def test_the_replay_cannot_be_rewound_before_what_the_bot_has_traded(api, mnq):
    start = reopen("2023-03-07")
    window = window_of(mnq, start, 6)
    sid = create_session(api, start, window[-1], prop=False)["id"]
    switch_on(api, sid)
    move_cursor(api, sid, _unix(window[200]))
    r = api.patch(f"/api/bt-sessions/{sid}/cursor", json={"cursor_time": _unix(window[100])})
    assert r.status_code == 400 and "Autopilot" in r.json()["detail"]
    assert api.patch(f"/api/bt-sessions/{sid}/cursor", json={"cursor_time": _unix(window[200])}).status_code == 200


def test_a_halt_only_step_does_not_break_the_next_one(api, mnq):
    """A cursor save whose new bars are all in the 17:00-18:00 ET halt (none exist) must not
    leave the engine's bookkeeping behind: the next save still continues from the right bar."""
    start = reopen("2023-03-07") - pd.Timedelta(hours=2)        # 16:00 ET: the halt comes up
    window = mnq.loc[start:start + 5 * H].index
    sid = create_session(api, start, window[-1], prop=False)["id"]
    switch_on(api, sid)
    plan = cursor_plan(window, "random", seed=3)
    for t in plan:
        r = move_cursor(api, sid, t)
        assert r["autopilot"]["status"] == "running"
    ref = offline_run(mnq, window[0], window[-1])
    compare_trades(api, sid, ref)


# ---------------------------------------------------------------------------
# forced lock / breach / pass, through the session layer
# ---------------------------------------------------------------------------

def _config_with(tmp_path, monkeypatch, name, contracts, sl, rr):
    raw = yaml.safe_load((CONFIG_DIR / "strategy_session_open.yaml").read_text(encoding="utf-8"))
    for leg in ("continuation", "mean_reversion"):
        raw["legs"][leg]["risk"].update(contracts=contracts, sl_points=sl, rr=rr)
    cfg_dir = tmp_path / "cfg"
    cfg_dir.mkdir(exist_ok=True)
    path = cfg_dir / f"{name}.yaml"
    path.write_text(yaml.safe_dump(raw), encoding="utf-8")
    monkeypatch.setattr(autopilot_service, "CONFIG_DIR", cfg_dir)
    return name, str(path)


def test_a_daily_lock_then_an_mll_breach_end_the_run_and_equal_offline(api, mnq, tmp_path, monkeypatch):
    name, path = _config_with(tmp_path, monkeypatch, "risky", contracts=5, sl=40.0, rr=1.0)
    start, end = reopen("2023-03-06"), reopen("2023-03-17")
    window = mnq.loc[start:end].index
    sid = create_session(api, start, window[-1])["id"]
    switch_on(api, sid, name)
    drive(api, sid, window, "hour")

    ref = offline_run(mnq, window[0], window[-1], config_path=path)
    kinds = [f.fill_type.value for f in ref.result.fills]
    assert "daily_lock_flatten" in kinds and "mll_breach_flatten" in kinds
    compare_trades(api, sid, ref)
    compare_account(api, sid, ref)
    compare_equity(sid, ref)

    ap = get(api, sid)["autopilot"]
    assert ap["status"] == "failed" and ap["enabled"] is False and ap["position"] is None
    stats = api.get(f"/api/runs/bt:{sid}/stats").json()["result"]
    assert stats["status"] == "failed" and stats["fail_reason"] == "mll_breach" and stats["daily_loss_lock_days"] >= 1
    assert api.post(f"/api/bt-sessions/{sid}/autopilot", json={"enabled": True, "config_id": name}).status_code == 400


def test_a_pass_ends_the_run_and_equals_offline(api, mnq):
    start, end = reopen("2024-02-05"), reopen("2024-02-16")
    window = mnq.loc[start:end].index
    # the default legs lose over time; this fortnight peaks at +$99, so a $60 target is hit and passes
    rules = {"profit_target": 60, "max_loss": 2000, "daily_loss_limit": 1000, "max_contracts": 5}
    r = api.post("/api/bt-sessions", json={
        "instrument": SYMBOL, "base_timeframe": "1min", "start_time": _unix(start), "end_date": _unix(window[-1]),
        "starting_balance": 50000.0, "risk_per_trade_percent": 1.0, "commission_per_contract": 1.3,
        "prop_ruleset": "custom", "prop_rules": rules,
    })
    assert r.status_code == 200, r.text
    sid = r.json()["id"]
    switch_on(api, sid)
    drive(api, sid, window, "hour")

    from app.backend.services import prop_presets
    from app.backend import models

    cfg = prop_presets.engine_config(models.PropRules(**rules), 50000.0, {SYMBOL: 1.3})
    ref = offline_run(mnq, window[0], window[-1], prop_cfg=cfg)
    assert ref.result.combine.status == "passed"
    compare_trades(api, sid, ref)
    compare_account(api, sid, ref)
    assert get(api, sid)["autopilot"]["status"] == "passed"


# ---------------------------------------------------------------------------
# one account, two sources
# ---------------------------------------------------------------------------

def _manual_trade(window, i0, i1, side="long", price=None, pnl=-60.0, mae=40.0, tid=None):
    return {
        "entry_time": _unix(window[i0]), "exit_time": _unix(window[i1]), "instrument": SYMBOL, "side": side,
        "size_contracts": 1, "entry_price": price, "exit_price": price - 5.0, "exit_type": "manual_close",
        "pnl_usd": pnl, "commission_usd": 1.3, "mae_points": mae, "mfe_points": 2.0, "bars_held": i1 - i0,
        "trade_key": tid,
    }


def test_manual_and_bot_trades_share_one_ledger_and_the_verdict_is_judged_per_source(api, mnq):
    start = reopen("2023-03-07")
    window = window_of(mnq, start, 16)
    sid = create_session(api, start, window[-1])["id"]
    switch_on(api, sid)
    plan = cursor_plan(window, "hour")
    for t in plan[: len(plan) // 2]:
        move_cursor(api, sid, t)

    before = get(api, sid)
    bot_balance = before["autopilot"]["bot_balance"]
    i0 = 300
    manual = _manual_trade(window, i0, i0 + 30, price=float(mnq.loc[window[i0], "close"]), tid="m1")
    r = api.post(f"/api/bt-sessions/{sid}/trades", json=manual)
    assert r.status_code == 200, r.text
    assert r.json()["trade"]["source"] == "manual"
    after = r.json()["session"]
    manual_sum = manual["pnl_usd"]
    assert after["account"]["balance"] == after["autopilot"]["bot_balance"] + manual_sum
    assert after["autopilot"]["bot_balance"] == bot_balance        # a manual trade does not touch the bot's book

    for t in plan[len(plan) // 2:]:
        move_cursor(api, sid, t)
    allt = trades(api, sid)
    assert {t["source"] for t in allt} == {"manual", "bot"}
    assert sum(1 for t in allt if t["source"] == "manual") == 1
    final = get(api, sid)
    assert final["account"]["balance"] == final["autopilot"]["bot_balance"] + manual_sum

    stats = api.get(f"/api/runs/bt:{sid}/stats").json()
    assert set(stats["by_source"]) == {"bot", "manual"}
    assert stats["by_source"]["manual"]["trades"] == 1
    assert stats["overall"]["trades"] == len(allt)
    only_bot = api.get(f"/api/runs/bt:{sid}/stats", params={"source": "bot"}).json()
    assert only_bot["overall"]["trades"] == len(allt) - 1
    bot_list = api.get(f"/api/runs/bt:{sid}/trades", params={"source": "bot"}).json()
    assert len(bot_list) == len(allt) - 1 and {t["source"] for t in bot_list} == {"bot"}
    assert stats["result"]["status"] == "incomplete"

    # the verdict is the combined account's: judged with the manual trade's bar extreme
    status = api.get(f"/api/manual-analytics/sessions/{sid}/prop-rules").json()
    assert status["balance"] == final["account"]["balance"]


def test_a_manual_loss_can_fail_the_account_while_the_bot_is_still_running(api, mnq):
    start = reopen("2023-03-07")
    window = window_of(mnq, start, 12)
    sid = create_session(api, start, window[-1])["id"]
    switch_on(api, sid)
    plan = cursor_plan(window, "hour")
    for t in plan[: len(plan) // 2]:
        move_cursor(api, sid, t)
    i0 = 200
    # A manual position is marked against the real bars' extremes, so give it an entry 1,100 points
    # above the market: 1 MNQ x ~1,100 pt x $2 is a $2,200 float loss, past the $2,000 max loss.
    big = _manual_trade(window, i0, i0 + 20, price=float(mnq.loc[window[i0], "close"]) + 1100.0, pnl=-60.0, mae=1100.0, tid="big")
    assert api.post(f"/api/bt-sessions/{sid}/trades", json=big).status_code == 200
    for t in plan[len(plan) // 2:]:
        move_cursor(api, sid, t)
    stats = api.get(f"/api/runs/bt:{sid}/stats").json()["result"]
    assert stats["status"] == "failed" and stats["fail_reason"] == "mll_breach"
    assert stats["resolved_time"] is not None
    assert _unix(window[i0]) <= stats["resolved_time"] <= _unix(window[i0 + 20])
    # (G10a: the bot's own gating sees only bot P&L, so it was still trading -- documented, G10b couples it)
    assert get(api, sid)["autopilot"]["status"] == "running"


def test_the_per_bar_verdict_is_cached_until_something_it_depends_on_changes(api, mnq):
    start = reopen("2023-03-07")
    window = window_of(mnq, start, 8)
    sid = create_session(api, start, window[-1])["id"]
    switch_on(api, sid)
    plan = cursor_plan(window, "hour")
    for t in plan[:3]:
        move_cursor(api, sid, t)
    first = manual_analytics._session_replay(f"bt:{sid}")[2]
    again = manual_analytics._session_replay(f"bt:{sid}")[2]
    assert again is first                                  # no second walk
    move_cursor(api, sid, plan[4])                         # the engine consumed more bars
    later = manual_analytics._session_replay(f"bt:{sid}")[2]
    assert later is not first
    assert later.samples[-1]["time"] > first.samples[-1]["time"]
