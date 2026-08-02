# BUILD_PROMPTS_VIZ.md — TradingView-grade backtest viewer, phase by phase

Put `VIZ_SPEC.md` in the repo (next to `CLAUDE.md`) first. Paste these into Claude Code **one phase at a time**, in order. Each phase ends with something you can open and see, plus tests. Only advance when it's green, and **commit after each phase**.

Order follows your feature priorities (dashboard → prop overlay → indicators → replay) after the foundation phases that everything else depends on.

---

## Phase V0 — Run bundle + backend API + frontend scaffold

```
Read CLAUDE.md and VIZ_SPEC.md fully. We're building the local web app in VIZ_SPEC. Do NOT touch strategy logic or change backtest results.

1. Add propbt/reporting/run_bundle.py that writes a run bundle to runs/<run_id>/ exactly per VIZ_SPEC §3–§5: meta.json, trades.parquet (schema §4, INCLUDING mae_points/mfe_points/mae_r/mfe_r — compute max adverse/favorable excursion per trade from the bars while the position was open), equity.parquet (§5, per-bar equity + mll_floor + daily_loss_floor + target_level + breached/daily_locked). Change `run.py review` to emit a bundle instead of the 19MB HTML. Add a test asserting the bundle's trades equal the in-memory backtest trades (no divergence) and that engine results are unchanged.

2. Build the FastAPI backend in app/backend per §1–§6: routers for /api/runs, /api/runs/{id}, /api/runs/{id}/trades, /api/runs/{id}/equity, /api/runs/{id}/stats, /api/bars, /api/sessions. Reuse propbt's loader/resampler for bars; /api/bars must downsample wide windows by resampling to a coarser timeframe (never dump 1.7M rows). Pydantic models for all responses. Times as UNIX seconds UTC.

3. Scaffold the frontend in app/frontend: Vite + React + TypeScript + Tailwind + TanStack Query + Zustand. Vite dev proxy to the backend. Build ONE page for now: a runs list that fetches /api/runs and shows each run's instrument, date range, and pass/fail. Add a `make dev` (or npm script) that starts backend + frontend together.

4. Tests: backend endpoint shape tests against a fixture bundle; a known-value spot check. Run them and show output. Then tell me the exact commands to start the app and confirm the runs list loads.
```

---

## Phase V1 — Core chart: candles, timeframes, trade markers, SL/TP

```
Read VIZ_SPEC, especially §8 (Lightweight Charts v5 gotchas — use the CURRENT v5 API, check the official docs, do not use removed methods like addCandlestickSeries or series.setMarkers).

Build the chart view for a selected run:
- Candlestick series from /api/bars with a timeframe switch (1m/5m/15m/1h), zoom (scroll) and pan (drag), crosshair. A volume series in its own pane.
- Load the run's trades from /api/trades. For each trade: entry marker (arrow, up/down by side) and exit marker (colored by win/loss) via createSeriesMarkers; SL and TP as price lines via createPriceLine; shade the time span the position was open.
- "Fit trade" (zoom to a trade's window) and "Full day" buttons.

Critical: markers and lines must align exactly to bar timestamps (this is where the old custom canvas drifted — Lightweight Charts aligns by time natively, so feed correct UNIX-second times). Verify by loading a known run and confirming a specific trade's entry marker sits on the correct bar and the SL/TP lines match trades.parquet values. Show me the run + trade_id you verified against.
```

---

## Phase V2 — Trade list panel + cross-linked navigation

```
Read VIZ_SPEC. Add a trade list panel beside the chart:
- Sortable table of all trades (columns: entry time, leg, session, side, size, entry, exit, exit_type, pnl_usd, R, mae_points, mfe_points). Click a column header to sort.
- Filters: leg, session, side, win/loss, exit_type, date range. Filtering updates BOTH the table and the markers shown on the chart (hidden trades' markers disappear).
- Click a row → chart pans/zooms to that trade (reuse "Fit trade") and highlights its markers/lines.
- Keep everything driven by /api/trades query params where practical; use Zustand for the shared filter/selection state.

Verify: apply a filter (e.g. leg=mean_reversion, session=london) and confirm table rows and chart markers match, and clicking a row navigates correctly. Add a frontend test for the filter/selection store.
```

---

## Phase V3 — Performance dashboard  (your priority #1)

