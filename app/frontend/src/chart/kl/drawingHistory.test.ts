import { describe, expect, it } from 'vitest'
import type { PersistedOverlay } from './drawingOverlays'
import { canRedo, canUndo, emptyHistory, MAX_DRAWING_HISTORY, recordDrawings, redo, undo } from './drawingHistory'

const d = (id: string): PersistedOverlay => ({ id, name: 'straightLine', points: [{ timestamp: 1, value: 1 }] }) as unknown as PersistedOverlay

describe('drawing history', () => {
  it('treats the first report as the baseline and ignores identical echoes', () => {
    let h = recordDrawings(emptyHistory(), [d('a')])
    expect(canUndo(h)).toBe(false)
    h = recordDrawings(h, [d('a')])
    expect(h.past).toHaveLength(0)
  })
  it('undoes and redoes edits, and a new edit clears redo', () => {
    let h = recordDrawings(emptyHistory(), [])
    h = recordDrawings(h, [d('a')])
    h = recordDrawings(h, [d('a'), d('b')])
    const u = undo(h)!
    expect(u.restore.map((o) => o.id)).toEqual(['a'])
    h = u.history
    expect(canRedo(h)).toBe(true)
    const r = redo(h)!
    expect(r.restore.map((o) => o.id)).toEqual(['a', 'b'])
    h = undo(r.history)!.history
    h = recordDrawings(h, [d('c')])
    expect(canRedo(h)).toBe(false)
  })
  it('does nothing with no baseline or nothing to undo/redo, and caps the stack', () => {
    expect(undo(emptyHistory())).toBeNull()
    expect(redo(emptyHistory())).toBeNull()
    let h = recordDrawings(emptyHistory(), [])
    for (let i = 0; i < MAX_DRAWING_HISTORY + 10; i++) h = recordDrawings(h, [d(String(i))])
    expect(h.past).toHaveLength(MAX_DRAWING_HISTORY)
  })
})
