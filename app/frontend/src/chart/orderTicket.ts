// FXR_V2_SPEC.md phase G3, section 3.5: the pure rules behind the Place Order
// dialog -- risk-based sizing, the linked fields (Risk % <-> Risk $, price <->
// ticks), type/side validation against the current price, the Topstep cap, and
// the pre-fill from a position tool. Framework-free like simBroker.ts and
// orderEntry.ts so every rule can be tested without mounting the dialog.
//
// The dialog's inputs are STRINGS (a half-typed "20050." must survive a
// re-render), so this module owns a form of strings plus the functions that
// edit it. Each edit re-derives whatever is linked to the field that changed
// and returns a fresh form -- the component only calls these and renders.
//
// No look-ahead: the only market input is `mark`, the cursor bar's close
// (what the sim broker fills a market order at), and `atr`, computed from bars
// up to and including the cursor. Nothing here reads a later bar.
import { fmtPrice } from '../format'
import { ghostLevels, roundToTick } from './orderEntry'
import { positionCapMessage } from './positionCap'
import { impliedOrderType, sideSign, type ContractSpec, type Side } from './simBroker'

export const RISK_CHIPS = [0.25, 0.5, 0.75, 1, 2, 3] as const

export type BalanceBasis = 'initial' | 'current'
export type OrderKind = 'market' | 'limit' | 'stop'
export type LevelKind = 'sl' | 'tp'

// What the dialog needs to know about the session and the market right now.
export interface OrderContext {
  instrument: string
  spec: ContractSpec
  // The cursor bar's close: where a market order fills, and the price a limit /
  // stop is validated against.
  mark: number
  balances: { initial: number; current: number }
  // The session's position limit (Topstep: 5); null = a practice session, uncapped.
  cap: number | null
  // The Quick quantity: the size when there is no stop to size from.
  quickQuantity: number
  // ATR up to the cursor, for the default stop/target distance (null = unknown).
  atr: number | null
}

// --- numbers <-> text ------------------------------------------------------

