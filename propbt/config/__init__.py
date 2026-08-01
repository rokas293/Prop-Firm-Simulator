"""YAML config loaders. Nothing here hardcodes strategy/prop-rule values --
edit the .yaml files in this directory, not this module.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Dict

import yaml

CONFIG_DIR = Path(__file__).parent
PROJECT_ROOT = CONFIG_DIR.parent.parent


def _load_yaml(name: str) -> dict:
    path = CONFIG_DIR / name
    with open(path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


@dataclass(frozen=True)
class ContractSpec:
    symbol: str
    point_value: float
    tick_size: float
    tick_value: float
    is_micro: bool


def load_contracts(path: str = "contracts.yaml") -> Dict[str, ContractSpec]:
    raw = _load_yaml(path)
    return {
        sym: ContractSpec(
            symbol=sym,
            point_value=float(spec["point_value"]),
            tick_size=float(spec["tick_size"]),
            tick_value=float(spec["tick_value"]),
            is_micro=bool(spec["is_micro"]),
        )
        for sym, spec in raw.items()
    }


@dataclass(frozen=True)
class SessionAnchor:
    hour: int
    minute: int


@dataclass(frozen=True)
class TradingDayBoundary:
    close_hour: int
    close_minute: int
    reopen_hour: int
    reopen_minute: int


@dataclass(frozen=True)
class SessionsConfig:
    timezone: str
    anchors: Dict[str, SessionAnchor]
    trading_day_boundary: TradingDayBoundary


def load_sessions(path: str = "sessions.yaml") -> SessionsConfig:
    raw = _load_yaml(path)
    anchors = {
        name: SessionAnchor(hour=int(a["hour"]), minute=int(a["minute"]))
        for name, a in raw["anchors"].items()
    }
    tdb = raw["trading_day_boundary"]
    return SessionsConfig(
        timezone=raw["timezone"],
        anchors=anchors,
        trading_day_boundary=TradingDayBoundary(
            close_hour=int(tdb["close_hour"]),
            close_minute=int(tdb["close_minute"]),
            reopen_hour=int(tdb["reopen_hour"]),
            reopen_minute=int(tdb["reopen_minute"]),
        ),
    )


@dataclass(frozen=True)
class PropRulesConfig:
    start_balance: float
    profit_target: float
    mll_initial_offset: float
    mll_freeze_trigger_balance: float
    mll_freeze_floor: float
    daily_loss_limit: float
    consistency_max_pct: float
    max_open_contracts: int
    commissions: Dict[str, float]


def load_prop_rules(path: str = "prop_rules.yaml") -> PropRulesConfig:
    raw = _load_yaml(path)
    return PropRulesConfig(
        start_balance=float(raw["account"]["start_balance"]),
        profit_target=float(raw["account"]["profit_target"]),
        mll_initial_offset=float(raw["max_loss_limit"]["initial_offset"]),
        mll_freeze_trigger_balance=float(raw["max_loss_limit"]["freeze_trigger_balance"]),
        mll_freeze_floor=float(raw["max_loss_limit"]["freeze_floor"]),
        daily_loss_limit=float(raw["daily_loss_limit"]["amount"]),
        consistency_max_pct=float(raw["consistency_rule"]["max_single_day_pct_of_profit"]),
        max_open_contracts=int(raw["position_limit"]["max_open_contracts"]),
        commissions={k: float(v) for k, v in raw["commissions"].items()},
    )


@dataclass(frozen=True)
class ExecutionConfig:
    slippage_ticks: int


def load_execution(path: str = "execution.yaml") -> ExecutionConfig:
    raw = _load_yaml(path)
    return ExecutionConfig(slippage_ticks=int(raw["slippage_ticks"]))


def load_data_paths(path: str = "data.yaml") -> Dict[str, Path]:
    raw = _load_yaml(path)
    paths = {}
    for sym, spec in raw["symbols"].items():
        if not spec.get("active", True):
            continue
        p = Path(spec["path"])
        paths[sym] = p if p.is_absolute() else PROJECT_ROOT / p
    return paths
