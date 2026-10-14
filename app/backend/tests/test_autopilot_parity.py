"""FXR_V2_SPEC.md section 8 (G10a) -- the parity gate.

An Autopilot run over a window, driven through the real HTTP API (create a Topstep
50k session, switch the bot on, move the cursor), must equal the offline propbt
backtest of the same warm-up, trading start and end, EXACTLY: every trade's times,
side, size, entry/exit price, exit type, commission, net P&L, MAE/MFE and R, the
rejections, the open position, the final balance, the per-bar equity timeline and
the Combine verdict. `==` on floats; no tolerance anywhere.

Conventions that make this hold (and that the harness-sensitivity tests below
break on purpose, to show the comparison can fail): the bot is the real engine
(propbt.engine.stepper), decides on a bar's close, fills at the next bar's open
plus the engine's slippage, and is charged the session's commission -- which the
test pins to the Topstep config's before comparing.

Parity is claimed for UNINTERRUPTED runs only (switching the bot off and back on
rebuilds its strategy state; see test_autopilot.py).
"""
from __future__ import annotations

import dataclasses
import datetime as dt
import random
from functools import lru_cache
from typing import Dict, List, Optional, Tuple

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from app.backend.services import autopilot_service, bar_service, manual_analytics, prop_presets
from propbt.config import CONFIG_DIR, load_contracts, load_data_paths, load_execution, load_prop_rules, load_sessions
from propbt.data.loader import load_ohlcv
from propbt.data.sessions import session_anchor_utc, tag_sessions
from propbt.engine.backtester import run_backtest
from propbt.reporting import run_bundle as rb
from propbt.reporting.metrics import pair_trades
from propbt.sim.combine import DEFAULT_WARMUP_DAYS
from propbt.strategy.combined import build_combined_strategy_factory
from propbt.strategy.session_open import load_session_open_config

CONFIG_ID = "strategy_session_open"
SYMBOL = "MNQ"
SESS = load_sessions()


