# Research methodology: the metric, and staying honest

Pointed to from `CLAUDE.md`. Why this framework exists and the two rules
(the headline metric, and the anti-overfitting guardrails) that keep its
answer honest.

## Goal

Build a research/backtesting framework to design and validate an
intraday futures strategy that can **pass a Topstep $50k Combine** (the
evaluation phase). Funded-account rules differ and are out of scope for
now — model the Combine only.

The framework's single most important output is an honest answer to:
*"Across many realistic Combine attempts, what % would this strategy
pass, and how?"* — measured **out-of-sample**. This is a research tool.
Passing an eval is path-dependent and easy to fake by curve-fitting; the
framework must actively guard against that (see below).

## The metric that matters

A single equity curve is nearly meaningless for eval design. The primary
report is a **Monte Carlo over Combine attempts**: simulate the strategy
starting on many different dates, each running until pass/fail, and
report:

- **% of attempts passed** (target hit AND consistency AND no MLL
  breach) — this is *the* number.
- Distribution of days-to-pass; distribution of fail reasons (MLL breach
  vs never reaching target).
- Per-trade expectancy (in $ and R), win rate, per-session and per-leg
  (continuation vs mean-reversion vs news) breakdown.
- Sensitivity of pass % to RR, SL size, contracts, and which legs are on.

## Anti-overfitting guardrails (treat as a hard requirement)

The plan is to iterate daily to "find something that works." That is
exactly the process that produces a curve-fit strategy that passes the
backtest and fails live. Build the framework so honesty is the default:

- **Chronological split:** reserve the most recent ~30–40% of data as an
  **out-of-sample (OOS) holdout** that is never used for tuning. Report
  in-sample and OOS pass % side by side, always.
- **Walk-forward** validation as the headline evaluation, not a single
  optimized run.
- **Parameter budget:** log how many free parameters a config has; warn
  loudly when it's high relative to the number of independent
  trades/sessions.
- **Realistic frictions on by default:** commissions, slippage (ticks),
  and no-look-ahead. Never report a "clean" fill result without
  frictions.
- Prefer configs that are **robust across neighbors** in parameter space
  over single sharp optima.

When a result looks good, the first question in any summary must be:
"Is this in-sample or out-of-sample, and how many parameters bought it?"
