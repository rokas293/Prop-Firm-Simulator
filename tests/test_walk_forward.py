from __future__ import annotations

import dataclasses

import pandas as pd
import pytest

from propbt.config import load_contracts, load_prop_rules, load_sessions
from propbt.sim.monte_carlo import MonteCarloResult
from propbt.sim.walk_forward import (
    apply_overrides,
    count_free_parameters,
    count_leg_parameters,
    run_walk_forward,
    select_most_robust,
)
from propbt.strategy.session_open import ContinuationConfig, MeanReversionConfig, SessionOpenRunConfig
from tests.conftest import make_ohlcv


def flat_df(start: str, n_days: int, price: float = 5000.0) -> pd.DataFrame:
    idx = pd.date_range(start, periods=n_days * 1440, freq="1min", tz="UTC")
    n = len(idx)
    return make_ohlcv(idx, [price] * n, [price + 0.5] * n, [price - 0.5] * n, [price] * n, [100] * n)


def make_cont_cfg(**overrides):
    defaults = dict(sessions=("ny",), direction_method="close_vs_fair_value",
                     observation_window_minutes=1, contracts=1, sl_points=10.0, rr=1.0)
    defaults.update(overrides)
    return ContinuationConfig(**defaults)


def make_run_cfg(start="2025-01-01", end="2025-01-15", **cont_overrides):
    return SessionOpenRunConfig(symbol="MES", start=start, end=end,
                                 continuation=make_cont_cfg(**cont_overrides), mean_reversion=None)


def make_mc(pass_rate: float) -> MonteCarloResult:
    n = 10
    n_passed = round(pass_rate * n)
    return MonteCarloResult(n_attempts=n, n_passed=n_passed, n_failed=n - n_passed, n_incomplete=0,
                             pass_rate=pass_rate, resolved_pass_rate=pass_rate)


# --- apply_overrides ----------------------------------------------------

def test_apply_overrides_continuation_field():
    base = make_run_cfg()
    updated = apply_overrides(base, {"continuation_rr": 2.0})
    assert updated.continuation.rr == 2.0
    assert base.continuation.rr == 1.0  # original untouched (frozen dataclass)


def test_apply_overrides_reruns_validation():
    base = make_run_cfg()
    with pytest.raises(ValueError):
        apply_overrides(base, {"continuation_rr": 1.25})  # not in ALLOWED_RR


def test_apply_overrides_unknown_prefix_raises():
    base = make_run_cfg()
    with pytest.raises(ValueError):
        apply_overrides(base, {"nonsense_field": 1})


def test_apply_overrides_disabled_leg_raises():
    base = make_run_cfg()  # mean_reversion is None
    with pytest.raises(ValueError):
        apply_overrides(base, {"mean_reversion_rr": 1.0})


# --- parameter counting --------------------------------------------------

def test_count_leg_parameters_none_is_zero():
    assert count_leg_parameters(None) == 0


def test_count_leg_parameters_excludes_sessions_and_contracts():
    cfg = make_cont_cfg()
    n = count_leg_parameters(cfg)
    assert n == len(dataclasses.fields(cfg)) - 2  # sessions, contracts excluded


def test_count_free_parameters_sums_enabled_legs():
    run_cfg = SessionOpenRunConfig(
        symbol="MES", start="2025-01-01", end="2025-01-15",
        continuation=make_cont_cfg(),
        mean_reversion=MeanReversionConfig(
            sessions=("ny",), max_trades_per_session=3, compression_method="range",
            compression_lookback_bars=10, compression_threshold_points=5.0,
            require_volume_confirmation=False, volume_lookback_bars=5, volume_baseline_bars=20,
            volume_ratio_threshold=0.7, swing_lookback_bars=3, direction_mode="fade_break",
            contracts=1, sl_points=8.0, rr=1.0,
        ),
    )
    expected = count_leg_parameters(run_cfg.continuation) + count_leg_parameters(run_cfg.mean_reversion)
    assert count_free_parameters(run_cfg) == expected


# --- robust-neighbor selection --------------------------------------------

