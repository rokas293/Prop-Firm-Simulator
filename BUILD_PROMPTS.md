# BUILD_PROMPTS.md — Copy-paste prompts for Claude Code

How to use this: put `CLAUDE.md` in your repo root first, then paste these prompts into Claude Code **one phase at a time**. Don't jump ahead — each phase ends with a test/verification step. Only move on when it's green. Commit after each phase.

Before Phase 0, tell Claude Code where your Databento files live and paste one sample (a few rows + the header/schema) so the loader is built around your actual format.

---

## Phase 0 — Scaffold, data loader, sessions

```
Read CLAUDE.md fully. Set up the project skeleton exactly as in section 5 (propbt/ package, tests/, run.py, a config/ folder with YAML). Use Python 3.11+, pandas, numpy, pyyaml, typer, pytest, matplotlib. Add a pyproject.toml and a README with run instructions.

Then implement the data layer only:
- data/loader.py: ingest my Databento 1-min files for MES and MNQ into a tidy, tz-aware UTC DataFrame (columns: open, high, low, close, volume; DatetimeIndex in UTC). Here is my file format: [PASTE SAMPLE ROWS + SCHEMA]. Handle contract rolls per CLAUDE.md — flag roll days and never merge across a roll silently.
- data/resample.py: resample 1m up to arbitrary higher timeframes (5m, 15m, etc.) with correct OHLCV aggregation.
- data/sessions.py: given a config of session anchors in America/New_York (NY 09:30, London 03:00, Asia 20:00 as defaults), return per-day session windows, compute the "fair value" (close of the 1-min bar immediately before each open), and expose helpers to tag each bar with its active session. Handle DST correctly.

Write a small CLI command `python run.py inspect --symbol MES --date 2025-03-10` that prints that day's sessions, fair values, and a data-integrity summary (gaps, duplicate timestamps, roll flags).

Add pytest tests for: tz/DST correctness, resampling aggregation, fair-value selection, and a no-gap/no-duplicate data integrity check. Run the tests and show me the output. Do not build any strategy or engine yet.
```

---

## Phase 1 — Engine core + Topstep prop-rule tracker

```
Read CLAUDE.md. Build the event-driven backtest engine and the Topstep rule tracker. No trading strategy logic yet — drive it with a trivial placeholder strategy (e.g., random or always-flat) just to exercise the machinery.

Requirements:
- engine/events.py: typed Bar, Signal, Order (market/limit/stop, with static SL/TP in points), Fill.
- engine/broker.py: fills at bar t+1 open (or limit/stop fills within t+1), slippage in ticks (config), round-turn commissions per contract (config), and enforce the 50-micro position limit. Use the MES/MNQ contract specs from CLAUDE.md for $ conversion.
- engine/portfolio.py: track realized PnL and live intraday equity (realized + open PnL) on every bar.
- engine/prop_rules.py: implement the Topstep $50k Combine rules from CLAUDE.md section 3 EXACTLY — trailing MLL (EOD trail, freeze at 52k -> 50k), intraday breach check on live equity every bar (breach = fail), $1,000 daily loss lock (locks the day, not a fail), $3,000 target, and the 50% consistency check evaluated when target is hit. Return a structured result: passed / failed + reason + day-by-day log.
- engine/backtester.py: the bar loop that guarantees decisions on bar t use only data <= t close and executes at t+1. This is critical.

Tests (mandatory, must pass):
- A no-look-ahead test proving a strategy cannot use bar t's close to fill at bar t.
- Prop-rule edge cases: MLL trails then freezes at exactly 52k; intraday breach fails even if EOD would've been fine; daily loss lock stops trading and resumes next day; consistency rule blocks a pass where one day is >50% of profit.
Run all tests and show output.
```

---

## Phase 2 — Session-open continuation leg

