# Dashboard Redesign Proposal (REDESIGN_APPROACH.md Phase B1)

Audit of the current Dashboard/Compass/Prop Risk/Equity panels against VIZ_SPEC.md §7, and a proposal for the calm version.

> **Status: approved with 3 adjustments, and implemented in Phase B2.** See §7 for the adjustments as approved. Everything else in §1–§6 below is the original B1 proposal, kept as-written for the record — where an adjustment changed something, §7 is the authoritative version, not the passage it corrects.

## 1. Inventory + classification

### Dashboard panel

| Element | Classification | Note |
|---|---|---|
| Scope toggle (OOS/IS/All) | HERO | but see §2 — duplicated with Compass's own copy |
| KPI: Net PnL | HERO | |
| KPI: Net R | HERO | |
| KPI: Win rate | HERO | |
| KPI: Expectancy | HERO | |
| KPI: Profit factor | SECONDARY | technical, not glance-worthy |
| KPI: Max drawdown | HERO | prop-rule relevant |
| KPI: Trades | SECONDARY | context, not performance |
| KPI: Trading days | SECONDARY | context, not performance |
| Result banner (status/fail reason/target hit/consistency/final balance) | HERO | currently a separate strip below the KPI row — should *be* part of the hero row, not bolted under it |
| By-leg breakdown table | SECONDARY / **DUPLICATE** | byte-for-byte identical table also rendered in Compass |
| By-session breakdown table | SECONDARY / **DUPLICATE** | same |
| R-multiple histogram | SECONDARY | |
| MAE/MFE scatter | SECONDARY / **overlaps** | same underlying signal as Compass's "stop efficiency" KPI row, two different visualizations of it |

### Compass panel

| Element | Classification | Note |
|---|---|---|
| Scope toggle (OOS/IS/All) | **DUPLICATE** | independent `useState` from Dashboard's — the two can disagree (Dashboard on "All", Compass still on "OOS") since nothing syncs them |
| Compass score card (4 components) | SECONDARY | |
| AI insight button | SECONDARY | |
| By-leg / by-session tables | **DUPLICATE** | identical to Dashboard's, same component (`BreakdownTable`), same data (`stats.by_leg`/`by_session`) |
| Net PnL by hour-of-day / weekday / hold-time charts | SECONDARY | genuinely new information, not duplicated elsewhere |
| Win/loss streak distribution | SECONDARY | |
| MAE/MFE regime KPI row (losses/clipped/share/avg-MAE-SL) | SECONDARY / **overlaps** | see above |

### Prop Risk panel — out of scope this phase

Legend + one big annotated equity/MLL/target chart + a daily-risk strip. Already single-purpose and uncluttered. Not touched.

### Equity panel — out of scope, one note

Two small Recharts curves (equity+MLL floor, drawdown-from-peak). Already minimal. Worth flagging: it's a lighter-weight duplicate of the equity curve already drawn (with more annotation — breach markers, daily-lock strip) inside Prop Risk. Not proposing a change this phase, just naming it so it doesn't get re-discovered later as a surprise.

## 2. The actual problem

It's not that any *one* panel is badly designed — `KpiTile`/`ChartCard`/`BreakdownTable` were already extracted into shared components in an earlier phase. The problem is structural: **Dashboard and Compass are two separate dockable panels that independently fetch the same scope, the same stats, and the same trades**, then each renders its own copy of the leg/session tables and its own take on "how tight are the stops." In the default layout they're tabbed together with Prop Risk and Equity into one ~260–340px strip below the chart — so opening that strip means picking between two panels that already disagree with each other about which scope is active.

Everything else (redundant nested borders, no formal spacing/type scale) is real but secondary to that.

## 3. Proposal

### Merge Dashboard + Compass into one panel, internally tabbed

One panel, one `scope` state, one `useStats`/`useTrades` fetch, shared by every tab. This is the change that actually removes the duplication rather than just re-arranging it. Concretely:

