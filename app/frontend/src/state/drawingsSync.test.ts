// G9b: drawings, layouts and templates live on the server. These run the real store,
// migration and sync against an in-memory stand-in for the backend.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BrowserDrawingsImport,
  SessionDrawingsDoc,
  UpdateSessionDrawingsRequest,
  UpdateWorkspaceDrawingsRequest,
  WorkspaceDrawingsDoc,
} from '../api/types'
import type { PersistedOverlay } from '../chart/kl/drawingOverlays'

// The server: what is on disk, plus a log of every write it received.
const server = {
  workspace: { shared: {}, style_templates: [], new_drawing_template_id: null, imported_from_browser: false } as WorkspaceDrawingsDoc,
  sessions: {} as Record<string, SessionDrawingsDoc>,
  imports: [] as BrowserDrawingsImport[],
  sessionWrites: [] as { id: string; body: UpdateSessionDrawingsRequest }[],
  workspaceWrites: [] as UpdateWorkspaceDrawingsRequest[],
  failImport: false,
  failSessionWrites: 0,
}
const emptySession = (): SessionDrawingsDoc => ({ drawings: {}, layouts: [], shared_visible: false, imported_from_browser: false })

vi.mock('../api/client', () => ({
  api: {
    getWorkspaceDrawings: vi.fn(async () => structuredClone(server.workspace)),
    getSessionDrawings: vi.fn(async (id: string) => {
      if (!(id in server.sessions)) throw new Error('404')
      return structuredClone(server.sessions[id])
    }),
    updateWorkspaceDrawings: vi.fn(async (body: UpdateWorkspaceDrawingsRequest) => {
      server.workspaceWrites.push(structuredClone(body))
      if (body.shared) Object.assign(server.workspace.shared, structuredClone(body.shared))
      if (body.style_templates) server.workspace.style_templates = structuredClone(body.style_templates)
      if ('new_drawing_template_id' in body) server.workspace.new_drawing_template_id = body.new_drawing_template_id ?? null
      return structuredClone(server.workspace)
    }),
    updateSessionDrawings: vi.fn(async (id: string, body: UpdateSessionDrawingsRequest) => {
      if (server.failSessionWrites > 0) {
        server.failSessionWrites -= 1
        throw new Error('500')
      }
      server.sessionWrites.push({ id, body: structuredClone(body) })
      const doc = server.sessions[id]
      if (body.drawings) Object.assign(doc.drawings, structuredClone(body.drawings))
      if (body.layouts) doc.layouts = structuredClone(body.layouts)
      if (body.shared_visible !== undefined) doc.shared_visible = body.shared_visible
      return structuredClone(doc)
    }),
    importBrowserDrawings: vi.fn(async (body: BrowserDrawingsImport) => {
      if (server.failImport) throw new Error('network')
      server.imports.push(structuredClone(body))
      const result = { sessions_imported: [] as string[], sessions_missing: [] as string[], workspace_imported: true }
      if (!server.workspace.imported_from_browser) {
        server.workspace.shared = structuredClone(body.shared)
        server.workspace.style_templates = structuredClone(body.style_templates)
        server.workspace.new_drawing_template_id = body.new_drawing_template_id
        server.workspace.imported_from_browser = true
      }
      for (const [id, s] of Object.entries(body.sessions)) {
        const doc = server.sessions[id]
        if (!doc) {
          result.sessions_missing.push(id)
          continue
        }
        if (!doc.imported_from_browser) {
          doc.drawings = structuredClone(s.drawings)
          doc.layouts = structuredClone(s.layouts)
          doc.shared_visible = s.shared_visible
          doc.imported_from_browser = true
        }
        result.sessions_imported.push(id)
      }
      return result
    }),
  },
}))

import { bootstrapDrawings, diffSession, diffWorkspace, flushDrawings, loadSessionDrawings, resetDrawingsSyncForTests } from './drawingsSync'
import { LEGACY_DRAWINGS_KEY } from './legacyDrawings'
import { useKLDrawingStore, type NamedLayout } from './klDrawingStore'

