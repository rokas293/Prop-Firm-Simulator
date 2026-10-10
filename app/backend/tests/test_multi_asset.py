"""FXR_V2_SPEC.md sections 4 and 6 (G7): multi-asset sessions and the economic
calendar -- the server side.

One account, one cursor, two instruments. What these pin down:

  * the Topstep position cap counts contracts ACROSS instruments (a flat count:
    propbt/config/prop_rules.yaml, position_limit.max_open_contracts, whose comment
    says "5 MES, 5 MNQ, or 5 ZN (or any mix) all max this out"; docs/DATA_AND_RULES.md
    section 3), and is enforced where a session saves its broker state;
  * the prop rules (daily loss, trailing MLL, consistency) are judged on the one
    account: realized trades in the two instruments add up, and positions open at
    the same time add their open P&L, minute by minute, on the real 1m bars;
  * a single-asset session's verdict does not move (the golden Topstep fixtures);
  * the calendar serves a schedule and nothing about an outcome, and the no-news
    restriction refuses a position entered inside a high-impact event's window.

Bars are synthetic and injected (flat 1m bars with a designated dip) so every
number below can be checked by hand; the sessions are written straight to disk
like test_manual_analytics.py does.
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path

import pandas as pd
import pytest

from app.backend.services import bar_service
from app.backend.services import bt_session_service as bts
from app.backend.services import manual_analytics as ma
from app.backend.services import news_service

FIXTURES = Path(__file__).parent / "fixtures" / "topstep_regression"
DAY = "2025-03-11"  # one CME trading day; 15:00 UTC = 11:00 ET


@pytest.fixture()
def bt_client(client, tmp_path, monkeypatch):
    monkeypatch.setenv("PROPBT_BT_SESSIONS_DIR", str(tmp_path / "bt_sessions"))
    return client


def _ts(hhmm: str, day: str = DAY) -> int:
    return int(pd.Timestamp(f"{day} {hhmm}:00", tz="UTC").timestamp())


def _utc(hhmm: str, day: str = DAY) -> pd.Timestamp:
    return pd.Timestamp(f"{day} {hhmm}:00", tz="UTC")


# ------------------------------- creating sessions -------------------------------

def _create(client, **overrides):
    body = {
        "assets": ["MNQ", "MES"],
        "base_timeframe": "5min",
        "start_time": int(pd.Timestamp("2025-03-10 14:30:00", tz="UTC").timestamp()),
        "starting_balance": 50000.0,
    }
    body.update(overrides)
    return client.post("/api/bt-sessions", json=body)


def test_a_session_can_hold_both_micros_with_one_cursor_and_one_account(bt_client):
    r = _create(bt_client, commissions={"MNQ": 1.1, "MES": 1.5})
    assert r.status_code == 200, r.text
    s = r.json()
    assert s["assets"] == ["MNQ", "MES"] and s["instrument"] == "MNQ"  # the first is the primary
    assert s["account"]["commissions"] == {"MNQ": 1.1, "MES": 1.5}
    assert s["positions"] == [] and s["working_orders"] == []
    assert isinstance(s["cursor_time"], int)  # one cursor for both


def test_assets_may_not_repeat_or_be_unknown(bt_client):
    assert _create(bt_client, assets=["MNQ", "MNQ"]).status_code == 400
    assert _create(bt_client, assets=["MNQ", "ZN"]).status_code == 400


# --------------------------------- position cap ---------------------------------

def _pos(instrument, contracts, entry_time, **kw):
    body = {
        "instrument": instrument, "side": "long", "contracts": contracts, "entry_price": 20000.0,
        "entry_time": entry_time, "risk_usd": 100.0, "trade_key": f"{instrument}-{entry_time}",
        "initial_contracts": contracts,
    }
    body.update(kw)
    return body


def _save(client, session, positions=(), orders=(), cursor_offset=600):
    return client.patch(
        f"/api/bt-sessions/{session['id']}/cursor",
        json={
            "cursor_time": session["start_time"] + cursor_offset,
            "positions": list(positions),
            "working_orders": list(orders),
        },
    )


def test_the_topstep_cap_counts_contracts_across_instruments(bt_client):
    s = _create(bt_client, prop_ruleset="topstep_50k").json()
    assert s["account"]["max_contracts"] == 5
    t = s["start_time"] + 300
    # 3 MNQ + 2 MES = 5: at the cap, allowed.
    ok = _save(bt_client, s, [_pos("MNQ", 3, t), _pos("MES", 2, t)])
    assert ok.status_code == 200, ok.text
    assert sorted((p["instrument"], p["contracts"]) for p in ok.json()["positions"]) == [("MES", 2), ("MNQ", 3)]
    # 3 MNQ + 3 MES = 6: neither position is over the cap on its own, the account is.
    over = _save(bt_client, s, [_pos("MNQ", 3, t), _pos("MES", 3, t)])
    assert over.status_code == 400
    assert "6 contracts" in over.json()["detail"] and "limit of 5" in over.json()["detail"]
    # ... and it was not saved.
    assert sorted(p["contracts"] for p in bt_client.get(f"/api/bt-sessions/{s['id']}").json()["positions"]) == [2, 3]


def test_a_single_position_over_the_cap_is_still_refused(bt_client):
    s = _create(bt_client, assets=["MES"], prop_ruleset="topstep_50k").json()
    assert _save(bt_client, s, [_pos("MES", 6, s["start_time"])]).status_code == 400


def test_a_practice_session_has_no_cap_across_instruments(bt_client):
    s = _create(bt_client).json()
    assert s["account"]["max_contracts"] is None
    assert _save(bt_client, s, [_pos("MNQ", 30, s["start_time"]), _pos("MES", 30, s["start_time"])]).status_code == 200


def test_one_position_per_asset_and_only_the_sessions_assets(bt_client):
    s = _create(bt_client).json()
    t = s["start_time"]
    twice = _save(bt_client, s, [_pos("MNQ", 1, t), _pos("MNQ", 1, t, trade_key="again")])
    assert twice.status_code == 400 and "one position per asset" in twice.json()["detail"]
    other = bt_client.post("/api/bt-sessions", json={"assets": ["MES"], "base_timeframe": "5min", "start_time": t}).json()
    assert _save(bt_client, other, [_pos("MNQ", 1, t)]).status_code == 400


def test_a_trade_in_either_asset_lands_on_the_one_balance(bt_client):
    s = _create(bt_client).json()
    for sym, pnl in (("MNQ", -300.0), ("MES", 120.0)):
        body = {
            "entry_time": s["start_time"], "exit_time": s["start_time"] + 120, "instrument": sym, "side": "long",
            "size_contracts": 1, "entry_price": 5000.0, "exit_price": 5001.0, "exit_type": "manual_close",
            "pnl_usd": pnl, "commission_usd": 1.3, "mae_points": 1.0, "mfe_points": 2.0, "bars_held": 2,
        }
        assert bt_client.post(f"/api/bt-sessions/{s['id']}/trades", json=body).status_code == 200
    got = bt_client.get(f"/api/bt-sessions/{s['id']}").json()
    assert got["account"]["balance"] == 50000.0 - 300.0 + 120.0
    assert sorted(t["instrument"] for t in bt_client.get(f"/api/bt-sessions/{s['id']}/trades").json()) == ["MES", "MNQ"]
    bad = {**body, "instrument": "ZN"}
    assert bt_client.post(f"/api/bt-sessions/{s['id']}/trades", json=bad).status_code == 400


def test_a_v1_session_with_one_position_loads_as_positions(bt_client, tmp_path):
    """The single `position` of a session saved before multi-asset becomes the first of `positions`."""
    s = _create(bt_client, assets=["MES"]).json()
    p = tmp_path / "bt_sessions" / s["id"] / "session.json"
    raw = json.loads(p.read_text(encoding="utf-8"))
    raw.pop("positions")
    raw["position"] = {"side": "long", "contracts": 2, "entry_price": 5000.0, "entry_time": s["start_time"]}
    p.write_text(json.dumps(raw), encoding="utf-8")
    got = bt_client.get(f"/api/bt-sessions/{s['id']}").json()
    assert [(x["instrument"], x["contracts"]) for x in got["positions"]] == [("MES", 2)]
    assert got["position"] == got["positions"][0]  # the legacy view


# --------------------------- account-level prop rules ---------------------------

def _flat_bars(price: float, start="14:50", end="15:40") -> pd.DataFrame:
    idx = pd.date_range(_utc(start), _utc(end), freq="1min", name="ts_event")
    return pd.DataFrame({"open": price, "high": price, "low": price, "close": price, "volume": 100}, index=idx)


@pytest.fixture()
def bars(monkeypatch):
    """Flat 1m bars for both micros; a test dips one in place."""
    frames = {"MNQ": _flat_bars(20000.0), "MES": _flat_bars(5000.0)}
    for sym, df in frames.items():
        monkeypatch.setitem(bar_service._RAW_CACHE, sym, df)
    return frames


def _trade(trade_id, session_id, instrument, side, entry, exit_, entry_px, pnl, mae_pts, size=1, **kw):
    return {
        "trade_id": trade_id, "session_id": session_id, "source": "manual",
        "entry_time": _ts(entry), "exit_time": _ts(exit_), "instrument": instrument, "side": side,
        "leg": None, "session": "ny", "trading_day": None, "size_contracts": size,
        "entry_price": entry_px, "exit_price": entry_px, "sl_price": None, "tp_price": None,
        "sl_points": None, "tp_points": None, "rr_planned": None, "exit_type": "manual_close",
        "pnl_usd": pnl, "r_multiple": None, "commission_usd": 0.0,
        "mae_points": mae_pts, "mfe_points": kw.get("mfe_pts", 0.0), "mae_r": None, "mfe_r": None, "bars_held": 3,
        "notes": "", "tags": [], "setup_name": None, "grade": None, "screenshots": [],
    }


def _write_session(session_id, trades, prop_ruleset="topstep_50k", prop_rules=None, max_contracts=None):
    now = "2025-03-11T20:00:00+00:00"
    account = {
        "id": "acct-" + session_id, "starting_balance": 50000.0,
        "balance": 50000.0 + sum(t["pnl_usd"] for t in trades), "currency": "USD",
        "risk_per_trade_percent": 1.0, "risk_per_trade_usd": None, "commission_per_contract": 1.3,
        "commissions": {"MNQ": 1.3, "MES": 1.3}, "prop_ruleset": prop_ruleset,
    }
    if prop_rules is not None:
        account["prop_rules"] = prop_rules
        account["max_contracts"] = max_contracts
    bts._write(session_id, {
        "id": session_id, "instrument": "MNQ", "assets": ["MNQ", "MES"], "base_timeframe": "1min",
        "start_time": _ts("14:00"), "created_at": now, "updated_at": now, "cursor_time": _ts("16:00"),
        "status": "active", "replay_version": 2, "account": account, "settings": {"random_start": False},
        "positions": [], "working_orders": [], "notes": None,
    })
    bts._write_trades(session_id, trades)
    return ma.MANUAL_PREFIX + session_id


def _locked_days(run_id):
    return ma.get_stats(run_id).result.daily_loss_lock_days


def test_two_trades_each_under_the_daily_limit_lock_the_day_when_combined(bt_client, bars):
    """Topstep's daily limit is $1,000. An MNQ loss of $600 and an MES loss of $500
    are each under it; on one account they are $1,100 down: the day locks."""
    both = _write_session("both", [
        _trade(1, "both", "MNQ", "long", "15:00", "15:10", 20000.0, -600.0, mae_pts=300.0),   # 300 pts x $2 = $600
        _trade(2, "both", "MES", "short", "15:20", "15:30", 5000.0, -500.0, mae_pts=100.0),   # 100 pts x $5 = $500
    ])
    mnq_only = _write_session("mnq", [_trade(1, "mnq", "MNQ", "long", "15:00", "15:10", 20000.0, -600.0, mae_pts=300.0)])
    mes_only = _write_session("mes", [_trade(1, "mes", "MES", "short", "15:20", "15:30", 5000.0, -500.0, mae_pts=100.0)])
    assert _locked_days(mnq_only) == 0
    assert _locked_days(mes_only) == 0
    assert _locked_days(both) == 1
    # The day's risk table shows the lock too, and the Combine is still alive (a lock is not a fail).
    assert ma.prop_status("both").status == "incomplete"
    day = ma.list_daily_risk(both)[0]
    assert day.daily_locked and day.trades == 2


def test_each_instrument_is_priced_with_its_own_point_value(bt_client, bars):
    """The same 100-point adverse move is $200 in MNQ and $500 in MES -- a single
    instrument's spec applied to both would misjudge the daily limit."""
    mnq_100 = _write_session("a", [_trade(1, "a", "MNQ", "long", "15:00", "15:10", 20000.0, 0.0, mae_pts=100.0, size=5)])  # $1000
    mes_100 = _write_session("b", [_trade(1, "b", "MES", "long", "15:00", "15:10", 5000.0, 0.0, mae_pts=100.0, size=1)])    # $500
    assert _locked_days(mnq_100) == 1   # 100 x $2 x 5 = $1,000
    assert _locked_days(mes_100) == 0   # 100 x $5 x 1 = $500


