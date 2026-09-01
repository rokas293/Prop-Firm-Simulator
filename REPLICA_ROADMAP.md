# REPLICA_ROADMAP.md — toward a clean TradingView / TradeSea-feel trading platform

North star for the "make it feel like TradingView/TradeSea" effort. This is the checklist the work is driven from, batch by batch. Pairs with `DESIGN_LANGUAGE.md` (the visual bar) and `VIZ_SPEC.md` (the data contract). Progressive — no deadline, just steady movement toward parity.

## Scope philosophy

- **Replica of the *feel and core interactions*, not every feature.** A literal 1:1 clone is years of team-work; that's not the goal. The goal is that using it *feels* like TradingView — clean, fast, direct-manipulation, nothing clunky.
- **Parity by interaction, not by feature-count.** The things that make TradingView feel pro are mostly *interactions*: right-click menus, grab-and-drag drawings, a crosshair that reads well, replay that doesn't fight you. Nail those before breadth.
- **Every addition obeys `DESIGN_LANGUAGE.md`.** Restrained/minimal, one accent, tabular numbers, hierarchy through space. New surfaces get audited like the rest.
- **Engine truth is preserved** (`VIZ_SPEC §0`): the frontend renders bundle data; it never recomputes trades/PnL.

## How we run this (the workflow)

I (the assistant) own the target + sequencing + prompts. You paste each batch into Claude Code, it builds and self-verifies (DOM/`getOverlays`/screenshots), and you review at **checkpoints** — after each batch — rather than every step. At a checkpoint you either approve, or point at what feels off and I adjust the next batch. Taste forks get batched into a single occasional question, not a stream of them. Commit after each batch.

## Parity checklist (status: ✅ done · �it in progress · ☐ todo)

### A. Chart interaction
- ✅ Candles, zoom/pan, crosshair, OHLC + indicator legend
- ✅ Timeframe switching; instrument switching
- ✅ **Right-click context menus** — empty chart (Reset chart view, Remove all drawings w/ confirm-if-many) and per-drawing (Edit style, Clone, Lock/Unlock, Delete), one shared `ContextMenu` component. Also fixed a real pre-existing bug this surfaced: klinecharts' default right-click behavior is to delete the overlay outright unless prevented — now suppressed everywhere (user drawings + the SL/TP lines and session fair-value line, which rode the same interactive built-in figure).  ← Batch 1
- ✅ **Easy drawing selection** — hit-tolerance widened 2px → 6px for every line-based tool (lines/rays/segments/fib), a restrained hover highlight (thicker stroke + accent, reverts cleanly), selection handles confirmed already present via klinecharts' own `needDefaultPointFigure` (built-ins and custom shapes alike) with working drag-to-edit. A stray off-line click a few px away now reliably grabs and drags the line.  ← Batch 1
- ✅ **Axis interaction** — drag-to-scale on both the price (Y) and time (X) axes, and double-click the Y axis to auto-reset-to-fit, are klinecharts' own native behavior (confirmed in the v10.0.3 source, nothing to build). Double-click the X axis to reset is NOT native (its handler only covers the main pane and Y axis) — added via a manual click-timing detector (not the browser's native `dblclick`, which headless Chrome/CDP doesn't reliably synthesize even from real down/up pairs — confirmed live on a bare `<div>`), reusing the same `resetView()` the right-click menu's "Reset chart view" already calls.  ← Batch 2
- ✅ **Drawing management** — a compact object-list panel (extends Batch 1's manage dropdown) with per-item select (click to frame + flash-highlight on the chart), hide, lock, delete, plus header "hide all"/"lock all" bulk toggles (select-all-checkbox semantics: flips direction once everything's already hidden/locked). `visible`/`lock` are real klinecharts `Overlay` fields, now round-tripped through persistence alongside the existing lock. Trade markers/session overlays are untouched — the manager only ever targets the user-drawing group.  ← Batch 2
- ✅ **Magnet/snap mode** — a toolbar toggle (off by default) using klinecharts' own native `strong_magnet` overlay mode: while on, every point placed on a NEW drawing, or dragged on an EXISTING one, snaps to the nearest OHLC value of the bar under it. Scoped to the primary chart's drawing toolbar (the secondary split-view chart has no drawing-authoring UI of its own).  ← Batch 2
- ☐ Measure-on-drag (quick price/%/bars readout without arming a tool)

### B. Replay
- ✅ Play/pause/step/scrubber/speed, no-look-ahead, live PnL/R + MLL readout
- ✅ **Free camera** — stepping doesn't yank the viewport (klinecharts' `resetData()` was unconditionally resetting the scroll offset on every replay tick; now the visible time range is captured before and restored after via `convertFromPixel`/`scrollToTimestamp`); "Follow" toggle (default off) nudges minimally to keep the latest bar in view, never hard-recenters  ← Batch 1
- ☐ Click-to-set replay start bar on the chart
- ☐ Replay from a chosen point with a clear start affordance

