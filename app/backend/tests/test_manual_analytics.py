"""FXR_SPEC.md phase F6: the existing run analytics pointed at manual trades.

Sessions are written straight to disk (bt_session_service's own persistence
helpers) rather than through POST /api/bt-sessions, so these tests don't
depend on market-data files being present -- they exercise the analytics
adapter, not session creation.

Hand-checked scenario (MES, $5/point, one contract each, pnl already net of
commission, all on CME trading day 2025-03-11 -- 13:30 UTC is 09:30 ET):

    T1 long   13:30 -> 13:45  pnl +200  r +2.0  mae 4 pts  ($20)
    T2 short  14:00 -> 14:20  pnl -150  r -1.5  mae 30 pts ($150)
    T3 long   14:30 -> 14:50  pnl +350  r +3.5  mae 10 pts ($50)

    net +400 | win rate 2/3 | expectancy 400/3 | profit factor 550/150
    cumulative-by-exit 200, 50, 400 -> max drawdown = 50 - 200 = -150
    net R 4.0 | expectancy R 4/3
    Combine: balance 50000 -> 50200 -> 50050 -> 50400, never near the
    $3,000 target or the 48,000 floor -> "incomplete", 1 trading day.
    Closest approach to the floor: T1's worst point, 50000 - $20 = 49980,
    i.e. $1,980 above the 48,000 MLL.
"""
from __future__ import annotations

import pandas as pd
import pytest

from app.backend.services import bt_session_service as bts


@pytest.fixture()
def bt_client(client, tmp_path, monkeypatch):
    monkeypatch.setenv("PROPBT_BT_SESSIONS_DIR", str(tmp_path / "bt_sessions"))
    return client


def _ts(hhmm: str, day: str = "2025-03-11") -> int:
    return int(pd.Timestamp(f"{day} {hhmm}:00", tz="UTC").timestamp())


def _write_session(session_id: str, instrument: str = "MES", prop_ruleset=None, balance: float = 50000.0) -> None:
    now = "2025-03-11T20:00:00+00:00"
    bts._write(session_id, {
        "id": session_id, "instrument": instrument, "base_timeframe": "5min",
        "start_time": _ts("13:00"), "created_at": now, "updated_at": now,
        "cursor_time": _ts("15:00"), "status": "active",
        "account": {
            "id": "acct-" + session_id, "starting_balance": 50000.0, "balance": balance, "currency": "USD",
            "risk_per_trade_percent": 1.0, "risk_per_trade_usd": None, "default_contracts": 1,
            "commission_per_contract": 1.3, "prop_ruleset": prop_ruleset,
        },
        "settings": {"random_start": False}, "position": None, "working_orders": [], "notes": None,
    })


def _trade(trade_id, session_id, entry, exit_, side, pnl, r, mae_pts, **journal):
    px = 5000.0
    return {
        "trade_id": trade_id, "session_id": session_id, "source": "manual",
        "entry_time": _ts(entry), "exit_time": _ts(exit_), "instrument": "MES", "side": side,
        "leg": None, "session": journal.pop("trading_session", "ny"), "trading_day": None,
        "size_contracts": 1, "entry_price": px, "exit_price": px + (pnl / 5.0),
        "sl_price": px - 10, "tp_price": px + 20, "sl_points": 10.0, "tp_points": 20.0, "rr_planned": 2.0,
        "exit_type": "tp" if pnl > 0 else "sl", "pnl_usd": pnl, "r_multiple": r, "commission_usd": 1.3,
        "mae_points": mae_pts, "mfe_points": 12.0, "mae_r": mae_pts / 10.0, "mfe_r": 1.2, "bars_held": 3,
        "notes": "", "tags": journal.get("tags", []), "setup_name": journal.get("setup_name"),
        "grade": journal.get("grade"), "screenshots": [],
    }


def _seed_hand_checked(session_id="s1", prop_ruleset="topstep_50k"):
    _write_session(session_id, prop_ruleset=prop_ruleset, balance=50400.0)
    bts._write_trades(session_id, [
        _trade(1, session_id, "13:30", "13:45", "long", 200.0, 2.0, 4.0,
               tags=["breakout", "london-sweep"], setup_name="Break & Retest", grade="A"),
        _trade(2, session_id, "14:00", "14:20", "short", -150.0, -1.5, 30.0,
               tags=["breakout"], setup_name="Fade", grade="C"),
        _trade(3, session_id, "14:30", "14:50", "long", 350.0, 3.5, 10.0,
               tags=["london-sweep"], setup_name="Break & Retest", grade="A"),
    ])
    return f"bt:{session_id}"