def test_select_most_robust_does_not_just_pick_the_best_single_point():
    grid = [
        ({"continuation_rr": 1.0}, make_mc(0.10)),
        ({"continuation_rr": 1.5}, make_mc(0.90)),   # isolated spike, poor neighbors
        ({"continuation_rr": 2.0}, make_mc(0.10)),
    ]
    scored = select_most_robust(grid)
    best = max(scored, key=lambda g: g.robustness_score)
    naive_best = max(grid, key=lambda kv: kv[1].pass_rate)[0]
    assert naive_best == {"continuation_rr": 1.5}          # naive "best single point" would pick the spike
    assert best.overrides != {"continuation_rr": 1.5}       # robust selection must not just do that
    # the spike's own 3-point neighborhood average is (0.10+0.90+0.10)/3 = 0.367,
    # tied with (and not exceeding) its neighbors' own scores
    spike_score = next(g.robustness_score for g in scored if g.overrides == {"continuation_rr": 1.5})
    assert spike_score == pytest.approx((0.10 + 0.90 + 0.10) / 3)
    assert best.robustness_score >= spike_score


def test_select_most_robust_picks_plateau_when_present():
    grid = [
        ({"continuation_rr": 1.0}, make_mc(0.10)),
        ({"continuation_rr": 1.5}, make_mc(0.95)),   # isolated spike
        ({"continuation_rr": 2.0}, make_mc(0.15)),   # separates the spike from the plateau below
        ({"continuation_rr": 2.5}, make_mc(0.60)),
        ({"continuation_rr": 3.0}, make_mc(0.62)),   # plateau: consistently good neighborhood
        ({"continuation_rr": 3.5}, make_mc(0.61)),
    ]
    scored = select_most_robust(grid)
    best = max(scored, key=lambda g: g.robustness_score)
    # winner must come from the plateau region, never the isolated spike
    assert best.overrides in [{"continuation_rr": 2.5}, {"continuation_rr": 3.0}, {"continuation_rr": 3.5}]


def test_select_most_robust_endpoint_uses_one_sided_neighborhood():
    grid = [
        ({"continuation_rr": 1.0}, make_mc(0.80)),
        ({"continuation_rr": 1.5}, make_mc(0.20)),
    ]
    scored = select_most_robust(grid)
    # first point's neighborhood is just itself+next = (0.80+0.20)/2
    assert scored[0].robustness_score == pytest.approx((0.80 + 0.20) / 2)


# --- full walk-forward run (small synthetic data, single grid point) -----

@pytest.fixture(scope="module")
def sessions_cfg():
    return load_sessions()


@pytest.fixture(scope="module")
def contracts():
    return load_contracts()


@pytest.fixture(scope="module")
def prop_cfg():
    return load_prop_rules()


def test_run_walk_forward_end_to_end(sessions_cfg, contracts, prop_cfg):
    df = flat_df("2025-01-01 00:00:00", n_days=30)
    base_cfg = make_run_cfg(start="2025-01-01", end="2025-01-15")

    result = run_walk_forward(
        base_run_config=base_cfg,
        param_grid=[{"continuation_rr": 1.0}, {"continuation_rr": 1.5}, {"continuation_rr": 2.0}],
        df=df, symbol="MES", contracts=contracts, prop_rules_config=prop_cfg, sessions_config=sessions_cfg,
        out_of_sample_start="2025-01-16", out_of_sample_end="2025-01-30",
        n_attempts_per_grid_point=2, n_attempts_out_of_sample=2,
        stride_days=3, warmup_days=1, max_calendar_days=2,
    )

    assert len(result.grid) == 3
    assert result.selected_overrides in [{"continuation_rr": 1.0}, {"continuation_rr": 1.5}, {"continuation_rr": 2.0}]
    assert result.in_sample.n_attempts == 2
    assert result.out_of_sample.n_attempts == 2
    assert result.n_free_parameters > 0
    # flat data -> the continuation leg never sees a spike -> no trades -> should warn
    assert result.n_in_sample_trades == 0
    assert result.parameter_budget_warning is not None


def test_run_walk_forward_empty_grid_defaults_to_base_config(sessions_cfg, contracts, prop_cfg):
    df = flat_df("2025-01-01 00:00:00", n_days=20)
    base_cfg = make_run_cfg(start="2025-01-01", end="2025-01-10")

    result = run_walk_forward(
        base_run_config=base_cfg, param_grid=[], df=df, symbol="MES", contracts=contracts,
        prop_rules_config=prop_cfg, sessions_config=sessions_cfg,
        out_of_sample_start="2025-01-11", out_of_sample_end="2025-01-20",
        n_attempts_per_grid_point=1, n_attempts_out_of_sample=1,
        stride_days=2, warmup_days=1, max_calendar_days=2,
    )
    assert len(result.grid) == 1
    assert result.selected_overrides == {}
