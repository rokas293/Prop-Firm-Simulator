# FXR_V2_SPEC.md — FX Replay UX parity, then Autopilot

v1 (F1–F7) built a correct engine: no-look-ahead sim broker, persistence, journaling, analytics, the Topstep verdict. v2 rebuilds the **trading experience** on top of it so it works and feels like FX Replay, then adds **Autopilot**: the propbt strategy trading a session on screen, step by step, so you can watch it and judge it.

This spec is based on FX Replay's help center, including its published screenshots (reference list in §9, viewable in a browser). Where their text and screenshots disagree, the screenshots win, since they show the current UI.

Keep: everything in CLAUDE.md's invariants (no look-ahead, engine truth, ET display, DESIGN_LANGUAGE colours/type/spacing). Change: the session workspace layout, the order flow, session setup, and how replay advances.

---

## 1. What FX Replay actually is (the mental model)

- **The session screen is one full-bleed chart.** No docked panels around it. Everything else is a thin top bar, a thin bottom bar, popovers, modals, and one bottom panel that slides up when you want it. Analytics and the journal are separate pages you jump to.
- **Size is chosen per order, never per session.** Session setup only asks for a name, balance, assets and a date range.
- **There are four ways to enter a trade**, from fastest to most deliberate: Quick Buy/Sell with a quantity box; right-click on the chart; Scalper Mode (quick buy/sell with preset SL/TP/break-even); and the position tool with a full order dialog.
- **SL/TP live on the chart.** After any entry without SL/TP, two "ghost" lines appear (SL orange, TP green). You drag them, and dollars, ticks and % update live; releasing confirms with a toast.
- **Replay steps at a chosen granularity, independent of the chart timeframe.** On a 1h chart stepping by 1m, the current hour's candle builds up minute by minute. That is most of what makes it feel like live trading.

## 2. Session workspace layout (target)

Matches FX Replay's current UI (reference images R1, R5, R6):

**Top bar (one row, ~40px):**
- Left: ← back · session name · settings gear.
- Centre: the **playback pill**: grip handle · speed slider · ◀| step back · ▶/❚❚ play · |▶ step forward · step-granularity dropdown (1m / 5m / 15m / 1h) · auto-play toggle.
- Right: Go To (view a date) · Place Order · Calendar · Journal · theme · fullscreen.

**Chart toolbar (one row):** symbol switcher (session assets) · timeframes · chart type · Indicators · layouts dropdown · undo/redo · screenshot.

**Left:** the existing drawing toolbar, plus a **Long/Short Position tool**.

**Bottom bar (one row, ~40px):**
- Left: hide-trades eye · **Buy** (green) · **Sell** (red) · **Quantity** input · **Scalper Mode** toggle (accent when armed).
- Centre: grip to drag up the trade panel.
- Right: Analytics · Prop Rules (prop sessions only) · **Balance · Realized P&L · Unrealized P&L** (tabular, coloured only on the number) · hide-balances eye · ^ expand panel · fullscreen.

**Bottom trade panel (slides up):** tabs **Positions | Orders | History**.
- Positions rows: symbol, side, qty, avg entry, SL, TP, open P&L ($ and R), and actions: close all, close partial (qty input), move SL to break-even.
- Orders rows: working limit/stop orders, with edit and cancel.
- History: closed trades (paginated) that open into the journal.

**On the chart:**
- Open positions show as a TradingView-style **position line** at entry, with a label `[LONG 2 | +$127.94 | ×]`. The × closes it.
- SL/TP are draggable lines with live labels showing $ / ticks / %.
- Working orders show as dashed lines with their own label and ×.

The dockview panels (Dashboard, Prop Risk, Equity, Trade List) move off the session screen onto the **Analytics page** (§6). The chart is the hero.

## 3. Order entry (the core of v2)

### 3.1 Quick Buy/Sell
The Quantity box holds whole contracts (MNQ/MES micros) and persists per session. Buy or Sell is a market order at the current step's price. If no SL/TP is set (and Scalper Mode is off), the ghost SL/TP lines appear immediately.

### 3.2 Ghost SL/TP (drag to place)
- Orange SL and green TP lines appear at sensible default distances.
- While dragging, the label shows P&L at that level in $, the distance in ticks, and %.
- Releasing sets the level and shows a toast. Either line can be removed on its own.
- Ghosts never appear if SL/TP were already set.

