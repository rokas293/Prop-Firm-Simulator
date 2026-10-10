// FXR_V2_SPEC.md section 4 (G6): the New session form's logic, kept pure and
// framework-free (like sessionEnd.ts / discipline.ts) so the rules a user is
// told about are the ones tested. The server validates everything again
// (bt_session_service); this only makes the messages readable before submit.
import type { CreateSessionRequest, InstrumentRange, MaxLossType, PropPreset, PropRules } from '../api/types'
import { addDaysIso, addMonthsIso, etDayEndUnix, etWallTimeToUnix, fmtEtDate, fmtEtLongDate } from '../timeFormat'
import { parseCloseTime } from './holdingRestrictions'

export const DEFAULT_START_TIME = '09:30' // ET: the New York open
export const DEFAULT_RANDOM_LENGTH_DAYS = 7
export const MAX_RANDOM_LENGTH_DAYS = 366
const BASE_TIMEFRAME = '5min' // the chart timeframe and step size are changed inside the session (G5)

// "Min 16 Jul 2021 · Max 15 Jul 2026" -- the instrument's data range, in ET, shown
// under each date field. `which` picks the half that field cares about.
export function rangeHint(range: InstrumentRange | undefined, which: 'both' | 'min' | 'max' = 'both'): string {
  if (!range) return ''
  const min = `Min ${fmtEtLongDate(range.min)}`
  const max = `Max ${fmtEtLongDate(range.max)}`
  return which === 'min' ? min : which === 'max' ? max : `${min} · ${max}`
}

export type WindowErrors = { start?: string; end?: string }

export interface WindowInput {
  startDate: string // yyyy-mm-dd (ET)
  startTime: string // HH:MM (ET)
  endDate: string // yyyy-mm-dd (ET), '' = replay without an end
  range: InstrumentRange | undefined
  asset: string
  // Whose data the limits are: defaults to "<asset>'s". A multi-asset session names
  // the shared range ("the shared MNQ and MES").
  dataOf?: string
}

export interface ResolvedWindow {
  start: number
  end: number | null
}

// Validates a chosen window and, when it is valid, resolves it to unix seconds. Dates
// are compared as ET calendar days against the data range (so "16 Jul 2021" means
// what the hint says); the start is the date at the chosen time and the end is the
// last second of its day, each pulled in to the data's own first/last bar.
export function resolveWindow(w: WindowInput): { errors: WindowErrors; window: ResolvedWindow | null } {
  const errors: WindowErrors = {}
  const range = w.range
  const owner = w.dataOf ?? `${w.asset}'s`
  const dataMin = range ? fmtEtDate(range.min) : null
  const dataMax = range ? fmtEtDate(range.max) : null

  let start: number | null = null
  if (w.startDate) {
    // etWallTimeToUnix lets 25:99 roll over into the next day, so the time is checked first.
    const time = w.startTime || DEFAULT_START_TIME
    start = parseCloseTime(time) === null ? null : etWallTimeToUnix(`${w.startDate}T${time}`)
    if (start === null) errors.start = 'Enter the start time as 24-hour HH:MM, like 09:30.'
    else if (range && dataMin && w.startDate < dataMin) errors.start = `Start is before ${owner} first data (${fmtEtLongDate(range.min)}).`
    else if (range && dataMax && w.startDate > dataMax) errors.start = `Start is after ${owner} last data (${fmtEtLongDate(range.max)}).`
    else if (range && start !== null) start = Math.min(Math.max(start, range.min), range.max)
  }

  let end: number | null = null
  if (w.endDate) {
    end = etDayEndUnix(w.endDate)
    if (end === null) errors.end = 'Enter the end as a date, like 2024-03-08.'
    else if (range && dataMin && w.endDate < dataMin) errors.end = `End is before ${owner} first data (${fmtEtLongDate(range.min)}).`
    else if (range && dataMax && w.endDate > dataMax) errors.end = `End is after ${owner} last data (${fmtEtLongDate(range.max)}).`
    else if (range && end !== null) end = Math.min(end, range.max)
  }

  if (!errors.start && !errors.end && start !== null && end !== null && end <= start) {
    errors.end = 'The end date must be after the start.'
  }
  const ok = !errors.start && !errors.end
  return { errors, window: ok && w.startDate && start !== null ? { start, end } : null }
}

// The data every selected asset has: the latest first bar to the earliest last bar
// (the assets share one cursor, so a session can only run where all of them have data).
export function combinedRange(ranges: Record<string, InstrumentRange> | undefined, assets: readonly string[]): InstrumentRange | undefined {
  if (!ranges) return undefined
  const picked = assets.map((a) => ranges[a])
  if (picked.length === 0 || picked.some((r) => !r)) return undefined
  return { min: Math.max(...picked.map((r) => r.min)), max: Math.min(...picked.map((r) => r.max)) }
}

// "MNQ" / "MNQ and MES"
export function assetsLabel(assets: readonly string[]): string {
  return assets.join(' and ')
}

