import { beforeEach, describe, expect, it } from 'vitest'
import { useChartViewStore } from './chartViewStore'

const INITIAL = {
  viewMode: 'trade' as const,
  explicitDayWindow: null,
  replayActive: false,
  cursorIndex: 0,
  isPlaying: false,
  speed: 1,
  followLatestBar: false,
}

beforeEach(() => {
  useChartViewStore.setState(INITIAL)
})

describe('view mode transitions', () => {
  it('selectTradeView returns to trade mode and clears any explicit day window', () => {
    useChartViewStore.getState().selectExplicitDay({ from: 1, to: 2 })
    useChartViewStore.getState().selectTradeView()
    expect(useChartViewStore.getState()).toMatchObject({ viewMode: 'trade', explicitDayWindow: null })
  })

  it('selectFullDay switches to day mode but leaves the window derivation to the caller (null)', () => {
    useChartViewStore.getState().selectFullDay()
    expect(useChartViewStore.getState()).toMatchObject({ viewMode: 'day', explicitDayWindow: null })
  })

  it('selectExplicitDay switches to day mode and stores the given window', () => {
    useChartViewStore.getState().selectExplicitDay({ from: 100, to: 200 })
    expect(useChartViewStore.getState()).toMatchObject({
      viewMode: 'day',
      explicitDayWindow: { from: 100, to: 200 },
    })
  })

  it('a later selectTradeView overrides an earlier selectExplicitDay window', () => {
    useChartViewStore.getState().selectExplicitDay({ from: 100, to: 200 })
    useChartViewStore.getState().selectTradeView()
    expect(useChartViewStore.getState().explicitDayWindow).toBeNull()
    expect(useChartViewStore.getState().viewMode).toBe('trade')
  })
})

describe('replay toggling', () => {
  it('toggleReplay flips replayActive and always resets cursor/playing state', () => {
    useChartViewStore.setState({ cursorIndex: 7, isPlaying: true })
    useChartViewStore.getState().toggleReplay()
    expect(useChartViewStore.getState()).toMatchObject({ replayActive: true, cursorIndex: 0, isPlaying: false })
  })

  it('toggling twice returns replayActive to false, still resetting cursor/playing', () => {
    useChartViewStore.getState().toggleReplay()
    useChartViewStore.setState({ cursorIndex: 3, isPlaying: true })
    useChartViewStore.getState().toggleReplay()
    expect(useChartViewStore.getState()).toMatchObject({ replayActive: false, cursorIndex: 0, isPlaying: false })
  })
})

describe('cursor stepping', () => {
  it('setCursorIndex sets the index and stops playback', () => {
    useChartViewStore.setState({ isPlaying: true })
    useChartViewStore.getState().setCursorIndex(5)
    expect(useChartViewStore.getState()).toMatchObject({ cursorIndex: 5, isPlaying: false })
  })

  it('advanceCursor steps forward by one while below maxIndex', () => {
    useChartViewStore.setState({ cursorIndex: 2 })
    useChartViewStore.getState().advanceCursor(10)
    expect(useChartViewStore.getState().cursorIndex).toBe(3)
  })

  it('advanceCursor stops playback instead of overrunning once at maxIndex', () => {
    useChartViewStore.setState({ cursorIndex: 10, isPlaying: true })
    useChartViewStore.getState().advanceCursor(10)
    expect(useChartViewStore.getState()).toMatchObject({ cursorIndex: 10, isPlaying: false })
  })

  it('advanceCursor also stops playback if somehow already past maxIndex', () => {
    useChartViewStore.setState({ cursorIndex: 15, isPlaying: true })
    useChartViewStore.getState().advanceCursor(10)
    expect(useChartViewStore.getState()).toMatchObject({ cursorIndex: 15, isPlaying: false })
  })

  it('resetCursorForNewBars zeroes the cursor and stops playback regardless of prior state', () => {
    useChartViewStore.setState({ cursorIndex: 42, isPlaying: true })
    useChartViewStore.getState().resetCursorForNewBars()
    expect(useChartViewStore.getState()).toMatchObject({ cursorIndex: 0, isPlaying: false })
  })
})

describe('setIsPlaying / setSpeed', () => {
  it('setIsPlaying sets playback without touching the cursor', () => {
    useChartViewStore.setState({ cursorIndex: 4 })
    useChartViewStore.getState().setIsPlaying(true)
    expect(useChartViewStore.getState()).toMatchObject({ isPlaying: true, cursorIndex: 4 })
  })

  it('setSpeed updates the playback speed', () => {
    useChartViewStore.getState().setSpeed(4)
    expect(useChartViewStore.getState().speed).toBe(4)
  })
})

describe('toggleFollowLatestBar', () => {
  it('starts off (TradingView-style: stepping never touches the camera unless opted in)', () => {
    expect(useChartViewStore.getState().followLatestBar).toBe(false)
  })

  it('flips on, then back off', () => {
    useChartViewStore.getState().toggleFollowLatestBar()
    expect(useChartViewStore.getState().followLatestBar).toBe(true)
    useChartViewStore.getState().toggleFollowLatestBar()
    expect(useChartViewStore.getState().followLatestBar).toBe(false)
  })
})

describe('resetForNewRun', () => {
  it('resets every field to its initial value, regardless of prior state', () => {
    useChartViewStore.setState({
      viewMode: 'day',
      explicitDayWindow: { from: 1, to: 2 },
      replayActive: true,
      cursorIndex: 9,
      isPlaying: true,
      speed: 8,
      followLatestBar: true,
    })
    useChartViewStore.getState().resetForNewRun()
    expect(useChartViewStore.getState()).toMatchObject({
      viewMode: 'trade',
      explicitDayWindow: null,
      replayActive: false,
      cursorIndex: 0,
      isPlaying: false,
    })
    // speed/followLatestBar are deliberately NOT reset -- user preferences, not per-run state.
    expect(useChartViewStore.getState().speed).toBe(8)
    expect(useChartViewStore.getState().followLatestBar).toBe(true)
  })
})
