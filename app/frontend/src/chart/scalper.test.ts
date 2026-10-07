import { describe, expect, it } from 'vitest'
import { ghostsApply } from './orderEntry'
import {
  DEFAULT_SCALPER,
  editScalper,
  entryBrackets,
  normalizeScalper,
  scalperBrackets,
  scalperPreview,
  tpNeedsStop,
  type ScalperSettings,
} from './scalper'
import { CONTRACT_SPECS } from './simBroker'

// MNQ: $2 a point, 0.25 ticks (so $0.50 a tick a contract).
const MNQ = CONTRACT_SPECS.MNQ
const MES = CONTRACT_SPECS.MES
const ENTRY = 20000

const settings = (patch: Partial<ScalperSettings>): ScalperSettings => normalizeScalper({ ...DEFAULT_SCALPER, ...patch })

describe('stop loss units', () => {
  it('ticks: value x tick size below a long entry, above a short one', () => {
    const s = settings({ slOn: true, slValue: 40, slUnit: 'ticks', tpOn: false })
    expect(scalperBrackets(s, 'long', ENTRY, 2, MNQ).slPrice).toBe(19990)
    expect(scalperBrackets(s, 'short', ENTRY, 2, MNQ).slPrice).toBe(20010)
    expect(scalperBrackets(s, 'long', ENTRY, 2, MNQ).slTicks).toBe(40)
  })

  it('percent: a share of the entry price, snapped to the tick grid', () => {
    // 0.05% of 20,000 is 10 points = 40 ticks.
    const s = settings({ slOn: true, slValue: 0.05, slUnit: 'percent', tpOn: false })
    expect(scalperBrackets(s, 'long', ENTRY, 1, MNQ).slPrice).toBe(19990)
    // 0.0333% is 6.66 points, which snaps to 6.75 (27 ticks).
    const odd = settings({ slOn: true, slValue: 0.0333, slUnit: 'percent', tpOn: false })
    expect(scalperBrackets(odd, 'long', ENTRY, 1, MNQ).slPrice).toBe(19993.25)
  })

  it('$: the loss on the WHOLE position, so more contracts means a tighter stop', () => {
    const s = settings({ slOn: true, slValue: 80, slUnit: 'usd', tpOn: false })
    // $80 on 1 MNQ = 40 points; on 2 = 20 points; on 4 = 10 points.
    expect(scalperBrackets(s, 'long', ENTRY, 1, MNQ).slPrice).toBe(19960)
    expect(scalperBrackets(s, 'long', ENTRY, 2, MNQ).slPrice).toBe(19980)
    expect(scalperBrackets(s, 'long', ENTRY, 4, MNQ).slPrice).toBe(19990)
    // And the stop really does risk the dollars asked for.
    expect(scalperBrackets(s, 'long', ENTRY, 2, MNQ).riskUsd).toBe(80)
  })

  it('uses the instrument\'s own point value ($ on MES buys a tighter stop than on MNQ)', () => {
    const s = settings({ slOn: true, slValue: 100, slUnit: 'usd', tpOn: false })
    expect(scalperBrackets(s, 'long', 5000, 1, MES).slPrice).toBe(4980) // $100 / $5 = 20 points
    expect(scalperBrackets(s, 'long', 20000, 1, MNQ).slPrice).toBe(19950) // $100 / $2 = 50 points
  })

  it('is never narrower than one tick', () => {
    const s = settings({ slOn: true, slValue: 0.001, slUnit: 'ticks', tpOn: false })
    expect(scalperBrackets(s, 'long', ENTRY, 1, MNQ).slPrice).toBe(19999.75)
  })

  it('riskUsd is the stop\'s real risk at this size (what R is measured against)', () => {
    const s = settings({ slOn: true, slValue: 40, slUnit: 'ticks', tpOn: false })
    expect(scalperBrackets(s, 'long', ENTRY, 3, MNQ).riskUsd).toBe(60) // 10 points x $2 x 3
  })
})