```
Read CLAUDE.md. Implement strategy/base.py (Strategy interface: on_bar(state) -> orders) and strategy/session_open.py with ONLY the open-spike continuation leg for now:

- At each session open (Asia/London/NY), determine spike direction using a configurable method (sign of first-bar close vs fair value, OR first-N-min displacement — make it a switch).
- Take exactly ONE continuation trade in the spike direction. Static SL and TP in points; RR selectable {1:1, 1:1.5, 1:2}; contracts and SL-point size from config.
- Everything parameterized in config/, nothing hardcoded.

Wire it into the backtester. Add a CLI `python run.py backtest --config config/continuation.yaml` that runs over a date range and prints: number of trades, win rate, expectancy in $ and R, per-session breakdown, and the Topstep result (pass/fail + reason).

Add tests: correct entry direction/timing, SL/TP hit accounting, no-look-ahead preserved. Run a backtest on my in-sample data range and show me the summary. Do NOT tune parameters yet — just prove the leg works.
```

---

## Phase 3 — Mean-reversion leg

```
Read CLAUDE.md. Add the post-impulse mean-reversion leg to strategy/session_open.py:

- After the open impulse, detect consolidation (range/ATR compression over K bars and/or volume below rolling average — configurable).
- Detect break of structure (close beyond the most recent swing high/low; swing = local extreme over w bars each side).
- On BoS, take up to 3 mean-reversion trades fading back toward fair value / session VWAP. Direction logic ("fade the break" vs "join then fade") is a tested config switch. Static SL/TP in points, config-driven.

Keep the continuation leg working; legs are independently togg(le)able in config. Update the backtest summary to break results down by leg (continuation vs mean-reversion). Add tests for swing/BoS detection and consolidation detection. Run a backtest and show the per-leg breakdown.
```

---

## Phase 4 — News-spike leg

```
Read CLAUDE.md. Implement data/news.py to load a news_events.csv (UTC timestamp, event, impact; format-tolerant) and strategy/news_spike.py that applies the same continuation + mean-reversion logic around high-impact events. Filter to high-impact by default via config. Wire it in as another toggleable leg with its own params. Add tests for the news loader and for event-window entry timing (still no look-ahead). Run a backtest with news enabled and show the breakdown. I will provide the news CSV — build the loader to my format: [PASTE SAMPLE].
```

---

## Phase 5 — Combine simulation, Monte Carlo, walk-forward, reporting

```
Read CLAUDE.md, especially sections 6 and 7. Build the evaluation layer — this is the point of the whole project:

- sim/combine.py: simulate one full Combine attempt from a given start date until pass or fail.
- sim/monte_carlo.py: run many attempts over rolling/sampled start dates; report % passed (target + consistency + no breach), distribution of days-to-pass, and fail-reason distribution.
- sim/walk_forward.py: chronological in-sample optimize / out-of-sample validate, using the OOS holdout defined in CLAUDE.md. Report in-sample vs OOS pass % side by side.
- reporting/metrics.py + plots.py: expectancy ($ and R), win rate, per-session and per-leg breakdown, equity-curve and outcome-distribution plots, and a one-page summary.

Enforce the anti-overfitting guardrails from section 7: commissions + slippage + no-look-ahead always on; log the parameter count and warn when high; make the headline number the OUT-OF-SAMPLE pass %, never in-sample. Add a CLI `python run.py evaluate --config <cfg>` that prints the full report. Run it and show me the summary, clearly labeling in-sample vs out-of-sample.
```

---

## Phase 6 — Iteration loop (your daily workflow)

Once Phase 5 works, your daily experiment is just: edit a config (RR, SL points, which legs, thresholds), run `evaluate`, and compare **out-of-sample** pass %. Rules of the road:

- Judge everything on OOS, not in-sample. If OOS pass % collapses vs in-sample, you've overfit — simplify.
- Change one thing at a time; keep a log of config → OOS pass %.
- Prefer parameter regions that are robust to small changes over single sharp peaks.
- Keep commissions and slippage honest — they're the difference between a backtest edge and a real one.
- Re-verify Topstep's rules periodically; if they change, update `prop_rules.py` and CLAUDE.md together.
```