def test_positions_open_together_add_up_minute_by_minute(bt_client, bars):
    """MNQ long (5 contracts, $2/pt) and MES long (4 contracts, $5/pt) are open together.
    At 15:10 MNQ is 40 points under (-$400) and MES 35 under (-$700): -$1,100 on the
    account, past the $1,000 daily limit, though each trade's own worst point is under it.
    Walked one trade at a time (the single-asset way) that is never seen."""
    bars["MNQ"].loc[_utc("15:10"), "low"] = 19960.0
    bars["MES"].loc[_utc("15:10"), "low"] = 4965.0
    trades = [
        _trade(1, "ov", "MNQ", "long", "15:00", "15:20", 20000.0, 10.0, mae_pts=40.0, size=5),
        _trade(2, "ov", "MES", "long", "15:05", "15:15", 5000.0, 10.0, mae_pts=35.0, size=4),
    ]
    run_id = _write_session("ov", trades)
    assert _locked_days(run_id) == 1
    # Each trade alone, on the same bars: no lock.
    assert _locked_days(_write_session("ov1", [{**trades[0], "session_id": "ov1"}])) == 0
    assert _locked_days(_write_session("ov2", [{**trades[1], "session_id": "ov2"}])) == 0
    # The lock is stamped at the minute it happened (15:10), not at a trade's exit.
    samples = [s for s in ma._session_replay(run_id)[2].samples if s["daily_locked"]]
    assert pd.Timestamp(samples[0]["time"]) == _utc("15:10")


