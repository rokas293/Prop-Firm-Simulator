// G9b: reading what the first G9 left in browser storage, and removing exactly what the
// server confirmed it holds.
import { describe, expect, it } from 'vitest'
import type { PersistedOverlay } from '../chart/kl/drawingOverlays'
import { LEGACY_DRAWINGS_KEY, buildImport, dropMigrated, hasLegacyData, readLegacyDrawings } from './legacyDrawings'

const line = (id: string): PersistedOverlay => ({ id, name: 'segment', points: [{ timestamp: 1, value: 100 }] })

function fakeStorage(initial: Record<string, string> = {}) {
  const data = { ...initial }
  return {
    getItem: (k: string) => (k in data ? data[k] : null),
    setItem: (k: string, v: string) => void (data[k] = v),
    removeItem: (k: string) => void delete data[k],
    data,
  }
}

const layout = (id: string, name: string) => ({
  id,
  name,
  indicators: { sessionShading: true, fairValue: false, newsEvents: false, vwap: true, ema20: false, ema50: false, atr14: false, volume: true },
  candleType: 'heikin_ashi',
  timeframe: '15min',
  drawings: { MNQ: [line('ld1')] },
  sharedVisible: true,
})

function blob(state: Record<string, unknown>) {
  return fakeStorage({ [LEGACY_DRAWINGS_KEY]: JSON.stringify({ state, version: 0 }) })
}

const FULL = {
  overlaysByInstrument: { MNQ: [line('old1'), line('old2')], MES: [line('old3')] },
  overlaysBySession: { A: { MNQ: [line('a1')] }, B: { MNQ: [line('b1')], MES: [line('b2')] } },
  layoutsBySession: { A: [layout('l1', 'Open')] },
  sharedVisibleBySession: { A: true, B: false },
  styleTemplates: [{ id: 't1', name: 'Key level', style: { color: '#ff0000', width: 3 } }],
  newDrawingTemplateId: 't1',
  recentTools: ['segment', 'klZone'],
}

describe('readLegacyDrawings', () => {
  it('is null when there is nothing in browser storage', () => {
    expect(readLegacyDrawings(fakeStorage())).toBeNull()
  })

  it('reads every part of the first G9 blob', () => {
    const l = readLegacyDrawings(blob(FULL))!
    expect(Object.keys(l.shared)).toEqual(['MNQ', 'MES'])
    expect(l.shared.MNQ.map((o) => o.id)).toEqual(['old1', 'old2'])
    expect(Object.keys(l.sessions).sort()).toEqual(['A', 'B'])
    expect(l.sessions.B.drawings.MES.map((o) => o.id)).toEqual(['b2'])
    expect(l.sessions.A.layouts[0]).toMatchObject({ id: 'l1', name: 'Open', candleType: 'heikin_ashi', timeframe: '15min', sharedVisible: true })
    expect(l.sessions.A.layouts[0].indicators.vwap).toBe(true)
    expect(l.sessions.A.sharedVisible).toBe(true)
    expect(l.templates).toEqual([{ id: 't1', name: 'Key level', style: { color: '#ff0000', width: 3 } }])
    expect(l.newTemplateId).toBe('t1')
    expect(l.recentTools).toEqual(['segment', 'klZone'])
    expect(hasLegacyData(l)).toBe(true)
  })

  it('reads a store saved before G9 (shared layer only)', () => {
    const l = readLegacyDrawings(blob({ overlaysByInstrument: { MNQ: [line('legacy')] }, recentTools: ['segment'] }))!
    expect(l.shared.MNQ.map((o) => o.id)).toEqual(['legacy'])
    expect(l.sessions).toEqual({})
    expect(l.templates).toEqual([])
  })

  it('skips what the server could never accept, instead of failing the whole import', () => {
    const l = readLegacyDrawings(
      blob({
        overlaysByInstrument: { MNQ: [line('ok'), { name: 'segment', points: [] }, { id: 'x', name: 'segment' }], '../bad': [line('z')] },
        layoutsBySession: { A: [{ id: '', name: 'nameless' }, layout('l1', '  Fade  ')] },
        styleTemplates: [{ id: 't1', name: 'Wide', style: { color: '#fff', width: 999 } }, { id: 't2', name: 'No colour', style: { width: 2 } }],
        newDrawingTemplateId: 'ghost',
      }),
    )!
    expect(l.shared.MNQ.map((o) => o.id)).toEqual(['ok'])
    expect(l.shared['../bad']).toBeUndefined()
    expect(l.sessions.A.layouts.map((x) => x.name)).toEqual(['Fade'])
    expect(l.templates.map((t) => t.id)).toEqual(['t1'])
    expect(l.templates[0].style.width).toBe(1)
    expect(l.newTemplateId).toBeNull()
  })

  it('leaves an unreadable blob alone', () => {
    const storage = fakeStorage({ [LEGACY_DRAWINGS_KEY]: '{not json' })
    expect(readLegacyDrawings(storage)).toBeNull()
    dropMigrated({ sessions_imported: [], sessions_missing: [], workspace_imported: true }, storage)
    expect(storage.data[LEGACY_DRAWINGS_KEY]).toBe('{not json')
  })

  it('treats a session entry that says nothing as having nothing to move', () => {
    const l = readLegacyDrawings(blob({ overlaysBySession: { A: {} }, sharedVisibleBySession: { A: false }, layoutsBySession: { A: [] } }))!
    expect(l.sessions).toEqual({})
    expect(hasLegacyData(l)).toBe(false)
  })
})