# ---------------------------------------------------------------- meta/trades

def test_meta_for_a_manual_session(bt_client):
    run_id = _seed_hand_checked()
    meta = bt_client.get(f"/api/runs/{run_id}").json()
    assert meta["source"] == "manual"
    assert meta["instrument"] == "MES"
    assert meta["prop_ruleset"] == "topstep_50k"
    assert meta["session_ids"] == ["s1"]
    assert meta["date_from"] == "2025-03-11" and meta["date_to"] == "2025-03-11"
    assert meta["is_oos_split_date"] is None
    assert meta["result"]["passed"] is False


def test_unknown_manual_ids_404(bt_client):
    assert bt_client.get("/api/runs/bt:nope").status_code == 404
    assert bt_client.get("/api/runs/bt:all:ZN").status_code == 404
    assert bt_client.get("/api/runs/bt:nope/stats").status_code == 404
    assert bt_client.get("/api/runs/bt:nope/trades").status_code == 404
    assert bt_client.get("/api/runs/bt:nope/monte-carlo").status_code == 404


def test_trades_carry_schema_compat_fields_plus_source_and_session_id(bt_client):
    run_id = _seed_hand_checked()
    trades = bt_client.get(f"/api/runs/{run_id}/trades").json()
    assert [t["trade_id"] for t in trades] == [1, 2, 3]
    t1 = trades[0]
    assert t1["source"] == "manual" and t1["session_id"] == "s1"
    assert t1["tags"] == ["breakout", "london-sweep"] and t1["setup_name"] == "Break & Retest" and t1["grade"] == "A"
    assert t1["trading_day"] == "2025-03-11"          # derived, the journal doesn't store it
    assert t1["pnl_usd"] == 200.0 and t1["mae_points"] == 4.0
    # Existing engine runs are untouched: their trades carry no manual fields.
    engine_id = bt_client.get("/api/runs").json()[0]["run_id"]
    engine_trade = bt_client.get(f"/api/runs/{engine_id}/trades").json()[0]
    assert engine_trade["source"] is None and engine_trade["tags"] is None


@pytest.mark.parametrize("params,expected_ids", [
    ({"tag": "breakout"}, [1, 2]),
    ({"tag": "london-sweep"}, [1, 3]),
    ({"setup": "Break & Retest"}, [1, 3]),
    ({"grade": "C"}, [2]),
    ({"session": "ny"}, [1, 2, 3]),
    ({"session": "asia"}, []),
    ({"hour_ny": 9}, [1]),           # 13:30 UTC = 09:30 ET
    ({"hour_ny": 10}, [2, 3]),       # 14:00/14:30 UTC = 10:00/10:30 ET
    ({"tag": "breakout", "grade": "A"}, [1]),
    ({"result": "loss"}, [2]),
])
def test_trade_filters(bt_client, params, expected_ids):
    run_id = _seed_hand_checked()
    got = bt_client.get(f"/api/runs/{run_id}/trades", params=params).json()
    assert [t["trade_id"] for t in got] == expected_ids


# ---------------------------------------------------------------------- stats

def test_stats_match_the_hand_check(bt_client):
    run_id = _seed_hand_checked()
    s = bt_client.get(f"/api/runs/{run_id}/stats").json()
    o = s["overall"]
    assert o["trades"] == 3
    assert o["net_pnl_usd"] == pytest.approx(400.0)
    assert o["net_r"] == pytest.approx(4.0)
    assert o["win_rate"] == pytest.approx(2 / 3)
    assert o["expectancy_usd"] == pytest.approx(400 / 3)
    assert o["expectancy_r"] == pytest.approx(4 / 3)
    assert o["profit_factor"] == pytest.approx(550 / 150)
    assert o["max_drawdown_usd"] == pytest.approx(-150.0)


def test_stats_breakdowns_by_setup_tag_grade_and_session(bt_client):
    run_id = _seed_hand_checked()
    s = bt_client.get(f"/api/runs/{run_id}/stats").json()
    assert s["by_setup"]["Break & Retest"]["trades"] == 2
    assert s["by_setup"]["Break & Retest"]["net_pnl_usd"] == pytest.approx(550.0)
    assert s["by_setup"]["Fade"]["net_pnl_usd"] == pytest.approx(-150.0)
    assert s["by_grade"]["A"]["trades"] == 2 and s["by_grade"]["C"]["trades"] == 1
    # A trade with two tags counts once in EACH tag's row.
    assert s["by_tag"]["breakout"]["trades"] == 2
    assert s["by_tag"]["breakout"]["net_pnl_usd"] == pytest.approx(50.0)
    assert s["by_tag"]["london-sweep"]["net_pnl_usd"] == pytest.approx(550.0)
    assert s["by_session"]["ny"]["trades"] == 3
    assert s["by_leg"] == {}
    assert s["by_backtest_session"] == {}     # single session: nothing to break down


