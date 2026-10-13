"""G10 engine reference: the cases, how each is run, and how its result is
serialized -- shared by the recorder (tests/fixtures/record_engine_golden_g10.py)
and the gate test (tests/test_engine_golden_g10.py).

The reference was recorded from the engine as it stood BEFORE `run_backtest`'s
bar loop was extracted into a reusable stepper (FXR_V2_SPEC.md section 8, G10a).
The extraction must reproduce it exactly: fills, rejections, paired trades,
the per-bar equity log, run-bundle files and the Combine verdict. Everything
here goes through public engine entry points only, so it runs unchanged on
both sides of the refactor.

Floats are compared exactly (JSON floats round-trip via repr; parquet stores
float64) -- no tolerance anywhere.
"""
from __future__ import annotations

import dataclasses
import datetime as dt
import functools
import hashlib
import json
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional

import pandas as pd

from propbt.config import (
    PROJECT_ROOT, PropRulesConfig, load_contracts, load_execution, load_prop_rules, load_sessions,
)
from propbt.data.loader import load_ohlcv
from propbt.data.sessions import tag_sessions
from propbt.engine.backtester import run_backtest
from propbt.reporting.metrics import pair_trades
from propbt.reporting.run_bundle import write_run_bundle
from propbt.sim.combine import run_combine_attempt
from propbt.strategy.combined import build_combined_strategy_factory
from propbt.strategy.news_spike import load_news_spike_config
from propbt.strategy.placeholder import RandomStrategy
from propbt.strategy.session_open import SessionOpenRunConfig, load_session_open_config

STRATEGY_YAML = PROJECT_ROOT / "propbt" / "config" / "strategy.yaml"
FIXTURE_DIR = Path(__file__).parent / "fixtures" / "engine_golden_g10"


@dataclass(frozen=True)
class Case:
    name: str
    symbol: str
    start: str                       # df.loc[start:end] window (bar-0 .. last bar), as run.py slices
    end: str
    strategy: str                    # "yaml_news" | "yaml" | "random"
    random: Optional[Dict[str, Any]] = None   # contracts, sl, tp, prob, seed
    prop: str = "topstep"            # "topstep" (prop_rules.yaml) | "custom_intraday"
    bundle: bool = True              # also write + compare a run bundle (needs a daily loss limit)
    combine_attempt_from: Optional[str] = None  # run via sim.combine.run_combine_attempt (warm-up path)
    max_calendar_days: Optional[int] = None
    note: str = ""


CASES: List[Case] = [
    Case("mnq_real_news_2023_03", "MNQ", "2023-03-06", "2023-03-17", "yaml_news",
         note="real strategy.yaml legs incl. news; SL, TP, same-bar exits, position_already_open"),
    Case("mnq_real_news_2022_10", "MNQ", "2022-10-03", "2022-10-14", "yaml_news",
         note="second real window; most same-bar exits"),
    Case("mnq_news_2021_12", "MNQ", "2021-12-13", "2021-12-17", "yaml_news",
         note="a week with a real news_continuation trade (FOMC, take-profit)"),
    Case("mnq_news_2022_03", "MNQ", "2022-03-14", "2022-03-18", "yaml_news",
         note="a week with a real short news_continuation trade (FOMC, take-profit)"),
    Case("mes_real_2024_02", "MES", "2024-02-05", "2024-02-16", "yaml",
         note="MES, session-open legs only; many rejections"),
    Case("mnq_rnd_dlock_mll", "MNQ", "2023-03-06", "2023-03-10", "random",
         random=dict(contracts=5, sl=25.0, tp=25.0, prob=0.05, seed=2),
         note="daily-lock flatten then MLL-breach flatten (Combine failed)"),
    Case("mnq_rnd_dlock_incomplete", "MNQ", "2023-03-06", "2023-03-10", "random",
         random=dict(contracts=5, sl=25.0, tp=25.0, prob=0.05, seed=4),
         note="daily locks that reset across days, Combine never resolves"),
    Case("mes_rnd_pass", "MES", "2024-02-05", "2024-02-23", "random",
         random=dict(contracts=5, sl=6.0, tp=30.0, prob=0.05, seed=11),
         note="target hit and consistency ok: Combine passed, loop stops on newly_passed"),
    Case("mes_rnd_consistency_held", "MES", "2024-02-05", "2024-02-23", "random",
         random=dict(contracts=5, sl=8.0, tp=40.0, prob=0.03, seed=10),
         note="target hit but consistency not met: stays incomplete"),
    Case("mes_rnd_position_limit", "MES", "2024-02-05", "2024-02-07", "random",
         random=dict(contracts=6, sl=6.0, tp=12.0, prob=0.05, seed=1),
         note="every entry over the 5-contract cap: position_limit rejections, no fills"),
    Case("mes_rnd_custom_intraday", "MES", "2024-02-05", "2024-02-09", "random",
         random=dict(contracts=2, sl=4.0, tp=12.0, prob=0.08, seed=3), prop="custom_intraday", bundle=False,
         note="intraday-trailing MLL, no daily limit, no consistency, no freeze"),
    Case("mnq_combine_attempt_2023_03", "MNQ", "2023-03-07", "2023-03-07", "yaml_news",
         combine_attempt_from="2023-03-07", max_calendar_days=10, bundle=False,
         note="sim.combine.run_combine_attempt: warm-up days + trading_start_ts"),
]
CASES_BY_NAME = {c.name: c for c in CASES}


