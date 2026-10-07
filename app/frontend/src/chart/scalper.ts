// FXR_V2_SPEC.md phase G4, section 3.4: the pure rules behind Scalper Mode --
// preset SL / TP / auto break-even distances that every Quick Buy/Sell and
// right-click order gets automatically while it is armed. Framework-free like
// orderEntry.ts and orderTicket.ts so each unit can be tested without a chart.
//
// The settings hold DISTANCES, never prices ("Values are distances, never
// prices"): a price would be stale the moment the market moves. A distance is
// turned into prices at the instant of entry, from the entry price itself --
// the fill price of a market order, or the order's own price for a limit/stop
// -- so no later bar is ever read (no look-ahead).
import type { ScalperConfig } from '../api/types'
import { roundToTick } from './orderEntry'
import { sideSign, type ContractSpec, type Side } from './simBroker'

export type ScalperSlUnit = 'ticks' | 'percent' | 'usd'
export type ScalperTpUnit = 'ticks' | 'percent' | 'r'
export type ScalperBeMode = 'r' | 'ticks'

export interface ScalperSettings {
  slOn: boolean
  slValue: number
  slUnit: ScalperSlUnit
  tpOn: boolean
  tpValue: number
  // 'r' = a multiple of the stop distance, so it needs the stop.
  tpUnit: ScalperTpUnit
  beOn: boolean
  // 'r' = the trade is up this many times its risk; 'ticks' = it is this far in profit.
  beMode: ScalperBeMode
  beValue: number
}

export const DEFAULT_SCALPER: ScalperSettings = {
  slOn: true,
  slValue: 40,
  slUnit: 'ticks',
  tpOn: true,
  tpValue: 2,
  tpUnit: 'r',
  beOn: false,
  beMode: 'r',
  beValue: 1,
}

export const SL_UNITS: ReadonlyArray<{ value: ScalperSlUnit; label: string }> = [
  { value: 'ticks', label: 'ticks' },
  { value: 'percent', label: '%' },
  { value: 'usd', label: '$' },
]
export const TP_UNITS: ReadonlyArray<{ value: ScalperTpUnit; label: string }> = [
  { value: 'ticks', label: 'ticks' },
  { value: 'percent', label: '%' },
  { value: 'r', label: 'R' },
]
export const BE_MODES: ReadonlyArray<{ value: ScalperBeMode; label: string }> = [
  { value: 'r', label: 'R' },
  { value: 'ticks', label: 'ticks' },
]

const positive = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0
const oneOf = <T extends string>(v: unknown, allowed: ReadonlyArray<{ value: T }>, fallback: T): T =>
  allowed.some((a) => a.value === v) ? (v as T) : fallback

// Makes any settings object coherent: bad numbers fall back to the defaults, an
// unknown unit to the default unit, and break-even -- which moves the stop -- is
// off without one. Used on every edit and on whatever comes out of storage.
// (A take profit in R is a multiple of the stop; with no stop it simply places
// no target, see `tpNeedsStop`. The chosen unit is never rewritten, so the
// user's "3 R" is still "3 R" when they switch the stop back on.)
export function normalizeScalper(input: Partial<ScalperSettings> | null | undefined): ScalperSettings {
  const s = { ...DEFAULT_SCALPER, ...(input ?? {}) }
  const slOn = s.slOn === true
  return {
    slOn,
    slValue: positive(s.slValue) ? s.slValue : DEFAULT_SCALPER.slValue,
    slUnit: oneOf(s.slUnit, SL_UNITS, DEFAULT_SCALPER.slUnit),
    tpOn: s.tpOn === true,
    tpValue: positive(s.tpValue) ? s.tpValue : DEFAULT_SCALPER.tpValue,
    tpUnit: oneOf(s.tpUnit, TP_UNITS, DEFAULT_SCALPER.tpUnit),
    beOn: s.beOn === true && slOn,
    beMode: oneOf(s.beMode, BE_MODES, DEFAULT_SCALPER.beMode),
    beValue: positive(s.beValue) ? s.beValue : DEFAULT_SCALPER.beValue,
  }
}

// The take profit is on, but in R with no stop to take a multiple of: no target
// will be placed until the stop is on or the unit changes.
export function tpNeedsStop(s: ScalperSettings): boolean {
  return s.tpOn && s.tpUnit === 'r' && !s.slOn
}

// One edit, re-normalized. Switching the stop off also switches break-even off;
// every value and unit the user had is kept.
export function editScalper(s: ScalperSettings, patch: Partial<ScalperSettings>): ScalperSettings {
  return normalizeScalper({ ...s, ...patch })
}

// The session file's form of the settings (and the armed state), and back.
export function toScalperConfig(armed: boolean, settings: ScalperSettings): ScalperConfig {
  const s = normalizeScalper(settings)
  return {
    armed,
    sl_on: s.slOn,
    sl_value: s.slValue,
    sl_unit: s.slUnit,
    tp_on: s.tpOn,
    tp_value: s.tpValue,
    tp_unit: s.tpUnit,
    be_on: s.beOn,
    be_mode: s.beMode,
    be_value: s.beValue,
  }
}