def test_stats_accept_the_same_filters_as_the_trade_list(bt_client):
    run_id = _seed_hand_checked()
    s = bt_client.get(f"/api/runs/{run_id}/stats", params={"grade": "A"}).json()
    assert s["overall"]["trades"] == 2
    assert s["overall"]["net_pnl_usd"] == pytest.approx(550.0)
    # The Combine verdict belongs to the whole session, not to a filtered slice.
    assert s["result"]["status"] == "incomplete"
    assert s["result"]["final_balance"] == pytest.approx(50400.0)


def test_stats_empty_filter_result_is_zero_trades_not_an_error(bt_client):
    run_id = _seed_hand_checked()
    s = bt_client.get(f"/api/runs/{run_id}/stats", params={"tag": "no-such-tag"})
    assert s.status_code == 200
    assert s.json()["overall"]["trades"] == 0


def test_session_with_no_trades_has_valid_empty_analytics(bt_client):
    _write_session("empty", prop_ruleset=None)
    run_id = "bt:empty"
    assert bt_client.get(f"/api/runs/{run_id}/stats").json()["overall"]["trades"] == 0
    assert bt_client.get(f"/api/runs/{run_id}/trades").json() == []
    assert bt_client.get(f"/api/runs/{run_id}/equity").json() == []
    assert bt_client.get(f"/api/runs/{run_id}/monte-carlo").status_code == 400


# ------------------------------------------------------------- prop rule sim

def test_prop_session_incomplete_result_and_equity_timeline(bt_client):
    run_id = _seed_hand_checked()
    r = bt_client.get(f"/api/runs/{run_id}/stats").json()["result"]
    assert r["status"] == "incomplete"
    assert r["target_hit"] is False
    assert r["final_balance"] == pytest.approx(50400.0)
    assert r["trading_days"] == 1
    assert r["resolved_time"] is None and r["trades_to_result"] is None

    eq = bt_client.get(f"/api/runs/{run_id}/equity").json()
    # The replay observes entry+exit per trade; the shared change-detection
    # compression (bundle_reader._compress_equity) then drops the entry rows
    # that repeat the previous exit's balance, leaving the real steps.
    assert [p["balance"] for p in eq] == [50000.0, 50200.0, 50050.0, 50400.0]
    assert len({p["time"] for p in eq}) == len(eq)
    assert all(p["mll_floor"] == 48000.0 for p in eq)         # trails on EOD only, none yet
    assert all(p["target_level"] == 53000.0 for p in eq)
    assert eq[-1]["daily_loss_floor"] == pytest.approx(49000.0)
    assert not any(p["breached"] for p in eq)
    # drawdown-from-peak reuses the engine path: 50200 peak -> 50050 trough
    assert max(p["drawdown_usd"] for p in eq) == pytest.approx(150.0)


def test_daily_risk_includes_each_trades_worst_point(bt_client):
    run_id = _seed_hand_checked()
    days = bt_client.get(f"/api/runs/{run_id}/daily_risk").json()
    assert len(days) == 1
    d = days[0]
    assert d["trading_day"] == "2025-03-11"
    assert d["trades"] == 3
    assert d["min_distance_to_mll_usd"] == pytest.approx(1980.0)   # T1: 50000 - $20 vs 48000
    assert d["breached"] is False and d["daily_locked"] is False


