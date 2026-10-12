// FXR_V2_SPEC.md section 6 (G7): the no-news rule's pure helpers -- which rule a
// session carries, which event's window a time is in, and why an entry is refused.
import { describe, expect, it } from 'vitest'
import { eventInWindow, newsRule, newsWindowRefusal } from './newsWindow'
import type { NewsEvent } from '../api/types'

// 2024-03-06 13:30 UTC = 08:30 ET (EST).
const CPI = Date.UTC(2024, 2, 6, 13, 30, 0) / 1000
const FOMC = Date.UTC(2024, 2, 6, 19, 0, 0) / 1000 // 14:00 ET
const events: NewsEvent[] = [
  { time: CPI, event: 'CPI', impact: 'high' },
  { time: FOMC, event: 'FOMC Rate Decision', impact: 'high' },
]

describe('newsRule', () => {
  it('is null when the session does not restrict news trading', () => {
    expect(newsRule(null)).toBeNull()
    expect(newsRule(undefined)).toBeNull()
    expect(newsRule({ no_news: false, news_window_minutes: 10 })).toBeNull()
  })

  it("carries the session's own window, defaulting to 5 minutes", () => {
    expect(newsRule({ no_news: true, news_window_minutes: 15 })).toEqual({ windowMinutes: 15 })
    expect(newsRule({ no_news: true, news_window_minutes: undefined as unknown as number })).toEqual({ windowMinutes: 5 })
  })
})

describe('eventInWindow', () => {
  it('includes both edges and nothing just outside', () => {
    expect(eventInWindow(events, 5, CPI - 300)?.event).toBe('CPI')
    expect(eventInWindow(events, 5, CPI + 300)?.event).toBe('CPI')
    expect(eventInWindow(events, 5, CPI - 301)).toBeNull()
    expect(eventInWindow(events, 5, CPI + 301)).toBeNull()
  })

  it('finds the event whose window it is, among several', () => {
    expect(eventInWindow(events, 5, FOMC)?.event).toBe('FOMC Rate Decision')
    expect(eventInWindow(events, 5, CPI + 3600)).toBeNull()
  })

  it('scales with the window', () => {
    expect(eventInWindow(events, 1, CPI - 120)).toBeNull()
    expect(eventInWindow(events, 30, CPI - 1800)?.event).toBe('CPI')
  })
})

describe('newsWindowRefusal', () => {
  const rule = { windowMinutes: 5 }

  it('refuses inside the window, naming the event, its ET time and the window', () => {
    const msg = newsWindowRefusal(events, rule, CPI)
    expect(msg).toContain('CPI')
    expect(msg).toContain('08:30 ET')
    expect(msg).toContain('5 min')
  })

  it('allows outside every window', () => {
    expect(newsWindowRefusal(events, rule, CPI - 3600)).toBeNull()
    expect(newsWindowRefusal(events, rule, CPI + 3600)).toBeNull()
  })

  it('judges a 1-minute bar by its open and its close: a bar ending in the window is refused', () => {
    // The bar opening at CPI-240 closes at CPI-180, inside the window with its open.
    expect(newsWindowRefusal(events, rule, CPI - 240)).not.toBeNull()
    // The bar opening at CPI-330 closes at CPI-270, inside the window; its open is not.
    expect(newsWindowRefusal(events, rule, CPI - 330)).not.toBeNull()
    // The bar opening at CPI-360 closes exactly on the window's edge, which is inside.
    expect(newsWindowRefusal(events, rule, CPI - 360)).not.toBeNull()
    // One minute earlier it closes before the window opens.
    expect(newsWindowRefusal(events, rule, CPI - 420)).toBeNull()
  })

  it('has nothing to refuse without a rule, a calendar, or events', () => {
    expect(newsWindowRefusal(events, null, CPI)).toBeNull()
    expect(newsWindowRefusal(undefined, rule, CPI)).toBeNull()
    expect(newsWindowRefusal([], rule, CPI)).toBeNull()
  })

  it('an event ahead of the time never refuses an entry outside its window', () => {
    // A scheduled event hours away is visible but closes nothing yet.
    expect(newsWindowRefusal(events, rule, CPI - 7200)).toBeNull()
  })
})
