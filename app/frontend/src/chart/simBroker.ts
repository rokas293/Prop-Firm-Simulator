// FXR_SPEC.md section 3/6, phases F2/F3: the sim broker's fill/PnL logic --
// pure and framework-free (no React, no fetch), same "testable without
// mounting anything" discipline as chart/replay.ts and chart/tradeBracket.ts.
// SessionWorkspace calls these; the RESULT is then persisted to the backend
// for durability, but the numbers themselves are computed here, once,
// deterministically from (bars, orders) -- never recomputed differently
// anywhere else (VIZ_SPEC section 0 / FXR_SPEC section 6: "the sim computes
// fills from bars deterministically; nothing is recomputed inconsistently").
//
// FILL CONVENTIONS:
// - Market orders (F2) fill at the CLOSE of the replay cursor's current
//   bar -- the last fully-revealed price at the instant of the click. This
//   app reveals whole bars, never partial/intrabar ticks, so the cursor
//   bar's close is already fully known on screen the moment a click can
//   happen; filling there is NOT a look-ahead. This deliberately differs
//   from the automated engine's own t+1-open convention (CLAUDE.md section
//   2, propbt/engine/broker.py): that rule exists because THAT engine
//   decides from a completed bar and must act on the NEXT one to avoid
//   look-ahead. Here the decision and the fill happen at the same instant
//   a human trader would act, against a price already printed.
// - Limit/stop orders and SL/TP (F3) fill the instant a LATER bar's own
//   OHLC range crosses their price (FXR_SPEC.md section 3: "as replay
//   advances one bar, the engine checks working orders against that new
//   bar's OHLC"), exactly AT that price -- never a worse gap-adjusted one.
//   Deliberately skips slippage/gap-to-open handling entirely, matching
//   F2's own already-shipped "no slippage modeling" simplification for
//   consistency; revisit if a later phase needs higher fidelity.
import type { Bar, TradeRecord } from '../api/types'

export type Side = 'long' | 'short'
export type ExitType = 'manual_close' | 'stop_loss' | 'take_profit'

export interface ContractSpec {
  pointValue: number // $ per point
  tickSize: number
}

// Mirrors CLAUDE.md section 2's contract spec table. ZN is out of scope for
// this platform (FXR_SPEC.md section 1: "scoped to MNQ + MES").
export const CONTRACT_SPECS: Record<'MES' | 'MNQ', ContractSpec> = {
  MES: { pointValue: 5, tickSize: 0.25 },
  MNQ: { pointValue: 2, tickSize: 0.25 },
}

// FXR_SPEC.md section 2 lists an "optional prop_ruleset (reuse Topstep
// config)" on SimAccount that no phase has wired up yet -- until it is,
// this is the sensible default max-position cap for auto-sizing, since the
// platform is explicitly aimed at Topstep Combine prep (CLAUDE.md section
// 3: "5 contracts total for the $50k account... 1 micro counts as 1
// contract"). Revisit once a session can carry its own prop ruleset.
export const MAX_POSITION_CONTRACTS = 5

export function getContractSpec(instrument: string): ContractSpec {
  const spec = CONTRACT_SPECS[instrument as 'MES' | 'MNQ']
  if (!spec) throw new Error(`no contract spec for instrument ${instrument} (FXR platform is MNQ/MES only)`)
  return spec
}

export function sideSign(side: Side): 1 | -1 {
  return side === 'long' ? 1 : -1
}

export function marketFillPrice(bar: Bar): number {
  return bar.close
}

// Freezes the account's configured risk-per-trade into a dollar figure AT
// ENTRY. A later balance change (from THIS trade or others) must never
// retroactively change what an already-open/working trade's R means.
export function riskUsdAtEntry(
  balanceAtEntry: number,
  riskPercent: number | null,
  riskUsdFixed: number | null,
): number | null {
  if (riskPercent !== null && riskPercent !== undefined) return balanceAtEntry * (riskPercent / 100)
  if (riskUsdFixed !== null && riskUsdFixed !== undefined) return riskUsdFixed
  return null
}

export function unrealizedPnl(
  side: Side,
  entryPrice: number,
  markPrice: number,
  contracts: number,
  spec: ContractSpec,
): number {
  return sideSign(side) * (markPrice - entryPrice) * spec.pointValue * contracts
}

export function toR(pnlUsd: number, riskUsd: number | null): number | null {
  if (!riskUsd) return null
  return pnlUsd / riskUsd
}

