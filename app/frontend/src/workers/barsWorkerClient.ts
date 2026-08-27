// Thin request/response wrapper around barsWorker.ts (POLISH_ROADMAP Phase
// P4) -- a single shared worker instance, requests tagged with an
// incrementing id so concurrent fetches (e.g. the primary + secondary
// split-view charts requesting different timeframes at once) never cross
// their responses.
import type { Bar } from '../api/types'
import { usePerfStore } from '../state/perfStore'
import type { BarsRequestMessage, BarsResponseMessage } from './barsWorker'

export interface BarsWorkerParams {
  instrument: string
  tf: string
  from: number
  to: number
  max_points: number
}

let worker: Worker | null = null
let nextId = 0
const pending = new Map<number, { resolve: (bars: Bar[]) => void; reject: (err: Error) => void }>()

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./barsWorker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<BarsResponseMessage>) => {
      const { id, ok, data, error } = e.data
      const entry = pending.get(id)
      if (!entry) return
      pending.delete(id)
      if (ok) entry.resolve(data as Bar[])
      else entry.reject(new Error(error ?? 'bars worker request failed'))
    }
  }
  return worker
}

// Web Workers aren't available in the vitest/happy-dom test environment (or
// any environment without Worker support) -- fall back to a plain fetch
// there rather than throwing, so the app degrades instead of breaking.
async function fetchBarsDirect(params: BarsWorkerParams): Promise<Bar[]> {
  const qs = new URLSearchParams(
    Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
  ).toString()
  const res = await fetch(`/api/bars?${qs}`)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for /bars`)
  return res.json() as Promise<Bar[]>
}

export function fetchBarsInWorker(params: BarsWorkerParams): Promise<Bar[]> {
  const startedAt = performance.now()
  const record = () => usePerfStore.getState().recordFetch('/bars (worker)', performance.now() - startedAt)

  if (typeof Worker === 'undefined') {
    return fetchBarsDirect(params).then((bars) => {
      record()
      return bars
    })
  }

  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, {
      resolve: (bars) => {
        record()
        resolve(bars)
      },
      reject,
    })
    getWorker().postMessage({ id, ...params } satisfies BarsRequestMessage)
  })
}