CUSTOM_STATIC = {
    "profit_target": 3000.0, "max_loss_type": "static", "max_loss": 2000.0, "max_loss_locks_at_start": False,
    "daily_loss_limit": None, "consistency_pct": None, "max_contracts": None,
    "no_overnight": False, "no_weekend": False, "no_news": False, "news_window_minutes": 5, "close_time": "16:00",
}


def test_a_combined_drawdown_across_instruments_breaches_the_max_loss(bt_client, bars):
    """The floor is $2,000 under the start. MNQ x10 is 60 points under (-$1,200) and
    MES x2 90 points under (-$900) at 15:10: -$2,100, a breach neither shows alone."""
    bars["MNQ"].loc[_utc("15:10"), "low"] = 19940.0
    bars["MES"].loc[_utc("15:10"), "low"] = 4910.0
    trades = [
        _trade(1, "dd", "MNQ", "long", "15:00", "15:20", 20000.0, 0.0, mae_pts=60.0, size=10),
        _trade(2, "dd", "MES", "long", "15:05", "15:15", 5000.0, 0.0, mae_pts=90.0, size=2),
    ]
    run_id = _write_session("dd", trades, prop_ruleset="custom", prop_rules=CUSTOM_STATIC)
    status = ma.prop_status("dd")
    assert (status.status, status.fail_reason) == ("failed", "mll_breach")
    assert status.resolved_trade_id == 1                      # the deeper loss, MNQ
    stats = ma.get_stats(run_id)
    assert stats.result.resolved_time == _ts("15:10")
    for alone, trade in (("dd1", trades[0]), ("dd2", trades[1])):
        _write_session(alone, [{**trade, "session_id": alone}], prop_ruleset="custom", prop_rules=CUSTOM_STATIC)
        assert ma.prop_status(alone).status == "incomplete"