```
Read VIZ_SPEC §7. Build a dashboard view (tab or split-pane) fed by /api/stats:
- Headline KPIs: net PnL ($ and R), win rate, expectancy/trade, profit factor, max drawdown, trades, trading days, result (pass/fail + reason + days-to-fail).
- Breakdown tables: per leg and per session (count, win rate, expectancy, total R).
- Charts (Recharts or ECharts, NOT Lightweight Charts): R-multiple histogram; equity curve; drawdown curve; and an MAE-vs-MFE scatter colored by outcome.
- An in-sample / out-of-sample / all toggle (scope param) — OOS is the headline per CLAUDE.md §7; label it clearly.
- Cross-link: clicking a leg/session in a breakdown filters the trade list + chart (reuse V2 filter state).

The MAE/MFE scatter must make the "stops too tight?" question visible: highlight trades with high MFE that exited at SL (would've won but got stopped). Verify KPIs against a fixture run's known stats. Show me the numbers you checked.
```

---

## Phase V4 — Prop-firm risk overlay  (your priority #2)

```
Read CLAUDE.md §3 and VIZ_SPEC §5. Build an equity/risk view from /api/equity:
- Plot account equity over time with three reference lines: the trailing MLL floor, the daily loss limit floor (per trading day), and the profit target. Use the CME 18:00-ET trading-day boundary from CLAUDE.md.
- Shade the gap between equity and the MLL floor as a "distance to breach" band; the thinner it gets, the closer to failing.
- Mark the exact bar/day the run breached (fail point) and mark days where the daily loss lock triggered.
- A per-day "risk" strip: for each trading day, its lowest distance-to-MLL — so you can scan which days nearly killed the run.
- Clicking a day jumps the main price chart (V1) to that trading day.

Verify against a fixture run that fails: the breach marker must sit exactly where equity.parquet has breached=true. Show me that alignment.
```

---

## Phase V5 — Indicator overlays  (your priority #3)

```
Read VIZ_SPEC §6/§8 and CLAUDE.md §4. Add indicator overlays from /api/indicators, all COMPUTED SERVER-SIDE by reusing propbt so they exactly match strategy logic:
- Session background shading for Asia/London/NY (from /api/sessions), plus a fair-value price line per session.
- Session-anchored VWAP, EMA(20), EMA(50) as overlay lines; ATR(14) in its own pane.
- A toggle panel to show/hide each indicator; remember choices in localStorage.

These exist so each trade can be read in context (was the continuation trade with or against VWAP? did mean-reversion fade back to fair value?). Verify the session shading boundaries line up with the CME/session times in CLAUDE.md, and that fair-value lines match the values the engine used for those sessions. Show me one session verified end to end.
```

---

## Phase V6 — Bar-by-bar replay  (your priority #4)

```
Read VIZ_SPEC §0 (no look-ahead) and §8. Add a replay mode to the chart:
- Controls: play/pause, step forward/back one bar, speed control, and a scrubber. A "replay cursor" time reveals only bars up to the cursor (no future bars visible).
- As the cursor passes a trade's entry_time, its entry marker/SL/TP appear; at exit_time the exit marker appears. A live readout shows running PnL/R and current equity vs the MLL floor at the cursor.
- Strictly no look-ahead: nothing after the cursor time may be drawn or used.

Verify: at a chosen cursor time, only bars ≤ cursor are shown and only trades entered ≤ cursor are marked. Add a test for the cursor-filtering logic.
```

---

## Phase V7 — Multi-instrument, run compare, polish

```
Read VIZ_SPEC. Final polish phase:
- Instrument switch (MES/MNQ/ZN) wherever a run spans one instrument; respect the sparse-bar handling for ZN from CLAUDE.md.
- Compare mode: overlay equity curves of two runs, and a side-by-side stats table — so you can see e.g. the MES vs MNQ SL-scaling difference directly.
- Persist view state (selected run, timeframe, filters, indicator toggles) in localStorage; add keyboard shortcuts (next/prev trade, toggle replay, fit trade).
- Optional: a "export static snapshot" command that writes a single self-contained HTML for one run (the hybrid fallback) — only if cheap to add.
- Dark-theme polish pass.

Verify the app still runs end to end and all backend/frontend tests pass. Show me the final run/start instructions.
```

---

## Working notes (for your daily loop)

- Advance one phase at a time; commit after each. If a phase's verification fails, fix before moving on.
- Whenever a phase needs a number the frontend doesn't have, add it to the run bundle (engine side) rather than computing it in the browser — that's the §0 rule and it keeps the picture honest.
- Use this viewer to answer the MNQ stops-too-tight question first: check the MAE/MFE scatter (V3) and eyeball a few clipped trades in replay (V6) before you change any SL points in strategy.yaml.
- Keep judging strategy changes on **out-of-sample** stats (V3 toggle), never the pretty in-sample equity curve.
```
