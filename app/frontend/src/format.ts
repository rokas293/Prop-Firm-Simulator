// Shared display-formatting helpers -- pure string formatting of
// already-computed numbers, no financial math (VIZ_SPEC section 0). Used by
// DashboardPanel and CompassPanel (POLISH_ROADMAP Phase P5) so a $ or R
// value always reads identically wherever it's shown.
import { findInstrument, pricePrecisionFromTick } from './chart/kl/instruments'

// Negative money is "-$1,898.75" (sign before the currency symbol), never
// "$-1,898.75". The sign is taken off first so toLocaleString never has a
// chance to place it, and a value that rounds to zero ("-0.001") prints as
// "$0.00", not "-$0.00".
function money(v: number, digits: number): string {
  const text = Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })
  const rounded = Number(Math.abs(v).toFixed(digits))
  return `${v < 0 && rounded !== 0 ? '-' : ''}$${text}`
}

export function fmtUsd(v: number | null | undefined): string {
  if (v === null || v === undefined) return '-'
  return money(v, 2)
}

// Whole-dollar variant for axis ticks and compact labels.
export function fmtUsdWhole(v: number | null | undefined): string {
  if (v === null || v === undefined) return '-'
  return money(v, 0)
}

export function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined) return '-'
  return `${(v * 100).toFixed(1)}%`
}

export function fmtR(v: number | null | undefined): string {
  if (v === null || v === undefined) return '-'
  return `${v.toFixed(2)}R`
}

// Price levels need per-instrument decimal precision (CLAUDE.md section 2's
// contract-spec table: MES/MNQ trade in 0.25pt ticks -> 2dp, ZN in 1/64pt
// ticks -> more digits to render exactly) -- reuses the KL chart engine's
// own tick-precision derivation (instruments.ts) rather than hardcoding
// ".toFixed(2)" everywhere a price is displayed (DESIGN_AUDIT.md T1/B1: the
// only tables that showed prices were also the ones flagged for numeric
// formatting). Falls back to 2dp for an unrecognized symbol -- display-only,
// never throws.
export function fmtPrice(v: number | null | undefined, instrument: string): string {
  if (v === null || v === undefined) return '-'
  const spec = findInstrument(instrument)
  const digits = spec ? pricePrecisionFromTick(spec.minmov, spec.pricescale) : 2
  return v.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

// Point distances (MAE/MFE, SL/TP) aren't instrument-tick-quantized the way
// price levels are (CLAUDE.md section 8: "price distances in points"), so a
// flat 2dp with thousands separators is enough -- matches R-multiple's own
// 2dp convention.
export function fmtPoints(v: number | null | undefined): string {
  if (v === null || v === undefined) return '-'
  return v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
