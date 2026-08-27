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
    exit_type: Optional[str] = None,
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
    if exit_type:
        df = df[df["exit_type"] == exit_type]
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
        drawdown_usd=float(row["drawdown_usd"]),
    )


_EQUITY_CHANGE_COLS = ["balance", "equity", "mll_floor", "daily_loss_floor", "breached", "daily_locked"]


def _compress_equity(df: pd.DataFrame, max_points: int) -> pd.DataFrame:
    """Equity is per-bar (potentially 300k+ rows for a multi-year run) but
    mostly flat between trade/EOD events -- ship every row where something
    actually changed instead of a fixed-stride sample, so no real step in
    balance/mll_floor/breach state is ever silently dropped (VIZ_SPEC
    section 0: never ship all bars, but "resample honestly").

    If that's still above max_points, stride-sample on top, but always keep
    the breach row(s) -- the single bar the run died on (CLAUDE.md section
    6) must never be a casualty of decimation.
    """
    if df.empty:
        return df

    changed = (df[_EQUITY_CHANGE_COLS] != df[_EQUITY_CHANGE_COLS].shift(1)).any(axis=1)
    changed.iloc[0] = True
    compressed = df[changed]

    if len(compressed) <= max_points:
        return compressed

    stride = max(1, len(compressed) // max_points)
    keep = pd.Series(False, index=compressed.index)
    keep.iloc[::stride] = True
    keep.iloc[-1] = True
    keep |= compressed["breached"]
    return compressed[keep]


def list_equity(
    run_id: str,
    ts_from: Optional[int] = None,
    ts_to: Optional[int] = None,
    max_points: int = 5000,
) -> List[models.EquityPoint]:
    try:
        df = rb.read_equity(run_id, get_runs_dir())
    except FileNotFoundError:
        raise RunNotFound(run_id)

    # Drawdown-from-peak is computed on the full, unfiltered series first --
    # "peak equity to date" must reflect the run's real history even if the
    # caller only asked for a later window, and doing it here (not in the
    # frontend) keeps VIZ_SPEC's "frontend does zero financial math" rule.
    df = df.copy()
    df["drawdown_usd"] = df["equity"].cummax() - df["equity"]

    if ts_from is not None:
        df = df[df["time"] >= pd.Timestamp(ts_from, unit="s", tz="UTC")]
    if ts_to is not None:
        df = df[df["time"] <= pd.Timestamp(ts_to, unit="s", tz="UTC")]

    df = _compress_equity(df, max_points)

    return [_equity_row(row) for _, row in df.iterrows()]


def list_daily_risk(run_id: str) -> List[models.DailyRiskPoint]:
    """Per trading day, the closest the run ever came to an MLL breach --
    computed on the FULL uncompressed equity series (not the client-facing
    downsampled one), since the true intraday minimum could fall on a bar
    that decimation would otherwise drop. "Distance to MLL" = equity minus
    the trailing MLL floor (CLAUDE.md section 3: breach is live intraday
    equity touching the floor), so 0 or below means that day breached.
    """
    try:
        df = rb.read_equity(run_id, get_runs_dir())
    except FileNotFoundError:
        raise RunNotFound(run_id)

    try:
        trades_df = rb.read_trades(run_id, get_runs_dir())
    except FileNotFoundError:
        trades_df = None

    df = df.copy()
    df["distance_to_mll"] = df["equity"] - df["mll_floor"]

    rows: List[models.DailyRiskPoint] = []
    for trading_day, group in df.groupby("trading_day", sort=True):
        min_idx = group["distance_to_mll"].idxmin()
        min_row = group.loc[min_idx]
        trades_that_day = 0
        if trades_df is not None and "trading_day" in trades_df.columns:
            trades_that_day = int((trades_df["trading_day"] == trading_day).sum())

        breached_rows = group[group["breached"]]
        locked_rows = group[group["daily_locked"]]

        rows.append(
            models.DailyRiskPoint(
                trading_day=str(trading_day),
                min_distance_to_mll_usd=float(min_row["distance_to_mll"]),
                min_distance_time=_unix(min_row["time"]),
                breached=not breached_rows.empty,
                breach_time=_unix(breached_rows.iloc[0]["time"]) if not breached_rows.empty else None,
                daily_locked=not locked_rows.empty,
                daily_lock_time=_unix(locked_rows.iloc[0]["time"]) if not locked_rows.empty else None,
                trades=trades_that_day,
            )
        )
    return rows


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
