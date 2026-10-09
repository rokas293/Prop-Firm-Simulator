// FXR_V2_SPEC.md section 4 (G6): what the New session form tells a user, and what it sends.
import { describe, expect, it } from 'vitest'
import type { PropPreset, PropRules } from '../api/types'
import { etWallTimeToUnix } from '../timeFormat'
import {
  buildCreateRequest,
  describeRules,
  draftFromRules,
  endDateFor,
  groupMoney,
  matchingPreset,
  moneyRaw,
  normalizeClock,
  randomLengthError,
  rangeHint,
  resolveWindow,
  rulesFromDraft,
  typeClock,
  type WindowInput,
} from './sessionSetup'

// MES data: first bar 2021-07-16 00:00Z (15 Jul 2021 20:00 ET), last 2026-07-15 23:59Z (15 Jul 20:00 ET).
const RANGE = { min: 1626393600, max: 1784159940 }
const et = (s: string) => etWallTimeToUnix(s) as number

const input = (over: Partial<WindowInput> = {}): WindowInput => ({
  startDate: '2024-03-04',
  startTime: '09:30',
  endDate: '2024-03-08',
  range: RANGE,
  asset: 'MES',
  ...over,
})

describe('rangeHint', () => {
  it('shows the data range in ET, as Min … · Max …', () => {
    expect(rangeHint(RANGE)).toBe('Min 15 Jul 2021 · Max 15 Jul 2026')
    expect(rangeHint(RANGE, 'min')).toBe('Min 15 Jul 2021')
    expect(rangeHint(RANGE, 'max')).toBe('Max 15 Jul 2026')
  })
  it('is empty until the range has loaded', () => {
    expect(rangeHint(undefined)).toBe('')
  })
})

describe('resolveWindow', () => {
  it('resolves a valid window to the start time and the last second of the end day', () => {
    const r = resolveWindow(input())
    expect(r.errors).toEqual({})
    expect(r.window).toEqual({ start: et('2024-03-04T09:30'), end: et('2024-03-09T00:00') - 1 })
  })

  it('needs the end to be after the start, including a same-day end before the start time', () => {
    expect(resolveWindow(input({ endDate: '2024-03-03' })).errors.end).toBe('The end date must be after the start.')
    expect(resolveWindow(input({ endDate: '2024-03-04' })).errors).toEqual({}) // same day: ends at 23:59:59, after 09:30
    expect(resolveWindow(input({ endDate: '2024-03-04', startTime: '23:59' })).errors).toEqual({})
    expect(resolveWindow(input({ endDate: '2024-03-03' })).window).toBeNull()
  })

  it('refuses a start before or after the data, naming the asset and the limit', () => {
    expect(resolveWindow(input({ startDate: '2021-07-01' })).errors.start).toBe("Start is before MES's first data (15 Jul 2021).")
    expect(resolveWindow(input({ startDate: '2026-08-01', endDate: '' })).errors.start).toBe("Start is after MES's last data (15 Jul 2026).")
  })

  it('refuses an end before or after the data', () => {
    expect(resolveWindow(input({ endDate: '2027-01-01' })).errors.end).toBe("End is after MES's last data (15 Jul 2026).")
    expect(resolveWindow(input({ startDate: '2021-07-20', endDate: '2021-07-01' })).errors.end).toBe("End is before MES's first data (15 Jul 2021).")
  })

  it('accepts the first and last data dates themselves, pulled in to the real first/last bar', () => {
    const first = resolveWindow(input({ startDate: '2021-07-15', startTime: '09:30', endDate: '2021-07-16' }))
    expect(first.errors).toEqual({})
    expect(first.window?.start).toBe(RANGE.min) // 09:30 ET is before the first bar
    const last = resolveWindow(input({ startDate: '2026-07-10', endDate: '2026-07-15' }))
    expect(last.errors).toEqual({})
    expect(last.window?.end).toBe(RANGE.max) // the end of that day is after the last bar
  })

  it('refuses a start time that is not a real 24-hour time, instead of rolling it over', () => {
    for (const bad of ['25:99', '24:00', '09:60', '9:30', 'abc']) {
      const r = resolveWindow(input({ startTime: bad }))
      expect(r.errors.start, bad).toBe('Enter the start time as 24-hour HH:MM, like 09:30.')
      expect(r.window).toBeNull()
    }
    expect(resolveWindow(input({ startTime: '00:00' })).errors).toEqual({})
    expect(resolveWindow(input({ startTime: '23:59' })).errors).toEqual({})
    expect(resolveWindow(input({ startTime: '' })).errors).toEqual({}) // blank = the 09:30 default
  })

  it('allows no end (a replay without an end), but needs a start', () => {
    const open = resolveWindow(input({ endDate: '' }))
    expect(open.window).toEqual({ start: et('2024-03-04T09:30'), end: null })
    expect(resolveWindow(input({ startDate: '' })).window).toBeNull()
  })

  it('reports both messages at once', () => {
    const r = resolveWindow(input({ startDate: '2020-01-01', endDate: '2030-01-01' }))
    expect(Object.keys(r.errors).sort()).toEqual(['end', 'start'])
  })

  it('does not judge a date against a range that has not loaded', () => {
    expect(resolveWindow(input({ range: undefined })).errors).toEqual({})
  })
})

