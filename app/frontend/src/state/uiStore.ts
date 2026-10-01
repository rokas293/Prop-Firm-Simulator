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
  // Distraction-free chart mode (REPLICA_ROADMAP.md Batch 5) -- hides
  // App.tsx's header and Workspace.tsx's "Layout:" preset row; ChartPanel.tsx
  // pairs this with dockview's own native maximizeGroup/exitMaximizedGroup
  // (workspaceApiStore) to also collapse the sibling panels. Never
  // persisted (not in partialize below), same as compareRunIds/
  // pendingDayJump -- an ephemeral session mode, not a durable preference;
  // reloading mid-session shouldn't trap the user in it.
  distractionFree: boolean
  setDistractionFree: (v: boolean) => void
  // FXR_SPEC.md phase F1: the manual-replay session side of the app, kept
  // mutually exclusive with selectedRunId (selecting one clears the other)
  // since App.tsx renders exactly one of RunsListPage/SessionsListPage/
  // Workspace/SessionWorkspace at a time. landingTab is the tab switcher
  // shown when neither is selected.
  selectedSessionId: string | null
  selectSession: (sessionId: string | null) => void
  landingTab: 'runs' | 'sessions'
  setLandingTab: (tab: 'runs' | 'sessions') => void
  // FXR_SPEC.md phase F6: the analytics workspace's "Open in journal" hands
  // SessionWorkspace one trade to open selected (the journal's own trade id,
  // see TradeRecord.session_trade_id). One-shot, never persisted -- same
  // pattern as pendingDayJump above.
  pendingJournalTrade: number | null
  openJournalTrade: (sessionId: string, tradeId: number) => void
  consumeJournalTrade: () => void
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
      selectRun: (runId) =>
        set((s) => ({ selectedRunId: runId, selectedSessionId: runId ? null : s.selectedSessionId, pendingDayJump: null })),
      timeframe: '15min',
      setTimeframe: (tf) => set({ timeframe: tf }),
      pendingDayJump: null,
      jumpToTradingDay: (tradingDay) => set({ pendingDayJump: tradingDay }),
      consumeDayJump: () => set({ pendingDayJump: null }),
      compareRunIds: null,
      setCompareRunIds: (ids) => set({ compareRunIds: ids }),
      distractionFree: false,
      setDistractionFree: (v) => set({ distractionFree: v }),
      selectedSessionId: null,
      selectSession: (sessionId) =>
        set((s) => ({ selectedSessionId: sessionId, selectedRunId: sessionId ? null : s.selectedRunId })),
      landingTab: 'runs',
      setLandingTab: (tab) => set({ landingTab: tab }),
      pendingJournalTrade: null,
      openJournalTrade: (sessionId, tradeId) =>
        set({ selectedSessionId: sessionId, selectedRunId: null, pendingJournalTrade: tradeId }),
      consumeJournalTrade: () => set({ pendingJournalTrade: null }),
    }),
    {
      name: 'propbt-viz:ui-state',
      partialize: (s) => ({
        selectedRunId: s.selectedRunId,
        timeframe: s.timeframe,
        selectedSessionId: s.selectedSessionId,
        landingTab: s.landingTab,
      }),
    },
  ),
)
