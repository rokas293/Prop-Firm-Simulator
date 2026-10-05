// Undo/redo for the session toolbar's drawings. Pure and framework-free: the
// workspace feeds it the persisted drawing set every time ChartKL reports a
// change (placed, dragged, removed), and an undo/redo returns the set to write
// back (then ChartKL.reloadDrawings redraws it). Snapshots are compared by
// value, so the restore-on-load echo and an undo's own echo are no-ops.
import type { PersistedOverlay } from './drawingOverlays'

export interface DrawingHistory {
  past: PersistedOverlay[][]
  present: PersistedOverlay[] | null
  future: PersistedOverlay[][]
}

export const MAX_DRAWING_HISTORY = 50

export const emptyHistory = (): DrawingHistory => ({ past: [], present: null, future: [] })

const same = (a: PersistedOverlay[], b: PersistedOverlay[]) => JSON.stringify(a) === JSON.stringify(b)

// ChartKL reported `next`. The first report (the load) just becomes the
// baseline; an identical one changes nothing; a different one is a new edit
// that clears the redo stack.
export function recordDrawings(h: DrawingHistory, next: PersistedOverlay[]): DrawingHistory {
  if (h.present === null) return { past: [], present: next, future: [] }
  if (same(h.present, next)) return h
  return { past: [...h.past, h.present].slice(-MAX_DRAWING_HISTORY), present: next, future: [] }
}

export const canUndo = (h: DrawingHistory) => h.past.length > 0
export const canRedo = (h: DrawingHistory) => h.future.length > 0

// The history after an undo/redo, and the drawing set to restore (null if there
// is nothing to do).
export function undo(h: DrawingHistory): { history: DrawingHistory; restore: PersistedOverlay[] } | null {
  if (h.present === null || h.past.length === 0) return null
  const restore = h.past[h.past.length - 1]
  return { history: { past: h.past.slice(0, -1), present: restore, future: [h.present, ...h.future] }, restore }
}

export function redo(h: DrawingHistory): { history: DrawingHistory; restore: PersistedOverlay[] } | null {
  if (h.present === null || h.future.length === 0) return null
  const restore = h.future[0]
  return { history: { past: [...h.past, h.present], present: restore, future: h.future.slice(1) }, restore }
}
