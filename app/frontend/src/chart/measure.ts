// Pure measure-tool math (POLISH_ROADMAP Phase P2: "price %/points + bars
// + time"). Bars-between is counted from the actual loaded bars array
// (not estimated from elapsed time / a nominal bar size), so it's exact
// even across the sparse gaps CLAUDE.md describes for ZN and non-RTH hours.
import type { Bar } from '../api/types'

export interface MeasurePoint {
  time: number
  price: number
}

export interface MeasureResult {
  points: number // signed: p2.price - p1.price
  percent: number // signed, relative to p1.price
  bars: number // count of loaded bars within [min(time), max(time)], inclusive
  seconds: number // unsigned elapsed time
}

export function computeMeasure(p1: MeasurePoint, p2: MeasurePoint, bars: Bar[]): MeasureResult {
  const points = p2.price - p1.price
  const percent = p1.price !== 0 ? (points / p1.price) * 100 : 0
  const seconds = Math.abs(p2.time - p1.time)
  const tMin = Math.min(p1.time, p2.time)
  const tMax = Math.max(p1.time, p2.time)
  const barCount = bars.reduce((n, b) => (b.time >= tMin && b.time <= tMax ? n + 1 : n), 0)
  return { points, percent, bars: barCount, seconds }
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remMinutes = minutes % 60
  if (hours < 24) return remMinutes > 0 ? `${hours}h ${remMinutes}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  const remHours = hours % 24
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`
}