// The +1D / +1W / +1M buttons: the end date that many days / weeks / calendar months after the start.
export type QuickSpan = '1D' | '1W' | '1M'
export function endDateFor(startDate: string, span: QuickSpan): string {
  if (!startDate) return ''
  if (span === '1D') return addDaysIso(startDate, 1)
  if (span === '1W') return addDaysIso(startDate, 7)
  return addMonthsIso(startDate, 1)
}

// A random start has no date to add to: the buttons set the session's length instead.
export const SPAN_DAYS: Record<QuickSpan, number> = { '1D': 1, '1W': 7, '1M': 30 }

export function randomLengthError(days: number): string | undefined {
  if (!Number.isFinite(days) || days < 1) return 'Enter a length of at least 1 day.'
  if (days > MAX_RANDOM_LENGTH_DAYS) return `The longest random session is ${MAX_RANDOM_LENGTH_DAYS} days.`
  return undefined
}

// ---------------------------------------------------------------- prop rules

// The rule builder's fields as typed (strings), so a half-typed number is not lost.
export interface RuleDraft {
  profitTarget: string
  maxLossType: MaxLossType
  maxLoss: string
  locksAtStart: boolean
  dailyLossOn: boolean
  dailyLoss: string
  consistencyOn: boolean
  consistency: string
  capOn: boolean
  cap: string
  noOvernight: boolean
  noWeekend: boolean
  noNews: boolean
  // Minutes either side of a high-impact event that are closed to entries (with noNews).
  newsWindow: string
  closeTime: string
}

const num = (v: number | null | undefined) => (v === null || v === undefined ? '' : String(v))

export function draftFromRules(r: PropRules): RuleDraft {
  return {
    profitTarget: num(r.profit_target),
    maxLossType: r.max_loss_type,
    maxLoss: num(r.max_loss),
    locksAtStart: r.max_loss_locks_at_start,
    dailyLossOn: r.daily_loss_limit !== null,
    dailyLoss: num(r.daily_loss_limit ?? 1000),
    consistencyOn: r.consistency_pct !== null,
    consistency: num(r.consistency_pct ?? 50),
    capOn: r.max_contracts !== null,
    cap: num(r.max_contracts ?? 5),
    noOvernight: r.no_overnight,
    noWeekend: r.no_weekend,
    noNews: r.no_news,
    newsWindow: num(r.news_window_minutes ?? 5),
    closeTime: r.close_time,
  }
}

export type RuleErrors = Partial<Record<'profitTarget' | 'maxLoss' | 'dailyLoss' | 'consistency' | 'cap' | 'newsWindow' | 'closeTime', string>>

const positive = (s: string): number | null => {
  const n = Number(s)
  return s.trim() !== '' && Number.isFinite(n) && n > 0 ? n : null
}

// Turns the draft into the rules the server takes, or says what is wrong in plain words.
export function rulesFromDraft(d: RuleDraft, balance: number): { rules: PropRules | null; errors: RuleErrors } {
  const errors: RuleErrors = {}
  const profitTarget = positive(d.profitTarget)
  if (profitTarget === null) errors.profitTarget = 'Enter a profit target above $0.'
  const maxLoss = positive(d.maxLoss)
  if (maxLoss === null) errors.maxLoss = 'Enter a max loss above $0.'
  else if (balance > 0 && maxLoss >= balance) errors.maxLoss = 'The max loss must be smaller than the account balance.'

  let dailyLoss: number | null = null
  if (d.dailyLossOn) {
    dailyLoss = positive(d.dailyLoss)
    if (dailyLoss === null) errors.dailyLoss = 'Enter a daily loss limit above $0, or switch it off.'
    else if (maxLoss !== null && dailyLoss > maxLoss) errors.dailyLoss = 'The daily loss limit cannot be larger than the max loss.'
  }

  let consistency: number | null = null
  if (d.consistencyOn) {
    consistency = positive(d.consistency)
    if (consistency === null || consistency > 100) {
      errors.consistency = 'Enter a percentage from 1 to 100, or switch it off.'
      consistency = null
    }
  }

  let cap: number | null = null
  if (d.capOn) {
    const n = positive(d.cap)
    if (n === null || !Number.isInteger(n)) errors.cap = 'Enter a whole number of contracts, or switch the cap off.'
    else cap = n
  }

  let newsWindow = 5
  if (d.noNews) {
    const n = positive(d.newsWindow)
    if (n === null || !Number.isInteger(n) || n > 120) errors.newsWindow = 'Enter a whole number of minutes from 1 to 120.'
    else newsWindow = n
  }

  if (d.noOvernight || d.noWeekend) {
    const minutes = parseCloseTime(d.closeTime)
    if (minutes === null || minutes < 9 * 60 + 30 || minutes > 17 * 60) {
      errors.closeTime = 'Pick a close between 09:30 and 17:00 ET.'
    }
  }

  if (Object.keys(errors).length > 0 || profitTarget === null || maxLoss === null) return { rules: null, errors }
  return {
    errors,
    rules: {
      profit_target: profitTarget,
      max_loss_type: d.maxLossType,
      max_loss: maxLoss,
      max_loss_locks_at_start: d.locksAtStart,
      daily_loss_limit: dailyLoss,
      consistency_pct: consistency,
      max_contracts: cap,
      no_overnight: d.noOvernight,
      no_weekend: d.noWeekend,
      no_news: d.noNews,
      news_window_minutes: newsWindow,
      close_time: d.closeTime,
    },
  }
}

