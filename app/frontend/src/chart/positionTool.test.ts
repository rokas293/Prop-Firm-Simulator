import { describe, expect, it } from 'vitest'
import { defaultToolLevels, moveToolLevel, toolLabels, toolReadout } from './positionTool'
import type { PositionToolLevels } from './orderTicket'
import { CONTRACT_SPECS } from './simBroker'
import { fmtUsd } from '../format'

const MNQ = CONTRACT_SPECS.MNQ
const TICK = MNQ.tickSize
const MARK = 20050.25

const LONG: PositionToolLevels = { side: 'long', entry: MARK, sl: MARK - 10, tp: MARK + 20 }
const SHORT: PositionToolLevels = { side: 'short', entry: MARK, sl: MARK + 10, tp: MARK - 20 }

describe('defaultToolLevels -- the tool starts at the current price', () => {
  it('a long: entry at the market, the stop one ATR below, the target at 2R', () => {
    expect(defaultToolLevels('long', MARK, MNQ, 10)).toEqual({ side: 'long', entry: MARK, sl: MARK - 10, tp: MARK + 20 })
  })

  it('a short mirrors it', () => {
    expect(defaultToolLevels('short', MARK, MNQ, 10)).toEqual({ side: 'short', entry: MARK, sl: MARK + 10, tp: MARK - 20 })
  })

  it('snaps the entry to the tick grid and never starts closer than the minimum distance', () => {
    const l = defaultToolLevels('long', 20050.3, MNQ, 0.5)
    expect(l.entry).toBe(20050.25)
    // ATR 0.5 is below the 8-tick floor (2 points).
    expect(l.entry - l.sl).toBeCloseTo(2, 6)
  })

  it('with no ATR yet uses the fallback distance', () => {
    expect(defaultToolLevels('long', MARK, MNQ, null).sl).toBe(MARK - 10)
  })
})

describe('moveToolLevel -- handles keep the tool a coherent trade', () => {
  it('moves a handle to the dragged price, snapped to the tick', () => {
    expect(moveToolLevel(LONG, 'sl', MARK - 20.1, TICK).sl).toBe(MARK - 20)
    expect(moveToolLevel(LONG, 'tp', MARK + 30.1, TICK).tp).toBe(MARK + 30)
    expect(moveToolLevel(LONG, 'entry', MARK - 4.9, TICK).entry).toBe(MARK - 5)
  })

  it('a long stop cannot cross to or past the entry; it stops a tick short', () => {
    expect(moveToolLevel(LONG, 'sl', MARK + 50, TICK).sl).toBe(MARK - TICK)
    expect(moveToolLevel(LONG, 'sl', MARK, TICK).sl).toBe(MARK - TICK)
  })

  it('a long target cannot cross to or past the entry either', () => {
    expect(moveToolLevel(LONG, 'tp', MARK - 50, TICK).tp).toBe(MARK + TICK)
  })

  it('the entry stays strictly between the stop and the target', () => {
    expect(moveToolLevel(LONG, 'entry', MARK + 500, TICK).entry).toBe(LONG.tp - TICK)
    expect(moveToolLevel(LONG, 'entry', MARK - 500, TICK).entry).toBe(LONG.sl + TICK)
  })

  it('a short is the mirror image', () => {
    expect(moveToolLevel(SHORT, 'sl', MARK - 50, TICK).sl).toBe(MARK + TICK)
    expect(moveToolLevel(SHORT, 'tp', MARK + 50, TICK).tp).toBe(MARK - TICK)
    expect(moveToolLevel(SHORT, 'entry', MARK - 500, TICK).entry).toBe(SHORT.tp + TICK)
    expect(moveToolLevel(SHORT, 'entry', MARK + 500, TICK).entry).toBe(SHORT.sl - TICK)
    expect(moveToolLevel(SHORT, 'sl', MARK + 30, TICK).sl).toBe(MARK + 30)
  })

  it('the other two levels never move', () => {
    const next = moveToolLevel(LONG, 'sl', MARK - 25, TICK)
    expect(next.entry).toBe(LONG.entry)
    expect(next.tp).toBe(LONG.tp)
    expect(next.side).toBe('long')
  })

  it('never turns a long into a short, however far a handle is dragged', () => {
    for (const handle of ['entry', 'sl', 'tp'] as const) {
      for (const price of [MARK - 1000, MARK - 1, MARK, MARK + 1, MARK + 1000]) {
        const l = moveToolLevel(LONG, handle, price, TICK)
        expect(l.sl).toBeLessThan(l.entry)
        expect(l.entry).toBeLessThan(l.tp)
        const s = moveToolLevel(SHORT, handle, price, TICK)
        expect(s.tp).toBeLessThan(s.entry)
        expect(s.entry).toBeLessThan(s.sl)
      }
    }
  })
})

