import { describe, expect, it } from 'vitest'
import type { TradeRecord } from '../api/types'
import type { ReplayTradeView } from './replay'
import {
  bracketOutcome,
  computeBracketBounds,
  findBracketAt,
  formatBracketTooltip,
  hitTestBracket,
  shouldShowLabel,
  shouldSimplify,
} from './tradeBracket'

function makeTrade(overrides: Partial<TradeRecord> = {}): TradeRecord {
  return {
    trade_id: 5,
    entry_time: 1626467460,
    exit_time: 1626468300,
    instrument: 'MNQ',
    side: 'long',
    leg: 'mean_reversion',
    session: 'ny',
    trading_day: '2021-07-16',
    size_contracts: 1,
    entry_price: 14661.75,
    exit_price: 14669.75,
    sl_price: 14653.75,
    tp_price: 14669.75,
    sl_points: 8.0,
    tp_points: 8.0,
    rr_planned: 1.0,
    exit_type: 'tp',
    pnl_usd: 14.7,
    r_multiple: 0.91875,
    commission_usd: 1.3,
    mae_points: 2.75,
    mfe_points: 9.5,
    mae_r: 0.34375,
    mfe_r: 1.1875,
    bars_held: 15,
    ...overrides,
  }
}

function closedView(trade: TradeRecord): ReplayTradeView {
  return { trade, showExit: true, openSpanEnd: trade.exit_time }
}

describe('bracketOutcome', () => {
  it('is win for a positive-pnl closed trade', () => {
    expect(bracketOutcome(closedView(makeTrade({ pnl_usd: 14.7 })))).toBe('win')
  })

  it('is loss for a zero-or-negative-pnl closed trade', () => {
    expect(bracketOutcome(closedView(makeTrade({ pnl_usd: -10 })))).toBe('loss')
    expect(bracketOutcome(closedView(makeTrade({ pnl_usd: 0 })))).toBe('loss')
  })

  it('is open when the exit has not happened yet as of the replay cursor', () => {
    const view: ReplayTradeView = { trade: makeTrade(), showExit: false, openSpanEnd: 1626467700 }
    expect(bracketOutcome(view)).toBe('open')
  })
})

describe('computeBracketBounds', () => {
  it('sits exactly on the trade entry/exit prices and times (real trade #5)', () => {
    const trade = makeTrade()
    const bounds = computeBracketBounds(closedView(trade))
    expect(bounds.timeFrom).toBe(trade.entry_time)
    expect(bounds.timeTo).toBe(trade.exit_time)
    // entry 14661.75, exit/tp 14669.75, sl 14653.75 -> lo=sl, hi=exit(==tp)
    expect(bounds.priceLo).toBe(14653.75)
    expect(bounds.priceHi).toBe(14669.75)
  })

  it('excludes the exit price from the price range while still open', () => {
    const trade = makeTrade({ entry_price: 100, sl_price: 90, tp_price: 120, exit_price: 999 })
    const view: ReplayTradeView = { trade, showExit: false, openSpanEnd: 500 }
    const bounds = computeBracketBounds(view)
    expect(bounds.priceLo).toBe(90)
    expect(bounds.priceHi).toBe(120)
    expect(bounds.timeTo).toBe(500)
  })

  it('falls back to just the entry price when sl/tp are null', () => {
    const trade = makeTrade({ sl_price: null, tp_price: null, entry_price: 100, exit_price: 90 })
    const bounds = computeBracketBounds(closedView(trade))
    expect(bounds.priceLo).toBe(90)
    expect(bounds.priceHi).toBe(100)
  })
})

describe('hitTestBracket', () => {
  const bounds = computeBracketBounds(closedView(makeTrade()))

  it('matches a point inside the bracket', () => {
    expect(hitTestBracket(bounds, 1626467700, 14660)).toBe(true)
  })

  it('rejects a point outside the time range', () => {
    expect(hitTestBracket(bounds, 1626467000, 14660)).toBe(false)
  })

  it('rejects a point outside the price range', () => {
    expect(hitTestBracket(bounds, 1626467700, 14700)).toBe(false)
  })

  it('is inclusive at the exact edges', () => {
    expect(hitTestBracket(bounds, bounds.timeFrom, bounds.priceLo)).toBe(true)
    expect(hitTestBracket(bounds, bounds.timeTo, bounds.priceHi)).toBe(true)
  })
})

describe('findBracketAt', () => {
  it('returns null when nothing matches', () => {
    const views = [closedView(makeTrade())]
    expect(findBracketAt(views, 0, 0)).toBeNull()
  })

  it('finds the matching trade', () => {
    const views = [closedView(makeTrade({ trade_id: 5 }))]
    expect(findBracketAt(views, 1626467700, 14660)?.trade_id).toBe(5)
  })

  it('prefers the later trade when brackets overlap', () => {
    const a = makeTrade({ trade_id: 1, entry_time: 100, exit_time: 200, entry_price: 100, exit_price: 110 })
    const b = makeTrade({ trade_id: 2, entry_time: 100, exit_time: 200, entry_price: 100, exit_price: 110 })
    expect(findBracketAt([closedView(a), closedView(b)], 150, 105)?.trade_id).toBe(2)
  })
})

describe('shouldSimplify', () => {
  it('always simplifies in markers mode', () => {
    expect(shouldSimplify(1000, 'markers')).toBe(true)
  })

  it('never simplifies in full mode', () => {
    expect(shouldSimplify(1, 'full')).toBe(false)
  })

  it('simplifies narrow brackets and keeps wide ones in auto mode', () => {
    expect(shouldSimplify(5, 'auto')).toBe(true)
    expect(shouldSimplify(500, 'auto')).toBe(false)
  })
})

describe('shouldShowLabel', () => {
  it('hides the label below the width threshold', () => {
    expect(shouldShowLabel(10)).toBe(false)
    expect(shouldShowLabel(200)).toBe(true)
  })
})

describe('formatBracketTooltip', () => {
  it('includes leg, session, side, entry/exit, exit_type, MAE/MFE, and bars held', () => {
    const text = formatBracketTooltip(makeTrade())
    expect(text).toContain('#5')
    expect(text).toContain('long')
    expect(text).toContain('mean_reversion')
    expect(text).toContain('ny')
    expect(text).toContain('14661.75')
    expect(text).toContain('14669.75')
    expect(text).toContain('tp')
    expect(text).toContain('MAE 2.75 pts')
    expect(text).toContain('MFE 9.50 pts')
    expect(text).toContain('Bars held: 15')
    expect(text).toContain('+$14.70')
    expect(text).toContain('+0.92R')
  })

  it('formats a loss without a leading plus sign on pnl', () => {
    const text = formatBracketTooltip(makeTrade({ pnl_usd: -12.5, r_multiple: -1.02 }))
    expect(text).toContain('PnL -$12.50')
    expect(text).toContain('(-1.02R)')
  })
})