// FXR_SPEC.md section B: "given risk-per-trade... and the SL distance,
// compute contracts automatically (respect whole-contract sizing and any
// prop max-position cap)". Floors to whole contracts (never over-risks to
// round up), floors at 1 (a ticket always sizes to at least one contract
// even if the configured risk can't quite cover it at this SL distance --
// matching default_contracts' own floor elsewhere), and caps at
// maxContracts.
export function computeAutoSize(
  riskUsd: number | null,
  entryPrice: number,
  slPrice: number,
  spec: ContractSpec,
  maxContracts: number = MAX_POSITION_CONTRACTS,
): number {
  const slDistance = Math.abs(entryPrice - slPrice)
  if (!riskUsd || slDistance <= 0) return 1
  const riskPerContract = slDistance * spec.pointValue
  const contracts = Math.floor(riskUsd / riskPerContract)
  return Math.min(maxContracts, Math.max(1, contracts))
}

export interface MaeMfe {
  maePoints: number
  mfePoints: number
}

// Scans bars[entryIndex..exitIndexInclusive] (both ends included, matching
// propbt/reporting/run_bundle.py's own `_mae_mfe` inclusive .loc[entry_ts:
// exit_ts] window) for the worst adverse move and best favorable move
// relative to entry -- same convention an automated trade's numbers use, so
// a manual trade reads the same way.
export function computeMaeMfe(
  bars: Bar[],
  entryIndex: number,
  exitIndexInclusive: number,
  entryPrice: number,
  side: Side,
): MaeMfe {
  let lo = Infinity
  let hi = -Infinity
  for (let i = entryIndex; i <= exitIndexInclusive; i++) {
    lo = Math.min(lo, bars[i].low)
    hi = Math.max(hi, bars[i].high)
  }
  if (side === 'long') {
    return { maePoints: Math.max(0, entryPrice - lo), mfePoints: Math.max(0, hi - entryPrice) }
  }
  return { maePoints: Math.max(0, hi - entryPrice), mfePoints: Math.max(0, entryPrice - lo) }
}

export interface OpenPosition {
  side: Side
  contracts: number
  entryPrice: number
  entryTime: number
  entryIndex: number
  riskUsd: number | null
  slPrice: number | null
  tpPrice: number | null
}

export interface ClosedTradeResult {
  side: Side
  contracts: number
  entryTime: number
  entryPrice: number
  exitTime: number
  exitPrice: number
  exitType: ExitType
  // The PLANNED levels the position was opened with (not where it actually
  // exited) -- carried through so a journaled trade preserves them for
  // review/charting, same as the automated engine's own trade schema.
  slPrice: number | null
  tpPrice: number | null
  pnlUsd: number // net of commission
  commissionUsd: number
  rMultiple: number | null
  maePoints: number
  mfePoints: number
  maeR: number | null
  mfeR: number | null
  barsHeld: number
}

// Shared by closePosition (F2's manual market close) and advanceReplay's
// SL/TP auto-close below -- everything about a round trip except WHERE the
// exit price/type came from.
function closePositionAt(
  bars: Bar[],
  position: OpenPosition,
  exitIndex: number,
  exitPrice: number,
  exitType: ExitType,
  spec: ContractSpec,
  commissionPerContract: number,
): ClosedTradeResult {
  const exitBar = bars[exitIndex]
  const grossPnl = unrealizedPnl(position.side, position.entryPrice, exitPrice, position.contracts, spec)
  const commissionUsd = commissionPerContract * position.contracts
  const pnlUsd = grossPnl - commissionUsd
  const rMultiple = toR(pnlUsd, position.riskUsd)

  const { maePoints, mfePoints } = computeMaeMfe(
    bars,
    position.entryIndex,
    exitIndex,
    position.entryPrice,
    position.side,
  )
  // When the position carries no real SL (an F2-style bare market entry),
  // risk_usd has no price-level stop behind it -- back out an equivalent
  // point distance so mae_r/mfe_r stay on the SAME basis as r_multiple,
  // rather than being left null while r_multiple has a value. When a real
  // slPrice exists (F3), this equivalent happens to equal the actual SL
  // distance, so the two never disagree.
  const riskPointsEquivalent = position.riskUsd ? position.riskUsd / (spec.pointValue * position.contracts) : null
  const maeR = riskPointsEquivalent ? maePoints / riskPointsEquivalent : null
  const mfeR = riskPointsEquivalent ? mfePoints / riskPointsEquivalent : null

  return {
    side: position.side,
    contracts: position.contracts,
    entryTime: position.entryTime,
    entryPrice: position.entryPrice,
    exitTime: exitBar.time,
    exitPrice,
    exitType,
    slPrice: position.slPrice,
    tpPrice: position.tpPrice,
    pnlUsd,
    commissionUsd,
    rMultiple,
    maePoints,
    mfePoints,
    maeR,
    mfeR,
    barsHeld: exitIndex - position.entryIndex + 1,
  }
}

