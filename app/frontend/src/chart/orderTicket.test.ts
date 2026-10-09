import { describe, expect, it } from 'vitest'
import {
  RISK_CHIPS,
  actualRiskNote,
  balanceFor,
  bracketRefusal,
  buildOrder,
  entryOf,
  initialForm,
  orderTypeRefusal,
  parseNumber,
  priceFromTicks,
  riskPctFromUsd,
  riskUsdFromPct,
  setAutoBreakeven,
  setBasis,
  setContracts,
  setEntry,
  setLevelPrice,
  setLevelTicks,
  setRiskPct,
  setRiskUsd,
  setSide,
  setType,
  sizeFromRisk,
  suggestOrderType,
  summarize,
  ticksBetween,
  toggleLevel,
  validate,
  type OrderContext,
  type OrderForm,
  type PositionToolLevels,
} from './orderTicket'
import { CONTRACT_SPECS } from './simBroker'

// MNQ: $2 a point, 0.25 ticks. $50,000 started with, $52,000 now.
const MNQ = CONTRACT_SPECS.MNQ
const MES = CONTRACT_SPECS.MES
const MARK = 20050.25

function ctxWith(overrides: Partial<OrderContext> = {}): OrderContext {
  return {
    instrument: 'MNQ',
    spec: MNQ,
    mark: MARK,
    balances: { initial: 50000, current: 52000 },
    cap: null,
    quickQuantity: 3,
    atr: 10,
    ...overrides,
  }
}

const OPTS = { riskPct: 1, basis: 'initial' as const, autoBreakeven: false, tool: null as PositionToolLevels | null }

// A long tool at the market: stop 10 points (40 ticks) below, target 20 above.
const LONG_TOOL: PositionToolLevels = { side: 'long', entry: MARK, sl: MARK - 10, tp: MARK + 20 }

describe('sizeFromRisk -- rounded DOWN to whole contracts', () => {
  it('buys exactly what the budget covers when it divides evenly', () => {
    // 50-point MNQ stop = $100 a contract; $1,000 -> 10.
    const s = sizeFromRisk(1000, MARK, MARK - 50, MNQ, null)!
    expect(s.contracts).toBe(10)
    expect(s.actualRiskUsd).toBe(1000)
    expect(s.belowOne).toBe(false)
    expect(s.cappedAt).toBeNull()
  })

  it('never rounds up past the budget: 33.33 contracts is 33, and the actual risk is lower', () => {
    // 15-point stop = $30 a contract; $1,000 / $30 = 33.33.
    const s = sizeFromRisk(1000, MARK, MARK - 15, MNQ, null)!
    expect(s.exactContracts).toBeCloseTo(33.333, 3)
    expect(s.contracts).toBe(33)
    expect(s.actualRiskUsd).toBe(990)
  })

  it('does not lose a contract to float error when the quotient is exactly whole', () => {
    // $100 over a 5-point MNQ stop ($10 a contract) is exactly 10.
    expect(sizeFromRisk(100, MARK, MARK - 5, MNQ, null)!.contracts).toBe(10)
    // And a long run of tick-sized stops stays on the integer.
    for (let ticks = 1; ticks <= 400; ticks++) {
      const perContract = ticks * 0.25 * MNQ.pointValue
      expect(sizeFromRisk(perContract * 7, MARK, MARK - ticks * 0.25, MNQ, null)!.contracts).toBe(7)
    }
  })

  it('a budget too small for one contract still orders one, and says the risk is above the target', () => {
    // 80-point stop = $160 a contract; $100 cannot buy one.
    const s = sizeFromRisk(100, MARK, MARK - 80, MNQ, null)!
    expect(s.contracts).toBe(1)
    expect(s.belowOne).toBe(true)
    expect(s.actualRiskUsd).toBe(160)
    expect(s.actualRiskUsd).toBeGreaterThan(s.targetRiskUsd)
  })

  it('a position cap clamps the size, and the actual risk follows the clamped size', () => {
    const s = sizeFromRisk(1000, MARK, MARK - 50, MNQ, 5)!
    expect(s.contracts).toBe(5)
    expect(s.cappedAt).toBe(5)
    expect(s.actualRiskUsd).toBe(500)
  })

  it('a cap that is not reached changes nothing', () => {
    const s = sizeFromRisk(1000, MARK, MARK - 50, MNQ, 20)!
    expect(s.contracts).toBe(10)
    expect(s.cappedAt).toBeNull()
  })

  it('uses the instrument point value (MES is $5 a point)', () => {
    // 10-point MES stop = $50 a contract; $500 -> 10.
    expect(sizeFromRisk(500, 5000, 4990, MES, null)!.contracts).toBe(10)
  })

  it('has nothing to size from without a stop distance or a positive risk', () => {
    expect(sizeFromRisk(1000, MARK, MARK, MNQ, null)).toBeNull()
    expect(sizeFromRisk(0, MARK, MARK - 10, MNQ, null)).toBeNull()
    expect(sizeFromRisk(-5, MARK, MARK - 10, MNQ, null)).toBeNull()
  })

  it('sizes a short the same way (the distance is absolute)', () => {
    expect(sizeFromRisk(1000, MARK, MARK + 50, MNQ, null)!.contracts).toBe(10)
  })
})

