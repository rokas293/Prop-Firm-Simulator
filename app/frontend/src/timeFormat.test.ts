import { describe, expect, it } from 'vitest'
import { etDayEndUnix, etDayStartUnix, etDayTicks, etWallTimeToUnix, fmtEtDate, fmtEtDateTime, fmtEtDateTimeSec, fmtEtShort, fmtEtTick } from './timeFormat'

const utc = (iso: string) => Date.parse(iso) / 1000

describe('ET formatters', () => {
  it('shows winter time at UTC-5 with a visible ET label', () => {
    // 2024-01-15 14:30 UTC = 09:30 EST
    expect(fmtEtDateTime(utc('2024-01-15T14:30:00Z'))).toBe('2024-01-15 09:30 ET')
  })

  it('shows summer time at UTC-4', () => {
    // 2024-07-15 13:30 UTC = 09:30 EDT
    expect(fmtEtDateTime(utc('2024-07-15T13:30:00Z'))).toBe('2024-07-15 09:30 ET')
  })

  it('rolls the calendar date back across UTC midnight', () => {
    expect(fmtEtDate(utc('2024-07-16T03:00:00Z'))).toBe('2024-07-15')
    expect(fmtEtShort(utc('2024-07-16T03:00:00Z'))).toBe('07-15 23:00 ET')
  })

  it('prints midnight as 00:xx, never 24:xx', () => {
    expect(fmtEtDateTimeSec(utc('2024-01-15T05:00:05Z'))).toBe('2024-01-15 00:00:05 ET')
  })

  it('formats axis ticks by tick kind', () => {
    const t = utc('2024-01-15T14:30:00Z')
    expect(fmtEtTick(t, 0)).toBe('2024')
    expect(fmtEtTick(t, 2)).toBe('01-15')
    expect(fmtEtTick(t, 3)).toBe('09:30')
    expect(fmtEtTick(t, 4)).toBe('09:30:00')
  })

  describe('DST boundaries', () => {
    it('spring forward 2024-03-10: 01:59:59 EST jumps to 03:00:00 EDT', () => {
      expect(fmtEtDateTimeSec(utc('2024-03-10T06:59:59Z'))).toBe('2024-03-10 01:59:59 ET')
      expect(fmtEtDateTimeSec(utc('2024-03-10T07:00:00Z'))).toBe('2024-03-10 03:00:00 ET')
    })

    it('fall back 2024-11-03: 01:59 EDT repeats as 01:00 EST', () => {
      expect(fmtEtDateTimeSec(utc('2024-11-03T05:59:59Z'))).toBe('2024-11-03 01:59:59 ET')
      expect(fmtEtDateTimeSec(utc('2024-11-03T06:00:00Z'))).toBe('2024-11-03 01:00:00 ET')
    })

    it('the same 09:30 ET open is 14:30 UTC before the change and 13:30 UTC after it', () => {
      expect(fmtEtDateTime(utc('2024-03-08T14:30:00Z'))).toBe('2024-03-08 09:30 ET')
      expect(fmtEtDateTime(utc('2024-03-11T13:30:00Z'))).toBe('2024-03-11 09:30 ET')
    })
  })
})

describe('etWallTimeToUnix', () => {
  it('reads a winter wall time as UTC-5', () => {
    expect(etWallTimeToUnix('2024-01-15T09:30')).toBe(utc('2024-01-15T14:30:00Z'))
  })

  it('reads a summer wall time as UTC-4', () => {
    expect(etWallTimeToUnix('2024-07-15T09:30')).toBe(utc('2024-07-15T13:30:00Z'))
  })

  it('round-trips through the formatter either side of a DST change', () => {
    for (const local of ['2024-03-09T20:00', '2024-03-10T09:30', '2024-11-02T20:00', '2024-11-03T09:30']) {
      const unix = etWallTimeToUnix(local)
      expect(unix).not.toBeNull()
      expect(fmtEtDateTime(unix as number)).toBe(`${local.replace('T', ' ')} ET`)
    }
  })

  it('rejects an empty or malformed value', () => {
    expect(etWallTimeToUnix('')).toBeNull()
    expect(etWallTimeToUnix('nope')).toBeNull()
  })
})

describe('etDayStartUnix / etDayEndUnix', () => {
  it('bound an ET calendar day (EST)', () => {
    expect(etDayStartUnix('2024-01-15')).toBe(utc('2024-01-15T05:00:00Z'))
    expect(etDayEndUnix('2024-01-15')).toBe(utc('2024-01-16T04:59:59Z'))
  })

  it('handle 23h and 25h DST days', () => {
    expect(etDayEndUnix('2024-03-10')! - etDayStartUnix('2024-03-10')! + 1).toBe(23 * 3600)
    expect(etDayEndUnix('2024-11-03')! - etDayStartUnix('2024-11-03')! + 1).toBe(25 * 3600)
  })

  it('reject malformed dates', () => {
    expect(etDayStartUnix('nope')).toBeNull()
    expect(etDayEndUnix('nope')).toBeNull()
  })
})

describe('etDayTicks', () => {
  it('gives one tick per ET date, even when UTC dates differ', () => {
    // 22:00 and 23:30 ET on 07-15 are 02:00/03:30 UTC on 07-16.
    const times = [utc('2024-07-16T02:00:00Z'), utc('2024-07-16T03:30:00Z'), utc('2024-07-16T14:00:00Z')]
    expect(etDayTicks(times)).toEqual([times[0], times[2]])
  })

  it('thins a long run evenly and keeps both ends', () => {
    const times = Array.from({ length: 40 }, (_, i) => utc('2024-01-01T15:00:00Z') + i * 86400)
    const ticks = etDayTicks(times, 6)
    expect(ticks).toHaveLength(6)
    expect(ticks[0]).toBe(times[0])
    expect(ticks[5]).toBe(times[39])
  })
})