- **Hero row** (always visible, not in a tab): Result · Net R · Win rate · Expectancy · Max drawdown — 5 items, matching REDESIGN_APPROACH.md's example almost exactly. Profit factor / Trades / Trading days move to a small "details" line under the hero row (still visible, just visually demoted — text, not tiles).
- **Tabs below the hero row**, lazily rendered:
  - **Overview** *(default tab)* — one primary visual: the equity curve (promoted here from the Equity panel's simple version). This is the "one chart visible by default" the brief asks for.
  - **Breakdowns** — by-leg / by-session tables. *One* copy.
  - **Distributions** — R-multiple histogram, MAE/MFE scatter, hour-of-day, weekday, hold-time, streak distribution. All the "where/when does this strategy make or lose money" views live together.
  - **Score & AI** — Compass score card + the optional AI summary button.

This also directly answers REDESIGN_APPROACH.md's suggested tab set (Breakdowns/Distributions/Risk/Trades) — Risk and Trades already have dedicated, uncluttered panels (Prop Risk, Trade List), so they don't need a duplicate tab here.

### One Card primitive

`ChartCard` and `BreakdownTable`'s own wrapper `<div>` are already visually identical (`rounded border border-neutral-800 bg-neutral-900 p-4`), but the result banner, Compass's AI-insight box, and Equity panel's chart wrappers each re-type that same string ad hoc instead of using `ChartCard`. And `ScoreCard`'s four component tiles use `bg-neutral-950` where everything else uses `bg-neutral-900` — a small, visible inconsistency. Proposal: one `Card` component (title optional, for both chart-frame and plain-content use), everything else migrates to it, ad hoc copies deleted.

### Kill nested borders

Today a Compass score component tile (bordered) sits inside the ScoreCard (bordered) sits inside the dockview panel (bordered/titled). Proposal: only the outer `Card` gets a border; things nested inside a `Card` use spacing/background-shade to separate, not another border.

### Spacing scale

No new tokens needed — Phase P6's theme tokens already cover color. This is just *formalizing* the spacing values already in ad hoc use (`p-2`/`p-3`/`p-4`, `gap-2`/`gap-3`/`gap-4`, gaps of `mb-4`/`mb-6`) into a named scale (`space-xs/sm/md/lg` = 4/8/12/16px) so new panels pull from it instead of guessing.

## 4. Wireframe (merged Dashboard panel)

```
┌─ Dashboard ──────────────────────────────────────────────────────────┐
│ Scope: [Out-of-sample] [In-sample] [All]                             │
│                                                                       │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌───────────┐ ┌────────────┐       │
│  │ RESULT │ │ NET R  │ │  WIN   │ │ EXPECTANCY│ │ MAX DRAWDOWN│      │
│  │ FAILED │ │ -102.4R│ │ 44.3%  │ │  -$1.53   │ │   -$2,040   │      │
│  └────────┘ └────────┘ └────────┘ └───────────┘ └────────────┘       │
│  profit factor 0.86 · 1191 trades · 229 trading days                 │
│                                                                       │
│  [ Overview ] [ Breakdowns ] [ Distributions ] [ Score & AI ]        │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                                                                │  │
│  │                     equity curve (one chart)                  │  │
│  │                                                                │  │
│  └───────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────┘
```

Switching to **Breakdowns** replaces the chart area with the by-leg/by-session tables; **Distributions** with the histogram/scatter/hour/weekday/hold-time/streak charts; **Score & AI** with the Compass score card and summarize button. Hero row and scope toggle stay fixed above all four.

## 5. What reconciles / what doesn't change

- Every hero KPI still reads directly off `stats.overall.*` — no new computation, same VIZ_SPEC §0 guarantee.
- `by_leg`/`by_session` stay server-computed `GroupStats`, just rendered once instead of twice.
- Compass's pattern breakdowns (`compass/breakdowns.ts`, `compass/regime.ts`, `compass/score.ts`) are unchanged — only *where* they render moves.
- Cross-filtering (click a leg/session row → filters Trade List + Chart) is preserved, now with one code path instead of two.
- Prop Risk, Equity, Trade List, Chart panels: untouched. Layout presets (`Analysis`/`Chart-focused`/`Stats`) get updated to reference one merged panel instead of two, otherwise unchanged.

## 6. Open questions before I implement (B2)

1. **OK to merge Compass into Dashboard as one panel with tabs**, rather than keep them as two separate dockable panels? This is the one structural (not just visual) change here — it's what actually removes the duplication, but it does mean losing the ability to dock "Compass" and "Dashboard" independently side by side. (Old panel ID stays reachable — the `+ Panel` menu and command palette just point at one merged panel instead of two.)
2. **The 5 hero KPIs** — Result, Net R, Win rate, Expectancy, Max drawdown. Swap any of these?
3. Any objection to promoting the equity curve into the merged panel's default "Overview" tab (on top of it still existing, in more detail, inside Prop Risk)?

Reply with any changes, or just say go and I'll implement this as B2.

## 7. Approved adjustments (supersedes the above where they conflict)

The merge (§3, question 1) was approved as-is — Dashboard and Compass are now one panel, one `scope`, one fetch, one `Card` primitive, exactly as proposed. Three changes on top of that:

1. **Hero row is 5 *prop-relevant* KPIs, not the original 5.** Final set: **Result · Net P&L in $ (R as a subunit) · Max drawdown framed against the $2k MLL · Expectancy (R) · Profit factor.**
   - Net leads in **$**, not R — Net R and Expectancy(R) were redundant on the original hero row, so Net P&L now carries the dollar headline with R shown as a small subunit underneath.
   - **Profit factor replaces Win rate** up top — win rate alone misleads when RR is variable (a 30%-win-rate strategy with 3R average winners is healthy; the raw percentage alone reads as a red flag). Win rate moved to the Overview tab instead of being cut.
   - **Max drawdown** now shows a "*X% of $2k MLL*" subunit, not just the raw dollar figure, so it reads directly against the prop-rule limit instead of requiring mental math.
   - Win rate and days-to-pass/fail both moved into the **Overview** tab (demoted, not removed — reachable in one click, per the "nothing deleted" rule).
2. **Do not duplicate the equity curve.** §3/§4's plan to promote the full equity curve into the Overview tab was replaced with a compact, axis-less, tooltip-less **sparkline** (`EquitySparkline`, max 200 points) plus a "View full chart →" link that jumps to Prop Risk. The full MLL-annotated, breach-marked, interactive curve stays exactly one place: the Prop Risk panel.
3. Everything else in §3 (one `Card` primitive, no nested borders, spacing scale, tab set, cross-filtering preserved) shipped as proposed.

### Actual hero row + wireframe, as implemented

```
┌─ Dashboard ──────────────────────────────────────────────────────────┐
│ Scope: [Out-of-sample] [In-sample] [All]                             │
│                                                                       │
│  ┌────────┐ ┌───────────┐ ┌──────────────┐ ┌───────────┐ ┌────────┐ │
│  │ RESULT │ │  NET P&L  │ │ MAX DRAWDOWN │ │ EXPECTANCY│ │ PROFIT │ │
│  │ FAILED │ │ -$1,821.80│ │  -$2,040.10  │ │  -0.09R   │ │ FACTOR │ │
│  │mll_bre.│ │  -102.37R │ │102% of $2kMLL│ │           │ │  0.86  │ │
│  └────────┘ └───────────┘ └──────────────┘ └───────────┘ └────────┘ │
│  1191 trades · 229 trading days                                     │
│                                                                       │
│  [ Overview ] [ Breakdowns ] [ Distributions ] [ Score & AI ]        │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │ win rate · target hit · consistency · final balance            │  │
│  │ Equity (full run)                        View full chart →     │  │
│  │  ╲___                                                          │  │
│  │      ╲________________________________                        │  │
│  └───────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────┘
```

Verified live against a real run bundle (20260802T180304Z_6b373299, MNQ, 1191 trades) — hero row and sparkline reconcile exactly with the backend's `stats.overall.*` and `/equity` endpoint, in both a populated scope ("All") and the empty-OOS edge case, with no crash or NaN.
