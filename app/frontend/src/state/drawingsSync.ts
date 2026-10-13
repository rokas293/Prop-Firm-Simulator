// G9b: keeps klDrawingStore (the in-memory working copy) and the backend (the source of
// truth) in step.
//
//   bootstrapDrawings()      once per page load: moves anything the first G9 left in
//                            localStorage to the server (once), then loads the shared
//                            layer and the style templates.
//   loadSessionDrawings(id)  loads one session's drawings/layouts/shared toggle.
//   (a store subscription)   saves every later change, debounced.
//
// What is saved is found by DIFFING the store against a snapshot of what the server is
// known to hold -- so a load never counts as an edit, and only a target that has been
// loaded is ever written (an empty store can never overwrite a session's saved drawings).
import { api } from '../api/client'
import type { UpdateSessionDrawingsRequest, UpdateWorkspaceDrawingsRequest } from '../api/types'
import type { PersistedOverlay } from '../chart/kl/drawingOverlays'
import { fromWireLayout, fromWireTemplate, toWireLayout, toWireTemplate } from './drawingsWire'
import { buildImport, dropMigrated, forgetLegacyDrawings, hasLegacyData, readLegacyDrawings } from './legacyDrawings'
import { useKLDrawingStore, type DrawingStyleTemplate, type NamedLayout } from './klDrawingStore'

const SAVE_DELAY_MS = 400
const RETRY_DELAY_MS = 3000

type Overlays = Record<string, PersistedOverlay[]>
type StoreState = ReturnType<typeof useKLDrawingStore.getState>

// What the server is known to hold, as the very objects the store holds (so an unchanged
// slice compares equal by reference).
interface SessionSnapshot {
  drawings: Overlays
  layouts: NamedLayout[]
  sharedVisible: boolean
}
interface WorkspaceSnapshot {
  shared: Overlays
  templates: DrawingStyleTemplate[]
  newTemplateId: string | null
}

const sessionSnapshots = new Map<string, SessionSnapshot>()
let workspaceSnapshot: WorkspaceSnapshot | null = null

// --- diffs (pure, exported for tests) ------------------------------------------------

function changedInstruments(now: Overlays, saved: Overlays): Overlays {
  const out: Overlays = {}
  for (const k of new Set([...Object.keys(now), ...Object.keys(saved)])) {
    if (now[k] !== saved[k]) out[k] = now[k] ?? []
  }
  return out
}

export function diffSession(state: StoreState, sessionId: string, saved: SessionSnapshot): UpdateSessionDrawingsRequest | null {
  const body: UpdateSessionDrawingsRequest = {}
  const drawings = changedInstruments(state.overlaysBySession[sessionId] ?? {}, saved.drawings)
  if (Object.keys(drawings).length > 0) body.drawings = drawings
  const layouts = state.layoutsBySession[sessionId] ?? saved.layouts
  if (layouts !== saved.layouts) body.layouts = layouts.map(toWireLayout)
  const shared = !!state.sharedVisibleBySession[sessionId]
  if (shared !== saved.sharedVisible) body.shared_visible = shared
  return Object.keys(body).length > 0 ? body : null
}

export function diffWorkspace(state: StoreState, saved: WorkspaceSnapshot): UpdateWorkspaceDrawingsRequest | null {
  const body: UpdateWorkspaceDrawingsRequest = {}
  const shared = changedInstruments(state.overlaysByInstrument, saved.shared)
  if (Object.keys(shared).length > 0) body.shared = shared
  const templatesChanged = state.styleTemplates !== saved.templates
  if (templatesChanged) body.style_templates = state.styleTemplates.map(toWireTemplate)
  if (state.newDrawingTemplateId !== saved.newTemplateId) body.new_drawing_template_id = state.newDrawingTemplateId
  return Object.keys(body).length > 0 ? body : null
}

// --- saving -------------------------------------------------------------------------

let timer: number | null = null
let queue: Promise<void> = Promise.resolve()
let subscribed = false

function schedule(delay = SAVE_DELAY_MS): void {
  if (timer !== null) window.clearTimeout(timer)
  timer = window.setTimeout(() => {
    timer = null
    void flushDrawings()
  }, delay)
}

// Whether the store holds anything the server does not.
function dirty(state: StoreState): boolean {
  if (workspaceSnapshot && diffWorkspace(state, workspaceSnapshot)) return true
  for (const [id, snap] of sessionSnapshots) if (diffSession(state, id, snap)) return true
  return false
}