export function fromScalperConfig(c: ScalperConfig): { armed: boolean; settings: ScalperSettings } {
  return {
    armed: c.armed === true,
    settings: normalizeScalper({
      slOn: c.sl_on,
      slValue: c.sl_value,
      slUnit: c.sl_unit,
      tpOn: c.tp_on,
      tpValue: c.tp_value,
      tpUnit: c.tp_unit,
      beOn: c.be_on,
      beMode: c.be_mode,
      beValue: c.be_value,
    }),
  }
}

export interface ScalperBrackets {
  slPrice: number | null
  tpPrice: number | null
  slTicks: number | null
  tpTicks: number | null
  // The stop's real dollar risk at this size: what R is measured against for
  // this trade. null without a stop (the caller keeps the account's own risk).
  riskUsd: number | null
  autoBreakeven: boolean
  // The break-even trigger, resolved: a multiple of risk, or a price distance.
  // At most one is set; both null when break-even is off.
  breakevenR: number | null
  breakevenPoints: number | null
}

const cents = (usd: number) => Math.round(usd * 100) / 100

// The stop distance in ticks (at least one: a zero-width stop would fill at
// once), from a value in the chosen unit. `usd` is the whole position's loss, so
// the same $ buys a tighter stop on more contracts.
function slDistanceTicks(s: ScalperSettings, entry: number, contracts: number, spec: ContractSpec): number {
  const points =
    s.slUnit === 'ticks'
      ? s.slValue * spec.tickSize
      : s.slUnit === 'percent'
        ? (entry * s.slValue) / 100
        : s.slValue / (spec.pointValue * Math.max(1, contracts))
  return Math.max(1, Math.round(points / spec.tickSize))
}

function tpDistanceTicks(s: ScalperSettings, entry: number, slTicks: number | null, spec: ContractSpec): number | null {
  if (s.tpUnit === 'r') return slTicks === null ? null : Math.max(1, Math.round(slTicks * s.tpValue))
  const points = s.tpUnit === 'ticks' ? s.tpValue * spec.tickSize : (entry * s.tpValue) / 100
  return Math.max(1, Math.round(points / spec.tickSize))
}

// The brackets for one entry at `entry` (a stop sits on the loss side, a target
// on the profit side), snapped to the tick grid.
export function scalperBrackets(settings: ScalperSettings, side: Side, entry: number, contracts: number, spec: ContractSpec): ScalperBrackets {
  const s = normalizeScalper(settings)
  const sign = sideSign(side)
  const slTicks = s.slOn ? slDistanceTicks(s, entry, contracts, spec) : null
  const tpTicks = s.tpOn ? tpDistanceTicks(s, entry, slTicks, spec) : null
  const beOn = s.beOn && slTicks !== null
  return {
    slPrice: slTicks === null ? null : roundToTick(entry - sign * slTicks * spec.tickSize, spec.tickSize),
    tpPrice: tpTicks === null ? null : roundToTick(entry + sign * tpTicks * spec.tickSize, spec.tickSize),
    slTicks,
    tpTicks,
    riskUsd: slTicks === null ? null : cents(slTicks * spec.tickSize * spec.pointValue * contracts),
    autoBreakeven: beOn,
    breakevenR: beOn && s.beMode === 'r' ? s.beValue : null,
    breakevenPoints: beOn && s.beMode === 'ticks' ? s.beValue * spec.tickSize : null,
  }
}

// What the settings amount to at a given entry and size, for the popover's
// live line under the fields. Side-free: the distances are the same both ways.
export interface ScalperPreview {
  slTicks: number | null
  slUsd: number | null
  tpTicks: number | null
  tpUsd: number | null
  rewardRisk: number | null
  // Break-even is set to trigger at or beyond the take profit -- it could never
  // fire before the target fills.
  breakevenPastTarget: boolean
}

export function scalperPreview(settings: ScalperSettings, entry: number, contracts: number, spec: ContractSpec): ScalperPreview {
  const s = normalizeScalper(settings)
  const b = scalperBrackets(s, 'long', entry, contracts, spec)
  const perTick = spec.tickSize * spec.pointValue * contracts
  const slUsd = b.slTicks === null ? null : cents(b.slTicks * perTick)
  const tpUsd = b.tpTicks === null ? null : cents(b.tpTicks * perTick)
  let beTicks: number | null = null
  if (b.autoBreakeven && b.slTicks !== null) {
    beTicks = b.breakevenR !== null ? b.breakevenR * b.slTicks : (b.breakevenPoints ?? 0) / spec.tickSize
  }
  return {
    slTicks: b.slTicks,
    slUsd,
    tpTicks: b.tpTicks,
    tpUsd,
    rewardRisk: b.slTicks !== null && b.tpTicks !== null ? b.tpTicks / b.slTicks : null,
    breakevenPastTarget: beTicks !== null && b.tpTicks !== null && beTicks >= b.tpTicks,
  }
}

// The one place "armed or not" is decided for an entry: null when Scalper Mode
// is off, so the caller does exactly what it did before G4 (no brackets, the
// ghost lines). When armed, the brackets -- and the caller shows no ghosts.
export function entryBrackets(
  scalper: { armed: boolean; settings: ScalperSettings },
  side: Side,
  entry: number,
  contracts: number,
  spec: ContractSpec,
): ScalperBrackets | null {
  return scalper.armed ? scalperBrackets(scalper.settings, side, entry, contracts, spec) : null
}
