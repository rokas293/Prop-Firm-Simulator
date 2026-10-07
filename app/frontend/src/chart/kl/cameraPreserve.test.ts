import { describe, expect, it } from 'vitest'
import { cameraRestoreIndex, captureViewAnchor, firstViewPlan, reanchorRestoreIndex, rightMarginForPane } from './cameraPreserve'

// A faithful model of the two pieces of klinecharts v10.0.3 arithmetic the
// camera restore rides on, transcribed from the library source so this test
// asserts against the REAL geometry rather than against our own helper's
// opinion of it:
//
//   ChartImp.scrollToDataIndex(i):
//     distance = (diff + (len - 1 - i)) * barSpace ; scroll(distance)
//   StoreImp.scroll(distance):
//     diff = diffAtScrollStart - distance / barSpace
//     (scrollByDistance calls startScroll() first, so diffAtScrollStart is
//     simply the current diff -- the two terms cancel to diff = i - (len-1))
//   StoreImp._adjustVisibleRange():
//     realTo = round(diff + len + 0.5)
//     to     = min(realTo, len)
//     from   = max(0, round(to - visibleBarCount) - 1)
//
// `diff` is klinecharts' _lastBarRightSideDiffBarCount: bar-widths of space
// to the RIGHT of the last bar (negative when the last bar sits off-screen
// past the right edge).
class ChartModel {
  diff: number
  constructor(
    public barCount: number,
    public visibleBarCount: number,
    rightEdgeIndexExclusive: number,
  ) {
    this.diff = rightEdgeIndexExclusive - this.barCount - 0.5
  }

  get realTo(): number {
    return Math.round(this.diff + this.barCount + 0.5)
  }

  get visibleRange(): { from: number; to: number; realTo: number } {
    const realTo = this.realTo
    const to = Math.min(realTo, this.barCount)
    const from = Math.max(0, Math.round(to - this.visibleBarCount) - 1)
    return { from, to, realTo }
  }

  appendBar(): void {
    this.barCount += 1
  }

  scrollToDataIndex(i: number): void {
    this.diff = i - (this.barCount - 1)
  }
}

// The bug this file exists to prevent: the previous implementation took the
// visible range's midpoint and handed it to scrollToTimestamp, which pins
// that point to the RIGHT EDGE rather than centering it.
function legacyMidpointRestoreIndex(range: { from: number; to: number }): number {
  return Math.round((range.from + range.to) / 2)
}

const VISIBLE = 120

function freshChart(barCount = 500): ChartModel {
  // Camera parked with the last bar flush at the right edge.
  return new ChartModel(barCount, VISIBLE, barCount)
}