describe('Risk % <-> Risk $ and the balance basis', () => {
  it('converts both ways', () => {
    expect(riskUsdFromPct(1, 50000)).toBe(500)
    expect(riskUsdFromPct(0.25, 52000)).toBe(130)
    expect(riskPctFromUsd(500, 50000)).toBe(1)
    expect(riskPctFromUsd(130, 52000)).toBe(0.25)
    expect(riskPctFromUsd(100, 0)).toBe(0)
  })

  it('picks the initial or current balance', () => {
    expect(balanceFor('initial', ctxWith().balances)).toBe(50000)
    expect(balanceFor('current', ctxWith().balances)).toBe(52000)
  })

  it('offers the six chips from the spec', () => {
    expect([...RISK_CHIPS]).toEqual([0.25, 0.5, 0.75, 1, 2, 3])
  })

  it('every chip sets the percentage and the matching dollars on the initial balance', () => {
    const ctx = ctxWith()
    const start = initialForm(ctx, OPTS)
    const expected = { 0.25: '125.00', 0.5: '250.00', 0.75: '375.00', 1: '500.00', 2: '1000.00', 3: '1500.00' }
    for (const chip of RISK_CHIPS) {
      const f = setRiskPct(start, ctx, String(chip))
      expect(f.riskPct).toBe(String(chip))
      expect(f.riskUsd).toBe(expected[chip])
    }
  })

  it('typing a percentage updates the dollars, and typing dollars updates the percentage', () => {
    const ctx = ctxWith()
    const start = initialForm(ctx, OPTS)
    const byPct = setRiskPct(start, ctx, '1.5')
    expect(byPct.riskUsd).toBe('750.00')
    const byUsd = setRiskUsd(start, ctx, '1000')
    expect(byUsd.riskPct).toBe('2')
    // The field being typed in keeps exactly what was typed (a half-typed number survives).
    expect(byUsd.riskUsd).toBe('1000')
    expect(setRiskPct(start, ctx, '1.').riskPct).toBe('1.')
  })

  it('a field that does not parse leaves its partner alone', () => {
    const ctx = ctxWith()
    const start = initialForm(ctx, OPTS)
    expect(setRiskPct(start, ctx, '').riskUsd).toBe(start.riskUsd)
    expect(setRiskUsd(start, ctx, 'abc').riskPct).toBe(start.riskPct)
  })

  it('switching the basis keeps the percentage, re-prices the dollars, and re-sizes', () => {
    const ctx = ctxWith()
    const initial = initialForm(ctx, { ...OPTS, riskPct: 1, tool: LONG_TOOL })
    expect(initial.riskUsd).toBe('500.00')
    const current = setBasis(initial, ctx, 'current')
    expect(current.basis).toBe('current')
    expect(current.riskPct).toBe('1')
    expect(current.riskUsd).toBe('520.00')
    // 10-point stop = $20 a contract: $500 -> 25, $520 -> 26.
    expect(initial.contracts).toBe('25')
    expect(current.contracts).toBe('26')
  })
})

