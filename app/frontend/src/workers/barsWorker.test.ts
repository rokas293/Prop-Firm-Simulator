import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BarsRequestMessage, BarsResponseMessage } from './barsWorker'

// barsWorker.ts assigns `self.onmessage` at module load time, so `self`
// must be stubbed with a fake we control BEFORE the (fresh, via
// resetModules) import -- this captures our fake `postMessage` spy as the
// module's `ctx`, letting the test observe exactly what the worker posts
// back without a real Worker thread.
let postMessage: ReturnType<typeof vi.fn>
let onmessageHandler: ((e: MessageEvent<BarsRequestMessage>) => void) | null

async function loadWorker() {
  vi.resetModules()
  postMessage = vi.fn()
  const fakeSelf = { onmessage: null as typeof onmessageHandler, postMessage }
  vi.stubGlobal('self', fakeSelf)
  await import('./barsWorker')
  onmessageHandler = fakeSelf.onmessage
}

beforeEach(async () => {
  await loadWorker()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const REQUEST: BarsRequestMessage = {
  id: 7,
  instrument: 'MNQ',
  tf: '1min',
  from: 1000,
  to: 2000,
  max_points: 5000,
}

function lastPostedMessage(): BarsResponseMessage {
  const calls = postMessage.mock.calls
  return calls[calls.length - 1][0] as BarsResponseMessage
}

describe('barsWorker onmessage', () => {
  it('builds the /api/bars query string from every request field except id', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [] })
    vi.stubGlobal('fetch', fetchMock)

    onmessageHandler!({ data: REQUEST } as MessageEvent<BarsRequestMessage>)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())

    const url = new URL(fetchMock.mock.calls[0][0] as string, 'http://x')
    expect(url.pathname).toBe('/api/bars')
    expect(url.searchParams.get('instrument')).toBe('MNQ')
    expect(url.searchParams.get('tf')).toBe('1min')
    expect(url.searchParams.get('from')).toBe('1000')
    expect(url.searchParams.get('to')).toBe('2000')
    expect(url.searchParams.get('max_points')).toBe('5000')
    // The request id is a message-routing concern, not a query param -- it
    // must not leak into the URL.
    expect(url.searchParams.has('id')).toBe(false)
  })

  it('posts back {id, ok: true, data} with the parsed JSON on a successful fetch', async () => {
    const bars = [{ time: 1000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => bars }))

    onmessageHandler!({ data: REQUEST } as MessageEvent<BarsRequestMessage>)
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalled())

    expect(lastPostedMessage()).toEqual({ id: 7, ok: true, data: bars })
  })

  it('posts back {id, ok: false, error} with the status text on a non-ok HTTP response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: 'Internal Server Error' }))

    onmessageHandler!({ data: REQUEST } as MessageEvent<BarsRequestMessage>)
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalled())

    const response = lastPostedMessage()
    expect(response.id).toBe(7)
    expect(response.ok).toBe(false)
    expect(response.error).toContain('500')
    expect(response.error).toContain('Internal Server Error')
  })

  it('posts back {id, ok: false, error} when fetch itself rejects (network error)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))

    onmessageHandler!({ data: REQUEST } as MessageEvent<BarsRequestMessage>)
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalled())

    expect(lastPostedMessage()).toEqual({ id: 7, ok: false, error: 'network down' })
  })

  it('stringifies a non-Error rejection rather than losing the reason', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue('plain string rejection'))

    onmessageHandler!({ data: REQUEST } as MessageEvent<BarsRequestMessage>)
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalled())

    expect(lastPostedMessage()).toEqual({ id: 7, ok: false, error: 'plain string rejection' })
  })

  it('echoes back whatever request id it was given, not a hardcoded one', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => [] }))

    onmessageHandler!({ data: { ...REQUEST, id: 42 } } as MessageEvent<BarsRequestMessage>)
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalled())

    expect(lastPostedMessage().id).toBe(42)
  })
})
