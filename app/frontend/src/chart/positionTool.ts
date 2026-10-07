// FXR_V2_SPEC.md phase G3, section 3.5: the Long / Short Position tool's pure
// geometry and label text -- where the three levels may sit, and what the live
// R:R / $ risk / $ reward labels say. Framework-free like orderEntry.ts; the
// klinecharts overlay (kl/positionToolOverlay.ts) only draws what this decides.
//
// No look-ahead: a tool starts at the cursor bar's close (never a later price)
// and its labels read only its own three levels.
import { fmtPrice, fmtUsd } from '../format'
import { ghostLevels, roundToTick } from './orderEntry'
import { sizeFromRisk, type PositionToolLevels } from './orderTicket'
import { sideSign, type ContractSpec, type Side } from './simBroker'

export type { PositionToolLevels } from './orderTicket'
export type ToolHandle = 'entry' | 'sl' | 'tp'

// The tool is drawn by one click: it appears at the CURRENT price ("entry
// defaults to the current price"), with the stop one ATR away and the target at
// the default reward:risk -- the same defaults the ghost SL/TP use.
export function defaultToolLevels(side: Side, mark: number, spec: ContractSpec, atr: number | null): PositionToolLevels {
  const g = ghostLevels(side, mark, spec, atr)
  return { side, entry: roundToTick(mark, spec.tickSize), sl: g.sl, tp: g.tp }
}

// Moves one handle. The price snaps to the tick grid, then is held where the
// tool stays a coherent trade: the stop strictly on the loss side of the entry,
// the target on the profit side, and the entry between them -- a tick apart at
// the closest. A Long tool never turns into a short by dragging; use the Short
// tool for that.
export function moveToolLevel(levels: PositionToolLevels, handle: ToolHandle, price: number, tickSize: number): PositionToolLevels {
  const p = roundToTick(price, tickSize)
  const sign = sideSign(levels.side)
  // Work in "profit direction" space so long and short share one rule.
  const dir = (v: number) => sign * v
  const undo = (v: number) => sign * v
  if (handle === 'entry') {
    const lo = dir(levels.sl) + tickSize
    const hi = dir(levels.tp) - tickSize
    return { ...levels, entry: roundToTick(undo(Math.min(hi, Math.max(lo, dir(p)))), tickSize) }
  }
  if (handle === 'sl') {
    return { ...levels, sl: roundToTick(undo(Math.min(dir(levels.entry) - tickSize, dir(p))), tickSize) }
  }
  return { ...levels, tp: roundToTick(undo(Math.max(dir(levels.entry) + tickSize, dir(p))), tickSize) }
}

// What sizes the tool's labels: the risk budget the order dialog will open with
// (the session's configured risk) and the position cap. Both optional.
export interface ToolSizing {
  riskUsd: number | null
  cap: number | null
}

export interface ToolReadout {
  slTicks: number
  tpTicks: number
  slPercent: number
  tpPercent: number
  rewardRisk: number | null
  contracts: number | null
  // $ lost at the stop / won at the target for `contracts` (gross of commission,
  // like the on-chart level labels). null until a size can be derived.
  riskUsd: number | null
  rewardUsd: number | null
}

export function toolReadout(levels: PositionToolLevels, spec: ContractSpec, sizing: ToolSizing): ToolReadout {
  const slDistance = Math.abs(levels.entry - levels.sl)
  const tpDistance = Math.abs(levels.tp - levels.entry)
  const sized = sizing.riskUsd !== null ? sizeFromRisk(sizing.riskUsd, levels.entry, levels.sl, spec, sizing.cap) : null
  const contracts = sized?.contracts ?? null
  return {
    slTicks: Math.round(slDistance / spec.tickSize),
    tpTicks: Math.round(tpDistance / spec.tickSize),
    slPercent: levels.entry !== 0 ? (slDistance / levels.entry) * 100 : 0,
    tpPercent: levels.entry !== 0 ? (tpDistance / levels.entry) * 100 : 0,
    rewardRisk: slDistance > 0 ? tpDistance / slDistance : null,
    contracts,
    riskUsd: contracts !== null ? Math.round(slDistance * spec.pointValue * contracts * 100) / 100 : null,
    rewardUsd: contracts !== null ? Math.round(tpDistance * spec.pointValue * contracts * 100) / 100 : null,
  }
}

export interface ToolLabel {
  // The descriptive part, in the primary text colour.
  text: string
  // The $ amount, coloured by what it is (a loss / a gain) -- the number only.
  amount: string | null
  tone: 'positive' | 'negative' | 'neutral'
}

export interface ToolLabels {
  target: ToolLabel
  stop: ToolLabel
  // The R:R pill on the entry line.
  center: ToolLabel
}

const pct = (v: number) => `${v.toFixed(2)}%`

// "Target 20,148.75 · 393 ticks (0.49%)" + "+$1,440.58", "Stop ... " + "-$750.00",
// and "R:R 1.76 · 4 ct" on the entry (structure of reference R2).
export function toolLabels(levels: PositionToolLevels, spec: ContractSpec, sizing: ToolSizing, instrument: string): ToolLabels {
  const r = toolReadout(levels, spec, sizing)
  return {
    target: {
      text: `Target ${fmtPrice(levels.tp, instrument)} · ${r.tpTicks.toLocaleString()} ticks (${pct(r.tpPercent)})`,
      amount: r.rewardUsd !== null ? `+${fmtUsd(r.rewardUsd)}` : null,
      tone: 'positive',
    },
    stop: {
      text: `Stop ${fmtPrice(levels.sl, instrument)} · ${r.slTicks.toLocaleString()} ticks (${pct(r.slPercent)})`,
      amount: r.riskUsd !== null ? `-${fmtUsd(r.riskUsd)}` : null,
      tone: 'negative',
    },
    center: {
      text: `${levels.side === 'long' ? 'Long' : 'Short'} · R:R ${r.rewardRisk !== null ? r.rewardRisk.toFixed(2) : '–'}${r.contracts !== null ? ` · ${r.contracts} ct` : ''}`,
      amount: null,
      tone: 'neutral',
    },
  }
}