describe('price <-> ticks, linked', () => {
  it('counts ticks between two prices and builds a price from ticks, per side', () => {
    expect(ticksBetween(MARK, MARK - 10, 0.25)).toBe(40)
    expect(priceFromTicks('long', 'sl', MARK, 40, 0.25)).toBe(MARK - 10)
    expect(priceFromTicks('long', 'tp', MARK, 80, 0.25)).toBe(MARK + 20)
    expect(priceFromTicks('short', 'sl', MARK, 40, 0.25)).toBe(MARK + 10)
    expect(priceFromTicks('short', 'tp', MARK, 80, 0.25)).toBe(MARK - 20)
  })

  it('editing the stop price updates its ticks, and editing the ticks updates its price', () => {
    const ctx = ctxWith()
    const f = initialForm(ctx, { ...OPTS, tool: LONG_TOOL })
    expect(f.slPrice).toBe('20040.25')
    expect(f.slTicks).toBe('40')
    const byPrice = setLevelPrice(f, ctx, 'sl', '20030.25')
    expect(byPrice.slTicks).toBe('80')
    const byTicks = setLevelTicks(f, ctx, 'sl', '100')
    expect(byTicks.slPrice).toBe('20025.25')
    expect(byTicks.slTicks).toBe('100')
  })

  it('the target links the same way', () => {
    const ctx = ctxWith()
    const f = initialForm(ctx, { ...OPTS, tool: LONG_TOOL })
    expect(f.tpTicks).toBe('80')
    expect(setLevelPrice(f, ctx, 'tp', '20100.25').tpTicks).toBe('200')
    expect(setLevelTicks(f, ctx, 'tp', '8').tpPrice).toBe('20052.25')
  })

  it('a short builds its levels on the other sides', () => {
    const ctx = ctxWith()
    const short: PositionToolLevels = { side: 'short', entry: MARK, sl: MARK + 10, tp: MARK - 20 }
    const f = initialForm(ctx, { ...OPTS, tool: short })
    expect(f.side).toBe('short')
    expect(setLevelTicks(f, ctx, 'sl', '20').slPrice).toBe('20055.25')
    expect(setLevelTicks(f, ctx, 'tp', '20').tpPrice).toBe('20045.25')
  })

  it('a half-typed or invalid value does not clobber the linked field', () => {
    const ctx = ctxWith()
    const f = initialForm(ctx, { ...OPTS, tool: LONG_TOOL })
    expect(setLevelPrice(f, ctx, 'sl', '').slTicks).toBe('40')
    expect(setLevelTicks(f, ctx, 'sl', 'x').slPrice).toBe('20040.25')
  })

  it('the ticks stay linked to the entry: moving the entry keeps the price levels and recomputes the ticks', () => {
    const ctx = ctxWith()
    const f = setEntry(initialForm(ctx, { ...OPTS, tool: LONG_TOOL }), ctx, '20045.25')
    expect(f.slPrice).toBe('20040.25')
    expect(f.slTicks).toBe('20')
    expect(f.tpTicks).toBe('100')
  })

  it('stop and target prices are measured from the entry of a limit order, not from the market', () => {
    const ctx = ctxWith()
    const limit: PositionToolLevels = { side: 'long', entry: MARK - 5, sl: MARK - 15, tp: MARK + 5 }
    const f = initialForm(ctx, { ...OPTS, tool: limit })
    expect(f.slTicks).toBe('40') // 10 points below the 20045.25 entry
    expect(f.tpTicks).toBe('40')
  })
})

describe('auto-size follows risk and stop', () => {
  it('re-sizes when the risk, the stop or the entry changes', () => {
    const ctx = ctxWith()
    const f = initialForm(ctx, { ...OPTS, tool: LONG_TOOL })
    expect(f.contracts).toBe('25') // $500 / $20
    expect(setRiskPct(f, ctx, '2').contracts).toBe('50')
    expect(setLevelTicks(f, ctx, 'sl', '80').contracts).toBe('12') // 20pt stop = $40/ct -> 12.5 -> 12
    expect(setLevelPrice(f, ctx, 'sl', '20030.25').contracts).toBe('12')
  })

  it('a typed size is kept through target and tag edits, and handed back when risk or stop change', () => {
    const ctx = ctxWith()
    const f = setContracts(initialForm(ctx, { ...OPTS, tool: LONG_TOOL }), '4')
    expect(f.contractsManual).toBe(true)
    expect(setLevelTicks(f, ctx, 'tp', '40').contracts).toBe('4')
    expect(setRiskPct(f, ctx, '2').contracts).toBe('50')
    expect(setRiskPct(f, ctx, '2').contractsManual).toBe(false)
    expect(setLevelTicks(f, ctx, 'sl', '20').contractsManual).toBe(false)
  })

  it('with no stop there is no distance to risk: the size is the Quick quantity', () => {
    const ctx = ctxWith({ quickQuantity: 3 })
    const f = toggleLevel(initialForm(ctx, { ...OPTS, tool: LONG_TOOL }), ctx, 'sl', false)
    expect(f.slOn).toBe(false)
    expect(f.contracts).toBe('3')
  })

  it('turning the stop back on with nothing usable in it restores a default distance and re-sizes', () => {
    const ctx = ctxWith()
    const off = toggleLevel({ ...initialForm(ctx, { ...OPTS, tool: LONG_TOOL }), slPrice: '', slTicks: '' }, ctx, 'sl', false)
    const on = toggleLevel(off, ctx, 'sl', true)
    // ATR 10 -> a 10-point (40-tick) stop below the entry.
    expect(on.slPrice).toBe('20040.25')
    expect(on.slTicks).toBe('40')
    expect(on.contracts).toBe('25')
  })

  it('removing the stop also drops auto break-even, which cannot outlive it', () => {
    const ctx = ctxWith()
    const f = setAutoBreakeven(initialForm(ctx, { ...OPTS, tool: LONG_TOOL }), true)
    expect(f.autoBreakeven).toBe(true)
    expect(toggleLevel(f, ctx, 'sl', false).autoBreakeven).toBe(false)
    expect(setAutoBreakeven(toggleLevel(f, ctx, 'sl', false), true).autoBreakeven).toBe(false)
  })
})

