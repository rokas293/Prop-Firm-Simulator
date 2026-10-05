# FXR manual backtesting platform (MNQ / MES)

An FX Replay-style platform for manually backtesting, journaling and analyzing
trades on MNQ and MES futures, built on top of `propbt`, an automated backtest
engine that validates a strategy against the Topstep $50k Combine rules
(`CLAUDE.md`, `FXR_SPEC.md`).

## What it does

- **Replay sessions.** Pick MNQ or MES, a timeframe and a start time (or a
  random one) and step or play through history. Future bars are never shown or
  fillable.
- **Simulated broker.** Market buy/sell, a drag-to-place entry/SL/TP ticket,
  right-click limit/stop orders, partial closes, break-even and trailing, with
  auto position sizing and commissions. Fills are deterministic from the bars
  up to the cursor.
- **Discipline tools.** Random start, an optional lock that stops the replay
  going back past a placed trade, and a bar magnifier that shows the 1-minute
  bars inside a revealed bar (never past the cursor).
- **Topstep Combine sim.** Optionally judge a session against the profit
  target, trailing max loss, daily loss limit, consistency rule and the
  5-contract cap.
- **Journal.** Every closed trade is logged with notes, tags, setup, grade and
  screenshots, and you can jump the chart back to any trade.
- **Analytics.** Stats, equity, drawdown and heat, breakdowns, trade-sequence
  Monte Carlo and the Combine verdict, per session or pooled per instrument.
- **Keyboard.** Shift+B / Shift+S / Shift+C trade, Space plays, `.` steps; press
  `?` in the app for the full list.

## Run the platform

```bash
pip install -e ".[dev]"            # once (see Setup below)
npm install                        # once, project root
npm --prefix app/frontend install  # once
npm run dev                        # backend :8000 + frontend :5173
```

Open **http://localhost:5173**, go to the **Sessions** tab and choose **New
session**. Sessions are stored in `bt_sessions/`; set `PROPBT_BT_SESSIONS_DIR`
to keep them elsewhere (handy for experiments). More in `app/README.md`.

## Screenshots

_Placeholder: add screenshots here (sessions list, session workspace with the
trade ticket, journal, analytics)._

<!-- ![Session workspace](docs/img/workspace.png) -->

## The propbt engine

`propbt` is the automated backtest engine underneath. `python run.py review`
writes run bundles that the same app can review under the **Runs** tab.

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

## Viz app

`python run.py review --config propbt/config/strategy.yaml` writes a run
bundle (`runs/<run_id>/`) for the local web viewer described in
`VIZ_SPEC.md` -- see `app/README.md` for how to run it.

## Third-party notices

The viz app's frontend bundles `lightweight-charts` (Apache-2.0, TradingView, Inc.) for the Prop Risk panel's chart. License text and attribution details: `THIRD_PARTY_NOTICES.md`.

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
