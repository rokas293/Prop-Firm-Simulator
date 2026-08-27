import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// hline/ray/trendline take their line color from the same palette used
// elsewhere; rect is a shaded zone; measure is a ruler with a text label
// (see chart/measure.ts). All persist -- including measure, deliberately:
// a completed measurement is often worth keeping visible until you
// explicitly remove it, same as any other annotation.
export type DrawingType = 'hline' | 'ray' | 'trendline' | 'rect' | 'measure'

export interface DrawingPoint {
  time: number
  price: number
}

export interface Drawing {
  id: string
  type: DrawingType
  instrument: string
  // hline: exactly 1 point. ray/trendline/rect/measure: exactly 2.
  points: DrawingPoint[]
}

export const POINTS_REQUIRED: Record<DrawingType, number> = {
  hline: 1,
  ray: 2,
  trendline: 2,
  rect: 2,
  measure: 2,
}

interface DrawingState {
  drawings: Drawing[]
  addDrawing: (d: Drawing) => void
  removeDrawing: (id: string) => void
  clearForInstrument: (instrument: string) => void

  // Tool-selection UI state -- deliberately NOT persisted (partialize
  // below): reopening the app should never land mid-drawing.
  activeTool: DrawingType | null
  setActiveTool: (t: DrawingType | null) => void
  pendingPoint: DrawingPoint | null
  setPendingPoint: (p: DrawingPoint | null) => void
  cancelDrawing: () => void
}

export const useDrawingStore = create<DrawingState>()(
  persist(
    (set) => ({
      drawings: [],
      addDrawing: (d) => set((s) => ({ drawings: [...s.drawings, d] })),
      removeDrawing: (id) => set((s) => ({ drawings: s.drawings.filter((d) => d.id !== id) })),
      clearForInstrument: (instrument) =>
        set((s) => ({ drawings: s.drawings.filter((d) => d.instrument !== instrument) })),

      activeTool: null,
      setActiveTool: (t) => set({ activeTool: t, pendingPoint: null }),
      pendingPoint: null,
      setPendingPoint: (p) => set({ pendingPoint: p }),
      cancelDrawing: () => set({ activeTool: null, pendingPoint: null }),
    }),
    {
      name: 'propbt-viz:drawings',
      partialize: (s) => ({ drawings: s.drawings }),
    },
  ),
)

export function drawingsForInstrument(drawings: Drawing[], instrument: string | null): Drawing[] {
  if (!instrument) return []
  return drawings.filter((d) => d.instrument === instrument)
}
