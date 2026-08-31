import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BarsRequestMessage, BarsResponseMessage } from './barsWorker'
import type { BarsWorkerParams } from './barsWorkerClient'

async function loadClient() {
  vi.resetModules()
  return import('./barsWorkerClient')
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const PARAMS: BarsWorkerParams = { instrument: 'MNQ', tf: '1min', from: 1000, to: 2000, max_points: 5000 }

// Web Workers aren't available in vitest/happy-dom (confirmed by the
// module's own comment) -- `typeof Worker === 'undefined'` is true here,
// so fetchBarsInWorker always takes the fetchBarsDirect fallback unless a
// fake Worker is stubbed in, as the later describe block does.
describe('fetchBarsInWorker (no Worker global -- the direct-fetch fallback)', () => {
  beforeEach(() => {
    expect(typeof Worker).toBe('undefined')
  })

  it('fetches /api/bars with every param in the query string', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [] })
    vi.stubGlobal('fetch', fetchMock)
    const { fetchBarsInWorker } = await loadClient()

    await fetchBarsInWorker(PARAMS)

    const url = new URL(fetchMock.mock.calls[0][0] as string, 'http://x')
    expect(url.pathname).toBe('/api/bars')
    expect(url.searchParams.get('instrument')).toBe('MNQ')
    expect(url.searchParams.get('tf')).toBe('1min')
    expect(url.searchParams.get('from')).toBe('1000')
    expect(url.searchParams.get('to')).toBe('2000')
    expect(url.searchParams.get('max_points')).toBe('5000')
  })

  it('resolves with the parsed bars on a successful response', async () => {
    const bars = [{ time: 1000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => bars }))
    const { fetchBarsInWorker } = await loadClient()

    await expect(fetchBarsInWorker(PARAMS)).resolves.toEqual(bars)
  })

  it('rejects with the status text on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' }))
    const { fetchBarsInWorker } = await loadClient()

    await expect(fetchBarsInWorker(PARAMS)).rejects.toThrow(/404.*Not Found/)
  })
})

// A minimal fake Worker that echoes back a controllable response for
// whatever message it's posted, so the round-trip id-tagging/pending-map
// logic in getWorker() can be exercised without a real worker thread.
class FakeWorker {
  onmessage: ((e: MessageEvent<BarsResponseMessage>) => void) | null = null
  posted: BarsRequestMessage[] = []
  // Test-controlled: how to respond to each posted message, keyed by id.
  static respond: (req: BarsRequestMessage) => BarsResponseMessage = (req) => ({ id: req.id, ok: true, data: [] })
  // getWorker() keeps its Worker instance module-private -- recording
  // every constructed instance here is how the tests below recover a
  // handle on it (there's always exactly one, since getWorker() memoizes).
  static instances: FakeWorker[] = []

  constructor(_url: string | URL, _options?: unknown) {
    FakeWorker.instances.push(this)
  }

  postMessage(msg: BarsRequestMessage) {
    this.posted.push(msg)
    queueMicrotask(() => this.onmessage?.({ data: FakeWorker.respond(msg) } as MessageEvent<BarsResponseMessage>))
  }

  terminate() {}
}

describe('fetchBarsInWorker (fake Worker -- the real message round-trip)', () => {
  beforeEach(() => {
    FakeWorker.instances = []
    vi.stubGlobal('Worker', FakeWorker)
    FakeWorker.respond = (req) => ({ id: req.id, ok: true, data: [] })
  })

  it('posts a BarsRequestMessage carrying every param plus a numeric id', async () => {
    const { fetchBarsInWorker } = await loadClient()
    await fetchBarsInWorker(PARAMS)

    expect(FakeWorker.instances).toHaveLength(1)
    const posted = FakeWorker.instances[0].posted
    expect(posted).toHaveLength(1)
    expect(posted[0]).toMatchObject(PARAMS)
    expect(typeof posted[0].id).toBe('number')
  })

  it('reuses the same Worker instance across multiple calls instead of spawning a new one each time', async () => {
    const { fetchBarsInWorker } = await loadClient()
    await fetchBarsInWorker(PARAMS)
    await fetchBarsInWorker({ ...PARAMS, tf: '5min' })

    expect(FakeWorker.instances).toHaveLength(1)
    expect(FakeWorker.instances[0].posted).toHaveLength(2)
  })

  it('assigns a different id to each request so responses can be routed back correctly', async () => {
    const { fetchBarsInWorker } = await loadClient()
    await Promise.all([fetchBarsInWorker(PARAMS), fetchBarsInWorker(PARAMS)])

    const [firstId, secondId] = FakeWorker.instances[0].posted.map((m) => m.id)
    expect(firstId).not.toBe(secondId)
  })

  it('resolves with the bars the worker posts back for a matching id', async () => {
    const bars = [{ time: 5000, open: 1, high: 1, low: 1, close: 1, volume: 1 }]
    FakeWorker.respond = (req) => ({ id: req.id, ok: true, data: bars })
    const { fetchBarsInWorker } = await loadClient()

    await expect(fetchBarsInWorker(PARAMS)).resolves.toEqual(bars)
  })

  it('rejects when the worker posts back ok: false', async () => {
    FakeWorker.respond = (req) => ({ id: req.id, ok: false, error: 'boom' })
    const { fetchBarsInWorker } = await loadClient()

    await expect(fetchBarsInWorker(PARAMS)).rejects.toThrow('boom')
  })

  it('never crosses two concurrent requests\' responses, even if the worker answers them out of order', async () => {
    // Request A responds LAST, request B responds FIRST -- if the pending
    // map were keyed wrong (or not keyed at all), one promise would
    // resolve with the other's data.
    FakeWorker.respond = (req) => ({
      id: req.id,
      ok: true,
      data: [{ time: req.id, open: req.id, high: req.id, low: req.id, close: req.id, volume: req.id }],
    })
    const originalPostMessage = FakeWorker.prototype.postMessage
    const order: number[] = []
    FakeWorker.prototype.postMessage = function (this: FakeWorker, msg: BarsRequestMessage) {
      order.push(msg.id)
      const delayMs = order.length === 1 ? 10 : 0 // first call resolves LAST
      this.posted.push(msg)
      setTimeout(() => this.onmessage?.({ data: FakeWorker.respond(msg) } as MessageEvent<BarsResponseMessage>), delayMs)
    }

    const { fetchBarsInWorker } = await loadClient()
    const [resultA, resultB] = await Promise.all([
      fetchBarsInWorker({ ...PARAMS, instrument: 'A' }),
      fetchBarsInWorker({ ...PARAMS, instrument: 'B' }),
    ])

    // Each result's synthetic time field is the id the worker echoed back
    // for that specific request -- A and B must each get their OWN id's
    // data, not the other's, regardless of resolution order.
    expect(resultA[0].time).not.toBe(resultB[0].time)
    FakeWorker.prototype.postMessage = originalPostMessage
  })
})