describe('the actual risk is shown when rounding or a cap changes it', () => {
  it('names the rounding', () => {
    const ctx = ctxWith()
    // 15-point stop = $30 a contract; 1% of $50,000 = $500 -> 16.67 -> 16, risking $480.
    const tool: PositionToolLevels = { side: 'long', entry: MARK, sl: MARK - 15, tp: MARK + 30 }
    const f = initialForm(ctx, { ...OPTS, tool })
    const note = actualRiskNote(f, summarize(f, ctx), ctx)
    expect(f.contracts).toBe('16')
    expect(note).toContain('Rounded down from 16.67')
    expect(note).toContain('$480.00')
    expect(note).toContain('$500.00')
    expect(note).toContain('0.96%')
  })

  it('names a cap', () => {
    const ctx = ctxWith({ cap: 5 })
    const f = initialForm(ctx, { ...OPTS, tool: LONG_TOOL }) // wants 25
    const s = summarize(f, ctx)
    expect(f.contracts).toBe('5')
    expect(actualRiskNote(f, s, ctx)).toContain('Capped at 5 contracts')
    expect(s.actualRiskUsd).toBe(100)
  })

  it('names the one-contract floor', () => {
    const ctx = ctxWith()
    const tool: PositionToolLevels = { side: 'long', entry: MARK, sl: MARK - 80, tp: MARK + 80 }
    const f = initialForm(ctx, { ...OPTS, riskPct: 0.25, tool }) // $125 vs $160 a contract
    expect(f.contracts).toBe('1')
    expect(actualRiskNote(f, summarize(f, ctx), ctx)).toContain('One contract is the smallest order')
  })

  it('says what a typed size risks', () => {
    const ctx = ctxWith()
    const f = setContracts(initialForm(ctx, { ...OPTS, tool: LONG_TOOL }), '10')
    expect(actualRiskNote(f, summarize(f, ctx), ctx)).toBe('At this size the stop risks $200.00 (0.4%).')
  })

  it('says nothing when the size risks what was asked for', () => {
    const ctx = ctxWith()
    const f = initialForm(ctx, { ...OPTS, tool: LONG_TOOL }) // 25 x $20 = $500 exactly
    expect(actualRiskNote(f, summarize(f, ctx), ctx)).toBeNull()
  })

  it('the estimate header is the real risk and reward of the chosen size', () => {
    const ctx = ctxWith()
    const s = summarize(initialForm(ctx, { ...OPTS, tool: LONG_TOOL }), ctx)
    expect(s.estimatedLoss).toBe(500) // 25 x 10pt x $2
    expect(s.estimatedProfit).toBe(1000) // 25 x 20pt x $2
    expect(s.rewardRisk).toBe(2)
  })
})

describe('Topstep position cap', () => {
  it('a practice session is uncapped: the true size', () => {
    const f = initialForm(ctxWith({ cap: null }), { ...OPTS, tool: LONG_TOOL })
    expect(f.contracts).toBe('25')
    expect(validate(f, ctxWith({ cap: null }))).toEqual([])
  })

  it('a prop session auto-sizes within the cap', () => {
    const ctx = ctxWith({ cap: 5 })
    const f = initialForm(ctx, { ...OPTS, tool: LONG_TOOL })
    expect(f.contracts).toBe('5')
    expect(validate(f, ctx)).toEqual([])
  })

  it('a prop session refuses a typed size over the cap, with the reason, inside the dialog', () => {
    const ctx = ctxWith({ cap: 5 })
    const f = setContracts(initialForm(ctx, { ...OPTS, tool: LONG_TOOL }), '7')
    const issues = validate(f, ctx)
    expect(issues).toHaveLength(1)
    expect(issues[0].field).toBe('contracts')
    expect(issues[0].message).toContain('7 contracts')
    expect(issues[0].message).toContain('5-contract position limit')
    const built = buildOrder(f, ctx)
    expect(built.ok).toBe(false)
    // The cap itself is allowed.
    expect(buildOrder(setContracts(f, '5'), ctx).ok).toBe(true)
  })

  it('no stop: the Quick quantity is clamped to the cap rather than refused', () => {
    const ctx = ctxWith({ cap: 2, quickQuantity: 4 })
    const f = toggleLevel(initialForm(ctx, { ...OPTS, tool: LONG_TOOL }), ctx, 'sl', false)
    expect(f.contracts).toBe('2')
  })
})