def _unix(ts: pd.Timestamp) -> int:
    return int(ts.value // 1_000_000_000)


@pytest.fixture(scope="module")
def mnq() -> pd.DataFrame:
    paths = load_data_paths()
    if SYMBOL not in paths or not paths[SYMBOL].exists():
        pytest.skip("MNQ data file not present")
    return load_ohlcv(SYMBOL)


@pytest.fixture()
def api(tmp_path, monkeypatch):
    monkeypatch.setenv("PROPBT_BT_SESSIONS_DIR", str(tmp_path / "bt_sessions"))
    monkeypatch.setenv("PROPBT_RUNS_DIR", str(tmp_path / "runs"))
    from app.backend.main import app

    return TestClient(app)


def reopen(day: str) -> pd.Timestamp:
    return session_anchor_utc(dt.date.fromisoformat(day), "globex_reopen", SESS)


# ---- the offline reference -------------------------------------------------------------

@dataclasses.dataclass
class Offline:
    result: object
    trades: list
    equity: pd.DataFrame
    open_entry: Optional[object]


def offline_run(
    frame: pd.DataFrame, start: pd.Timestamp, end: pd.Timestamp, *, slippage_ticks: Optional[int] = None,
    prop_cfg=None, config_id: str = CONFIG_ID, config_path: Optional[str] = None,
) -> Offline:
    """What `run_backtest` says for the window: the same warm-up the service uses, trading
    from the activation bar, ending at the last bar the replay revealed."""
    path = config_path or str(CONFIG_DIR / f"{config_id}.yaml")
    run_cfg = load_session_open_config(path)
    warm_from = max(frame.index[0], start - pd.Timedelta(days=DEFAULT_WARMUP_DAYS))
    df = frame.loc[warm_from:end]
    prop_cfg = prop_cfg or load_prop_rules()
    strategy = build_combined_strategy_factory(run_cfg, SESS, None)()
    res = run_backtest(
        df, symbol=SYMBOL, strategy=strategy, contracts=load_contracts(), prop_rules_config=prop_cfg,
        sessions_config=SESS,
        slippage_ticks=load_execution().slippage_ticks if slippage_ticks is None else slippage_ticks,
        trading_start_ts=start,
    )
    spec = load_contracts()[SYMBOL]
    risk = {}
    if run_cfg.continuation:
        risk["continuation"] = run_cfg.continuation.sl_points * spec.point_value * run_cfg.continuation.contracts
    if run_cfg.mean_reversion:
        risk["mean_reversion"] = run_cfg.mean_reversion.sl_points * spec.point_value * run_cfg.mean_reversion.contracts
    trades = pair_trades(res.fills, tag_sessions(df, SESS)["session"], risk)
    frame_trades = rb.build_trades_frame(trades, df, SYMBOL, SESS)
    entries = [f for f in res.fills if f.fill_type.value == "entry"]
    exits = [f for f in res.fills if f.fill_type.value != "entry"]
    open_entry = entries[-1] if len(entries) > len(exits) else None
    return Offline(res, list(zip(trades, frame_trades.to_dict("records"))), rb.build_equity_frame(res.equity_log, prop_cfg), open_entry)


# ---- driving the session through the API ---------------------------------------------------

def create_session(api, start: pd.Timestamp, end: pd.Timestamp, *, commission: float = 1.3, prop: bool = True) -> dict:
    body = {
        "instrument": SYMBOL, "base_timeframe": "1min", "start_time": _unix(start), "end_date": _unix(end),
        "starting_balance": 50000.0, "risk_per_trade_percent": 1.0, "quick_quantity": 1,
        "commission_per_contract": commission,
    }
    if prop:
        body["prop_ruleset"] = "topstep_50k"
    r = api.post("/api/bt-sessions", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def switch_on(api, sid: str, config_id: str = CONFIG_ID) -> dict:
    r = api.post(f"/api/bt-sessions/{sid}/autopilot", json={"enabled": True, "config_id": config_id})
    assert r.status_code == 200, r.text
    return r.json()


def move_cursor(api, sid: str, t: int) -> dict:
    r = api.patch(f"/api/bt-sessions/{sid}/cursor", json={"cursor_time": t})
    assert r.status_code == 200, r.text
    return r.json()


def cursor_plan(index: pd.DatetimeIndex, pattern: str, seed: int = 7) -> List[int]:
    """Cursor times (open of the last revealed bar) after the activation bar, ascending."""
    n = len(index)
    if pattern == "minute":
        picks = list(range(1, n))
    elif pattern == "5min":
        picks = list(range(5, n, 5))
    elif pattern == "hour":
        picks = list(range(60, n, 60))
    elif pattern == "jump":
        picks = []
    elif pattern == "random":
        rng, picks, i = random.Random(seed), [], 0
        while i < n - 1:
            i += rng.choice([1, 1, 2, 5, 17, 60, 211, 400])
            picks.append(min(i, n - 1))
    else:
        raise ValueError(pattern)
    if not picks or picks[-1] != n - 1:
        picks.append(n - 1)
    return [_unix(index[i]) for i in picks]


def drive(api, sid: str, window: pd.DatetimeIndex, pattern: str) -> dict:
    last = None
    for t in cursor_plan(window, pattern):
        last = move_cursor(api, sid, t)
    return last


# ---- the comparison --------------------------------------------------------------------------

TRADE_FIELDS = [
    ("entry_time", lambda t, r: _unix(t.entry_ts)),
    ("exit_time", lambda t, r: _unix(t.exit_ts)),
    ("side", lambda t, r: t.side.value),
    ("size_contracts", lambda t, r: t.contracts),
    ("entry_price", lambda t, r: t.entry_price),
    ("exit_price", lambda t, r: t.exit_price),
    ("exit_type", lambda t, r: t.exit_type.value),
    ("commission_usd", lambda t, r: t.commission),
    ("pnl_usd", lambda t, r: t.realized_pnl),
    ("leg", lambda t, r: t.leg),
    ("sl_price", lambda t, r: t.sl_price),
    ("tp_price", lambda t, r: t.tp_price),
    ("entry_sl_price", lambda t, r: t.sl_price),
    ("entry_tp_price", lambda t, r: t.tp_price),
    ("session", lambda t, r: r["session"]),
    ("trading_day", lambda t, r: r["trading_day"]),
    ("sl_points", lambda t, r: _none(r["sl_points"])),
    ("tp_points", lambda t, r: _none(r["tp_points"])),
    ("r_multiple", lambda t, r: _none(r["r_multiple"])),
    ("mae_points", lambda t, r: r["mae_points"]),
    ("mfe_points", lambda t, r: r["mfe_points"]),
    ("bars_held", lambda t, r: r["bars_held"]),
]


def _none(v):
    return None if v is None or (isinstance(v, float) and v != v) else v


def compare_trades(api, sid: str, ref: Offline) -> None:
    got = api.get(f"/api/bt-sessions/{sid}/trades").json()
    assert len(got) == len(ref.trades), f"{len(got)} bot trades vs {len(ref.trades)} offline"
    for i, (g, (t, row)) in enumerate(zip(got, ref.trades)):
        assert g["source"] == "bot", f"trade {i} is not source=bot"
        for name, expect in TRADE_FIELDS:
            assert g[name] == expect(t, row), f"trade {i} {name}: {g[name]!r} != {expect(t, row)!r}"
        assert len(g["exits"]) == 1 and g["exits"][0]["pnl_usd"] == t.realized_pnl


def compare_account(api, sid: str, ref: Offline) -> None:
    s = api.get(f"/api/bt-sessions/{sid}").json()
    ap = s["autopilot"]
    combine = ref.result.combine
    assert s["account"]["balance"] == combine.final_balance
    assert ap["bot_balance"] == combine.final_balance
    assert ap["rejections"] == len(ref.result.rejections)
    assert ap["trades"] == len(ref.trades)
    if ref.open_entry is None:
        assert ap["position"] is None
    else:
        p, e = ap["position"], ref.open_entry
        assert (p["side"], p["contracts"], p["entry_price"], p["entry_time"], p["sl_price"], p["tp_price"]) == (
            e.side.value, e.contracts, e.price, _unix(e.ts), e.sl_price, e.tp_price)
    # the verdict, through the same endpoint the app reads
    stats = api.get(f"/api/runs/bt:{sid}/stats").json()["result"]
    assert (stats["status"], stats["fail_reason"], stats["target_hit"], stats["consistency_passed"]) == (
        combine.status, combine.fail_reason, combine.target_hit, combine.consistency_passed)
    assert stats["final_balance"] == combine.final_balance
    assert stats["trading_days"] == len(combine.day_logs)


def compare_equity(sid: str, ref: Offline) -> None:
    got = manual_analytics.build_equity_frame(f"bt:{sid}")
    want = ref.equity.drop_duplicates("time", keep="last").reset_index(drop=True)
    pd.testing.assert_frame_equal(got.reset_index(drop=True), want, check_exact=True)


def run_and_compare(api, mnq, start: pd.Timestamp, end: pd.Timestamp, pattern: str) -> Tuple[str, Offline]:
    window = mnq.loc[start:end].index
    sess = create_session(api, start, window[-1])
    sid = sess["id"]
    switch_on(api, sid)
    drive(api, sid, window, pattern)
    ref = offline_run(mnq, window[0], window[-1])
    compare_trades(api, sid, ref)
    compare_account(api, sid, ref)
    compare_equity(sid, ref)
    return sid, ref


# ---- tests ---------------------------------------------------------------------------------------

def test_the_session_is_priced_exactly_like_the_offline_config(api, mnq):
    """The preconditions parity rests on, asserted rather than assumed."""
    start = reopen("2023-03-07")
    sess = create_session(api, start, start + pd.Timedelta(hours=1))
    cfg = autopilot_service.engine_config({"account": sess["account"]})
    offline = load_prop_rules()
    assert dataclasses.replace(cfg, commissions={}) == dataclasses.replace(offline, commissions={})
    assert cfg.commissions[SYMBOL] == offline.commissions[SYMBOL]
    assert sess["account"]["prop_rules"] is not None and sess["account"]["prop_ruleset"] == prop_presets.TOPSTEP_50K
    assert switch_on(api, sess["id"])["autopilot"]["slippage_ticks"] == load_execution().slippage_ticks


def test_ten_hours_stepped_a_minute_at_a_time(api, mnq):
    """The most adversarial stepping: one bar per save, across the Asia and London opens."""
    start = reopen("2023-03-07")
    _, ref = run_and_compare(api, mnq, start, start + pd.Timedelta(hours=10), "minute")
    assert {t.leg for t, _ in ref.trades} >= {"continuation"}
    assert len(ref.trades) >= 2


def test_three_days_in_five_minute_steps(api, mnq):
    start = reopen("2023-03-06")
    _, ref = run_and_compare(api, mnq, start, reopen("2023-03-09"), "5min")
    assert len(ref.trades) >= 8


@pytest.mark.parametrize("pattern", ["hour", "random", "jump"])
def test_two_weeks_under_every_stepping_pattern(api, mnq, pattern):
    start = reopen("2023-03-06")
    _, ref = run_and_compare(api, mnq, start, reopen("2023-03-17"), pattern)
    kinds = {t.exit_type.value for t, _ in ref.trades}
    assert {"stop_loss", "take_profit"} <= kinds
    assert len(ref.trades) >= 30
    assert len(ref.result.rejections) >= 1     # position_already_open: a decision met an open position
    assert any(
        (a.fill_type.value == "entry" and b.ts == a.ts and b.fill_type.value != "entry")
        for a, b in zip(ref.result.fills, ref.result.fills[1:])
    ), "the window should include a same-bar entry+exit"


def test_the_engine_is_deciding_on_closes_and_filling_at_the_next_open(api, mnq):
    start = reopen("2023-03-07")
    sid, ref = run_and_compare(api, mnq, start, start + pd.Timedelta(hours=8), "5min")
    frame = mnq
    for fill in [f for f in ref.result.fills if f.fill_type.value == "entry"]:
        decided = frame.index.get_loc(fill.order_ts)
        nxt = frame.index[decided + 1]
        assert fill.ts == nxt
        slip = load_execution().slippage_ticks * load_contracts()[SYMBOL].tick_size * fill.side.sign
        assert fill.price == float(frame["open"].iloc[decided + 1]) + slip
        assert fill.price != float(frame["close"].iloc[decided])


def test_the_bot_never_holds_a_bar_past_the_cursor(api, mnq):
    start = reopen("2023-03-07")
    window = mnq.loc[start:start + pd.Timedelta(hours=6)].index
    sess = create_session(api, start, window[-1])
    sid = sess["id"]
    switch_on(api, sid)
    for t in cursor_plan(window, "hour"):
        move_cursor(api, sid, t)
        live = autopilot_service._LIVE[autopilot_service._key(sid)]
        assert live.stepper.last_held_ts <= pd.Timestamp(t, unit="s", tz="UTC")
        assert live.stepper.frame.index.max() <= pd.Timestamp(t, unit="s", tz="UTC")


# ---- the comparison itself must be able to fail ------------------------------------------------------

def _first_mismatch(api, mnq, start, end, **offline_kw) -> Optional[str]:
    window = mnq.loc[start:end].index
    sid = create_session(api, start, window[-1])["id"]
    switch_on(api, sid)
    drive(api, sid, window, "hour")
    ref = offline_run(mnq, window[0], window[-1], **offline_kw)
    try:
        compare_trades(api, sid, ref)
        compare_account(api, sid, ref)
        compare_equity(sid, ref)
    except AssertionError as e:
        return str(e)
    return None


def test_harness_catches_a_different_slippage(api, mnq):
    start = reopen("2023-03-07")
    assert _first_mismatch(api, mnq, start, start + pd.Timedelta(hours=8), slippage_ticks=0) is not None


def test_harness_catches_a_different_commission(api, mnq):
    start = reopen("2023-03-07")
    cfg = load_prop_rules()
    cfg = dataclasses.replace(cfg, commissions={**cfg.commissions, SYMBOL: 2.1})
    assert _first_mismatch(api, mnq, start, start + pd.Timedelta(hours=8), prop_cfg=cfg) is not None


def test_harness_catches_a_cursor_close_fill(api, mnq, monkeypatch):
    """If the bot filled at the DECISION bar's close (the manual broker's convention) instead of
    the next bar's open, the same comparison must fail. Plant exactly that in the engine's broker."""
    from propbt.engine import broker as broker_mod
    from propbt.engine.events import OrderType

    orig_process, orig_fill = broker_mod.Broker.process_bar, broker_mod.Broker._try_fill_entry

    def process_bar(self, bar):
        self._decision_close = getattr(self, "_last_close", None)   # the previous bar's close
        out = orig_process(self, bar)
        self._last_close = bar.close
        return out

    def try_fill_entry(self, bar, order):
        if order.order_type is OrderType.MARKET and getattr(self, "_decision_close", None) is not None:
            bar = dataclasses.replace(bar, open=self._decision_close)
        return orig_fill(self, bar, order)

    monkeypatch.setattr(broker_mod.Broker, "process_bar", process_bar)
    monkeypatch.setattr(broker_mod.Broker, "_try_fill_entry", try_fill_entry)
    start = reopen("2023-03-07")
    window = mnq.loc[start:start + pd.Timedelta(hours=8)].index
    sid = create_session(api, start, window[-1])["id"]
    switch_on(api, sid)
    drive(api, sid, window, "hour")
    monkeypatch.undo()                               # the offline reference is the real engine
    ref = offline_run(mnq, window[0], window[-1])
    assert ref.trades, "the window must contain trades for the comparison to mean anything"
    with pytest.raises(AssertionError):
        compare_trades(api, sid, ref)