def test_the_trailing_floor_and_profit_target_use_the_shared_balance(bt_client, bars):
    """Profit in one instrument moves the same account's balance and the same target."""
    trades = [
        _trade(1, "tgt", "MNQ", "long", "15:00", "15:10", 20000.0, 1700.0, mae_pts=1.0),
        _trade(2, "tgt", "MES", "long", "15:20", "15:30", 5000.0, 1400.0, mae_pts=1.0),
    ]
    _write_session("tgt", trades)  # Topstep: target $3,000, consistency 50%
    s = ma.prop_status("tgt")
    # $3,100 total, but the best day is the whole thing: consistency (<= 50%) is not met.
    assert s.status == "incomplete"
    stats = ma.get_stats("bt:tgt")
    assert stats.result.final_balance == 53100.0 and stats.result.consistency_passed is False


def test_overlapping_exits_in_two_instruments_keep_the_equity_timeline_ordered(bt_client, bars):
    trades = [
        _trade(1, "tl", "MNQ", "long", "15:00", "15:20", 20000.0, 50.0, mae_pts=5.0, size=2),
        _trade(2, "tl", "MES", "short", "15:05", "15:15", 5000.0, -25.0, mae_pts=5.0, size=1),
    ]
    _write_session("tl", trades)
    eq = ma.build_equity_frame("bt:tl")
    assert eq["time"].is_monotonic_increasing
    assert eq["balance"].iloc[-1] == 50000.0 + 50.0 - 25.0


