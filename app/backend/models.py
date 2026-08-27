"""Pydantic response models -- one per API shape (VIZ_SPEC.md section 6).
All times are UNIX seconds UTC (Lightweight Charts' native format); the
backend converts from the bundle's tz-aware pandas Timestamps here, once,
so nothing downstream has to think about timezones again.
"""
from __future__ import annotations

from typing import Dict, Optional

from pydantic import BaseModel


class RunResultModel(BaseModel):
    passed: bool
    fail_reason: Optional[str] = None
    days_to_fail: Optional[int] = None


class RunSummary(BaseModel):
    run_id: str
    created_at: str
    config_name: str
    instrument: str
    base_timeframe: str
    date_from: str
    date_to: str
    is_oos_split_date: Optional[str] = None
    result: RunResultModel
    params_count: int


class RunMetaResponse(RunSummary):
    config_hash: str


class TradeRecord(BaseModel):
    trade_id: int
    entry_time: int
    exit_time: int
    instrument: str
    side: str
    leg: Optional[str] = None
    session: Optional[str] = None
    trading_day: Optional[str] = None
    size_contracts: int
    entry_price: float
    exit_price: float
    sl_price: Optional[float] = None
    tp_price: Optional[float] = None
    sl_points: Optional[float] = None
    tp_points: Optional[float] = None
    rr_planned: Optional[float] = None
    exit_type: str
    pnl_usd: float
    r_multiple: Optional[float] = None
    commission_usd: float
    mae_points: float
    mfe_points: float
    mae_r: Optional[float] = None
    mfe_r: Optional[float] = None
    bars_held: int


class EquityPoint(BaseModel):
    time: int
    balance: float
    open_pnl: float
    equity: float
    mll_floor: float
    daily_loss_floor: float
    target_level: float
    trading_day: Optional[str] = None
    day_start_balance: float
    breached: bool
    daily_locked: bool
    drawdown_usd: float


class GroupStats(BaseModel):
    trades: int
    net_pnl_usd: float
    net_r: Optional[float] = None
    win_rate: Optional[float] = None
    expectancy_usd: Optional[float] = None
    expectancy_r: Optional[float] = None
    profit_factor: Optional[float] = None
    max_drawdown_usd: float = 0.0


class StatsResult(BaseModel):
    status: str
    fail_reason: Optional[str] = None
    target_hit: bool
    consistency_passed: Optional[bool] = None
    final_balance: float
    trading_days: int


class StatsResponse(BaseModel):
    scope: str
    overall: GroupStats
    by_leg: Dict[str, GroupStats]
    by_session: Dict[str, GroupStats]
    result: Optional[StatsResult] = None


class Bar(BaseModel):
    time: int
    open: float
    high: float
    low: float
    close: float
    volume: int


class DailyRiskPoint(BaseModel):
    trading_day: str
    min_distance_to_mll_usd: float
    min_distance_time: int
    breached: bool
    breach_time: Optional[int] = None
    daily_locked: bool
    daily_lock_time: Optional[int] = None
    trades: int


class IndicatorPoint(BaseModel):
    time: int
    value: float


class AiStatusResponse(BaseModel):
    available: bool


class SummarizeResponse(BaseModel):
    summary: str


class SessionWindow(BaseModel):
    trading_day: str
    session: str
    start: int
    end: int
    fair_value: Optional[float] = None
    fair_value_time: Optional[int] = None
