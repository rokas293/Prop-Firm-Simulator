// The replay camera's "don't move when a bar is revealed" math, kept pure
// and framework-free so it's unit-testable without mounting a chart (same
// pattern as chart/replay.ts and chart/tradeBracket.ts).
//
// WHY THIS EXISTS: klinecharts v10 has no setDataList, so revealing a bar
// means resetData(), which unconditionally recomputes the scroll offset
// from a fixed right-side distance -- the camera snaps. ChartKL therefore
// captures the viewport before resetData() and restores it after.
//
// The restore MUST be done in klinecharts' own DATA-INDEX space, not in
// time. The previous implementation captured the visible range's midpoint
// TIMESTAMP and fed it to scrollToTimestamp(), which looks reasonable but
// is wrong twice over:
//
//   1. scrollToTimestamp() does NOT center the timestamp -- it resolves it
//      to the nearest bar and pins that bar to the RIGHT EDGE (it forwards
//      to scrollToDataIndex, whose own arithmetic sets
//      lastBarRightSideDiffBarCount = dataIndex - (length - 1)). Handing it
//      the midpoint therefore scrolled the view back by half a viewport on
//      EVERY replay step, measured at ~55-60 bars per step against a ~120
//      bar viewport, until it hit the left scroll limit and stuck there
//      showing the first couple of bars of the fetched window.
//   2. Bars are evenly spaced in INDEX space but not in TIME (session
//      breaks, weekends), so a midpoint in time isn't the midpoint on
//      screen anyway.
//
// Working in index space sidesteps both: revealing a bar APPENDS to the
// data list, so every already-loaded bar keeps its index, and holding the
// right-edge index fixed holds the whole view fixed -- including any empty
// space right of the last bar, which simply absorbs the new bar.

// scrollToDataIndex(i) leaves klinecharts' own visible range at
// realTo = round(i + 1.5) = i + 2 (from StoreImp._adjustVisibleRange:
// realTo = round(lastBarRightSideDiffBarCount + totalBarCount + 0.5), with
// diff = i - (totalBarCount - 1)). So to land a desired exclusive
// right-edge index R, scrollToDataIndex is handed R - 2.
const RIGHT_EDGE_INDEX_OFFSET = 2

export interface CameraRestoreInput {
  // klinecharts' VisibleRange.realTo BEFORE the reload: the exclusive
  // data-index of the viewport's right edge, which may sit past the last
  // bar when the user has scrolled empty space into view.
  beforeRealTo: number
  // First bar's timestamp before/after the reload -- the cheap check for
  // "this was a plain append" (see below).
  beforeFirstBarTime: number | null
  afterFirstBarTime: number | null
  afterBarCount: number
  followLatestBar: boolean
}

// Returns the dataIndex to hand scrollToDataIndex, or null to leave the
// camera untouched.
export function cameraRestoreIndex(input: CameraRestoreInput): number | null {
  const { beforeRealTo, beforeFirstBarTime, afterFirstBarTime, afterBarCount, followLatestBar } = input
  if (afterBarCount <= 0) return null
  // A genuine WINDOW change (the fetch window re-anchored as replay ran off
  // the end of the loaded bars) prepends history, which shifts every index
  // -- restoring one here would yank the view somewhere arbitrary. Detected
  // by the first bar's timestamp changing; in that case the camera belongs
  // to the window-change fit instead (SessionWorkspace's defaultFitWindow),
  // so this hands it over by doing nothing.
  if (beforeFirstBarTime === null || afterFirstBarTime === null || beforeFirstBarTime !== afterFirstBarTime) return null

  // "Follow latest bar" ON and the newly revealed bar landed at or past the
  // old right edge: shift by exactly enough to bring it flush to the edge,
  // never a hard recenter. OFF (or nothing new past the edge): hold the
  // right edge exactly where the user left it.
  const lastBarIndex = afterBarCount - 1
  const targetRealTo = followLatestBar && lastBarIndex >= beforeRealTo ? afterBarCount : beforeRealTo
  return targetRealTo - RIGHT_EDGE_INDEX_OFFSET
}

// ---- window re-anchor (long replays) ---------------------------------------
//
// When a long replay nears the end of the fetched window the workspace
// re-anchors the window on the cursor, so the data list is REPLACED by one
// that starts at a different time. Indices from the old list mean nothing in
// the new one (the cursor bar moves from ~index 2980 to ~index 900), and a
// plain init reload resets the scroll to klinecharts' default right-side
// distance -- which, followed by a refit to a default window, was the visible
// hop. The bars themselves are the same bars, though, so the view is
// preserved in TIME space instead: remember which bar sat at the right edge
// (plus any empty space past the last bar), find that bar in the new list,
// and put the right edge back on it.

export interface ViewAnchor {
  // Timestamp of the bar at (or last bar before) the viewport's right edge.
  time: number
  // Empty bars of space between the last bar and the right edge (0 when the
  // edge is on or before the last bar).
  extraBars: number
}

// `times` are the loaded bars' timestamps, in order; `realTo` is the
// exclusive right-edge index (klinecharts' VisibleRange.realTo).
export function captureViewAnchor(times: readonly number[], realTo: number): ViewAnchor | null {
  if (times.length === 0) return null
  if (realTo > times.length) return { time: times[times.length - 1], extraBars: realTo - times.length }
  const edge = Math.max(0, realTo - 1)
  return { time: times[edge], extraBars: 0 }
}

// The dataIndex to hand scrollToDataIndex for the NEW list, or null when there
// is nothing to restore against. Three cases:
//   - the anchored bar is still loaded: put it (plus any empty space) back at
//     the right edge -- the exact view, same zoom;
//   - it is NOT loaded (the new window starts after it, e.g. the user was
//     panned far back): snap the cursor -- the last bar of a replay-filtered
//     list -- flush to the right edge, zoom unchanged, never window index 0;
//   - follow-latest is on and the newest bar sits past the restored edge
//     (the anchor was captured before this step's bar was revealed): apply
//     the follow nudge here, so the newest bar is never out of view.
export function reanchorRestoreIndex(
  anchor: ViewAnchor | null,
  afterTimes: readonly number[],
  followLatestBar = false,
): number | null {
  if (!anchor || afterTimes.length === 0) return null
  const lastIndex = afterTimes.length - 1
  let targetRealTo: number
  if (anchor.time < afterTimes[0]) {
    targetRealTo = afterTimes.length
  } else {
    // Last bar at or before the anchor time (binary search; times ascend).
    let lo = 0
    let hi = lastIndex
    let found = 0
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (afterTimes[mid] <= anchor.time) {
        found = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    targetRealTo = found + 1 + anchor.extraBars
    if (followLatestBar && lastIndex >= targetRealTo) targetRealTo = afterTimes.length
  }
  return targetRealTo - RIGHT_EDGE_INDEX_OFFSET
}
