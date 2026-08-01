# CLAUDE.md — Prop Firm Eval Backtesting Framework

This file is persistent context for Claude Code. Read it before every task. Keep it updated as the design evolves.

## 1. Goal

Build a research/backtesting framework to design and validate an intraday futures strategy that can **pass a Topstep $50k Combine** (the evaluation phase). Funded-account rules differ and are out of scope for now — model the Combine only.

The framework's single most important output is an honest answer to: *"Across many realistic Combine attempts, what % would this strategy pass, and how?"* — measured **out-of-sample**. This is a research tool. Passing an eval is path-dependent and easy to fake by curve-fitting; the framework must actively guard against that (see §7).

## 2. Instruments & data

- **Data source:** Databento, 1-minute OHLCV parquet for **MES** (Micro E-mini S&P 500), **MNQ** (Micro E-mini Nasdaq-100), and **ZN** (10-Year T-Note, full-size). Files store OHLCV with a tz-aware UTC `ts_event` index and no embedded symbol/expiration/roll metadata. Resample up to higher timeframes as needed; never resample down. Start development on MES/MNQ; bring ZN in once specs/limits below are wired.
- **Timestamps:** Databento is UTC. Store everything internally as tz-aware UTC. Convert to `America/New_York` for session logic. Handle DST correctly — never hardcode UTC offsets.
- **Contract rolls:** front-month futures roll quarterly. Do NOT hold positions across a roll boundary and flag roll days. If using a continuous/back-adjusted series, remember back-adjustment preserves *point distances* (which is what static SL/TP care about) but shifts absolute levels; raw stitching creates phantom gaps. Confirm which Databento product is in use before trusting overnight moves.
- **Sparse bars (Databento emits a bar only when a trade occurs).** MES/MNQ are dense; **ZN has ~10x more small intra-session gaps** in thin hours because it simply doesn't trade every minute. Do NOT forward-fill synthetic prices — leave bars sparse and make resample.py and the strategy tolerate missing minutes. Caveat for strategy logic: window-based calcs (ATR/consolidation over "K bars", swing lookbacks) count *bars*, so on ZN a K-bar window spans more wall-clock time than on MES. Where a window is meant to represent elapsed time, define it in minutes and derive the bar count, or document that it's bar-count-based.
- **No look-ahead, ever.** A decision made on bar `t` may only use data with timestamp ≤ close of bar `t`. Execution happens at bar `t+1` open (or as a limit/stop fill within `t+1`). This rule is non-negotiable and every strategy/engine change must preserve it. Add tests for it.

### Contract specs
| Symbol | Point value | Tick size | Tick value |
|--------|-------------|-----------|------------|
| MES    | $5 / point  | 0.25 pt   | $1.25      |
| MNQ    | $2 / point  | 0.25 pt   | $0.50      |
| ZN     | $1,000 / pt | 1/64 pt   | $15.625    |

(Full-size for reference: ES $50/pt, NQ $20/pt. MES/MNQ are micros; **ZN is a full-size contract** — 10Y T-Note, price quoted in points and 32nds, tick = 1/64 pt. Its point value is large, so position sizing and risk behave very differently from the micros.)

## 3. Topstep $50k Combine rules (model these exactly)

Verified 2026 rules — put them in a single `PropRules` config object, all values overridable:

- **Profit target:** +$3,000 cumulative (account balance reaches $53,000).
- **Maximum Loss Limit (trailing drawdown):** starts at $2,000 below start balance (floor = $48,000). It **trails on end-of-day balance**: after each trading day closes, `mll = max(mll, eod_balance - 2000)`. Once EOD balance reaches **$52,000**, the MLL **freezes at $50,000** and never trails again.
  - **Breach = fail**, and it is checked against **live intraday equity** (realized + open PnL) on every bar. If intraday equity ever touches the current MLL floor → the Combine attempt fails immediately.
