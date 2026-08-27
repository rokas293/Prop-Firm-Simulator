import { create } from 'zustand'

// Chart-display state that used to live as local useState inside the old
// single ChartPage component. Lifted into a store (POLISH_ROADMAP Phase P1)
// because the Chart and Trade List are now independent dockable panels with
// no parent/child relationship -- they can only coordinate through shared
// state, the same pattern already used for cross-panel actions elsewhere
// (tradeStore's filters, uiStore's day-jump).

export type ChartViewMode = 'trade' | 'day'

export interface TimeWindow {
  from: number
  to: number
}

interface ChartViewState {
  viewMode: ChartViewMode
  // Set by the Risk panel's day-jump (a trading day, not necessarily tied
  // to any one trade) -- takes priority over the trade-derived day window.
  explicitDayWindow: TimeWindow | null

  replayActive: boolean
  cursorIndex: number
  isPlaying: boolean
  speed: number

  /** Picking a trade (Trade List row, next/prev, keyboard) always returns to a plain trade-centered view. */
  selectTradeView: () => void
  /** The "Full day" button: show the selected trade's whole CME trading day. */
  selectFullDay: () => void
  /** The Risk panel's day-jump: an explicit day window, independent of any trade. */
  selectExplicitDay: (window: TimeWindow) => void

  toggleReplay: () => void
  setCursorIndex: (i: number) => void
  /** Advance one step during playback; stops playback at the end instead of overrunning. */
  advanceCursor: (maxIndex: number) => void
  setIsPlaying: (playing: boolean) => void
  setSpeed: (speed: number) => void
  /** Called whenever a fresh bars window loads -- replay always restarts from its beginning. */
  resetCursorForNewBars: () => void

  resetForNewRun: () => void
}

export const useChartViewStore = create<ChartViewState>((set) => ({
  viewMode: 'trade',
  explicitDayWindow: null,
  replayActive: false,
  cursorIndex: 0,
  isPlaying: false,
  speed: 1,

  selectTradeView: () => set({ viewMode: 'trade', explicitDayWindow: null }),
  selectFullDay: () => set({ viewMode: 'day', explicitDayWindow: null }),
  selectExplicitDay: (window) => set({ viewMode: 'day', explicitDayWindow: window }),

  toggleReplay: () =>
    set((s) => ({ replayActive: !s.replayActive, cursorIndex: 0, isPlaying: false })),
  setCursorIndex: (i) => set({ cursorIndex: i, isPlaying: false }),
  advanceCursor: (maxIndex) =>
    set((s) => {
      if (s.cursorIndex >= maxIndex) return { isPlaying: false }
      return { cursorIndex: s.cursorIndex + 1 }
    }),
  setIsPlaying: (playing) => set({ isPlaying: playing }),
  setSpeed: (speed) => set({ speed }),
  resetCursorForNewBars: () => set({ cursorIndex: 0, isPlaying: false }),

  resetForNewRun: () =>
    set({ viewMode: 'trade', explicitDayWindow: null, replayActive: false, cursorIndex: 0, isPlaying: false }),
}))
