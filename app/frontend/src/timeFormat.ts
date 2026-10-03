// Display-only time formatting, all in Eastern Time. Storage and the APIs stay
// UTC unix seconds (api/types.ts); only what the user READS is converted, so
// the chart axis, replay cursor, trade lists, journal and tooltips all agree
// with the session rules, which are anchored in America/New_York. The zone is
// resolved by Intl (never a hardcoded offset), so EST/EDT switch on the right
// instant. Every string carries a visible "ET" suffix.
export const ET_ZONE = 'America/New_York'
export const ET_LABEL = 'ET'

const PARTS_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: ET_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

interface EtParts {
  year: string
  month: string
  day: string
  hour: string
  minute: string
  second: string
}

function etParts(unixSeconds: number): EtParts {
  const out: Record<string, string> = {}
  for (const p of PARTS_FORMATTER.formatToParts(new Date(unixSeconds * 1000))) out[p.type] = p.value
  return out as unknown as EtParts
}

// "2024-03-10"
export function fmtEtDate(unixSeconds: number): string {
  const p = etParts(unixSeconds)
  return `${p.year}-${p.month}-${p.day}`
}

// "2024-03-10 09:30 ET"
export function fmtEtDateTime(unixSeconds: number): string {
  const p = etParts(unixSeconds)
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${ET_LABEL}`
}

// "2024-03-10 09:30:15 ET" -- the replay cursor, which steps in seconds-aware bars.
export function fmtEtDateTimeSec(unixSeconds: number): string {
  const p = etParts(unixSeconds)
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} ${ET_LABEL}`
}

// "03-10 09:30 ET" -- compact form for dense lists where the year is implied.
export function fmtEtShort(unixSeconds: number): string {
  const p = etParts(unixSeconds)
  return `${p.month}-${p.day} ${p.hour}:${p.minute} ${ET_LABEL}`
}

// The inverse for the one input that takes a wall-clock time: "2024-03-10T09:30"
// read as Eastern Time -> unix seconds. Resolves the offset at that wall time
// (so it is DST-correct) by fixed-point iteration on the formatter; a time
// inside the spring-forward gap lands on the instant just after the jump.
export function etWallTimeToUnix(local: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local)
  if (!m) return null
  const [y, mo, d, h, mi] = m.slice(1).map(Number)
  const asUtc = Date.UTC(y, mo - 1, d, h, mi) / 1000
  let guess = asUtc
  for (let i = 0; i < 3; i++) {
    const p = etParts(guess)
    const shown = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute)) / 1000
    const next = guess + (asUtc - shown)
    if (next === guess) break
    guess = next
  }
  return guess
}

// ET calendar-day boundaries for a "yyyy-mm-dd" filter date, so a date filter
// agrees with the ET times the UI displays (a 20:00 ET trade is on that ET
// day even though it is already the next UTC day). Start is 00:00 ET; end is
// the last second before the next ET midnight (DST-correct: the day may be
// 23 or 25 hours long).
export function etDayStartUnix(dateIso: string): number | null {
  return etWallTimeToUnix(`${dateIso}T00:00`)
}

export function etDayEndUnix(dateIso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateIso)
  if (!m) return null
  const next = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1)).toISOString().slice(0, 10)
  const start = etWallTimeToUnix(`${next}T00:00`)
  return start === null ? null : start - 1
}

// Axis tick label for charts that hand a tick-mark kind to a formatter
// (lightweight-charts' TickMarkType: 0 year, 1 month, 2 day-of-month,
// 3 time, 4 time-with-seconds). Date-level ticks print the ET calendar date,
// time-level ticks the ET wall clock; the pane's own caption carries "ET".
export function fmtEtTick(unixSeconds: number, tickKind: number): string {
  const p = etParts(unixSeconds)
  if (tickKind === 0) return p.year
  if (tickKind === 1 || tickKind === 2) return `${p.month}-${p.day}`
  return tickKind === 4 ? `${p.hour}:${p.minute}:${p.second}` : `${p.hour}:${p.minute}`
}

// One tick per distinct ET calendar date (the first sample of each day),
// thinned evenly to at most `max`, so a date-labelled axis never repeats the
// same label. `times` ascend.
export function etDayTicks(times: readonly number[], max = 6): number[] {
  const firsts: number[] = []
  let last = ''
  for (const t of times) {
    const d = fmtEtDate(t)
    if (d !== last) {
      firsts.push(t)
      last = d
    }
  }
  if (firsts.length <= max) return firsts
  const out: number[] = []
  for (let i = 0; i < max; i++) out.push(firsts[Math.round((i * (firsts.length - 1)) / (max - 1))])
  return out
}