- **Daily Loss Limit:** $1,000. If the day's drawdown from that day's starting balance reaches −$1,000, the account is **locked for the rest of that day** (flatten and stop trading). This does NOT fail the Combine — it just ends the day.
- **Consistency rule:** the single best trading day must be **≤ 50%** of total profit at the moment the target is hit. Check this when the target is reached; if violated, the attempt is "target hit but not consistency-passed" (track separately).
- **Position limit:** **5 contracts total** for the $50k account. Important: Topstep (unlike Apex) does NOT give micros a 10:1 discount — **1 micro counts as 1 contract**. So 5 MES or 5 MNQ micros maxes you out, and each ZN counts as 1 of the 5. Model the limit as a flat count of open contracts across all instruments, capped at 5 (configurable). Verify on Topstep's official Combine Parameters page before real use — public sources disagree on the micro count.
- **Trading day boundary (critical — governs daily loss reset AND the EOD balance for the MLL trail):** the Topstep/CME trading day runs **18:00 ET → 17:00 ET** next day (5:00 PM CT reset), with the 17:00–18:00 ET maintenance halt (already visible as the recurring 1h gap in the data). The Daily Loss Limit resets, and the EOD balance that trails the MLL is stamped, at this **17:00/18:00 ET boundary — NOT midnight and NOT the NY equity close.** Consequence: attribute every session to the CME trading day it falls within, so Asia (20:00 ET), the following London (03:00 ET), and NY (09:30 ET) all belong to ONE trading day and share one daily loss limit and one EOD stamp. This resolves the Asia day-attribution TODO in §4.
- **Commissions:** round-turn per contract, configurable **per instrument** (micros ~$0.75–$1.30 round-turn; **ZN is a full-size contract with its own, higher round-turn — give it a separate config value**, don't reuse the micro number). With ~20 trades/day, commissions materially affect pass rate, so they must be in from day one.

> Rules change periodically. Keep them in config, cite this file's "verified 2026" note, and re-verify before trusting results for real money.

## 4. Strategy under test (from the source trader)

Three trade "legs", applied to **each session open** (Asia, London, New York) and to **scheduled high-impact news**:

1. **Fair value:** the close of the 1-minute bar immediately *before* the session/news open. Stored as the session's reference price.
2. **Open-spike continuation (1 trade):** at the open there's a volume/price spike. Take **one** continuation trade in the spike's direction. Static SL and TP measured in **points**, with RR selectable from {1:1, 1:1.5, 1:2}. Configurable observation window (default: judge direction from the first 1–5 min of displacement).
3. **Mean-reversion after the impulse (~3 trades):** once opening volume dies down there's consolidation; on a **break of structure** the trader fades back toward fair value / session VWAP. Up to 3 trades. Static SL/TP in points.

Same pattern is applied around scheduled **high-impact news** spikes (FOMC, CPI, NFP, PCE, etc.). Target volume ~**20 trades/day** across the three sessions plus news.

### Concrete definitions (implement these, keep them tunable)
- **Session anchors (America/New_York, configurable — confirm before relying on defaults):**
  - New York open: 09:30 ET (RTH). Also consider 08:30 ET data releases as "news", not session.
  - London open: 03:00 ET (08:00 London).
  - Asia open: default 20:00 ET (Tokyo 09:00 JST). Day attribution is RESOLVED — it belongs to the CME trading day that reopened at 18:00 ET that evening (see §3 trading-day boundary), i.e. the same trading day as the following London/NY sessions. Confirm the anchor *time* if you want a different one, but the attribution rule is fixed.
  - Globex daily reopen 18:00 ET is available as an optional anchor.
- **Spike direction:** sign of (close of first bar − fair value), or displacement of first-N-min range — make the method a config switch so both can be tested.
- **Consolidation:** range/ATR over the last K bars compressed below a threshold, and/or volume below a rolling average — configurable.
- **Swing point:** local extreme over `w` bars each side. **Break of structure (BoS):** a bar closes beyond the most recent swing high/low. Mean-reversion entries fade the BoS back toward fair value (direction logic is a tested config switch, since "fade the break" vs "join then fade" both need evaluating).
- **News calendar:** ingest a `news_events.csv` (UTC timestamp, event, impact). High-impact only by default. Source is the user's export (e.g., an economic calendar CSV) — the loader must be format-tolerant.

Every strategy parameter (windows, thresholds, RR, SL points, contracts, which legs are enabled) lives in a config file. Nothing hardcoded in strategy logic.

## 5. Architecture

Python 3.11+, event-driven. Vectorize data prep; loop bar-by-bar for the engine (so path-dependent prop rules and no-look-ahead are trivially correct). Suggested layout:

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
    monte_carlo.py   # many attempts over rolling/ sampled start dates -> pass %
    walk_forward.py  # in-sample optimize, out-of-sample validate
  reporting/
    metrics.py       # expectancy, win rate, per-session/per-leg breakdown, fail reasons
    plots.py         # equity curves, distributions
  tests/             # pytest: no-look-ahead, prop-rule edge cases, fills, tz/DST
  run.py             # CLI (typer/argparse)
```

Libraries: pandas or polars, numpy, pyyaml, typer, matplotlib, pytest. Numba/vectorization optional later for speed. Keep the engine deterministic and seedable.

## 6. The metric that matters

A single equity curve is nearly meaningless for eval design. The primary report is a **Monte Carlo over Combine attempts**: simulate the strategy starting on many different dates, each running until pass/fail, and report:

- **% of attempts passed** (target hit AND consistency AND no MLL breach) — this is *the* number.
- Distribution of days-to-pass; distribution of fail reasons (MLL breach vs never reaching target).
- Per-trade expectancy (in $ and R), win rate, per-session and per-leg (continuation vs mean-reversion vs news) breakdown.
- Sensitivity of pass % to RR, SL size, contracts, and which legs are on.

## 7. Anti-overfitting guardrails (treat as a hard requirement)

The user plans to iterate daily to "find something that works." That is exactly the process that produces a curve-fit strategy that passes the backtest and fails live. Build the framework so honesty is the default:

- **Chronological split:** reserve the most recent ~30–40% of data as an **out-of-sample (OOS) holdout** that is never used for tuning. Report in-sample and OOS pass % side by side, always.
- **Walk-forward** validation as the headline evaluation, not a single optimized run.
- **Parameter budget:** log how many free parameters a config has; warn loudly when it's high relative to the number of independent trades/sessions.
- **Realistic frictions on by default:** commissions, slippage (ticks), and no-look-ahead. Never report a "clean" fill result without frictions.
- Prefer configs that are **robust across neighbors** in parameter space over single sharp optima.

When a result looks good, the first question in any summary must be: "Is this in-sample or out-of-sample, and how many parameters bought it?"

## 8. Conventions

- Money in account-currency USD; price distances in points; risk in R.
- All times tz-aware UTC internally; convert only at session boundaries and for display.
- Config-driven, no magic numbers in logic.
- Every engine/strategy change ships with a test. No-look-ahead and prop-rule tests are mandatory and must stay green.
- Commit small, phase by phase (see BUILD_PROMPTS.md).