describe('take profit units', () => {
  it('ticks: value x tick size on the profit side', () => {
    const s = settings({ slOn: false, tpOn: true, tpValue: 80, tpUnit: 'ticks' })
    expect(scalperBrackets(s, 'long', ENTRY, 1, MNQ).tpPrice).toBe(20020)
    expect(scalperBrackets(s, 'short', ENTRY, 1, MNQ).tpPrice).toBe(19980)
  })

  it('percent: a share of the entry price', () => {
    const s = settings({ slOn: false, tpOn: true, tpValue: 0.1, tpUnit: 'percent' })
    expect(scalperBrackets(s, 'long', ENTRY, 1, MNQ).tpPrice).toBe(20020) // 0.1% of 20,000 = 20 points
  })

  it('R: a multiple of the STOP distance, however the stop was set', () => {
    const inTicks = settings({ slOn: true, slValue: 40, slUnit: 'ticks', tpOn: true, tpValue: 2, tpUnit: 'r' })
    expect(scalperBrackets(inTicks, 'long', ENTRY, 1, MNQ).tpPrice).toBe(20020) // 2 x 10 points
    expect(scalperBrackets(inTicks, 'short', ENTRY, 1, MNQ).tpPrice).toBe(19980)
    const oneAndAHalf = { ...inTicks, tpValue: 1.5 }
    expect(scalperBrackets(oneAndAHalf, 'long', ENTRY, 1, MNQ).tpPrice).toBe(20015) // 60 ticks
    // A $ stop on 2 contracts is 20 points, so 1R is 20 points too.
    const inUsd = settings({ slOn: true, slValue: 80, slUnit: 'usd', tpOn: true, tpValue: 1, tpUnit: 'r' })
    expect(scalperBrackets(inUsd, 'long', ENTRY, 2, MNQ).tpPrice).toBe(20020)
  })

  it('R without a stop places no target (never a price from nothing), and keeps its unit for when the stop is back', () => {
    const s = settings({ slOn: false, tpOn: true, tpValue: 3, tpUnit: 'r' })
    expect(s.tpUnit).toBe('r')
    expect(tpNeedsStop(s)).toBe(true)
    expect(scalperBrackets(s, 'long', ENTRY, 1, MNQ).tpPrice).toBeNull()
    expect(tpNeedsStop(editScalper(s, { slOn: true }))).toBe(false)
    expect(tpNeedsStop(settings({ slOn: false, tpOn: true, tpUnit: 'ticks' }))).toBe(false)
  })

  it('a leg that is off produces no level', () => {
    const s = settings({ slOn: true, tpOn: false })
    const b = scalperBrackets(s, 'long', ENTRY, 1, MNQ)
    expect(b.tpPrice).toBeNull()
    expect(b.tpTicks).toBeNull()
    const noStop = settings({ slOn: false, tpOn: true, tpUnit: 'ticks' })
    expect(scalperBrackets(noStop, 'long', ENTRY, 1, MNQ).slPrice).toBeNull()
    expect(scalperBrackets(noStop, 'long', ENTRY, 1, MNQ).riskUsd).toBeNull()
  })

  it('stop and target always sit on their own sides of the entry', () => {
    for (const side of ['long', 'short'] as const) {
      const b = scalperBrackets(DEFAULT_SCALPER, side, ENTRY, 1, MNQ)
      const sign = side === 'long' ? 1 : -1
      expect(sign * (b.slPrice! - ENTRY)).toBeLessThan(0)
      expect(sign * (b.tpPrice! - ENTRY)).toBeGreaterThan(0)
    }
  })
})

describe('auto break-even', () => {
  it('by R multiple: carries the multiple, no distance', () => {
    const s = settings({ slOn: true, beOn: true, beMode: 'r', beValue: 1.5 })
    const b = scalperBrackets(s, 'long', ENTRY, 1, MNQ)
    expect(b).toMatchObject({ autoBreakeven: true, breakevenR: 1.5, breakevenPoints: null })
  })

  it('by distance: carries the distance in price points (ticks x tick size), no R', () => {
    const s = settings({ slOn: true, beOn: true, beMode: 'ticks', beValue: 12 })
    const b = scalperBrackets(s, 'long', ENTRY, 1, MNQ)
    expect(b).toMatchObject({ autoBreakeven: true, breakevenR: null, breakevenPoints: 3 })
  })

  it('needs a stop: without one it is off, whatever was asked', () => {
    const s = settings({ slOn: false, tpUnit: 'ticks', beOn: true })
    expect(s.beOn).toBe(false)
    expect(scalperBrackets({ ...s, beOn: true }, 'long', ENTRY, 1, MNQ)).toMatchObject({ autoBreakeven: false, breakevenR: null, breakevenPoints: null })
  })

  it('off means off: no trigger values are carried', () => {
    const b = scalperBrackets(settings({ slOn: true, beOn: false }), 'long', ENTRY, 1, MNQ)
    expect(b).toMatchObject({ autoBreakeven: false, breakevenR: null, breakevenPoints: null })
  })
})

