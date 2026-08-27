# REDESIGN_APPROACH.md — high-end redesign: TradingView charting, clean dashboard, deep theming

A long-project plan for three things: (1) migrate the price chart to **TradingView Advanced Charts** so you get the TradeSea/Topstep left drawing toolbar + 110+ tools + built-in indicators, and kill the buggy hand-built drawings; (2) **declutter the dashboard** into a calm, well-ordered surface; (3) build a **unified theming system** where every color is customizable but the result stays clean.

Workflow unchanged: this file lives in the repo next to `VIZ_SPEC.md`; paste each phase into Claude Code, verify, commit, advance. Take it slow — each phase is a real chunk.

## Principles

- **Adopt, don't rebuild.** The chart engine gives you drawings/indicators/replay for free. Your job is integration + your own trade overlays, not reimplementing a charting suite.
- **The engine stays the source of truth.** Per `VIZ_SPEC.md`, the frontend still renders run-bundle data; it does no financial math. TradingView renders bars + your trades; it doesn't recompute anything.
- **Clean = constrained.** Deep customization stays clean by routing everything through a small token system with sensible defaults and contrast guardrails — users tune tokens, not 200 individual element colors.
- **One migration risk at a time.** The chart swap is the riskiest work; isolate it, keep the old chart until the new one reaches parity, then delete.

---

# PART A — Migrate the price chart to TradingView Advanced Charts

