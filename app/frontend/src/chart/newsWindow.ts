// FXR_V2_SPEC.md section 6 (G7): a prop session's "no news trading" restriction.
// With it on, no entry is accepted within `windowMinutes` either side of a
// high-impact scheduled event (news_events.csv, served by /api/news-events).
// Pure and framework-free, like holdingRestrictions.ts, and tested on its own.
//
// Only the SCHEDULE is involved -- when an event is due and what it is called.
// That is public in advance, so using it ahead of the cursor is no look-ahead;
// nothing about what an event turned out to be exists in the data or is read.
//
// The backend enforces the same rule where a session saves its broker state
// (news_service.window_refusal); this is the same rule applied first, so a
// refusal reads as a reason on the button instead of a failed save. An entry
// bar [t, t + 60) is refused if either its open or its close falls in a window,
// which is never looser than the server (it judges the bar's open).
import type { NewsEvent, PropRules } from '../api/types'
import { fmtEtTime } from '../timeFormat'

export interface NewsRule {
  windowMinutes: number
}

// null when the session does not restrict news trading (nothing to enforce).
export function newsRule(rules: Pick<PropRules, 'no_news' | 'news_window_minutes'> | null | undefined): NewsRule | null {
  if (!rules || !rules.no_news) return null
  return { windowMinutes: rules.news_window_minutes ?? 5 }
}

// The event whose window contains `time`, or null. Edges are inside the window.
export function eventInWindow(events: readonly NewsEvent[], windowMinutes: number, time: number): NewsEvent | null {
  const span = windowMinutes * 60
  for (const e of events) {
    if (e.time - span <= time && time <= e.time + span) return e
  }
  return null
}

// Why a NEW entry on the bar that opens at `barTime` is refused, or null.
export function newsWindowRefusal(events: readonly NewsEvent[] | undefined, rule: NewsRule | null, barTime: number): string | null {
  if (!rule || !events || events.length === 0) return null
  const hit = eventInWindow(events, rule.windowMinutes, barTime) ?? eventInWindow(events, rule.windowMinutes, barTime + 60)
  if (!hit) return null
  return `No entries within ${rule.windowMinutes} min of ${hit.event} (${fmtEtTime(hit.time)} ET): this session's rules close the window around high-impact news.`
}