@functools.lru_cache(maxsize=None)
def _ohlcv(symbol: str) -> pd.DataFrame:
    return load_ohlcv(symbol)


def data_available(symbol: str) -> bool:
    from propbt.config import load_data_paths

    p = load_data_paths().get(symbol)
    return p is not None and p.exists()


def _prop_config(case: Case) -> PropRulesConfig:
    base = load_prop_rules()
    if case.prop == "topstep":
        return base
    if case.prop == "custom_intraday":
        return PropRulesConfig(
            start_balance=50000.0, profit_target=2500.0, mll_initial_offset=1500.0,
            mll_freeze_trigger_balance=None, mll_freeze_floor=None, daily_loss_limit=None,
            consistency_max_pct=None, max_open_contracts=4, commissions=dict(base.commissions),
            mll_type="intraday_trailing",
        )
    raise ValueError(case.prop)


def _iso(ts: Optional[pd.Timestamp]) -> Optional[str]:
    return None if ts is None else ts.isoformat()


def _f(x: Optional[float]) -> Optional[float]:
    return None if x is None else float(x)


def _fill(f) -> dict:
    return {
        "ts": _iso(f.ts), "symbol": f.symbol, "side": f.side.value, "contracts": int(f.contracts),
        "price": _f(f.price), "fill_type": f.fill_type.value, "commission": _f(f.commission),
        "realized_pnl": _f(f.realized_pnl), "order_ts": _iso(f.order_ts), "reason": f.reason,
        "sl_price": _f(f.sl_price), "tp_price": _f(f.tp_price),
    }


def _trade(t) -> dict:
    return {
        "symbol": t.symbol, "side": t.side.value, "contracts": int(t.contracts),
        "entry_ts": _iso(t.entry_ts), "entry_price": _f(t.entry_price),
        "exit_ts": _iso(t.exit_ts), "exit_price": _f(t.exit_price), "exit_type": t.exit_type.value,
        "commission": _f(t.commission), "realized_pnl": _f(t.realized_pnl),
        "session": t.session, "leg": t.leg, "risk_dollars": _f(t.risk_dollars),
        "sl_price": _f(t.sl_price), "tp_price": _f(t.tp_price),
    }


def _combine(c) -> dict:
    return {
        "status": c.status, "fail_reason": c.fail_reason, "fail_ts": _iso(c.fail_ts),
        "pass_ts": _iso(c.pass_ts), "target_hit": bool(c.target_hit),
        "target_hit_ts": _iso(c.target_hit_ts),
        "consistency_passed": None if c.consistency_passed is None else bool(c.consistency_passed),
        "final_balance": _f(c.final_balance),
        "day_logs": [
            {
                "trading_day": d.trading_day.isoformat(), "start_balance": _f(d.start_balance),
                "end_balance": _f(d.end_balance), "daily_pnl": _f(d.daily_pnl),
                "daily_loss_locked": bool(d.daily_loss_locked), "mll_floor_after": _f(d.mll_floor_after),
                "mll_frozen_after": bool(d.mll_frozen_after),
            }
            for d in c.day_logs
        ],
    }


def _curve_digest(curve) -> str:
    h = hashlib.sha256()
    for ts, eq in curve:
        h.update(f"{ts.isoformat()}|{float(eq).hex()}\n".encode())
    return h.hexdigest()


def _equity_log_frame(log) -> pd.DataFrame:
    cols = ["ts", "balance", "equity", "mll_floor", "trading_day", "day_start_balance", "breached", "daily_locked"]
    df = pd.DataFrame(
        [
            {
                "ts": r.ts, "balance": r.balance, "equity": r.equity, "mll_floor": r.mll_floor,
                "trading_day": r.trading_day.isoformat() if r.trading_day else None,
                "day_start_balance": r.day_start_balance, "breached": r.breached, "daily_locked": r.daily_locked,
            }
            for r in log
        ],
        columns=cols,
    )
    if len(df):
        df["ts"] = pd.to_datetime(df["ts"], utc=True)
    return df


def _strategy_factory(case: Case, run_cfg: SessionOpenRunConfig, news_cfg, sessions_cfg):
    if case.strategy == "random":
        r = case.random
        return lambda: RandomStrategy(
            contracts=r["contracts"], sl_points=r["sl"], tp_points=r["tp"],
            trade_prob=r["prob"], seed=r["seed"],
        )
    return build_combined_strategy_factory(
        run_cfg, sessions_cfg, news_cfg if case.strategy == "yaml_news" else None,
        news_start=case.start, news_end=case.end,
    )