describe('cameraRestoreIndex -- replay camera across many steps', () => {
  it('holds the viewport perfectly still over 200 steps with follow off', () => {
    const chart = freshChart()
    const firstBarTime = 1_000
    const initial = chart.visibleRange

    for (let step = 0; step < 200; step++) {
      const before = chart.visibleRange
      chart.appendBar()
      const idx = cameraRestoreIndex({
        beforeRealTo: before.realTo,
        beforeFirstBarTime: firstBarTime,
        afterFirstBarTime: firstBarTime,
        afterBarCount: chart.barCount,
        followLatestBar: false,
      })
      expect(idx).not.toBeNull()
      chart.scrollToDataIndex(idx as number)
    }

    // Not "roughly stable" -- byte-identical to where it started.
    expect(chart.visibleRange.from).toBe(initial.from)
    expect(chart.visibleRange.to).toBe(initial.to)
    expect(chart.visibleRange.realTo).toBe(initial.realTo)
  })

  it('keeps the current bar (and therefore the current price) in view over 200 steps with follow on', () => {
    const chart = freshChart()
    const firstBarTime = 1_000

    for (let step = 0; step < 200; step++) {
      const before = chart.visibleRange
      chart.appendBar()
      const idx = cameraRestoreIndex({
        beforeRealTo: before.realTo,
        beforeFirstBarTime: firstBarTime,
        afterFirstBarTime: firstBarTime,
        afterBarCount: chart.barCount,
        followLatestBar: true,
      })
      chart.scrollToDataIndex(idx as number)

      const lastBarIndex = chart.barCount - 1
      const { from, to } = chart.visibleRange
      expect(lastBarIndex).toBeGreaterThanOrEqual(from)
      expect(lastBarIndex).toBeLessThan(to)
    }
  })

  // The literal assertion the regression brief asks for: build a price
  // series, derive the visible price range the way an auto-scaled y-axis
  // does (min low / max high of the VISIBLE bars), and require the current
  // price to sit inside it after N steps.
  it('the visible price range still contains the current price after 200 steps (follow on)', () => {
    const chart = freshChart()
    const firstBarTime = 1_000
    // A trending series, so a camera left behind would quickly be looking at
    // a price band that no longer contains the current price.
    const price = (i: number) => 4500 + i * 0.5
    const lows: number[] = []
    const highs: number[] = []
    for (let i = 0; i < chart.barCount; i++) {
      lows.push(price(i) - 2)
      highs.push(price(i) + 2)
    }

    for (let step = 0; step < 200; step++) {
      const before = chart.visibleRange
      chart.appendBar()
      lows.push(price(chart.barCount - 1) - 2)
      highs.push(price(chart.barCount - 1) + 2)
      const idx = cameraRestoreIndex({
        beforeRealTo: before.realTo,
        beforeFirstBarTime: firstBarTime,
        afterFirstBarTime: firstBarTime,
        afterBarCount: chart.barCount,
        followLatestBar: true,
      })
      chart.scrollToDataIndex(idx as number)
    }

    const { from, to } = chart.visibleRange
    const visibleLow = Math.min(...lows.slice(from, to))
    const visibleHigh = Math.max(...highs.slice(from, to))
    const currentPrice = price(chart.barCount - 1)
    expect(currentPrice).toBeGreaterThanOrEqual(visibleLow)
    expect(currentPrice).toBeLessThanOrEqual(visibleHigh)
  })

  it('REGRESSION: the old midpoint restore walked the camera backwards ~half a viewport per step', () => {
    const chart = freshChart()
    const startFrom = chart.visibleRange.from

    for (let step = 0; step < 5; step++) {
      const before = chart.visibleRange
      chart.appendBar()
      chart.scrollToDataIndex(legacyMidpointRestoreIndex(before))
    }

    // Five steps was enough to throw the view most of a viewport into the
    // past -- and the real chart kept going until it hit the scroll limit,
    // stranding the user on the first bars of the fetched window.
    const drift = startFrom - chart.visibleRange.from
    expect(drift).toBeGreaterThan(VISIBLE * 2)
    // The current bar is nowhere near the viewport any more.
    expect(chart.barCount - 1).toBeGreaterThanOrEqual(chart.visibleRange.to)
  })

  it('hands the camera over (returns null) when the fetch window re-anchored and prepended history', () => {
    // A window re-anchor changes the first bar's timestamp; indices are no
    // longer comparable, so the window-change fit owns the camera instead.
    expect(
      cameraRestoreIndex({
        beforeRealTo: 500,
        beforeFirstBarTime: 1_000,
        afterFirstBarTime: 500, // earlier history prepended
        afterBarCount: 900,
        followLatestBar: false,
      }),
    ).toBeNull()
  })

  it('leaves the camera alone when there is no data to restore against', () => {
    expect(
      cameraRestoreIndex({
        beforeRealTo: 10,
        beforeFirstBarTime: null,
        afterFirstBarTime: null,
        afterBarCount: 0,
        followLatestBar: false,
      }),
    ).toBeNull()
  })

  it('does not yank the view forward while the new bar is still comfortably inside it (follow on)', () => {
    // Right edge parked well past the last bar (empty space to the right):
    // the newly revealed bar lands in that space, so nothing should move.
    const chart = new ChartModel(500, VISIBLE, 510)
    const before = chart.visibleRange
    chart.appendBar()
    const idx = cameraRestoreIndex({
      beforeRealTo: before.realTo,
      beforeFirstBarTime: 1_000,
      afterFirstBarTime: 1_000,
      afterBarCount: chart.barCount,
      followLatestBar: true,
    })
    chart.scrollToDataIndex(idx as number)
    expect(chart.visibleRange.realTo).toBe(before.realTo)
  })
})