### 3.3 Right-click orders
The context menu shows the correct pair for where you clicked, using the Quick quantity: `Buy 2 MNQ @ 20,050.25 limit` and `Sell 2 MNQ @ 20,050.25 stop` (above the market: sell limit / buy stop; below: buy limit / sell stop). Keep the existing menu items under a separator.

### 3.4 Scalper Mode
A settings popover from the ⚡ button:
- SL on/off, value, unit (ticks / % / $).
- TP on/off, value, unit (ticks / % / R multiple).
- Auto break-even on/off, triggered by R multiple or by distance.

When armed (button turns accent), every Quick Buy/Sell gets these brackets automatically and no ghosts appear. Values are distances, never prices. Break-even requires an SL.

### 3.5 Position tool → Place Order dialog
Drawing a Long or Short Position tool on the chart (entry, stop and target boxes with live R:R and $ labels) enables **Place Order**, which opens the order dialog pre-filled from the tool. The dialog can also be opened empty from the top bar:

- Header: **Estimated loss** (red) · **Estimated profit** (green).
- Risk basis: **Initial balance / Current balance**.
- Risk chips: 0.25% · 0.5% · 0.75% · 1% · 2% · 3%. Then Risk % and Risk $ fields, which stay linked.
- **Position size (contracts)**: auto-computed from risk and stop distance, rounded **down** to whole contracts, and always editable. When rounding or a cap changes the risk, show the actual risk.
- Entry price · Type (Market / Limit / Stop) · Side.
- Stop loss toggle with price ⇄ ticks (linked). Take profit toggle with price ⇄ ticks (linked). Auto break-even toggle.
- Tags (multi-select) · optional **checklist** (the session's strategy rules as tick-boxes, §4).
- Actions: **Discard · Save · Save & Journal** (Save & Journal opens the journal entry for the trade once it fills).

The Topstep position cap still applies. An over-cap size is refused inside the dialog with the reason, not after submit.

### 3.6 Partials and management
- Close any quantity from the Positions row or the position-line menu, not only half.
- Move SL to break-even in one click.
- Partial exits journal as one trade with multiple exits (FX Replay calls this "trade merge"). The trade's R and P&L are computed across all its exits.

## 4. Session setup and home

**Home page:** KPI cards (trades taken with buy/sell split, overall win rate, average time in trade), a win-rate-by-weekday chart, a **Recent sessions** list (each card shows name, assets, date range, a progress bar with "N days remaining", a ▶ resume button, and an expand chevron), and **+ New session** in accent.

**Create a quick session:**
- Name · Account balance · **Assets** (multi-select chips: MNQ, MES).
- **Start date** and **End date**, each with the instrument's data range shown underneath ("Min 16 Jul 2021 · Max 15 Jul 2026"), plus quick **+1D / +1W / +1M** buttons that fill in the end date.
- Random start option.
- There are no contract or risk fields here; sizing happens per order.

**Advanced session:** commissions per instrument, the discipline lock, a **strategy checklist** (free-text rules that become tick-boxes in the order dialog), and **Prop firm session**:
- Rule builder: profit target, max loss (Static / Trailing / EOD-trailing), max daily loss, consistency %, position cap.
- Restrictions: news trading, holding overnight, holding over the weekend.
- Presets, starting with "Topstep 50k".
- Prop sessions disable rewind entirely, matching FX Replay.

A session ends when the cursor reaches its end date. The session then shows a completion state with links to analytics.

**Migration:** existing v1 sessions keep working. `default_contracts` becomes the starting Quick quantity, and the session's single instrument becomes its asset list.

## 5. Replay feel

- **Step granularity separate from chart timeframe.** The playback pill's dropdown sets what one step advances (1m by default). On a higher timeframe chart, the forming candle is aggregated from revealed 1m bars, so its OHLC only ever reflects data at or before the cursor. Indicators update to match.
- **Fills at step resolution.** Orders and SL/TP are evaluated on every 1m step. This also fixes v1's same-bar SL+TP ambiguity on higher timeframes, because we can see which level was touched first within the hour. It must stay strictly no-look-ahead.
- **Bar-by-bar rewind:** one step back, which is disabled in prop and discipline-locked sessions.
- **Play speed** in steps per second, plus auto-play.
- **Go To:** view a date without moving the session cursor (it's view-only, like FX Replay's Go To Date).
- **Smooth candles option:** animate the forming candle between steps during auto-play. This is cosmetic only and never reveals future data.
- **Hotkeys:** FX Replay's map as the reference, adapted to avoid browser and existing conflicts: next step (Ctrl+Space), play/pause, speed −/+, step granularity −/+, new market / limit / stop order, open order dialog, Buy/Sell (Shift-guarded, as in v1). All listed in the "?" overlay.

Data limit: we only have 1-minute bars, so seconds timeframes and tick replay are out of scope.

## 6. Analytics page and prop rules

The **Analytics page** is a full page opened from the bottom bar, scoped to one session or all sessions. It reuses the v1 dashboard work, reorganised to match FX Replay:
- **Session stats:** total P&L, win rate, average R:R, average gain per month / week / day.
- **Charts:** equity curve, monthly performance, performance by weekday.
- **Drawdown analytics:** heat in R on winners (average / max / min). This is the existing MAE work.
- **RR simulator:** "what if my target had been nR": replays each trade that had an SL at entry with a different TP and reports win rate, P&L, profit factor and average drawdown. At least 3 trades required.
- **Monte Carlo** (existing).
- **Trades table:** paginated, with a rows-per-page setting, and filters by tag, setup, grade, side and time.

**Prop Rules modal** (from the bottom bar, or Tab):
- Three progress cards: profit target, max loss used / left, daily loss used / left, each with a bar.
- A rules table and a restrictions checklist.

**Pass and fail:** a fail screen with "Try again" (a new session with the same rules) and "View analytics"; a pass screen with a summary card.

**Economic calendar:** events from `news_events.csv` shown as markers along the time axis (Show events toggle), plus a calendar popover. When the prop "no news trading" restriction is on, an entry inside the news window is refused with the reason.

## 7. Journal parity
- A session journal (free text) plus the existing per-trade notes, tags, grade and screenshots.
- Merged multi-exit trades (§3.6).
- Export CSV of trades with journal fields.
- Chart layouts (drawings and indicators) saved per session, so markings don't bleed between sessions.
- Candle types: candles, hollow, Heikin Ashi, bars, line.

## 8. Autopilot (automated sessions), after parity

Goal: watch the propbt strategy trade a replay session on screen, step by step, and judge its decisions.

- **Same broker, same rules.** The strategy places orders through the same sim broker API the UI uses, so fills, P&L, journaling and analytics are identical in kind. Bot trades are marked `source=bot`.
- **Execution convention.** The engine decides on the close of bar t and executes at the open of t+1 (CLAUDE.md). Autopilot must keep that convention, using a "fill at next open" market order, not the manual cursor-close fill. **Parity test:** an Autopilot run over a date range must produce the same trades and P&L as the offline propbt backtest for that range and config.
- **Visible reasoning.** Every bot action draws a marker with a short reason ("fair value 20,048.25 · NY open spike up · continuation long · SL 12pt / TP 1.5R"). Clicking it opens a decision panel showing the inputs the strategy saw at that bar.
- **Controls.** Autopilot on/off in the playback pill. It pauses on each trade (optional), and you can step through decisions.
- **Mixed mode.** You can take manual trades alongside the bot, and analytics can split results by source.
- **Compare.** Run the same session window with different strategy configs and compare results on the Analytics page.

## 9. Visual references (FX Replay's public help-center screenshots)

Claude Code can open these in its browser to match layout and density. Treat them as reference for structure and behaviour, not as assets to copy: no FX Replay logos or branding.

- R1 Session workspace + Scalper Mode (current UI): https://cdn.prod.website-files.com/676174e24c49177d0e49fa3b/68a4d6bff0c76aeba95e0ed4_attachment%253A03e66bd3-d547-49ae-a01e-25a51aa6fbcd%253Aimage.png
- R2 Place Order dialog + position tool + bottom bar: https://cdn.prod.website-files.com/676174e24c49177d0e49fa3b/67a62ab8fffb512d4a9dfade_31076276238093.png
- R3 Place Order dialog, lower half (TP, auto BE, tags, side, type): https://cdn.prod.website-files.com/676174e24c49177d0e49fa3b/67a62ab8ce7b0376dccef020_31076276243213.png
- R4 Quick Buy/Sell + quantity bar: https://cdn.prod.website-files.com/676174e24c49177d0e49fa3b/68a5e577fb412d317ede5448_attachment%253Aea9398f7-34b8-4a14-bbe7-aa066a527190%253Aimage.png
- R5 Right-click order menu: https://cdn.prod.website-files.com/676174e24c49177d0e49fa3b/68a5e577fb412d317ede544c_attachment%253A291fc349-efbf-4ff6-8305-97751f6cf378%253Aimage.png
- R6 Prop session workspace (bottom bar with Prop Firm Rules): https://cdn.prod.website-files.com/676174e24c49177d0e49fa3b/690bb4ffca80b2e06cfa9cf2_image4.webp
- R7 Stats & Rules modal: https://cdn.prod.website-files.com/676174e24c49177d0e49fa3b/690bb535daf415894db26f01_image5.webp
- R8 Create a quick session (assets, date range, +1D/+1W/+1M): https://cdn.prod.website-files.com/676174e24c49177d0e49fa3b/67a62ab8a2cec5bb1aacc488_31076267984141.png
- R9 Home dashboard + recent sessions: https://cdn.prod.website-files.com/676174e24c49177d0e49fa3b/67a4e1691031327ff16ecc4e_31609467565325.png
- R10 Open position line with P&L on chart: https://cdn.prod.website-files.com/676174e24c49177d0e49fa3b/67a4e04e94c54a5c8c55c76a_31075381755021.png
- R11 Ghost SL/TP while dragging: https://cdn.prod.website-files.com/676174e24c49177d0e49fa3b/68a5f00288d6fd42e694df98_attachment%253A714f4f91-1e94-4092-a457-67d144c7240b%253Aimage.png

---

## 10. Phases (paste one at a time; review before each commit)

Every phase: plan mode on; test sessions in a scratch directory; no-look-ahead preserved; DESIGN_LANGUAGE obeyed; verifier for the full gate; design-auditor with rendered screenshots compared against the listed references; don't commit until reviewed. Append to each prompt: *"In your report, describe each screenshot against DESIGN_LANGUAGE.md and the referenced FX Replay screenshots."*

**G1: Workspace shell.**
- Rebuild the session screen per §2: full-bleed chart, top bar with the playback pill, bottom trading bar with balances, and the slide-up Positions / Orders / History panel.
- Move the dock panels to an Analytics route.
- Session model: assets[], end_date, quick_quantity (replacing default_contracts), with a migration for v1 sessions.
- References: R1, R6, R10.

**G2: Fast order entry.**
- Quick Buy/Sell with the quantity box.
- Ghost SL/TP with live $/ticks/% labels and a confirm toast (§3.2).
- On-chart position line with P&L and ×.
- Working-order lines.
- Right-click orders with quantity (§3.3).
- Partial close of any quantity, and break-even in one click (§3.6).
- References: R4, R5, R10, R11.

**G3: Position tool + Place Order dialog** (§3.5), with risk-based sizing, linked fields, checklist, and Save & Journal. References: R2, R3.

**G4: Scalper Mode + hotkeys** (§3.4, §5 hotkeys). Reference: R1.

**G5: Replay feel** (§5).
- Step granularity separate from chart timeframe, with the forming candle built from 1m data.
- Fills evaluated at 1m resolution (with tests proving the same-bar ambiguity is resolved correctly and nothing leaks from the future).
- Rewind, speed, Go To, smooth candles.
- Raise effort to high for this phase.

**G6: Session setup + home** (§4): quick and advanced creation, date range with min/max hints and +1D/+1W/+1M, the prop rule builder with presets, recent sessions with progress, and the completion state. References: R8, R9.

**G7: Multi-asset + calendar.** MNQ and MES in one session with a shared cursor and account; news events on the chart; the news-trading restriction.

**G8: Analytics page + prop rules** (§6): session stats, charts, drawdown analytics, RR simulator, paginated trades table, the Stats & Rules modal, and pass/fail screens. Reference: R7.

**G9: Journal parity** (§7): session journal, merged multi-exit trades, CSV export, per-session layouts, candle types.

**G10: Autopilot** (§8): strategy adapter on the sim broker, next-open execution, the **parity test against offline propbt**, decision markers and panel, mixed mode, run compare. Raise effort to high for this phase.

**G11: Parity audit.** Rendered side-by-side review of every surface against R1–R11; punch-list; fix.
