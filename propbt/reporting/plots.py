"""Equity-curve and outcome-distribution plots (CLAUDE.md section 6).
Headless by design (Agg backend) -- this is a CLI tool, not a notebook;
figures are saved to disk, not shown interactively.
"""
from __future__ import annotations

import matplotlib

matplotlib.use("Agg")

from pathlib import Path  # noqa: E402
from typing import List, Optional, Sequence, Tuple  # noqa: E402

import matplotlib.pyplot as plt  # noqa: E402
import pandas as pd  # noqa: E402
from matplotlib.figure import Figure  # noqa: E402

from propbt.sim.monte_carlo import MonteCarloResult  # noqa: E402


def plot_equity_curve(
    equity_curve: Sequence[Tuple[pd.Timestamp, float]], start_balance: float, title: str = "Equity curve"
) -> Figure:
    fig, ax = plt.subplots(figsize=(10, 4))
    if equity_curve:
        xs = [ts for ts, _ in equity_curve]
        ys = [eq for _, eq in equity_curve]
        ax.plot(xs, ys, linewidth=1)
    ax.axhline(start_balance, color="gray", linestyle="--", linewidth=1, label="start balance")
    ax.set_title(title)
    ax.set_ylabel("Equity ($)")
    ax.legend(loc="best")
    fig.autofmt_xdate()
    fig.tight_layout()
    return fig


def plot_outcome_distribution(mc: MonteCarloResult, title: str = "Combine outcomes") -> Figure:
    fig, (ax_outcome, ax_days) = plt.subplots(1, 2, figsize=(10, 4))

    labels = ["passed", "failed", "incomplete"]
    counts = [mc.n_passed, mc.n_failed, mc.n_incomplete]
    ax_outcome.bar(labels, counts)
    ax_outcome.set_title(f"{title} (n={mc.n_attempts}, pass rate={mc.pass_rate:.1%})")
    ax_outcome.set_ylabel("# attempts")

    if mc.days_to_pass:
        ax_days.hist(mc.days_to_pass, bins=min(10, max(1, len(set(mc.days_to_pass)))))
    ax_days.set_title("Days-to-pass (passed attempts)")
    ax_days.set_xlabel("Trading days")
    ax_days.set_ylabel("# attempts")

    fig.tight_layout()
    return fig


def plot_fail_reasons(mc: MonteCarloResult, title: str = "Fail reasons") -> Figure:
    fig, ax = plt.subplots(figsize=(6, 4))
    if mc.fail_reasons:
        reasons = list(mc.fail_reasons.keys())
        counts = [mc.fail_reasons[r] for r in reasons]
        ax.bar(reasons, counts)
    ax.set_title(title)
    ax.set_ylabel("# attempts")
    fig.tight_layout()
    return fig


def save_evaluation_plots(
    in_sample_mc: MonteCarloResult,
    out_of_sample_mc: MonteCarloResult,
    output_dir: Path,
    representative_equity_curve: Optional[Sequence[Tuple[pd.Timestamp, float]]] = None,
    start_balance: Optional[float] = None,
) -> List[Path]:
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    saved: List[Path] = []

    specs = [
        ("in_sample_outcomes.png", plot_outcome_distribution(in_sample_mc, "In-sample outcomes")),
        ("in_sample_fail_reasons.png", plot_fail_reasons(in_sample_mc, "In-sample fail reasons")),
        ("out_of_sample_outcomes.png", plot_outcome_distribution(out_of_sample_mc, "Out-of-sample outcomes")),
        ("out_of_sample_fail_reasons.png", plot_fail_reasons(out_of_sample_mc, "Out-of-sample fail reasons")),
    ]
    if representative_equity_curve is not None and start_balance is not None:
        specs.append((
            "representative_equity_curve.png",
            plot_equity_curve(representative_equity_curve, start_balance, "Representative attempt equity curve"),
        ))

    for filename, fig in specs:
        path = output_dir / filename
        fig.savefig(path, dpi=120)
        plt.close(fig)
        saved.append(path)

    return saved
