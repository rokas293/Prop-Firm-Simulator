// G5: the indicator points for the candles a replay has built since its history
// was loaded, the forming one included -- fetched from the backend
// (/api/indicators/replay) after every cursor move, never computed here. See
// chart/replayIndicators.ts for what is asked and how it is spliced.
//
// One request is in flight at a time: while it runs, further cursor moves only
// remember the latest one, and the next request is made for that. So the request
// rate follows the backend's speed, never the play speed, and an answer is never
// applied out of order.
import { useEffect, useRef, useState } from 'react'
import { api } from '../api/client'
import type { IndicatorName, IndicatorPoint } from '../api/types'
import { foldTail, tailRequest } from '../chart/replayIndicators'

export type ReplayIndicatorTail = Partial<Record<IndicatorName, IndicatorPoint[]>>

interface Options {
  instrument: string | null
  timeframe: string
  tfSeconds: number
  // The `from` the history was loaded with (sets the warm-up) and where it ends.
  historyFrom: number | null
  historyEnd: number | null
  cursorTime: number | null
  which: IndicatorName[]
}

export function useReplayIndicators({ instrument, timeframe, tfSeconds, historyFrom, historyEnd, cursorTime, which }: Options): ReplayIndicatorTail {
  const [tail, setTail] = useState<ReplayIndicatorTail>({})
  const active = instrument !== null && historyFrom !== null && historyEnd !== null && which.length > 0
  const key = `${instrument}|${timeframe}|${historyFrom}|${historyEnd}|${which.join(',')}`

  const state = useRef({
    key,
    held: {} as ReplayIndicatorTail,
    accepted: null as number | null,
    inFlight: false,
    pending: null as number | null,
  })
  const latest = useRef({ instrument, timeframe, tfSeconds, historyFrom, historyEnd, which })
  latest.current = { instrument, timeframe, tfSeconds, historyFrom, historyEnd, which }

  const request = (cursor: number) => {
    const s = state.current
    if (s.inFlight) {
      s.pending = cursor
      return
    }
    const o = latest.current
    if (o.instrument === null || o.historyFrom === null || o.historyEnd === null || o.which.length === 0) return
    const req = tailRequest({ lastAcceptedCursor: s.accepted, cursor, historyEnd: o.historyEnd, tfSeconds: o.tfSeconds })
    if (!req) return
    s.inFlight = true
    const requestKey = s.key
    api
      .getReplayIndicators({
        instrument: o.instrument,
        tf: o.timeframe,
        from: o.historyFrom,
        cursor,
        since: req.since,
        which: o.which.join(','),
      })
      .then((res) => {
        const cur = state.current
        if (cur.key !== requestKey) return // the chart moved on to another series
        const held: ReplayIndicatorTail = req.reset ? {} : { ...cur.held }
        for (const name of o.which) held[name] = foldTail(held[name] ?? [], res[name] ?? [])
        cur.held = held
        cur.accepted = cursor
        setTail(held)
      })
      .catch(() => undefined)
      .finally(() => {
        const cur = state.current
        cur.inFlight = false
        if (cur.pending !== null) {
          const next = cur.pending
          cur.pending = null
          // Whatever series is current now: a stale answer was dropped above, and
          // the latest cursor still needs its own.
          request(next)
        }
      })
  }

  // A different series (timeframe, indicators, a re-anchored history): start clean.
  useEffect(() => {
    state.current = { key, held: {}, accepted: null, inFlight: state.current.inFlight, pending: null }
    setTail({})
    if (active && cursorTime !== null) request(cursorTime)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  useEffect(() => {
    if (active && cursorTime !== null) request(cursorTime)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursorTime])

  return tail
}
