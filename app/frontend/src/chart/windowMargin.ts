// Smoothness (POLISH_ROADMAP Phase P2): fetch the target window plus a
// fixed margin on each side, so ordinary panning inside that margin never
// needs a refetch at all. Deliberately NOT reactive (no pan-event-driven
// re-fetching) -- that was tried in an earlier phase and reverted after it
// caused spurious fetches indistinguishable from genuine user pans
// (Lightweight Charts fires the same "visible range changed" event for
// both a real drag and an internal auto-range from setData/fitRange). A
// static margin gets most of the smoothness benefit with none of that risk.
export interface TimeWindow {
  from: number
  to: number
}

const MARGIN_RATIO = 0.5

export function withMargin(window: TimeWindow, marginRatio: number = MARGIN_RATIO): TimeWindow {
  const span = window.to - window.from
  const margin = Math.max(0, span * marginRatio)
  return { from: window.from - margin, to: window.to + margin }
}
