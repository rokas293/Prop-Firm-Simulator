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
import type { Bar, PersistedPosition, PersistedWorkingOrder, TradeRecord } from '../api/types'
import { nextCloseAfter, type HoldingRule } from './holdingRestrictions'

export type Side = 'long' | 'short'
// 'session_close': flattened by the session's no-overnight / no-weekend rule (G6).
export type ExitType = 'manual_close' | 'stop_loss' | 'take_profit' | 'session_close'

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

// What the Place Order dialog (FXR_V2_SPEC.md 3.5) attached to a trade: its
// tags, the checklist rules that were ticked, and the journal draft. It rides on
// the working order, then the position, until the first exit is journaled and it
// lands on the trade. (Sizing from risk lives in orderTicket.ts, not here.)
export interface OrderJournal {
  tags: string[]
  checklist: string[]
  notes: string
}

export const NO_JOURNAL: OrderJournal = { tags: [], checklist: [], notes: '' }

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
  // F4 optional toggles -- see applyBreakevenAndTrailing.
  autoBreakeven: boolean
  trailingPoints: number | null
  // FXR_V2_SPEC.md 3.4 (G4): where auto break-even triggers -- a multiple of the
  // risk, or a distance in price points in profit (the points win if both are
  // set). Both absent/null = the original rule, +1R. Scalper Mode sets one.
  breakevenR?: number | null
  breakevenPoints?: number | null
  // FXR_V2_SPEC.md 3.6: the journal identity shared by every exit of this
  // position (a working order's id when it came from one), and its size at
  // entry -- `contracts` is only what is still open after partial closes.
  tradeKey: string
  initialContracts: number
  // FXR_V2_SPEC.md 3.2: ghost SL/TP levels not yet placed (null = none /
  // already placed or removed). Independent per side.
  ghostSl: number | null
  ghostTp: number | null
  // FXR_V2_SPEC.md 3.5: absent for a Quick Buy/Sell, set by the dialog.
  journal?: OrderJournal
}

// FXR_SPEC.md section B/3, phase F4: persistence boundary conversions --
// entryIndex/placedIndex are indices into the CURRENTLY LOADED bars array,
// meaningless across a reload (a fresh fetch window re-indexes everything
// from 0), so they're deliberately dropped here and re-resolved from the
// persisted TIME the same way cursor_time itself already is
// (resyncCursorIndex) once bars load again.
export function toPersistedPosition(position: OpenPosition): PersistedPosition {
  return {
    side: position.side,
    contracts: position.contracts,
    entry_price: position.entryPrice,
    entry_time: position.entryTime,
    risk_usd: position.riskUsd,
    sl_price: position.slPrice,
    tp_price: position.tpPrice,
    auto_breakeven: position.autoBreakeven,
    trailing_points: position.trailingPoints,
    breakeven_r: position.breakevenR ?? null,
    breakeven_points: position.breakevenPoints ?? null,
    trade_key: position.tradeKey,
    initial_contracts: position.initialContracts,
    ghost_sl: position.ghostSl,
    ghost_tp: position.ghostTp,
    tags: position.journal?.tags ?? [],
    checklist: position.journal?.checklist ?? [],
    journal_notes: position.journal?.notes ?? '',
  }
}

export function fromPersistedPosition(p: PersistedPosition, entryIndex: number): OpenPosition {
  return {
    side: p.side,
    contracts: p.contracts,
    entryPrice: p.entry_price,
    entryTime: p.entry_time,
    entryIndex,
    riskUsd: p.risk_usd,
    slPrice: p.sl_price,
    tpPrice: p.tp_price,
    autoBreakeven: p.auto_breakeven,
    trailingPoints: p.trailing_points,
    breakevenR: p.breakeven_r ?? undefined,
    breakevenPoints: p.breakeven_points ?? undefined,
    // A v1 position has no key/initial size: it journals as one plain trade.
    tradeKey: p.trade_key ?? `legacy-${p.entry_time}`,
    initialContracts: p.initial_contracts ?? p.contracts,
    ghostSl: p.ghost_sl ?? null,
    ghostTp: p.ghost_tp ?? null,
    journal: journalFromPersisted(p.tags, p.checklist, p.journal_notes),
  }
}

