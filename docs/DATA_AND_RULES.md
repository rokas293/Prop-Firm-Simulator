# Data & Topstep rules

Pointed to from `CLAUDE.md`. Covers the raw data (Databento) and the exact
Topstep $50k Combine rules the `propbt` engine models. See also
`docs/ARCHITECTURE.md` for where these get consumed (`propbt/data/`,
`propbt/engine/prop_rules.py`).

## Instruments & data

- **Data source:** Databento, 1-minute OHLCV parquet for **MES** (Micro
  E-mini S&P 500), **MNQ** (Micro E-mini Nasdaq-100), and **ZN** (10-Year
  T-Note, full-size). Files store OHLCV with a tz-aware UTC `ts_event`
  index and no embedded symbol/expiration/roll metadata. Resample up to
  higher timeframes as needed; never resample down. Start development on
  MES/MNQ; bring ZN in once specs/limits below are wired.
- **Timestamps:** Databento is UTC. Store everything internally as
  tz-aware UTC. Convert to `America/New_York` for session logic. Handle
  DST correctly — never hardcode UTC offsets.
- **Contract rolls:** front-month futures roll quarterly. Do NOT hold
  positions across a roll boundary and flag roll days. If using a
  continuous/back-adjusted series, remember back-adjustment preserves
  *point distances* (which is what static SL/TP care about) but shifts
  absolute levels; raw stitching creates phantom gaps. Confirm which
  Databento product is in use before trusting overnight moves.
- **Sparse bars** (Databento emits a bar only when a trade occurs).
  MES/MNQ are dense; **ZN has ~10x more small intra-session gaps** in thin
  hours because it simply doesn't trade every minute. Do NOT forward-fill
  synthetic prices — leave bars sparse and make `resample.py` and the
  strategy tolerate missing minutes. Caveat for strategy logic:
  window-based calcs (ATR/consolidation over "K bars", swing lookbacks)
  count *bars*, so on ZN a K-bar window spans more wall-clock time than on
  MES. Where a window is meant to represent elapsed time, define it in
  minutes and derive the bar count, or document that it's bar-count-based.
- **No look-ahead, ever** (the propbt engine's specific convention — the
  FXR manual-replay sim broker has its own, documented in `FXR_SPEC.md`
  section 3). A decision made on bar `t` may only use data with timestamp
  ≤ close of bar `t`. Execution happens at bar `t+1` open (or as a
  limit/stop fill within `t+1`). This rule is non-negotiable and every
  strategy/engine change must preserve it. Add tests for it.

### Contract specs

| Symbol | Point value | Tick size | Tick value |
|--------|-------------|-----------|------------|
| MES    | $5 / point  | 0.25 pt   | $1.25      |
| MNQ    | $2 / point  | 0.25 pt   | $0.50      |
| ZN     | $1,000 / pt | 1/64 pt   | $15.625    |

(Full-size for reference: ES $50/pt, NQ $20/pt. MES/MNQ are micros; **ZN is
a full-size contract** — 10Y T-Note, price quoted in points and 32nds, tick
= 1/64 pt. Its point value is large, so position sizing and risk behave
very differently from the micros.)

## Topstep $50k Combine rules (model these exactly)

Verified 2026 rules — put them in a single `PropRules` config object, all
values overridable:

- **Profit target:** +$3,000 cumulative (account balance reaches $53,000).
- **Maximum Loss Limit (trailing drawdown):** starts at $2,000 below start
  balance (floor = $48,000). It **trails on end-of-day balance**: after
  each trading day closes, `mll = max(mll, eod_balance - 2000)`. Once EOD
  balance reaches **$52,000**, the MLL **freezes at $50,000** and never
  trails again.
  - **Breach = fail**, and it is checked against **live intraday equity**
    (realized + open PnL) on every bar. If intraday equity ever touches
    the current MLL floor → the Combine attempt fails immediately.
- **Daily Loss Limit:** $1,000. If the day's drawdown from that day's
  starting balance reaches −$1,000, the account is **locked for the rest
  of that day** (flatten and stop trading). This does NOT fail the
  Combine — it just ends the day.
- **Consistency rule:** the single best trading day must be **≤ 50%** of
  total profit at the moment the target is hit. Check this when the
  target is reached; if violated, the attempt is "target hit but not
  consistency-passed" (track separately).
- **Position limit:** **5 contracts total** for the $50k account.
  Important: Topstep (unlike Apex) does NOT give micros a 10:1 discount —
  **1 micro counts as 1 contract**. So 5 MES or 5 MNQ micros maxes you
  out, and each ZN counts as 1 of the 5. Model the limit as a flat count
  of open contracts across all instruments, capped at 5 (configurable).
  Verify on Topstep's official Combine Parameters page before real use —
  public sources disagree on the micro count.
- **Trading day boundary** (critical — governs daily loss reset AND the
  EOD balance for the MLL trail): the Topstep/CME trading day runs
  **18:00 ET → 17:00 ET** next day (5:00 PM CT reset), with the
  17:00–18:00 ET maintenance halt (already visible as the recurring 1h
  gap in the data). The Daily Loss Limit resets, and the EOD balance that
  trails the MLL is stamped, at this **17:00/18:00 ET boundary — NOT
  midnight and NOT the NY equity close.** Consequence: attribute every
  session to the CME trading day it falls within, so Asia (20:00 ET), the
  following London (03:00 ET), and NY (09:30 ET) all belong to ONE
  trading day and share one daily loss limit and one EOD stamp.
- **Commissions:** round-turn per contract, configurable **per
  instrument** (micros ~$0.75–$1.30 round-turn; **ZN is a full-size
  contract with its own, higher round-turn — give it a separate config
  value**, don't reuse the micro number). With ~20 trades/day, commissions
  materially affect pass rate, so they must be in from day one.

> Rules change periodically. Keep them in config, cite this file's
> "verified 2026" note, and re-verify before trusting results for real
> money.
