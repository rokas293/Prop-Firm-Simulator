# REPLICA_AUDIT.md — Batch 6 parity + design audit (read-only)

Read-only re-audit against `REPLICA_ROADMAP.md`'s parity checklist and `DESIGN_LANGUAGE.md`'s quality bar, done live against the running app (run `20260802T180304Z_6b373299`, MNQ) via a Puppeteer driver against `vite` :5173 / `uvicorn` :8000 — same methodology as the existing `DESIGN_AUDIT.md`. No code changed.

**Verification discipline:** every color/size/spacing/alignment claim below was checked with `getComputedStyle` (or read directly from source where the Tailwind class is unambiguous) — not eyeballed from a screenshot. Screenshots were used to *find* candidates and to judge overall composition/hierarchy, never as the sole evidence for a specific pixel value, per the instruction that past audits had false positives from scaled images.

**Relationship to `DESIGN_AUDIT.md`:** that audit predates Batches 1–5 of `REPLICA_ROADMAP.md`. A large fraction of its top-10 has since been fixed — confirmed live, not assumed — and is credited in §7 below rather than re-reported. This document supersedes it as the current punch-list; `DESIGN_AUDIT.md` is kept for history.

---

## 1. Top 10 highest-impact fixes

Ordered by impact-for-effort toward the "TradingView-clean, high-end" bar.

