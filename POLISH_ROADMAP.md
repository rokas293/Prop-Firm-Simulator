# POLISH_ROADMAP.md — TradeSea-style UX upgrade for the backtest viewer

Goal: no live trading, no prop firm — just make the existing app **cleaner, smoother, and more advanced to use**, borrowing UX patterns from TradeSea (Station + Compass). Same workflow as before: put this file in the repo next to `VIZ_SPEC.md`, paste each phase into Claude Code, verify, commit, move on.

Scope guardrail: this is a **polish/UX** effort on the existing React + Lightweight Charts + FastAPI app. It does not change the engine, the run-bundle contract, or the "frontend does zero financial math" rule from `VIZ_SPEC.md`. We're borrowing *design patterns* from TradeSea, not its code or branding.

## Design north star (from TradeSea)

- **Clean, customizable, intuitive — but powerful.** A beginner can read it; an advanced user can bend it to their flow.
- **Workspace, not fixed tabs.** "Build a workspace that fits your flow — drag and drop widgets, resize panels, choose your colors."
- **Fast is a feature.** Interactions should feel instant; nothing janky on pan/zoom or panel resize.
- **The chart is the hero.** Everything else supports reading price and trades.

Order below leads with the things that match your stated priorities (smoothness + chart display + a customizable, clean layout); analytics and theming come after.

---

## Phase P1 — Workspace shell (dockable, resizable, saveable panels + command palette)

```
Read VIZ_SPEC.md. We're doing a UX upgrade (POLISH_ROADMAP.md) — no engine or data-contract changes. Replace the current fixed tab layout with a customizable workspace inspired by TradeSea Station.

- Introduce a dockable/resizable panel system (use a mature lib — e.g. dockview or rc-dock; pick one and justify briefly). Panels: Chart, Trade List, Dashboard, Prop Risk, Equity. User can drag to rearrange, resize, split, pop panels in/out, and close/add them from a "+" menu.
- Save named layouts to localStorage; provide 2-3 presets ("Analysis", "Chart-focused", "Stats") plus a "reset layout". Restore the last layout on load.
- Add a command palette (cmdk) opened with Cmd/Ctrl-K: fuzzy actions like "open run…", "jump to trade #", "switch instrument", "toggle replay", "add panel…", "switch layout…".
- Establish a small design-token layer (Tailwind theme: spacing scale, radius, elevation, a refined dark palette) and apply consistent panel chrome (title bar, drag handle, subtle borders). Keep the current dark theme but tighten typography and spacing.

Keep all existing functionality working inside the new panels. Verify: rearrange + resize + save a layout, reload, confirm it restores; command palette navigates correctly. Add a store test for layout persistence.
```

---

## Phase P2 — Chart display upgrade (smoother, drawing tools, multi-chart)

```
Read VIZ_SPEC §8 (Lightweight Charts v5 — use current API). Upgrade the chart to feel like a pro charting surface:

- Smoothness: ensure buttery pan/zoom on 1m data — request bars for the visible window + margin, keep series updates incremental (setData only on range change, update() for appends), debounce refetch, and confirm no full re-renders on interaction.
- Drawing tools: add a drawing layer over the chart (Lightweight Charts has no built-in drawing tools — implement via its plugin/primitives API or a synced overlay canvas). Support horizontal line/ray, trendline, rectangle/zone, and a measure tool (price %/points + bars + time). Drawings snap to price/time, persist per instrument in localStorage, and are individually deletable.
- Multi-chart / split view: allow 2 charts in the Chart panel (e.g. 1m + 15m of the same instrument) with a synchronized crosshair and time range. 
- Crosshair readout: OHLCV + indicator values in a compact legend that updates on hover.

Verify on a known run: drawings persist across reload, the measure tool reports correct point/percent distances, and the split charts stay time-synced. Keep markers/SL-TP lines from earlier phases intact.
```

---

## Phase P3 — On-chart trade brackets & richer trade visuals (TradeSea "PnL brackets")