// Does a draft equal one of the presets (on the given balance)? Drives the preset
// select: editing a preset's field flips it to "Custom", as the server will label it.
export function matchingPreset(rules: PropRules | null, balance: number, presets: PropPreset[]): PropPreset | null {
  if (!rules) return null
  return presets.find((p) => p.starting_balance === balance && sameRules(p.rules, rules)) ?? null
}

export function sameRules(a: PropRules, b: PropRules): boolean {
  return (Object.keys(a) as (keyof PropRules)[]).every((k) => a[k] === b[k])
}

// One line saying what a rule set is, for the home card and the prop popover.
export function describeRules(r: PropRules): string[] {
  const usd = (v: number) => `$${v.toLocaleString('en-US')}`
  const lossKind = { static: 'static', eod_trailing: 'end-of-day trailing', intraday_trailing: 'intraday trailing' }[r.max_loss_type]
  const out = [`Target ${usd(r.profit_target)}`, `Max loss ${usd(r.max_loss)} (${lossKind})`]
  if (r.daily_loss_limit !== null) out.push(`Daily loss ${usd(r.daily_loss_limit)}`)
  if (r.consistency_pct !== null) out.push(`Consistency ${r.consistency_pct}%`)
  if (r.max_contracts !== null) out.push(`Cap ${r.max_contracts} contracts`)
  if (r.no_overnight) out.push('No overnight holding')
  if (r.no_weekend) out.push('No weekend holding')
  if (r.no_news) out.push(`No entries within ${r.news_window_minutes ?? 5} min of high-impact news`)
  return out
}

export const rulesLabel = (ruleset: string | null | undefined): string =>
  ruleset === 'topstep_50k' ? 'Topstep 50k' : ruleset ? 'Custom prop rules' : 'Practice'

// ------------------------------------------------------------------ request

export interface SetupInput {
  name: string
  balance: number
  assets: string[]
  window: ResolvedWindow | null
  random: { days: number } | null
  commissions: Record<string, number>
  disciplineLock: boolean
  checklist: string[]
  prop: { rules: PropRules; preset: PropPreset | null } | null
}

export function buildCreateRequest(i: SetupInput): CreateSessionRequest {
  const base: CreateSessionRequest = {
    assets: i.assets,
    name: i.name.trim() || null,
    base_timeframe: BASE_TIMEFRAME,
    starting_balance: i.balance,
    commission_per_contract: i.commissions[i.assets[0]] ?? 0,
    commissions: i.commissions,
    discipline_lock: i.disciplineLock,
    checklist: i.checklist.map((c) => c.trim()).filter(Boolean),
  }
  if (i.random) {
    base.random_start = true
    base.start_time = null
    base.random_duration_seconds = Math.round(i.random.days) * 86400
  } else if (i.window) {
    base.start_time = i.window.start
    base.end_date = i.window.end
  }
  if (i.prop) {
    base.prop_ruleset = i.prop.preset ? i.prop.preset.id : 'custom'
    base.prop_rules = i.prop.rules
  }
  return base
}

// ----------------------------------------------------------- typed field text

// Money as typed: only digits and one decimal point (cents at most), so "1,500.5x" is "1500.5".
export function moneyRaw(text: string): string {
  const cleaned = text.replace(/[^0-9.]/g, '')
  const dot = cleaned.indexOf('.')
  if (dot === -1) return cleaned
  return `${cleaned.slice(0, dot)}.${cleaned.slice(dot + 1).replace(/\./g, '').slice(0, 2)}`
}

// The same with thousands separators for display: "3000" -> "3,000"; a trailing "." or
// ".0" survives so typing a cents figure is not interrupted.
export function groupMoney(raw: string): string {
  const [whole, frac] = raw.split('.')
  const grouped = whole.replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return frac === undefined ? grouped : `${grouped || '0'}.${frac}`
}

// A 24-hour HH:MM field as typed: digits and a colon, the colon added after four digits ("1600" -> "16:00").
export function typeClock(text: string): string {
  const cleaned = text.replace(/[^0-9:]/g, '').slice(0, 5)
  return /^\d{4}$/.test(cleaned) ? `${cleaned.slice(0, 2)}:${cleaned.slice(2)}` : cleaned
}

// On leaving the field: "9:30" -> "09:30"; anything else is left for validation to explain.
export function normalizeClock(text: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text)
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : text
}