1. ✅ **FIXED — Prop Risk chart had a broken rendering artifact.** What looked like a huge, badly-clipped text fragment (read as `1%`) turned out on live investigation to be lightweight-charts' own default "Charting by TradingView" attribution logo (`id="tv-attr-logo"`, a real 35×19px SVG link the library injects on every chart unless told not to). The original hypothesis (an off-screen marker label) was ruled out by ablation — clearing all markers via `setMarkers([])` left the artifact in place; walking the canvas layer stack with `getImageData` found zero matching pixels in any of `RiskChart`'s own four canvases; `document.querySelectorAll('a')` on the pane then surfaced the actual `<a id="tv-attr-logo">` sitting at z-index 3, above both canvas layers, at the exact glitch coordinates. It read as broken because this app never opted into the mark and doesn't attribute TradingView anywhere else, so an unstyled third-party logo sat directly on the one surface DESIGN_LANGUAGE says should be quietest. **Fix applied:** `layout: { attributionLogo: false }` added to `RiskChart.tsx`'s `createChart()` call (its own documented option for exactly this). Verified gone via `document.getElementById('tv-attr-logo')` returning `null` post-fix, not just a screenshot. The legitimate `BREACH 2022-06-03` marker still renders correctly, confirming markers were never the issue. **Licensing follow-up (same pass):** lightweight-charts is Apache-2.0 and its own license comment ties the in-chart logo to that license's attribution requirement — disabling it without compensating elsewhere would trade a visual bug for a compliance one. Added a quiet "Charts by TradingView" link (11px, `text-muted`, footer of the Settings modal, always visible without scrolling) linking to https://www.tradingview.com/, and a `THIRD_PARTY_NOTICES.md` at the repo root with the library's full license text, referenced from `README.md`.
2. ✅ **FIXED — Control heights were inconsistent app-wide: 24 / 26 / 28px, not one value.** Standardized every flagged control to `h-7` (28px), matching the chart toolbar that already set the bar: the "Layout:" preset row buttons + "Reset layout" + "+ Panel" (`Workspace.tsx`), the header "Perf" and "Settings" buttons (`App.tsx` — "Perf" wasn't separately named but sits in the same row as "Settings" and would have been the one visibly mismatched holdout), and all 5 Trade List filter `<select>`s + both date `<input>`s + both "Clear"/"Clear filters" buttons (`TradeListPanel.tsx`). Verified live via `getBoundingClientRect`: all 12 sampled controls now measure exactly **28.0px**, matching the `15min` timeframe pill used as the reference. Functionality re-confirmed post-fix (layout-preset switching, Settings modal, select-driven filtering, Clear, date-range filtering) — pure className changes, no logic touched.
3. ✅ **FIXED — chrome no longer stacks 5 rows / 214px before the first candle in the default layout.** Was: app header (51px) + "Layout:" preset row (41px) + dockview panel-tab row (32px) + chart toolbar (28px) + trade-nav row (45px) = 214px. Now, measured live in the same "Analysis" preset immediately after opening a run (no trade yet focused): header (53px) + panel-tab row (32px) + chart toolbar (28px) = **130px total, 3 rows** — an 84px / 39% reduction, and the trade-nav row's own permanent presence is gone. **What changed:** the "Layout:" row (#8) is removed entirely, its presets folded into `ChartLayoutMenu`'s popover; the trade-nav row (Prev/Next/Fit/Full day) is now conditional — hidden until the user explicitly focuses a trade (a Trade List row click, or the row's own controls/keyboard shortcuts once already visible), not on `selectedTrade` being non-null, since `ChartPanel.tsx` auto-selects trade #1 on every run load for an unrelated reason (it also drives the chart's default fitted window) and that would have made a `selectedTrade`-only gate a no-op. Tracked via a new `tradeStore.tradeNavFocused` flag, reset on run change. Once a trade is focused the row reappears at its usual 45px (measured: canvas top moves from 130px to 175px, exactly the row's own height, nothing else shifts) — this is the row earning its space by being used, not permanent chrome. Distraction-free mode, the Settings modal's own LAYOUT section, and the "+Panel"/preset/reset functionality were all re-verified working through the new popover.
4. ✅ **FIXED — see #2.** Trade List's filter row (24–26px) now matches its own 28px virtualized row height (`ROW_HEIGHT = 28`) — no more self-inconsistency within the one panel.
5. ✅ **FIXED — Runs-list table row height was 37px**, against §4's 28–32px band. Reduced `th`/`td` vertical padding from `py-2` to `py-1` across the whole table (`RunsListPage.tsx`). Verified live: row height is now **29px**, squarely inside the 28–32px band. Header typography (11px uppercase muted) and the right-aligned tabular `PARAMS` column were already correct and untouched.
6. **The Dashboard/Equity "bordered `Card`" pattern has grown to ~12+ instances on one screen.** Confirmed live: `KpiTile` (`rounded border border-border bg-surface`, used 7× per Dashboard tab for Result/Net P&L/Max Drawdown/Expectancy/Profit Factor/Win Rate/Days-to-fail), the By-leg/By-session breakdown tables, and both Equity-panel charts all use the same bordered-card shell. A prior pass (`DESIGN_AUDIT.md` B3/E1) reviewed this specific pattern and explicitly accepted it ("use as the internal reference for what compliant looks like") — noted here for completeness, not as a fresh discovery, since re-litigating a decided call without new information isn't useful. What *is* new: the sheer count has grown since that review (Score & AI's Compass-score block is a 6th+ instance not covered in the original pass), and DESIGN_LANGUAGE §5/§10 still read unambiguously against it ("A KPI doesn't need a bordered card…", "Too many borders/cards" is anti-pattern #1). Flagging as a re-open candidate given the accumulated count, not a clear-cut bug. **Surface:** Dashboard, Equity. **Severity: Medium (re-open candidate, not new).** **Fix, if pursued:** drop `KpiTile`'s border/bg, separate tiles by gap/whitespace only (a `flex gap-8` row); keep `Card`'s border for the two or three *true* containers (charts) where a boundary genuinely helps orient the eye.
7. ✅ **FIXED — measure-on-drag, the last open item on the whole A–F parity checklist.** `chart/measure.ts`'s math (`computeMeasure`/`formatDuration`) was already implemented and tested, but the only thing wired to it was `klMeasure` — a full drawing tool (arm it from the toolbar, place two points, it stays on the chart as a real overlay) — which doesn't match TradingView's own ephemeral ruler ("quick readout WITHOUT arming a tool"). Added a second, parallel interaction in `ChartKL.tsx`: hold **Alt** and drag directly on the candle pane — no arming step, and nothing is added to the chart's data model, so there's nothing to clean up beyond clearing local state on mouseup. A thin dashed guide line + two dots (plain SVG, absolutely positioned over the canvas) connects the two points; a floating box near the cursor shows the signed points/percent (colored positive/negative on the number, matching §9) and, on a second line, bars-between and elapsed time. Registered the initial mousedown at **capture phase** so a qualifying press never reaches klinecharts' own mousedown handling — confirmed live that klinecharts then treats the rest of the drag as plain hover (still firing `onCrosshairChange`, which the readout piggybacks on) rather than entering its own pan state. Verified live via the DOM against exact known bar timestamps/closes (not just a screenshot): dragging between two specific loaded bars produced `bars` and `formatDuration` values that matched the source data exactly, and points/percent matched to within expected sub-pixel rounding; confirmed the readout is absent before any drag and gone immediately after mouseup; confirmed zero overlays left in the chart's `kl-user-drawing` group afterward; confirmed a plain (non-Alt) drag still pans the chart exactly as before (regression check). Discoverability: added a display-only entry to the shortcuts registry ("Alt + drag" under Chart) so it shows in the "?" overlay and Settings' Shortcuts list, alongside the pre-existing `klMeasure` tool (kept as-is — a legitimate, different use case for someone who wants to *keep* a measurement on the chart).
8. ✅ **FIXED — the "Layout:" preset row no longer duplicates Settings.** Removed entirely from `Workspace.tsx` (including its own "+ Panel" reopen-list, which had no home in Settings and needed one). Both moved into `ChartLayoutMenu.tsx`'s existing popover as two new sections — "Workspace layout" (Analysis/Chart-focused/Stats + Reset layout) and "Panels" (reopen any closed panel) — reading/driving the same `useWorkspaceApiStore` instance `Workspace.tsx` already publishes, so no new cross-component plumbing was needed. Settings' own LAYOUT section is untouched and still works as the deep-link path. Verified live: switching presets and reopening a closed panel both work correctly from the popover, and it auto-closes after a preset pick.
9. **Dashboard's default "Analysis" layout hides its own sub-tab content below the fold with no visible cue.** The KPI row stays visible regardless of which sub-tab is active, but "Breakdowns"/"Distributions"/"Score & AI" content sits inside a `overflow-auto` container that's only ~228px tall in the default layout against ~459px of actual content (confirmed live) — it scrolls correctly, it's just not obvious there's more below without trying. The "Stats" layout preset (which gives Dashboard a full-height column) makes this a non-issue, but it isn't the default, and #8's fix moved preset-switching into a popover rather than making it more prominent, so this is still open. **Surface:** Dashboard. **Severity: Low.** **Fix:** a subtle bottom-edge fade matching `DESIGN_AUDIT.md`'s existing C4 recommendation for the same affordance elsewhere.
10. **Micro-inconsistency, not a defect: three keycap stylings collapsed to one, but the code comment documenting the old gap is now stale.** Checked live: `App.tsx`'s header kbd, `ShortcutsList.tsx`'s kbd, and the command palette's own `Ctrl/Cmd K` kbd are now all `rounded border border-border px-1 py-1` → 4px padding, identical. `App.tsx:100`'s comment ("this surface's own px-1.5 py-0.5) — this was a third, independent keycap styling, flagged… as out of scope") describes a state that's since been fixed; worth a one-line comment cleanup next time that file is touched (not a design fix, just doc hygiene — mentioned here only because it was checked as part of this audit).

---

## 2. Chart interaction & drawings

| # | Finding | Section | Severity | Fix |
|---|---|---|---|---|
| A1 | Left drawing-rail icon buttons are a clean, consistent 32×32 square at rest, all `text-muted` (confirmed live: 11 buttons sampled, all `rgb(139,148,158)`, zero accent-at-rest) — this fully resolves `DESIGN_AUDIT.md`'s old #2 ("~20 inactive labels in accent blue"). | §7, §2 | — (compliant) | None |
| A2 | Flyout menu items (e.g. "Lines tools": Horizontal/Ray/Trend/…) are all `text-text` at rest, not accent — confirmed live across 12 sampled rows. | §2 | — (compliant) | None |
| A3 | Border radius is consistent at 4px across every sampled control (timeframe pills, layout-preset buttons, trade-nav buttons, selects). | §4 | — (compliant) | None |
| A4 | Chart canvas shows a proper skeleton (title-bar bar, chart-shaped rect, legend-row bar, sub-pane rect) during the ~0.5–1.5s load window, not a spinner or blank grid — resolves `DESIGN_AUDIT.md`'s old C2. | §9, §10 | — (compliant) | None |
| A5 | Measure-on-drag still missing — see Top 10 #7. | — | Medium | See Top 10 #7 |

## 3. Replay

| # | Finding | Section | Severity | Fix |
|---|---|---|---|---|
| B1 | Replay controls row (Step/Play/Step→/speed/Follow/Set start) sits directly under the always-visible trade-nav row, both at 28–45px heights — contributes to Top 10 #3's chrome stack when replay is active, adding a 6th row. | §5 | Low (already conditional — only appears during replay) | None required beyond #3's broader fix |
| B2 | "Set start" armed-state button (accent-filled, "Click a bar…" label) and the crosshair cursor swap are both correctly single-accent, clear affordances. | §2, §6 | — (compliant) | None |

## 4. Toolbars & layout

| # | Finding | Section | Severity | Fix |
|---|---|---|---|---|
| C1 | ✅ Fixed — see Top 10 #3 (chrome stacking) and #8 (Layout-row/Settings redundancy). | §5 | — (fixed) | None |
| C2 | Dockview panel tabs (Chart/Trade List/Dashboard/Prop Risk/Equity) distinguish active vs. inactive purely by text color (`text` vs `text-muted`) and background step (`bg` vs `surface-2`) — no underline, but §6 explicitly allows "an underline **or** subtle active bg," so this is compliant, not a gap. | §6 | — (compliant) | None |
| C3 | Dashboard's own sub-tabs (Overview/Breakdowns/Distributions/Score & AI) correctly use a 2px accent underline for the active tab and `text-muted` for inactive — and their padding is `4px 12px`, a clean 4px-grid value (fixes `DESIGN_AUDIT.md`'s old #9, which measured 6px). | §4, §6 | — (compliant, previously fixed) | None |

## 5. Symbol & timeframe

| # | Finding | Section | Severity | Fix |
|---|---|---|---|---|
| D1 | Symbol search, timeframe dropdown, and the shared popover family (Batch 5) all correctly use `propbt-fade-in`, matching shell/padding/focus-ring — re-verified live, still holding. | §6, §8 | — (compliant) | None |

## 6. Indicators

| # | Finding | Section | Severity | Fix |
|---|---|---|---|---|
| E1 | On-chart legend row, indicator dialog, and sub-pane controls (Batch 3) show no new regressions on re-check; not re-audited in full depth this pass since nothing in Batches 4–5 touched this surface. | — | — | None found; low-risk area |

## 7. Trade List panel

| # | Finding | Section | Severity | Fix |
|---|---|---|---|---|
| F1 | Numeric columns (`.num` class) are correctly `text-align: right` + `font-variant-numeric: tabular-nums` — confirmed live on the PnL/entry/exit/size columns. This fully resolves `DESIGN_AUDIT.md`'s old #1 ("Numbers are left-aligned and non-tabular everywhere") for this panel. | §3, §9 | — (compliant, previously fixed) | None |
| F2 | Row height is exactly 28px (`ROW_HEIGHT = 28` in source, confirmed on-screen) — on-spec. | §4 | — (compliant) | None |
| F3 | Rows are correctly zebra-free, told apart by hover (`hover:bg-surface`) and selected (`bg-surface-2`) background steps only, no row borders — matches §6 exactly, including the code's own comment citing that section. | §6 | — (compliant) | None |
| F4 | ✅ Filter row control heights now match the panel's own 28px row height — see Top 10 #4. | §6 | — (fixed) | None |

## 8. Dashboard panel

| # | Finding | Section | Severity | Fix |
|---|---|---|---|---|
| G1 | KPI tile values are 20px/500 (Overview) and the Score hero is 28px/600 — both now correctly on the §3 scale (11/12/13/14/16/20/24–28), and correctly *distinct* tiers per the source's own comment citing the old audit's D1/S1 finding of "two different, off-scale hero treatments." Fully resolved. | §3 | — (compliant, previously fixed) | None |
| G2 | "Compass score" panel-title-style heading measured at 16px/500 — matches §3's "panel titles: 16" exactly (old audit's S3 found 14px). Resolved. | §3 | — (compliant, previously fixed) | None |
| G3 | Micro-labels (RESULT, NET P&L, …) are 11px/500/uppercase — matches §3 exactly (old audit's #7 found 400-weight). Resolved. | §3 | — (compliant, previously fixed) | None |
| G4 | Breakdown table numeric columns (Trades/Win Rate/Expectancy/Total R) are right-aligned tabular with correct positive/negative coloring on the number only. | §3, §9 | — (compliant) | None |
| G5 | Bordered-`Card` pattern count — see Top 10 #6. | §5, §10 | Medium (re-open candidate) | See Top 10 #6 |
| G6 | Sub-tab content can sit below the fold in the default layout — see Top 10 #9. | §5 | Low | See Top 10 #9 |

## 9. Prop Risk panel

| # | Finding | Section | Severity | Fix |
|---|---|---|---|---|
| H1 | ✅ Rendering artifact fixed — see Top 10 #1. Was lightweight-charts' own attribution logo, not a bug in this codebase's drawing code; disabled via `attributionLogo: false`. | §1 ("the chart is the hero") | — (fixed) | None |
| H2 | Legend swatches (Equity/Trailing MLL floor/Daily loss floor/Profit target/Distance-to-breach band) and the daily-risk strip's Safe/Close/Breach status colors are both legitimate, functional color use (identity + status), not decorative — compliant with the §2 exception for categorical/status color. | §2 | — (compliant) | None |
| H3 | Daily-risk strip bars have no visible gap-based grouping issue; hover/click affordance (`title` tooltip, opacity-75 hover) present. | §6 | — (compliant) | None |

## 10. Equity panel

| # | Finding | Section | Severity | Fix |
|---|---|---|---|---|
| I1 | Both charts (Equity & trailing MLL, Drawdown from peak equity) remain the cleanest surface in the app per the prior audit's own conclusion (E1) — re-verified, no regressions; axis ticks muted, single accent/negative line colors, consistent `Card` padding. | — | — (compliant) | None |
| I2 | Shares the `Card` border pattern — see Top 10 #6. | §5 | Medium (re-open candidate) | See Top 10 #6 |

## 11. Settings, command palette, shortcuts

| # | Finding | Section | Severity | Fix |
|---|---|---|---|---|
| J1 | Command palette remains excellent: single accent row-highlight, uppercase muted section labels, no nested borders — matches the prior audit's "reference example" verdict, re-confirmed live. | — | — (compliant) | None |
| J2 | Keycap styling (`Ctrl/Cmd K` chips) is now unified across header/shortcuts-overlay/command-palette at 4px padding — see Top 10 #10 (stale comment only, not a live defect). | §4 | — (compliant, comment stale) | Doc cleanup only |
| J3 | Settings' theme editor shows contrast ratios inline next to every color swatch (6.8:1, 5.2:1, …) — a nice, functional touch beyond spec, not a violation of "no decorative color" since every swatch is functional (it *is* the color being edited). | §2 | — (compliant) | None |
| J4 | Settings' "LAYOUT" section duplicates the always-visible preset row — see Top 10 #8. | §5 | Low-Medium | See Top 10 #8 |

## 12. Runs list (entry point)

| # | Finding | Section | Severity | Fix |
|---|---|---|---|---|
| K1 | ✅ Row height fixed — see Top 10 #5. Now 29px, down from 37px. | §4 | — (fixed) | None |
| K2 | Header row is now correctly 11px/uppercase/muted/letter-spaced (`0.44px` ≈ 0.04em at 11px) — matches §3 exactly; resolves the old audit's #10 header-typography half (the row-height half of #10 is still open, tracked as K1). | §3 | — (compliant, previously fixed) | None |
| K3 | `PARAMS` column is correctly right-aligned + `tabular-nums`; `RESULT` column colors only the semantic word (`FAILED` in `text-negative`) while the reason (`(mll_breach)`) stays `text-muted` — both exactly per §9 ("color on the number/status only, not its label"). | §9 | — (compliant) | None |

---

## 13. Cross-cutting: what's new-inconsistent after Batches 1–5

Batches 1–5 each reasonably scoped their own surface; stepping back across all of them together surfaces two things no single batch would have caught:

- **Control-height drift (Top 10 #2/#4).** Batch 4's toolbar consolidation quietly established 28px as "the" interactive-control height by using it consistently across the new unified toolbar — but nothing went back to bring the *older* surfaces (Layout-preset row, header Settings button, Trade List filters, all untouched by Batches 1–5) up to that same bar. The new toolbar is now the odd-one-out in a good way; everything else needs to catch up to it, not the reverse.
- **Chrome accumulation (Top 10 #3).** Each batch added its own row where it made local sense (Batch 4's toolbar row, the pre-existing trade-nav row, Batch 5's distraction-free escape hatch as the *fix* for exactly this problem) — but no batch was scoped to look at the *total* stack height in the default (non-distraction-free) state, which is where most usage actually happens.

## 14. What's still open from the Batch 1–5 parity checklist

Per `REPLICA_ROADMAP.md`, **every item in sections A–F is ✅ except one**: "Measure-on-drag (quick price/%/bars readout without arming a tool)" in §A. See Top 10 #7.

## 15. What's already fixed since `DESIGN_AUDIT.md` (credited, not re-flagged)

Re-verified live, all now compliant — listed here so the historical document doesn't get treated as still-current:

- Trade List numeric columns: tabular + right-aligned (was old #1).
- Drawing-tool labels: muted at rest, accent only when armed (was old #2).
- Score & AI hero number: 28px/600 (was old #3, measured 36px/700).
- KPI tile values: 20px/500, distinct from the Score hero tier (was old #4).
- Table headers (Dashboard/Trade List): uppercase, muted, right-aligned over numeric columns (was old #5).
- Prop Risk's *old* stacked-label overlap (three last-value labels colliding) is gone — `RiskChart.tsx`'s own comment confirms this was deliberately fixed by hiding MLL/daily-loss floor labels and keeping only the equity series' — though a *new*, different rendering defect has since appeared in its place (Top 10 #1).
- Micro-labels: 500 weight (was old #7).
- Chart canvas loading skeleton: present (was old #8).
- Dashboard sub-tab padding: `4px 12px` (was old #9).
- Runs-list header typography: 11px uppercase muted (half of old #10 — the row-height half remains open, see K1/Top 10 #5).
