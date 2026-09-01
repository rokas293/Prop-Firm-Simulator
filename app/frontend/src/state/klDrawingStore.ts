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
// REPLICA_ROADMAP.md Batch 4's drawing-toolbar favorites row: the last few
// DISTINCT tool names armed, most-recent-first. Lives here (not new local
// state in KLDrawingToolbar) so it survives a reload the same way the
// drawings themselves do -- a genuinely useful "pick up where I left off"
// preference, not session-only. Capped well below the full ~20-tool
// catalog so the flyout stays a quick-pick, not a second copy of the tool
// list.
const MAX_RECENT_TOOLS = 5

interface KLDrawingState {
  overlaysByInstrument: Record<string, PersistedOverlay[]>
  setOverlaysForInstrument: (instrument: string, overlays: PersistedOverlay[]) => void
  clearForInstrument: (instrument: string) => void
  recentTools: string[]
  recordToolUsed: (name: string) => void
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
      recentTools: [],
      recordToolUsed: (name) =>
        set((s) => ({ recentTools: [name, ...s.recentTools.filter((t) => t !== name)].slice(0, MAX_RECENT_TOOLS) })),
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