export function parseNumber(text: string): number | null {
  const t = text.trim()
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

export function priceText(price: number): string {
  return price.toFixed(2)
}

export function usdText(usd: number): string {
  return usd.toFixed(2)
}

// Up to 4 decimals, no trailing zeros: 1 -> "1", 0.25 -> "0.25", 0.8333 -> "0.8333".
export function pctText(pct: number): string {
  return String(Number(pct.toFixed(4)))
}

const cents = (usd: number) => Math.round(usd * 100) / 100

// --- risk <-> size ---------------------------------------------------------

export function balanceFor(basis: BalanceBasis, balances: OrderContext['balances']): number {
  return basis === 'initial' ? balances.initial : balances.current
}

export function riskUsdFromPct(pct: number, balance: number): number {
  return cents((pct / 100) * balance)
}

export function riskPctFromUsd(usd: number, balance: number): number {
  return balance > 0 ? Number(((usd / balance) * 100).toFixed(4)) : 0
}

export interface SizeResult {
  contracts: number
  // risk_usd / (stop distance in $) before rounding -- what the budget could buy.
  exactContracts: number
  riskPerContract: number
  // What the chosen size really risks if the stop is hit (contracts x $/contract).
  actualRiskUsd: number
  targetRiskUsd: number
  // The budget could not buy even one contract; one is the smallest order, so
  // the actual risk is ABOVE the target.
  belowOne: boolean
  // The Topstep limit shrank the size: the cap, else null.
  cappedAt: number | null
}

// "Auto-sized from risk and stop distance, rounded DOWN to whole contracts"
// (3.5): never rounds up past the budget. The one exception is a budget too
// small for a single contract, where 1 is the smallest order that exists
// (`belowOne`, with the true actual risk reported). A cap clamps the size.
// Returns null when there is nothing to size from (no stop distance or no
// positive risk).
export function sizeFromRisk(riskUsd: number, entry: number, sl: number, spec: ContractSpec, cap: number | null): SizeResult | null {
  const distance = Math.abs(entry - sl)
  const riskPerContract = distance * spec.pointValue
  if (!(riskUsd > 0) || !(riskPerContract > 0)) return null
  const exactContracts = riskUsd / riskPerContract
  // 1e-9: 1000 / 10 is exactly 100 but 0.1 + 0.2-style quotients can land a hair under.
  const floored = Math.floor(exactContracts + 1e-9)
  const belowOne = floored < 1
  let contracts = Math.max(1, floored)
  let cappedAt: number | null = null
  if (cap !== null && contracts > cap) {
    contracts = cap
    cappedAt = cap
  }
  return { contracts, exactContracts, riskPerContract, actualRiskUsd: cents(contracts * riskPerContract), targetRiskUsd: riskUsd, belowOne, cappedAt }
}

// --- price <-> ticks -------------------------------------------------------

export function ticksBetween(entry: number, price: number, tickSize: number): number {
  return Math.round(Math.abs(price - entry) / tickSize)
}

// A stop sits on the loss side of the entry, a target on the profit side.
export function priceFromTicks(side: Side, kind: LevelKind, entry: number, ticks: number, tickSize: number): number {
  const direction = kind === 'sl' ? -sideSign(side) : sideSign(side)
  return roundToTick(entry + direction * ticks * tickSize, tickSize)
}

// --- validation ------------------------------------------------------------

export function suggestOrderType(side: Side, entry: number, mark: number): OrderKind {
  return entry === mark ? 'market' : impliedOrderType(side, entry, mark)
}

const sideWord = (side: Side) => (side === 'long' ? 'Buy' : 'Sell')

// A limit waits for a better price, a stop chases a breakout; either one placed
// at (or through) the market would just fill on the next bar, which a Market
// order says honestly. Returns the reason, or null if the type fits the price.
export function orderTypeRefusal(kind: OrderKind, side: Side, entry: number, mark: number, instrument: string): string | null {
  if (kind === 'market') return null
  const shown = fmtPrice(mark, instrument)
  const buy = side === 'long'
  if (kind === 'limit') {
    const ok = buy ? entry < mark : entry > mark
    if (ok) return null
    return `${sideWord(side)} limit must be ${buy ? 'below' : 'above'} the current price (${shown}). Use a ${buy ? 'stop to buy above' : 'stop to sell below'} it, or Market.`
  }
  const ok = buy ? entry > mark : entry < mark
  if (ok) return null
  return `${sideWord(side)} stop must be ${buy ? 'above' : 'below'} the current price (${shown}). Use a ${buy ? 'limit to buy below' : 'limit to sell above'} it, or Market.`
}

// A stop / target is measured from the ENTRY (for a limit or stop order that is
// not the market): beyond it on its own side by at least a tick.
export function bracketRefusal(side: Side, kind: LevelKind, price: number, entry: number, tickSize: number): string | null {
  const direction = kind === 'sl' ? -sideSign(side) : sideSign(side)
  if (direction * (price - entry) >= tickSize - 1e-9) return null
  const where = direction < 0 ? 'below' : 'above'
  return `${kind === 'sl' ? 'Stop loss' : 'Take profit'} must be at least one tick ${where} the entry price for a ${sideWord(side).toLowerCase()}.`
}

// --- the form --------------------------------------------------------------

export interface OrderForm {
  side: Side
  type: OrderKind
  // True until the user picks a type themselves: side and entry edits keep
  // re-deriving it (a price above the market on a buy is a stop, and so on).
  typeAuto: boolean
  entry: string
  basis: BalanceBasis
  riskPct: string
  riskUsd: string
  contracts: string
  // True once the size was typed: risk and stop edits then leave it alone
  // until the user changes one of them (which hands sizing back to the risk).
  contractsManual: boolean
  slOn: boolean
  slPrice: string
  slTicks: string
  tpOn: boolean
  tpPrice: string
  tpTicks: string
  autoBreakeven: boolean
  tags: string[]
  checklist: string[]
}

// The position tool's three levels, as drawn on the chart.
export interface PositionToolLevels {
  side: Side
  entry: number
  sl: number
  tp: number
}

export interface InitialFormOptions {
  tool: PositionToolLevels | null
  riskPct: number
  basis: BalanceBasis
  autoBreakeven: boolean
  // G4's "new market / limit / stop order" hotkeys: open with this type chosen
  // (and kept, rather than re-derived from the price). Without a position tool a
  // limit / stop starts one default stop-distance away from the market, on the
  // side of it that type needs for a buy, so the form opens valid.
  type?: OrderKind
}

function ticksText(entry: number | null, price: number | null, tickSize: number): string {
  return entry === null || price === null ? '' : String(ticksBetween(entry, price, tickSize))
}

// Where a preset limit / stop opens for a buy: one default stop-distance below /
// above the market (a sell limit / stop mirrors it, which is what Side does).
function presetEntry(side: Side, type: OrderKind | undefined, ctx: OrderContext): number {
  if (type !== 'limit' && type !== 'stop') return ctx.mark
  const distance = Math.abs(ctx.mark - ghostLevels('long', ctx.mark, ctx.spec, ctx.atr).sl)
  const away = (type === 'limit' ? -1 : 1) * sideSign(side)
  return roundToTick(ctx.mark + away * distance, ctx.spec.tickSize)
}

// Pre-fill (3.5): from the tool when there is one (its side, entry, stop and
// target, the type derived from where the entry sits against the market);
// otherwise an empty order -- a market buy at the current price with the stop
// and target at the default ATR distances, which the toggles can switch off.
export function initialForm(ctx: OrderContext, opts: InitialFormOptions): OrderForm {
  const { tool } = opts
  const side: Side = tool?.side ?? 'long'
  const entry = opts.type === 'market' ? ctx.mark : (tool?.entry ?? presetEntry(side, opts.type, ctx))
  const defaults = ghostLevels(side, entry, ctx.spec, ctx.atr)
  const sl = tool?.sl ?? defaults.sl
  const tp = tool?.tp ?? defaults.tp
  const form: OrderForm = {
    side,
    type: opts.type ?? suggestOrderType(side, entry, ctx.mark),
    typeAuto: opts.type === undefined,
    entry: priceText(entry),
    basis: opts.basis,
    riskPct: pctText(opts.riskPct),
    riskUsd: usdText(riskUsdFromPct(opts.riskPct, balanceFor(opts.basis, ctx.balances))),
    contracts: '',
    contractsManual: false,
    slOn: true,
    slPrice: priceText(sl),
    slTicks: ticksText(entry, sl, ctx.spec.tickSize),
    tpOn: true,
    tpPrice: priceText(tp),
    tpTicks: ticksText(entry, tp, ctx.spec.tickSize),
    autoBreakeven: opts.autoBreakeven,
    tags: [],
    checklist: [],
  }
  return resize(form, ctx)
}

// The entry the order would carry: the market price for a Market order, else
// what is typed (snapped to the tick grid).
export function entryOf(form: OrderForm, ctx: OrderContext): number | null {
  if (form.type === 'market') return ctx.mark
  const typed = parseNumber(form.entry)
  return typed === null ? null : roundToTick(typed, ctx.spec.tickSize)
}

function levelOf(form: OrderForm, ctx: OrderContext, kind: LevelKind): number | null {
  const on = kind === 'sl' ? form.slOn : form.tpOn
  if (!on) return null
  const typed = parseNumber(kind === 'sl' ? form.slPrice : form.tpPrice)
  return typed === null ? null : roundToTick(typed, ctx.spec.tickSize)
}

// Re-derives the size from risk and stop distance. Does nothing while the size
// was typed by hand (`contractsManual`), and keeps whatever is there when there
// is nothing valid to size from. With no stop at all it falls back to the Quick
// quantity (clamped to the cap) -- there is no distance to risk against.
export function resize(form: OrderForm, ctx: OrderContext): OrderForm {
  if (form.contractsManual) return form
  const entry = entryOf(form, ctx)
  const sl = levelOf(form, ctx, 'sl')
  if (!form.slOn) {
    const size = ctx.cap !== null ? Math.min(ctx.cap, ctx.quickQuantity) : ctx.quickQuantity
    return { ...form, contracts: String(Math.max(1, size)) }
  }
  const risk = parseNumber(form.riskUsd)
  if (entry === null || sl === null || risk === null) return form
  const sized = sizeFromRisk(risk, entry, sl, ctx.spec, ctx.cap)
  return sized ? { ...form, contracts: String(sized.contracts) } : form
}

// Re-reads both ticks fields from their prices (after the entry moved).
function relinkTicks(form: OrderForm, ctx: OrderContext): OrderForm {
  const entry = entryOf(form, ctx)
  const tick = ctx.spec.tickSize
  return {
    ...form,
    slTicks: ticksText(entry, parseNumber(form.slPrice), tick) || form.slTicks,
    tpTicks: ticksText(entry, parseNumber(form.tpPrice), tick) || form.tpTicks,
  }
}

function retype(form: OrderForm, ctx: OrderContext): OrderForm {
  if (!form.typeAuto) return form
  const entry = entryOf(form, ctx)
  return entry === null ? form : { ...form, type: suggestOrderType(form.side, entry, ctx.mark) }
}

const handBackSizing = (form: OrderForm): OrderForm => ({ ...form, contractsManual: false })

export function setSide(form: OrderForm, ctx: OrderContext, side: Side): OrderForm {
  if (side === form.side) return form
  let next: OrderForm = { ...form, side }
  const entry = entryOf(next, ctx)
  if (entry !== null) {
    // The levels were on the old side's profit/loss halves; mirror their
    // distances to the new side so the order stays a coherent bracket.
    const mirror = (text: string): string => {
      const p = parseNumber(text)
      return p === null ? text : priceText(roundToTick(2 * entry - p, ctx.spec.tickSize))
    }
    next = { ...next, slPrice: mirror(next.slPrice), tpPrice: mirror(next.tpPrice) }
  }
  return resize(relinkTicks(retype(next, ctx), ctx), ctx)
}

export function setType(form: OrderForm, ctx: OrderContext, type: OrderKind): OrderForm {
  let next: OrderForm = { ...form, type, typeAuto: false }
  // A Market order fills at the current price, so the entry field follows it.
  if (type === 'market') next = { ...next, entry: priceText(ctx.mark) }
  return resize(relinkTicks(handBackSizing(next), ctx), ctx)
}

export function setEntry(form: OrderForm, ctx: OrderContext, text: string): OrderForm {
  // Typing a price is choosing to enter there: a Market order (which has no
  // price of its own) becomes whatever type that price implies, unless the
  // user fixed the type already.
  let next: OrderForm = { ...form, entry: text }
  if (next.type === 'market' && next.typeAuto) {
    const typed = parseNumber(text)
    if (typed !== null) next = { ...next, type: suggestOrderType(next.side, roundToTick(typed, ctx.spec.tickSize), ctx.mark) }
  } else {
    next = retype(next, ctx)
  }
  return resize(relinkTicks(handBackSizing(next), ctx), ctx)
}

export function setLevelPrice(form: OrderForm, ctx: OrderContext, kind: LevelKind, text: string): OrderForm {
  const entry = entryOf(form, ctx)
  const typed = parseNumber(text)
  const ticks = entry !== null && typed !== null ? String(ticksBetween(entry, typed, ctx.spec.tickSize)) : kind === 'sl' ? form.slTicks : form.tpTicks
  const next: OrderForm = kind === 'sl' ? { ...form, slPrice: text, slTicks: ticks } : { ...form, tpPrice: text, tpTicks: ticks }
  return kind === 'sl' ? resize(handBackSizing(next), ctx) : next
}

export function setLevelTicks(form: OrderForm, ctx: OrderContext, kind: LevelKind, text: string): OrderForm {
  const entry = entryOf(form, ctx)
  const n = parseNumber(text)
  const price = entry !== null && n !== null && n >= 0 ? priceText(priceFromTicks(form.side, kind, entry, n, ctx.spec.tickSize)) : kind === 'sl' ? form.slPrice : form.tpPrice
  const next: OrderForm = kind === 'sl' ? { ...form, slTicks: text, slPrice: price } : { ...form, tpTicks: text, tpPrice: price }
  return kind === 'sl' ? resize(handBackSizing(next), ctx) : next
}

export function toggleLevel(form: OrderForm, ctx: OrderContext, kind: LevelKind, on: boolean): OrderForm {
  let next: OrderForm = kind === 'sl' ? { ...form, slOn: on } : { ...form, tpOn: on }
  const entry = entryOf(next, ctx)
  const priceField = kind === 'sl' ? next.slPrice : next.tpPrice
  // Switching a level on with nothing usable in it: the default distance.
  if (on && entry !== null && parseNumber(priceField) === null) {
    const d = ghostLevels(next.side, entry, ctx.spec, ctx.atr)
    const price = kind === 'sl' ? d.sl : d.tp
    next = kind === 'sl' ? { ...next, slPrice: priceText(price), slTicks: ticksText(entry, price, ctx.spec.tickSize) } : { ...next, tpPrice: priceText(price), tpTicks: ticksText(entry, price, ctx.spec.tickSize) }
  }
  // Break-even moves the stop, so it cannot outlive it.
  if (kind === 'sl' && !on) next = { ...next, autoBreakeven: false }
  return kind === 'sl' ? resize(handBackSizing(next), ctx) : next
}

export function setRiskPct(form: OrderForm, ctx: OrderContext, text: string): OrderForm {
  const pct = parseNumber(text)
  const next: OrderForm = { ...form, riskPct: text, riskUsd: pct === null ? form.riskUsd : usdText(riskUsdFromPct(pct, balanceFor(form.basis, ctx.balances))) }
  return resize(handBackSizing(next), ctx)
}

export function setRiskUsd(form: OrderForm, ctx: OrderContext, text: string): OrderForm {
  const usd = parseNumber(text)
  const balance = balanceFor(form.basis, ctx.balances)
  const next: OrderForm = { ...form, riskUsd: text, riskPct: usd === null ? form.riskPct : pctText(riskPctFromUsd(usd, balance)) }
  return resize(handBackSizing(next), ctx)
}

// Switching the basis keeps the percentage (the thing a trader thinks in) and
// re-prices it in dollars against the other balance.
export function setBasis(form: OrderForm, ctx: OrderContext, basis: BalanceBasis): OrderForm {
  const pct = parseNumber(form.riskPct)
  const next: OrderForm = { ...form, basis, riskUsd: pct === null ? form.riskUsd : usdText(riskUsdFromPct(pct, balanceFor(basis, ctx.balances))) }
  return resize(handBackSizing(next), ctx)
}

export function setContracts(form: OrderForm, text: string): OrderForm {
  return { ...form, contracts: text, contractsManual: true }
}

export function setAutoBreakeven(form: OrderForm, on: boolean): OrderForm {
  return { ...form, autoBreakeven: on && form.slOn }
}

// --- the derived order -----------------------------------------------------

export type IssueField = 'entry' | 'type' | 'sl' | 'tp' | 'risk' | 'contracts' | 'breakeven'

export interface OrderIssue {
  field: IssueField
  message: string
}

export interface OrderSummary {
  entry: number | null
  sl: number | null
  tp: number | null
  contracts: number | null
  // $ lost if the stop is hit / won if the target is (gross of commission,
  // like the on-chart level labels). null without that level or a size.
  estimatedLoss: number | null
  estimatedProfit: number | null
  rewardRisk: number | null
  // The sizing explanation: null when there is no stop to size from.
  sizing: SizeResult | null
  // The real risk of the chosen size, and whether it differs from the target
  // (rounding, the one-contract floor, a cap, or a hand-typed size).
  actualRiskUsd: number | null
  riskDiffers: boolean
}

export function summarize(form: OrderForm, ctx: OrderContext): OrderSummary {
  const entry = entryOf(form, ctx)
  const sl = levelOf(form, ctx, 'sl')
  const tp = levelOf(form, ctx, 'tp')
  const n = parseNumber(form.contracts)
  const contracts = n !== null && Number.isInteger(n) && n >= 1 ? n : null
  const pv = ctx.spec.pointValue
  const risk = parseNumber(form.riskUsd)
  const slDistance = entry !== null && sl !== null ? Math.abs(entry - sl) : null
  const tpDistance = entry !== null && tp !== null ? Math.abs(tp - entry) : null
  const sizing = entry !== null && sl !== null && risk !== null ? sizeFromRisk(risk, entry, sl, ctx.spec, ctx.cap) : null
  const estimatedLoss = slDistance !== null && contracts !== null ? cents(slDistance * pv * contracts) : null
  const estimatedProfit = tpDistance !== null && contracts !== null ? cents(tpDistance * pv * contracts) : null
  return {
    entry,
    sl,
    tp,
    contracts,
    estimatedLoss,
    estimatedProfit,
    rewardRisk: slDistance && tpDistance !== null ? tpDistance / slDistance : null,
    sizing,
    actualRiskUsd: estimatedLoss,
    riskDiffers: estimatedLoss !== null && risk !== null && Math.abs(estimatedLoss - risk) >= 0.005,
  }
}

export function validate(form: OrderForm, ctx: OrderContext): OrderIssue[] {
  const issues: OrderIssue[] = []
  const entry = entryOf(form, ctx)
  if (entry === null || entry <= 0) {
    issues.push({ field: 'entry', message: 'Enter an entry price.' })
  } else {
    const typeIssue = orderTypeRefusal(form.type, form.side, entry, ctx.mark, ctx.instrument)
    if (typeIssue) issues.push({ field: 'type', message: typeIssue })
    for (const kind of ['sl', 'tp'] as const) {
      if (!(kind === 'sl' ? form.slOn : form.tpOn)) continue
      const price = levelOf(form, ctx, kind)
      if (price === null) {
        issues.push({ field: kind, message: `Enter a ${kind === 'sl' ? 'stop loss' : 'take profit'} price, or switch it off.` })
        continue
      }
      const refusal = bracketRefusal(form.side, kind, price, entry, ctx.spec.tickSize)
      if (refusal) issues.push({ field: kind, message: refusal })
    }
  }
  const n = parseNumber(form.contracts)
  if (n === null || !Number.isInteger(n) || n < 1) {
    issues.push({ field: 'contracts', message: 'Enter a whole number of contracts (1 or more).' })
  } else {
    // The Topstep position limit: refused here, with the reason, not after submit.
    const cap = positionCapMessage(n, ctx.cap, 'This order')
    if (cap) issues.push({ field: 'contracts', message: cap })
  }
  const risk = parseNumber(form.riskUsd)
  if (form.slOn && !form.contractsManual && !(risk !== null && risk > 0)) {
    issues.push({ field: 'risk', message: 'Enter a risk above zero to size the order, or type the contracts.' })
  }
  if (form.autoBreakeven && !form.slOn) {
    issues.push({ field: 'breakeven', message: 'Auto break-even moves the stop, so it needs a stop loss.' })
  }
  return issues
}

// "Showing the actual risk when rounding or a cap changes it" (3.5): the line
// under the size, or null when the size risks what was asked for. Says WHY the
// risk differs -- a typed size, a cap, the one-contract floor, or rounding down.
export function actualRiskNote(form: OrderForm, summary: OrderSummary, ctx: OrderContext): string | null {
  if (!form.slOn || !summary.riskDiffers || summary.actualRiskUsd === null) return null
  const target = parseNumber(form.riskUsd)
  if (target === null) return null
  const actual = summary.actualRiskUsd
  const pct = pctText(riskPctFromUsd(actual, balanceFor(form.basis, ctx.balances)))
  const actualText = `$${actual.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  const targetText = `$${target.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  const sizing = summary.sizing
  if (form.contractsManual || !sizing) return `At this size the stop risks ${actualText} (${pct}%).`
  if (sizing.cappedAt !== null) {
    return `Capped at ${sizing.cappedAt} contracts, this session's position limit. Risks ${actualText} (${pct}%) instead of ${targetText}.`
  }
  if (sizing.belowOne) return `One contract is the smallest order. It risks ${actualText} (${pct}%), above your ${targetText} target.`
  return `Rounded down from ${sizing.exactContracts.toFixed(2)} contracts. Risks ${actualText} (${pct}%) instead of ${targetText}.`
}

// What the workspace places: the broker's own order fields, from a valid form.
export interface OrderRequest {
  side: Side
  type: OrderKind
  entryPrice: number
  contracts: number
  slPrice: number | null
  tpPrice: number | null
  // The risk frozen at entry, which R is measured against: the real risk of the
  // size at the stop when there is one, else the target risk from the form.
  riskUsd: number | null
  autoBreakeven: boolean
  tags: string[]
  checklist: string[]
}

export function buildOrder(form: OrderForm, ctx: OrderContext): { ok: true; order: OrderRequest } | { ok: false; issues: OrderIssue[] } {
  const issues = validate(form, ctx)
  if (issues.length > 0) return { ok: false, issues }
  const s = summarize(form, ctx)
  const risk = parseNumber(form.riskUsd)
  return {
    ok: true,
    order: {
      side: form.side,
      type: form.type,
      entryPrice: s.entry as number,
      contracts: s.contracts as number,
      slPrice: s.sl,
      tpPrice: s.tp,
      riskUsd: s.actualRiskUsd ?? (risk !== null && risk > 0 ? risk : null),
      autoBreakeven: form.autoBreakeven,
      tags: form.tags,
      checklist: form.checklist,
    },
  }
}