describe('type vs side vs the current price', () => {
  it('suggests the type from where the entry sits', () => {
    expect(suggestOrderType('long', MARK, MARK)).toBe('market')
    expect(suggestOrderType('long', MARK - 5, MARK)).toBe('limit')
    expect(suggestOrderType('long', MARK + 5, MARK)).toBe('stop')
    expect(suggestOrderType('short', MARK + 5, MARK)).toBe('limit')
    expect(suggestOrderType('short', MARK - 5, MARK)).toBe('stop')
  })

  it('a buy limit must be below the market, a buy stop above', () => {
    expect(orderTypeRefusal('limit', 'long', MARK - 1, MARK, 'MNQ')).toBeNull()
    expect(orderTypeRefusal('limit', 'long', MARK + 1, MARK, 'MNQ')).toContain('Buy limit must be below the current price')
    expect(orderTypeRefusal('stop', 'long', MARK + 1, MARK, 'MNQ')).toBeNull()
    expect(orderTypeRefusal('stop', 'long', MARK - 1, MARK, 'MNQ')).toContain('Buy stop must be above the current price')
  })

  it('a sell limit must be above the market, a sell stop below', () => {
    expect(orderTypeRefusal('limit', 'short', MARK + 1, MARK, 'MNQ')).toBeNull()
    expect(orderTypeRefusal('limit', 'short', MARK - 1, MARK, 'MNQ')).toContain('Sell limit must be above the current price')
    expect(orderTypeRefusal('stop', 'short', MARK - 1, MARK, 'MNQ')).toBeNull()
    expect(orderTypeRefusal('stop', 'short', MARK + 1, MARK, 'MNQ')).toContain('Sell stop must be below the current price')
  })

  it('a limit or stop AT the market is refused (it would fill on the next bar), a market order never is', () => {
    expect(orderTypeRefusal('limit', 'long', MARK, MARK, 'MNQ')).not.toBeNull()
    expect(orderTypeRefusal('stop', 'short', MARK, MARK, 'MNQ')).not.toBeNull()
    expect(orderTypeRefusal('market', 'long', MARK, MARK, 'MNQ')).toBeNull()
    expect(orderTypeRefusal('market', 'short', MARK + 100, MARK, 'MNQ')).toBeNull()
  })

  it('the refusal quotes the current price', () => {
    expect(orderTypeRefusal('limit', 'long', MARK + 1, MARK, 'MNQ')).toContain('20,050.25')
  })

  it('typing an entry above the market on a buy turns the order into a stop, below a limit', () => {
    const ctx = ctxWith()
    const f = initialForm(ctx, { ...OPTS, tool: null })
    expect(f.type).toBe('market')
    expect(setEntry(f, ctx, '20060.25').type).toBe('stop')
    expect(setEntry(f, ctx, '20040.25').type).toBe('limit')
    expect(setEntry(setEntry(f, ctx, '20040.25'), ctx, '20050.25').type).toBe('market')
  })

  it('a type the user chose is kept, and validated against the price', () => {
    const ctx = ctxWith()
    const f = setType(setEntry(initialForm(ctx, { ...OPTS, tool: null }), ctx, '20060.25'), ctx, 'limit')
    expect(f.type).toBe('limit')
    expect(f.typeAuto).toBe(false)
    expect(validate(f, ctx).some((i) => i.field === 'type')).toBe(true)
    // Further entry edits do not silently flip a chosen type.
    expect(setEntry(f, ctx, '20030.25').type).toBe('limit')
    expect(validate(setEntry(f, ctx, '20030.25'), ctx).some((i) => i.field === 'type')).toBe(false)
  })

  it('choosing Market puts the entry at the current price', () => {
    const ctx = ctxWith()
    const limit = initialForm(ctx, { ...OPTS, tool: { ...LONG_TOOL, entry: MARK - 5, sl: MARK - 15, tp: MARK + 5 } })
    expect(limit.type).toBe('limit')
    const market = setType(limit, ctx, 'market')
    expect(market.entry).toBe('20050.25')
    expect(entryOf(market, ctx)).toBe(MARK)
  })

  it('changing the side of an auto-typed order re-derives the type', () => {
    const ctx = ctxWith()
    const buyLimit = initialForm(ctx, { ...OPTS, tool: { side: 'long', entry: MARK - 5, sl: MARK - 15, tp: MARK + 5 } })
    expect(buyLimit.type).toBe('limit')
    expect(setSide(buyLimit, ctx, 'short').type).toBe('stop') // a sell below the market
  })
})

