"""FXR_V2_SPEC.md section 6 (G8): the Analytics page's aggregates, the RR
simulator and the prop-rules modal's status.

The RR simulator is tested on hand-built 1m paths (a frame monkeypatched in for
the instrument's bars), so every expected number below is worked out by hand:
MES, $5 / point, 1 contract, commission 1.00.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from app.backend import models
from app.backend.services import bar_service, manual_analytics, rr_simulator
from app.backend.services import bt_session_service as bts
from propbt.config import load_prop_rules
from propbt.engine.prop_rules import PropRulesTracker

PV = 5.0  # MES point value


@pytest.fixture()
def bt_client(client, tmp_path, monkeypatch):
    monkeypatch.setenv("PROPBT_BT_SESSIONS_DIR", str(tmp_path / "bt_sessions"))
    return client


def _utc(day: str, hhmm: str) -> pd.Timestamp:
    return pd.Timestamp(f"{day} {hhmm}:00", tz="UTC")


def _unix(day: str, hhmm: str) -> int:
    return int(_utc(day, hhmm).timestamp())


def _bars(start: pd.Timestamp, rows) -> pd.DataFrame:
    """1m bars from `start`; rows are (open, high, low, close)."""
    idx = pd.DatetimeIndex([start + pd.Timedelta(minutes=i) for i in range(len(rows))], name="ts_event", tz="UTC")
    o, h, l, c = zip(*rows)
    return pd.DataFrame({"open": o, "high": h, "low": l, "close": c, "volume": [100] * len(rows)}, index=idx)


@pytest.fixture()
def fake_bars(monkeypatch):
    holder = {}

    def load(instrument):
        if instrument not in holder:
            raise bar_service.UnknownInstrument(instrument)
        return holder[instrument]

    monkeypatch.setattr(bar_service, "_load_raw", load)
    return holder


# ------------------------------ simulate_trade ------------------------------

def _sim(side, entry, stop, bars, last_close=None, n=range(1, 4), contracts=1, commission=1.0):
    highs = np.array([b[0] for b in bars], dtype=float)
    lows = np.array([b[1] for b in bars], dtype=float)
    if last_close is None and bars:
        last_close = bars[-1][2]
    return rr_simulator.simulate_trade(side, entry, stop, PV, contracts, commission, highs, lows, last_close, tuple(n))


def test_target_hit_first_wins_at_n_times_risk():
    # Long 100, stop 90 (1R = 10). Bars are (high, low, close).
    out = _sim("long", 100, 90, [(105, 98, 104), (112, 103, 111), (125, 108, 124)])
    # 1R = 110 is touched in bar 2 (the stop at 90 never is): +10 pts.
    assert out[1].pnl_usd == pytest.approx(10 * PV - 1.0)
    # 2R = 120 in bar 3.
    assert out[2].pnl_usd == pytest.approx(20 * PV - 1.0)
    # 3R = 130 is never reached: flattened at the last close, 124.
    assert out[3].pnl_usd == pytest.approx(24 * PV - 1.0)
    # Heat: bar 1 dipped to 98 (2 points); bar 2 (the 1R exit bar) to 103 -> still 2.
    assert out[1].drawdown_points == pytest.approx(2.0)
    assert out[1].drawdown_usd == pytest.approx(2.0 * PV)
    assert out[1].drawdown_r == pytest.approx(0.2)


def test_stop_hit_first_loses_one_r_whatever_the_target():
    out = _sim("long", 100, 90, [(104, 95, 96), (106, 89, 91), (130, 100, 128)])
    for n in (1, 2, 3):
        assert out[n].pnl_usd == pytest.approx(-10 * PV - 1.0)
        assert out[n].drawdown_r == pytest.approx(1.0)  # out at the stop: 1R, not the bar's 11 points


def test_same_minute_stop_and_target_resolves_as_the_stop():
    # One bar spans both the 90 stop and the 110 target.
    out = _sim("long", 100, 90, [(111, 89, 100)])
    assert out[1].pnl_usd == pytest.approx(-10 * PV - 1.0)
    # An earlier bar that reaches the target alone wins, even if a later one touches both.
    out = _sim("long", 100, 90, [(111, 99, 110), (111, 89, 100)])
    assert out[1].pnl_usd == pytest.approx(10 * PV - 1.0)


def test_short_trades_mirror_the_long_case():
    # Short 100, stop 110: 1R target is 90.
    out = _sim("short", 100, 110, [(104, 96, 98), (101, 89, 90)])
    assert out[1].pnl_usd == pytest.approx(10 * PV - 1.0)
    assert out[1].drawdown_points == pytest.approx(4.0)   # the 104 high
    out = _sim("short", 100, 110, [(111, 99, 105), (101, 80, 85)])
    assert out[1].pnl_usd == pytest.approx(-10 * PV - 1.0)  # the stop came first


def test_commission_and_contracts_scale_the_result():
    out = _sim("long", 100, 90, [(112, 99, 110)], contracts=3, commission=3.0, n=(1,))
    assert out[1].pnl_usd == pytest.approx(10 * PV * 3 - 3.0)


def test_empty_path_is_flat_at_entry():
    out = _sim("long", 100, 90, [], last_close=None, n=(1,))
    assert out[1].pnl_usd == pytest.approx(-1.0)


# ------------------------------ end-of-day flatten ------------------------------

def _prop_rules(**kw) -> models.PropRules:
    base = dict(profit_target=3000, max_loss=2000, max_loss_type="eod_trailing", daily_loss_limit=1000,
                no_overnight=True, close_time="16:00")
    base.update(kw)
    return models.PropRules(**base)


def test_flatten_rule_follows_the_session_restrictions():
    r = rr_simulator.flatten_rule(_prop_rules(close_time="15:30"))
    assert (r.hour, r.minute, r.weekdays) == (15, 30, (0, 1, 2, 3, 4))
    r = rr_simulator.flatten_rule(_prop_rules(no_overnight=False, no_weekend=True))
    assert r.weekdays == (4,)
    r = rr_simulator.flatten_rule(None)  # no restriction: the CME trading-day close
    assert (r.hour, r.minute) == (17, 0)


def test_next_close_skips_weekends_and_uses_et():
    rule = rr_simulator.FlattenRule(16, 0, (0, 1, 2, 3, 4))
    # 2025-03-14 is a Friday; 16:00 EDT = 20:00 UTC. After the Friday close the next is Monday's.
    after_friday = rr_simulator.next_close_after(rule, _utc("2025-03-14", "20:30"))
    assert after_friday == _utc("2025-03-17", "20:00")
    assert rr_simulator.next_close_after(rule, _utc("2025-03-14", "15:00")) == _utc("2025-03-14", "20:00")


def _trade(tid, entry_hhmm, side="long", entry=100.0, stop=90.0, sl_at_close=None, day="2025-03-11", **kw):
    t = {
        "trade_id": tid, "session_id": "s1", "source": "manual",
        "entry_time": _unix(day, entry_hhmm), "exit_time": _unix(day, entry_hhmm) + 600, "instrument": "MES",
        "side": side, "leg": None, "session": "ny", "trading_day": None, "size_contracts": 1,
        "entry_price": entry, "exit_price": entry, "sl_price": sl_at_close, "tp_price": None,
        "entry_sl_price": stop, "sl_points": None, "tp_points": None, "rr_planned": None,
        "exit_type": "manual_close", "pnl_usd": -1.0, "r_multiple": None, "commission_usd": 1.0,
        "mae_points": 2.0, "mfe_points": 5.0, "mae_r": None, "mfe_r": None, "bars_held": 3,
        "notes": "", "tags": [], "setup_name": None, "grade": None, "screenshots": [],
    }
    t.update(kw)
    return t


def _write_session(session_id="s1", instrument="MES", prop_rules=None, balance=50000.0, cursor="2025-03-11 23:00",
                   assets=None) -> None:
    now = "2025-03-11T20:00:00+00:00"
    acct = {
        "id": "acct-" + session_id, "starting_balance": 50000.0, "balance": balance, "currency": "USD",
        "risk_per_trade_percent": 1.0, "risk_per_trade_usd": None, "commission_per_contract": 1.0,
    }
    if prop_rules is not None:
        acct["prop_ruleset"] = "custom"
        acct["prop_rules"] = prop_rules.model_dump()
    bts._write(session_id, {
        "id": session_id, "instrument": instrument, "assets": assets or [instrument], "base_timeframe": "1min",
        "start_time": _unix("2025-03-11", "13:00"), "created_at": now, "updated_at": now,
        "cursor_time": int(pd.Timestamp(cursor, tz="UTC").timestamp()), "status": "active", "replay_version": 2,
        "account": acct, "positions": [], "working_orders": [], "notes": None,
    })


def _simulate(session_id="s1", instrument=None):
    return rr_simulator.simulate([bts.get_session(session_id)], instrument=instrument, scope=f"bt:{session_id}")


def test_path_is_cut_at_the_prop_sessions_flatten_close(bt_client, fake_bars):
    # Entry 19:55 UTC (15:55 ET, EDT). 16:00 ET = 20:00 UTC: the 19:59 bar is the flatten bar.
    # The target (110) is only touched at 20:05, AFTER the flatten, so it must not count.
    start = _utc("2025-03-11", "19:55")
    rows = [(100, 101, 99, 100)] * 4 + [(100, 103, 99, 102)] * 1 + [(102, 111, 100, 110)] * 6  # 19:55..20:05
    fake_bars["MES"] = _bars(start, rows)
    _write_session(prop_rules=_prop_rules())
    bts._write_trades("s1", [_trade(1, "19:55"), _trade(2, "19:55"), _trade(3, "19:55")])
    res = _simulate()
    assert res.qualified == 3
    # Flatten bar = 19:59 (close 102 at index 4? bars: 19:55-19:58 -> idx0-3, 19:59 -> idx4). Entry
    # price 100 == the entry bar's close (100) -> a market entry, so the path starts at 19:56.
    # Exit at the 19:59 close, 102: +2 points, not the +10 the 20:05 bar would give.
    one_r = res.rows[0]
    assert one_r.n == 1
    assert one_r.net_pnl_usd == pytest.approx(3 * (2 * PV - 1.0))
    assert one_r.wins == 3


def test_non_prop_session_flattens_at_the_cme_close(bt_client, fake_bars):
    # No restriction: 17:00 ET = 21:00 UTC. A target touched at 21:05 (inside the halt's
    # aftermath, i.e. the next trading day) does not count; 20:59 is the flatten bar.
    start = _utc("2025-03-11", "20:55")
    rows = [(100, 101, 99, 100), (100, 101, 99, 100), (100, 101, 99, 100), (100, 101, 99, 100),
            (100, 104, 99, 103), (103, 112, 100, 111), (103, 112, 100, 111)]  # 20:55 .. 21:01
    fake_bars["MES"] = _bars(start, rows)
    _write_session()
    bts._write_trades("s1", [_trade(i, "20:55") for i in (1, 2, 3)])
    res = _simulate()
    assert res.enough
    # Flatten bar 20:59 (index 4, close 103).
    assert res.rows[0].net_pnl_usd == pytest.approx(3 * (3 * PV - 1.0))


def test_the_path_never_runs_past_the_sessions_cursor(bt_client, fake_bars):
    start = _utc("2025-03-11", "14:00")
    rows = [(100, 101, 99, 100), (100, 103, 99, 102), (102, 130, 101, 125)]  # target only at 14:02
    fake_bars["MES"] = _bars(start, rows)
    _write_session(cursor="2025-03-11 14:01")  # the session only revealed up to 14:01
    bts._write_trades("s1", [_trade(i, "14:00") for i in (1, 2, 3)])
    res = _simulate()
    assert res.rows[0].net_pnl_usd == pytest.approx(3 * (2 * PV - 1.0))  # flat at the 14:01 close, 102


def test_a_resting_order_stopped_in_its_entry_bar_cannot_be_won(bt_client, fake_bars):
    # Limit buy filled at 95 inside the 14:00 bar (its close is 100, so it was not a market
    # entry), which also reached the 85 stop. The next bar rallies through the target.
    start = _utc("2025-03-11", "14:00")
    rows = [(100, 101, 84, 100), (100, 130, 99, 128)]
    fake_bars["MES"] = _bars(start, rows)
    _write_session()
    bts._write_trades("s1", [_trade(i, "14:00", entry=95.0, stop=85.0) for i in (1, 2, 3)])
    res = _simulate()
    assert res.rows[0].net_pnl_usd == pytest.approx(3 * (-10 * PV - 1.0))


def test_trades_without_a_stop_at_entry_are_excluded(bt_client, fake_bars):
    start = _utc("2025-03-11", "14:00")
    rows = [(100, 101, 99, 100), (100, 112, 99, 111), (111, 113, 110, 112)]
    fake_bars["MES"] = _bars(start, rows)
    _write_session()
    bts._write_trades("s1", [
        _trade(1, "14:00"),
        _trade(2, "14:00"),
        _trade(3, "14:00"),
        # A stop was added AFTER entry: sl_price (at close) is set, entry_sl_price is not.
        _trade(4, "14:00", stop=None, sl_at_close=90.0),
        # Journaled before G8: neither field says anything.
        _trade(5, "14:00", stop=None, sl_at_close=None),
    ])
    res = _simulate()
    assert (res.total_trades, res.qualified) == (5, 3)
    assert res.excluded == {"no_stop_at_entry": 2}
    assert res.enough and len(res.rows) == 10 and res.rows[0].trades == 3
    assert res.actual is not None and res.actual.trades == 3


def test_fewer_than_three_qualifying_trades_is_not_enough(bt_client, fake_bars):
    fake_bars["MES"] = _bars(_utc("2025-03-11", "14:00"), [(100, 101, 99, 100), (100, 112, 99, 111)])
    _write_session()
    bts._write_trades("s1", [_trade(1, "14:00"), _trade(2, "14:00"), _trade(3, "14:00", stop=None)])
    res = _simulate()
    assert (res.qualified, res.enough, res.rows, res.actual) == (2, False, [], None)
    assert res.min_trades == 3


def test_instrument_filter_and_api(bt_client, fake_bars):
    fake_bars["MES"] = _bars(_utc("2025-03-11", "14:00"), [(100, 101, 99, 100), (100, 112, 99, 111)])
    _write_session()
    bts._write_trades("s1", [_trade(i, "14:00") for i in (1, 2, 3)])
    body = bt_client.get("/api/manual-analytics/bt:s1/rr-simulator").json()
    assert body["qualified"] == 3 and body["enough"] is True and len(body["rows"]) == 10
    none = bt_client.get("/api/manual-analytics/bt:s1/rr-simulator", params={"instrument": "MNQ"}).json()
    assert none["total_trades"] == 0 and none["enough"] is False
    assert bt_client.get("/api/manual-analytics/nope/rr-simulator").status_code == 404


def test_profit_factor_is_null_without_a_loser(bt_client, fake_bars):
    fake_bars["MES"] = _bars(_utc("2025-03-11", "14:00"), [(100, 101, 99, 100), (100, 112, 99, 111)])
    _write_session()
    bts._write_trades("s1", [_trade(i, "14:00") for i in (1, 2, 3)])
    res = _simulate()
    assert res.rows[0].profit_factor is None and res.rows[0].win_rate == 1.0


# -------------------------- stats reconcile with trades --------------------------

def _journal(tid, session_id, day, hhmm, side, pnl, r, mae_r, instrument="MES", **kw):
    t = _trade(tid, hhmm, side=side, day=day, instrument=instrument, pnl_usd=pnl, r_multiple=r, mae_r=mae_r,
               session_id=session_id, **kw)
    t["exit_time"] = t["entry_time"] + 900
    return t


def _seed_two_sessions():
    _write_session("a", assets=["MES", "MNQ"], instrument="MES")
    _write_session("b", instrument="MNQ")
    bts._write_trades("a", [
        _journal(1, "a", "2025-03-11", "14:00", "long", 200.0, 2.0, 0.4),       # Tue
        _journal(2, "a", "2025-03-11", "15:00", "short", -100.0, -1.0, 0.9),
        _journal(3, "a", "2025-03-12", "14:00", "long", 300.0, 3.0, 0.2, instrument="MNQ"),  # Wed
    ])
    bts._write_trades("b", [
        _journal(1, "b", "2025-04-02", "14:00", "long", 50.0, 0.5, 0.1, instrument="MNQ"),   # Wed, April
        _journal(2, "b", "2025-04-04", "14:00", "short", -150.0, -1.5, 1.0, instrument="MNQ"),  # Fri
    ])


def test_summary_reconciles_with_the_trade_list(bt_client):
    _seed_two_sessions()
    trades = bt_client.get("/api/runs/bt:all/trades").json()
    s = bt_client.get("/api/manual-analytics/bt:all/summary").json()
    pnls = [t["pnl_usd"] for t in trades]
    st = s["stats"]
    assert len(trades) == st["trades"] == 5
    assert st["net_pnl_usd"] == pytest.approx(sum(pnls)) == pytest.approx(300.0)
    assert st["wins"] == sum(p > 0 for p in pnls) == 3
    assert st["win_rate"] == pytest.approx(3 / 5)
    assert st["profit_factor"] == pytest.approx(550 / 250)
    assert st["avg_r"] == pytest.approx(np.mean([2.0, -1.0, 3.0, 0.5, -1.5]))
    assert st["r_trades"] == 5
    # Buckets partition the trades.
    assert sum(m["net_pnl_usd"] for m in s["monthly"]) == pytest.approx(300.0)
    assert sum(m["trades"] for m in s["monthly"]) == 5
    assert [m["key"] for m in s["monthly"]] == ["2025-03", "2025-04"]
    assert sum(w["trades"] for w in s["weekday"]) == 5
    assert sum(w["net_pnl_usd"] for w in s["weekday"]) == pytest.approx(300.0)
    by_wd = {w["label"]: w for w in s["weekday"]}
    assert by_wd["Tue"]["trades"] == 2 and by_wd["Wed"]["trades"] == 2 and by_wd["Fri"]["trades"] == 1
    # Equity curve ends at the total, one step per exit.
    assert len(s["equity"]) == 5 and s["equity"][-1]["pnl_usd"] == pytest.approx(300.0)
    # Periods with a trade: 4 trading days, 2 ISO weeks (11-12 Mar, 2-4 Apr), 2 months.
    assert st["avg_gain_day"] == {"value": pytest.approx(75.0), "periods": 4}
    assert st["avg_gain_week"]["periods"] == 2 and st["avg_gain_week"]["value"] == pytest.approx(150.0)
    assert st["avg_gain_month"] == {"value": pytest.approx(150.0), "periods": 2}
    # Heat on winners: mae_r of the three winners (0.4, 0.2, 0.1).
    assert s["heat"] == {"sample": 3, "avg_r": pytest.approx(0.7 / 3), "max_r": 0.4, "min_r": 0.1}


def test_instrument_filter_matches_the_filtered_trade_list(bt_client):
    _seed_two_sessions()
    trades = bt_client.get("/api/runs/bt:all/trades", params={"instrument": "MNQ"}).json()
    s = bt_client.get("/api/manual-analytics/bt:all/summary", params={"instrument": "MNQ"}).json()
    assert s["stats"]["trades"] == len(trades) == 3
    assert s["stats"]["net_pnl_usd"] == pytest.approx(sum(t["pnl_usd"] for t in trades)) == pytest.approx(200.0)
    assert s["instruments"] == ["MES", "MNQ"]  # the filter options stay whole


def test_single_session_scope_and_empty_scope(bt_client):
    _seed_two_sessions()
    s = bt_client.get("/api/manual-analytics/bt:b/summary").json()
    assert s["stats"]["trades"] == 2 and s["starting_balance"] == 50000.0
    _write_session("empty")
    e = bt_client.get("/api/manual-analytics/bt:empty/summary").json()
    assert e["stats"]["trades"] == 0 and e["stats"]["win_rate"] is None and e["equity"] == []
    assert [w["trades"] for w in e["weekday"]] == [0, 0, 0, 0, 0]


def test_pooled_scope_keeps_both_instruments(bt_client):
    _seed_two_sessions()
    meta = bt_client.get("/api/runs/bt:all").json()
    assert meta["instruments"] == ["MES", "MNQ"] and sorted(meta["session_ids"]) == ["a", "b"]
    # The older per-instrument pool still works and only holds that instrument.
    assert len(bt_client.get("/api/runs/bt:all:MNQ/trades").json()) == 3


def test_trade_without_entry_stop_round_trips_through_the_api(bt_client):
    """entry_sl_price is journaled with the trade (and None stays None)."""
    _write_session("rt")
    base = {k: v for k, v in _trade(1, "14:00").items() if k not in ("trade_id", "session_id", "source", "notes", "tags", "setup_name", "grade", "screenshots", "trading_day")}
    r = bt_client.post("/api/bt-sessions/rt/trades", json={**base, "entry_sl_price": 90.0})
    assert r.status_code == 200, r.text
    assert r.json()["trade"]["entry_sl_price"] == 90.0
    r = bt_client.post("/api/bt-sessions/rt/trades", json={**base, "entry_sl_price": None, "sl_price": 95.0})
    assert r.json()["trade"]["entry_sl_price"] is None and r.json()["trade"]["sl_price"] == 95.0


# ------------------------------ prop rules status ------------------------------

def _seed_prop(rules=None):
    rules = rules or _prop_rules(no_overnight=False)
    _write_session("p", prop_rules=rules, balance=50400.0, cursor="2025-03-11 15:00")
    bts._write_trades("p", [
        _journal(1, "p", "2025-03-11", "14:00", "long", 200.0, 2.0, 0.4),
        _journal(2, "p", "2025-03-11", "14:30", "short", -150.0, -1.5, 0.9),
        _journal(3, "p", "2025-03-11", "14:45", "long", 350.0, 3.5, 0.2),
    ])
    return "p"


def test_progress_cards_match_the_tracker(bt_client):
    sid = _seed_prop()
    st = bt_client.get(f"/api/manual-analytics/sessions/{sid}/prop-rules", params={"open_pnl": -600}).json()

    # Independent drive of the SAME tracker over the same account path.
    session = bts.get_session(sid)
    cfg = manual_analytics.session_engine_config(session)
    tracker = PropRulesTracker(cfg)
    day = manual_analytics.trading_day_of(_utc("2025-03-11", "14:00"), manual_analytics.load_sessions())
    bal = 50000.0
    for pnl in (200.0, -150.0, 350.0):
        tracker.on_bar(_utc("2025-03-11", "14:00"), day, bal, bal)
        bal += pnl
        tracker.on_bar(_utc("2025-03-11", "14:00"), day, bal, bal)
    equity = bal - 600
    tracker.on_bar(_utc("2025-03-11", "15:00"), day, bal, equity)

    assert st["status"] == "incomplete"
    assert st["balance"] == pytest.approx(bal) == pytest.approx(50400.0)
    assert st["equity"] == pytest.approx(equity)
    # Profit target: realized profit toward the $3,000 target.
    assert st["profit"]["limit"] == 3000 and st["profit"]["used"] == pytest.approx(400.0)
    assert st["profit"]["left"] == pytest.approx(2600.0) and st["profit"]["fraction"] == pytest.approx(400 / 3000)
    # Max loss: the tracker's floor is 48,000 (EOD trailing has not trailed yet); equity is 49,800.
    assert st["max_loss_floor"] == pytest.approx(tracker.mll_floor) == pytest.approx(48000.0)
    assert st["max_loss"]["left"] == pytest.approx(equity - tracker.mll_floor) == pytest.approx(1800.0)
    assert st["max_loss"]["used"] == pytest.approx(200.0)
    # Daily loss: the day opened at 50,000 and equity is 49,800.
    assert st["day_start_balance"] == pytest.approx(tracker.day_start_balance) == pytest.approx(50000.0)
    assert st["daily_loss"]["limit"] == 1000 and st["daily_loss"]["used"] == pytest.approx(200.0)
    assert st["daily_loss"]["left"] == pytest.approx(800.0)
    assert st["daily_locked"] is False


def test_next_trading_day_rolls_the_daily_and_trails_the_floor(bt_client):
    sid = _seed_prop()
    # Cursor on the next CME day: the day opens at the realized 50,400; EOD trailing lifts
    # the floor to 50,400 - 2,000 = 48,400.
    nxt = _unix("2025-03-12", "14:00")
    st = bt_client.get(f"/api/manual-analytics/sessions/{sid}/prop-rules", params={"open_pnl": -250, "cursor_time": nxt}).json()
    assert st["day_start_balance"] == pytest.approx(50400.0)
    assert st["max_loss_floor"] == pytest.approx(48400.0)
    assert st["daily_loss"]["used"] == pytest.approx(250.0)
    assert st["max_loss"]["left"] == pytest.approx(50150.0 - 48400.0)


def test_a_breach_reads_as_failed_with_the_budget_gone(bt_client):
    sid = _seed_prop()
    st = bt_client.get(f"/api/manual-analytics/sessions/{sid}/prop-rules", params={"open_pnl": -2500}).json()
    assert st["status"] == "failed" and st["fail_reason"] == "mll_breach"
    assert st["max_loss"]["used"] == st["max_loss"]["limit"] and st["max_loss"]["left"] == 0
    assert st["open_pnl"] == 0  # a resolved Combine no longer marks the float


def test_daily_loss_lock_and_rules_table(bt_client):
    sid = _seed_prop()
    st = bt_client.get(f"/api/manual-analytics/sessions/{sid}/prop-rules", params={"open_pnl": -1500}).json()
    assert st["status"] == "incomplete" and st["daily_locked"] is True
    assert st["daily_loss"]["used"] == st["daily_loss"]["limit"] == 1000
    rows = {r["key"]: r["value"] for r in st["rules"]}
    assert rows["profit_target"] == "$3,000" and rows["daily_loss"] == "$1,000"
    assert rows["max_loss"].startswith("$2,000") and "End-of-day trailing" in rows["max_loss"]
    assert [r["key"] for r in st["restrictions"]] == ["no_news", "no_overnight", "no_weekend"]
    assert not any(r["on"] for r in st["restrictions"])


def test_restrictions_checklist_reflects_the_rules(bt_client):
    sid = _seed_prop(_prop_rules(no_overnight=True, no_news=True, news_window_minutes=10, close_time="15:45"))
    st = bt_client.get(f"/api/manual-analytics/sessions/{sid}/prop-rules").json()
    on = {r["key"]: r for r in st["restrictions"]}
    assert on["no_news"]["on"] and "10 min" in on["no_news"]["detail"]
    assert on["no_overnight"]["on"] and "15:45 ET" in on["no_overnight"]["detail"]
    assert not on["no_weekend"]["on"]


def test_prop_rules_for_a_practice_session_is_400_and_unknown_404(bt_client):
    _write_session("plain")
    assert bt_client.get("/api/manual-analytics/sessions/plain/prop-rules").status_code == 400
    assert bt_client.get("/api/manual-analytics/sessions/ghost/prop-rules").status_code == 404


def test_status_agrees_with_the_stats_verdict(bt_client):
    """Same journal, same tracker: the modal's verdict is the Stats endpoint's verdict."""
    sid = _seed_prop()
    st = bt_client.get(f"/api/manual-analytics/sessions/{sid}/prop-rules").json()
    stats = bt_client.get(f"/api/runs/bt:{sid}/stats").json()
    assert st["status"] == stats["result"]["status"]
    assert st["balance"] == pytest.approx(stats["result"]["final_balance"])


def test_planned_rr_uses_the_entry_stop_and_entry_target_only(bt_client):
    _write_session("pr")
    rows = [
        # long 100, stop 90, target 130 -> 3.0
        _journal(1, "pr", "2025-03-11", "14:00", "long", 10.0, 1.0, 0.1, stop=90.0, entry_tp_price=130.0),
        # short 100, stop 105, target 90 -> 2.0
        _journal(2, "pr", "2025-03-11", "15:00", "short", 10.0, 1.0, 0.1, stop=105.0, entry_tp_price=90.0),
        # a target added later (tp_price at close only): not a plan
        _journal(3, "pr", "2025-03-12", "14:00", "long", 10.0, 1.0, 0.1, stop=90.0, tp_price=150.0),
        # no entry stop, but a target: not a plan
        _journal(4, "pr", "2025-03-12", "15:00", "long", 10.0, 1.0, 0.1, stop=None, entry_tp_price=120.0),
        # target on the wrong side of the entry
        _journal(5, "pr", "2025-03-13", "14:00", "long", 10.0, 1.0, 0.1, stop=90.0, entry_tp_price=95.0),
    ]
    bts._write_trades("pr", rows)
    st = bt_client.get("/api/manual-analytics/bt:pr/summary").json()["stats"]
    assert st["planned_rr_trades"] == 2
    assert st["avg_planned_rr"] == pytest.approx(2.5)
    assert st["r_trades"] == 5  # realized R is counted on its own
