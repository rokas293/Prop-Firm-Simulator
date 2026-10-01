import { describe, expect, it } from 'vitest'
import type { StatsResult } from '../api/types'
import { combineBanner, describePropResult } from './propResult'

const base: StatsResult = {
  status: 'incomplete',
  fail_reason: null,
  target_hit: false,
  consistency_passed: null,
  final_balance: 50400,
  trading_days: 1,
}

describe('describePropResult', () => {
  it('explains an MLL failure with the trade, time, equity and floor', () => {
    const n = describePropResult(
      {
        ...base,
        status: 'failed',
        fail_reason: 'mll_breach',
        final_balance: 50000,
        resolved_trade_id: 1,
        trades_to_result: 1,
        resolved_time: Date.UTC(2025, 2, 11, 14, 0) / 1000,
        equity_at_result: 47950,
        mll_floor_at_result: 48000,
      },
      2,
    )
    expect(n.status).toBe('failed')
    expect(n.headline).toBe('Trailing max loss limit breached')
    expect(n.details[0]).toBe(
      'On trade #1 (1 of 2) at 2025-03-11 14:00 UTC, equity fell to $47,950.00, at or below the $48,000.00 floor.',
    )
    expect(n.details[1]).toBe('1 later trade journaled after the Combine ended.')
  })

  it('reports a pass and any trades taken after it', () => {
    const n = describePropResult(
      {
        ...base,
        status: 'passed',
        target_hit: true,
        consistency_passed: true,
        final_balance: 53000,
        resolved_trade_id: 3,
        trades_to_result: 3,
        resolved_time: Date.UTC(2025, 2, 13, 14, 30) / 1000,
      },
      5,
    )
    expect(n.headline).toBe('Profit target reached, consistency rule satisfied')
    expect(n.details).toContain('Reached on trade #3 (3 of 5) at 2025-03-13 14:30 UTC; balance $53,000.00.')
    expect(n.details).toContain('2 later trades journaled after the pass.')
  })

  it('distinguishes "target hit but consistency not met" from "target not reached"', () => {
    const consistency = describePropResult({ ...base, target_hit: true, consistency_passed: false, final_balance: 53500 }, 4)
    expect(consistency.headline).toBe('Target reached, consistency rule not met')
    const plain = describePropResult(base, 3)
    expect(plain.headline).toBe('Profit target not yet reached')
    expect(plain.details[0]).toBe('Balance $50,400.00 over 1 trading day.')
  })

  it('mentions daily-loss-limit days only when there were some', () => {
    expect(describePropResult({ ...base, daily_loss_lock_days: 0 }, 1).details.join(' ')).not.toContain('daily loss')
    expect(describePropResult({ ...base, daily_loss_lock_days: 2 }, 1).details).toContain(
      'The daily loss limit was hit on 2 trading days.',
    )
  })
})

describe('combineBanner', () => {
  it('is silent while the Combine is open (or unknown)', () => {
    expect(combineBanner(base)).toBeNull()
    expect(combineBanner(null)).toBeNull()
  })

  it('says which trade resolved it, and that later trades do not count', () => {
    expect(combineBanner({ ...base, status: 'failed', fail_reason: 'mll_breach', resolved_trade_id: 15 })).toBe(
      "Combine failed on trade #15 — later trades don't count toward the result.",
    )
    expect(combineBanner({ ...base, status: 'passed', resolved_trade_id: 3 })).toBe(
      "Combine passed on trade #3 — later trades don't count toward the result.",
    )
  })
})
