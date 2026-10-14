// FXR_V2_SPEC.md section 8 (G10): with Autopilot on, every replay step is a cursor
// save, and the server feeds the bot the bars each save reveals. Auto-play at speed
// would otherwise make one HTTP call per bar. This coalesces them: the first save goes
// out at once (a manual step stays instant), and further ones inside `windowMs` wait for
// ONE trailing save that carries the latest cursor -- the save always reads the live
// refs when it is sent, so nothing is lost by merging, and the server steps the engine
// through every bar between the two cursors, bar by bar.
export interface PersistBatcher {
  // A step happened: save now, or merge into the pending trailing save.
  push: () => void
  // Send whatever is pending right away (pause, a manual action, unmount).
  flush: () => void
  cancel: () => void
}

export interface BatcherClock {
  now: () => number
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
}

const REAL_CLOCK: BatcherClock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

export function createPersistBatcher(send: () => void, windowMs: number, clock: BatcherClock = REAL_CLOCK): PersistBatcher {
  let lastSent = Number.NEGATIVE_INFINITY
  let dirty = false
  let timer: unknown = null

  const fire = () => {
    if (timer !== null) {
      clock.clearTimer(timer)
      timer = null
    }
    if (!dirty) return
    dirty = false
    lastSent = clock.now()
    send()
  }

  return {
    push() {
      dirty = true
      if (timer !== null) return
      const wait = lastSent + windowMs - clock.now()
      if (wait <= 0) {
        fire()
        return
      }
      timer = clock.setTimer(() => {
        timer = null
        fire()
      }, wait)
    },
    flush: fire,
    cancel() {
      if (timer !== null) clock.clearTimer(timer)
      timer = null
      dirty = false
    },
  }
}

// The window: long enough that auto-play at the fastest speeds makes a handful of calls a
// second, short enough that the bot's fills appear within a beat of the bars that caused them.
export const AUTOPILOT_SAVE_WINDOW_MS = 400