const line = (id: string): PersistedOverlay => ({ id, name: 'segment', points: [{ timestamp: 1, value: 100 }] })
const layout = (id: string, name: string): NamedLayout => ({
  id,
  name,
  indicators: { sessionShading: false, fairValue: false, newsEvents: false, vwap: true, ema20: false, ema50: false, atr14: false, volume: false },
  candleType: 'candles',
  timeframe: '5min',
  drawings: { MNQ: [line('ld')] },
  sharedVisible: false,
})

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  localStorage.clear()
  server.workspace = { shared: {}, style_templates: [], new_drawing_template_id: null, imported_from_browser: false }
  server.sessions = {}
  server.imports = []
  server.sessionWrites = []
  server.workspaceWrites = []
  server.failImport = false
  server.failSessionWrites = 0
  resetDrawingsSyncForTests()
  useKLDrawingStore.setState({
    overlaysByInstrument: {},
    overlaysBySession: {},
    sharedVisibleBySession: {},
    layoutsBySession: {},
    styleTemplates: [],
    newDrawingTemplateId: null,
    recentTools: [],
    serverRevision: 0,
  })
})

const legacyBlob = (state: Record<string, unknown>) => localStorage.setItem(LEGACY_DRAWINGS_KEY, JSON.stringify({ state, version: 0 }))

