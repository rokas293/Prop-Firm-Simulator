# FXR_SPEC.md — FX Replay-style manual backtesting platform (personal)

North-star product spec for turning the existing app into a high-end, FX Replay-style **manual backtesting / replay / journaling** platform, scoped to **MNQ + MES** (expandable later). Personal project. Pairs with `DESIGN_LANGUAGE.md` (visual bar), `VIZ_SPEC.md` (data contract), `REPLICA_ROADMAP.md` (TradingView-parity, now done), and `CLAUDE.md` (engine/data/prop rules).

Modeled on FX Replay's actual workflow: pick asset + timeframe + start date → replay candle-by-candle with the future locked out → place/manage simulated trades on the chart → everything auto-journals → review performance in an analytics dashboard. Sources at bottom.

---

## 1. What this is (and the key insight)

FX Replay is a **manual, discretionary** trainer: you trade *by hand* against replayed history and it journals and analyzes you. This is different from what you built first (an *automated* strategy backtester). But the striking part: **most of FX Replay's surface area already exists in your app.** The genuinely new work is concentrated in one place — a **simulated broker** you can trade during replay — plus **sessions** and **journaling**. Everything else is reuse.

### Reuse map — where the work actually is

| FX Replay capability | Your app today | Work |
|---|---|---|
| TradingView-style chart, drawings, indicators, measure, split | KLineCharts build (Batches 1–5) | ✅ have |
| Bar replay, lock future candles, step/speed, click-to-set-start | replay engine + `chart/replay.ts` + free camera | ✅ have (extend) |
| Multi-asset data (MNQ/MES) | Databento pipeline + `/api/bars` | ✅ have |
| Performance dashboard (equity, win rate, expectancy, PF, drawdown, by-session) | Dashboard/Compass panels | ✅ have → **repoint to manual trades** |
| Drawdown-in-R / "heat" analytics | MAE/MFE already computed per trade | ✅ have → repoint |
| Monte Carlo simulation | already in the backtest engine | ✅ have → repoint |
| **Prop-firm challenge simulation** | **you already model Topstep rules** | ✅ have → huge reuse |
| Theming, workspace, command palette | done | ✅ have |
| **Simulated broker: place/manage trades in replay** | — | **NEW (keystone)** |
| **Sessions: start/save/resume a backtest** | — | **NEW** |
| **Journaling: notes, tags, screenshots per trade** | partial (trade records exist) | **NEW (mostly)** |
| On-chart order tools (drag entry/SL/TP, right-click order) | right-click menu exists (Batch 1) | **NEW, on existing foundation** |

**Build order follows this:** the sim broker is the keystone everything hangs off, so it comes first (after the session shell it needs).

---

## 2. Core concepts / data model

Keep manual trades **schema-compatible with the existing trade-record model** (entry/exit/side/size/pnl/R/mae/mfe/tags) so the analytics dashboard, Monte Carlo, MAE/MFE and prop-rule views repoint with minimal change. New entities:

- **BacktestSession** — `{ id, instrument, base_timeframe, start_time (replay anchor), created_at, cursor_time, account_id, status (active/archived), settings }`. The unit you start, save, resume, and list.
- **SimAccount** — `{ id, starting_balance, balance, currency, risk_per_trade (%, or fixed $), default_contracts, commission_per_contract, optional prop_ruleset (reuse Topstep config) }`.
- **Order** — `{ id, session_id, type (market/limit/stop), side, price (for limit/stop), size, sl_price?, tp_price?, status (working/filled/cancelled), placed_cursor_time, filled_cursor_time? }`.
- **Position** — derived from filled orders: `{ side, size, avg_entry, sl_price?, tp_price?, open_pnl, open_r }`. Supports partial closes and (optionally) multiple concurrent positions.
- **ManualTrade** — the journaled record once flat: the existing trade schema + `{ session_id, tags[], notes, screenshots[], setup_name, grade, entry_reason }`.
- **JournalEntry** — per-trade notes/tags/screenshots; also session-level notes.

Persist sessions/orders/trades to the FastAPI backend (new tables/JSON store), so a session survives reload and resume — same durability approach as run bundles.