def run_case(case: Case) -> Dict[str, Any]:
    """Run one case through the CURRENT engine. Returns
    {"summary": json-able dict, "trades": DataFrame|None, "equity": DataFrame, "stats": dict|None,
     "meta": dict|None}. Bundle cases go through the real `write_run_bundle` into a temp dir and
    are read back, so the comparison is on exactly the files the viz app reads."""
    contracts, sessions_cfg, exec_cfg = load_contracts(), load_sessions(), load_execution()
    prop_cfg = _prop_config(case)
    yaml_cfg = load_session_open_config(str(STRATEGY_YAML))
    news_cfg = load_news_spike_config(str(STRATEGY_YAML))
    run_cfg = (
        SessionOpenRunConfig(case.symbol, case.start, case.end, None, None)
        if case.strategy == "random"
        else dataclasses.replace(yaml_cfg, symbol=case.symbol, start=case.start, end=case.end)
    )
    factory = _strategy_factory(case, run_cfg, news_cfg, sessions_cfg)
    full = _ohlcv(case.symbol)

    if case.combine_attempt_from is not None:
        attempt = run_combine_attempt(
            full, case.symbol, factory, contracts, prop_cfg, sessions_cfg,
            start_date=dt.date.fromisoformat(case.combine_attempt_from),
            slippage_ticks=exec_cfg.slippage_ticks, max_calendar_days=case.max_calendar_days,
        )
        fills, rejections, combine, curve = attempt.fills, attempt.rejections, attempt.combine, attempt.equity_curve
        sliced, result = None, None
        extra = {"n_trading_days": int(attempt.n_trading_days)}
        equity_frame = pd.DataFrame(
            {"ts": pd.to_datetime([t for t, _ in curve], utc=True), "equity": [float(e) for _, e in curve]}
        )
    else:
        sliced = full.loc[case.start:case.end]
        result = run_backtest(
            sliced, symbol=case.symbol, strategy=factory(), contracts=contracts,
            prop_rules_config=prop_cfg, sessions_config=sessions_cfg, slippage_ticks=exec_cfg.slippage_ticks,
        )
        fills, rejections, combine, curve = result.fills, result.rejections, result.combine, result.equity_curve
        extra = {}
        equity_frame = _equity_log_frame(result.equity_log)

    trades = None
    if result is not None:
        spec = contracts[case.symbol]
        risk_by_leg: Dict[Optional[str], float] = {}
        if case.strategy != "random":
            if run_cfg.continuation is not None:
                risk_by_leg["continuation"] = run_cfg.continuation.sl_points * spec.point_value * run_cfg.continuation.contracts
            if run_cfg.mean_reversion is not None:
                risk_by_leg["mean_reversion"] = run_cfg.mean_reversion.sl_points * spec.point_value * run_cfg.mean_reversion.contracts
            if case.strategy == "yaml_news" and news_cfg is not None:
                for leg, c in (("news_continuation", news_cfg.continuation), ("news_mean_reversion", news_cfg.mean_reversion)):
                    if c is not None:
                        risk_by_leg[leg] = c.sl_points * spec.point_value * c.contracts
        session_by_ts = tag_sessions(sliced, sessions_cfg)["session"]
        trades = pair_trades(result.fills, session_by_ts, risk_by_leg)

    summary: Dict[str, Any] = {
        "case": dataclasses.asdict(case),
        "fills": [_fill(f) for f in fills],
        "rejections": [
            {"ts": _iso(r.ts), "symbol": r.symbol, "order_ts": _iso(r.order_ts), "reason": r.reason}
            for r in rejections
        ],
        "combine": _combine(combine),
        "equity_curve_n": len(curve),
        "equity_curve_sha256": _curve_digest(curve),
        **extra,
    }
    if trades is not None:
        summary["trades"] = [_trade(t) for t in trades]

    out: Dict[str, Any] = {"summary": summary, "trades": None, "equity": equity_frame, "stats": None, "meta": None}
    if case.bundle and result is not None:
        with tempfile.TemporaryDirectory(prefix="engine_golden_") as tmp:
            meta = write_run_bundle(
                result, trades, sliced, case.symbol, sessions_cfg, prop_cfg,
                config_path=str(STRATEGY_YAML), run_cfg=run_cfg,
                news_cfg=news_cfg if case.strategy == "yaml_news" else None,
                is_oos_split_date="2024-10-14", runs_dir=tmp, config_name="engine_golden",
            )
            d = Path(tmp) / meta.run_id
            out["trades"] = pd.read_parquet(d / "trades.parquet")
            out["equity"] = pd.read_parquet(d / "equity.parquet")
            out["stats"] = json.loads((d / "stats.json").read_text(encoding="utf-8"))
            m = json.loads((d / "meta.json").read_text(encoding="utf-8"))
            for volatile in ("run_id", "created_at"):
                m.pop(volatile)
            out["meta"] = m
    return out


def _strict(o: Any):
    raise TypeError(f"{type(o).__name__} is not plain JSON: convert it in engine_golden (no default=str)")


def dumps(obj: Any) -> str:
    return json.dumps(obj, indent=1, sort_keys=True, default=_strict)