def test_mll_breach_is_detected_from_mae_and_explains_how_it_failed(bt_client):
    _write_session("bust", prop_ruleset="topstep_50k", balance=48000.0)
    bts._write_trades("bust", [
        # Worst point: 50000 - 410 pts * $5 = 47,950 <= the 48,000 floor, even
        # though the trade itself closes only -$1,900 (balance 48,100).
        _trade(1, "bust", "13:30", "14:00", "long", -1900.0, -4.0, 410.0, setup_name="Revenge"),
        _trade(2, "bust", "14:30", "14:50", "long", 500.0, 1.0, 5.0),   # taken after the Combine ended
    ])
    stats = bt_client.get("/api/runs/bt:bust/stats").json()
    r = stats["result"]
    assert r["status"] == "failed"
    assert r["fail_reason"] == "mll_breach"
    assert r["resolved_trade_id"] == 1 and r["trades_to_result"] == 1
    assert r["resolved_time"] == _ts("14:00")
    assert r["equity_at_result"] == pytest.approx(47950.0)
    assert r["mll_floor_at_result"] == pytest.approx(48000.0)
    assert stats["overall"]["trades"] == 2          # stats still cover every journaled trade

    meta = bt_client.get("/api/runs/bt:bust").json()
    assert meta["result"]["passed"] is False and meta["result"]["fail_reason"] == "mll_breach"

    eq = bt_client.get("/api/runs/bt:bust/equity").json()
    assert eq[-1]["breached"] is True and eq[-1]["equity"] == pytest.approx(47950.0)
    assert eq[-1]["time"] == _ts("14:00")           # equity timeline ends where the Combine did

    days = bt_client.get("/api/runs/bt:bust/daily_risk").json()
    assert days[0]["breached"] is True and days[0]["breach_time"] == _ts("14:00")
    assert days[0]["min_distance_to_mll_usd"] == pytest.approx(-50.0)


def test_profit_target_with_consistency_passes(bt_client):
    # Three equal winning days (+1,000 each) hit the $3,000 target with the
    # best day at 33% of profit (<= 50%) -> passed on the third day's trade.
    _write_session("win", prop_ruleset="topstep_50k", balance=53000.0)
    trades = []
    for i, day in enumerate(["2025-03-11", "2025-03-12", "2025-03-13"], start=1):
        t = _trade(i, "win", "14:00", "14:30", "long", 1000.0, 2.0, 2.0)
        t["entry_time"], t["exit_time"] = _ts("14:00", day), _ts("14:30", day)
        trades.append(t)
    bts._write_trades("win", trades)
    r = bt_client.get("/api/runs/bt:win/stats").json()["result"]
    assert r["status"] == "passed"
    assert r["target_hit"] is True and r["consistency_passed"] is True
    assert r["trades_to_result"] == 3 and r["resolved_trade_id"] == 3
    assert bt_client.get("/api/runs/bt:win").json()["result"]["passed"] is True


def test_plain_session_has_no_prop_result_and_null_floors(bt_client):
    run_id = _seed_hand_checked("plain", prop_ruleset=None)
    assert bt_client.get(f"/api/runs/{run_id}/stats").json()["result"] is None
    eq = bt_client.get(f"/api/runs/{run_id}/equity").json()
    assert [p["balance"] for p in eq] == [50000.0, 50200.0, 50050.0, 50400.0]
    assert all(p["mll_floor"] is None and p["daily_loss_floor"] is None and p["target_level"] is None for p in eq)
    assert bt_client.get(f"/api/runs/{run_id}/daily_risk").json() == []
    assert bt_client.get(f"/api/runs/{run_id}").json()["prop_ruleset"] is None


# ------------------------------------------------------- all-sessions pooling

def test_all_sessions_pools_one_instrument_with_unique_trade_ids(bt_client):
    _seed_hand_checked("a", prop_ruleset=None)
    _write_session("b")
    other = _trade(1, "b", "15:00", "15:20", "long", 100.0, 1.0, 3.0, setup_name="Fade", grade="B")
    bts._write_trades("b", [other])
    _write_session("mnq", instrument="MNQ")
    mnq = _trade(1, "mnq", "15:00", "15:20", "long", 999.0, 1.0, 3.0)
    mnq["instrument"] = "MNQ"
    bts._write_trades("mnq", [mnq])

    meta = bt_client.get("/api/runs/bt:all:MES").json()
    assert sorted(meta["session_ids"]) == ["a", "b"]
    assert meta["instrument"] == "MES" and meta["prop_ruleset"] is None

    trades = bt_client.get("/api/runs/bt:all:MES/trades").json()
    assert [t["trade_id"] for t in trades] == [1, 2, 3, 4]          # renumbered, unique
    assert [t["session_trade_id"] for t in trades] == [1, 2, 3, 1]  # the journal's own ids still link back
    assert {t["session_id"] for t in trades} == {"a", "b"}
    assert all(t["instrument"] == "MES" for t in trades)             # MNQ session excluded

    only_b = bt_client.get("/api/runs/bt:all:MES/trades", params={"session_id": "b"}).json()
    assert [t["pnl_usd"] for t in only_b] == [100.0]

    stats = bt_client.get("/api/runs/bt:all:MES/stats").json()
    assert stats["overall"]["net_pnl_usd"] == pytest.approx(500.0)
    assert stats["result"] is None                                    # no single account to judge
    assert set(stats["by_backtest_session"]) == {"a", "b"}
    assert stats["by_setup"]["Fade"]["trades"] == 2

    eq = bt_client.get("/api/runs/bt:all:MES/equity").json()
    assert eq[0]["balance"] == 0.0 and eq[-1]["balance"] == pytest.approx(500.0)   # pooled = cumulative net P&L
    assert eq[-1]["mll_floor"] is None


