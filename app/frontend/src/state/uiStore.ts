import { create } from 'zustand'

// Minimal for now (just which run is selected) -- grows in later phases
// (chart timeframe, trade filters, replay cursor, indicator toggles).
interface UiState {
  selectedRunId: string | null
  selectRun: (runId: string | null) => void
}

export const useUiStore = create<UiState>((set) => ({
  selectedRunId: null,
  selectRun: (runId) => set({ selectedRunId: runId }),
}))