function journalFromPersisted(tags?: string[], checklist?: string[], notes?: string): OrderJournal | undefined {
  if (!tags?.length && !checklist?.length && !notes) return undefined
  return { tags: tags ?? [], checklist: checklist ?? [], notes: notes ?? '' }
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
  // FXR_V2_SPEC.md 3.6: this is ONE exit of its position -- journaled under
  // tradeKey so a partial and its remainder merge into one trade. `contracts`
  // is this exit's slice, `initialContracts` the size at entry, `riskUsd` this
  // slice's share of the risk frozen at entry (merged R = total P&L / total).
  tradeKey: string
  initialContracts: number
  riskUsd: number | null
  // FXR_V2_SPEC.md 3.5: the Place Order dialog's tags / checklist / journal draft,
  // carried to the journaled trade by the first exit.
  journal?: OrderJournal
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
    tradeKey: position.tradeKey,
    initialContracts: position.initialContracts,
    riskUsd: position.riskUsd,
    journal: position.journal,
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
  // Carried through to the OpenPosition once this order fills (F4) -- an
  // armed toggle is a property of the TRADE, decided at placement time,
  // whether it fills immediately (a market order) or later (a working one).
  autoBreakeven: boolean
  trailingPoints: number | null
  // G4: the break-even trigger, handed to the position on fill (OpenPosition).
  breakevenR?: number | null
  breakevenPoints?: number | null
  // FXR_V2_SPEC.md 3.5 (G3): the dialog's tags/checklist/draft notes, handed to
  // the position when this order fills, and "Save & Journal" (open the journal
  // entry at that fill).
  journal?: OrderJournal
  journalOnFill?: boolean
}

// A working order persists its auto break-even / trailing choice too (G3: the
// dialog sets them per order, so a reload while it is still working must not
// drop them).
export function toPersistedWorkingOrder(order: WorkingOrder): PersistedWorkingOrder {
  return {
    id: order.id,
    side: order.side,
    order_type: order.orderType,
    price: order.price,
    contracts: order.contracts,
    sl_price: order.slPrice,
    tp_price: order.tpPrice,
    risk_usd: order.riskUsd,
    placed_time: order.placedTime,
    auto_breakeven: order.autoBreakeven,
    trailing_points: order.trailingPoints,
    breakeven_r: order.breakevenR ?? null,
    breakeven_points: order.breakevenPoints ?? null,
    tags: order.journal?.tags ?? [],
    checklist: order.journal?.checklist ?? [],
    journal_notes: order.journal?.notes ?? '',
    journal_on_fill: order.journalOnFill ?? false,
  }
}

