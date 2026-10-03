// The Compass "score" (POLISH_ROADMAP Phase P5): "a simple, transparent
// score... define the formula in the UI... explainable, not a black box."
// Four equally-weighted 0-100 components, each built from either an
// already-server-computed aggregate (StatsResponse.overall) or a
// descriptive grouping of already-tagged trade fields (trading_day,
// pnl_usd) -- no financial recomputation (VIZ_SPEC section 0). Every
// reference constant below is named, documented, and surfaced in each
// component's `detail` string so CompassPanel can render the exact formula
// next to the number, per the phase's explicit "not a black box" ask.
import type { GroupStats, TradeRecord } from '../api/types'
import { isClippedStop } from './regime'
import { fmtUsdWhole } from '../format'

export interface ScoreComponent {
  key: 'expectancy' | 'consistency' | 'drawdown' | 'stopEfficiency'
  label: string
  score: number // 0-100
  detail: string
}

export interface CompassScore {
  total: number // 0-100, the plain average of the four components below
  components: ScoreComponent[]
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x))
}

// "Excellent" per-trade expectancy reference point -- a round, clearly-
// labeled number, not a claim about what's actually achievable. Shown
// alongside the raw R value in the UI so the reference is never hidden.
export const EXPECTANCY_REFERENCE_R = 0.5

export function computeExpectancyComponent(overall: GroupStats): ScoreComponent {
  const r = overall.expectancy_r ?? 0
  const score = Math.round(100 * clamp01(r / EXPECTANCY_REFERENCE_R))
  return {
    key: 'expectancy',
    label: 'Expectancy',
    score,
    detail: `${r.toFixed(2)}R per trade, scored against a ${EXPECTANCY_REFERENCE_R}R reference (100 = ${EXPECTANCY_REFERENCE_R}R or better)`,
  }
}

// Topstep's own consistency rule (CLAUDE.md section 3): the single best
// trading day must be <= 50% of total profit when the target is hit. This
// component estimates the same ratio continuously across the whole scoped
// trade set (not just at the moment the target was reached, which is what
// StatsResponse.result.consistency_passed checks) -- so it's a related but
// distinct, clearly-labeled read, not a restatement of the engine's pass/fail.
export const CONSISTENCY_FAIL_SHARE = 0.5

export function computeConsistencyComponent(trades: TradeRecord[]): ScoreComponent {
  const byDay = new Map<string, number>()
  for (const t of trades) {
    const day = t.trading_day ?? 'unknown'
    byDay.set(day, (byDay.get(day) ?? 0) + t.pnl_usd)
  }
  const totalPnl = [...byDay.values()].reduce((a, b) => a + b, 0)
  const bestDayPnl = byDay.size > 0 ? Math.max(...byDay.values()) : 0
  const bestDayShare = totalPnl > 0 ? bestDayPnl / totalPnl : 0
  const score = Math.round(100 * clamp01(1 - bestDayShare / CONSISTENCY_FAIL_SHARE))
  return {
    key: 'consistency',
    label: 'Consistency',
    score,
    detail: `Best trading day is an estimated ${(bestDayShare * 100).toFixed(0)}% of total profit (Topstep's own rule fails a run at ${CONSISTENCY_FAIL_SHARE * 100}%)`,
  }
}

// Drawdown relative to profit generated, not to a specific account's MLL
// budget -- CLAUDE.md's prop rules are configurable per run, and the
// bundle doesn't expose the configured MLL size to the frontend, so this
// avoids silently assuming the $50k Combine's $2,000 default applies.
export const DRAWDOWN_TARGET_RATIO = 1.0

export function computeDrawdownComponent(overall: GroupStats): ScoreComponent {
  // max_drawdown_usd is peak-to-trough (cumulative PnL minus its running
  // max), so the engine reports it as <= 0 (propbt/reporting/run_bundle.py's
  // _kpis) -- magnitude is what matters here, both for the drawdown itself
  // and for net PnL (a net-losing run's "profit" is itself negative, and
  // the ratio of two magnitudes is still the right "how much was given
  // back relative to what was made or lost" read).
  const drawdownMagnitude = Math.abs(overall.max_drawdown_usd)
  const netPnlMagnitude = Math.max(Math.abs(overall.net_pnl_usd), 1)
  const ratio = drawdownMagnitude / netPnlMagnitude
  const score = Math.round(100 * clamp01(1 - ratio / DRAWDOWN_TARGET_RATIO))
  return {
    key: 'drawdown',
    label: 'Drawdown',
    score,
    detail: `Max drawdown ${fmtUsdWhole(drawdownMagnitude)} is ${(ratio * 100).toFixed(0)}% of net PnL magnitude (100 = 0%, 0 = ${DRAWDOWN_TARGET_RATIO * 100}%+)`,
  }
}

export function computeStopEfficiencyComponent(trades: TradeRecord[]): ScoreComponent {
  const losses = trades.filter((t) => t.pnl_usd <= 0)
  const clipped = losses.filter(isClippedStop)
  const share = losses.length > 0 ? clipped.length / losses.length : 0
  const score = Math.round(100 * clamp01(1 - share))
  return {
    key: 'stopEfficiency',
    label: 'Stop efficiency',
    score,
    detail:
      losses.length === 0
        ? 'No losing trades in this scope'
        : `${clipped.length} of ${losses.length} losses (${(share * 100).toFixed(0)}%) still reached the planned TP distance before reversing – stops may be clipping winners`,
  }
}

export function computeCompassScore(overall: GroupStats, trades: TradeRecord[]): CompassScore {
  const components = [
    computeExpectancyComponent(overall),
    computeConsistencyComponent(trades),
    computeDrawdownComponent(overall),
    computeStopEfficiencyComponent(trades),
  ]
  const total = Math.round(components.reduce((sum, c) => sum + c.score, 0) / components.length)
  return { total, components }
}