---

## 3. The correctness rule (this is the whole game)

The sim broker must be **deterministic and strictly no-look-ahead**, exactly like replay:

- Orders fill from bars **at or before the replay cursor only**. As replay advances one bar, the engine checks working orders against that new bar's OHLC: a buy-stop fills when the bar's high ≥ stop; a sell-limit fills when high ≥ limit; SL/TP fill when the bar's range touches them. Never peek at future bars.
- Fill price uses a documented, conservative convention (e.g. stop orders fill at the stop price or the bar open if it gapped through; SL/TP fill at the level if the bar's range crosses it) — write the rule down and test it.
- PnL/R for MNQ/MES uses the contract specs from `CLAUDE.md` ($ per point, tick), plus configured commission.
- This mirrors `VIZ_SPEC §0`: the sim is the source of truth for fills; the UI renders them, never invents them. Fills must be reproducible from `(bars ≤ cursor, orders)`.

---

## 4. Feature spec by area

### A. Sessions & replay
- **Start a session:** pick instrument (MNQ/MES) + base timeframe + start date/time. Option for a **random start** (blind — jump to a random valid historical point to kill snooping bias).
- **Replay controls:** play/pause, step, speed, and the existing free-camera + "follow" behavior. Future candles locked out (already enforced).
- **Right-click a candle → "Replay to here"** (you have click-to-set-start; align the wording/behavior with FX Replay).
- **Save / resume / list sessions:** a sessions list (like the runs list), each resumable at its saved cursor with its account state and open positions intact.
- **Bar magnifier** (later): peek at the lower-timeframe action inside the forming candle.

### B. Simulated broker — the keystone (build first)
- **Market order (quick buy/sell):** one-click enter at the current replayed price; one-click close. Live PnL/R updates each bar while open.
- **On-chart order ticket ("New Trade"):** drag to place **entry, SL (orange), TP (green)** as ghost markers on the chart, see the R:R and $ risk live, then Confirm. Dragging any line updates size/risk live.
- **Right-click order execution:** right-click a price on the chart → place a **limit** or **stop** order there directly (extend the Batch 1 context menu with order actions), with optional attached SL/TP.
- **Auto position sizing:** given risk-per-trade (% of balance or fixed $) and the SL distance, compute contracts automatically (respect whole-contract sizing and any prop max-position cap).
- **Position management:** modify SL/TP by dragging during the trade; partial close; full close; optional multiple concurrent positions; optional **auto break-even** ("move SL to entry after +1R") and trailing.
- **Account model:** starting balance, commissions per contract, running balance; optional attach the Topstep ruleset so a session can be run as a **prop-firm challenge sim** (reuse existing rule engine — target/drawdown/daily-loss/consistency tracked live).

### C. Journaling
- **Auto-log every closed trade** into the ManualTrade journal: instrument, entry/exit time+price, side, size, PnL, R, MAE/MFE, exit reason.
- **Notes + tags** per trade: setup name, structure, session, mistake, grade (A/B/C). Tag taxonomy is user-editable.
- **Screenshots / chart markup** saved to the trade (capture the chart state at entry/exit).
- **Trade review:** click a journaled trade → jump the chart/replay back to it with your notes and markup shown.

### D. Analytics (repoint existing work)
- **Performance dashboard** over the session's (or all sessions') manual trades: equity curve, win rate, avg R, expectancy, profit factor, drawdown + duration, by-session/by-time-of-day — this is your existing Dashboard/Compass, pointed at manual trades.
- **Drawdown-in-R / heat:** reuse MAE/MFE to show how much heat trades take before resolving.
- **Monte Carlo:** reuse the engine's Monte Carlo over the manual trade sequence to show outcome distributions.
- **R:R / risk simulation:** what-if on risk-per-trade and RR.
- **Filters:** by tag / session / setup / trade type, cross-linking to the trade list and chart (reuse existing cross-filter).
- **Prop-firm sim result:** if the session used the Topstep ruleset, show pass/fail + how it happened (reuse existing prop-rule visualization).

