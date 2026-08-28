# PART A (REVISED) — Chart migration to KLineCharts

**This supersedes Part A of `REDESIGN_APPROACH.md`.** TradingView Advanced Charts is licensed to companies only (no personal use), so we're using **KLineCharts** — open-source (Apache-2.0), a normal npm package, with built-in drawing overlays, indicators, and full theming. Parts B (dashboard, done) and C (theming) still stand; only Part C3 changes (see note at the end).

## Approach

- Use **core `klinecharts`** (the engine) + a **custom left drawing toolbar** built in our own React UI. Not the all-in-one `@klinecharts/pro` component — Pro ships its own symbol search / period bar / menus that would collide with our dockview panels, timeframe controls, and theme tokens. Core gives us every drawing tool as a built-in overlay; we drive them from a toolbar that matches our app shell.
- **A0 scaffolding carries over:** the datafeed against `/api/bars`, `instruments.ts` mapping, resolution↔timeframe map, and the engine-toggle store all stay. What goes away: the vendor-bundle folder, the access-request README, and the hand-written vendor `.d.ts` (klinecharts ships its own types via npm).
- Same migration discipline as before: build KLineCharts behind the existing engine flag, keep lightweight-charts working until parity is verified, then delete LWC + the old drawing engine.
- KLineCharts API differs across major versions (v9 vs v10). Tell Claude Code to confirm the installed version's API in the official docs (klinecharts.com) before coding each phase, rather than assuming signatures.

---

## Phase A0′ — Swap the TV stub for a real KLineCharts chart

```
Read PART_A_REVISED_klinecharts.md. We chose KLineCharts (open-source) instead of TradingView. Adapt the A0 scaffolding:

1. `npm install klinecharts` (confirm the version and check its current docs). Remove the now-unneeded vendor pieces from A0: public/charting_library/ README + gitignore entry, loadTvScript.ts, and the hand-written datafeedTypes.ts (use klinecharts' own types).
2. Replace the ChartTV component with a ChartKL component that initializes a klinecharts instance and loads candles from our existing datafeed logic against /api/bars (reuse the seconds→ms and resolution mapping already written). Keep the engine-toggle store but rename the non-LWC option to "KL"; default stays LWC.
3. Timeframe + symbol switching (MES/MNQ/ZN) working; respect ZN sparse bars from CLAUDE.md (real gaps, no synthetic fill). Wire the price precision from instruments.ts (pricescale/minmov) into klinecharts' price format.
4. Keep everything else working; hide LWC-only controls when KL is selected (as A0 already did for TV).

Verify: candles for all three instruments match the LWC chart for a known day/range — spot-check OHLC of a few bars against the bundle. Show me the bars you verified. tsc + tests + build clean.
```

## Phase A1 — Trades on the KLineCharts chart (parity, then retire LWC)

```
Read PART_A_REVISED_klinecharts.md. Bring the KL chart to parity with the old chart's trade visuals, then retire lightweight-charts for price.

- Entry/exit markers, SL/TP lines/zones, and the open-position shading: implement with klinecharts overlays (createOverlay) and/or registerOverlay for any custom shape not built in. Color per our conventions; all values from the run bundle (no recomputation).
- Clicking a trade in the Trade List scrolls the chart to it (scrollToTimestamp / scrollToDataIndex) and highlights its overlays; preserve "Fit trade" and "Full day".
- Reuse the ready/has-data guard discipline: never call into the klinecharts instance before it's initialized and has data (this is the exact crash class from split-view/Fit-trade — make a helper).

Verify a specific trade: entry marker on the correct bar/price, SL/TP overlays match bundle values. Once parity is confirmed, remove lightweight-charts from the price chart (keep Recharts/ECharts for stats panels) and drop the engine flag. Show me the trade you verified.
```

## Phase A2 — Left drawing toolbar + built-in drawing tools (the point)

