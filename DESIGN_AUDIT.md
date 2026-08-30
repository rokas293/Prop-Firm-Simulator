# DESIGN_AUDIT.md — visual audit against DESIGN_LANGUAGE.md

Read-only audit, no code changed. Run 20260802T180304Z_6b373299 (MNQ) was used as the live subject, captured via a Playwright driver against the local dev servers (`uvicorn` :8000, `vite` :5173). Screenshots are referenced by descriptive name below (captured this session, not committed as binaries — same convention as `PART_C1_AUDIT.md`); several claims are backed by `getComputedStyle` measurements taken live in the running app, quoted inline so severities aren't just eyeballed.

Surfaces covered: chart workspace (Analysis + Chart-focused layouts), trade list, dashboard (Overview / Breakdowns / Distributions / Score & AI), prop risk, equity, settings/theme editor, command palette + shortcuts overlay, empty/loading states, runs list (entry point, bonus).

---

## Top 10 highest-impact fixes

Ordered by how much each would raise the "high-end, restrained" feel for the effort involved.

1. **Numbers are left-aligned and non-tabular everywhere.** Every table in the app — Trade List, Dashboard's By-leg/By-session breakdowns — renders numeric cells with `text-align: start` and `font-variant-numeric: normal`. Confirmed live: Trade List price cell `14748.00` → `textAlign=start, fontVariantNumeric=normal`; Breakdowns table `670` → same. This is DESIGN_LANGUAGE's single most explicit rule (§3, §9, and named in the §10 anti-pattern list verbatim) and it's violated everywhere numbers appear. **Highest-impact single fix in the whole audit.**
2. **Drawing-tool sidebar list renders ~20 inactive labels in accent blue.** `Horizontal / Horizontal ray / Trend / Ray / Zone / Circle / Triangle / Arrow / Tag / Measure / Brush …` are all accent-colored text at rest, not just the active tool. On the one surface DESIGN_LANGUAGE calls "the hero" that everything else should recede around (§1), this is the loudest, most sustained accent-color wash in the product.
3. **Score & AI hero number is 36px/700**, not the spec's 24–28px/semibold-600 (§3). It's also a different treatment than the KPI tiles' own hero numbers (18px/600, itself off-scale — see #4), so the app has two different "biggest number on screen" styles, neither matching the documented scale.
4. **KPI tile values (RESULT, NET P&L, MAX DRAWDOWN, etc.) are 18px** — not on the approved 11/12/13/14/16/20/24–28 scale (§3). Trivial fix (drop to 16 or bump to 20), but it's the most-viewed number size in the app (every dashboard tab, every session).
5. **Table headers aren't uppercase and aren't right-aligned over their numeric columns** ("Entry", "Trades", etc. measured at `textTransform: none`, `textAlign: left`). §6 specifies "muted uppercase micro-label header, right-aligned numbers" — currently neither half holds, compounding #1.
6. **Prop Risk panel's price-label cluster overlaps illegibly** at the current-price edge (`48189.60` / `48178.20` / `47235.60` stacked with a `BREACH …` label crammed against them — see `audit/15-prop-risk-fully-settled.png`). On a panel whose entire job is "read this number fast," it currently can't be read fast.
7. **Micro-labels are regular weight (400), not medium (500).** Measured on the Dashboard's "RESULT" label. Spec (§3) is explicit: micro-labels are medium weight. Cheap, systemic fix (one shared component/class).
8. **Chart pane has no loading affordance.** On first mount (and again whenever a slow-fetching panel like Prop Risk is opened — its equity fetch measured 4.6s and 2.0s in two parallel calls), the canvas area renders fully blank — no skeleton, no message — for several seconds. §9/§10 call for a skeleton, explicitly not a blank slate or a spinner; here it's neither, which reads as more broken than either.
9. **6px vertical padding on Dashboard tabs** (`Overview/Breakdowns/Distributions/Score & AI` measured at `padding: 6px 12px`). Not a multiple of 4 — exactly the "5/7/13px kind" of violation §10 names by example.
10. **Runs-list table row height is 37px** against the spec's 28–32px band, and its header typography (14px, not the 11–12px muted-uppercase micro-label convention used elsewhere) doesn't match the Dashboard/Trade-List table header style — two different table conventions live in the same app.

---

## Chart workspace (Analysis + Chart-focused layouts)

