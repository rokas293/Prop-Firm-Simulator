"""Loader for run.py evaluate's config -- Monte Carlo + walk-forward run
settings. Kept separate from propbt/config/__init__.py to avoid that
module needing to import strategy-config types (which would create a
propbt.config <-> propbt.strategy import cycle).
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Union

import yaml

from propbt.config import PROJECT_ROOT


@dataclass(frozen=True)
class MonteCarloRunConfig:
    method: str
    stride_days: int
    seed: int
    warmup_days: int
    max_calendar_days: int


@dataclass(frozen=True)
class WalkForwardRunConfig:
    out_of_sample_start: str
    out_of_sample_end: str
    param_grid: List[Dict[str, Any]]
    n_attempts_per_grid_point: int
    n_attempts_out_of_sample: int


@dataclass(frozen=True)
class EvaluateConfig:
    strategy_config_path: Path
    monte_carlo: MonteCarloRunConfig
    walk_forward: WalkForwardRunConfig
    plots_dir: Path


def load_evaluate_config(path: Union[str, Path]) -> EvaluateConfig:
    with open(path, "r", encoding="utf-8") as f:
        raw = yaml.safe_load(f)

    strategy_config_path = Path(raw["strategy_config"])
    if not strategy_config_path.is_absolute():
        strategy_config_path = PROJECT_ROOT / strategy_config_path

    mc = raw["monte_carlo"]
    mc_cfg = MonteCarloRunConfig(
        method=mc["method"], stride_days=int(mc["stride_days"]),
        seed=int(mc["seed"]), warmup_days=int(mc["warmup_days"]), max_calendar_days=int(mc["max_calendar_days"]),
    )

    wf = raw["walk_forward"]
    wf_cfg = WalkForwardRunConfig(
        out_of_sample_start=str(wf["out_of_sample_start"]), out_of_sample_end=str(wf["out_of_sample_end"]),
        param_grid=list(wf.get("param_grid") or []),
        n_attempts_per_grid_point=int(wf["n_attempts_per_grid_point"]),
        n_attempts_out_of_sample=int(wf["n_attempts_out_of_sample"]),
    )

    plots_dir = Path(raw["output"]["plots_dir"])
    if not plots_dir.is_absolute():
        plots_dir = PROJECT_ROOT / plots_dir

    return EvaluateConfig(
        strategy_config_path=strategy_config_path, monte_carlo=mc_cfg, walk_forward=wf_cfg, plots_dir=plots_dir,
    )
