// FXR_V2_SPEC.md phase G2 (fast order entry), section 3: the pure rules behind
// Quick Buy/Sell, the ghost SL/TP lines, the on-chart order labels, the
// right-click order pair and partial close / break-even. Framework-free like
// simBroker.ts (which owns fills and P&L) -- this module only decides WHERE
// things go and WHAT they say, from numbers the broker already computed, so it
// can be tested without mounting a chart.
//
// No look-ahead: everything here reads the cursor bar and earlier, never later.
import type { Bar, ManualTrade } from '../api/types'
import { fmtPrice, fmtUsd } from '../format'
import { impliedOrderType, sideSign, unrealizedPnl, type ContractSpec, type OpenPosition, type PendingOrderType, type Side } from './simBroker'

export function roundToTick(price: number, tickSize: number): number {
  return Math.round(price / tickSize) * tickSize
}

// --- 3.2 Ghost SL/TP -------------------------------------------------------

// ATR over the last `period` bars up to and INCLUDING the cursor bar -- the
// volatility a trader looking at the chart right now can see, nothing later.
// null with fewer than two revealed bars (no true range exists yet).
export function averageTrueRange(bars: readonly Bar[], cursorIndex: number, period = 14): number | null {
  const last = Math.min(cursorIndex, bars.length - 1)
  const first = Math.max(1, last - period + 1)
  if (last < 1) return null
  let sum = 0
  let n = 0
  for (let i = first; i <= last; i++) {
    const prevClose = bars[i - 1].close
    sum += Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - prevClose), Math.abs(bars[i].low - prevClose))
    n++
  }
  return n > 0 ? sum / n : null
}

// Defaults when there is no volatility to read yet, and the floor under it.
export const GHOST_FALLBACK_POINTS = 10
export const GHOST_MIN_TICKS = 8
export const GHOST_REWARD_RISK = 2

// "Sensible default distances": the stop sits one ATR from the entry (never
// closer than GHOST_MIN_TICKS, so a dead-quiet stretch doesn't put it inside
// the spread of noise), the target GHOST_REWARD_RISK times that. Both snap to
// the tick grid; SL is on the loss side, TP on the profit side.
export function ghostLevels(side: Side, entryPrice: number, spec: ContractSpec, atr: number | null): { sl: number; tp: number } {
  const floor = GHOST_MIN_TICKS * spec.tickSize
  const raw = atr !== null && atr > 0 ? Math.max(atr, floor) : GHOST_FALLBACK_POINTS
  const dist = Math.max(spec.tickSize, roundToTick(raw, spec.tickSize))
  const sign = sideSign(side)
  return {
    sl: roundToTick(entryPrice - sign * dist, spec.tickSize),
    tp: roundToTick(entryPrice + sign * dist * GHOST_REWARD_RISK, spec.tickSize),
  }
}

// Ghosts appear only for an entry that carries neither level ("Ghosts never
// appear if SL/TP were already set") -- a bracketed entry (the New Trade
// ticket, a filled working order, later Scalper Mode) never gets them.
export function ghostsApply(slPrice: number | null, tpPrice: number | null): boolean {
  return slPrice === null && tpPrice === null
}

export type LevelKind = 'sl' | 'tp'

// A level is only meaningful on its own side of where price is NOW: a stop
// below a long's market (above a short's), a target above (below). Anything
// else would fill on the very next bar. Returns the reason, or null if fine.
export function levelRefusal(side: Side, kind: LevelKind, price: number, mark: number, tickSize: number): string | null {
  const sign = sideSign(side)
  const p = roundToTick(price, tickSize)
  const lossSide = kind === 'sl'
  // For a long: SL must be < mark, TP must be > mark. Short mirrors it.
  const ok = lossSide ? sign * (mark - p) > 0 : sign * (p - mark) > 0
  if (ok) return null
  const where = (lossSide ? sign > 0 : sign < 0) ? 'below' : 'above'
  return `${lossSide ? 'Stop loss' : 'Take profit'} must be ${where} the current price (${mark.toFixed(2)}) for a ${side} position.`
}

// --- the live readout on a level's label -----------------------------------

export interface LevelReadout {
  pnlUsd: number // gross P&L if price reaches the level (commission is charged on exit, not shown here)
  ticks: number // distance from entry
  percent: number // distance as % of the entry price
}

