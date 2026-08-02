# VIZ_SPEC.md — TradingView-grade Backtest Review App

Persistent context for Claude Code, alongside `CLAUDE.md`. Read both before every viz task. This describes the *viewer*; `CLAUDE.md` still governs the strategy, data, and Topstep rules. Keep this file updated as the app evolves.

## 0. Guiding principles

- **The engine is the single source of truth.** `propbt` runs the backtest and emits a structured *run bundle*. The app only *renders* that bundle — it never recomputes trades, PnL, or prop-rule state. If the chart and the stats ever disagree, that's a bug in rendering, not a judgment call. This is what makes the visual layer trustworthy.
- **Everything the eye needs, the bundle carries.** If a feature needs a number (MAE/MFE, session tag, MLL floor at time T), the engine computes it and writes it to the bundle. The frontend does zero financial math.
- **Big data by default.** 1.7M+ bars per instrument. Never ship all bars to the browser at once — the API serves windows and downsamples. The 19MB self-contained HTML is the anti-pattern we're replacing.
- **No look-ahead in the picture either.** Replay and indicator overlays must respect the same "data ≤ bar t" rule as the engine (see `CLAUDE.md` §2).

## 1. Tech stack

- **Backend:** Python **FastAPI** + uvicorn, importing the existing `propbt` package. Reads run bundles and parquet bars (via existing `data/loader.py` + `resample.py`). Serves JSON over REST. Pydantic models for every response.
- **Frontend:** **Vite + React + TypeScript**. Charting: **TradingView `lightweight-charts` v5**. Data fetching: **TanStack Query** (React Query). UI state (selected run, filters, replay cursor): **Zustand**. Styling: **Tailwind**. Stats charts (histograms, bars): **Recharts** or **ECharts** (Lightweight Charts is for price/time series only).
- **Dev:** `uvicorn` on :8000, Vite dev server on :5173 with a proxy to `/api`. One `make dev` / npm script to run both. Keep a `hybrid` static-snapshot export as an optional later feature, not the primary path.

## 2. Repo layout additions

```
propbt/               # existing engine — emits run bundles now
  reporting/
    run_bundle.py     # NEW: write/read the structured run bundle
runs/                 # NEW: one folder per backtest run (gitignored)
  <run_id>/
    meta.json         # config name, instrument, tf, date range, IS/OOS split, pass/fail
    trades.parquet    # one row per trade (schema §4)
    equity.parquet    # per-bar equity + prop-rule floors (schema §5)
    stats.json        # aggregate + per-leg/per-session breakdowns
app/
  backend/
    main.py           # FastAPI app
    api/              # routers: runs, bars, trades, equity, stats, indicators, sessions
    services/         # bundle reader, bar server, indicator compute (reuse propbt)
    models.py         # pydantic response models
    tests/
  frontend/
    src/
      chart/          # Lightweight Charts wrapper, markers, price lines, panes
      panels/         # trade list, dashboard, prop overlay, replay controls
      state/          # zustand stores
      api/            # typed client + React Query hooks
      App.tsx
    index.html, vite.config.ts, tailwind.config.js
```

## 3. Run bundle (engine output)

`propbt/reporting/run_bundle.py` writes `runs/<run_id>/`. `run_id` = timestamp + short hash of config. The backtest CLI (`run.py review`/`evaluate`) writes a bundle instead of an HTML. Bundles are the ONLY thing the app reads.

`meta.json`: `{ run_id, created_at, config_name, config_hash, instrument, base_timeframe, date_from, date_to, is_oos_split_date, result: {passed, fail_reason, days_to_fail}, params_count }`

## 4. Trade record schema (`trades.parquet`)

One row per trade. Engine fills all of it — frontend only displays:

`trade_id, entry_time (UTC), exit_time (UTC), instrument, side (long/short), leg (continuation/mean_reversion/news), session (asia/london/ny/news), trading_day (CME 18:00-ET day id), size_contracts, entry_price, exit_price, sl_price, tp_price, sl_points, tp_points, rr_planned, exit_type (tp/sl/time/eod/daily_lock), pnl_usd, r_multiple, commission_usd, mae_points (max adverse excursion), mfe_points (max favorable excursion), mae_r, mfe_r, bars_held`

