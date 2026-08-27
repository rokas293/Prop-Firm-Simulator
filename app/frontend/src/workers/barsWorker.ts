// Fetches + JSON-parses OHLCV bars off the main thread (POLISH_ROADMAP
// Phase P4: "move bar fetching/resampling off the main thread"). Resampling
// itself already happens server-side (VIZ_SPEC section 0: frontend does
// zero financial math) -- what this avoids is the synchronous JSON.parse of
// a large bar array blocking pan/zoom interaction on the main thread for a
// full day (or more) of 1-minute data.
//
// Deliberately NOT typed against the "webworker" TS lib: mixing it with the
// app's "dom" lib in one tsconfig program causes global-scope conflicts
// (duplicate `self`, `postMessage`, etc). Narrow casts instead -- this file
// only needs `onmessage`/`postMessage`, both trivially typeable by hand.
export {}

interface WorkerScope {
  onmessage: ((e: MessageEvent<BarsRequestMessage>) => void) | null
  postMessage: (msg: BarsResponseMessage) => void
}
const ctx = self as unknown as WorkerScope

export interface BarsRequestMessage {
  id: number
  instrument: string
  tf: string
  from: number
  to: number
  max_points: number
}

export interface BarsResponseMessage {
  id: number
  ok: boolean
  data?: unknown
  error?: string
}

ctx.onmessage = (e) => {
  const { id, ...params } = e.data
  const qs = new URLSearchParams(
    Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
  ).toString()

  fetch(`/api/bars?${qs}`)
    .then(async (res) => {
      if (!res.ok) throw new Error(`${res.status} ${res.statusText} for /bars`)
      const data = await res.json()
      ctx.postMessage({ id, ok: true, data })
    })
    .catch((err: unknown) => {
      ctx.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) })
    })
}
