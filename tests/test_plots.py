from __future__ import annotations

import pandas as pd

from propbt.reporting.plots import (
    plot_equity_curve,
    plot_fail_reasons,
    plot_outcome_distribution,
    save_evaluation_plots,
)
from propbt.sim.monte_carlo import MonteCarloResult


def make_mc(n_passed=3, n_failed=5, n_incomplete=2, days_to_pass=None, fail_reasons=None) -> MonteCarloResult:
    n = n_passed + n_failed + n_incomplete
    return MonteCarloResult(
        n_attempts=n, n_passed=n_passed, n_failed=n_failed, n_incomplete=n_incomplete,
        pass_rate=n_passed / n if n else float("nan"),
        resolved_pass_rate=n_passed / (n_passed + n_failed) if (n_passed + n_failed) else float("nan"),
        days_to_pass=days_to_pass or [10, 12, 15], fail_reasons=fail_reasons or {"mll_breach": 5},
    )


def test_plot_equity_curve_with_data():
    curve = [(pd.Timestamp("2025-01-06 14:30", tz="UTC"), 50000.0),
             (pd.Timestamp("2025-01-06 14:31", tz="UTC"), 50050.0)]
    fig = plot_equity_curve(curve, start_balance=50000.0)
    assert len(fig.axes) == 1
    assert len(fig.axes[0].lines) >= 1


def test_plot_equity_curve_with_no_data_does_not_crash():
    fig = plot_equity_curve([], start_balance=50000.0)
    assert len(fig.axes) == 1


def test_plot_outcome_distribution_has_two_subplots():
    mc = make_mc()
    fig = plot_outcome_distribution(mc)
    assert len(fig.axes) == 2


def test_plot_outcome_distribution_with_no_passes():
    mc = make_mc(n_passed=0, n_failed=5, n_incomplete=2, days_to_pass=[])
    fig = plot_outcome_distribution(mc)
    assert len(fig.axes) == 2


def test_plot_fail_reasons_with_data():
    mc = make_mc(fail_reasons={"mll_breach": 4, "other": 1})
    fig = plot_fail_reasons(mc)
    assert len(fig.axes) == 1


def test_plot_fail_reasons_empty():
    mc = make_mc(n_failed=0, fail_reasons={})
    fig = plot_fail_reasons(mc)
    assert len(fig.axes) == 1


def test_save_evaluation_plots_writes_files(tmp_path):
    in_sample = make_mc()
    out_of_sample = make_mc(n_passed=1, n_failed=6, n_incomplete=1, fail_reasons={"mll_breach": 6})
    curve = [(pd.Timestamp("2025-01-06 14:30", tz="UTC"), 50000.0)]

    saved = save_evaluation_plots(in_sample, out_of_sample, tmp_path,
                                   representative_equity_curve=curve, start_balance=50000.0)
    assert len(saved) == 5
    for path in saved:
        assert path.exists()
        assert path.stat().st_size > 0


def test_save_evaluation_plots_without_equity_curve(tmp_path):
    in_sample = make_mc()
    out_of_sample = make_mc()
    saved = save_evaluation_plots(in_sample, out_of_sample, tmp_path)
    assert len(saved) == 4  # no equity-curve plot without one supplied
