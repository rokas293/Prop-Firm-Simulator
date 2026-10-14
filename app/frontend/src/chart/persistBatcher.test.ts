import { describe, expect, it } from 'vitest'
import { createPersistBatcher, type BatcherClock } from './persistBatcher'

function fakeClock() {
  let t = 0
  let next = 1
  const timers = new Map<number, { at: number; fn: () => void }>()
  const clock: BatcherClock = {
    now: () => t,
    setTimer: (fn, ms) => {
      const id = next++
      timers.set(id, { at: t + ms, fn })
      return id
    },
    clearTimer: (h) => void timers.delete(h as number),
  }
  const advance = (ms: number) => {
    const end = t + ms
    for (;;) {
      const due = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      t = due[1].at
      timers.delete(due[0])
      due[1].fn()
    }
    t = end
  }
  return { clock, advance, pending: () => timers.size }
}

describe('persist batcher', () => {
  it('sends the first save at once, then at most one per window', () => {
    const { clock, advance } = fakeClock()
    let sent = 0
    const b = createPersistBatcher(() => void (sent += 1), 400, clock)
    b.push()
    expect(sent).toBe(1)
    // auto-play at 10 steps/s for 2 seconds: 21 steps in all
    for (let i = 0; i < 20; i++) {
      advance(100)
      b.push()
    }
    advance(400)
    // the leading save, then one per 400 ms window up to 2.4 s: 7 calls for 21 steps
    expect(sent).toBe(7)
  })

  it('a burst inside the window is one trailing save', () => {
    const { clock, advance } = fakeClock()
    let sent = 0
    const b = createPersistBatcher(() => void (sent += 1), 400, clock)
    b.push() // leading
    b.push()
    b.push()
    b.push()
    expect(sent).toBe(1)
    advance(399)
    expect(sent).toBe(1)
    advance(1)
    expect(sent).toBe(2)
    advance(2000)
    expect(sent).toBe(2) // nothing pending: no idle saves
  })

  it('flush sends what is pending immediately and only once', () => {
    const { clock, pending } = fakeClock()
    let sent = 0
    const b = createPersistBatcher(() => void (sent += 1), 400, clock)
    b.push()
    b.push()
    b.flush()
    expect(sent).toBe(2)
    expect(pending()).toBe(0)
    b.flush()
    expect(sent).toBe(2)
  })

  it('a slow step rate saves every step (nothing is delayed when it need not be)', () => {
    const { clock, advance } = fakeClock()
    let sent = 0
    const b = createPersistBatcher(() => void (sent += 1), 400, clock)
    for (let i = 0; i < 5; i++) {
      b.push()
      advance(1000)
    }
    expect(sent).toBe(5)
  })

  it('cancel drops the pending save', () => {
    const { clock, advance } = fakeClock()
    let sent = 0
    const b = createPersistBatcher(() => void (sent += 1), 400, clock)
    b.push()
    b.push()
    b.cancel()
    advance(1000)
    expect(sent).toBe(1)
  })
})
