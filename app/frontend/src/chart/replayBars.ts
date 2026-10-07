// FXR_V2_SPEC.md section 5 (G5): the replay always counts in 1-minute bars -- the
// "feed". The chart's timeframe and the step size are independent of that, so
// what the chart draws at a higher timeframe is built HERE from the feed:
//
//   - a COMPLETED candle is the aggregate of all the 1m bars in its bucket;
//   - the FORMING candle is the aggregate of the 1m bars in its bucket at or
//     before the cursor, and nothing else.
//
// Pure and framework-free (like replay.ts / simBroker.ts) so the no-look-ahead
// property is unit-testable on its own: every function below reads feed[j] only
// for j <= the cursor index it is handed, and the tests poison everything after.
//
// A candle labelled `t` covers [t, t + timeframe); its bucket is the epoch grid
// (t = floor(time / tf) * tf), the same one propbt.data.resample builds on the
// backend, so a candle completed here equals what /api/bars returns for it.
import type { Bar } from '../api/types'

export interface SessionTimeframe {
  // The pandas offset alias the backend and /api/bars use ('5min', '1h').
  id: string
  label: string
  seconds: number
}

// Any timeframe at or above 1m (the data has nothing finer). One list serves the
// chart's timeframe buttons and the playback pill's step-size dropdown. Matches
// the backend's bt_session_service.TIMEFRAME_SECONDS (a subset of it).
export const SESSION_TIMEFRAMES: readonly SessionTimeframe[] = [
  { id: '1min', label: '1m', seconds: 60 },
  { id: '3min', label: '3m', seconds: 180 },
  { id: '5min', label: '5m', seconds: 300 },
  { id: '15min', label: '15m', seconds: 900 },
  { id: '30min', label: '30m', seconds: 1800 },
  { id: '1h', label: '1h', seconds: 3600 },
  { id: '4h', label: '4h', seconds: 14400 },
]

export const ONE_MINUTE = 60

export function timeframeSeconds(id: string, fallback = ONE_MINUTE): number {
  return SESSION_TIMEFRAMES.find((t) => t.id === id)?.seconds ?? fallback
}

export function timeframeLabel(id: string): string {
  return SESSION_TIMEFRAMES.find((t) => t.id === id)?.label ?? id
}

// Open time of the candle (of `tfSeconds`) that `time` falls in.
export function bucketStart(time: number, tfSeconds: number): number {
  return Math.floor(time / tfSeconds) * tfSeconds
}

// Index of the last bar at or before `time` (binary search; bars ascend), -1 if
// every bar is later.
export function lastIndexAtOrBefore(bars: readonly Bar[], time: number): number {
  let lo = 0
  let hi = bars.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (bars[mid].time <= time) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return found
}

// Index of the first feed bar of the candle that feed[index] belongs to (bars
// are only read at or before `index`).
function bucketFirstIndex(feed: readonly Bar[], index: number, tfSeconds: number): number {
  const start = bucketStart(feed[index].time, tfSeconds)
  let i = index
  while (i > 0 && feed[i - 1].time >= start) i--
  return i
}

function aggregate(feed: readonly Bar[], from: number, to: number, time: number): Bar {
  let high = feed[from].high
  let low = feed[from].low
  let volume = 0
  for (let i = from; i <= to; i++) {
    const b = feed[i]
    if (b.high > high) high = b.high
    if (b.low < low) low = b.low
    volume += b.volume
  }
  return { time, open: feed[from].open, high, low, close: feed[to].close, volume }
}

// The candle (of `tfSeconds`) containing feed[cursorIndex], as the cursor sees
// it: the 1m bars in its bucket from its first through the cursor bar.
export function formingBar(feed: readonly Bar[], cursorIndex: number, tfSeconds: number): Bar {
  const first = bucketFirstIndex(feed, cursorIndex, tfSeconds)
  return aggregate(feed, first, cursorIndex, bucketStart(feed[cursorIndex].time, tfSeconds))
}

// The candles revealed by moving the cursor from feed[fromIndex] (already
// shown; -1 = nothing shown yet) to feed[toIndex], each as of `toIndex`: the
// candle fromIndex was forming (now carrying more minutes, unless the move left
// it), then every later candle the new minutes touch, the last of them forming.
// Ascending by time. A 1m step on any timeframe yields exactly one candle.
export function revealedBars(feed: readonly Bar[], fromIndex: number, toIndex: number, tfSeconds: number): Bar[] {
  if (toIndex <= fromIndex || toIndex < 0) return []
  const out: Bar[] = []
  const firstNew = fromIndex + 1
  let start = bucketFirstIndex(feed, firstNew, tfSeconds)
  while (start <= toIndex) {
    const time = bucketStart(feed[start].time, tfSeconds)
    let end = start
    while (end < toIndex && feed[end + 1].time < time + tfSeconds) end++
    out.push(aggregate(feed, start, end, time))
    start = end + 1
  }
  return out
}