### E. Charting (done)
Everything from the KLineCharts build: drawings, indicators, measure, split, right-click menus, theming. The order tools in (B) layer on top of this.

### F. Discipline / anti-snooping (FX Replay's core value)
- Future candles are never rendered or fillable (already enforced in replay + the sim's no-look-ahead rule).
- Random-start sessions and "no rewind past a placed trade" options to enforce honesty.

---

## 5. The end-to-end flow (what the user does)

1. **New session:** choose MNQ, 5-min, a start date (or Random). Set account: balance, risk 1%, commissions.
2. **Replay:** step/play forward; the future is hidden.
3. **Trade:** at a setup, hit New Trade → drag entry/SL/TP (auto-sized to 1% risk) → Confirm. Or right-click a level for a limit/stop. Manage on the chart as price replays.
4. **Close:** TP/SL fills automatically as replay reaches them, or close manually. Trade auto-journals.
5. **Journal:** add a tag ("Break & Retest / London / A"), a note, a screenshot.
6. **Repeat** to a decent sample (FX Replay suggests 100+ trades).
7. **Analyze:** open the dashboard — equity curve, expectancy, drawdown, MAE heat, Monte Carlo, filter by tag/session. Iterate the approach.

---

## 6. Architecture notes

- **Sim broker lives in the frontend replay loop** (it needs to react bar-by-bar to the cursor), but every fill is **persisted to the backend** and must be **reproducible** from `(bars, orders)` so it can never drift — add a test that replays a fixed order set over fixed bars and asserts identical fills/PnL.
- **Sessions/orders/trades** persist via new FastAPI endpoints + storage (mirror the run-bundle durability model). A resumed session restores cursor, account, open positions, working orders, and journal.
- **Manual trades reuse the existing trade schema** so Dashboard/Compass/Monte-Carlo/MAE-MFE/prop-rule code repoints with minimal change (add a `source: manual|backtest` and a `session_id`).
- **Keep engine-truth:** the frontend renders sim state; the sim computes fills from bars deterministically; nothing is recomputed inconsistently.
- **DESIGN_LANGUAGE** governs every new surface (order ticket, sessions list, journal): restrained, one accent, tabular numbers, on-chart order lines using the same SL=orange/TP=green/entry conventions, quiet chrome.

---

## 7. Phased build plan (prompts follow in FXR_BUILD_PROMPTS)

Breadth-first to functional, then depth — you never perfect one feature before the next exists.

1. **F1 — Session + account shell.** Start/save/resume/list sessions; SimAccount model; sessions list UI. No trading yet.
2. **F2 — Sim broker MVP (keystone).** Market buy/sell in replay, single position, live PnL/R, manual close, auto-journal a bare trade record, deterministic-fill test. This is the moment it becomes a backtester.
3. **F3 — On-chart order tools.** New-Trade drag ticket (entry/SL/TP ghost markers, live R:R), right-click limit/stop, auto position sizing.
4. **F4 — Order types & management.** Limit/stop fills in replay, partial close, drag-to-modify SL/TP, multiple positions, auto break-even.
5. **F5 — Journaling.** Notes, tags, screenshots, trade-review jump-back.
6. **F6 — Analytics repoint.** Point Dashboard/Compass, Monte Carlo, MAE heat, and the prop-rule sim at manual trades; filters by tag/session.
7. **F7 — Polish & discipline.** Random start, bar magnifier, hotkeys, onboarding, then a DESIGN_LANGUAGE audit/elevate pass on all the new surfaces.

Each phase is one Claude Code pass + a checkpoint you review. Commit after each. Start with F1→F2 (the keystone), then use it and let real friction guide the depth passes.

---
Sources: [FX Replay — full backtesting workflow](https://fxreplay.com/learn/a-full-backtesting-workflow-using-fx-replay), [FX Replay — right-click order execution](https://support.fxreplay.com/articles/how-to-place-trades-with-right-click-order-execution), [FX Replay — session stats / analytics](https://support.fxreplay.com/articles/session-stats-overview), [FX Replay overview (LuxAlgo)](https://www.luxalgo.com/blog/fx-replay-backtesting-platform-overview/)