describe('endDateFor (+1D / +1W / +1M)', () => {
  it('adds a day, a week, a calendar month to the start date', () => {
    expect(endDateFor('2024-03-04', '1D')).toBe('2024-03-05')
    expect(endDateFor('2024-03-04', '1W')).toBe('2024-03-11')
    expect(endDateFor('2024-03-04', '1M')).toBe('2024-04-04')
  })
  it('crosses month and year ends', () => {
    expect(endDateFor('2024-12-31', '1D')).toBe('2025-01-01')
    expect(endDateFor('2024-12-28', '1W')).toBe('2025-01-04')
    expect(endDateFor('2024-12-15', '1M')).toBe('2025-01-15')
  })
  it('clamps +1M to the target month length', () => {
    expect(endDateFor('2024-01-31', '1M')).toBe('2024-02-29') // leap year
    expect(endDateFor('2025-01-31', '1M')).toBe('2025-02-28')
    expect(endDateFor('2024-03-31', '1M')).toBe('2024-04-30')
  })
  it('is empty without a start date', () => {
    expect(endDateFor('', '1W')).toBe('')
  })
})

describe('randomLengthError', () => {
  it('bounds the length', () => {
    expect(randomLengthError(7)).toBeUndefined()
    expect(randomLengthError(0)).toMatch(/at least 1 day/)
    expect(randomLengthError(Number.NaN)).toMatch(/at least 1 day/)
    expect(randomLengthError(400)).toMatch(/366 days/)
  })
})

// ------------------------------------------------------------------ rules

const TOPSTEP: PropRules = {
  profit_target: 3000,
  max_loss_type: 'eod_trailing',
  max_loss: 2000,
  max_loss_locks_at_start: true,
  daily_loss_limit: 1000,
  consistency_pct: 50,
  max_contracts: 5,
  no_overnight: false,
  no_weekend: false,
  no_news: false,
  close_time: '16:00',
}
const PRESET: PropPreset = { id: 'topstep_50k', label: 'Topstep 50k', starting_balance: 50000, rules: TOPSTEP }

describe('rule draft', () => {
  it('round-trips the Topstep preset exactly', () => {
    const { rules, errors } = rulesFromDraft(draftFromRules(TOPSTEP), 50000)
    expect(errors).toEqual({})
    expect(rules).toEqual(TOPSTEP)
  })

  it('switching an optional rule off makes it null', () => {
    const d = { ...draftFromRules(TOPSTEP), dailyLossOn: false, consistencyOn: false, capOn: false }
    const { rules } = rulesFromDraft(d, 50000)
    expect(rules).toMatchObject({ daily_loss_limit: null, consistency_pct: null, max_contracts: null })
  })

  it('explains each invalid field in plain words', () => {
    const d = {
      ...draftFromRules(TOPSTEP),
      profitTarget: '',
      maxLoss: '60000',
      dailyLoss: '-5',
      consistency: '150',
      cap: '2.5',
      noOvernight: true,
      closeTime: '18:30',
    }
    const { rules, errors } = rulesFromDraft(d, 50000)
    expect(rules).toBeNull()
    expect(errors.profitTarget).toBe('Enter a profit target above $0.')
    expect(errors.maxLoss).toBe('The max loss must be smaller than the account balance.')
    expect(errors.dailyLoss).toBe('Enter a daily loss limit above $0, or switch it off.')
    expect(errors.consistency).toBe('Enter a percentage from 1 to 100, or switch it off.')
    expect(errors.cap).toBe('Enter a whole number of contracts, or switch the cap off.')
    expect(errors.closeTime).toBe('Pick a close between 09:30 and 17:00 ET.')
  })

  it('does not ask for a close time unless a holding restriction is on', () => {
    const d = { ...draftFromRules(TOPSTEP), closeTime: 'garbage' }
    expect(rulesFromDraft(d, 50000).errors.closeTime).toBeUndefined()
    expect(rulesFromDraft({ ...d, noWeekend: true }, 50000).errors.closeTime).toBeDefined()
  })

  it('refuses a daily limit larger than the max loss', () => {
    const d = { ...draftFromRules(TOPSTEP), dailyLoss: '2500' }
    expect(rulesFromDraft(d, 50000).errors.dailyLoss).toBe('The daily loss limit cannot be larger than the max loss.')
  })
})

