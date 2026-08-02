"""Reads run bundles (propbt.reporting.run_bundle) and converts them into
API response models. All financial numbers here already came out of the
engine (trades.parquet/equity.parquet/stats.json) -- this module does no
math beyond unit conversion (Timestamp -> unix seconds, NaN -> None) and
filtering by already-computed columns.
"""
from __future__ import annotations

from typing import List, Optional

import pandas as pd

from app.backend import models
from app.backend.config import get_runs_dir
from propbt.reporting import run_bundle as rb


class RunNotFound(Exception):
    def __init__(self, run_id: str):
        super().__init__(f"run {run_id!r} not found")
        self.run_id = run_id


def _opt_float(v) -> Optional[float]:
    return None if pd.isna(v) else float(v)


def _opt_str(v) -> Optional[str]:
    return None if pd.isna(v) else str(v)


def _unix(ts) -> int:
    return int(pd.Timestamp(ts).value // 1_000_000_000)


def list_runs() -> List[models.RunSummary]:
    runs_dir = get_runs_dir()
    summaries = []
    for run_id in rb.list_run_ids(runs_dir):
        try:
            meta = rb.read_meta(run_id, runs_dir)
        except (FileNotFoundError, ValueError):
            continue
        summaries.append(models.RunSummary.model_validate(meta))
    summaries.sort(key=lambda s: s.created_at, reverse=True)
    return summaries


def get_run_meta(run_id: str) -> models.RunMetaResponse:
    try:
        meta = rb.read_meta(run_id, get_runs_dir())
    except FileNotFoundError:
        raise RunNotFound(run_id)
    return models.RunMetaResponse.model_validate(meta)


def _trade_row(row: pd.Series) -> models.TradeRecord:
    return models.TradeRecord(
        trade_id=int(row["trade_id"]),
        entry_time=_unix(row["entry_time"]),
        exit_time=_unix(row["exit_time"]),
        instrument=row["instrument"],
        side=row["side"],
        leg=_opt_str(row["leg"]),
        session=_opt_str(row["session"]),
        trading_day=_opt_str(row["trading_day"]),
        size_contracts=int(row["size_contracts"]),
        entry_price=float(row["entry_price"]),
        exit_price=float(row["exit_price"]),
        sl_price=_opt_float(row["sl_price"]),
        tp_price=_opt_float(row["tp_price"]),
        sl_points=_opt_float(row["sl_points"]),
        tp_points=_opt_float(row["tp_points"]),
        rr_planned=_opt_float(row["rr_planned"]),
        exit_type=row["exit_type"],
        pnl_usd=float(row["pnl_usd"]),
        r_multiple=_opt_float(row["r_multiple"]),
        commission_usd=float(row["commission_usd"]),
        mae_points=float(row["mae_points"]),
        mfe_points=float(row["mfe_points"]),
        mae_r=_opt_float(row["mae_r"]),
        mfe_r=_opt_float(row["mfe_r"]),
        bars_held=int(row["bars_held"]),
    )


def list_trades(
    run_id: str,
    leg: Optional[str] = None,
    session: Optional[str] = None,
    side: Optional[str] = None,
    result: Optional[str] = None,
    ts_from: Optional[int] = None,
    ts_to: Optional[int] = None,
) -> List[models.TradeRecord]:
    try:
        df = rb.read_trades(run_id, get_runs_dir())
    except FileNotFoundError:
        raise RunNotFound(run_id)

    if leg:
        df = df[df["leg"] == leg]
    if session:
        df = df[df["session"] == session]
    if side:
        df = df[df["side"] == side]
    if result == "win":
        df = df[df["pnl_usd"] > 0]
    elif result == "loss":
        df = df[df["pnl_usd"] <= 0]
    if ts_from is not None:
        df = df[df["entry_time"] >= pd.Timestamp(ts_from, unit="s", tz="UTC")]
    if ts_to is not None:
        df = df[df["entry_time"] <= pd.Timestamp(ts_to, unit="s", tz="UTC")]

    return [_trade_row(row) for _, row in df.iterrows()]


def _equity_row(row: pd.Series) -> models.EquityPoint:
    return models.EquityPoint(
        time=_unix(row["time"]),
        balance=float(row["balance"]),
        open_pnl=float(row["open_pnl"]),
        equity=float(row["equity"]),
        mll_floor=float(row["mll_floor"]),
        daily_loss_floor=float(row["daily_loss_floor"]),
        target_level=float(row["target_level"]),
        trading_day=_opt_str(row["trading_day"]),
        day_start_balance=float(row["day_start_balance"]),
        breached=bool(row["breached"]),
        daily_locked=bool(row["daily_locked"]),
    )


def list_equity(run_id: str, ts_from: Optional[int] = None, ts_to: Optional[int] = None) -> List[models.EquityPoint]:
    try:
        df = rb.read_equity(run_id, get_runs_dir())
    except FileNotFoundError:
        raise RunNotFound(run_id)

    if ts_from is not None:
        df = df[df["time"] >= pd.Timestamp(ts_from, unit="s", tz="UTC")]
    if ts_to is not None:
        df = df[df["time"] <= pd.Timestamp(ts_to, unit="s", tz="UTC")]

    return [_equity_row(row) for _, row in df.iterrows()]


def _group_stats(d: dict) -> models.GroupStats:
    return models.GroupStats(**d)


def get_stats(run_id: str, scope: str = "all") -> models.StatsResponse:
    if scope not in ("all", "is", "oos"):
        raise ValueError(f"scope must be one of all/is/oos, got {scope!r}")

    runs_dir = get_runs_dir()
    try:
        meta = rb.read_meta(run_id, runs_dir)
        trades_df = rb.read_trades(run_id, runs_dir)
        base_stats = rb.read_stats(run_id, runs_dir)
    except FileNotFoundError:
        raise RunNotFound(run_id)

    split_str = meta.get("is_oos_split_date")
    if scope in ("is", "oos") and split_str:
        split = pd.Timestamp(split_str, tz="UTC")
        trades_df = trades_df[trades_df["entry_time"] < split] if scope == "is" else trades_df[trades_df["entry_time"] >= split]

    stats = rb.compute_run_stats(trades_df)  # scope-filtered overall/by_leg/by_session, no "result"
    result = base_stats.get("result")  # pass/fail is a property of the whole run, not the scope

    return models.StatsResponse(
        scope=scope,
        overall=_group_stats(stats["overall"]),
        by_leg={k: _group_stats(v) for k, v in stats["by_leg"].items()},
        by_session={k: _group_stats(v) for k, v in stats["by_session"].items()},
        result=models.StatsResult(**result) if result else None,
    )
