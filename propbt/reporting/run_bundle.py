"""Run bundle: write/read the structured backtest output the viz app reads
(VIZ_SPEC.md sections 3-5). The engine is the single source of truth --
this module only serializes numbers `run_backtest`/`pair_trades` already
computed (plus MAE/MFE, which is a pure read of the same price bars the
engine already used, and reporting-layer aggregation of already-computed
per-trade PnL/R). It never re-derives fills, PnL, or prop-rule decisions.

runs/<run_id>/
  meta.json      -- RunMeta (see below)
  trades.parquet -- one row per trade (VIZ_SPEC section 4)
  equity.parquet -- per-bar equity + prop-rule floors (VIZ_SPEC section 5)
  stats.json     -- aggregate + per-leg/session breakdowns, "all" scope
                     (the API computes is/oos scopes on demand by filtering
                     trades.parquet against meta.json's is_oos_split_date,
                     reusing compute_run_stats -- not re-derived per scope).
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional, Union

import pandas as pd

from propbt.config import PROJECT_ROOT, PropRulesConfig, SessionsConfig
from propbt.data.sessions import trading_day as trading_day_of
from propbt.engine.backtester import BacktestResult, EquityLogRow
from propbt.engine.events import FillType, Side
from propbt.engine.prop_rules import CombineResult
from propbt.reporting.metrics import Trade
from propbt.sim.walk_forward import count_free_parameters
from propbt.strategy.news_spike import NewsSpikeConfig
from propbt.strategy.session_open import SessionOpenRunConfig

DEFAULT_RUNS_DIR = PROJECT_ROOT / "runs"

# VIZ_SPEC section 4 lists exit_type as tp/sl/time/eod/daily_lock (illustrative
# categories); we don't have a genuine time-based exit, so that category is
# unused, but the rest map onto our actual FillType values 1:1.
_EXIT_TYPE_MAP = {
    FillType.TAKE_PROFIT.value: "tp",
    FillType.STOP_LOSS.value: "sl",
    FillType.DAILY_LOCK_FLATTEN.value: "daily_lock",
    FillType.MLL_BREACH_FLATTEN.value: "eod",
}

TRADE_COLUMNS = [
    "trade_id", "entry_time", "exit_time", "instrument", "side", "leg", "session",
    "trading_day", "size_contracts", "entry_price", "exit_price", "sl_price", "tp_price",
    "sl_points", "tp_points", "rr_planned", "exit_type", "pnl_usd", "r_multiple",
    "commission_usd", "mae_points", "mfe_points", "mae_r", "mfe_r", "bars_held",
]

EQUITY_COLUMNS = [
    "time", "balance", "open_pnl", "equity", "mll_floor", "daily_loss_floor",
    "target_level", "trading_day", "day_start_balance", "breached", "daily_locked",
]


def hash_config_file(path: Union[str, Path]) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def generate_run_id(config_hash: str, created_at: Optional[dt.datetime] = None) -> str:
    created_at = created_at or dt.datetime.now(dt.timezone.utc)
    return f"{created_at:%Y%m%dT%H%M%S}Z_{config_hash[:8]}"


def _mae_mfe(price_df: pd.DataFrame, trade: Trade):
    """Max adverse/favorable excursion in points, over the bars while the
    position was open (entry_time..exit_time inclusive) -- reads the SAME
    price bars the engine traded on, doesn't recompute anything strategic.
    """
    window = price_df.loc[trade.entry_ts:trade.exit_ts]
    if len(window) == 0:
        return 0.0, 0.0, None, None, 0

    lo, hi = float(window["low"].min()), float(window["high"].max())
    if trade.side is Side.LONG:
        mae_points = max(0.0, trade.entry_price - lo)
        mfe_points = max(0.0, hi - trade.entry_price)
    else:
        mae_points = max(0.0, hi - trade.entry_price)
        mfe_points = max(0.0, trade.entry_price - lo)

    risk_points = abs(trade.entry_price - trade.sl_price) if trade.sl_price is not None else None
    mae_r = (mae_points / risk_points) if risk_points else None
    mfe_r = (mfe_points / risk_points) if risk_points else None
    return mae_points, mfe_points, mae_r, mfe_r, len(window)


def build_trades_frame(
    trades: List[Trade], price_df: pd.DataFrame, symbol: str, sessions_config: SessionsConfig
) -> pd.DataFrame:
    rows = []
    for i, t in enumerate(trades):
        mae_points, mfe_points, mae_r, mfe_r, bars_held = _mae_mfe(price_df, t)
        sl_points = abs(t.entry_price - t.sl_price) if t.sl_price is not None else None
        tp_points = abs(t.tp_price - t.entry_price) if t.tp_price is not None else None
        rr_planned = (tp_points / sl_points) if (sl_points and tp_points) else None

        # news_continuation/news_mean_reversion (our actual leg tags) collapse
        # to session="news" here -- a reporting-layer label, not a change to
        # how the engine tagged the trade (still available via `leg`).
        session = "news" if (t.leg or "").startswith("news") else t.session

        day = trading_day_of(t.entry_ts, sessions_config)
        rows.append({
            "trade_id": i,
            "entry_time": t.entry_ts,
            "exit_time": t.exit_ts,
            "instrument": symbol,
            "side": t.side.value,
            "leg": t.leg,
            "session": session,
            "trading_day": day.isoformat() if day else None,
            "size_contracts": t.contracts,
            "entry_price": t.entry_price,
            "exit_price": t.exit_price,
            "sl_price": t.sl_price,
            "tp_price": t.tp_price,
            "sl_points": sl_points,
            "tp_points": tp_points,
            "rr_planned": rr_planned,
            "exit_type": _EXIT_TYPE_MAP.get(t.exit_type.value, t.exit_type.value),
            "pnl_usd": t.realized_pnl,
            "r_multiple": t.r_multiple,
            "commission_usd": t.commission,
            "mae_points": mae_points,
            "mfe_points": mfe_points,
            "mae_r": mae_r,
            "mfe_r": mfe_r,
            "bars_held": bars_held,
        })
    df = pd.DataFrame(rows, columns=TRADE_COLUMNS)
    if len(df):
        df["entry_time"] = pd.to_datetime(df["entry_time"], utc=True)
        df["exit_time"] = pd.to_datetime(df["exit_time"], utc=True)
    return df


def build_equity_frame(equity_log: List[EquityLogRow], prop_rules_config: PropRulesConfig) -> pd.DataFrame:
    target_level = prop_rules_config.start_balance + prop_rules_config.profit_target
    rows = []
    for row in equity_log:
        rows.append({
            "time": row.ts,
            "balance": row.balance,
            "open_pnl": row.equity - row.balance,
            "equity": row.equity,
            "mll_floor": row.mll_floor,
            "daily_loss_floor": row.day_start_balance - prop_rules_config.daily_loss_limit,
            "target_level": target_level,
            "trading_day": row.trading_day.isoformat() if row.trading_day else None,
            "day_start_balance": row.day_start_balance,
            "breached": row.breached,
            "daily_locked": row.daily_locked,
        })
    df = pd.DataFrame(rows, columns=EQUITY_COLUMNS)
    if len(df):
        df["time"] = pd.to_datetime(df["time"], utc=True)
    return df


def _kpis(df: pd.DataFrame) -> dict:
    n = len(df)
    if n == 0:
        return {
            "trades": 0, "net_pnl_usd": 0.0, "net_r": None, "win_rate": None,
            "expectancy_usd": None, "expectancy_r": None, "profit_factor": None, "max_drawdown_usd": 0.0,
        }
    wins = df.loc[df["pnl_usd"] > 0, "pnl_usd"].sum()
    losses = df.loc[df["pnl_usd"] < 0, "pnl_usd"].sum()
    cum = df.sort_values("exit_time")["pnl_usd"].cumsum()
    drawdown = float((cum - cum.cummax()).min())
    r_vals = df["r_multiple"].dropna()
    return {
        "trades": n,
        "net_pnl_usd": float(df["pnl_usd"].sum()),
        "net_r": float(r_vals.sum()) if len(r_vals) else None,
        "win_rate": float((df["pnl_usd"] > 0).mean()),
        "expectancy_usd": float(df["pnl_usd"].mean()),
        "expectancy_r": float(r_vals.mean()) if len(r_vals) else None,
        "profit_factor": float(wins / abs(losses)) if losses < 0 else None,
        "max_drawdown_usd": drawdown if pd.notna(drawdown) else 0.0,
    }


def compute_run_stats(trades_df: pd.DataFrame, combine: Optional[CombineResult] = None) -> dict:
    """Aggregate KPIs + per-leg/per-session breakdowns from an already-built
    trades frame. Pure aggregation (mean/sum/count) of per-trade pnl_usd/
    r_multiple the engine already computed -- not a re-derivation.
    """
    overall = _kpis(trades_df)
    by_leg = {str(k): _kpis(g) for k, g in trades_df.groupby("leg")} if len(trades_df) else {}
    by_session = {str(k): _kpis(g) for k, g in trades_df.groupby("session")} if len(trades_df) else {}

    out = {"overall": overall, "by_leg": by_leg, "by_session": by_session}
    if combine is not None:
        out["result"] = {
            "status": combine.status, "fail_reason": combine.fail_reason,
            "target_hit": combine.target_hit, "consistency_passed": combine.consistency_passed,
            "final_balance": combine.final_balance, "trading_days": len(combine.day_logs),
        }
    return out


@dataclass(frozen=True)
class RunResult:
    passed: bool
    fail_reason: Optional[str]
    days_to_fail: Optional[int]


@dataclass(frozen=True)
class RunMeta:
    run_id: str
    created_at: str
    config_name: str
    config_hash: str
    instrument: str
    base_timeframe: str
    date_from: str
    date_to: str
    is_oos_split_date: Optional[str]
    result: RunResult
    params_count: int

    def to_dict(self) -> dict:
        return {
            "run_id": self.run_id, "created_at": self.created_at, "config_name": self.config_name,
            "config_hash": self.config_hash, "instrument": self.instrument,
            "base_timeframe": self.base_timeframe, "date_from": self.date_from, "date_to": self.date_to,
            "is_oos_split_date": self.is_oos_split_date,
            "result": {
                "passed": self.result.passed, "fail_reason": self.result.fail_reason,
                "days_to_fail": self.result.days_to_fail,
            },
            "params_count": self.params_count,
        }


def write_run_bundle(
    result: BacktestResult,
    trades: List[Trade],
    price_df: pd.DataFrame,
    symbol: str,
    sessions_config: SessionsConfig,
    prop_rules_config: PropRulesConfig,
    config_path: Union[str, Path],
    run_cfg: SessionOpenRunConfig,
    news_cfg: Optional[NewsSpikeConfig] = None,
    is_oos_split_date: Optional[str] = None,
    runs_dir: Union[str, Path] = DEFAULT_RUNS_DIR,
    config_name: Optional[str] = None,
) -> RunMeta:
    runs_dir = Path(runs_dir)
    config_path = Path(config_path)
    config_hash = hash_config_file(config_path)
    created_at = dt.datetime.now(dt.timezone.utc)
    run_id = generate_run_id(config_hash, created_at)

    run_dir = runs_dir / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    trades_df = build_trades_frame(trades, price_df, symbol, sessions_config)
    equity_df = build_equity_frame(result.equity_log, prop_rules_config)
    stats = compute_run_stats(trades_df, result.combine)

    trades_df.to_parquet(run_dir / "trades.parquet", index=False)
    equity_df.to_parquet(run_dir / "equity.parquet", index=False)
    (run_dir / "stats.json").write_text(json.dumps(stats, indent=2, default=str), encoding="utf-8")

    days_to_fail = len(result.combine.day_logs) if result.combine.status == "failed" else None
    meta = RunMeta(
        run_id=run_id,
        created_at=created_at.isoformat(),
        config_name=config_name or config_path.stem,
        config_hash=config_hash,
        instrument=symbol,
        base_timeframe="1m",
        date_from=run_cfg.start,
        date_to=run_cfg.end,
        is_oos_split_date=is_oos_split_date,
        result=RunResult(
            passed=(result.combine.status == "passed"),
            fail_reason=result.combine.fail_reason,
            days_to_fail=days_to_fail,
        ),
        params_count=count_free_parameters(run_cfg, news_cfg),
    )
    (run_dir / "meta.json").write_text(json.dumps(meta.to_dict(), indent=2), encoding="utf-8")
    return meta


# --------------------------------- reader ------------------------------------

def list_run_ids(runs_dir: Union[str, Path] = DEFAULT_RUNS_DIR) -> List[str]:
    runs_dir = Path(runs_dir)
    if not runs_dir.exists():
        return []
    return sorted(p.name for p in runs_dir.iterdir() if p.is_dir() and (p / "meta.json").exists())


def read_meta(run_id: str, runs_dir: Union[str, Path] = DEFAULT_RUNS_DIR) -> dict:
    path = Path(runs_dir) / run_id / "meta.json"
    return json.loads(path.read_text(encoding="utf-8"))


def read_trades(run_id: str, runs_dir: Union[str, Path] = DEFAULT_RUNS_DIR) -> pd.DataFrame:
    return pd.read_parquet(Path(runs_dir) / run_id / "trades.parquet")


def read_equity(run_id: str, runs_dir: Union[str, Path] = DEFAULT_RUNS_DIR) -> pd.DataFrame:
    return pd.read_parquet(Path(runs_dir) / run_id / "equity.parquet")


def read_stats(run_id: str, runs_dir: Union[str, Path] = DEFAULT_RUNS_DIR) -> dict:
    path = Path(runs_dir) / run_id / "stats.json"
    return json.loads(path.read_text(encoding="utf-8"))
