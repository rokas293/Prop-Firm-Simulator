# Strategy under test

Pointed to from `CLAUDE.md`. The discretionary strategy (from the source
trader) that `propbt/strategy/` implements and `propbt/sim/` evaluates
against the rules in `docs/DATA_AND_RULES.md`.

Three trade "legs", applied to **each session open** (Asia, London, New
York) and to **scheduled high-impact news**:

1. **Fair value:** the close of the 1-minute bar immediately *before* the
   session/news open. Stored as the session's reference price.
2. **Open-spike continuation (1 trade):** at the open there's a
   volume/price spike. Take **one** continuation trade in the spike's
   direction. Static SL and TP measured in **points**, with RR selectable
   from {1:1, 1:1.5, 1:2}. Configurable observation window (default: judge
   direction from the first 1–5 min of displacement).
3. **Mean-reversion after the impulse (~3 trades):** once opening volume
   dies down there's consolidation; on a **break of structure** the trader
   fades back toward fair value / session VWAP. Up to 3 trades. Static
   SL/TP in points.

Same pattern is applied around scheduled **high-impact news** spikes
(FOMC, CPI, NFP, PCE, etc.). Target volume ~**20 trades/day** across the
three sessions plus news.

## Concrete definitions (implement these, keep them tunable)

- **Session anchors** (America/New_York, configurable — confirm before
  relying on defaults):
  - New York open: 09:30 ET (RTH). Also consider 08:30 ET data releases
    as "news", not session.
  - London open: 03:00 ET (08:00 London).
  - Asia open: default 20:00 ET (Tokyo 09:00 JST). Day attribution is
    RESOLVED — it belongs to the CME trading day that reopened at 18:00 ET
    that evening (see `docs/DATA_AND_RULES.md`'s trading-day boundary),
    i.e. the same trading day as the following London/NY sessions.
    Confirm the anchor *time* if you want a different one, but the
    attribution rule is fixed.
  - Globex daily reopen 18:00 ET is available as an optional anchor.
- **Spike direction:** sign of (close of first bar − fair value), or
  displacement of first-N-min range — make the method a config switch so
  both can be tested.
- **Consolidation:** range/ATR over the last K bars compressed below a
  threshold, and/or volume below a rolling average — configurable.
- **Swing point:** local extreme over `w` bars each side. **Break of
  structure (BoS):** a bar closes beyond the most recent swing high/low.
  Mean-reversion entries fade the BoS back toward fair value (direction
  logic is a tested config switch, since "fade the break" vs "join then
  fade" both need evaluating).
- **News calendar:** ingest a `news_events.csv` (UTC timestamp, event,
  impact). High-impact only by default. Source is the user's export (e.g.
  an economic calendar CSV) — the loader must be format-tolerant.

Every strategy parameter (windows, thresholds, RR, SL points, contracts,
which legs are enabled) lives in a config file. Nothing hardcoded in
strategy logic.