```
Read VIZ_SPEC. Make each trade read at a glance on the chart, TradeSea-style:

- Render every trade as an entry→exit "bracket": a shaded zone from entry to exit, green above/red below relative to entry by outcome, with the SL zone and TP zone lightly shaded too. Label with R and $PnL.
- Hover a bracket → tooltip with full trade detail (leg, session, side, entry/exit, exit_type, MAE/MFE, bars held).
- Selecting a trade in the Trade List highlights and frames its bracket; a subtle animation ("fit trade") eases the viewport to it rather than snapping.
- Add a density control so brackets can be simplified to just markers when zoomed out (avoid clutter over a full day of trades).

All values come from the run bundle (no recomputation). Verify a specific trade's bracket edges sit exactly on its entry/exit prices and times.
```

---

## Phase P4 — Performance & smoothness pass

```
Read VIZ_SPEC. Make the whole app feel instant.

- Move bar fetching/resampling off the main thread: a web worker (or streaming fetch) so pan/zoom never blocks the UI; show a subtle skeleton/loading shimmer instead of a freeze.
- Virtualize the Trade List (react-virtual) so thousands of rows scroll at 60fps.
- Memoize derived selectors; ensure panel resize/drag doesn't re-fetch or re-render unrelated panels.
- Add lightweight route/panel transitions and optimistic UI so switching runs/instruments feels immediate; prefetch a run's trades/stats when hovered in the runs list.
- Add a tiny perf HUD (toggle) showing render time / fetch time while developing.

Verify with a large run (e.g. the 1191-trade MNQ run): scroll the trade list, pan across a full day, switch timeframe — all smooth, no main-thread jank. Note before/after timings.
```

---

## Phase P5 — Compass-style analytics (behavioral & pattern insights)

```
Read VIZ_SPEC §7. Add a "Compass"-style analytics panel over the run's trades (still zero financial recomputation — read the bundle; only aggregate/describe):

- Pattern breakdowns: performance by time-of-day, by session, by leg, by weekday; win/loss streak distribution; hold-time buckets; performance by MAE/MFE regime (surfacing the "stops clipping winners" pattern explicitly).
- A simple, transparent "score" (define the formula in the UI — e.g. blend of expectancy, consistency, drawdown, and MAE efficiency) so it's explainable, not a black box.
- Optional AI insight: a "Summarize this run" button that sends the aggregated stats (not raw ticks) to an LLM and returns a short plain-English read of strengths/weaknesses. Make the endpoint/config optional so the app works without it.
- Cross-link: clicking any breakdown segment filters the Trade List + chart (reuse existing filter state).

Verify the breakdowns reconcile with the headline stats (e.g. session subtotals sum to the total). 
```

---

## Phase P6 — Theming, keyboard-first, and delight

```
Read VIZ_SPEC. Final polish for feel and personalization (TradeSea "choose your colors"):

- Theme system: a few curated dark themes + user-adjustable accent color and up/down candle colors, persisted. Ensure chart, panels, and native controls all follow the theme.
- Keyboard-first: comprehensive shortcuts (next/prev trade, toggle panels, switch timeframe, open palette, toggle replay), with a discoverable "?" shortcuts overlay.
- Micro-interactions: smooth panel open/close, hover states, focus rings, empty states with helpful hints, and consistent loading skeletons.
- Settings panel to manage layouts, themes, shortcuts, and data defaults.

Verify the app end-to-end: all existing tests green, themes apply everywhere including the chart, and the shortcuts overlay lists working bindings.
```

---

## Suggested libraries (let Claude Code confirm current versions)

- Panels/workspace: **dockview** or **rc-dock**
- Command palette: **cmdk**
- List virtualization: **@tanstack/react-virtual**
- Charts: keep **lightweight-charts v5** (+ its plugin/primitives API for drawings/brackets)
- Stats charts: keep **Recharts/ECharts**

## Working notes

- One phase at a time; commit after each; keep all prior tests green.
- Never let polish break the `VIZ_SPEC` rule: the frontend renders bundle data, it doesn't compute trades/PnL.
- After P1–P4 the app should already *feel* like a different tool. P5–P6 are the "advanced + personal" layer.
- If a phase is big, tell Claude Code to split it into sub-steps and verify each — smoothness work especially is easier to land incrementally.
```
