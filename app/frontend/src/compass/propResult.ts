// FXR_SPEC.md phase F6: turns the engine's prop-rule verdict for a manual
// session (StatsResult, produced by propbt's PropRulesTracker server-side)
// into a short "what happened" read for the Dashboard. Pure wording over
// already-computed fields -- nothing here decides pass/fail or recomputes a
// balance (VIZ_SPEC section 0: the frontend renders, the engine decides).
import type { StatsResult } from '../api/types'
import { fmtUsd } from '../format'

export interface PropNarrative {
  status: 'passed' | 'failed' | 'incomplete'
  headline: string
  // One sentence per line, already formatted.
  details: string[]
}

export function fmtUtcMinute(unixSeconds: number): string {
  return `${new Date(unixSeconds * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

const FAIL_REASON_TEXT: Record<string, string> = {
  mll_breach: 'trailing max loss limit breached',
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

// The quiet banner a session workspace shows once its Combine has resolved
// (trading stays allowed -- the sim never blocks you; the result just stops
// counting). null while the Combine is still open.
export function combineBanner(r: StatsResult | null | undefined): string | null {
  if (!r || r.status === 'incomplete') return null
  const verb = r.status === 'passed' ? 'passed' : 'failed'
  const where = r.resolved_trade_id != null ? ` on trade #${r.resolved_trade_id}` : ''
  return `Combine ${verb}${where} — later trades don't count toward the result.`
}

export function describePropResult(r: StatsResult, totalTrades: number): PropNarrative {
  const status: PropNarrative['status'] = r.status === 'passed' ? 'passed' : r.status === 'failed' ? 'failed' : 'incomplete'
  const details: string[] = []

  const where =
    r.resolved_trade_id != null && r.trades_to_result != null && r.resolved_time != null
      ? `trade #${r.resolved_trade_id} (${r.trades_to_result} of ${totalTrades}) at ${fmtUtcMinute(r.resolved_time)}`
      : null

  let headline: string
  if (status === 'failed') {
    const reason = r.fail_reason ? (FAIL_REASON_TEXT[r.fail_reason] ?? r.fail_reason) : 'rule breached'
    // The verdict word (FAILED) is the hero Result tile's job; this says how.
    headline = reason.charAt(0).toUpperCase() + reason.slice(1)
    if (where && r.equity_at_result != null && r.mll_floor_at_result != null) {
      details.push(
        `On ${where}, equity fell to ${fmtUsd(r.equity_at_result)}, at or below the ${fmtUsd(r.mll_floor_at_result)} floor.`,
      )
    }
    if (r.trades_to_result != null && totalTrades > r.trades_to_result) {
      details.push(`${plural(totalTrades - r.trades_to_result, 'later trade')} journaled after the Combine ended.`)
    }
  } else if (status === 'passed') {
    headline = 'Profit target reached, consistency rule satisfied'
    if (where) details.push(`Reached on ${where}; balance ${fmtUsd(r.final_balance)}.`)
    if (r.trades_to_result != null && totalTrades > r.trades_to_result) {
      details.push(`${plural(totalTrades - r.trades_to_result, 'later trade')} journaled after the pass.`)
    }
  } else if (r.target_hit && r.consistency_passed === false) {
    headline = 'Target reached, consistency rule not met'
    details.push(
      `The best trading day is more than half of total profit; further profit on other days is needed. Balance ${fmtUsd(r.final_balance)}.`,
    )
  } else {
    headline = 'Profit target not yet reached'
    details.push(`Balance ${fmtUsd(r.final_balance)} over ${plural(r.trading_days, 'trading day')}.`)
  }

  if (r.daily_loss_lock_days != null && r.daily_loss_lock_days > 0) {
    details.push(`The daily loss limit was hit on ${plural(r.daily_loss_lock_days, 'trading day')}.`)
  }
  return { status, headline, details }
}
