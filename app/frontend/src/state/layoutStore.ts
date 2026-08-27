import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// The workspace's current arrangement, auto-saved on every change and
// restored on load (POLISH_ROADMAP Phase P1). `data` is dockview's own
// `DockviewApi.toJSON()` output -- kept as `unknown` here (not
// `SerializedDockview`) so this store has zero dependency on dockview and
// stays trivially unit-testable.
export interface StoredLayout {
  data: unknown
  savedAt: string
}

interface LayoutState {
  lastLayout: StoredLayout | null
  setLastLayout: (data: unknown) => void
  clearLastLayout: () => void
}

export const useLayoutStore = create<LayoutState>()(
  persist(
    (set) => ({
      lastLayout: null,
      setLastLayout: (data) => set({ lastLayout: { data, savedAt: new Date().toISOString() } }),
      clearLastLayout: () => set({ lastLayout: null }),
    }),
    { name: 'propbt-viz:workspace-layout' },
  ),
)