// A long replay re-anchors the fetch window on the cursor: the data list is
// replaced by one starting at a different time, so the cursor bar's index
// jumps (here 2980 -> 900). The view must stay on the same bars.
describe('window re-anchor -- no camera jump in a long replay', () => {
  const BAR = 300
  const times = (startIdx: number, count: number) => Array.from({ length: count }, (_, i) => (startIdx + i) * BAR)

  const oldBars = times(0, 3000) // cursor bar is index 2980
  const newBars = times(2980 - 900, 3000) // re-anchored: cursor bar is now index 900

  // The times at the left and right edge of what is on screen.
  const edgesInTime = (model: ChartModel, list: number[]) => {
    const { from, realTo } = model.visibleRange
    return { fromTime: list[from], toTime: list[Math.min(realTo, list.length) - 1] }
  }

  it('keeps the same bars on screen with the cursor at the right edge', () => {
    const before = new ChartModel(oldBars.length, VISIBLE, 2981)
    const beforeEdges = edgesInTime(before, oldBars)

    const anchor = captureViewAnchor(oldBars, before.visibleRange.realTo)
    const after = new ChartModel(newBars.length, VISIBLE, newBars.length) // an init reload resets the scroll
    after.scrollToDataIndex(reanchorRestoreIndex(anchor, newBars) as number)

    expect(edgesInTime(after, newBars)).toEqual(beforeEdges)
    expect(after.visibleRange.realTo).toBe(901)
  })

  it('preserves empty space scrolled in to the right of the cursor', () => {
    const clipped = oldBars.slice(0, 2981)
    const before = new ChartModel(clipped.length, VISIBLE, clipped.length + 15)
    const anchor = captureViewAnchor(clipped, before.visibleRange.realTo)
    expect(anchor).toEqual({ time: clipped[2980], extraBars: 15 })

    const newClipped = newBars.slice(0, 901)
    const after = new ChartModel(newClipped.length, VISIBLE, newClipped.length)
    after.scrollToDataIndex(reanchorRestoreIndex(anchor, newClipped) as number)
    expect(after.visibleRange.realTo).toBe(newClipped.length + 15)
  })

  it('REGRESSION: without a time-anchored restore the reloaded view is on different bars (the hop)', () => {
    const before = new ChartModel(oldBars.length, VISIBLE, 2981)
    const beforeEdges = edgesInTime(before, oldBars)
    // cameraRestoreIndex deliberately hands a changed window to someone else...
    expect(
      cameraRestoreIndex({
        beforeRealTo: before.visibleRange.realTo,
        beforeFirstBarTime: oldBars[0],
        afterFirstBarTime: newBars[0],
        afterBarCount: newBars.length,
        followLatestBar: false,
      }),
    ).toBeNull()
    // ...and an untouched init reload leaves the camera on a different span.
    const untouched = new ChartModel(newBars.length, VISIBLE, newBars.length)
    expect(edgesInTime(untouched, newBars)).not.toEqual(beforeEdges)
  })

  // Re-anchor window shape: the cursor (time index 2980) sits 0 bars from the
  // far end of the replay-filtered list, with ~2800 bars of history behind it.
  const reAnchored = (lastTimeIdx: number) => times(2980 - 2799, lastTimeIdx - (2980 - 2799) + 1)

  it('follow off, view panned far behind but still loaded: restores the EXACT view', () => {
    // User's right edge sat 400 bars behind the cursor in the old list.
    const before = new ChartModel(oldBars.length, VISIBLE, 2981 - 400)
    const beforeEdges = edgesInTime(before, oldBars)
    const anchor = captureViewAnchor(oldBars, before.visibleRange.realTo)
    const list = reAnchored(2980)
    const after = new ChartModel(list.length, VISIBLE, list.length)
    after.scrollToDataIndex(reanchorRestoreIndex(anchor, list, false) as number)
    expect(edgesInTime(after, list)).toEqual(beforeEdges)
  })

  it('follow off, view bars no longer loaded: snaps the cursor to the right edge, zoom unchanged, never index 0', () => {
    // Right edge 2500 bars behind the cursor -- before the new (shorter) window starts.
    const before = new ChartModel(oldBars.length, VISIBLE, 2981 - 2500)
    const anchor = captureViewAnchor(oldBars, before.visibleRange.realTo)
    const list = times(2980 - 1000, 1001)
    const after = new ChartModel(list.length, VISIBLE, list.length)
    after.scrollToDataIndex(reanchorRestoreIndex(anchor, list, false) as number)
    expect(after.visibleRange.realTo).toBe(list.length) // cursor bar flush right
    expect(after.visibleRange.from).toBeGreaterThan(0)
    expect(after.visibleBarCount).toBe(VISIBLE) // zoom untouched
  })

  it('follow on: the newest bar is brought into view in the same step (no 1-bar lag)', () => {
    // Anchor captured BEFORE this step's bar (time 2981) was revealed: right edge = previous cursor bar.
    const prev = oldBars.slice(0, 2981)
    const anchor = captureViewAnchor(prev, prev.length)
    const list = reAnchored(2981)
    const after = new ChartModel(list.length, VISIBLE, list.length)
    after.scrollToDataIndex(reanchorRestoreIndex(anchor, list, true) as number)
    expect(after.visibleRange.realTo).toBe(list.length) // newest bar is the right edge
    // Without follow the newest bar is left one bar past the edge (the old lag).
    const lag = new ChartModel(list.length, VISIBLE, list.length)
    lag.scrollToDataIndex(reanchorRestoreIndex(anchor, list, false) as number)
    expect(lag.visibleRange.realTo).toBe(list.length - 1)
  })

  it('returns null with nothing to restore against', () => {
    expect(captureViewAnchor([], 10)).toBeNull()
    expect(reanchorRestoreIndex(null, newBars)).toBeNull()
    expect(reanchorRestoreIndex({ time: 0, extraBars: 0 }, [])).toBeNull()
  })
})