describe('buildImport', () => {
  it('sends the wire shape: snake_case layouts, flat templates, per-session sets', () => {
    const body = buildImport(readLegacyDrawings(blob(FULL))!)
    expect(body.style_templates).toEqual([{ id: 't1', name: 'Key level', color: '#ff0000', width: 3 }])
    expect(body.new_drawing_template_id).toBe('t1')
    expect(body.sessions.A.layouts[0]).toMatchObject({ candle_type: 'heikin_ashi', shared_visible: true })
    expect(body.sessions.A.layouts[0].indicators).toMatchObject({ session_shading: true, vwap: true, volume: true, ema20: false })
    expect(body.sessions.A.shared_visible).toBe(true)
    expect(body.shared.MES.map((o) => o.id)).toEqual(['old3'])
  })
})

describe('dropMigrated', () => {
  it('removes the key once the server holds everything', () => {
    const storage = blob(FULL)
    dropMigrated({ sessions_imported: ['A', 'B'], sessions_missing: [], workspace_imported: true }, storage)
    expect(storage.data[LEGACY_DRAWINGS_KEY]).toBeUndefined()
  })

  it('keeps a session the server does not have, and nothing else', () => {
    const storage = blob(FULL)
    dropMigrated({ sessions_imported: ['A'], sessions_missing: ['B'], workspace_imported: true }, storage)
    const left = readLegacyDrawings(storage)!
    expect(Object.keys(left.sessions)).toEqual(['B'])
    expect(left.sessions.B.drawings.MNQ.map((o) => o.id)).toEqual(['b1'])
    expect(left.shared).toEqual({})
    expect(left.templates).toEqual([])
    // Run again with the same answer: unchanged, not an error.
    const once = storage.data[LEGACY_DRAWINGS_KEY]
    dropMigrated({ sessions_imported: ['A'], sessions_missing: ['B'], workspace_imported: true }, storage)
    expect(storage.data[LEGACY_DRAWINGS_KEY]).toBe(once)
  })

  it('does not touch the shared layer or templates when the server did not take them', () => {
    const storage = blob(FULL)
    dropMigrated({ sessions_imported: ['A', 'B'], sessions_missing: [], workspace_imported: false }, storage)
    const left = readLegacyDrawings(storage)!
    expect(left.sessions).toEqual({})
    expect(left.shared.MNQ).toHaveLength(2)
    expect(left.templates).toHaveLength(1)
  })
})