describe('settings hygiene', () => {
  it('turning the stop off turns break-even off; every value and unit stays, so "3 R" is still "3 R" when it is back', () => {
    const on = settings({ slOn: true, slValue: 30, tpOn: true, tpValue: 3, tpUnit: 'r', beOn: true })
    const off = editScalper(on, { slOn: false })
    expect(off).toMatchObject({ slOn: false, slValue: 30, beOn: false, tpValue: 3, tpUnit: 'r' })
    // Switching it back on does not silently re-enable break-even.
    const back = editScalper(off, { slOn: true })
    expect(back.beOn).toBe(false)
    expect(scalperBrackets(back, 'long', ENTRY, 1, MNQ).tpPrice).toBe(20022.5) // 3 x (30 ticks = 7.5 points)
  })

  it('break-even cannot be switched on without a stop', () => {
    const noStop = settings({ slOn: false, tpUnit: 'ticks' })
    expect(editScalper(noStop, { beOn: true }).beOn).toBe(false)
  })

  it('whatever comes out of storage is made coherent: junk values and units fall back to the defaults', () => {
    const bad = normalizeScalper({ slValue: -5, slUnit: 'furlongs' as never, tpValue: Number.NaN, tpUnit: '??' as never, beValue: 0, beMode: 'x' as never })
    expect(bad).toMatchObject({
      slValue: DEFAULT_SCALPER.slValue,
      slUnit: DEFAULT_SCALPER.slUnit,
      tpValue: DEFAULT_SCALPER.tpValue,
      tpUnit: DEFAULT_SCALPER.tpUnit,
      beValue: DEFAULT_SCALPER.beValue,
      beMode: DEFAULT_SCALPER.beMode,
    })
    expect(normalizeScalper(null)).toEqual(DEFAULT_SCALPER)
  })

  it('holds distances only: there is no price field anywhere in the settings', () => {
    expect(Object.keys(DEFAULT_SCALPER).sort()).toEqual(['beMode', 'beOn', 'beValue', 'slOn', 'slUnit', 'slValue', 'tpOn', 'tpUnit', 'tpValue'])
  })
})

describe('armed vs disarmed', () => {
  const armed = { armed: true, settings: DEFAULT_SCALPER }

  it('disarmed: no brackets at all, so the entry is exactly the G2 one (and the ghost lines appear)', () => {
    expect(entryBrackets({ armed: false, settings: DEFAULT_SCALPER }, 'long', ENTRY, 2, MNQ)).toBeNull()
    // The caller draws ghosts for an entry with neither level.
    expect(ghostsApply(null, null)).toBe(true)
  })

  it('armed: the same brackets scalperBrackets gives, and a bracketed entry never gets ghosts', () => {
    const b = entryBrackets(armed, 'long', ENTRY, 2, MNQ)
    expect(b).toEqual(scalperBrackets(DEFAULT_SCALPER, 'long', ENTRY, 2, MNQ))
    expect(b?.slPrice).toBe(19990)
    expect(b?.tpPrice).toBe(20020)
    expect(ghostsApply(b!.slPrice, b!.tpPrice)).toBe(false)
  })

  it('armed with nothing on still counts as armed (the caller shows no ghosts), with no levels', () => {
    const none = { armed: true, settings: settings({ slOn: false, tpOn: false }) }
    expect(entryBrackets(none, 'long', ENTRY, 1, MNQ)).toMatchObject({ slPrice: null, tpPrice: null, autoBreakeven: false })
  })

  it('brackets are measured from the entry given, so a limit order is bracketed from its own price', () => {
    const b = entryBrackets(armed, 'short', 20100, 1, MNQ)
    expect(b?.slPrice).toBe(20110)
    expect(b?.tpPrice).toBe(20080)
  })
})

describe('scalperPreview', () => {
  it('reports the stop and target in ticks and dollars at this size, and the reward:risk', () => {
    const p = scalperPreview(DEFAULT_SCALPER, ENTRY, 2, MNQ)
    expect(p).toMatchObject({ slTicks: 40, slUsd: 40, tpTicks: 80, tpUsd: 80, rewardRisk: 2, breakevenPastTarget: false })
  })

  it('flags a break-even that would trigger at or beyond the target', () => {
    const s = settings({ slOn: true, tpOn: true, tpUnit: 'r', tpValue: 1, beOn: true, beMode: 'r', beValue: 1.5 })
    expect(scalperPreview(s, ENTRY, 1, MNQ).breakevenPastTarget).toBe(true)
    const ticks = settings({ slOn: true, tpOn: true, tpUnit: 'ticks', tpValue: 20, beOn: true, beMode: 'ticks', beValue: 20 })
    expect(scalperPreview(ticks, ENTRY, 1, MNQ).breakevenPastTarget).toBe(true)
    const fine = settings({ slOn: true, tpOn: true, tpUnit: 'r', tpValue: 2, beOn: true, beMode: 'r', beValue: 1 })
    expect(scalperPreview(fine, ENTRY, 1, MNQ).breakevenPastTarget).toBe(false)
  })
})