// FXR_V2_SPEC.md G2: the session chart keeps empty space to the right of the
// newest bar so order labels never cover recent price. The camera must hold
// that margin while following, hold the exact view when not, and survive a
// window re-anchor -- the same guarantees as the flush camera above.
describe('right margin (order-label room)', () => {
  const MARGIN = 40
  const firstBarTime = 1_000
  const marginChart = (barCount = 500) => new ChartModel(barCount, VISIBLE, barCount + MARGIN)

  it('follow on: the margin never erodes over 200 steps and the newest bar stays in view', () => {
    const chart = marginChart()
    for (let step = 0; step < 200; step++) {
      const before = chart.visibleRange
      chart.appendBar()
      const idx = cameraRestoreIndex({
        beforeRealTo: before.realTo,
        beforeFirstBarTime: firstBarTime,
        afterFirstBarTime: firstBarTime,
        afterBarCount: chart.barCount,
        followLatestBar: true,
        rightMarginBars: MARGIN,
      })
      chart.scrollToDataIndex(idx as number)
      expect(chart.visibleRange.realTo - chart.barCount).toBe(MARGIN) // exactly MARGIN empty bars to the right
      expect(chart.barCount - 1).toBeLessThan(chart.visibleRange.to)
    }
  })

  it('follow off: the right edge is byte-identical after 200 steps (the margin simply absorbs the new bars)', () => {
    const chart = marginChart()
    const initial = chart.visibleRange
    for (let step = 0; step < 200; step++) {
      const before = chart.visibleRange
      chart.appendBar()
      const idx = cameraRestoreIndex({
        beforeRealTo: before.realTo,
        beforeFirstBarTime: firstBarTime,
        afterFirstBarTime: firstBarTime,
        afterBarCount: chart.barCount,
        followLatestBar: false,
        rightMarginBars: MARGIN,
      })
      chart.scrollToDataIndex(idx as number)
    }
    // The edge never moves; the 200 new bars filled the margin (`to` is clamped
    // to the bar count, so only realTo -- the true edge -- is compared).
    expect(chart.visibleRange.realTo).toBe(initial.realTo)
    expect(chart.visibleRange.realTo - VISIBLE).toBe(initial.realTo - VISIBLE)
  })

  it('zero margin is exactly the old flush behaviour', () => {
    const a = freshChart()
    const b = freshChart()
    for (let step = 0; step < 50; step++) {
      const beforeA = a.visibleRange
      const beforeB = b.visibleRange
      a.appendBar()
      b.appendBar()
      const base = { beforeFirstBarTime: firstBarTime, afterFirstBarTime: firstBarTime, followLatestBar: true }
      a.scrollToDataIndex(cameraRestoreIndex({ ...base, beforeRealTo: beforeA.realTo, afterBarCount: a.barCount }) as number)
      b.scrollToDataIndex(cameraRestoreIndex({ ...base, beforeRealTo: beforeB.realTo, afterBarCount: b.barCount, rightMarginBars: 0 }) as number)
    }
    expect(a.visibleRange).toEqual(b.visibleRange)
  })

  it('follow off: a view panned back into history stays exactly where the user left it', () => {
    const chart = new ChartModel(500, VISIBLE, 400)
    const before = chart.visibleRange
    chart.appendBar()
    const idx = cameraRestoreIndex({
      beforeRealTo: before.realTo,
      beforeFirstBarTime: firstBarTime,
      afterFirstBarTime: firstBarTime,
      afterBarCount: chart.barCount,
      followLatestBar: false,
      rightMarginBars: MARGIN,
    })
    chart.scrollToDataIndex(idx as number)
    expect(chart.visibleRange.realTo).toBe(before.realTo)
  })

  it('a window re-anchor restores the same margin (view held in time, follow on or off)', () => {
    const old = Array.from({ length: 3000 }, (_, i) => 1_000 + i)
    const before = new ChartModel(old.length, VISIBLE, old.length + MARGIN)
    const anchor = captureViewAnchor(old, before.visibleRange.realTo)
    expect(anchor).toEqual({ time: old[old.length - 1], extraBars: MARGIN })
    const list = old.slice(500) // the window's history was trimmed in front; the last bar is the same
    const after = new ChartModel(list.length, VISIBLE, list.length)
    for (const follow of [false, true]) {
      after.scrollToDataIndex(reanchorRestoreIndex(anchor, list, follow, MARGIN) as number)
      expect(after.visibleRange.realTo - list.length).toBe(MARGIN)
    }
  })

  it('a re-anchor whose view bars are gone snaps the cursor to the edge WITH the margin', () => {
    const anchor = { time: 0, extraBars: 0 }
    const list = Array.from({ length: 800 }, (_, i) => 5_000 + i)
    const after = new ChartModel(list.length, VISIBLE, list.length)
    after.scrollToDataIndex(reanchorRestoreIndex(anchor, list, false, MARGIN) as number)
    expect(after.visibleRange.realTo - list.length).toBe(MARGIN)
  })
})