// Deterministic close: a pure function of (bars, position, exitIndex, spec,
// commission) -- the exact reproducibility FXR_SPEC section 3/6 requires
// ("fills must be reproducible from (bars, orders)"). Commission is charged
// ONCE, on exit -- matching propbt/engine/broker.py's own convention
// (entry fills carry commission=0.0; the exit fill's commission covers the
// whole round-turn), so a manual trade's cost model matches the automated
// engine's exactly.
export function closePosition(
  bars: Bar[],
  position: OpenPosition,
  exitIndex: number,
  spec: ContractSpec,
  commissionPerContract: number,
): ClosedTradeResult {
  return closePositionAt(bars, position, exitIndex, marketFillPrice(bars[exitIndex]), 'manual_close', spec, commissionPerContract)
}

export type PendingOrderType = 'limit' | 'stop'

export interface WorkingOrder {
  id: string
  side: Side
  orderType: PendingOrderType
  price: number
  contracts: number
  slPrice: number | null
  tpPrice: number | null
  riskUsd: number | null
  placedTime: number
  placedIndex: number
}

// Which entry-order type makes sense for a given side, given where the
// price was clicked relative to the current market -- a stop chases a
// breakout AWAY from market, a limit waits for a pullback TOWARD a better
// price, exactly the real-broker distinction (a "stop" placed on the wrong
// side of market would just fill immediately, which is never the intent
// of "place an order there"). Used by the right-click menu to offer only
// the two combinations that are actually meaningful at the clicked price.
export function impliedOrderType(side: Side, orderPrice: number, marketPrice: number): PendingOrderType {
  if (side === 'long') return orderPrice > marketPrice ? 'stop' : 'limit'
  return orderPrice < marketPrice ? 'stop' : 'limit'
}

export function orderTriggered(order: WorkingOrder, bar: Bar): boolean {
  if (order.orderType === 'stop') {
    return order.side === 'long' ? bar.high >= order.price : bar.low <= order.price
  }
  return order.side === 'long' ? bar.low <= order.price : bar.high >= order.price
}

// Both an SL and a TP touched within the SAME bar can't be resolved from
// OHLC alone (the true intrabar path isn't known) -- conservatively assume
// the worse outcome (the stop), matching propbt/engine/broker.py's own
// _check_stop_take.
function slTpHit(position: OpenPosition, bar: Bar): ExitType | null {
  const hitSl =
    position.slPrice !== null &&
    (position.side === 'long' ? bar.low <= position.slPrice : bar.high >= position.slPrice)
  const hitTp =
    position.tpPrice !== null &&
    (position.side === 'long' ? bar.high >= position.tpPrice : bar.low <= position.tpPrice)
  if (!hitSl && !hitTp) return null
  return hitSl ? 'stop_loss' : 'take_profit'
}

export interface AdvanceReplayResult {
  position: OpenPosition | null
  workingOrders: WorkingOrder[]
  closedTrades: ClosedTradeResult[]
  filledOrderIds: string[]
}