# ---------------------------------------------------------------- Monte Carlo

def test_monte_carlo_runs_over_the_manual_trade_sequence(bt_client):
    run_id = _seed_hand_checked()
    r = bt_client.get(f"/api/runs/{run_id}/monte-carlo", params={"method": "shuffle", "n_sims": 200}).json()
    assert r["n_trades"] == 3 and r["n_sims"] == 200 and r["method"] == "shuffle"
    assert r["actual_path"] == [0.0, 200.0, 50.0, 400.0]
    assert r["actual_final_pnl"] == 400.0 and r["actual_max_drawdown"] == 150.0
    assert set(r["final_pnl_pct"].values()) == {400.0}               # a reordering never changes the sum
    assert r["prob_profit"] == 1.0
    assert r["drawdown_budget_usd"] == 2000.0                         # the Topstep MLL distance
    assert r["prob_drawdown_breach"] == 0.0
    assert len(r["fan"]["50"]) == 4
    # worst possible ordering of (+200,-150,+350) is -150 first: 150 drawdown
    assert max(r["max_drawdown_pct"].values()) <= 150.0


def test_monte_carlo_is_seeded_and_filterable(bt_client):
    run_id = _seed_hand_checked()
    a = bt_client.get(f"/api/runs/{run_id}/monte-carlo", params={"seed": 3, "n_sims": 300}).json()
    b = bt_client.get(f"/api/runs/{run_id}/monte-carlo", params={"seed": 3, "n_sims": 300}).json()
    assert a == b
    only_a = bt_client.get(f"/api/runs/{run_id}/monte-carlo", params={"grade": "A", "method": "shuffle"}).json()
    assert only_a["n_trades"] == 2 and only_a["actual_final_pnl"] == 550.0
    assert bt_client.get(f"/api/runs/{run_id}/monte-carlo", params={"method": "nope"}).status_code == 400
    assert bt_client.get(f"/api/runs/{run_id}/monte-carlo", params={"tag": "none"}).status_code == 400


def test_monte_carlo_also_works_on_an_engine_run(bt_client):
    engine_id = bt_client.get("/api/runs").json()[0]["run_id"]
    r = bt_client.get(f"/api/runs/{engine_id}/monte-carlo", params={"n_sims": 50})
    assert r.status_code == 200 and r.json()["n_trades"] >= 1


# ----------------------------------------------------------- session creation

def test_create_session_with_prop_ruleset_requires_matching_balance(bt_client):
    from propbt.config import load_data_paths
    paths = load_data_paths()
    if "MES" not in paths or not paths["MES"].exists():
        pytest.skip("MES data file not present")
    body = {
        "instrument": "MES", "base_timeframe": "5min", "start_time": _ts("14:30", "2025-03-10"),
        "starting_balance": 25000.0, "risk_per_trade_percent": 1.0, "default_contracts": 1,
        "commission_per_contract": 1.3, "prop_ruleset": "topstep_50k",
    }
    assert bt_client.post("/api/bt-sessions", json=body).status_code == 400
    body["starting_balance"] = 50000.0
    ok = bt_client.post("/api/bt-sessions", json=body)
    assert ok.status_code == 200 and ok.json()["account"]["prop_ruleset"] == "topstep_50k"
    body["prop_ruleset"] = "apex_50k"
    assert bt_client.post("/api/bt-sessions", json=body).status_code == 400


# ------------------------------------------------- Topstep position-size cap

def _trade_body(contracts: int) -> dict:
    t = _trade(1, "x", "13:30", "13:45", "long", 100.0, 1.0, 2.0)
    body = {k: t[k] for k in (
        "entry_time", "exit_time", "instrument", "side", "leg", "session", "trading_day", "size_contracts",
        "entry_price", "exit_price", "sl_price", "tp_price", "sl_points", "tp_points", "rr_planned", "exit_type",
        "pnl_usd", "r_multiple", "commission_usd", "mae_points", "mfe_points", "mae_r", "mfe_r", "bars_held")}
    body["size_contracts"] = contracts
    return body