describe('migration from browser storage', () => {
  const FULL = {
    overlaysByInstrument: { MNQ: [line('old1')] },
    overlaysBySession: { A: { MNQ: [line('a1'), line('a2')] }, B: { MES: [line('b1')] } },
    layoutsBySession: { A: [layout('l1', 'Open')] },
    sharedVisibleBySession: { A: true },
    styleTemplates: [{ id: 't1', name: 'Key level', style: { color: '#ff0000', width: 3 } }],
    newDrawingTemplateId: 't1',
    recentTools: ['segment'],
  }

  it('moves everything to the server once, then removes the browser copy', async () => {
    server.sessions = { A: emptySession(), B: emptySession() }
    legacyBlob(FULL)
    await bootstrapDrawings()
    expect(server.imports).toHaveLength(1)
    expect(server.sessions.A.drawings.MNQ.map((o) => o.id)).toEqual(['a1', 'a2'])
    expect(server.sessions.A.layouts.map((l) => l.name)).toEqual(['Open'])
    expect(server.sessions.A.shared_visible).toBe(true)
    expect(server.sessions.B.drawings.MES.map((o) => o.id)).toEqual(['b1'])
    expect(server.workspace.shared.MNQ.map((o) => o.id)).toEqual(['old1'])
    expect(server.workspace.style_templates).toEqual([{ id: 't1', name: 'Key level', color: '#ff0000', width: 3 }])
    expect(localStorage.getItem(LEGACY_DRAWINGS_KEY)).toBeNull()
    // The store now shows the server's shared layer and templates; recent tools were adopted.
    const st = useKLDrawingStore.getState()
    expect(st.overlaysByInstrument.MNQ.map((o) => o.id)).toEqual(['old1'])
    expect(st.styleTemplates.map((t) => t.name)).toEqual(['Key level'])
    expect(st.newDrawingTemplateId).toBe('t1')
    expect(st.recentTools).toEqual(['segment'])
  })

  it('a session then loads exactly what was migrated, and the load saves nothing', async () => {
    server.sessions = { A: emptySession() }
    legacyBlob(FULL)
    await bootstrapDrawings()
    await loadSessionDrawings('A')
    const st = useKLDrawingStore.getState()
    expect(st.overlaysBySession.A.MNQ.map((o) => o.id)).toEqual(['a1', 'a2'])
    expect(st.layoutsBySession.A[0]).toMatchObject({ name: 'Open', candleType: 'candles', timeframe: '5min' })
    expect(st.sharedVisibleBySession.A).toBe(true)
    await flushDrawings()
    expect(server.sessionWrites).toEqual([])
    expect(server.workspaceWrites).toEqual([])
  })

  it('does nothing a second time: nothing left to read, nothing sent', async () => {
    server.sessions = { A: emptySession(), B: emptySession() }
    legacyBlob(FULL)
    await bootstrapDrawings()
    resetDrawingsSyncForTests() // a page reload
    await bootstrapDrawings()
    expect(server.imports).toHaveLength(1)
    await loadSessionDrawings('A')
    expect(useKLDrawingStore.getState().overlaysBySession.A.MNQ).toHaveLength(2) // not 4
  })

  it('a failed import loses nothing and is retried on the next load', async () => {
    server.sessions = { A: emptySession(), B: emptySession() }
    legacyBlob(FULL)
    server.failImport = true
    await bootstrapDrawings()
    const kept = localStorage.getItem(LEGACY_DRAWINGS_KEY)
    expect(kept).not.toBeNull()
    expect(JSON.parse(kept!).state.overlaysBySession.A.MNQ).toHaveLength(2)
    server.failImport = false
    resetDrawingsSyncForTests()
    await bootstrapDrawings()
    expect(server.sessions.A.drawings.MNQ).toHaveLength(2)
    expect(localStorage.getItem(LEGACY_DRAWINGS_KEY)).toBeNull()
  })

  it('a crash after the server took it (browser copy still there) does not duplicate on the next load', async () => {
    server.sessions = { A: emptySession(), B: emptySession() }
    legacyBlob(FULL)
    await bootstrapDrawings() // server has it, browser copy removed ...
    legacyBlob(FULL) // ... put the copy back, as if the removal never happened
    resetDrawingsSyncForTests()
    await bootstrapDrawings()
    await loadSessionDrawings('A')
    expect(server.sessions.A.drawings.MNQ.map((o) => o.id)).toEqual(['a1', 'a2'])
    expect(server.sessions.A.layouts).toHaveLength(1)
    expect(useKLDrawingStore.getState().layoutsBySession.A).toHaveLength(1)
    expect(localStorage.getItem(LEGACY_DRAWINGS_KEY)).toBeNull()
  })

  it('keeps the drawings of a session this server does not have, in the browser', async () => {
    server.sessions = { A: emptySession() } // B is not on this server
    legacyBlob(FULL)
    await bootstrapDrawings()
    const left = JSON.parse(localStorage.getItem(LEGACY_DRAWINGS_KEY)!).state
    expect(Object.keys(left.overlaysBySession)).toEqual(['B'])
    expect(left.overlaysBySession.B.MES[0].id).toBe('b1')
    expect(left.overlaysByInstrument).toBeUndefined()
    // The next load offers only what is left; what the server already holds is not re-sent.
    resetDrawingsSyncForTests()
    await bootstrapDrawings()
    expect(server.imports).toHaveLength(2)
    expect(Object.keys(server.imports[1].sessions)).toEqual(['B'])
    expect(server.imports[1].shared).toEqual({})
    expect(localStorage.getItem(LEGACY_DRAWINGS_KEY)).not.toBeNull()
  })

  it('with no browser data it asks the server for nothing to import', async () => {
    await bootstrapDrawings()
    expect(server.imports).toEqual([])
  })

  it('adopts the favourites row and clears a blob that held nothing else', async () => {
    legacyBlob({ recentTools: ['klZone'] })
    await bootstrapDrawings()
    expect(server.imports).toEqual([])
    expect(useKLDrawingStore.getState().recentTools).toEqual(['klZone'])
    expect(localStorage.getItem(LEGACY_DRAWINGS_KEY)).toBeNull()
  })

  it('after migrating, drawings are not read from browser storage again', async () => {
    server.workspace.shared = { MNQ: [line('server')] }
    server.workspace.imported_from_browser = true
    server.sessions = { A: emptySession() }
    await bootstrapDrawings()
    // Something appears under the old key afterwards (e.g. an old tab): the store ignores it.
    legacyBlob({ ...FULL })
    await useKLDrawingStore.persist.rehydrate()
    await loadSessionDrawings('A')
    const st = useKLDrawingStore.getState()
    expect(st.overlaysByInstrument.MNQ.map((o) => o.id)).toEqual(['server'])
    expect(st.overlaysBySession.A).toEqual({})
  })
})

