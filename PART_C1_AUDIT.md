# Part C1 pre-work audit — color inventory & token proposal

Read-only audit per `REDESIGN_APPROACH.md` Part C and `PART_A_REVISED_klinecharts.md`'s Part C3 note, done before writing any token-system code. No code changed in this pass.

## 1. Baseline

- `git status` — clean.
- `tsc -b` — clean.
- `vitest run` — 19/19 files, 172/172 tests pass.
- `npm run build` — clean (existing >500kB chunk-size warning is pre-existing and unrelated).

Safe to start Part C1 from here.

## 2. Color inventory by surface

### 2a. App shell (React components, Tailwind + raw CSS)

`src/index.css` already defines a partial token system (`@theme` block, added Phase P1):

```
--color-surface-canvas / --color-surface-raised / --color-surface-grid
--color-border-default / --color-border-hover
--color-text-muted / --color-text-body / --color-text-heading
--color-accent-blue / --color-accent-green / --color-accent-red / --color-accent-amber
--radius-panel, --shadow-panel-float
```

Of these, only **three are runtime-tunable today**: `applyThemeToDocument()` (in `themeStore.ts`) overwrites `--color-accent-blue/green/red` from `useThemeStore`'s `{accent, up, down}` on every theme change. `--color-accent-amber` and all surface/border/text tokens are build-time constants — no live theming path exists for them yet.

**The bulk of the app shell doesn't consume these tokens at all.** It uses Tailwind's stock (non-token, non-tunable) gray scale directly:

| Class | Count |
|---|---|
| `text-neutral-300` | 64 |
| `bg-neutral-800` | 55 |
| `text-neutral-500` | 43 |
| `border-neutral-800` | 30 |
| `bg-neutral-700` | 30 |
| `text-neutral-400` | 21 |
| `text-neutral-200` | 20 |
| `bg-neutral-900` | 16 |
| `border-neutral-700` | 12 |
| `text-neutral-600` | 10 |
| `text-neutral-100` | 9 |
| `bg-neutral-950` | 5 |
| `border-neutral-900` | 4 |
| `border-neutral-500` | 1 |
| `bg-neutral-100` | 1 |
| `text-white` | 12 |

That's **~300+ raw-neutral usages** vs. **36 total** usages of the app's own tokens (`bg-accent-blue` ×13, `text-accent-red` ×12, `text-accent-green` ×6, `text-accent-blue` ×3, `border-accent-blue` ×2). Virtually every panel, card, button, and table in the app is chrome-colored with Tailwind's un-overridable defaults, not tokens — this is the largest single item Part C1 has to fix, by volume.

There's already a small Settings-panel theme editor (4 presets + 3 raw `<input type="color">` pickers for accent/up/down only) — a real precedent to extend in C2, not build from scratch.

### 2b. KLineCharts price chart (`ChartKL.tsx` + `chart/kl/*`)

- `themeStyles()` → `chart.setStyles()` covers **only** `candle.bar.*` (up/down/border/wick/no-change) and `indicator.bars[0].*` (VOL up/down). Re-applied on mount and on every `colors` change. ✅ theme-reactive.
- Trade overlays (`tradeOverlays.ts`: entry/exit annotations, SL/TP lines, PnL/bracket zones) read `useThemeStore`'s `colors` live and rebuild on every theme change. ✅ theme-reactive.
- **Everything else klinecharts renders is untouched, unthemed, using klinecharts' own built-in defaults**: pane/chart background, grid lines, crosshair, axis text/line color, and the default styling of user-drawn overlays (trendline/rect/fib/etc. — `drawingOverlays.ts` has zero color code, so newly-drawn tools get whatever klinecharts ships by default).
- Session-band shading + fair-value line (`sessionOverlay.ts`) use **4 fixed per-session `rgba()` hues** (asia/london/ny/news) plus a default gray — not read from `useThemeStore` at all, by design (these are categorical identity colors, not accent/up/down).
- VWAP/EMA20/EMA50/ATR14 line colors (`indicators.ts`) are **4 fixed hex constants**, baked into a one-time global `registerIndicator()` call at app start — not theme-reactive, and structurally the hardest item here to make live: overlays get fresh styles on every rebuild already, but klinecharts' indicator registration is a one-shot; restyling on theme change will need either an override call (if klinecharts exposes one) or a full re-register, which needs checking against the installed version's docs before C3 assumes either.

### 2c. lightweight-charts RiskChart (`chart/RiskChart.tsx`, used by Equity/Prop Risk panels)

- Series colors (equity=accent, MLL floor=down, target=up) and the MLL breach band (`hexToRgba(colors.down, 0.15)`) **are** theme-reactive — set in the `[equity, colors]` effect. ✅
- The chart-level `createChart()` options (`layout.background`, `layout.textColor`, `grid.vertLines/horzLines`, `timeScale.borderColor`, `rightPriceScale.borderColor`) are **hardcoded hex, set once at creation, and never re-applied on theme change** — no `chart.applyOptions()` call exists for them at all. They also happen to duplicate `--color-surface-canvas` / `--color-text-body` / `--color-surface-grid` / `--color-border-default`'s exact values as separate raw literals, so today they're consistent with the shell only by coincidence.
- `DAILY_LOSS_COLOR` / `LOCK_COLOR` = fixed `#d29922` (amber). The code comment is explicit this was a **deliberate Phase P6 decision**: "a third semantic outside the theme's up/down/accent model" — not an oversight, but it does mean this color won't move if a user picks a different theme, unlike everything else on this chart. (That comment also references a `DrawingLayerPrimitive` that no longer exists — a stale reference from the deleted old LWC drawing engine, harmless but worth a cleanup note.)

