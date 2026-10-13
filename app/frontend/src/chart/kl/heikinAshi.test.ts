// FXR_V2_SPEC.md section 7 (G9): Heikin Ashi is display only. These pin the maths, that the
// forming candle only ever uses revealed data, and that switching to it changes no fill.
import { describe, expect, it } from 'vitest'
import type { Bar } from '../../api/types'
import { CONTRACT_SPECS, advanceReplay, type OpenPosition, type WorkingOrder } from '../simBroker'
import { candleTypeStyles } from './ChartKL'
import { heikinAshiSeries } from './heikinAshi'

const T0 = 1_741_564_800
const bar = (i: number, open: number, high: number, low: number, close: number): Bar => ({
  time: T0 + i * 60, open, high, low, close, volume: 10,
})

describe('heikinAshiSeries', () => {
  const bars = [bar(0, 100, 110, 96, 108), bar(1, 108, 120, 105, 118), bar(2, 118, 119, 100, 102)]

  it('matches the definition, worked out by hand', () => {
    const [a, b, c] = heikinAshiSeries(bars)
    // 1st: close = (100+110+96+108)/4 = 103.5, open = (100+108)/2 = 104
    expect(a).toEqual({ haOpen: 104, haClose: 103.5, haHigh: 110, haLow: 96 })
    // 2nd: close = (108+120+105+118)/4 = 112.75, open = (104+103.5)/2 = 103.75
    expect(b.haClose).toBeCloseTo(112.75)
    expect(b.haOpen).toBeCloseTo(103.75)
    expect(b.haHigh).toBe(120)
    expect(b.haLow).toBeCloseTo(103.75) // below the real low 105: the HA open
    // 3rd: close = (118+119+100+102)/4 = 109.75, open = (103.75+112.75)/2 = 108.25
    expect(c.haClose).toBeCloseTo(109.75)
    expect(c.haOpen).toBeCloseTo(108.25)
  })

  it('the forming candle uses only revealed data: a prefix of the series is the series of the prefix', () => {
    const rng = (() => { let s = 7; return () => ((s = (s * 48271) % 2147483647) / 2147483647) })()
    const feed: Bar[] = []
    let p = 20000
    for (let i = 0; i < 60; i++) {
      const o = p
      const c = o + (rng() - 0.5) * 20
      feed.push(bar(i, o, Math.max(o, c) + rng() * 5, Math.min(o, c) - rng() * 5, c))
      p = c
    }
    const full = heikinAshiSeries(feed)
    for (const k of [1, 2, 17, 59]) {
      expect(heikinAshiSeries(feed.slice(0, k + 1))[k]).toEqual(full[k])
    }
    // And changing a FUTURE bar never moves an earlier point.
    const changed = feed.map((b, i) => (i === 40 ? { ...b, high: b.high + 500, close: b.close + 300 } : b))
    expect(heikinAshiSeries(changed).slice(0, 40)).toEqual(full.slice(0, 40))
  })

  it('does not mutate the real bars', () => {
    const frozen = bars.map((b) => Object.freeze({ ...b }))
    expect(() => heikinAshiSeries(frozen)).not.toThrow()
  })
})

describe('switching to Heikin Ashi changes no fill', () => {
  const SPEC = CONTRACT_SPECS.MNQ
  // 20 flat minutes at 20000, a dip to 19990 at minute 8 (the buy limit), a spike to 20030 at minute 14.
  const feed: Bar[] = Array.from({ length: 20 }, (_, i) => {
    if (i === 8) return bar(i, 20000, 20002, 19989, 19994)
    if (i === 14) return bar(i, 19994, 20030, 19994, 20025)
    return bar(i, 20000, 20003, 19997, 20000)
  })
  const frozenFeed = feed.map((b) => Object.freeze({ ...b }))
  const long: OpenPosition = {
    side: 'long', contracts: 2, entryPrice: 20000, entryTime: feed[0].time, entryIndex: 0, riskUsd: 40,
    slPrice: 19980, tpPrice: 20020, autoBreakeven: false, trailingPoints: null, tradeKey: 'k', initialContracts: 2,
    ghostSl: null, ghostTp: null,
  }
  const run = () => advanceReplay(frozenFeed, 0, 19, long, [] as WorkingOrder[], SPEC, 1.3)

  it('runs the same trades at the same real prices before and after the display transform', () => {
    const before = run()
    const ha = heikinAshiSeries(frozenFeed)
    // The display really is different data...
    expect(ha.some((p, i) => p.haClose !== frozenFeed[i].close)).toBe(true)
    // ...but the broker's inputs (the real bars) are untouched, so the outcome is identical.
    const after = run()
    expect(after).toEqual(before)
    expect(after.closedTrades).toHaveLength(1)
    expect(after.closedTrades[0]).toMatchObject({ exitType: 'take_profit', exitPrice: 20020 })
    // The fill price is a real level, not one of the smoothed candle's values.
    const haValues = new Set(ha.flatMap((p) => [p.haOpen, p.haHigh, p.haLow, p.haClose]))
    expect(haValues.has(after.closedTrades[0].exitPrice)).toBe(false)
    expect(frozenFeed.map((b) => b.close)).toEqual(feed.map((b) => b.close))
  })

  it('leaves the real candles in the chart: only their drawing is hidden', () => {
    const styles = candleTypeStyles('heikin_ashi', { accent: '#000', positive: '#0f0', negative: '#f00', upCandle: '#0f0', downCandle: '#f00' })
    expect(styles.candle.type).toBe('candle_solid')
    expect(styles.candle.bar.upColor).toMatch(/,\s*0\)$/) // fully transparent
    const normal = candleTypeStyles('candle_stroke', { accent: '#000', positive: '#0f0', negative: '#f00', upCandle: '#0f0', downCandle: '#f00' })
    expect(normal.candle.type).toBe('candle_stroke')
    expect(normal.candle.bar.upColor).toBe('#0f0')
  })
})
