# propbt

Backtesting/research framework for validating an intraday futures strategy
against the Topstep $50k Combine rules. See `CLAUDE.md` for the full design
and `BUILD_PROMPTS.md` for the phased build plan. This is Phase 0: data
layer only (loader, resample, sessions) -- no engine or strategy yet.

## Setup

```bash
python -m venv .venv
.venv\Scripts\activate        # Windows
pip install -e ".[dev]"
```

Data files (`MES_1m.parquet`, `MNQ_1m.parquet`, `ZN_1m.parquet`) are expected
in the project root, per `propbt/config/data.yaml`.

## Run

```bash
python run.py inspect --symbol MES --date 2025-03-10
```

Prints that trading day's session anchors (Asia/London/NY, America/New_York
wall clock), fair value (close of the 1-min bar immediately before each
anchor), a scoped data-integrity summary, and any nearby *estimated* roll
date (see caveat below).

## Tests

```bash
pytest
```

## Status / caveats

- MES and MNQ are the primary targets for now. ZN's contract specs and the
  flat 5-contract position limit are wired into config
  (`propbt/config/contracts.yaml`, `propbt/config/prop_rules.yaml`), but
  ZN-specific strategy/engine testing is deferred.
- The source parquet files carry no symbol/expiration/instrument_id column,
  so contract-roll dates cannot be read from the data -- `estimate_roll_days`
  in `propbt/data/loader.py` is a calendar heuristic (days before the 3rd
  Friday of the contract month), not ground truth. Treat `roll_day` flags as
  approximate until the actual Databento roll rule is confirmed.
