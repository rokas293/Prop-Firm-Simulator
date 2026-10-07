// FXR_V2_SPEC.md section 5 (G5), "smooth candles": during auto-play the forming
// candle may glide from the state it had to the state the new step revealed,
// instead of jumping. It is cosmetic and must never show a price the replay has
// not revealed -- so every frame is built ONLY from the two revealed states and
// stays inside the envelope of the later one:
//
//   open  = the candle's open (never moves within a candle)
//   close = between the previous close and the revealed close
//   high  = between the previous high and the revealed high, never below open/close
//   low   = between the previous low and the revealed low, never above open/close
//
// A candle that has only just begun grows from a flat line at its open. Pure and
// framework-free so the "never past what is revealed" property is unit-testable.
import type { Bar } from '../api/types'

// Ease-out (DESIGN_LANGUAGE.md section 8: fast, subtle, ease-out).
export function easeOut(progress: number): number {
  const p = Math.max(0, Math.min(1, progress))
  return 1 - (1 - p) ** 3
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t

// What the candle looks like `progress` (0..1) of the way from `from` (what was
// on screen; null/another candle = it just began) to `target` (what the cursor
// has revealed). progress >= 1 is exactly `target`.
export function smoothFrame(from: Bar | null, target: Bar, progress: number): Bar {
  if (progress >= 1) return target
  const t = easeOut(progress)
  // The start state, clamped into the target's range: a candle only ever widens
  // as minutes are revealed, so this is a no-op except after a rewind within it.
  const start =
    from && from.time === target.time
      ? {
          close: Math.min(target.high, Math.max(target.low, from.close)),
          high: Math.min(target.high, Math.max(target.low, from.high)),
          low: Math.min(target.high, Math.max(target.low, from.low)),
          volume: Math.min(target.volume, from.volume),
        }
      : { close: target.open, high: target.open, low: target.open, volume: 0 }
  const close = lerp(start.close, target.close, t)
  const high = Math.min(target.high, Math.max(lerp(start.high, target.high, t), target.open, close))
  const low = Math.max(target.low, Math.min(lerp(start.low, target.low, t), target.open, close))
  return {
    time: target.time,
    open: target.open,
    high,
    low,
    close,
    volume: Math.round(lerp(start.volume, target.volume, t)),
  }
}

// How long one glide takes: a fraction of the time between steps (so it settles
// before the next one arrives) and never longer than the motion budget.
export const SMOOTH_MAX_MS = 180
export function smoothDurationMs(stepsPerSecond: number): number {
  if (!(stepsPerSecond > 0)) return 0
  return Math.min(SMOOTH_MAX_MS, Math.round((1000 / stepsPerSecond) * 0.8))
}
