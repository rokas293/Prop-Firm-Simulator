# FXR_BUILD_PROMPTS.md — phased prompts for the FX Replay-style platform

Put `FXR_SPEC.md` in the repo. Paste these into Claude Code one phase at a time, verify, commit, advance. Breadth-first to functional, then depth. The sim broker (F2) is the keystone — everything hangs off it, so F1→F2 first, then use it and let real friction guide the rest.

Append this line to every prompt (as in prior batches):
`In your report, describe each screenshot in detail — layout, spacing, alignment, colors, and anything off against DESIGN_LANGUAGE.md — not just "it works."`

---

## Phase F1 — Session + account shell

```
Read FXR_SPEC.md and DESIGN_LANGUAGE.md. We're building an FX Replay-style manual backtesting platform on the existing app, scoped to MNQ/MES. This phase: sessions + account only, no trading yet.
- Data model per FXR_SPEC §2: BacktestSession and SimAccount. Add FastAPI endpoints + persistence (mirror the run-bundle durability approach) to create, save, resume, list, and archive sessions.
- "New session" flow: pick instrument (MNQ/MES) + base timeframe + start date/time, plus account settings (starting balance, risk-per-trade %, commission per contract, default contracts). Option for a Random start (jump to a random valid historical point).
- A Sessions list UI (like the runs list) — each row resumable at its saved cursor, showing instrument/date/balance/status.
- Resuming a session restores the chart at the saved cursor_time in replay mode (reuse existing replay + cursor logic). No trading yet.
Verify: create a session, reload, resume it, confirm it restores to the exact cursor and account state. tsc/tests/build green.
```

## Phase F2 — Sim broker MVP (the keystone)

```
Read FXR_SPEC.md (§3 correctness rule is critical) and DESIGN_LANGUAGE.md. Build the minimum simulated broker so you can trade during replay.
- Market orders: one-click Buy / Sell at the current replayed price opens a single position sized by default_contracts; one-click Close closes it. Live open PnL and open R update every bar while the position is open, using MNQ/MES contract specs from CLAUDE.md + configured commission.
- STRICT no-look-ahead: fills and PnL derive only from bars at/before the replay cursor. As replay advances one bar, evaluate the position against that bar's OHLC. Write down the fill convention and TEST it.
- On close, auto-journal a bare ManualTrade record (schema-compatible with the existing trade model per §2: entry/exit time+price, side, size, pnl, R, mae, mfe) tied to the session.
- Show current position + open PnL/R in a compact panel and as entry/SL/TP lines on the chart (reuse the trade-overlay conventions).
- MANDATORY test: replay a fixed set of orders over a fixed set of bars and assert identical fills/PnL/R — fills must be reproducible from (bars, orders).
Verify: enter a market long mid-replay, step forward, watch PnL update bar-by-bar, close, confirm the journaled trade's numbers match a hand calc. tsc/tests/build green.
```

## Phase F3 — On-chart order tools

```
Read FXR_SPEC.md §B and DESIGN_LANGUAGE.md. Add FX Replay-style on-chart order entry on top of the F2 broker.
- "New Trade" ticket: drag to place entry, SL (orange), TP (green) as ghost markers on the chart; show live R:R and $ risk as they drag; Confirm to place. Dragging a line updates the numbers live.
- Auto position sizing: given risk-per-trade (% of balance or fixed $) and the SL distance, compute contracts automatically (whole-contract sizing; respect any prop max-position cap). Show the resulting size before confirm.
- Right-click order execution: extend the existing Batch 1 context menu so right-clicking a price places a limit or stop order there, optionally with attached SL/TP.
- Use the entry/SL(orange)/TP(green) line conventions consistently; keep chrome quiet per DESIGN_LANGUAGE.
Verify: drag a New Trade sized to exactly 1% risk and confirm the computed contracts match the SL distance; place a right-click limit. tsc/tests/build green.
```

## Phase F4 — Order types & management

```
Read FXR_SPEC.md §B/§3. Complete the broker.
- Limit/stop orders fill correctly in replay per the no-look-ahead fill convention (buy-stop fills when a bar's high >= stop, etc.); working orders show on the chart and can be cancelled.
- Position management: drag SL/TP to modify during the trade; partial close; full close; support multiple concurrent positions if feasible (else document single-position limit).
- Optional auto break-even ("move SL to entry after +1R") and simple trailing, as toggles.
- SL/TP auto-fill as replay reaches them, closing (or partially closing) the position and journaling it.
Extend the deterministic-fill test to cover limit/stop/SL/TP and partial closes. Verify each order type fills at the right bar/price against known data. tsc/tests/build green.
```

## Phase F5 — Journaling

```
Read FXR_SPEC.md §C and DESIGN_LANGUAGE.md. Build journaling on top of the auto-logged trades.
- Per-trade: editable notes, user-defined tags (setup name, structure, session, mistake, grade A/B/C), and screenshots/markup of the chart at entry/exit saved to the trade.
- A journal view listing session trades with their tags/notes/R/PnL (reuse the Trade List patterns), filterable by tag/session.
- Trade review: click a journaled trade to jump the chart/replay back to it with its notes and saved markup shown.
- Session-level notes too.
Persist all of it with the session. Verify a tag+note+screenshot survives reload and the review jump lands on the right bar. tsc/tests/build green.
```

## Phase F6 — Analytics repoint

```
Read FXR_SPEC.md §D and VIZ_SPEC §7. Point the EXISTING analytics at manual trades — don't rebuild them.
- Make Dashboard/Compass, the equity/drawdown views, Monte Carlo, and the MAE/MFE "heat" analytics accept a session's (or all sessions') manual trades (add source=manual + session_id; reuse the schema compatibility from §2).
- Filters by tag / setup / session / time-of-day, cross-linking to the trade list and chart (reuse existing cross-filter).
- If a session used the Topstep ruleset, show the prop-firm pass/fail result and how it happened, reusing the existing prop-rule engine/visualization.
Verify the manual-trade stats reconcile with a hand check on a small session, and Monte Carlo runs over the manual sequence. tsc/tests/build green.
```

## Phase F7 — Polish & discipline

```
Read FXR_SPEC.md §A/§F and DESIGN_LANGUAGE.md. Final pass.
- Discipline: random-start sessions and an optional "no rewind past a placed trade" lock; confirm future candles are never rendered/fillable.
- Bar magnifier: peek at the lower-timeframe action inside the forming candle.
- Hotkeys for the trading loop (buy/sell/close/step/speed) with a "?" overlay entry.
- Onboarding: a short first-run explainer of the session→trade→journal→analyze loop.
- Then run a DESIGN_LANGUAGE audit + elevate pass over ALL the new surfaces (order ticket, sessions list, journal, account panel), same loop as REPLICA_AUDIT.
Verify end to end; tsc/tests/build green.
```

---

## Working notes
- Commit after each phase; keep all existing tests green; the deterministic-fill test (F2, extended in F4) is mandatory and must stay green — it's what guarantees the backtester isn't lying.
- After F1→F2, actually *use* it (place a few trades in replay) before building F3+. Real friction should steer the depth.
- Everything obeys `VIZ_SPEC §0` (frontend renders, sim computes fills deterministically) and `DESIGN_LANGUAGE.md` (restrained, tabular numbers, entry/SL-orange/TP-green line conventions).
- Scope stays MNQ/MES. Adding an instrument later is a data-pipeline add, not a rebuild.
