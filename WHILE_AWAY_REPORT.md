# While-away hardening report

Self-contained pass across three streams: accessibility, test coverage, and a fresh DESIGN_LANGUAGE re-audit. **Nothing committed** — everything below is sitting uncommitted in the working tree for review. tsc, all 239 unit tests, and the production build are green after every change, verified after each stream and again at the end.

## 1. Accessibility — audited live via the DOM (Playwright driver against the running app), not by reading code and guessing

### Fixed

| Gap | Confirmed via | Fix |
|---|---|---|
| Settings modal (`SettingsPanel.tsx`) had no focus management at all | Opened it, checked `document.activeElement` — still the trigger button. Tabbed 3× — landed on "Chart-focused", a button in the *workspace behind the modal* | New shared `components/useModalFocus.ts` hook: moves focus into the dialog on open, traps Tab/Shift+Tab inside it, restores focus to the trigger on close. Wired into `SettingsPanel` and `ShortcutsOverlay` (the two hand-rolled dialogs — `role="dialog"` alone doesn't do any of this by itself). Re-verified after the fix: focus lands inside on open, 6 tabs later still inside, focus returns to the trigger button on close. Also added the missing `aria-modal="true"` to both. |
| Command palette (cmdk) | Checked the same way, as a baseline | Already correct — auto-focuses its input, traps Tab, uses proper `role="combobox"`. No change needed; recorded so it's clear this was checked, not assumed. |
| Date-range filter inputs in Trade List had no accessible name | `input.labels.length === 0` on both — the visible "From"/"To" text sat next to the inputs with no `htmlFor`/`id` pairing, so a screen reader announced them with no name at all | Added matching `id`/`htmlFor` pairs. `labels.length === 1` confirmed after. |
| Trade List's 5 filter `<select>`s had no accessible name beyond their first `<option>` text | Confirmed `aria-label === null` on all 5 | Added `aria-label` to each (`"Filter by leg"`, `"Filter by session"`, etc.) |
| `BreakdownTable` and `RunsListPage` table rows: `onClick` on a plain `<tr>`/`<td>` with no keyboard equivalent | Same category of bug already found and fixed in `TradeListPanel` during the design-elevation series, but these two were missed | Added `tabIndex={0}` + Enter/Space `onKeyDown` calling the same handler the click already does (same pattern as `TradeListPanel`'s rows) |
| Toggle-button groups had no `aria-pressed`/`aria-selected` — a screen reader had no way to tell which option was active | Grepped `aria-pressed` app-wide: only `KLDrawingToolbar`'s tool buttons had it; every other group (chart timeframes, Dashboard tabs, theme mode/presets, layout presets, bracket density, scope toggle) didn't | Fixed the two highest-traffic ones: chart timeframe buttons (`aria-pressed`) and the Dashboard tab bar, which got full ARIA tabs semantics (`role="tablist"`/`"tab"`/`"tabpanel"`, `aria-selected`, `aria-controls`/`aria-labelledby` pairing) since it's semantically a tablist and is used constantly. The rest are listed below — same fix, not yet applied everywhere. |

### Verified already correct, not touched
- Native checkbox/color-input labeling (`IndicatorTogglePanel`, `SettingsPanel`'s `TokenPicker`) — both already correctly wrap the input inside the `<label>`, confirmed as the one other `<label>` usage in the app.
- Global `:focus-visible` ring — applies automatically to every real `<button>`/`<input>`/`<select>` app-wide; confirmed on several elements across earlier sessions' work.

### Top remaining a11y items (not fixed this pass — same category of fix as above, just not everywhere yet)
1. **`aria-pressed` missing on most other toggle groups**: theme mode (Dark/Light), theme presets, layout presets, bracket density (Auto/Full/Off), Dashboard's scope toggle (Out-of-sample/In-sample/All), split-view toggle. Same one-line fix as the chart timeframe buttons, just not applied to every group yet — lower traffic than the two fixed, but still a real gap for screen-reader users.
2. **Canvas-rendered chart content is inherently not keyboard-navigable** — the KLineCharts candlestick pane, drawing tools, and trade markers have no keyboard-accessible equivalent (a well-known, industry-wide limitation of canvas-based charting libraries, not something fixable without a parallel data-table view or a large custom keyboard-navigation layer). Flagging as a known, accepted limitation rather than a fixable gap.
3. No `aria-live` region for state changes that currently only show visually (e.g., "1191 trades" count updating as filters change, the cross-filter badge appearing/disappearing) — a screen reader user gets no announcement that the list changed.

## 2. Test coverage

**Before: 205 tests across 22 files. After: 239 tests across 26 files (+34 tests, +4 files).** No coverage tooling is installed (`@vitest/coverage-v8` isn't a devDependency), so gaps were found by manually cross-referencing every non-test `.ts`/`.tsx` source file against existing `*.test.ts` files, rather than a coverage percentage. The Python backend (`propbt/`, `app/backend/`) already has a large, passing suite (224 tests via `pytest`) and wasn't touched — the frontend had the clearer, more addressable gaps in the time available.

New test files, all real assertions (not smoke tests):

- **`state/chartViewStore.test.ts` (14 tests)** — the replay/cursor-slicing state store had zero coverage despite `chart/replay.ts`'s own pure functions being thoroughly tested (16 tests). Covers view-mode transitions (trade/day/explicit-day mutual exclusivity), `toggleReplay`'s reset-to-zero side effect, `advanceCursor`'s stop-at-max-index behavior (the actual bug-prone boundary condition), and `resetForNewRun`'s selective reset (confirms `speed` deliberately survives a run switch as a user preference, everything else doesn't).
- **`state/uiStore.test.ts` (8 tests)** — `selectRun`'s side effect of clearing a stale `pendingDayJump` (a real invariant: switching runs must cancel a day-jump aimed at the old run), the jump/consume lifecycle, and a persistence test that reaches into zustand's own `persist` API to confirm `partialize` excludes the ephemeral `pendingDayJump`/`compareRunIds` fields from localStorage — this one would catch a future edit that accidentally widened what persists.
- **`chart/kl/rectOverlay.test.ts` (4 tests)** — the "overlay builders" category had one file with zero coverage. Beyond registration/idempotency (matching the existing pattern in `drawingOverlays.test.ts`), one test retrieves the actual registered overlay via klinecharts' own `getOverlayClass` and invokes its real `createPointFigures` with reversed corner coordinates — exercising the actual `Math.min`/`Math.abs` geometry math, not just "doesn't throw."
- **`api/client.test.ts` (8 tests)** — `buildQuery` (every API call goes through it) had zero coverage and wasn't even exported. Exported it (matching the codebase's existing convention of exporting pure helpers for testability, e.g. `drawingOverlays.ts`'s `measureLabel`) and added tests for `undefined`-value omission, URL-encoding of both keys and values, and the empty-params case.

### Top remaining coverage gaps
1. `chart/MllBandPrimitive.ts` (the lightweight-charts custom primitive drawing the distance-to-breach band) — likely needs a canvas/chart-context mock to test meaningfully; skipped given the time budget.
2. `state/indicatorStore.ts`, `state/chartDefaultsStore.ts`, `state/workspaceApiStore.ts` — thin stores, mostly plain setters; lower value than the two fixed, but `indicatorStore`'s `toggle` (flip-a-boolean-by-key) is still untested.
3. `workers/barsWorker.ts`/`barsWorkerClient.ts` — the off-main-thread bars-fetch path from the P4 performance work has no tests at all.
4. `workspace/presets.ts` — layout-preset application logic, untested.

## 3. Fresh DESIGN_LANGUAGE re-audit (record only — appended to `DESIGN_AUDIT.md`, nothing fixed)

Re-ran the audit against current code: grepped the whole frontend for off-grid spacing (`p`/`m`/`gap` classes ending in `.5`) and off-scale text sizes (`text-[Npx]` outside the approved set, plus Tailwind's `text-lg`/`text-3xl`/`text-4xl`), and read a few surfaces that were never central to any single elevation pass (`RunsListPage`'s error/empty states, `IndicatorTogglePanel`, `KeyboardShortcuts.tsx`, `PerfProfiler.tsx`).

**The grep sweep came back completely clean** — no off-grid spacing, no off-scale text anywhere in `app/frontend/src`. That's a real signal the six prior elevation passes were thorough. Two small items surfaced from reading actual render output:

1. **Original audit item R3 was never fixed.** `RunsListPage`'s `"FAILED (mll_breach)"` cell still colors the whole string — status word and the parenthetical fail-reason both — in `text-negative`, not just the status word (DESIGN_LANGUAGE §9: color on the value/status, not surrounding detail).
2. **Same-shaped, previously-unnoticed issue**: `RunsListPage`'s error state (`isError`) colors the entire "Failed to load runs: {raw exception message}" line in `text-negative`, including the raw technical detail. Same root cause as R3; likely missed earlier because the error path is rarely exercised.

Both are low severity and full details (with the exact line numbers) are now in `DESIGN_AUDIT.md`'s new "Follow-up re-audit" section at the bottom, ready for the next elevation-style pass.

## Files touched (uncommitted)

Modified: `DESIGN_AUDIT.md`, `app/frontend/src/api/client.ts`, `app/frontend/src/components/BreakdownTable.tsx`, `app/frontend/src/components/SettingsPanel.tsx`, `app/frontend/src/components/ShortcutsOverlay.tsx`, `app/frontend/src/pages/RunsListPage.tsx`, `app/frontend/src/panels/ChartPanel.tsx`, `app/frontend/src/panels/DashboardPanel.tsx`, `app/frontend/src/panels/TradeListPanel.tsx`

New: `app/frontend/src/api/client.test.ts`, `app/frontend/src/chart/kl/rectOverlay.test.ts`, `app/frontend/src/components/useModalFocus.ts`, `app/frontend/src/state/chartViewStore.test.ts`, `app/frontend/src/state/uiStore.test.ts`