describe('matchingPreset', () => {
  it('finds the preset only when rules AND balance are exactly its own', () => {
    expect(matchingPreset(TOPSTEP, 50000, [PRESET])).toBe(PRESET)
    expect(matchingPreset(TOPSTEP, 100000, [PRESET])).toBeNull()
    expect(matchingPreset({ ...TOPSTEP, profit_target: 4000 }, 50000, [PRESET])).toBeNull()
    expect(matchingPreset({ ...TOPSTEP, no_overnight: true }, 50000, [PRESET])).toBeNull()
    expect(matchingPreset(null, 50000, [PRESET])).toBeNull()
  })
})

describe('describeRules', () => {
  it('lists only the rules that exist', () => {
    expect(describeRules(TOPSTEP)).toEqual([
      'Target $3,000',
      'Max loss $2,000 (end-of-day trailing)',
      'Daily loss $1,000',
      'Consistency 50%',
      'Cap 5 contracts',
    ])
    expect(
      describeRules({ ...TOPSTEP, max_loss_type: 'static', daily_loss_limit: null, consistency_pct: null, max_contracts: null, no_overnight: true, no_news: true }),
    ).toEqual(['Target $3,000', 'Max loss $2,000 (static)', 'No overnight holding', 'No news trading'])
  })
})

// ---------------------------------------------------------------- request

describe('buildCreateRequest', () => {
  const base = {
    name: '  NY open reps ',
    balance: 25000,
    asset: 'MES',
    window: { start: 100, end: 200 },
    random: null,
    commissions: { MES: 1.3 },
    disciplineLock: false,
    checklist: [' wait for the sweep ', '  '],
    prop: null,
  }

  it('is a quick session: no contract, risk or prop fields', () => {
    const r = buildCreateRequest({ ...base, checklist: [] })
    expect(r).toMatchObject({ assets: ['MES'], name: 'NY open reps', starting_balance: 25000, start_time: 100, end_date: 200, commission_per_contract: 1.3 })
    expect(r).not.toHaveProperty('quick_quantity')
    expect(r).not.toHaveProperty('risk_per_trade_percent')
    expect(r.prop_ruleset).toBeUndefined()
    expect(r.random_start).toBeUndefined()
  })

  it('trims and drops blank checklist rules', () => {
    expect(buildCreateRequest(base).checklist).toEqual(['wait for the sweep'])
  })

  it('a random start sends a length and no dates', () => {
    const r = buildCreateRequest({ ...base, window: null, random: { days: 7 } })
    expect(r).toMatchObject({ random_start: true, start_time: null, random_duration_seconds: 7 * 86400 })
    expect(r.end_date).toBeUndefined()
  })

  it('names the preset, or "custom"', () => {
    expect(buildCreateRequest({ ...base, prop: { rules: TOPSTEP, preset: PRESET } })).toMatchObject({ prop_ruleset: 'topstep_50k', prop_rules: TOPSTEP })
    expect(buildCreateRequest({ ...base, prop: { rules: { ...TOPSTEP, no_overnight: true }, preset: null } }).prop_ruleset).toBe('custom')
  })
})

describe('typed field text', () => {
  it('money keeps digits and at most cents', () => {
    expect(moneyRaw('1,500.5x')).toBe('1500.5')
    expect(moneyRaw('$3000')).toBe('3000')
    expect(moneyRaw('0.629')).toBe('0.62')
    expect(moneyRaw('1.2.3')).toBe('1.23')
    expect(moneyRaw('abc')).toBe('')
  })
  it('groups thousands for display without disturbing a half-typed cents figure', () => {
    expect(groupMoney('3000')).toBe('3,000')
    expect(groupMoney('1250000')).toBe('1,250,000')
    expect(groupMoney('999')).toBe('999')
    expect(groupMoney('0.62')).toBe('0.62')
    expect(groupMoney('3000.')).toBe('3,000.')
    expect(groupMoney('.5')).toBe('0.5')
    expect(groupMoney('')).toBe('')
    expect(groupMoney('007')).toBe('7')
  })
  it('a 24-hour time field adds its colon and pads on leaving', () => {
    expect(typeClock('1600')).toBe('16:00')
    expect(typeClock('16:0')).toBe('16:0')
    expect(typeClock('4pm')).toBe('4')
    expect(typeClock('09:300')).toBe('09:30')
    expect(normalizeClock('9:30')).toBe('09:30')
    expect(normalizeClock('16:00')).toBe('16:00')
    expect(normalizeClock('16:0')).toBe('16:0')
  })
})
