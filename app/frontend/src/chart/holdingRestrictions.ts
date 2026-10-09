// FXR_V2_SPEC.md section 4 (G6): a prop session's "no overnight holding" and "no
// weekend holding" restrictions, enforced by the sim broker. Pure and
// framework-free (like discipline.ts / sessionEnd.ts) and tested on its own.
//
// The rule is stated in ET wall-clock time: positions must be flat by the
// session's `closeTime` -- every trading day for no-overnight, Fridays only for
// no-weekend. At that instant the broker flattens an open position and cancels
// working orders (advanceReplay), and until the market reopens at 18:00 ET no
// new order is accepted (entryRefusal), since it could only be held through
// the close. The CME maintenance halt means there are no bars between 17:00 and
// 18:00 ET anyway; the window matters from `closeTime` to 17:00.
//
// No look-ahead: a close is "reached" by the first revealed 1m bar that ends at
// or after it; a close that falls in a gap between bars is applied at the last
// bar BEFORE it (the last price the position could have been closed at).
import type { PropRules } from '../api/types'
import { addDaysIso, etClock, etWallTimeToUnix } from '../timeFormat'

export interface HoldingRule {
  noOvernight: boolean
  noWeekend: boolean
  // Minutes since ET midnight.
  closeMinutes: number
  closeLabel: string // "16:00"
}

const MAX_SEARCH_DAYS = 9

export function parseCloseTime(hhmm: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm)
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

// null when the session restricts neither (nothing to enforce).
export function holdingRule(rules: Pick<PropRules, 'no_overnight' | 'no_weekend' | 'close_time'> | null | undefined): HoldingRule | null {
  if (!rules || (!rules.no_overnight && !rules.no_weekend)) return null
  const closeMinutes = parseCloseTime(rules.close_time)
  if (closeMinutes === null) return null
  return { noOvernight: rules.no_overnight, noWeekend: rules.no_weekend, closeMinutes, closeLabel: rules.close_time }
}

// Does a close apply on this ET weekday (0 = Sunday)?
function closeApplies(rule: HoldingRule, weekday: number): boolean {
  if (rule.noOvernight) return weekday >= 1 && weekday <= 5
  return weekday === 5 // weekend only: the Friday close
}

function closeOn(rule: HoldingRule, dateIso: string): number | null {
  const h = String(Math.floor(rule.closeMinutes / 60)).padStart(2, '0')
  const m = String(rule.closeMinutes % 60).padStart(2, '0')
  return etWallTimeToUnix(`${dateIso}T${h}:${m}`)
}

// The first close instant strictly after `t` (unix seconds).
export function nextCloseAfter(rule: HoldingRule, t: number): number {
  const startDate = etClock(t).date
  for (let d = 0; d < MAX_SEARCH_DAYS; d++) {
    const date = addDaysIso(startDate, d)
    const f = closeOn(rule, date)
    if (f !== null && f > t && closeApplies(rule, etClock(f).weekday)) return f
  }
  return Number.POSITIVE_INFINITY
}

// The latest close instant at or before `t`, or null when none within a week and a half.
function lastCloseAtOrBefore(rule: HoldingRule, t: number): number | null {
  const startDate = etClock(t).date
  for (let d = 0; d < MAX_SEARCH_DAYS; d++) {
    const date = addDaysIso(startDate, -d)
    const f = closeOn(rule, date)
    if (f !== null && f <= t && closeApplies(rule, etClock(f).weekday)) return f
  }
  return null
}

// The first 18:00 ET reopen strictly after `t`.
function nextReopenAfter(t: number): number {
  const startDate = etClock(t).date
  for (let d = 0; d < MAX_SEARCH_DAYS; d++) {
    const f = etWallTimeToUnix(`${addDaysIso(startDate, d)}T18:00`)
    if (f !== null && f > t) return f
  }
  return Number.POSITIVE_INFINITY
}

// Why a NEW order is refused at this moment, or null. `barTime` is the open time of the
// cursor bar; an order fills at that bar's close, so the moment that matters is its end.
export function entryRefusal(rule: HoldingRule | null, barTime: number): string | null {
  if (!rule) return null
  const at = barTime + 60
  const lastClose = lastCloseAtOrBefore(rule, at)
  if (lastClose === null || at >= nextReopenAfter(lastClose)) return null
  const why = rule.noOvernight ? 'holding overnight' : 'holding over the weekend'
  return `No new orders after the ${rule.closeLabel} ET close: this session's rules forbid ${why}. Step to the next session open to trade again.`
}

export function flattenNotice(rule: HoldingRule, instrument: string): string {
  const why = rule.noOvernight ? 'no overnight holding' : 'no weekend holding'
  return `${instrument} position flattened at the ${rule.closeLabel} ET close (${why}).`
}
