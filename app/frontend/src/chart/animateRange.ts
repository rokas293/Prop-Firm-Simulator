// Pure easing/interpolation math for the "ease the viewport to a trade"
// animation (POLISH_ROADMAP Phase P3: "a subtle animation... eases the
// viewport to it rather than snapping"). Framework/chart-free on purpose --
// PriceChart.tsx drives an actual requestAnimationFrame loop using these,
// calling chart.timeScale().setVisibleRange() once per frame.
export interface TimeRange {
  from: number
  to: number
}

export function easeOutCubic(t: number): number {
  const clamped = Math.min(1, Math.max(0, t))
  return 1 - Math.pow(1 - clamped, 3)
}

export function interpolateRange(from: TimeRange, to: TimeRange, t: number): TimeRange {
  const eased = easeOutCubic(t)
  return {
    from: from.from + (to.from - from.from) * eased,
    to: from.to + (to.to - from.to) * eased,
  }
}