// Walks bars[fromIndexExclusive+1 .. toIndexInclusive] STRICTLY in order,
// checking working orders and the open position's SL/TP against each bar's
// own OHLC in turn -- FXR_SPEC.md section 3's explicit rule ("as replay
// advances one bar, the engine checks working orders against that new
// bar's OHLC"). Scrubbing/playing forward by more than one bar at once
// must still evaluate every intermediate bar, not just the final one, or a
// fill on a skipped bar would be missed entirely -- the same
// deterministic-from-(bars,orders) guarantee F2's mandatory test
// established, now extended to order types that can trigger mid-replay
// instead of only at the instant of a click. At most one position is ever
// open at a time (same single-position simplification as F2): an order
// only gets a chance to fill on a bar where nothing is already open.
export function advanceReplay(
  bars: Bar[],
  fromIndexExclusive: number,
  toIndexInclusive: number,
  position: OpenPosition | null,
  workingOrders: WorkingOrder[],
  spec: ContractSpec,
  commissionPerContract: number,
): AdvanceReplayResult {
  let pos = position
  let orders = workingOrders
  const closedTrades: ClosedTradeResult[] = []
  const filledOrderIds: string[] = []

  for (let i = fromIndexExclusive + 1; i <= toIndexInclusive; i++) {
    const bar = bars[i]

    if (pos) {
      const hit = slTpHit(pos, bar)
      if (hit) {
        const exitPrice = hit === 'stop_loss' ? (pos.slPrice as number) : (pos.tpPrice as number)
        closedTrades.push(closePositionAt(bars, pos, i, exitPrice, hit, spec, commissionPerContract))
        pos = null
      }
    }

    if (!pos && orders.length > 0) {
      const idx = orders.findIndex((o) => orderTriggered(o, bar))
      if (idx >= 0) {
        const order = orders[idx]
        pos = {
          side: order.side,
          contracts: order.contracts,
          entryPrice: order.price,
          entryTime: bar.time,
          entryIndex: i,
          riskUsd: order.riskUsd,
          slPrice: order.slPrice,
          tpPrice: order.tpPrice,
        }
        filledOrderIds.push(order.id)
        orders = orders.filter((o) => o.id !== order.id)

        // A freshly filled position can still be hit by its own SL/TP
        // within the REMAINDER of this same bar -- not look-ahead, since
        // it's still only this bar's own OHLC (matches propbt/engine/
        // broker.py's own same-bar-exit handling).
        const hit = slTpHit(pos, bar)
        if (hit) {
          const exitPrice = hit === 'stop_loss' ? (pos.slPrice as number) : (pos.tpPrice as number)
          closedTrades.push(closePositionAt(bars, pos, i, exitPrice, hit, spec, commissionPerContract))
          pos = null
        }
      }
    }
  }

  return { position: pos, workingOrders: orders, closedTrades, filledOrderIds }
}

export interface OpenPositionView {
  position: OpenPosition
  instrument: string
  cursorIndex: number
  markPrice: number
  cursorTime: number
}

// Renders the currently-open position as a TradeRecord so it can flow
// through the EXACT SAME chart trade-overlay pipeline a closed automated
// trade uses (chart/kl/tradeOverlays.ts, chart/replay.ts's
// filterTradesForReplay) with zero chart-side changes -- "reuse the
// trade-overlay conventions" per the F2 prompt, extended in F3 to carry
// real sl_price/tp_price so the SAME overlay pipeline also draws the
// entry/SL/TP lines it already knows how to. exit_time is set to
// cursorTime + 1 (strictly after the cursor) specifically so
// filterTradesForReplay's own `showExit = exit_time <= cursorTime` check
// always reads false while the position is open: no real exit exists yet,
// so nothing downstream may treat this as a completed, priced trade.
// trade_id 0 is a reserved sentinel that real journaled trades (assigned
// server-side starting at 1, see app/backend/services/bt_session_service.py)
// never collide with.
export function openPositionAsTradeRecord(view: OpenPositionView): TradeRecord {
  const spec = getContractSpec(view.instrument)
  const pnlUsd = unrealizedPnl(view.position.side, view.position.entryPrice, view.markPrice, view.position.contracts, spec)
  const rMultiple = toR(pnlUsd, view.position.riskUsd)
  const { slPrice, tpPrice } = view.position
  const slPoints = slPrice !== null ? Math.abs(view.position.entryPrice - slPrice) : null
  const tpPoints = tpPrice !== null ? Math.abs(tpPrice - view.position.entryPrice) : null
  const rrPlanned = slPoints && tpPoints ? tpPoints / slPoints : null
  return {
    trade_id: 0,
    entry_time: view.position.entryTime,
    exit_time: view.cursorTime + 1,
    instrument: view.instrument,
    side: view.position.side,
    leg: null,
    session: null,
    trading_day: null,
    size_contracts: view.position.contracts,
    entry_price: view.position.entryPrice,
    exit_price: view.markPrice,
    sl_price: slPrice,
    tp_price: tpPrice,
    sl_points: slPoints,
    tp_points: tpPoints,
    rr_planned: rrPlanned,
    exit_type: 'open',
    pnl_usd: pnlUsd,
    r_multiple: rMultiple,
    commission_usd: 0,
    mae_points: 0,
    mfe_points: 0,
    mae_r: null,
    mfe_r: null,
    bars_held: view.cursorIndex - view.position.entryIndex + 1,
  }
}
