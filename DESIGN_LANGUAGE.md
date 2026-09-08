# DESIGN_LANGUAGE.md — the quality bar (restrained / minimal)

Target: a high-end, clean, chart-first trading tool in the Linear / Vercel / TradingView-clean school. This file is the explicit standard every surface is measured against. Restrained/minimal is unforgiving — with little color and few borders to hide behind, spacing and typography carry the whole feel, so the rules below are concrete on purpose. Values are starting points; keep them consistent once chosen.

Ties into the existing token system (Part C). This governs *how* tokens are used, not new tokens.

## 1. Principles

- **Restraint is the aesthetic.** The default answer to "should I add a border / color / shadow / label?" is no. Elevate by removing.
- **Hierarchy through space and type, not lines and boxes.** Group with whitespace and alignment before reaching for a border or a card.
- **The chart is the hero.** Everything around it recedes — quiet chrome, muted controls, so price is the brightest thing on screen.
- **One accent, used rarely.** Accent means "this one thing is active/primary." If everything is accented, nothing is.
- **Calm.** No competing weights, no decorative color, no motion that draws attention to itself. The user should feel oriented instantly.

## 2. Color discipline

- **Neutral-dominant.** 90%+ of the UI is the neutral ramp (bg / surface / surface-2 / border / text / text-muted). Color appears only for (a) the single accent on the active/primary element, and (b) semantic positive/negative on *data* (PnL, win/loss).
- **No decorative color.** No colored section headers, no colored icons "for interest," no gradients. Session/compare categorical colors are the one exception and stay muted.
- **Trading-action exception.** Buy/Sell order-entry buttons (the sim broker's position ticket) are the one place an ACTION, not data, carries color: muted green Buy / muted red Sell (`bg-positive/15 text-positive` and `bg-negative/15 text-negative` — the same low-opacity badge recipe already used for the accent filter chip in DashboardPanel, never a solid/neon fill), everything else on that control (Close, side/contracts/entry-price text) stays neutral. Justification: direction-of-risk on a literal buy/sell action is domain convention strong enough to outweigh the data-only rule, same spirit as the session/compare exception above — but it stays exactly this narrow, muted, and does not license coloring other action buttons.
- **Borders are a last resort.** Prefer a background step (bg → surface) or spacing to separate regions. When a divider is truly needed, it's the faintest border token, 1px, never a heavy line. No nested borders (card inside card inside panel — pick one).
- **Elevation is subtle.** Flat by default. Shadows only on true overlays (menus, modals, tooltips), and soft/low — never on inline cards.
- **Text has two levels, occasionally three:** primary `--color-text`, secondary `--color-text-muted`, and rarely a third faint level for metadata. Don't color text to create hierarchy — use these levels.

## 3. Typography

- **One family.** Inter or the system UI stack for everything; a mono/tabular face only if Inter's tabular figures aren't used.
- **Type scale (px), no in-between sizes:** 11 (caps micro-labels), 12 (secondary/table), 13 (body/default), 14 (emphasis), 16 (panel titles), 20 (section KPI), 24–28 (hero KPI). Pick from this set only.
- **Two weights, mostly.** Regular (400) and medium (500). Semibold (600) only for hero numbers. Never bold everything.
- **Numbers are the product.** All prices, PnL, R, stats use **tabular / lining figures**, right-aligned in tables, consistent decimals per instrument (MES/MNQ 2dp, ZN per tick), thousands separators. A column of numbers must align on the decimal.
- **Micro-labels:** 11px, `--color-text-muted`, uppercase, ~0.04em letter-spacing, medium weight — for things like "NET PNL", "WIN RATE". Sentence case for everything else.
- **Line-height:** ~1.4 for body, ~1.1 for big numbers. Generous enough to breathe.

## 4. Spacing & density

- **4px base grid.** Every padding, gap, and margin is a multiple of 4 (4/8/12/16/24/32). No 5s, 7s, 13s.
- **Consistent panel padding:** 16px inside panels (12px for dense sub-areas). Section gaps 24px. Related items 8px. This consistency is 80% of "clean."
- **Table/list rows:** one row height (e.g. 28–32px), comfortable but not airy; consistent cell padding; hover is a subtle background step, not a border.
- **Restrained density, not cramped and not wasteful.** Readable at a glance; whitespace is intentional, not filler. When in doubt, more space between *groups*, less decoration within them.

## 5. Layout & structure

- **Flatten containers.** Aim for the fewest nested surfaces that still communicate grouping. A KPI doesn't need a bordered card if whitespace + a muted label already separate it.
- **Align to a grid.** Consistent left edges; labels and values line up across rows and panels. Misalignment is what reads as "amateur."
- **Quiet panel chrome.** Panel title bars: small (12–13px), muted, minimal controls revealed on hover where possible. The content is the point, not the frame.

## 6. Components & states

Every interactive element defines all five states; missing states are the main "unfinished" tell.

- **Buttons:** mostly ghost/secondary (transparent, muted text, subtle hover bg). **One** primary style (accent) reserved for the single main action in a context. Consistent height (28–32px), radius, and padding. Icon buttons are square, same height.
- **Inputs / selects:** surface bg, faint border only on focus, accent focus ring. Consistent height with buttons.
- **Tabs:** text tabs with an underline or subtle active bg — not boxed. Active = accent or primary text; inactive = muted.
- **Tables:** muted uppercase micro-label header, right-aligned numbers, zebra-free (use hover), sortable affordance appears on hover.
- **Tooltips / menus:** surface-2 bg, soft shadow, 12px text, tight padding, fast fade.
- **States:** rest / hover (subtle) / active / focus-visible (clear accent ring for keyboard) / disabled (reduced opacity, no pointer). Consistent across every component.

## 7. Iconography

- **One icon set**, consistent stroke width and size (16px default, 14px dense). Monochrome, inherit `currentColor` at the muted level; brighten on hover/active.
- Icons for **actions and wayfinding**, never decoration. If a label is clear enough alone, don't add an icon.

## 8. Motion

- **Fast and subtle:** 120–200ms, ease-out. For state changes, panel/menu open, tab switch, and the chart's scroll/fit easing (already 200ms — match it).
- **No** bounce, no long fades, no attention-seeking animation. Motion confirms an action; it never performs.
- Respect `prefers-reduced-motion` — drop non-essential transitions.

## 9. Data display (trading-tool specifics)

- Prices/PnL/R: tabular figures, right-aligned, fixed decimals, thousands separators; positive/negative color on the **number only**, not its label.
- The chart surface is the brightest, most saturated thing; surrounding panels sit a step back in contrast so the eye goes to price.
- Empty states are quiet: one muted line + optional single action, never a big illustration or bright callout.
- Loading: skeletons that match the final layout's shape (not spinners), in a faint surface step.

## 10. Anti-patterns (eliminate on sight)

Too many borders/cards; nested bordered containers; more than one accent color on screen; decorative or colored icons; inconsistent paddings (the 5/7/13px kind); non-tabular or center-aligned numbers; multiple competing font weights; heavy shadows on inline elements; color used to create hierarchy where spacing/type should; controls that are always fully visible when they could reveal on hover; spinners where a skeleton belongs.

---

## How to use this: the audit + elevation loop

This is the repeatable, forever-forward loop. Run the audit first (below), then elevate one surface per pass against the punch-list, verifying visually each time.

### Audit prompt (paste first — read-only)

```
Read DESIGN_LANGUAGE.md fully — this is our quality bar (restrained/minimal, TradingView-clean). Do a READ-ONLY visual audit, no code changes.

For each major surface — chart workspace, trade list, dashboard (all tabs), prop risk, equity, settings/theme editor, command palette, empty/loading states — take a screenshot and evaluate it against DESIGN_LANGUAGE.md section by section: color discipline, typography (esp. tabular numbers + type scale), spacing/4px-grid consistency, layout/nesting, component states, iconography, motion, data display, and the anti-pattern list.

Produce a prioritized punch-list as a markdown doc (DESIGN_AUDIT.md): each item = surface, what violates the bar, which section, severity (high/med/low), and the concrete fix. Group by surface. Call out the top ~10 highest-impact fixes that would most raise the 'high-end' feel. Do NOT change code yet — just the audit + screenshots referenced.
```

### Elevation prompt (repeat per surface, highest-impact first)

```
Read DESIGN_LANGUAGE.md and DESIGN_AUDIT.md. Elevate ONE surface to the bar: <surface name>. Apply its punch-list items — spacing to the 4px grid, tabular right-aligned numbers, remove excess borders/cards/nesting, correct type scale/weights, complete hover/focus/disabled states, quiet the chrome, one-accent discipline. Change only this surface (and shared components it forces, noting them). Keep all tokens/theming intact and tsc/tests/build green. Show me before/after screenshots and the checklist of what you changed.
```

Order of elevation: **chart workspace → trade list → dashboard → prop risk / equity → settings & command palette → global consistency sweep.** Commit after each surface.