export function fromPersistedWorkingOrder(o: PersistedWorkingOrder, placedIndex: number): WorkingOrder {
  return {
    id: o.id,
    side: o.side,
    orderType: o.order_type as PendingOrderType,
    price: o.price,
    contracts: o.contracts,
    slPrice: o.sl_price,
    tpPrice: o.tp_price,
    riskUsd: o.risk_usd,
    placedTime: o.placed_time,
    placedIndex,
    autoBreakeven: o.auto_breakeven ?? false,
    trailingPoints: o.trailing_points ?? null,
    breakevenR: o.breakeven_r ?? undefined,
    breakevenPoints: o.breakeven_points ?? undefined,
    journal: journalFromPersisted(o.tags, o.checklist, o.journal_notes),
    journalOnFill: o.journal_on_fill ?? false,
  }
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
// _check_stop_take. The replay feeds this ONE-MINUTE bars whatever the chart's
// timeframe or the step size (FXR_V2_SPEC.md section 5, G5), so that ambiguity
// only remains inside a single minute; two levels touched in different minutes
// of the same hour resolve by which minute came first.
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

// FXR_SPEC.md section B, phase F4's optional toggles -- evaluated once per
// bar, AFTER that bar's own SL/TP check (see advanceReplay: a position
// already closed this bar has nothing left to adjust), so a stop can never
// be moved using information from a bar it didn't survive. Both read the
// bar's OWN favorable extreme (high for a long, low for a short) -- the
// same "this bar's OHLC only" discipline as every other fill/trigger check
// in this module.
//
// Break-even moves the SL to entry (never a fee-inclusive "entry + costs"
// figure -- SL is a PRICE, commission is separate) the first bar the
// favorable excursion reaches the trigger -- +1R by default, or the position's
// own R multiple / price distance (Scalper Mode, G4) -- and only that once
// (`slPrice !== entryPrice` guards against re-triggering every subsequent bar).
//
// Trailing keeps the SL exactly trailingPoints behind the best price seen
// so far, and -- critically -- only ever moves it TOWARD the position's
// favor, never back: a bar that pulls back doesn't drag the stop with it.
// Break-even only ever TIGHTENS the stop: one already at or past the entry (a
// trail that has run, or a hand-placed lock-in) is left where it is.
function stopBeyondEntry(pos: OpenPosition): boolean {
  return pos.slPrice !== null && sideSign(pos.side) * (pos.slPrice - pos.entryPrice) >= 0
}

function applyBreakevenAndTrailing(position: OpenPosition, bar: Bar, spec: ContractSpec): OpenPosition {
  let pos = position
  const favorableExtreme = pos.side === 'long' ? bar.high : bar.low

  if (pos.autoBreakeven && pos.slPrice !== pos.entryPrice && !stopBeyondEntry(pos)) {
    const beDistance = pos.breakevenPoints ?? null
    let triggered = false
    if (beDistance !== null && beDistance > 0) {
      // A distance: the bar's favorable extreme is at least this far past entry.
      triggered = sideSign(pos.side) * (favorableExtreme - pos.entryPrice) >= beDistance - 1e-9
    } else if (pos.riskUsd) {
      // A multiple of the risk frozen at entry (default 1R).
      const profitAtExtreme = unrealizedPnl(pos.side, pos.entryPrice, favorableExtreme, pos.contracts, spec)
      triggered = profitAtExtreme >= pos.riskUsd * (pos.breakevenR ?? 1) - 1e-9
    }
    if (triggered) pos = { ...pos, slPrice: pos.entryPrice }
  }

  if (pos.trailingPoints !== null && pos.trailingPoints > 0) {
    const candidateSl = pos.side === 'long' ? favorableExtreme - pos.trailingPoints : favorableExtreme + pos.trailingPoints
    const trailedSl =
      pos.slPrice === null ? candidateSl : pos.side === 'long' ? Math.max(pos.slPrice, candidateSl) : Math.min(pos.slPrice, candidateSl)
    if (trailedSl !== pos.slPrice) pos = { ...pos, slPrice: trailedSl }
  }

  return pos
}

// FXR_SPEC.md section B, phase F4: closes CONTRACTS-worth of the position
// at exitPrice, journaling that slice as its own ClosedTradeResult, and
// returns whatever's left open (null if this closed the whole thing).
// There is only ever ONE entry fill in this model (no averaging-in), so
// the remainder's entryPrice/entryTime/slPrice/tpPrice are all unchanged --
// only contracts (and riskUsd, proportionally) shrink. riskUsd shrinks
// proportionally because it represents a DOLLAR figure frozen at entry for
// the WHOLE position; the remaining contracts' share of that original
// risk is smaller, so R-multiples on both the closed slice and whatever's
// left keep meaning "fraction of the ORIGINALLY intended max loss", not a
// number that jumps around across partial closes.
export interface PartialCloseResult {
  closedTrade: ClosedTradeResult
  remainingPosition: OpenPosition | null
}

export function closePositionPartial(
  bars: Bar[],
  position: OpenPosition,
  exitIndex: number,
  contractsToClose: number,
  exitPrice: number,
  exitType: ExitType,
  spec: ContractSpec,
  commissionPerContract: number,
): PartialCloseResult {
  const closingAll = contractsToClose >= position.contracts
  const closedPortion: OpenPosition = closingAll
    ? position
    : {
        ...position,
        contracts: contractsToClose,
        riskUsd: position.riskUsd !== null ? (position.riskUsd * contractsToClose) / position.contracts : null,
      }
  const closedTrade = closePositionAt(bars, closedPortion, exitIndex, exitPrice, exitType, spec, commissionPerContract)
  if (closingAll) return { closedTrade, remainingPosition: null }

  const remainingContracts = position.contracts - contractsToClose
  const remainingPosition: OpenPosition = {
    ...position,
    contracts: remainingContracts,
    riskUsd: position.riskUsd !== null ? (position.riskUsd * remainingContracts) / position.contracts : null,
  }
  return { closedTrade, remainingPosition }
}

// The "Close half" button's own convenience wrapper -- mirrors
// closePosition's own relationship to closePositionAt (always at market,
// always a manual_close; partial closes are a manual-only action in F4,
// never auto-triggered by SL/TP).
export function closePositionPartialAtMarket(
  bars: Bar[],
  position: OpenPosition,
  exitIndex: number,
  contractsToClose: number,
  spec: ContractSpec,
  commissionPerContract: number,
): PartialCloseResult {
  return closePositionPartial(
    bars,
    position,
    exitIndex,
    contractsToClose,
    marketFillPrice(bars[exitIndex]),
    'manual_close',
    spec,
    commissionPerContract,
  )
}

export interface AdvanceReplayResult {
  position: OpenPosition | null
  workingOrders: WorkingOrder[]
  closedTrades: ClosedTradeResult[]
  filledOrderIds: string[]
  // Set when a no-overnight / no-weekend close flattened a position or cancelled
  // working orders in this advance (G6), so the UI can say so.
  flattenedAtClose: boolean
}

// `bars` is the 1-minute feed (G5), so "every bar passed over" is every MINUTE
// passed over, even when one step spans an hour: orders, SL/TP, break-even and
// trailing are all evaluated at 1m resolution. Nothing here reads a bar after
// `toIndexInclusive` -- the property the tests check by poisoning them.
//
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
  holding: HoldingRule | null = null,
): AdvanceReplayResult {
  let pos = position
  let orders = workingOrders
  const closedTrades: ClosedTradeResult[] = []
  const filledOrderIds: string[] = []
  let flattenedAtClose = false

  // G6: the next no-overnight / no-weekend close the replay has not yet reached,
  // measured from the end of the bar the cursor is on. At it, an open position is
  // closed at the last revealed price and working orders are cancelled.
  let nextClose = holding && fromIndexExclusive >= 0 ? nextCloseAfter(holding, bars[fromIndexExclusive].time + 60) : Number.POSITIVE_INFINITY
  const flattenAt = (exitIndex: number) => {
    if (pos && exitIndex >= pos.entryIndex) {
      closedTrades.push(closePositionAt(bars, pos, exitIndex, marketFillPrice(bars[exitIndex]), 'session_close', spec, commissionPerContract))
      pos = null
      flattenedAtClose = true
    }
    if (orders.length > 0) {
      orders = []
      flattenedAtClose = true
    }
    nextClose = holding ? nextCloseAfter(holding, nextClose) : Number.POSITIVE_INFINITY
  }

  for (let i = fromIndexExclusive + 1; i <= toIndexInclusive; i++) {
    const bar = bars[i]

    // The close fell in a gap before this bar (halt, weekend): the position was
    // last priced at the bar before it, and nothing may fill on this one.
    while (holding && bar.time >= nextClose) flattenAt(i - 1)

    // A position only meets bars AFTER the one it was entered on, and an order
    // only bars after the one it was placed on. Moving the cursor back and
    // forward again re-walks bars already behind a trade; without this a rewound
    // replay would fill an order, or stop a position, on price action from
    // before it existed.
    if (pos && bar.time > pos.entryTime) {
      const hit = slTpHit(pos, bar)
      if (hit) {
        const exitPrice = hit === 'stop_loss' ? (pos.slPrice as number) : (pos.tpPrice as number)
        closedTrades.push(closePositionAt(bars, pos, i, exitPrice, hit, spec, commissionPerContract))
        pos = null
      } else {
        // Only a position that was ALREADY open (and survived this bar's
        // own SL/TP check) gets its stop adjusted -- never a position that
        // just filled this same bar (see the same-bar-exit branch below,
        // which deliberately does not call this).
        pos = applyBreakevenAndTrailing(pos, bar, spec)
      }
    }

    if (!pos && orders.length > 0) {
      const idx = orders.findIndex((o) => bar.time > o.placedTime && orderTriggered(o, bar))
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
          autoBreakeven: order.autoBreakeven,
          trailingPoints: order.trailingPoints,
          breakevenR: order.breakevenR,
          breakevenPoints: order.breakevenPoints,
          tradeKey: order.id,
          initialContracts: order.contracts,
          ghostSl: null,
          ghostTp: null,
          journal: order.journal,
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

    // The close lands exactly at this bar's end: flatten at its close.
    while (holding && bar.time + 60 >= nextClose) flattenAt(i)
  }

  return { position: pos, workingOrders: orders, closedTrades, filledOrderIds, flattenedAtClose }
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
