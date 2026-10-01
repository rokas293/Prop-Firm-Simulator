import { describe, expect, it } from 'vitest'
import type { MonteCarloResponse } from '../api/types'
import { actualRankBand, fanRows } from './monteCarlo'

const mc: MonteCarloResponse = {
  method: 'shuffle',
  n_trades: 2,
  n_sims: 100,
  seed: 0,
  drawdown_budget_usd: 2000,
  final_pnl_pct: { '5': 100, '25': 150, '50': 200, '75': 250, '95': 300 },
  max_drawdown_pct: { '5': 0, '25': 0, '50': 10, '75': 20, '95': 30 },
  prob_profit: 1,
  prob_drawdown_breach: 0,
  actual_final_pnl: 220,
  actual_max_drawdown: 10,
  fan: {
    '5': [0, -10, 100],
    '25': [0, 0, 150],
    '50': [0, 50, 200],
    '75': [0, 100, 250],
    '95': [0, 200, 300],
  },
  actual_path: [0, 80, 220],
}

describe('fanRows', () => {
  it('lines the percentile bands up with the realized path, one row per trade plus the start', () => {
    const rows = fanRows(mc)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toEqual({ trade: 0, band90: [0, 0], band50: [0, 0], median: 0, actual: 0 })
    expect(rows[2]).toEqual({ trade: 2, band90: [100, 300], band50: [150, 250], median: 200, actual: 220 })
  })
})

describe('actualRankBand', () => {
  it('places the realized terminal P&L on the percentile grid the server returned', () => {
    expect(actualRankBand(mc)).toBe('between the 50th and 75th percentile')
    expect(actualRankBand({ ...mc, actual_final_pnl: 50 })).toBe('below the 5th percentile')
    expect(actualRankBand({ ...mc, actual_final_pnl: 999 })).toBe('above the 95th percentile')
  })
})