describe('rightMarginForPane (proportional margin)', () => {
  it('is the configured width on a wide pane', () => {
    expect(rightMarginForPane(400, 3000)).toBe(400)
    expect(rightMarginForPane(400, 2000)).toBe(400) // exactly 20% of 2000
  })

  it('is capped at 20% of the pane so a narrow pane keeps its space for price', () => {
    expect(rightMarginForPane(400, 1500)).toBe(300)
    expect(rightMarginForPane(400, 1135)).toBe(227) // journal open
    expect(rightMarginForPane(400, 600)).toBe(120)
  })

  it('falls back to the configured width when the pane has no size yet', () => {
    expect(rightMarginForPane(400, undefined)).toBe(400)
    expect(rightMarginForPane(400, 0)).toBe(400)
  })
})

describe('firstViewPlan (a session opens with the cursor bar in view and the margin applied)', () => {
  it('parks the newest bar the margin short of the right edge at the chosen zoom', () => {
    const plan = firstViewPlan({ paneWidth: 1500, marginPx: 120, barCount: 3000, visibleBars: 120 })!
    expect(plan.barSpace).toBeCloseTo(12.5)
    expect(plan.marginBars).toBe(10) // ceil(120 / 12.5) = 9.6 -> 10
    // scrollToDataIndex(i) leaves the right edge at i + 2: edge = bars + margin bars.
    expect(plan.scrollIndex + 2).toBe(3000 + 10)
  })

  it('always has the newest bar in view: the right edge is at or past the bar count', () => {
    for (const barCount of [1, 2, 60, 120, 3000]) {
      for (const marginPx of [0, 96, 120, 300]) {
        const plan = firstViewPlan({ paneWidth: 1400, marginPx, barCount, visibleBars: 120 })!
        expect(plan.scrollIndex + 2).toBeGreaterThanOrEqual(barCount)
        expect(plan.scrollIndex + 2 - barCount).toBe(plan.marginBars)
      }
    }
  })

  it('no margin configured = flush to the edge', () => {
    const plan = firstViewPlan({ paneWidth: 1400, marginPx: 0, barCount: 500, visibleBars: 120 })!
    expect(plan.marginBars).toBe(0)
    expect(plan.scrollIndex + 2).toBe(500)
  })

  it('the margin in pixels is honoured whatever the zoom (never rounds down)', () => {
    for (const visibleBars of [30, 120, 400]) {
      const plan = firstViewPlan({ paneWidth: 1400, marginPx: 120, barCount: 1000, visibleBars })!
      expect(plan.marginBars * plan.barSpace).toBeGreaterThanOrEqual(120)
    }
  })

  it('has nothing to place before there are bars or a width', () => {
    expect(firstViewPlan({ paneWidth: 1400, marginPx: 120, barCount: 0, visibleBars: 120 })).toBeNull()
    expect(firstViewPlan({ paneWidth: 0, marginPx: 120, barCount: 100, visibleBars: 120 })).toBeNull()
    expect(firstViewPlan({ paneWidth: 1400, marginPx: 120, barCount: 100, visibleBars: 0 })).toBeNull()
  })
})
