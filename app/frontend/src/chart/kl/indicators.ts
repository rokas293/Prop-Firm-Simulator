// Backend-sourced indicators for the KLineCharts engine (PART_A_REVISED_
// klinecharts.md Phase A3). VWAP/EMA20/EMA50/ATR14 are deliberately NOT
// klinecharts' own built-in EMA/ATR formulas -- verified against the
// v10.0.3 source that the built-in EMA seeds with a simple average of the
// first N closes then recurses (2*close + (p-1)*prevEma)/(p+1), a specific
// convention that isn't guaranteed to match propbt's own EMA. VIZ_SPEC §0/
// §8 are explicit that the frontend does zero financial math and that
// session-anchored values especially must come from the engine -- these
// four are registered as pass-through custom indicators that just reshape
// already-fetched /api/indicators points into klinecharts' calc-pipeline
// shape, the same "no recomputation" contract PriceChart.tsx already
// honors for the lightweight-charts engine. Only Volume (Phase A3's other
// ask) is a genuine klinecharts built-in ('VOL') -- it just visualizes
// each bar's own volume field, so there's no divergence risk.
import { registerIndicator } from 'klinecharts'
import type { IndicatorPoint } from '../../api/types'
import { CHART_LINE_COLORS, resolveBase, useThemeStore } from '../../state/themeStore'

export const KL_VWAP = 'klVwap'
export const KL_EMA20 = 'klEma20'
export const KL_EMA50 = 'klEma50'
export const KL_ATR14 = 'klAtr14'

interface IndicatorContext {
  vwap: IndicatorPoint[]
  ema20: IndicatorPoint[]
  ema50: IndicatorPoint[]
  atr14: IndicatorPoint[]
}

let context: IndicatorContext = { vwap: [], ema20: [], ema50: [], atr14: [] }

// Set once per bars load / indicator refetch (ChartKL), read inside each
// custom indicator's `calc` below. Module-level because registerIndicator
// runs once at import time, outside any component's props/state -- same
// pattern as drawingOverlays.ts's measureBars context.
export function setIndicatorContext(next: IndicatorContext): void {
  context = next
}

// Most-recent-known-value-at-or-before lookup: indicator series are sparse
// relative to bars (warm-up periods, session-anchored resets), so an
// exact-timestamp match per bar isn't guaranteed -- same concept as
// PriceChart.tsx's findValueAt. Single pass since both dataList and points
// are sorted ascending by time.
export function valuesForBarsMs(points: IndicatorPoint[], barTimesMs: number[]): Array<number | undefined> {
  const out: Array<number | undefined> = new Array(barTimesMs.length)
  let i = 0
  let last: number | undefined
  for (let b = 0; b < barTimesMs.length; b++) {
    const barTimeSec = barTimesMs[b] / 1000
    while (i < points.length && points[i].time <= barTimeSec) {
      last = points[i].value
      i++
    }
    out[b] = last
  }
  return out
}

function registerPassthroughIndicator(
  name: string,
  shortName: string,
  color: string,
  series: 'price' | 'normal',
  getPoints: (ctx: IndicatorContext) => IndicatorPoint[],
): void {
  registerIndicator<{ value?: number }>({
    name,
    shortName,
    series,
    calcParams: [],
    precision: 2,
    figures: [{ key: 'value', title: `${shortName}: `, type: 'line', styles: () => ({ color }) }],
    calc: (dataList) => {
      const values = valuesForBarsMs(
        getPoints(context),
        dataList.map((d) => d.timestamp),
      )
      return values.map((value) => ({ value }))
    },
  })
}

// EMA20/EMA50 are fixed CATEGORICAL colors (Part C1 audit risk #3 -- "which
// line is this", not a tunable semantic), registered once and never
// restyled. VWAP (theme accent) and ATR14 (theme textMuted, which differs
// dark vs light) DO need to track live theme/mode changes -- read from the
// store directly (registration happens once at app start, outside any
// component) so the registration-time value is the user's actual current
// theme rather than a guessed placeholder; ChartKL.tsx's immediate
// chart.overrideIndicator() call keeps both correct on every later change.
let registered = false
export function ensureIndicatorsRegistered(): void {
  if (registered) return
  registered = true
  const { colors, mode } = useThemeStore.getState()
  registerPassthroughIndicator(KL_VWAP, 'VWAP', colors.accent, 'price', (c) => c.vwap)
  registerPassthroughIndicator(KL_EMA20, 'EMA20', CHART_LINE_COLORS.ema20, 'price', (c) => c.ema20)
  registerPassthroughIndicator(KL_EMA50, 'EMA50', CHART_LINE_COLORS.ema50, 'price', (c) => c.ema50)
  registerPassthroughIndicator(KL_ATR14, 'ATR14', resolveBase(mode).textMuted, 'normal', (c) => c.atr14)
}