### 2d. Stats charts (Recharts — no ECharts is actually used anywhere in this repo)

- `EquitySparkline.tsx` — ✅ already correct: `stroke={colors.accent}` from `useThemeStore`.
- `DashboardPanel.tsx` — **mixed**. Win/loss bars and scatter points correctly take `colors.up`/`colors.down` as props (`winColor`/`lossColor`, `<Scatter fill={colors.up}>`). But every `CartesianGrid`/`XAxis`/`YAxis`/`Tooltip` in the same file hardcodes grid/axis/tooltip chrome (`#21262d`, `#8b949e`, `#161b22`, `#30363d`, ×~15 occurrences), and one `<Scatter fill="#d29922">` (clipped stops) hardcodes the same de-facto amber found in RiskChart/RiskPanel.
- `EquityPanel.tsx`, `ComparePage.tsx` — same hardcoded grid/axis/tooltip chrome pattern, no theme-reactive colors at all in the chart chrome.
- `ComparePage.tsx` additionally needs a genuine **second identity color** (Run B, `COLOR_B = '#e3b341'`) distinct from Run A's `colors.accent` — this isn't a chrome color, it's a categorical/comparison color that can't just become "the accent" (both runs would look identical).

Because Recharts renders SVG (not canvas), its `stroke`/`fill` props can take a CSS custom property string directly (`stroke="var(--color-text-muted)"`) — the static chrome colors don't need a `useThemeStore` subscription at all, unlike klinecharts/lightweight-charts which are canvas and need the JS-side store. Only genuinely per-datum colors (win/loss bars, Run A/B) need the JS value.

## 3. Every hardcoded color literal, grouped by file

Raw hex / `rgb()` / `rgba()`:

| File | Literals |
|---|---|
| `chart/kl/indicators.ts` | `#e3b341` (VWAP), `#79c0ff` (EMA20), `#d2a8ff` (EMA50), `#8b949e` (ATR14) |
| `chart/kl/sessionOverlay.ts` | `rgba(163,113,247,.07)` asia, `rgba(88,166,255,.07)` london, `rgba(63,185,80,.07)` ny, `rgba(210,153,34,.09)` news, `rgba(139,148,158,.06)` default, `rgba(201,209,217,.6)` fair-value line |
| `chart/RiskChart.tsx` | `#d29922` ×2 (daily-loss/lock), `#0d1117`, `#c9d1d9`, `#161b22` ×1, `#30363d` ×2 |
| `chart/MllBandPrimitive.ts` | `rgba(248,81,73,.15)` default band fill |
| `pages/ComparePage.tsx` | `#e3b341` (Run B), `#21262d`, `#8b949e` ×3, `#161b22`, `#30363d` |
| `panels/DashboardPanel.tsx` | `#21262d` ×4, `#8b949e` ×8, `#161b22` ×4, `#30363d` ×4 (one as `<ReferenceLine stroke>`), `#d29922` (clipped-stops scatter) |
| `panels/EquityPanel.tsx` | `#21262d` ×2, `#8b949e` ×3, `#161b22` ×2, `#30363d` ×2 |
| `panels/RiskPanel.tsx` | `#d29922` ×3 (threshold fn + two Legend swatches) |
| `state/themeStore.ts` | preset seed values (4 presets × 3 hex each) — **not a violation**, this is the theme system's own source data by design |
| `index.css` | the `@theme` block's own hex values — **not a violation**, this is the token definition itself |

Non-token Tailwind color classes (raw palette, not app tokens): the `neutral-*`/`white` table in §2a, spread across essentially every `.tsx` file with UI chrome (panels, toolbars, tables, buttons) — too widespread to usefully enumerate file-by-file here; treat it as "the whole app shell" rather than a short list. `text-amber-400` (`PerfHud.tsx` ×2, `DashboardPanel.tsx` ×1) and `bg-neutral-100` (`RiskPanel.tsx` ×1) are the two odd ones out — both are semantic (warning/alert), not decorative, and neither maps to an existing token.

## 4. Proposed token set

