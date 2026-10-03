// One chip per active dimension of the shared trade filter (state/tradeStore),
// so any surface that is narrowed by it can say so -- the Trade List toolbar
// and the Journal drawer both render these, which is what keeps a filter set
// in one panel from silently narrowing another.
import type { TradeFilters } from '../state/tradeStore'

export interface FilterChip {
  key: keyof TradeFilters
  label: string
}

export function activeFilterChips(f: TradeFilters): FilterChip[] {
  const chips: FilterChip[] = []
  const add = (key: keyof TradeFilters, label: string) => chips.push({ key, label })

  if (f.tag !== null) add('tag', `Tag: ${f.tag}`)
  if (f.setup !== null) add('setup', `Setup: ${f.setup}`)
  if (f.grade !== null) add('grade', `Grade: ${f.grade}`)
  if (f.sessionId !== null) add('sessionId', `Backtest session: ${f.sessionId.slice(0, 13)}`)
  if (f.leg !== null) add('leg', `Leg: ${f.leg}`)
  if (f.session !== null) add('session', `Session: ${f.session}`)
  if (f.side !== null) add('side', `Side: ${f.side}`)
  if (f.result !== null) add('result', `Result: ${f.result}`)
  if (f.exitType !== null) add('exitType', `Exit: ${f.exitType}`)
  if (f.entryHourNy !== null) add('entryHourNy', `Hour: ${String(f.entryHourNy).padStart(2, '0')}:00 ET`)
  if (f.weekday !== null) add('weekday', `Weekday: ${f.weekday}`)
  if (f.holdTimeBucket !== null) add('holdTimeBucket', `Hold: ${f.holdTimeBucket}`)
  if (f.streakSelector !== null) add('streakSelector', `${f.streakSelector.type} streak of ${f.streakSelector.length}`)
  if (f.dateFrom !== null) add('dateFrom', `From ${f.dateFrom}`)
  if (f.dateTo !== null) add('dateTo', `To ${f.dateTo}`)
  return chips
}
