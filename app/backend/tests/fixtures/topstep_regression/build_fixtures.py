"""Builds the Topstep-regression fixtures (G6): copies of real v1 Topstep
sessions plus synthetic ones that exercise every rule outcome (pass, a target
held back by the consistency rule, an MLL breach from a trade's MAE, a daily
loss lock + MLL freeze, partial exits across two trading days).

The golden verdicts in golden.json were recorded ONCE, from the engine as it
stood BEFORE the G6 rule builder (PropRulesTracker fed straight from
prop_rules.yaml). test_prop_presets.py replays these sessions through the
current code (sessions migrated onto the "Topstep 50k" preset) and demands
identical verdicts. Run with the old code only to re-record: it is not part of
the test run.
"""
from __future__ import annotations

import copy
import json
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).parent
SESSIONS = HERE / "sessions"
REAL = Path(sys.argv[1]) if len(sys.argv) > 1 else None   # the user's bt_sessions dir

MON = 1699281000  # Mon 2023-11-06 09:30 ET (14:30Z)
DAY = 86400


def day_ts(n: int, minute: int = 0) -> int:
    """n-th trading day from Mon 2023-11-06 (weekends skipped), at 09:30 ET + minute."""
    weeks, d = divmod(n, 5)
    return MON + (weeks * 7 + d) * DAY + minute * 60


def trade(i, day, pnl, mae=0.0, size=1, minute=0, hold=10, exits=None):
    t = {
        "trade_id": i, "entry_time": day_ts(day, minute), "exit_time": day_ts(day, minute + hold),
        "instrument": "MES", "side": "long", "leg": None, "session": None, "trading_day": None,
        "size_contracts": size, "entry_price": 4400.0, "exit_price": 4400.0 + pnl / 5 / size,
        "sl_price": None, "tp_price": None, "sl_points": None, "tp_points": None, "rr_planned": None,
        "exit_type": "manual", "pnl_usd": pnl, "r_multiple": None, "commission_usd": 0.0,
        "mae_points": mae, "mfe_points": max(pnl / 5 / size, 0.0), "mae_r": None, "mfe_r": None,
        "bars_held": hold, "source": "manual", "session_trade_id": None,
        "tags": [], "setup_name": None, "grade": None, "notes": "", "screenshots": [],
    }
    if exits:
        t["exits"] = exits
        t["trade_key"] = f"k{i}"
    return t


SYNTHETIC = {
    "pass_clean": [trade(i + 1, i, 700.0) for i in range(5)],
    "consistency_dilutes": [trade(1, 0, 2800.0), trade(2, 1, 300.0)] + [trade(3 + i, 2 + i, 300.0) for i in range(4)] + [trade(7, 6, 1500.0)],
    "mll_breach_mae": [trade(1, 0, 500.0), trade(2, 1, -100.0, mae=450.0)],
    "daily_lock_and_freeze": [trade(1, 0, 1100.0), trade(2, 1, 1000.0), trade(3, 2, -1100.0, mae=240.0), trade(4, 3, 50.0)],
    "partial_exits_two_days": [
        trade(1, 0, 900.0, size=2, exits=[
            {"time": day_ts(0, 20), "price": 4490.0, "contracts": 1, "pnl_usd": 450.0, "commission_usd": 0.0, "exit_type": "manual_close", "risk_usd": None, "mae_points": 5.0},
            {"time": day_ts(1, 20), "price": 4490.0, "contracts": 1, "pnl_usd": 450.0, "commission_usd": 0.0, "exit_type": "manual_close", "risk_usd": None, "mae_points": 12.0},
        ], hold=20),
        trade(2, 2, -700.0, mae=150.0),
    ],
}


def session_json(sid: str, trades: list) -> dict:
    pnl = sum(t["pnl_usd"] for t in trades)
    return {
        "id": sid, "instrument": "MES", "base_timeframe": "5min", "start_time": MON, "created_at": "2026-10-03T20:00:33+00:00",
        "updated_at": "2026-10-03T20:00:48+00:00", "cursor_time": MON, "status": "active",
        "account": {
            "id": "a" * 32, "starting_balance": 50000.0, "balance": 50000.0 + pnl, "currency": "USD",
            "risk_per_trade_percent": 1.0, "risk_per_trade_usd": None, "default_contracts": 1,
            "commission_per_contract": 1.3, "prop_ruleset": "topstep_50k", "max_contracts": 5,
        },
        "settings": {"random_start": False}, "position": None, "working_orders": [], "notes": None,
    }


def write(sid: str, session: dict, trades: list) -> None:
    d = SESSIONS / sid
    d.mkdir(parents=True, exist_ok=True)
    session = copy.deepcopy(session)
    session["id"] = sid
    for t in trades:
        t["session_id"] = sid
    (d / "session.json").write_text(json.dumps(session, indent=2), encoding="utf-8")
    (d / "trades.json").write_text(json.dumps(trades, indent=2), encoding="utf-8")


if __name__ == "__main__":
    if SESSIONS.exists():
        shutil.rmtree(SESSIONS)
    for name, trades in SYNTHETIC.items():
        write(f"synthetic_{name}", session_json(name, trades), trades)
    if REAL is not None:
        for p in sorted(REAL.glob("*/session.json")):
            s = json.loads(p.read_text(encoding="utf-8"))
            tp = p.parent / "trades.json"
            if s["account"].get("prop_ruleset") and tp.exists():
                write(f"real_{p.parent.name}", s, json.loads(tp.read_text(encoding="utf-8")))