Screenshots: `01-chart-workspace-analysis`, `02-chart-focused`, `05-chart-after-row-click`.

| # | Violation | Section | Severity | Fix |
|---|---|---|---|---|
| C1 | Drawing tool list (Lines/Fibonacci/Shapes/Notes groups, ~20 items) renders every label in accent blue whether or not it's the active tool | §2 "one accent, used rarely," §10 anti-pattern "decorative... color" | **High** | Default all inactive tool labels to `text-muted`/`text`; reserve accent for the currently-armed tool only (and maybe hover) |
| C2 | Chart canvas shows no skeleton/placeholder while the first trade's bars are loading — plain blank grid with axis labels for 2–6s depending on how the panel was reached | §9 "loading: skeletons... not spinners," §10 anti-pattern "spinners where a skeleton belongs" | **Med-High** | Render a faint skeleton (or at minimum a muted "Loading…" line matching the panel's quiet-chrome style) in the chart pane until first paint |
| C3 | Category group labels ("LINES", "FIBONACCI", "SHAPES", "NOTES") in the drawing sidebar sit directly above their items with no visible spacing rule difference from item-to-item spacing — hard to tell groups apart from a glance at the screenshot | §4 "related items 8px... more space between groups" | Low | Increase gap above each group label relative to intra-group item gap |
| C4 | Chart-focused layout's expanded drawing tool list (Fibonacci/Shapes/Notes added) pushes the sidebar to scroll past the visible chart height with no visual cue there's more below the fold | §5 "quiet panel chrome... content is the point" (indirect) | Low | Add a subtle bottom fade or scroll affordance if the list can overflow |

Compliant / worth preserving: timeframe buttons (1min/5min/15min/1h) and the Auto/Full/Off bracket-density toggle both correctly show a single accent-filled active state against neutral siblings — this is the pattern the rest of the app should be measured against.

## Trade list panel

Screenshots: `03-chart-workspace-analysis-b`, `05-chart-after-row-click` (right panel).

| # | Violation | Section | Severity | Fix |
|---|---|---|---|---|
| T1 | Numeric columns (Size, Entry, Exit) are left-aligned, non-tabular text — measured live: `14748.00` → `textAlign: start`, `fontVariantNumeric: normal` | §3 "tabular... right-aligned," §10 anti-pattern | **High** | Apply `font-variant-numeric: tabular-nums` + right-align to Size/Entry/Exit/PnL columns |
| T2 | Column headers ("Entry", "Leg", "Session"...) are 12px/500/muted but not uppercase, not right-aligned over numeric columns | §6 "muted uppercase micro-label header, right-aligned numbers" | Medium | Uppercase + letter-spacing on headers; right-align the numeric ones to match T1 |
| T3 | Filter `<select>` height measured at 26px vs. the 28px measured on adjacent buttons — a 2px mismatch in "consistent height with buttons" | §6 | Low | Normalize both to the same height token (28px) |
| T4 | Loading skeleton rows (visible at `21-dashboard-kpi-skeleton.png`) are a good positive example — grey blocks matching final row shape/count | §9 (compliant) | — | Keep as the reference pattern for other panels' loading states (see C2, P1 below) |

## Dashboard — Overview tab

Screenshots: `08b-dashboard-overview-all`.