describe('stop and target must sit on their own side of the entry', () => {
  it('a long stop is below, a long target above; a short mirrors', () => {
    expect(bracketRefusal('long', 'sl', MARK - 1, MARK, 0.25)).toBeNull()
    expect(bracketRefusal('long', 'sl', MARK + 1, MARK, 0.25)).toContain('Stop loss must be at least one tick below the entry price for a buy')
    expect(bracketRefusal('long', 'tp', MARK + 1, MARK, 0.25)).toBeNull()
    expect(bracketRefusal('long', 'tp', MARK - 1, MARK, 0.25)).toContain('Take profit must be at least one tick above')
    expect(bracketRefusal('short', 'sl', MARK + 1, MARK, 0.25)).toBeNull()
    expect(bracketRefusal('short', 'tp', MARK - 1, MARK, 0.25)).toBeNull()
    expect(bracketRefusal('short', 'sl', MARK - 1, MARK, 0.25)).toContain('for a sell')
  })

  it('one tick away is allowed, none is not', () => {
    expect(bracketRefusal('long', 'sl', MARK - 0.25, MARK, 0.25)).toBeNull()
    expect(bracketRefusal('long', 'sl', MARK, MARK, 0.25)).not.toBeNull()
  })

  it('switching the side mirrors the levels so the order stays valid', () => {
    const ctx = ctxWith()
    const long = initialForm(ctx, { ...OPTS, tool: LONG_TOOL })
    expect(validate(long, ctx)).toEqual([])
    const short = setSide(long, ctx, 'short')
    expect(short.slPrice).toBe('20060.25')
    expect(short.tpPrice).toBe('20030.25')
    expect(short.slTicks).toBe('40')
    expect(short.tpTicks).toBe('80')
    expect(validate(short, ctx)).toEqual([])
  })

  it('a stop on the wrong side is reported against the stop field', () => {
    const ctx = ctxWith()
    const f = setLevelPrice(initialForm(ctx, { ...OPTS, tool: LONG_TOOL }), ctx, 'sl', '20060.25')
    const issues = validate(f, ctx)
    expect(issues.map((i) => i.field)).toContain('sl')
    expect(buildOrder(f, ctx).ok).toBe(false)
  })

  it('a switched-on level with no price is reported', () => {
    const ctx = ctxWith()
    const f = setLevelPrice(initialForm(ctx, { ...OPTS, tool: LONG_TOOL }), ctx, 'tp', '')
    expect(validate(f, ctx).find((i) => i.field === 'tp')?.message).toContain('take profit')
  })
})

describe('validation of the rest of the form', () => {
  it('needs a whole number of contracts of at least one', () => {
    const ctx = ctxWith()
    const base = initialForm(ctx, { ...OPTS, tool: LONG_TOOL })
    for (const bad of ['', '0', '-1', '2.5', 'x']) {
      expect(validate(setContracts(base, bad), ctx).some((i) => i.field === 'contracts')).toBe(true)
    }
    expect(validate(setContracts(base, '3'), ctx)).toEqual([])
  })

  it('needs a risk above zero to size a stop, unless the size is typed', () => {
    const ctx = ctxWith()
    const noRisk = setRiskUsd(initialForm(ctx, { ...OPTS, tool: LONG_TOOL }), ctx, '0')
    expect(validate(noRisk, ctx).some((i) => i.field === 'risk')).toBe(true)
    expect(validate(setContracts(noRisk, '2'), ctx).some((i) => i.field === 'risk')).toBe(false)
  })

  it('needs an entry price', () => {
    const ctx = ctxWith()
    const f = setType(initialForm(ctx, { ...OPTS, tool: null }), ctx, 'limit')
    expect(validate({ ...f, entry: '' }, ctx).map((i) => i.field)).toContain('entry')
  })

  it('auto break-even needs a stop loss', () => {
    const ctx = ctxWith()
    const f: OrderForm = { ...initialForm(ctx, { ...OPTS, tool: LONG_TOOL }), slOn: false, autoBreakeven: true }
    expect(validate(f, ctx).map((i) => i.field)).toContain('breakeven')
  })

  it('parses numbers strictly', () => {
    expect(parseNumber(' 12.5 ')).toBe(12.5)
    expect(parseNumber('')).toBeNull()
    expect(parseNumber('1e3x')).toBeNull()
    expect(parseNumber('Infinity')).toBeNull()
  })
})