# ------------------------------- instrument filter -------------------------------

def test_analytics_can_filter_by_instrument(bt_client, bars):
    run_id = _write_session("flt", [
        _trade(1, "flt", "MNQ", "long", "15:00", "15:10", 20000.0, 100.0, mae_pts=1.0),
        _trade(2, "flt", "MES", "long", "15:20", "15:30", 5000.0, -40.0, mae_pts=1.0),
        _trade(3, "flt", "MES", "short", "15:35", "15:38", 5000.0, 60.0, mae_pts=1.0),
    ], prop_ruleset=None)
    meta = bt_client.get(f"/api/runs/{run_id}").json()
    assert meta["instruments"] == ["MNQ", "MES"] and meta["instrument"] == "MNQ"

    both = bt_client.get(f"/api/runs/{run_id}/trades").json()
    only_mes = bt_client.get(f"/api/runs/{run_id}/trades", params={"instrument": "MES"}).json()
    assert [t["instrument"] for t in both] == ["MNQ", "MES", "MES"]
    assert [t["trade_id"] for t in only_mes] == [2, 3]

    all_stats = bt_client.get(f"/api/runs/{run_id}/stats").json()
    mes_stats = bt_client.get(f"/api/runs/{run_id}/stats", params={"instrument": "MES"}).json()
    assert all_stats["overall"]["trades"] == 3 and all_stats["overall"]["net_pnl_usd"] == 120.0
    assert mes_stats["overall"]["trades"] == 2 and mes_stats["overall"]["net_pnl_usd"] == 20.0


