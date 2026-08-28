import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { PersistedOverlay } from '../chart/kl/drawingOverlays'

// Per-instrument persisted drawings for the KLineCharts engine
// (PART_A_REVISED_klinecharts.md Phase A2), replacing the old
// state/drawingStore.ts. Same storage mechanism as before (localStorage
// via zustand's persist) -- there's no backend drawings endpoint and a
// client-only annotation feature doesn't need one; VIZ_SPEC's "frontend
// does zero financial math" doesn't apply to what's purely a visual note
// the user drew on their own screen.
interface KLDrawingState {
  overlaysByInstrument: Record<string, PersistedOverlay[]>
  setOverlaysForInstrument: (instrument: string, overlays: PersistedOverlay[]) => void
  clearForInstrument: (instrument: string) => void
}

export const useKLDrawingStore = create<KLDrawingState>()(
  persist(
    (set) => ({
      overlaysByInstrument: {},
      setOverlaysForInstrument: (instrument, overlays) =>
        set((s) => ({ overlaysByInstrument: { ...s.overlaysByInstrument, [instrument]: overlays } })),
      clearForInstrument: (instrument) =>
        set((s) => {
          const next = { ...s.overlaysByInstrument }
          delete next[instrument]
          return { overlaysByInstrument: next }
        }),
    }),
    { name: 'propbt-viz:kl-drawings' },
  ),
)

export function overlaysForInstrument(
  overlaysByInstrument: Record<string, PersistedOverlay[]>,
  instrument: string | null,
): PersistedOverlay[] {
  if (!instrument) return []
  return overlaysByInstrument[instrument] ?? []
}
