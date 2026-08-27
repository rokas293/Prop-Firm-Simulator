import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type Timeframe = '1min' | '5min' | '15min' | '1h'

interface UiState {
  selectedRunId: string | null
  selectRun: (runId: string | null) => void
  timeframe: Timeframe
  setTimeframe: (tf: Timeframe) => void
  // Set by the Prop Risk panel's day strip, consumed by the Chart panel to
  // jump the price chart to that CME trading day (a cross-panel command,
  // same pattern as tradeStore's leg/session cross-filter from the
  // Dashboard panel). Never persisted -- it's one-shot, not durable state.
  pendingDayJump: string | null
  jumpToTradingDay: (tradingDay: string) => void
  consumeDayJump: () => void
  // Exactly two run_ids selected for the Compare view (Phase V7), or null.
  // Compare replaces the whole workspace while active -- it isn't itself a
  // dockable panel (POLISH_ROADMAP Phase P1).
  compareRunIds: [string, string] | null
  setCompareRunIds: (ids: [string, string] | null) => void
}

// Persisted to localStorage (Phase V7: "persist view state -- selected
// run, timeframe, filters, indicator toggles" -- filters/indicators have
// their own stores, see tradeStore.ts/indicatorStore.ts; workspace layout
// has its own store too, see workspace/layoutStore.ts) so reopening the
// app returns to where you left off.
export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      selectedRunId: null,
      selectRun: (runId) => set({ selectedRunId: runId, pendingDayJump: null }),
      timeframe: '15min',
      setTimeframe: (tf) => set({ timeframe: tf }),
      pendingDayJump: null,
      jumpToTradingDay: (tradingDay) => set({ pendingDayJump: tradingDay }),
      consumeDayJump: () => set({ pendingDayJump: null }),
      compareRunIds: null,
      setCompareRunIds: (ids) => set({ compareRunIds: ids }),
    }),
    {
      name: 'propbt-viz:ui-state',
      partialize: (s) => ({ selectedRunId: s.selectedRunId, timeframe: s.timeframe }),
    },
  ),
)