### C. Toolbars & layout
- ✅ Left icon drawing toolbar with grouped flyouts
- ✅ Dockable/resizable panels, layout presets, command palette
- ☐ Top chart toolbar polish: symbol, timeframe, indicators, settings, replay, layout — one clean row
- ☐ Favorites / recently-used drawing tools row
- ☐ Full-screen / distraction-free chart mode

### D. Symbol & timeframe UX
- ✅ Instrument + timeframe switch
- ☐ Symbol search/quick-switch (typeahead) styled like TradingView's
- ☐ Timeframe as both quick buttons and a dropdown of the full set

### E. Indicators
- ✅ Built-in + custom indicators, session shading, fair-value
- ✅ **On-chart per-indicator legend row** — klinecharts already renders name+live-values natively (confirmed `showRule: 'always'` in the v10.0.3 source, nothing to build there); added the interactive part via its `createTooltipDataSource` per-indicator override (NOT the chart-wide `tooltip.features` default, which the source only uses as a fallback): a settings swatch (line-color picker, VWAP/EMA20/EMA50/ATR14 only — VOL's up/down bars have no single color to pick), an eye (hide/show, klinecharts' native `Indicator.visible` field, re-applied on every rebuild since indicators fully recreate on any prefs/data/theme change), and a remove (×, reuses the same indicatorStore toggle the add-indicator dialog uses). Icons are hand-authored SVG paths (klinecharts' path parser supports the full grammar) since the library ships zero default icons.  ← Batch 3
- ✅ **Indicator dialog, with search** — replaces the old always-visible checkbox row (deleted `IndicatorTogglePanel`) with a searchable list (cmdk, reusing the command palette's own `.propbt-cmdk-*` chrome verbatim) of the same six prefs plus a newly-added `volume` toggle (previously an unconditional mount-time indicator, not gated by anything). Deliberately does NOT add klinecharts' own built-in MA/EMA/ATR formulas as new options — CLAUDE.md's engine-truth rule means the catalog is exactly what's already a backend pass-through or a zero-computation built-in, nothing new computed client-side.  ← Batch 3
- ✅ **Sub-pane management** — resize is klinecharts' own native separator-drag (`PaneOptions.dragEnabled`, confirmed via the `onPaneDrag` action, nothing to build); remove reuses the legend row's own × (VOL is now a real on/off indicator, same as the other five, so its pane can be removed/re-added); reorder is two more legend icons (↑/↓, sub-pane indicators only, shown only once ≥2 sub-panes exist) that swap `PaneOptions.order` between VOL and ATR14 — found and fixed two real bugs building this: klinecharts leaves every new sub-pane's `order` tied at the same default (now explicitly normalized to distinct values), and `getPaneOptions()` returns its OWN live/mutable options object rather than a snapshot (a naive swap using both sides' live `.order` after mutating the first was silently a no-op).  ← Batch 3

### F. Visual & feel
- ✅ Restrained/minimal design pass across all surfaces; full theming incl. background/candles
- ✅ Price-anchored trade markers, quiet zones, tooltips
- ☐ Consistent context-menu + tooltip + popover system app-wide (one component family)
- ☐ Motion/polish pass on the new interaction surfaces as they land

## Batch plan (sequenced; each is one Claude Code pass + a checkpoint)

1. **Batch 1 — direct manipulation (biggest feel gain):** right-click context menus + easy drawing selection/editing (A) and replay free-camera (B). *(prompts provided now.)*
2. **Batch 2 — chart object control:** axis drag-to-scale + double-click reset, drawing management (hide/lock all, object list), magnet/snap.
3. **Batch 3 — indicator UX:** on-chart per-indicator legend with hover controls, add-indicator dialog, sub-pane resize/reorder.
4. **Batch 4 — top toolbar + symbol/timeframe:** clean single-row top toolbar, symbol typeahead, timeframe quick+dropdown, favorites row of drawing tools.
5. **Batch 5 — modes & finish:** full-screen/distraction-free chart, click-to-set replay start, unified context-menu/tooltip/popover family, motion polish.
6. **Batch 6 — parity audit:** re-audit the whole app against TradingView/TradeSea + `DESIGN_LANGUAGE.md`, punch-list the gaps, elevate. (Renewable, like the design loop.)

Order can shift at any checkpoint based on what feels most-wrong when you're using it.

## What I'll ask you about (rare, batched)
- Taste forks where TradingView is opinionated and we might diverge (e.g. exact context-menu contents, whether replay follows by default).
- Priority reshuffles if something bugs you more than the current batch.
Everything else I'll just drive.