describe('pre-fill from the position tool', () => {
  it('a long tool at the market opens as a market buy with its own stop and target', () => {
    const ctx = ctxWith()
    const f = initialForm(ctx, { ...OPTS, tool: LONG_TOOL })
    expect(f.side).toBe('long')
    expect(f.type).toBe('market')
    expect(f.typeAuto).toBe(true)
    expect(f.entry).toBe('20050.25')
    expect(f.slOn && f.tpOn).toBe(true)
    expect(f.slPrice).toBe('20040.25')
    expect(f.tpPrice).toBe('20070.25')
    expect(f.slTicks).toBe('40')
    expect(f.tpTicks).toBe('80')
    expect(f.riskPct).toBe('1')
    expect(f.riskUsd).toBe('500.00')
    expect(f.contracts).toBe('25')
    expect(f.contractsManual).toBe(false)
    expect(f.tags).toEqual([])
    expect(f.checklist).toEqual([])
  })

  it('a short tool opens as a sell', () => {
    const f = initialForm(ctxWith(), { ...OPTS, tool: { side: 'short', entry: MARK, sl: MARK + 10, tp: MARK - 20 } })
    expect(f.side).toBe('short')
    expect(f.slPrice).toBe('20060.25')
    expect(f.tpPrice).toBe('20030.25')
  })

  it('a tool dragged below the market opens as a buy limit at that price; above, a buy stop', () => {
    const ctx = ctxWith()
    const limit = initialForm(ctx, { ...OPTS, tool: { side: 'long', entry: MARK - 5, sl: MARK - 15, tp: MARK + 5 } })
    expect(limit.type).toBe('limit')
    expect(limit.entry).toBe('20045.25')
    const stop = initialForm(ctx, { ...OPTS, tool: { side: 'long', entry: MARK + 5, sl: MARK - 5, tp: MARK + 25 } })
    expect(stop.type).toBe('stop')
    // A short tool above the market is a sell limit.
    expect(initialForm(ctx, { ...OPTS, tool: { side: 'short', entry: MARK + 5, sl: MARK + 15, tp: MARK - 5 } }).type).toBe('limit')
  })

  it('the pre-filled form is valid as it stands and builds the order the tool described', () => {
    const ctx = ctxWith()
    const built = buildOrder(initialForm(ctx, { ...OPTS, tool: LONG_TOOL }), ctx)
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.order).toMatchObject({
      side: 'long',
      type: 'market',
      entryPrice: MARK,
      contracts: 25,
      slPrice: MARK - 10,
      tpPrice: MARK + 20,
      autoBreakeven: false,
      tags: [],
      checklist: [],
    })
    // R is measured against what the size really risks at the stop.
    expect(built.order.riskUsd).toBe(500)
  })

  it('opened empty: a market buy at the current price with the default ATR stop and target', () => {
    const ctx = ctxWith()
    const f = initialForm(ctx, { ...OPTS, tool: null })
    expect(f.side).toBe('long')
    expect(f.type).toBe('market')
    expect(f.entry).toBe('20050.25')
    expect(f.slPrice).toBe('20040.25') // ATR 10
    expect(f.tpPrice).toBe('20070.25') // 2R
    expect(validate(f, ctx)).toEqual([])
  })

  it('opened empty with no ATR yet falls back to the default distance', () => {
    const f = initialForm(ctxWith({ atr: null }), { ...OPTS, tool: null })
    expect(f.slPrice).toBe('20040.25')
  })

  it('carries the remembered basis, the risk and the auto break-even choice', () => {
    const ctx = ctxWith()
    const f = initialForm(ctx, { riskPct: 0.5, basis: 'current', autoBreakeven: true, tool: LONG_TOOL })
    expect(f.basis).toBe('current')
    expect(f.riskUsd).toBe('260.00')
    expect(f.autoBreakeven).toBe(true)
  })

  it('a tool at a price that is not on the tick grid is snapped when the order is built', () => {
    const ctx = ctxWith()
    const built = buildOrder(setLevelPrice(initialForm(ctx, { ...OPTS, tool: LONG_TOOL }), ctx, 'sl', '20040.3'), ctx)
    expect(built.ok && built.order.slPrice).toBe(20040.25)
  })
})