| # | Violation | Section | Severity | Fix |
|---|---|---|---|---|
| D1 | KPI tile values (RESULT "FAILED", NET P&L, MAX DRAWDOWN, EXPECTANCY, PROFIT FACTOR) measured at 18px/600 — not on the 11/12/13/14/16/20/24-28 scale | §3 type scale | **High** (most-viewed number size in the app) | Move to 20px (section-KPI size) for consistency with the "20 = section KPI" scale entry, or 16 if these should read as secondary to the Score tab's hero number |
| D2 | KPI tile micro-labels ("RESULT", "NET P&L"...) measured at 11px/400 (regular), not the specified medium weight | §3 "micro-labels:... medium weight" | Medium | Bump to `font-weight: 500` in the shared KPI-label class |
| D3 | 5-tile KPI row + scope toggle + tab row all present with fairly light spacing above/below (visually tight relative to §4's 24px section-gap guidance) — worth a spacing pass once D1/D2 land | §4 | Low | Verify section gaps are 24px once the number/label sizes change (may resolve itself) |

## Dashboard — Breakdowns tab

Screenshots: `10-dashboard-breakdowns`.

| # | Violation | Section | Severity | Fix |
|---|---|---|---|---|
| B1 | By-leg / By-session table numeric columns (Trades, Win rate, Expectancy, Total R) are left-aligned, non-tabular — measured live: `670` → `textAlign: start`, `fontVariantNumeric: normal` | §3, §10 anti-pattern | **High** | Same fix as T1, shared `BreakdownTable` component — one fix covers both tables |
| B2 | Table header row ("Trades", "Win rate"...) not uppercase, left-aligned even over numeric columns | §6 | Medium | Same as T2 |
| B3 | Two side-by-side bordered `Card` tables sit directly under the KPI row + tab row with no additional grouping cue beyond the card border itself — acceptable, but confirm no third level of nesting was introduced (cards-in-cards) — visually clean in the screenshot, not flagged as a violation, noted as a check-again-after-B1/B2 item | §5 | — | No action; re-verify after B1 fix doesn't add visual weight |

## Dashboard — Distributions tab

Screenshots: `11-dashboard-distributions`, `16-distributions-stats-layout`.

| # | Violation | Section | Severity | Fix |
|---|---|---|---|---|
| DI1 | R-multiple histogram and MAE/MFE scatter charts sit in two side-by-side `Card`s directly below the tab row — clean, but the MAE/MFE card's explanatory paragraph ("20 trades exited at SL...") uses body-text size/weight indistinguishable from a KPI label at a glance; confirm it's using the §3 body size (13px) not a muted micro-label size | §3 | Low | Verify computed size is 13px, not 11/12 |
| DI2 | The four KPI tiles under the MAE/MFE scatter (Losses/Clipped stops/Clipped share/Avg MAE÷SL) repeat the same 18px off-scale value size as D1 | §3 | High (same root cause as D1) | Same fix as D1 — one shared `KpiTile` fix resolves D1, DI2, and any other KpiTile usage app-wide |
| DI3 | Six chart cards stack vertically in this tab (R-histogram+MAE/MFE, hour-of-day+weekday, session-hour facet, hold-time+streak) — each is its own bordered `Card`. Individually each is justified (distinct data), but the tab as a whole is the densest concentration of bordered containers in the app; worth a "can any two merge or lose their border in favor of a section label" pass in the elevation phase | §5 "flatten containers... fewest nested surfaces" | Medium | Candidate: merge the two hour-based cards (pooled hour-of-day + session-hour facet) under one card with an internal divider instead of two full card borders |

## Dashboard — Score & AI tab

Screenshots: `17-score-ai`.

| # | Violation | Section | Severity | Fix |
|---|---|---|---|---|
| S1 | Score hero number measured at 36px/700 (bold) — off the 24–28px hero-KPI scale, and 700 isn't one of the two-weights-plus-600-for-hero rule's allowed weights (§3: "Regular/Medium, semibold 600 only for hero numbers") | §3 | **High** | Set to 28px/600 |
| S2 | Score card's four component rows (Expectancy/Consistency/Drawdown/Stop efficiency) each show a score number in a size/weight not yet measured — audit as part of the same pass as S1, likely also needs alignment to the "14 emphasis" scale entry rather than a bespoke size | §3 | Medium | Verify computed size; align to 14px/500 if currently bespoke |
| S3 | Panel title "Compass score" measured at 14px/500 — DESIGN_LANGUAGE explicitly maps 16px → panel titles (§3); this component (and by extension every `Card` title in the app, since it's the shared component) is one step below the documented size | §3 | Medium (systemic — one shared `Card` component) | Bump `Card` title from 14px to 16px, or explicitly re-map "panel titles" to 14 in DESIGN_LANGUAGE if 14 is the intended convention (needs a decision, not just a CSS change) |
| S4 | "AI insight (optional)" card's disabled-state copy ("Not configured — set ANTHROPIC_API_KEY...") and the Summarize button's disabled state were not visually distinguishable from the enabled state at a glance in the screenshot — confirm disabled opacity/cursor treatment matches §6's "disabled: reduced opacity, no pointer" | §6 | Low | Verify `disabled:opacity-*` is actually visible against the surface background |

## Prop risk panel

Screenshots: `09-prop-risk-settled` (mid-load, confusingly similar to a "stuck" state), `14-prop-risk-loading-state` (true loading), `15-prop-risk-fully-settled`.

| # | Violation | Section | Severity | Fix |
|---|---|---|---|---|
| P1 | On open, the panel shows two fully blank grey rectangles with zero skeleton content for as long as ~4-7s (measured: the panel's `equity?max_points=...` fetch took 4616ms and 2020ms in two concurrent calls) — worse than C2 because it's longer and the panel has more distinct regions (legend, chart, day-strip) that could each get a shaped skeleton | §9, §10 | **High** | Give RiskPanel the same shaped skeleton treatment already used well in Trade List (`21-dashboard-kpi-skeleton.png`) — legend-row skeleton, chart-area skeleton, day-strip skeleton |
| P2 | Once loaded, the three price-level labels near the current price (`48189.60` red chip, `48178.20` accent-blue chip, `47235.60` amber chip) plus a `BREACH 20...` text label all cram into the same ~40px vertical strip at the chart's top-right, overlapping/crowding each other illegibly | §9 "the chart surface is the brightest, most saturated thing" (implies legible, not cluttered), general readability | **High** | Stagger or collapse overlapping price labels (e.g., only show the closest-to-price label, or offset labels that are within N px of each other) |
| P3 | Daily-risk color strip at the bottom (green/yellow/red bars, one per trading day) has no visible gap between adjacent bars of different color — reads as one solid gradient block rather than distinct clickable days at this trade-count/zoom level | §4 "table/list rows... consistent" (indirect), general affordance | Low | Consider a 1px surface-colored gap between day bars, at least at lower zoom/density |

## Equity panel

Screenshots: `07-equity`.

| # | Violation | Section | Severity | Fix |
|---|---|---|---|---|
| E1 | Two Recharts cards (Equity & trailing MLL, Drawdown from peak equity) stacked with light-weight axis text — this is the cleanest surface in the audit: consistent card padding, muted axis ticks, no excess color. No violations found. | — | — | None — use as the internal reference example for "what compliant looks like" during the elevation pass |
| E2 | Axis tick labels use full ISO-ish dates (`2021-07-22`) at what looks like the default Recharts tick size — confirm this is 11px (micro-label) not a larger default | §3 | Low | Verify computed tick font-size is 11px |

## Settings / theme editor

Screenshots: `18-settings`.

| # | Violation | Section | Severity | Fix |
|---|---|---|---|---|
| ST1 | Color swatches (Accent/Positive/Negative/Up candle/Down candle) and preset-preview dots are colorful by necessity (it's a color picker) — correctly exempted from "no decorative color," not a violation | §2 (exception applies) | — | None |
| ST2 | Contrast-ratio numbers next to each swatch (`6.8:1`, `5.2:1`...) are 12px muted text, consistent with the rest of the app's secondary-text convention — compliant | §3 | — | None |
| ST3 | The low-contrast warning ("2.5:1 low contrast for white button text") renders in an amber/yellow warning color inline with the Accent row — this is a legitimate semantic-state warning, not decoration, and doesn't compete with the modal's otherwise-neutral palette. Compliant. | §2 | — | None |
| ST4 | Modal section headers ("THEME", "LAYOUT", "DATA DEFAULTS", "SHORTCUTS") — confirm these follow the same 11px/uppercase/medium micro-label convention audited as non-compliant elsewhere (D2, table headers); if this modal's headers ARE correctly styled, it's evidence the correct component already exists somewhere in the codebase and just isn't reused by KpiTile/table headers | §3 | Medium (worth checking — may shortcut the D2/T2/B2 fixes) | Compare computed style of "THEME" label against KpiTile's "RESULT" label; if THEME is already 500-weight, reuse that class everywhere |

## Command palette + keyboard shortcuts overlay

Screenshots: `19-command-palette`, `20-shortcuts-overlay`.

| # | Violation | Section | Severity | Fix |
|---|---|---|---|---|
| CP1 | Both overlays are clean, single-surface, one-accent (the selected command row's blue highlight, the `Ctrl/Cmd+K` key-cap chips) — no borders-on-borders, consistent section-label styling ("RUNS", "INSTRUMENTS", "CHART", "GLOBAL", "CHART", "DRAWING"...). This is the best-executed surface in the audit alongside the Equity panel. | — | — | None — reference example |
| CP2 | Key-cap chips (`Ctrl/Cmd+K`, `→ / N`, `H`, `T`...) use a bordered pill treatment — technically a border, but it's functioning as a keycap affordance (a real-world keyboard-key metaphor), which is a defensible exception to "borders as last resort" rather than a violation | §2 | — | None, but worth an explicit exception note in DESIGN_LANGUAGE if this pattern spreads elsewhere |

## Empty / loading states

Screenshots: `21-dashboard-kpi-skeleton` (Trade List + Equity-tab skeleton), `14-prop-risk-loading-state` (blank, no skeleton).

| # | Violation | Section | Severity | Fix |
|---|---|---|---|---|
| L1 | Trade List's loading skeleton (grey rows matching final row count/height) is the best example in the app of "skeletons that match the final layout's shape" | §9 (compliant) | — | Reuse this exact pattern for Prop Risk (P1) and the chart canvas (C2) |
| L2 | `EmptyState` component (read from source, not independently screenshot-reachable with only one run in this bundle) renders a single muted title line + optional muted hint + optional action — matches §9 "quiet... one muted line + optional single action" exactly as documented. Compliant by inspection. | §9 (compliant) | — | None |
| L3 | Equity-tab's own loading skeleton (two large grey rectangles, seen in `21-dashboard-kpi-skeleton.png`) matches final chart-card shape reasonably well but doesn't preserve the card title text during load (title appears only after data resolves) — minor, the title costs nothing to render immediately since it doesn't depend on the fetch | §9 | Low | Render the card title text immediately, skeleton only the chart area beneath it |

## Runs list (entry point)

Screenshots: `00-runs-list-empty`.

| # | Violation | Section | Severity | Fix |
|---|---|---|---|---|
| R1 | Table row height measured at 37px, above the §4 "28–32px" band | §4 | Medium | Tighten row padding to land in 28–32px |
| R2 | Column headers ("Cmp", "Run", "Instrument", "Date range", "Result", "Params") measured at 14px/500, not uppercase — a different convention from the Dashboard/Trade-List table headers (12px/500, also not uppercase per T2/B2, but at least consistently 12px elsewhere) | §6, internal consistency | Medium | Pick one table-header convention (11-12px muted uppercase per §6) and apply it to every table in the app, this one included |
| R3 | "FAILED (mll_breach)" result cell uses negative-red on the whole cell text including the reason in parentheses — DESIGN_LANGUAGE says color the number/status, not surrounding text, though a status word is arguably closer to "the number" than a label is; low-confidence call, worth a second look during elevation rather than a hard verdict here | §9 "positive/negative color on the number only, not its label" | Low | Consider muting the `(mll_breach)` parenthetical to text-muted, keeping only "FAILED" in negative red |

---

## Cross-cutting patterns worth fixing once, not per-surface

- **Tabular numbers + right alignment (T1/B1/DI2 root cause).** One shared fix — add a `.num` utility (`font-variant-numeric: tabular-nums; text-align: right`) and apply it to every numeric table cell and KPI value across Trade List, Breakdowns, and the Score tab's KPI tiles — resolves the single highest-count violation class in this audit.
- **KpiTile value size (D1/DI2/S1 are all instances of the same component or its sibling).** One component fix cascades to Overview, Distributions, and (once reconciled with the Score number's own separate style) Score & AI.
- **Table header convention (T2/B2/R2).** Three different tables, three slightly different header treatments. Standardize once.
- **Micro-label weight (D2, and worth checking against ST4's THEME/LAYOUT labels — that modal may already have it right).** If Settings' modal section labels are already 500-weight, that's the class to copy everywhere else, not a new one to invent.
- **Blank-panel loading states (C2, P1) vs. the good pattern already in Trade List (L1).** Same fix, different panels — port the existing skeleton pattern rather than designing a new one.

## Suggested elevation order

Per DESIGN_LANGUAGE.md's own stated order (chart workspace → trade list → dashboard → prop risk/equity → settings/palette → global sweep), but given how much of this audit's *count* of findings is really 2–3 shared-component fixes (tabular numbers, KpiTile size, table headers, micro-label weight), consider doing a **global shared-component pass first** (tabular-nums utility, KpiTile size/weight, table header style) before the surface-by-surface loop — it would silently resolve roughly half the items listed above (T1, T2, B1, B2, D1, D2, DI2, R2, S3 partially) in one commit, and the remaining surface-specific items (C1 drawing-tool color, P1/P2 Prop Risk loading+label clutter, C2 chart skeleton) are the ones that actually need per-surface attention.