> Note on editions: the **free Advanced Charts** library is a single-chart widget — perfect for our chart panel, with the full drawing toolbar, built-in studies, and Bar Replay. Native multi-chart grid layouts are a paid Trading Platform feature; our "split view" will run two widget instances side by side (Phase A5). The library is free and self-hosted but gated behind a quick access request and a license you must accept (keep attribution, don't redistribute the source).

## Phase A0 — Access, vendor, and a bare chart on your data

```
Read VIZ_SPEC.md and REDESIGN_APPROACH.md. We are migrating the price chart from lightweight-charts to the TradingView Advanced Charts library. This phase: get a bare chart rendering our data. Do NOT remove lightweight-charts yet — build the new chart alongside it behind a feature flag so we can compare.

Steps:
1. Document the access step for me: where to request the free Advanced Charts library, and where to place the self-hosted static bundle in the repo (e.g. app/frontend/public/charting_library/). Assume I will download it and drop it in; scaffold the folder + a README note. Do not commit the vendor bundle (gitignore it) — note that I must supply it.
2. Build a custom JS Datafeed (implements onReady, resolveSymbol, searchSymbols, getBars, subscribeBars, unsubscribeBars) that calls our EXISTING FastAPI endpoints (/api/bars etc.). Map symbols MES/MNQ/ZN and map the library's resolutions (1,5,15,60...) to our resample timeframes. Respect the sparse-bar handling for ZN from CLAUDE.md (return real gaps; do not synth bars).
3. Mount the widget in a new React ChartTV component with theme:'dark', in a feature-flagged panel. Timeframe switching, symbol switching, zoom/pan working from real data.
4. Verify: candles for all three instruments match the old chart for a known day/range (spot-check OHLC of a few bars against the bundle). Show me the bars you verified. Keep everything else working.
```

## Phase A1 — Put trades on the TradingView chart (parity with the old chart)

```
Read REDESIGN_APPROACH.md Part A. Re-implement our trade visuals on the TradingView widget so it reaches parity with the old chart, then we can retire lightweight-charts for price.

- Entry/exit: use createExecutionShape (buy/sell arrows with price, time, tooltip text) for each trade from the run bundle.
- SL/TP: draw as shapes (horizontal line or rectangle zone) via createShape/createMultipointShape, colored by our conventions.
- Trade dots on bars: optionally use the datafeed getMarks() to show a round mark per trade for quick scanning.
- Interaction: clicking a trade in the Trade List scrolls/zooms the chart to that trade (setVisibleRange / scrollToTime on the active chart) and highlights its shapes. "Fit trade" and "Full day" behaviors preserved.
- All values come from the bundle — no recomputation. Guard every widget call behind the chart being ready and having data (this is the bug class from the split-view/Fit-trade crashes — same discipline here).

Verify a specific trade: its entry arrow sits on the correct bar/price and SL/TP shapes match the bundle values. Once parity is confirmed, remove lightweight-charts from the price chart (keep Recharts/ECharts for the stats panels) and drop the feature flag. Show me the trade you verified.
```

## Phase A2 — Full drawing toolbar (the whole point)

```
Read REDESIGN_APPROACH.md Part A. Enable and wire up the built-in drawing system — this replaces ALL the old hand-built drawings.

- Enable the left drawing toolbar and the full tool set (trend/ray/extended lines, horizontal & vertical lines, parallel channel, pitchfork, all Fibonacci tools, Gann, rectangles/ellipses/triangles/paths, brush/highlighter, arrows, text/callout/note, long/short position tools, price range, date range, measure, icons). Confirm the toolbar matches the TradeSea/Topstep look.
- Persistence: implement the save/load adapter so drawings (and the chart layout/studies) save per instrument (and optionally per run). Use widget.save()/load() serialized to our backend or localStorage; auto-save on change; restore on load.
- Drawing templates + a "clear all drawings" action. Keyboard shortcuts for common tools.
- Delete the old custom drawing engine and its buggy code paths entirely.

Verify: place several tool types, reload, confirm they persist; confirm the measure tool reports correct points/%/bars; confirm deleting the old drawing code didn't break trade shapes from A1. List which old drawing features are now covered by built-ins (should be all + far more).
```

## Phase A3 — Indicators via built-in + custom studies

```
Read REDESIGN_APPROACH.md Part A and CLAUDE.md §4. Move indicators onto the library.

- Use built-in studies for VWAP, moving averages (EMA20/50), ATR(14), volume — no custom code needed.
- For our strategy-specific overlays that must match engine logic (session shading Asia/London/NY, session-anchored fair-value lines, session VWAP anchored at the CME open), implement Custom Studies (Custom Studies API) OR draw them as shapes from data our backend already computes (/api/sessions, /api/indicators) — prefer pulling from the backend so they exactly match the engine.
- Provide an indicator toggle UI (can reuse the library's own indicators dialog) and persist choices with the chart layout.

Verify session shading boundaries line up with the CME/session times in CLAUDE.md and fair-value lines match the engine's values for one session end-to-end.
```

## Phase A4 — Replay (adopt the built-in)

```
Read REDESIGN_APPROACH.md Part A. Replace our custom replay with the library's built-in Bar Replay.
- Enable Bar Replay; ensure our trade shapes/marks reveal correctly as the replay cursor advances (no look-ahead: nothing after the cursor shown) and a small live PnL/R + distance-to-MLL readout tracks the cursor (fed from the equity bundle).
- Retire the custom replay component if the built-in covers it; otherwise document the gap and keep a thin custom layer only for the PnL readout.
Verify at a chosen cursor time only bars/trades ≤ cursor are visible. 
```

## Phase A5 — Split / multi-chart

```
Read REDESIGN_APPROACH.md Part A (edition note). Implement split view as TWO Advanced Charts widget instances side by side (native grid layouts are a paid edition we're not using).
- Sync symbol and (optionally) visible time range between the two; independent timeframes (e.g. 1m + 15m). Crosshair sync if feasible via the library's crosshair API; if not, document the limitation.
- Reuse the ready/has-data guards so mounting the second widget can never crash the app (this is exactly the failure you already hit — enforce it structurally here).
Verify rapid toggling of split view never crashes and the two charts stay symbol-synced.
```

---

# PART B — Declutter the dashboard

Your read is right: it's doing too much at once. The fix is information hierarchy and progressive disclosure, not deleting data. This part is independent of Part A and can be done first for a fast visible win.

## Phase B1 — Audit + redesign (wireframe before code)

```
Read VIZ_SPEC.md §7 and REDESIGN_APPROACH.md Part B. Before changing code, produce a short redesign proposal for the dashboard (as a markdown doc + a simple wireframe description):
- Inventory every element currently on the dashboard and classify each: HERO (always visible), SECONDARY (one click away), or REMOVE/duplicate.
- Propose ~5 hero KPIs only (e.g. net R, win rate, expectancy, max drawdown, result/pass-fail) in a calm top row. Everything else grouped into collapsible sections or tabs (Breakdowns, Distributions, Risk, Trades).
- Reduce the number of charts shown simultaneously; one primary visual (equity curve) visible by default, the rest behind tabs.
- Define a single consistent card component, a spacing scale, and one accent color. Kill redundant borders/badges.
Give me the proposal to approve before implementing. Do not code yet.
```

## Phase B2 — Implement the calm dashboard

```
Read the approved B1 proposal. Implement it:
- One consistent Card primitive; a top KPI row (hero metrics only); secondary content in tabs/accordions with lazy rendering.
- Generous whitespace, one accent color, restrained typography (a clear type scale), muted secondary text. Remove duplicate/never-used visuals.
- Keep all data reachable — nothing deleted, just demoted. Cross-links to Trade List/chart preserved.
Verify KPIs reconcile with the run bundle and every previously-shown stat is still reachable within one interaction. Show me before/after.
```

---

# PART C — Unified theming & deep customization (clean, not chaotic)

Goal: change the background and the color of everything, fully customizable, still clean. The trick is a **token system**: a small set of semantic color tokens drives the whole app AND the TradingView chart. Users edit tokens (with guardrails), not individual elements.

## Phase C1 — Token foundation (do this after the chart migration so it can theme the new chart too)

```
Read REDESIGN_APPROACH.md Part C. Establish a semantic design-token system and make the whole app consume it.
- Define CSS-variable tokens: --bg, --surface, --surface-2, --border, --text, --text-muted, --accent, --positive, --negative, --up-candle, --down-candle, --grid, --selection. Add a light/dark base and spacing/radius/elevation tokens.
- Refactor the app so NO component hardcodes a color (you already found a stray accent-blue-600 on the replay scrubber — hunt down all of them; add an ESLint rule or test that fails on raw hex/tailwind color literals in components).
- Recharts/ECharts stats charts read tokens too.
Verify by flipping token values at runtime and seeing the entire app (except the chart, next phase) recolor consistently. Add a test that no component references a non-token color.
```

## Phase C2 — Theme editor

```
Read REDESIGN_APPROACH.md Part C. Build a Theme Editor panel:
- Color pickers for each semantic token with LIVE preview across the app; a few curated presets (e.g. Midnight, Slate, Paper-dark, high-contrast); "reset to preset".
- Guardrails that keep it clean: enforce a minimum text/background contrast ratio (warn or auto-adjust), and derive hover/active/border shades from base tokens so users set a few colors, not dozens.
- Persist the active theme to localStorage; import/export a theme as JSON.
Verify a user can set a custom background + accent, reload, and it persists; contrast guardrail triggers on a bad combo.
```

## Phase C3 — Theme the TradingView chart from the same tokens

```
Read REDESIGN_APPROACH.md Part C and Part A. Make the chart obey the theme tokens so the whole product feels like one surface.
- Map tokens → the widget's overrides (paneProperties.background, gridProperties, candle up/down/border/wick colors, scales text) and studies_overrides, plus a custom_css_url for the library's toolbars/dialogs so they match --surface/--text/--accent.
- Re-apply overrides live when the theme changes (recreate or applyOverrides on the widget) without losing the user's drawings/layout.
Verify: change the theme's background + candle colors and confirm the chart (background, grid, candles, toolbars) updates to match the rest of the app, drawings intact.
```

---

## Suggested sequencing for the whole project

1. **B1–B2 first** (dashboard declutter) — fast, independent, immediate relief from "too much going on."
2. **A0–A2** — the core chart migration + full drawing toolbar (the headline). A2 is the moment the drawings problem is truly solved.
3. **A3–A5** — indicators, replay, split view on the new chart.
4. **C1–C3** — token system, theme editor, then theme the migrated chart last so it's included.

Commit after every phase; keep all tests green; retire old code only after the replacement reaches verified parity.

## Risks & notes

- **Access gate:** you must request the Advanced Charts library and self-host it; the vendor bundle isn't on npm. A0 assumes you supply it. Keep it gitignored.
- **Edition limits:** single chart per widget; multi-chart grids and some trading-terminal features are paid — we route around this (two widget instances for split).
- **Parity discipline:** don't delete lightweight-charts or the old drawing/replay code until the TradingView equivalent is verified. This keeps you from a half-migrated broken state.
- **The crash class you already fixed** (calling chart methods before data/ready) applies doubly to a library you don't control — guard every `widget`/`activeChart()` call behind ready + has-data. Bake it into a small helper so it's impossible to forget.
- **Keep the `VIZ_SPEC` contract:** frontend renders bundle data only; theming/chart changes never touch engine math.

---
Sources: [TradingView Advanced Charts (free, self-hosted, 110+ drawing tools)](https://www.tradingview.com/advanced-charts/), [Advanced Charts documentation](https://www.tradingview.com/charting-library-docs/latest/introduction/), [Free Charting Library overview](https://www.tradingview.com/free-charting-libraries/)