export function levelReadout(side: Side, entryPrice: number, price: number, contracts: number, spec: ContractSpec): LevelReadout {
  const p = roundToTick(price, spec.tickSize)
  return {
    pnlUsd: unrealizedPnl(side, entryPrice, p, contracts, spec),
    ticks: Math.round(Math.abs(p - entryPrice) / spec.tickSize),
    percent: entryPrice !== 0 ? (Math.abs(p - entryPrice) / entryPrice) * 100 : 0,
  }
}

export function fmtSignedUsd(v: number): string {
  const text = fmtUsd(v)
  return v > 0 && !text.startsWith('-') ? `+${text}` : text
}

// --- on-chart label segments -----------------------------------------------

export type OrderLineRole = 'ghost-sl' | 'ghost-tp' | 'sl' | 'tp' | 'position' | 'order'
export type SegmentTone = 'tag' | 'neutral' | 'positive' | 'negative' | 'muted'

export interface LabelSegment {
  // Hit-test key: 'close' is the × button; 'grip' is the drag handle (drawn as
  // dots, its text is empty); 'hint' the ghost-only "drag to place" cue.
  key: 'grip' | 'tag' | 'hint' | 'body' | 'qty' | 'close'
  text: string
  tone: SegmentTone
}

// What an order line knows about itself (ChartKL's klOrderLabel overlay
// reads this from extendData; the live price comes from the overlay's own
// point, so a drag updates the label on every frame without a React round trip).
export interface OrderLineInfo {
  role: OrderLineRole
  side: Side
  entryPrice: number
  contracts: number
  spec: ContractSpec
  // position: its live open P&L (the workspace pushes this on every step).
  pnlUsd?: number
  // working order: its type, for "BUY LIMIT 2".
  orderType?: PendingOrderType
  // G10: the line belongs to the Autopilot bot, not the manual book. Read-only: no
  // grip, no x, tagged "BOT" (the server's engine owns it).
  bot?: boolean
}

function tone(v: number): SegmentTone {
  return v > 0 ? 'positive' : v < 0 ? 'negative' : 'neutral'
}

export function labelSegments(info: OrderLineInfo, price: number): LabelSegment[] {
  if (info.role === 'position') {
    const pnl = info.pnlUsd ?? 0
    if (info.bot) {
      return [
        { key: 'tag', text: `BOT ${info.side === 'long' ? 'LONG' : 'SHORT'} ${info.contracts}`, tone: 'neutral' },
        { key: 'body', text: fmtSignedUsd(pnl), tone: tone(pnl) },
      ]
    }
    return [
      { key: 'tag', text: `${info.side === 'long' ? 'LONG' : 'SHORT'} ${info.contracts}`, tone: 'neutral' },
      { key: 'body', text: fmtSignedUsd(pnl), tone: tone(pnl) },
      { key: 'close', text: '×', tone: 'muted' },
    ]
  }
  if (info.role === 'order') {
    return [
      { key: 'tag', text: `${info.side === 'long' ? 'BUY' : 'SELL'} ${(info.orderType ?? 'limit').toUpperCase()} ${info.contracts}`, tone: 'neutral' },
      { key: 'close', text: '×', tone: 'muted' },
    ]
  }
  // SL / TP: grip | tag | $ | ticks | % | qty | x. A GHOST (not yet placed,
  // nothing will fill there) is told apart at a glance: it says "drag to place"
  // and carries no qty -- it is a suggestion, not an order.
  const r = levelReadout(info.side, info.entryPrice, price, info.contracts, info.spec)
  const isSl = info.role === 'sl' || info.role === 'ghost-sl'
  const ghost = info.role === 'ghost-sl' || info.role === 'ghost-tp'
  const body: LabelSegment = { key: 'body', text: `${fmtSignedUsd(r.pnlUsd)} | ${r.ticks} ticks | ${r.percent.toFixed(2)}%`, tone: tone(r.pnlUsd) }
  const tag: LabelSegment = { key: 'tag', text: isSl ? 'SL' : 'TP', tone: 'tag' }
  const grip: LabelSegment = { key: 'grip', text: '', tone: 'muted' }
  const close: LabelSegment = { key: 'close', text: '×', tone: 'muted' }
  // The bot's own stop / target: shown, never edited from here.
  if (info.bot) return [{ ...tag, text: `BOT ${isSl ? 'SL' : 'TP'}` }, body, { key: 'qty', text: String(info.contracts), tone: 'muted' }]
  if (ghost) return [grip, tag, { key: 'hint', text: 'drag to place', tone: 'muted' }, body, close]
  return [grip, tag, body, { key: 'qty', text: String(info.contracts), tone: 'muted' }, close]
}