describe('buildOrder', () => {
  it('freezes the actual risk at the stop as the order risk', () => {
    const ctx = ctxWith()
    const tool: PositionToolLevels = { side: 'long', entry: MARK, sl: MARK - 15, tp: MARK + 30 }
    const built = buildOrder(initialForm(ctx, { ...OPTS, tool }), ctx)
    expect(built.ok && built.order.contracts).toBe(16)
    expect(built.ok && built.order.riskUsd).toBe(480) // not the $500 target
  })

  it('with no stop the target risk is what R is measured against', () => {
    const ctx = ctxWith()
    const f = toggleLevel(initialForm(ctx, { ...OPTS, tool: LONG_TOOL }), ctx, 'sl', false)
    const built = buildOrder(f, ctx)
    expect(built.ok && built.order.slPrice).toBeNull()
    expect(built.ok && built.order.riskUsd).toBe(500)
    expect(built.ok && built.order.contracts).toBe(3)
  })

  it('a limit order carries its own entry price and type', () => {
    const ctx = ctxWith()
    const f = initialForm(ctx, { ...OPTS, tool: { side: 'long', entry: MARK - 5, sl: MARK - 15, tp: MARK + 5 } })
    const built = buildOrder(f, ctx)
    expect(built.ok && built.order.type).toBe('limit')
    expect(built.ok && built.order.entryPrice).toBe(MARK - 5)
  })

  it('passes tags, ticked rules and auto break-even through', () => {
    const ctx = ctxWith()
    const f: OrderForm = { ...initialForm(ctx, { ...OPTS, tool: LONG_TOOL }), tags: ['breakout', 'A+'], checklist: ['Trend aligned'], autoBreakeven: true }
    const built = buildOrder(f, ctx)
    expect(built.ok && built.order).toMatchObject({ tags: ['breakout', 'A+'], checklist: ['Trend aligned'], autoBreakeven: true })
  })

  it('returns every blocking issue instead of an order', () => {
    const ctx = ctxWith({ cap: 5 })
    const f = setContracts(setLevelPrice(initialForm(ctx, { ...OPTS, tool: LONG_TOOL }), ctx, 'sl', '20060.25'), '9')
    const built = buildOrder(f, ctx)
    expect(built.ok).toBe(false)
    if (!built.ok) expect(built.issues.map((i) => i.field).sort()).toEqual(['contracts', 'sl'])
  })
})


// G4: the Shift+M / L / T hotkeys open the dialog on a chosen type.
describe('initialForm -- a preset order type (new market / limit / stop hotkeys)', () => {
  const ctx = ctxWith()

  it('with no preset the type still follows the price (unchanged)', () => {
    const f = initialForm(ctx, OPTS)
    expect(f.type).toBe('market')
    expect(f.typeAuto).toBe(true)
  })

  it('market: the entry is the market and the type is kept', () => {
    const f = initialForm(ctx, { ...OPTS, type: 'market' })
    expect(f.type).toBe('market')
    expect(f.typeAuto).toBe(false)
    expect(entryOf(f, ctx)).toBe(MARK)
    expect(validate(f, ctx)).toEqual([])
  })

  it('limit: opens one default stop-distance below the market for a buy, a valid order as it stands', () => {
    const f = initialForm(ctx, { ...OPTS, type: 'limit' })
    expect(f.type).toBe('limit')
    expect(f.typeAuto).toBe(false)
    expect(parseNumber(f.entry)).toBeLessThan(MARK)
    expect(orderTypeRefusal('limit', 'long', parseNumber(f.entry)!, MARK, 'MNQ')).toBeNull()
    expect(validate(f, ctx)).toEqual([])
  })

  it('stop: opens one default stop-distance above the market for a buy, a valid order as it stands', () => {
    const f = initialForm(ctx, { ...OPTS, type: 'stop' })
    expect(f.type).toBe('stop')
    expect(parseNumber(f.entry)).toBeGreaterThan(MARK)
    expect(validate(f, ctx)).toEqual([])
  })

  it('the preset distance is the same ATR-based one the ghost stop uses (10 points here), on the tick grid', () => {
    expect(parseNumber(initialForm(ctx, { ...OPTS, type: 'limit' }).entry)).toBe(MARK - 10)
    expect(parseNumber(initialForm(ctx, { ...OPTS, type: 'stop' }).entry)).toBe(MARK + 10)
  })

  it('a position tool still decides the entry and side; the preset only fixes the type', () => {
    const f = initialForm(ctx, { ...OPTS, tool: LONG_TOOL, type: 'limit' })
    expect(parseNumber(f.entry)).toBe(LONG_TOOL.entry)
    expect(f.side).toBe('long')
    expect(f.type).toBe('limit')
  })

  it('a preset type survives a side flip (chosen, so not re-derived)', () => {
    const f = setSide(initialForm(ctx, { ...OPTS, type: 'limit' }), ctx, 'short')
    expect(f.type).toBe('limit')
  })
})
