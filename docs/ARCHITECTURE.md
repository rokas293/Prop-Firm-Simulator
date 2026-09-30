# propbt engine architecture & conventions

Pointed to from `CLAUDE.md`. Covers the Python backtesting engine
(`propbt/`) only — the FastAPI/React viz+replay app has its own specs
(`VIZ_SPEC.md`, `FXR_SPEC.md`) and is not duplicated here.

## Architecture

Python 3.11+, event-driven. Vectorize data prep; loop bar-by-bar for the
engine (so path-dependent prop rules and no-look-ahead are trivially
correct). Layout:

```
propbt/
  config/            # YAML configs (data paths, sessions, strategy params, prop rules)
  data/
    loader.py        # Databento ingest -> tidy UTC DataFrame
    resample.py      # 1m -> higher TF
    sessions.py      # session windows, fair value, tz handling, roll flags
    news.py          # news_events.csv loader
  engine/
    events.py        # bar/signal/order/fill types
    broker.py        # fills, slippage (ticks), commissions, position & contract limits
    portfolio.py     # equity curve (realized + intraday unrealized)
    prop_rules.py    # Topstep MLL trail, daily loss lock, target, consistency
    backtester.py    # the bar loop; enforces execute-at-t+1
  strategy/
    base.py          # Strategy interface: on_bar(state) -> orders
    session_open.py  # continuation + mean-reversion legs
    news_spike.py
  sim/
    combine.py       # simulate a full Combine attempt from a start date
    monte_carlo.py   # many attempts over rolling/sampled start dates -> pass %
    walk_forward.py  # in-sample optimize, out-of-sample validate
  reporting/
    metrics.py       # expectancy, win rate, per-session/per-leg breakdown, fail reasons
    plots.py         # equity curves, distributions
  tests/             # pytest: no-look-ahead, prop-rule edge cases, fills, tz/DST
  run.py             # CLI (typer/argparse)
```

Libraries: pandas or polars, numpy, pyyaml, typer, matplotlib, pytest.
Numba/vectorization optional later for speed. Keep the engine
deterministic and seedable.

## Conventions

- Money in account-currency USD; price distances in points; risk in R.
- All times tz-aware UTC internally; convert only at session boundaries
  and for display.
- Config-driven, no magic numbers in logic.
- Every engine/strategy change ships with a test. No-look-ahead and
  prop-rule tests are mandatory and must stay green (run via the
  `verifier` subagent — see `CLAUDE.md`).
- Commit small, phase by phase (see `BUILD_PROMPTS.md`).