// --- 3.3 Right-click orders ------------------------------------------------

export interface RightClickOrder {
  side: Side
  orderType: PendingOrderType
  price: number
  contracts: number
  label: string
}

// The pair for where you clicked, sized by the Quick quantity. Above market:
// sell limit + buy stop; below: buy limit + sell stop (impliedOrderType is the
// one place that rule lives). Listed Buy first, as in the reference. Clicking
// ON the market price offers nothing -- there is no limit/stop there.
export function rightClickOrders(
  clickPrice: number,
  marketPrice: number,
  quantity: number,
  instrument: string,
  spec: ContractSpec,
): RightClickOrder[] {
  const price = roundToTick(clickPrice, spec.tickSize)
  if (price === marketPrice) return []
  return (['long', 'short'] as const).map((side) => {
    const orderType = impliedOrderType(side, price, marketPrice)
    return {
      side,
      orderType,
      price,
      contracts: quantity,
      label: `${side === 'long' ? 'Buy' : 'Sell'} ${quantity} ${instrument} @ ${fmtPrice(price, instrument)} ${orderType}`,
    }
  })
}

// Armed Scalper Mode brackets every right-click order, so its rows say so (G4):
// "Buy 2 MNQ @ 20,050.25 limit · with brackets". Only when a stop or a target
// will really be placed (armed with both off places nothing).
export function withBracketsNote(label: string, brackets: { slPrice: number | null; tpPrice: number | null } | null): string {
  return brackets && (brackets.slPrice !== null || brackets.tpPrice !== null) ? `${label} · with brackets` : label
}

// --- 3.6 Partials and management -------------------------------------------

// A partial close needs a whole quantity from 1 up to (not including) the open
// size; the full size is a plain Close. Returns the reason it is refused.
export function partialCloseRefusal(quantity: number, openContracts: number): string | null {
  if (!Number.isInteger(quantity) || quantity < 1) return 'Enter a whole number of contracts (1 or more).'
  if (openContracts < 2) return 'Only one contract is open. Use Close.'
  if (quantity >= openContracts) return `Enter fewer than the ${openContracts} open contracts, or use Close.`
  return null
}

// The quantities offered as one-click items in the position-line menu: every
// whole number below the open size when that is a handful, else a spread
// (1, quarter, half, three-quarters). The Positions row takes any quantity.
export function partialCloseChoices(openContracts: number): number[] {
  if (openContracts < 2) return []
  if (openContracts <= 6) return Array.from({ length: openContracts - 1 }, (_, i) => i + 1)
  const picks = new Set([1, Math.round(openContracts / 4), Math.round(openContracts / 2), Math.round((openContracts * 3) / 4)])
  return [...picks].filter((q) => q >= 1 && q < openContracts).sort((a, b) => a - b)
}

// Break-even in one click: the stop goes to the entry price (a PRICE; commission
// is separate -- same convention as auto break-even). Only valid once price is
// strictly beyond entry, else the stop would sit at or past the market.
export function breakevenRefusal(position: Pick<OpenPosition, 'side' | 'entryPrice' | 'slPrice'>, mark: number): string | null {
  if (position.slPrice === position.entryPrice) return 'The stop is already at break-even.'
  if (sideSign(position.side) * (mark - position.entryPrice) <= 0) return 'Break-even needs the trade in profit. The stop would sit at or past the market.'
  return null
}

// A journaled trade is still partly open while its exits cover less than its
// entry size (the remainder is the live position). A pre-G2 trade has no
// `exits` and is always fully closed.
export function tradeOpenContracts(trade: Pick<ManualTrade, 'size_contracts' | 'exits'>): number {
  if (!trade.exits || trade.exits.length === 0) return 0
  return Math.max(0, trade.size_contracts - trade.exits.reduce((n, e) => n + e.contracts, 0))
}
