import { describe, expect, it } from 'vitest'
import { cameraRestoreIndex } from './cameraPreserve'

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