describe('toolReadout -- the live R:R, $ risk and $ reward', () => {
  it('sizes against the risk budget and reports ticks, percent, R:R and dollars', () => {
    // 10pt stop = $20 a contract; $1,000 -> 50 contracts; 20pt target.
    const r = toolReadout(LONG, MNQ, { riskUsd: 1000, cap: null })
    expect(r.slTicks).toBe(40)
    expect(r.tpTicks).toBe(80)
    expect(r.slPercent).toBeCloseTo((10 / MARK) * 100, 6)
    expect(r.tpPercent).toBeCloseTo((20 / MARK) * 100, 6)
    expect(r.rewardRisk).toBe(2)
    expect(r.contracts).toBe(50)
    expect(r.riskUsd).toBe(1000)
    expect(r.rewardUsd).toBe(2000)
  })

  it('rounds the size down, so the dollars are for the whole contracts', () => {
    // $500 / $30 (15pt stop) = 16.67 -> 16.
    const r = toolReadout({ side: 'long', entry: MARK, sl: MARK - 15, tp: MARK + 30 }, MNQ, { riskUsd: 500, cap: null })
    expect(r.contracts).toBe(16)
    expect(r.riskUsd).toBe(480)
    expect(r.rewardUsd).toBe(960)
  })

  it('respects the position cap', () => {
    const r = toolReadout(LONG, MNQ, { riskUsd: 1000, cap: 5 })
    expect(r.contracts).toBe(5)
    expect(r.riskUsd).toBe(100)
    expect(r.rewardUsd).toBe(200)
  })

  it('with no risk budget it still reports the geometry', () => {
    const r = toolReadout(LONG, MNQ, { riskUsd: null, cap: null })
    expect(r.contracts).toBeNull()
    expect(r.riskUsd).toBeNull()
    expect(r.rewardUsd).toBeNull()
    expect(r.rewardRisk).toBe(2)
  })

  it('a short reads the same distances', () => {
    const r = toolReadout(SHORT, MNQ, { riskUsd: 1000, cap: null })
    expect(r.slTicks).toBe(40)
    expect(r.rewardRisk).toBe(2)
    expect(r.riskUsd).toBe(1000)
  })

  it('live: moving the stop changes the size, the risk and R:R', () => {
    const wide = moveToolLevel(LONG, 'sl', MARK - 20, TICK) // 20pt stop = $40 a contract
    const r = toolReadout(wide, MNQ, { riskUsd: 1000, cap: null })
    expect(r.contracts).toBe(25)
    expect(r.rewardRisk).toBe(1)
  })
})

describe('toolLabels', () => {
  it('writes the target, stop and R:R labels with signed dollar amounts', () => {
    const l = toolLabels(LONG, MNQ, { riskUsd: 1000, cap: null }, 'MNQ')
    expect(l.target.text).toContain('Target')
    expect(l.target.text).toContain('80 ticks')
    expect(l.target.amount).toBe(`+${fmtUsd(2000)}`)
    expect(l.target.tone).toBe('positive')
    expect(l.stop.text).toContain('Stop')
    expect(l.stop.text).toContain('40 ticks')
    expect(l.stop.amount).toBe(`-${fmtUsd(1000)}`)
    expect(l.stop.tone).toBe('negative')
    expect(l.center.text).toBe('Long · R:R 2.00 · 50 ct')
  })

  it('the short tool says Short', () => {
    expect(toolLabels(SHORT, MNQ, { riskUsd: 1000, cap: null }, 'MNQ').center.text).toContain('Short · R:R 2.00')
  })

  it('without a risk budget the amounts and the contract count are left off', () => {
    const l = toolLabels(LONG, MNQ, { riskUsd: null, cap: null }, 'MNQ')
    expect(l.target.amount).toBeNull()
    expect(l.stop.amount).toBeNull()
    expect(l.center.text).toBe('Long · R:R 2.00')
  })
})