async function saveOnce(keepalive: boolean): Promise<void> {
  const state = useKLDrawingStore.getState()
  const jobs: Promise<unknown>[] = []
  let failed = false
  if (workspaceSnapshot) {
    const body = diffWorkspace(state, workspaceSnapshot)
    if (body) {
      // Advance the snapshot to what was sent only once the server has it.
      const sent: WorkspaceSnapshot = { shared: state.overlaysByInstrument, templates: state.styleTemplates, newTemplateId: state.newDrawingTemplateId }
      jobs.push(
        api.updateWorkspaceDrawings(body, keepalive).then(
          () => {
            workspaceSnapshot = sent
          },
          (e) => {
            failed = true
            console.error('drawings: saving the shared layer failed', e)
          },
        ),
      )
    }
  }
  for (const [id, snap] of sessionSnapshots) {
    const body = diffSession(state, id, snap)
    if (!body) continue
    const sent: SessionSnapshot = {
      drawings: state.overlaysBySession[id] ?? {},
      layouts: state.layoutsBySession[id] ?? snap.layouts,
      sharedVisible: !!state.sharedVisibleBySession[id],
    }
    jobs.push(
      api.updateSessionDrawings(id, body, keepalive).then(
        () => {
          // Only if this session wasn't re-seeded meanwhile.
          if (sessionSnapshots.get(id) === snap) sessionSnapshots.set(id, sent)
        },
        (e) => {
          failed = true
          console.error(`drawings: saving session ${id} failed`, e)
        },
      ),
    )
  }
  await Promise.all(jobs)
  if (failed) schedule(RETRY_DELAY_MS)
}

// Saves whatever differs now. Saves never overlap, so an older one cannot land after a
// newer one.
export function flushDrawings(): Promise<void> {
  if (timer !== null) {
    window.clearTimeout(timer)
    timer = null
  }
  queue = queue.then(() => saveOnce(false)).catch(() => undefined)
  return queue
}

function startSync(): void {
  if (subscribed) return
  subscribed = true
  useKLDrawingStore.subscribe((state) => {
    if (dirty(state)) schedule()
  })
  // The page is going away: send what is pending so it outlives it.
  window.addEventListener('pagehide', () => {
    if (timer !== null) window.clearTimeout(timer)
    timer = null
    void saveOnce(true)
  })
}

// --- loading ------------------------------------------------------------------------

function seedWorkspace(doc: Awaited<ReturnType<typeof api.getWorkspaceDrawings>>): void {
  const templates = doc.style_templates.map(fromWireTemplate)
  const newId = doc.new_drawing_template_id
  workspaceSnapshot = { shared: doc.shared, templates, newTemplateId: newId }
  useKLDrawingStore.setState((s) => ({
    overlaysByInstrument: doc.shared,
    styleTemplates: templates,
    newDrawingTemplateId: newId,
    serverRevision: s.serverRevision + 1,
  }))
}

function seedSession(sessionId: string, doc: Awaited<ReturnType<typeof api.getSessionDrawings>>): void {
  const layouts = doc.layouts.map(fromWireLayout)
  sessionSnapshots.set(sessionId, { drawings: doc.drawings, layouts, sharedVisible: doc.shared_visible })
  useKLDrawingStore.setState((s) => ({
    overlaysBySession: { ...s.overlaysBySession, [sessionId]: doc.drawings },
    layoutsBySession: { ...s.layoutsBySession, [sessionId]: layouts },
    sharedVisibleBySession: { ...s.sharedVisibleBySession, [sessionId]: doc.shared_visible },
    serverRevision: s.serverRevision + 1,
  }))
}

// The one-off move of what the first G9 kept in browser storage. Everything is sent in
// one request and the server takes each target at most once, so a crash anywhere between
// "the server has it" and "the browser forgot it" cannot duplicate anything on the next
// load. The browser copy is removed only after the server's answer.
async function migrateLegacy(): Promise<void> {
  const legacy = readLegacyDrawings()
  if (!legacy) return
  const store = useKLDrawingStore.getState()
  if (legacy.recentTools.length > 0 && store.recentTools.length === 0) useKLDrawingStore.setState({ recentTools: legacy.recentTools })
  if (!hasLegacyData(legacy)) {
    forgetLegacyDrawings()
    return
  }
  const result = await api.importBrowserDrawings(buildImport(legacy))
  dropMigrated(result)
  if (result.sessions_missing.length > 0) {
    console.warn(`drawings: ${result.sessions_missing.length} saved session(s) are not on this server; their drawings stay in this browser`)
  }
}

let bootstrapPromise: Promise<void> | null = null

// Safe to call from anywhere, any number of times: one load per page.
export function bootstrapDrawings(): Promise<void> {
  if (!bootstrapPromise) {
    bootstrapPromise = (async () => {
      try {
        await migrateLegacy()
      } catch (e) {
        // The browser copy is untouched; the next load tries again.
        console.error('drawings: moving browser-stored drawings to the server failed', e)
      }
      seedWorkspace(await api.getWorkspaceDrawings())
      startSync()
    })().catch((e) => {
      bootstrapPromise = null
      throw e
    })
  }
  return bootstrapPromise
}

// Loads one session's drawings into the store. Anything still waiting to be saved goes
// first, so reading never races an earlier visit's last edit.
export async function loadSessionDrawings(sessionId: string): Promise<void> {
  await bootstrapDrawings()
  await flushDrawings()
  seedSession(sessionId, await api.getSessionDrawings(sessionId))
}

// Test seams.
export function resetDrawingsSyncForTests(): void {
  sessionSnapshots.clear()
  workspaceSnapshot = null
  bootstrapPromise = null
  if (timer !== null) window.clearTimeout(timer)
  timer = null
  queue = Promise.resolve()
}