Recommendation: **extend the existing `--color-*` family** (already wired into Tailwind v4's `@theme`, already used by dockview/cmdk CSS) rather than introduce REDESIGN_APPROACH's literal `--bg`/`--surface`/`--surface-2` names as a second, parallel naming scheme. The app's existing 3-tier surface naming (`canvas`/`raised`/`grid`) is already more specific than a flat `bg`/`surface`/`surface-2`, so I'd map REDESIGN's suggested list onto it rather than rename:

| REDESIGN_APPROACH name | Maps to (existing or new) |
|---|---|
| `--bg` | `--color-surface-canvas` (exists) |
| `--surface` | `--color-surface-raised` (exists) |
| `--surface-2` | *(new)* — a third elevation for nested cards-on-cards, if C1/C2 need it; otherwise skip, `raised` already covers "card" |
| `--border` | `--color-border-default` (exists) |
| `--text` | `--color-text-body` (exists) |
| `--text-muted` | `--color-text-muted` (exists) |
| `--accent` | `--color-accent-blue` (exists, name is a little odd once presets aren't blue — see risk below) |
| `--positive` / `--negative` | **new** — see §5, must NOT just alias `up`/`down` |
| `--up-candle` / `--down-candle` | `--color-accent-green` / `--color-accent-red` renamed/aliased for clarity that these are candle-specific |
| `--grid` | `--color-surface-grid` (exists) |
| `--selection` | **new** — formalize cmdk's current ad hoc `color-mix(accent-blue 12%, transparent)` |

Additional tokens this app needs that aren't in REDESIGN_APPROACH's base list:
- `--color-warning` — promotes the de-facto amber (`#d29922`, used identically in 4 files today) to a real theme token, since it currently won't change with the rest of the theme.
- A small **categorical** sub-palette for identity colors that must never be swallowed into positive/negative/accent: `--color-session-asia/london/ny/news` (4) and `--color-compare-a/b` (2, where `a` = accent). These are "which thing is this" colors, not "is this good or bad" colors — conceptually a different axis from the rest of the token set.

Per-surface consumption, concretely:

| Surface | How it takes tokens |
|---|---|
| App shell | Tailwind utility classes generated from `--color-*` (already the working pattern) — this is a **rename/replace pass** across ~300 raw-neutral call sites, not new infrastructure |
| KLineCharts | JS object → `chart.setStyles()`, read from `useThemeStore` (extend the existing `themeStyles()` function's scope to background/grid/crosshair/axis; indicator colors need a registration-time-vs-live-restyle investigation first) |
| lightweight-charts RiskChart | `chart.applyOptions()` for the top-level layout/grid/scale config (new — doesn't exist today), same `[colors]`-keyed effect pattern already used for its series |
| Recharts | Static chrome (grid/axis/tooltip) can take `"var(--color-text-muted)"` etc. directly as SVG props — no store subscription needed; per-datum colors (win/loss, compare A/B) keep reading `useThemeStore` as they already correctly do in `EquitySparkline`/parts of `DashboardPanel` |

## 5. Risks — colors that carry meaning

1. **Up/down candle color is currently the same pair as positive/negative meaning, and it shouldn't be.** `colors.up`/`colors.down` today drives *both* literal candle rendering *and* every "is this good or bad" use (PnL text, compass score tiers, win/loss badges, RiskPanel's safe/breach states). REDESIGN_APPROACH's own token list already anticipates this split (`--positive`/`--negative` vs `--up-candle`/`--down-candle` as separate names) — some traders genuinely prefer red-up/green-down candles, which would be actively wrong if it also flipped every "positive" label to red. **Recommend treating this as two independent token pairs from the start**, defaulted to the same values, so C2's editor can let a user flip candle convention without breaking every other "green = good" surface in the app.
2. **Amber "warning" isn't part of the theme model at all today.** It's a real, repeated semantic (daily-loss floor, near-breach state, compass mid-tier, slow-perf hint) hardcoded identically in 4 files, explicitly by a past deliberate choice to keep it "outside" the theme. Promoting it to `--color-warning` is a small, low-risk change but a real decision point: should users be able to retint warning at all, or does C2 keep it fixed (matching the prior P6 intent) while still making it a token for consistency/theme-awareness elsewhere?
3. **Session-band colors and the compare-page's Run B are categorical identity, not sentiment.** They must not be derived from positive/negative/accent — a session or "the other run" isn't good or bad, it's just a different thing that needs to stay visually distinct from its neighbors. These need their own fixed (or lightly tunable) small palette, ideally chosen for mutual distinguishability, not folded into the 3-slot theme.
4. **klinecharts indicator colors are baked at one-time registration**, unlike overlays which already rebuild fresh per theme change — this is a real implementation cost for C3, not just a token-mapping exercise, and needs a version-doc check (per this project's own klinecharts API-version discipline) before assuming an override mechanism exists.
5. **RiskChart's chart-level options have no re-apply-on-theme-change path today** (only its series do) — C1/C3 needs to add one, mirroring the pattern already proven on its series effect.
6. **Naming risk:** `--color-accent-blue/green/red` bakes a hue name into a semantic slot's variable name. Harmless while "blue=accent, green=up, red=down" happens to hold, but confusing once a preset breaks that assumption (e.g. an amber accent, or red-up candles). Worth deciding now whether C1 does a one-time rename to purely semantic names (`--color-accent`, `--color-positive`, etc.) — touches ~36 existing Tailwind-class call sites, small but real churn — versus keeping the current names and accepting the mismatch. Flagging for your call rather than deciding unilaterally.

---

No code changed. Awaiting approval before starting Part C1 implementation.