> **MAE/MFE are important** — they directly answer your MNQ "are stops too tight?" question. If `mae_points` is routinely close to `sl_points` on trades that later would've hit TP (high `mfe_points`), the stop is clipping noise, not catching real losers. The dashboard surfaces this explicitly (§7).

## 5. Equity + prop-rule timeline (`equity.parquet`)

Per-bar (or per-event) rows so the prop overlay is exact:

`time (UTC), balance, open_pnl, equity (balance+open_pnl), mll_floor, daily_loss_floor, target_level, trading_day, day_start_balance, breached (bool), daily_locked (bool)`

This lets the app draw the trailing MLL, daily loss floor, and target as lines and mark the exact bar the run died — no recomputation.

## 6. API contract

All times as **UNIX seconds (UTC)** — Lightweight Charts' native time format. All money USD, distances in points, risk in R.

- `GET /api/runs` → list of `meta.json` summaries.
- `GET /api/runs/{id}` → full meta.
- `GET /api/runs/{id}/trades?leg=&session=&side=&result=&from=&to=` → filtered trade rows (§4).
- `GET /api/runs/{id}/equity?from=&to=` → equity/prop timeline (§5).
- `GET /api/runs/{id}/stats?scope=all|is|oos` → aggregate + breakdowns (§7).
- `GET /api/bars?instrument=&tf=&from=&to=&max_points=` → candles `{time,open,high,low,close,volume}`, downsampled to ≤ `max_points` by resampling to a coarser tf when the window is wide (never drop rows arbitrarily — resample honestly).
- `GET /api/indicators?instrument=&tf=&from=&to=&which=vwap,ema20,ema50,atr14` → line series, **computed server-side by reusing `propbt`** so they match strategy logic exactly (session-anchored VWAP especially).
- `GET /api/sessions?instrument=&from=&to=` → session windows (for background shading) + fair-value price per session.

Pydantic models for every response; generate/maintain matching TypeScript types on the frontend.

## 7. Stats / dashboard content (`stats.json` + `/stats`)

Headline KPIs: net PnL ($ and R), win rate, expectancy/trade, profit factor, max drawdown ($ and R), trades, trading days, result (pass/fail + reason + days-to-fail). Breakdowns: **per leg** and **per session** (count, win rate, expectancy, total R). Distributions: R-multiple histogram, MAE/MFE scatter (adverse vs favorable excursion, colored by outcome — the stop-tightness view). Always available with an **in-sample / out-of-sample / all** toggle (ties to `CLAUDE.md` §7 — OOS is the number that matters).

## 8. Lightweight Charts v5 — known gotchas (use current API, not old tutorials)

- v5 series creation is `chart.addSeries(CandlestickSeries, options)` / `chart.addSeries(LineSeries, ...)`, **not** the removed `chart.addCandlestickSeries()`.
- Markers moved to a primitive: use **`createSeriesMarkers(series, markers)`** from the markers module — `series.setMarkers()` was removed in v5.
- SL/TP lines: `series.createPriceLine({ price, color, lineStyle, title })`.
- Multi-pane (volume, ATR, equity): v5 supports panes — attach series to a pane index rather than the old overlay-scale hacks.
- Time is UNIX seconds UTC. Feed data sorted ascending; gaps are fine (Lightweight Charts handles missing minutes — good for sparse ZN).
- For "shade the open-position span" and session backgrounds, use a lightweight custom series/primitive or a background band plugin; don't fake it with candles.
- **Check the official Lightweight Charts v5 docs for the exact current signatures before coding** — the API changed meaningfully from v3/v4 and most web tutorials are stale.

## 9. Conventions

- Backend never trusts client for math; frontend never does financial math.
- Every endpoint has a test asserting response shape and a known-value spot check against a fixture run bundle.
- Keep the existing `propbt` tests green; adding the bundle emitter must not change backtest results (add a test: bundle trades == in-memory trades).
- Commit per phase. `runs/`, `node_modules/`, and large reports stay gitignored.
- Dark theme default; keep the chart the visual focus.