```
Read PART_A_REVISED_klinecharts.md. Build the TradeSea/Topstep-style left drawing toolbar driving klinecharts' built-in overlays — this replaces ALL the old hand-built drawings.

- A vertical left toolbar (in our own React/theme, docked to the chart panel) with grouped tools: lines (horizontal, vertical, trend/segment, ray, extended, price line, parallel channel), Fibonacci (retracement, extension/trend-based, fan, time zones, circles if available), shapes (rectangle/zone, triangle, circle/ellipse, polygon/path), annotations (arrow, text/callout, note, price/measure), and any other built-in overlays klinecharts provides. Each button calls createOverlay for that overlay type.
- Selection, drag-to-edit handles, and delete come from klinecharts' overlay system — wire up select/remove and a "clear all drawings" action. Add keyboard shortcuts for common tools and Esc to cancel drawing.
- Persistence: serialize overlays (subscribe to overlay create/modify/remove events; use getOverlays or equivalent) and save per instrument (backend endpoint or localStorage); restore on load. 
- DELETE the old custom drawing engine and its buggy code paths entirely.

Verify: place several tool types, reload, confirm they persist; measure/price tools report correct points/%/bars; deleting old drawing code didn't break A1 trade overlays. List which old drawing features are now covered (should be all + many more).
```

## Phase A3 — Indicators (built-in + custom)

```
Read PART_A_REVISED_klinecharts.md and CLAUDE.md §4. Move indicators onto klinecharts.
- Built-in indicators (createIndicator) for MA/EMA, VWAP, ATR, volume — main-pane overlays vs sub-panes as appropriate.
- Strategy-specific overlays that must match engine logic (Asia/London/NY session shading, session-anchored fair-value lines): pull the values from our backend (/api/sessions, /api/indicators) and render as overlays or a custom indicator, so they match the engine exactly (do not recompute in the browser).
- Indicator toggle UI in our own panel; persist choices.
Verify session shading boundaries match the CME/session times in CLAUDE.md and fair-value lines match the engine's values for one session end to end.
```

## Phase A4 — Replay on KLineCharts

```
Read PART_A_REVISED_klinecharts.md and VIZ_SPEC §0 (no look-ahead). KLineCharts has no built-in bar-replay UI, so adapt our existing replay:
- Drive replay by feeding data up to the cursor (applyNewData with the slice ≤ cursor, or the incremental update API); reveal trade overlays as their entry/exit time is reached; nothing after the cursor drawn or used.
- Keep our replay controls (play/pause/step/scrubber/speed) and the live PnL/R + distance-to-MLL readout (from the equity bundle).
Verify at a chosen cursor time only bars/trades ≤ cursor are visible. Add a test for the cursor-slice logic.
```

## Phase A5 — Split / multi-chart

```
Read PART_A_REVISED_klinecharts.md. Split view = two klinecharts instances side by side.
- Sync symbol and (optionally) visible range; independent timeframes (e.g. 1m + 15m). Sync crosshair via klinecharts' action subscriptions if feasible; document any limitation.
- Enforce the ready/has-data guard so mounting the second instance can never crash the app (your prior split-view crash — prevent it structurally here).
Verify rapid split toggling never crashes and both charts stay symbol-synced.
```

---

## Part C3 change (theming the chart)

When you reach Part C3, theme the chart via **klinecharts `setStyles`** (candle up/down/border/wick, grid, background, crosshair, axis text, overlay colors) driven from the same design tokens — instead of TradingView overrides/custom_css. Re-apply styles live on theme change without losing drawings. Everything else in Part C is unchanged.

## Notes

- klinecharts is MIT/Apache-style open-source on npm — no license gate, no company requirement.
- Commit after each phase; keep tests green; retire LWC + old drawing code only after verified parity (A1/A2).
- If any built-in overlay is missing vs the TradeSea/Topstep set, klinecharts' registerOverlay lets you add it as a custom overlay — note gaps rather than reintroducing a fragile parallel drawing engine.
