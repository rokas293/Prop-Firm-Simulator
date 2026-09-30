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