// What a chart shows for the cursor at feed[cursorIndex]: the completed candles
// strictly before the forming one (from `history`, the fetched candles, and
// `tail`, those built here since), then the forming candle. Anything in either
// list at or after the forming candle's open is dropped, so a candle that was
// completed when the cursor was further on (a rewind) is replaced by what the
// cursor can see -- never shown with the minutes it has not reached. Candles the
// lists lack between their newest and the forming one (steps taken while a
// history fetch was in flight) are built from the feed, which holds only revealed
// minutes (everything here reads feed[j] for j <= cursorIndex).
export function visibleBars(
  history: readonly Bar[],
  tail: readonly Bar[],
  feed: readonly Bar[],
  cursorIndex: number,
  tfSeconds: number,
): Bar[] {
  const forming = formingBar(feed, cursorIndex, tfSeconds)
  const out: Bar[] = []
  for (const b of history) if (b.time < forming.time) out.push(b)
  for (const b of tail) if (b.time < forming.time && (out.length === 0 || b.time > out[out.length - 1].time)) out.push(b)

  const lastTime = out.length > 0 ? out[out.length - 1].time : null
  const newestBefore = lastIndexAtOrBefore(feed, forming.time - 1)
  if (newestBefore >= 0) {
    const firstMissing = lastTime === null ? 0 : lastIndexAtOrBefore(feed, lastTime + tfSeconds - 1) + 1
    if (firstMissing <= newestBefore) {
      for (const b of revealedBars(feed, firstMissing - 1, newestBefore, tfSeconds)) {
        if (lastTime === null || b.time > lastTime) out.push(b)
      }
    }
  }
  out.push(forming)
  return out
}

// ---- stepping ---------------------------------------------------------------
//
// One step advances to the end of a candle of the step size: from a cursor at
// the end of one (the normal case) that is exactly one step further; from the
// middle of one (after a finer step) it completes that candle first, so a step
// always lands on a boundary of its own size. A step of 1m is always one bar.
// Gaps in the data (the daily halt, weekends) are stepped over: the target is
// the candle holding the next bar that exists, never an empty one.

// Index the cursor moves to on one step forward from feed[cursorIndex]; the same
// index when there is no later bar. `maxIndex` (end_date) bounds it.
export function nextStepIndex(feed: readonly Bar[], cursorIndex: number, stepSeconds: number, maxIndex = feed.length - 1): number {
  if (cursorIndex >= maxIndex) return cursorIndex
  const target = bucketStart(feed[cursorIndex + 1].time, stepSeconds) + stepSeconds - ONE_MINUTE
  return Math.min(maxIndex, Math.max(cursorIndex + 1, lastIndexAtOrBefore(feed, target)))
}

// Index one step back: the end of the candle (of the step size) before the one
// the cursor is in -- so a cursor mid-candle loses that candle's revealed
// minutes, and one at its end steps back a whole candle. `minIndex` (the
// discipline lock's floor, or the start of the loaded feed) bounds it.
export function prevStepIndex(feed: readonly Bar[], cursorIndex: number, stepSeconds: number, minIndex = 0): number {
  if (cursorIndex <= minIndex) return cursorIndex
  const target = bucketStart(feed[cursorIndex].time, stepSeconds) - ONE_MINUTE
  return Math.max(minIndex, Math.min(cursorIndex - 1, lastIndexAtOrBefore(feed, target)))
}

// The timeframe one notch smaller (-1) / larger (+1) in the list (the step-size
// hotkeys); stays put at either end.
export function shiftTimeframe(currentId: string, direction: 1 | -1): string {
  const i = SESSION_TIMEFRAMES.findIndex((t) => t.id === currentId)
  if (i < 0) return currentId
  return SESSION_TIMEFRAMES[Math.max(0, Math.min(SESSION_TIMEFRAMES.length - 1, i + direction))].id
}

// ---- the chart's history window ---------------------------------------------

// Candles of history a replay chart loads before the one forming (a Go To can ask
// for more, up to the cap -- the bars endpoint refuses more than the worker's
// 5000-point limit rather than coarsening, so the window must stay below it).
export const HISTORY_BARS = 2000
export const MAX_HISTORY_BARS = 4900

export interface HistoryWindow {
  from: number
  to: number
}

// The history is every COMPLETED candle before the one the cursor is in at
// `anchorTime`: it ends the second before that candle opens (so the fetch can
// never hold a minute the cursor has not reached) and reaches `bars` candles back.
export function historyWindow(anchorTime: number, tfSeconds: number, bars = HISTORY_BARS): HistoryWindow {
  const to = bucketStart(anchorTime, tfSeconds) - 1
  return { from: to - Math.min(bars, MAX_HISTORY_BARS) * tfSeconds, to }
}

// How many candles of history a Go To to `time` needs (with a little room to its
// left), capped; `reachable` is false when the cap stops short of the time.
export function historyBarsFor(anchorTime: number, time: number, tfSeconds: number): { bars: number; reachable: boolean } {
  const to = bucketStart(anchorTime, tfSeconds) - 1
  const needed = Math.ceil((to - time) / tfSeconds) + 60
  return { bars: Math.min(MAX_HISTORY_BARS, Math.max(HISTORY_BARS, needed)), reachable: needed <= MAX_HISTORY_BARS }
}

// How many bars of `baseSeconds` a trade spanned: the distinct base-timeframe
// candles that have data between entry and exit. Journaled as bars_held so a
// session's trades keep counting in its own base timeframe whatever the chart
// timeframe or the 1m replay under it (v1 counted base bars).
export function heldBaseBars(feed: readonly Bar[], entryTime: number, exitTime: number, baseSeconds: number): number {
  let count = 0
  let last = -Infinity
  for (let i = Math.max(0, lastIndexAtOrBefore(feed, entryTime)); i < feed.length && feed[i].time <= exitTime; i++) {
    if (feed[i].time < entryTime) continue
    const bucket = bucketStart(feed[i].time, baseSeconds)
    if (bucket !== last) {
      count++
      last = bucket
    }
  }
  return Math.max(1, count)
}