def test_the_prop_verdict_stays_account_level_under_an_instrument_filter(bt_client, bars):
    trades = [
        _trade(1, "pv", "MNQ", "long", "15:00", "15:10", 20000.0, -600.0, mae_pts=300.0),
        _trade(2, "pv", "MES", "short", "15:20", "15:30", 5000.0, -500.0, mae_pts=100.0),
    ]
    run_id = _write_session("pv", trades)
    filtered = bt_client.get(f"/api/runs/{run_id}/stats", params={"instrument": "MES"}).json()
    assert filtered["overall"]["trades"] == 1
    assert filtered["result"]["daily_loss_lock_days"] == 1  # the lock came from both


def test_a_pooled_instrument_scope_holds_only_that_instruments_trades(bt_client, bars):
    _write_session("pool", [
        _trade(1, "pool", "MNQ", "long", "15:00", "15:10", 20000.0, 10.0, mae_pts=1.0),
        _trade(2, "pool", "MES", "long", "15:20", "15:30", 5000.0, 20.0, mae_pts=1.0),
    ], prop_ruleset=None)
    mnq = bt_client.get("/api/runs/bt:all:MNQ/trades").json()
    assert [t["instrument"] for t in mnq] == ["MNQ"]
    assert [t["instrument"] for t in bt_client.get("/api/runs/bt:all:MES/trades").json()] == ["MES"]


# ------------------------- single-asset verdicts are unchanged -------------------------

def test_single_asset_sessions_never_enter_the_overlap_walker_and_keep_their_verdicts(tmp_path, monkeypatch):
    """The regression the multi-asset change must not break: every saved single-asset
    Topstep session (real v1 files plus the synthetic pass / dilution / breach / lock /
    partial-exit ones) is one trade per unit -- the walk that judged it before G7 -- and
    every verdict, stat, equity vertex and daily-risk row equals the golden."""
    sessions_dir = tmp_path / "bt_sessions"
    shutil.copytree(FIXTURES / "sessions", sessions_dir)
    monkeypatch.setenv("PROPBT_BT_SESSIONS_DIR", str(sessions_dir))
    golden = json.loads((FIXTURES / "golden.json").read_text(encoding="utf-8"))
    assert golden
    for sid in sorted(golden):
        run_id = ma.MANUAL_PREFIX + sid
        df = ma.load_trades_frame(run_id)
        rows = list(df.itertuples(index=False))
        assert all(len(u) == 1 for u in ma._units(rows)), f"{sid}: a single-asset session was grouped as overlapping"
        s = bts.get_session(sid)
        assert s.assets == [s.instrument] and len(s.positions) <= 1
        stats = ma.get_stats(run_id)
        eq = ma.build_equity_frame(run_id)
        got = {
            "status": ma.prop_status(sid).model_dump(),
            "result": stats.result.model_dump() if stats.result else None,
            "overall": stats.overall.model_dump(),
            "equity": json.loads(eq.to_json(orient="records", date_format="epoch")),
            "daily_risk": [r.model_dump() for r in ma.list_daily_risk(run_id)],
        }
        assert json.loads(json.dumps(got)) == golden[sid], f"{sid}: verdict changed"


# ---------------------------------- the calendar ----------------------------------