def _position(contracts: int) -> dict:
    return {"side": "long", "contracts": contracts, "entry_price": 5000.0, "entry_time": _ts("13:30"),
            "risk_usd": None, "sl_price": None, "tp_price": None, "auto_breakeven": False, "trailing_points": None}


def test_topstep_session_rejects_a_trade_over_the_position_cap(bt_client):
    _write_session("capped", prop_ruleset="topstep_50k")
    over = bt_client.post("/api/bt-sessions/capped/trades", json=_trade_body(6))
    assert over.status_code == 400
    assert "6 contracts" in over.json()["detail"] and "limit of 5" in over.json()["detail"]
    assert bt_client.get("/api/bt-sessions/capped/trades").json() == []        # nothing was journaled
    assert bt_client.post("/api/bt-sessions/capped/trades", json=_trade_body(5)).status_code == 200


def test_topstep_session_rejects_an_over_cap_persisted_position_or_working_order(bt_client):
    _write_session("capped", prop_ruleset="topstep_50k")
    body = {"cursor_time": _ts("14:00"), "position": _position(6), "working_orders": []}
    r = bt_client.patch("/api/bt-sessions/capped/cursor", json=body)
    assert r.status_code == 400 and "position" in r.json()["detail"]
    order = {"id": "o1", "side": "long", "order_type": "limit", "price": 4990.0, "contracts": 7,
             "sl_price": None, "tp_price": None, "risk_usd": None, "placed_time": _ts("14:00")}
    r = bt_client.patch("/api/bt-sessions/capped/cursor", json={"cursor_time": _ts("14:00"), "position": None, "working_orders": [order]})
    assert r.status_code == 400 and "working order" in r.json()["detail"]
    ok = bt_client.patch("/api/bt-sessions/capped/cursor", json={"cursor_time": _ts("14:00"), "position": _position(5), "working_orders": []})
    assert ok.status_code == 200


def test_plain_practice_session_has_no_position_cap(bt_client):
    _write_session("free", prop_ruleset=None)
    assert bt_client.post("/api/bt-sessions/free/trades", json=_trade_body(25)).status_code == 200
    assert bt_client.patch("/api/bt-sessions/free/cursor", json={"cursor_time": _ts("14:00"), "position": _position(25), "working_orders": []}).status_code == 200


def test_create_topstep_session_sets_the_cap_and_rejects_default_contracts_over_it(bt_client):
    from propbt.config import load_data_paths
    paths = load_data_paths()
    if "MES" not in paths or not paths["MES"].exists():
        pytest.skip("MES data file not present")
    body = {"instrument": "MES", "base_timeframe": "5min", "start_time": _ts("14:30", "2025-03-10"),
            "starting_balance": 50000.0, "risk_per_trade_percent": 1.0, "default_contracts": 6,
            "commission_per_contract": 1.3, "prop_ruleset": "topstep_50k"}
    r = bt_client.post("/api/bt-sessions", json=body)
    assert r.status_code == 400 and "limit of 5" in r.json()["detail"]
    body["default_contracts"] = 5
    ok = bt_client.post("/api/bt-sessions", json=body)
    assert ok.status_code == 200 and ok.json()["account"]["max_contracts"] == 5
    body["prop_ruleset"], body["default_contracts"] = None, 6
    free = bt_client.post("/api/bt-sessions", json=body)
    assert free.status_code == 200 and free.json()["account"]["max_contracts"] is None


# ------------------------------------------------- prop status in the sessions list

def test_sessions_list_carries_each_prop_sessions_combine_status(bt_client):
    _seed_hand_checked("open1", prop_ruleset="topstep_50k")           # incomplete
    _write_session("bust", prop_ruleset="topstep_50k", balance=48000.0)
    bts._write_trades("bust", [_trade(1, "bust", "13:30", "14:00", "long", -1900.0, -4.0, 410.0)])
    _write_session("plain")
    rows = {s["id"]: s for s in bt_client.get("/api/bt-sessions").json()}
    assert rows["open1"]["prop_status"]["status"] == "incomplete"
    assert rows["bust"]["prop_status"] == {
        "status": "failed", "fail_reason": "mll_breach", "resolved_trade_id": 1, "trades_to_result": 1}
    assert rows["plain"]["prop_status"] is None