describe('saving', () => {
  beforeEach(async () => {
    server.sessions = { A: emptySession(), B: emptySession() }
    await bootstrapDrawings()
    await loadSessionDrawings('A')
    await loadSessionDrawings('B')
  })

  it('a session edit goes to that session only, and only the instrument that changed', async () => {
    const s = useKLDrawingStore.getState()
    s.setOverlaysForSession('A', 'MNQ', [line('a1')])
    await flushDrawings()
    expect(server.sessionWrites).toEqual([{ id: 'A', body: { drawings: { MNQ: [line('a1')] } } }])
    expect(server.sessions.B.drawings).toEqual({})
    useKLDrawingStore.getState().setOverlaysForSession('A', 'MES', [line('e1')])
    await flushDrawings()
    expect(server.sessionWrites[1]).toEqual({ id: 'A', body: { drawings: { MES: [line('e1')] } } })
  })

  it('two sessions keep separate drawings, layouts and toggles on the server', async () => {
    const s = useKLDrawingStore.getState()
    s.setOverlaysForSession('A', 'MNQ', [line('a1')])
    s.setOverlaysForSession('B', 'MNQ', [line('b1'), line('b2')])
    s.saveLayout('A', layout('l1', 'Only A'))
    s.setSharedVisible('B', true)
    await flushDrawings()
    expect(server.sessions.A.drawings.MNQ.map((o) => o.id)).toEqual(['a1'])
    expect(server.sessions.B.drawings.MNQ.map((o) => o.id)).toEqual(['b1', 'b2'])
    expect(server.sessions.A.layouts.map((l) => l.name)).toEqual(['Only A'])
    expect(server.sessions.B.layouts).toEqual([])
    expect([server.sessions.A.shared_visible, server.sessions.B.shared_visible]).toEqual([false, true])
  })

  it('what is saved comes back as the same session, layout and all', async () => {
    useKLDrawingStore.getState().saveLayout('A', layout('l1', 'Round trip'))
    await flushDrawings()
    resetDrawingsSyncForTests()
    useKLDrawingStore.setState({ layoutsBySession: {}, overlaysBySession: {}, sharedVisibleBySession: {} })
    await bootstrapDrawings()
    await loadSessionDrawings('A')
    expect(useKLDrawingStore.getState().layoutsBySession.A).toEqual([layout('l1', 'Round trip')])
  })

  it('deleting a layout, clearing an instrument and hiding the shared layer are saved', async () => {
    const s = useKLDrawingStore.getState()
    s.saveLayout('A', layout('l1', 'One'))
    s.setOverlaysForSession('A', 'MNQ', [line('a1')])
    s.setSharedVisible('A', true)
    await flushDrawings()
    useKLDrawingStore.getState().deleteLayout('A', 'l1')
    useKLDrawingStore.getState().setOverlaysForSession('A', 'MNQ', [])
    useKLDrawingStore.getState().setSharedVisible('A', false)
    await flushDrawings()
    expect(server.sessions.A).toMatchObject({ drawings: { MNQ: [] }, layouts: [], shared_visible: false })
  })

  it('replacing the whole set (loading a layout) clears the instruments it no longer has', async () => {
    const s = useKLDrawingStore.getState()
    s.setOverlaysForSession('A', 'MNQ', [line('a1')])
    s.setOverlaysForSession('A', 'MES', [line('e1')])
    await flushDrawings()
    useKLDrawingStore.getState().setSessionDrawings('A', { MNQ: [line('kept')] })
    await flushDrawings()
    expect(server.sessions.A.drawings.MNQ.map((o) => o.id)).toEqual(['kept'])
    expect(server.sessions.A.drawings.MES).toEqual([])
  })

  it('the shared layer is saved per instrument, apart from every session', async () => {
    useKLDrawingStore.getState().setOverlaysForInstrument('MNQ', [line('s1')])
    await flushDrawings()
    expect(server.workspaceWrites).toEqual([{ shared: { MNQ: [line('s1')] } }])
    expect(server.sessionWrites).toEqual([])
    useKLDrawingStore.getState().setOverlaysForInstrument('MES', [line('s2')])
    await flushDrawings()
    expect(server.workspaceWrites[1]).toEqual({ shared: { MES: [line('s2')] } })
    expect(Object.keys(server.workspace.shared).sort()).toEqual(['MES', 'MNQ'])
  })

  it('a session editing its own drawings never writes the shared layer', async () => {
    useKLDrawingStore.getState().setOverlaysForInstrument('MNQ', [line('s1')])
    await flushDrawings()
    server.workspaceWrites = []
    useKLDrawingStore.getState().setSharedVisible('A', true)
    useKLDrawingStore.getState().setOverlaysForSession('A', 'MNQ', [line('a1')])
    await flushDrawings()
    expect(server.workspaceWrites).toEqual([])
    expect(server.workspace.shared.MNQ.map((o) => o.id)).toEqual(['s1'])
  })

  it('style templates and the default for new drawings are saved', async () => {
    const s = useKLDrawingStore.getState()
    s.saveStyleTemplate({ id: 't1', name: 'Key', style: { color: '#ff0000', width: 2 } })
    s.setNewDrawingTemplateId('t1')
    await flushDrawings()
    expect(server.workspace.style_templates).toEqual([{ id: 't1', name: 'Key', color: '#ff0000', width: 2 }])
    expect(server.workspace.new_drawing_template_id).toBe('t1')
    useKLDrawingStore.getState().deleteStyleTemplate('t1')
    await flushDrawings()
    expect(server.workspace.style_templates).toEqual([])
    expect(server.workspace.new_drawing_template_id).toBeNull()
  })

  it('a failed save is retried with the same change, not dropped', async () => {
    server.failSessionWrites = 1
    useKLDrawingStore.getState().setOverlaysForSession('A', 'MNQ', [line('a1')])
    await flushDrawings()
    expect(server.sessions.A.drawings).toEqual({})
    await flushDrawings()
    expect(server.sessions.A.drawings.MNQ.map((o) => o.id)).toEqual(['a1'])
  })

  it('edits are saved on their own after a short pause', async () => {
    vi.useFakeTimers()
    try {
      useKLDrawingStore.getState().setOverlaysForSession('A', 'MNQ', [line('a1')])
      useKLDrawingStore.getState().setOverlaysForSession('A', 'MNQ', [line('a1'), line('a2')])
      expect(server.sessionWrites).toEqual([])
      await vi.advanceTimersByTimeAsync(600)
      expect(server.sessionWrites).toHaveLength(1)
      expect(server.sessionWrites[0].body.drawings?.MNQ.map((o) => o.id)).toEqual(['a1', 'a2'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a session that was never loaded is never written', async () => {
    useKLDrawingStore.getState().setOverlaysForSession('C', 'MNQ', [line('c1')])
    await flushDrawings()
    expect(server.sessionWrites).toEqual([])
  })

  it('opening a session again reads the server, after the last edit went out', async () => {
    useKLDrawingStore.getState().setOverlaysForSession('A', 'MNQ', [line('a1')])
    // No explicit flush: loading flushes first, so it can never read behind its own edit.
    await loadSessionDrawings('A')
    expect(useKLDrawingStore.getState().overlaysBySession.A.MNQ.map((o) => o.id)).toEqual(['a1'])
  })
})

describe('diffs', () => {
  it('no change, no diff', async () => {
    server.sessions = { A: emptySession() }
    await bootstrapDrawings()
    await loadSessionDrawings('A')
    const st = useKLDrawingStore.getState()
    expect(diffSession(st, 'A', { drawings: st.overlaysBySession.A, layouts: st.layoutsBySession.A, sharedVisible: false })).toBeNull()
    expect(diffWorkspace(st, { shared: st.overlaysByInstrument, templates: st.styleTemplates, newTemplateId: null })).toBeNull()
  })
})