@pytest.fixture()
def calendar(tmp_path, monkeypatch):
    path = tmp_path / "news_events.csv"
    path.write_text(
        "timestamp_utc,event,impact\n"
        "2025-03-11T15:30:00Z,FOMC Statement,high\n"
        "2025-03-11T12:30:00Z,CPI,medium\n"
        "2025-03-12T12:30:00Z,CPI,high\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("PROPBT_NEWS_EVENTS_PATH", str(path))
    return path


def test_the_calendar_serves_the_schedule_and_nothing_about_an_outcome(bt_client, calendar):
    r = bt_client.get("/api/news-events", params={"from": _ts("00:00"), "to": _ts("23:59", "2025-03-12")})
    assert r.status_code == 200
    events = r.json()
    # High impact only, oldest first -- the medium event is not on the calendar.
    assert [(e["event"], e["time"]) for e in events] == [("FOMC Statement", _ts("15:30")), ("CPI", _ts("12:30", "2025-03-12"))]
    # The payload is the schedule: when, what, how important. No actual / forecast / previous.
    assert all(set(e) == {"time", "event", "impact"} for e in events)
    # A range is a range.
    assert bt_client.get("/api/news-events", params={"from": _ts("16:00"), "to": _ts("23:00")}).json() == []


def test_a_missing_calendar_file_is_an_empty_calendar(bt_client, tmp_path, monkeypatch):
    monkeypatch.setenv("PROPBT_NEWS_EVENTS_PATH", str(tmp_path / "nope.csv"))
    assert bt_client.get("/api/news-events", params={"from": 0, "to": 2_000_000_000}).json() == []


def test_the_news_window_is_symmetric_and_includes_its_edges(calendar):
    event = _ts("15:30")
    assert news_service.window_refusal(event, 5) is not None
    assert news_service.window_refusal(event - 300, 5) is not None   # exactly 5 min before
    assert news_service.window_refusal(event + 300, 5) is not None   # exactly 5 min after
    assert news_service.window_refusal(event - 301, 5) is None
    assert news_service.window_refusal(event + 301, 5) is None
    assert news_service.window_refusal(event + 301, 6) is not None  # the window is configurable
    assert news_service.window_refusal(_ts("12:30"), 5) is None      # the medium-impact event does not count
    assert "FOMC Statement" in news_service.window_refusal(event, 5)


def _news_session(client, **rules):
    r = client.post("/api/bt-sessions", json={
        "assets": ["MNQ", "MES"], "base_timeframe": "5min", "starting_balance": 50000.0,
        "start_time": int(pd.Timestamp("2025-03-11 14:00:00", tz="UTC").timestamp()),
        "prop_ruleset": "custom",
        "prop_rules": {**CUSTOM_STATIC, "max_loss_locks_at_start": True, "no_news": True, **rules},
    })
    assert r.status_code == 200, r.text
    return r.json()


def test_no_news_trading_refuses_a_position_entered_inside_the_window(bt_client, calendar):
    s = _news_session(bt_client, news_window_minutes=5)
    assert s["account"]["prop_rules"]["news_window_minutes"] == 5
    inside = _save(bt_client, s, [_pos("MNQ", 1, _ts("15:27"))], cursor_offset=3 * 3600)
    assert inside.status_code == 400 and "FOMC Statement" in inside.json()["detail"]
    outside = _save(bt_client, s, [_pos("MNQ", 1, _ts("15:20"))], cursor_offset=3 * 3600)
    assert outside.status_code == 200, outside.text
    # A position already open is not re-judged when it merely survives into the window.
    survives = _save(bt_client, outside.json(), [_pos("MNQ", 1, _ts("15:20"))], cursor_offset=3 * 3600 + 600)
    assert survives.status_code == 200


def test_the_news_window_is_configurable_per_session(bt_client, calendar):
    wide = _news_session(bt_client, news_window_minutes=30)
    assert _save(bt_client, wide, [_pos("MES", 1, _ts("15:10"))], cursor_offset=3 * 3600).status_code == 400
    narrow = _news_session(bt_client, news_window_minutes=2)
    assert _save(bt_client, narrow, [_pos("MES", 1, _ts("15:10"))], cursor_offset=3 * 3600).status_code == 200


def test_without_the_restriction_news_does_not_block_entries(bt_client, calendar):
    s = _news_session(bt_client, no_news=False)
    assert _save(bt_client, s, [_pos("MNQ", 1, _ts("15:30"))], cursor_offset=3 * 3600).status_code == 200
