// G9b: the one-off migration of what the first G9 kept in browser storage.
//
// zustand's persist wrote everything under one key as { state, version }:
//   overlaysByInstrument     -> the shared layer (per instrument)
//   overlaysBySession        -> each session's own drawings (per instrument)
//   layoutsBySession         -> named layouts per session
//   sharedVisibleBySession   -> whether a session shows the shared layer
//   styleTemplates, newDrawingTemplateId
//   recentTools              -> stays a browser preference (see klDrawingStore)
//
// Nothing writes this key any more. `readLegacyDrawings` normalises it for the import,
// and `dropMigrated` removes exactly what the server confirmed it holds -- AFTER the
// import answered, so a failed request loses nothing. Entries for sessions this server
// has no folder for are kept (they may belong to a different sessions directory).
import type { BrowserDrawingsImport, BrowserDrawingsImportResult } from '../api/types'
import type { PersistedOverlay } from '../chart/kl/drawingOverlays'
import { toWireLayout, toWireTemplate } from './drawingsWire'
import type { DrawingStyleTemplate, NamedLayout } from './klDrawingStore'

export const LEGACY_DRAWINGS_KEY = 'propbt-viz:kl-drawings'

type LegacyStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
type Overlays = Record<string, PersistedOverlay[]>

export interface LegacySession {
  drawings: Overlays
  layouts: NamedLayout[]
  sharedVisible: boolean
}

export interface LegacyDrawings {
  shared: Overlays
  templates: DrawingStyleTemplate[]
  newTemplateId: string | null
  recentTools: string[]
  sessions: Record<string, LegacySession>
}

// The backend's instrument-key rule (drawings_service._INSTRUMENT_RE): one bad key would
// fail the whole import, so keys that could never be stored are not sent.
const INSTRUMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,15}$/

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function overlays(v: unknown): PersistedOverlay[] {
  if (!Array.isArray(v)) return []
  return v.filter(
    (o): o is PersistedOverlay =>
      isObject(o) && typeof o.id === 'string' && o.id.length > 0 && o.id.length <= 200 &&
      typeof o.name === 'string' && o.name.length > 0 && o.name.length <= 100 && Array.isArray(o.points),
  )
}

function overlaysByInstrument(v: unknown): Overlays {
  const out: Overlays = {}
  if (!isObject(v)) return out
  for (const [instrument, list] of Object.entries(v)) {
    if (!INSTRUMENT_RE.test(instrument)) continue
    const clean = overlays(list)
    if (clean.length > 0) out[instrument] = clean
  }
  return out
}

function layouts(v: unknown): NamedLayout[] {
  if (!Array.isArray(v)) return []
  const out: NamedLayout[] = []
  for (const l of v) {
    if (!isObject(l) || typeof l.id !== 'string' || !l.id || typeof l.name !== 'string' || !l.name.trim()) continue
    const ind = isObject(l.indicators) ? l.indicators : {}
    out.push({
      id: l.id,
      name: l.name.trim().slice(0, 80),
      indicators: {
        sessionShading: ind.sessionShading === true,
        fairValue: ind.fairValue === true,
        newsEvents: ind.newsEvents === true,
        vwap: ind.vwap === true,
        ema20: ind.ema20 === true,
        ema50: ind.ema50 === true,
        atr14: ind.atr14 === true,
        volume: ind.volume === true,
      },
      candleType: typeof l.candleType === 'string' ? l.candleType : 'candles',
      timeframe: typeof l.timeframe === 'string' ? l.timeframe : '5min',
      drawings: overlaysByInstrument(l.drawings),
      sharedVisible: l.sharedVisible === true,
    })
  }
  return out
}

function templates(v: unknown): DrawingStyleTemplate[] {
  if (!Array.isArray(v)) return []
  const out: DrawingStyleTemplate[] = []
  for (const t of v) {
    if (!isObject(t) || typeof t.id !== 'string' || !t.id || typeof t.name !== 'string' || !t.name.trim()) continue
    const style = isObject(t.style) ? t.style : {}
    // A template with no colour cannot be applied to anything: nothing to carry over.
    if (typeof style.color !== 'string' || !style.color) continue
    const width = typeof style.width === 'number' && style.width > 0 && style.width <= 20 ? style.width : 1
    out.push({ id: t.id, name: t.name.trim().slice(0, 80), style: { color: style.color.slice(0, 40), width } })
  }
  return out
}

function readBlob(storage: LegacyStorage): Record<string, unknown> | null {
  const raw = storage.getItem(LEGACY_DRAWINGS_KEY)
  if (!raw) return null
  const blob = JSON.parse(raw) as unknown
  return isObject(blob) && isObject(blob.state) ? blob.state : null
}

function normalise(state: Record<string, unknown>): LegacyDrawings {
  const bySession = isObject(state.overlaysBySession) ? state.overlaysBySession : {}
  const layoutsBySession = isObject(state.layoutsBySession) ? state.layoutsBySession : {}
  const sharedBySession = isObject(state.sharedVisibleBySession) ? state.sharedVisibleBySession : {}
  const sessions: Record<string, LegacySession> = {}
  for (const id of new Set([...Object.keys(bySession), ...Object.keys(layoutsBySession), ...Object.keys(sharedBySession)])) {
    const own = overlaysByInstrument(bySession[id])
    const lay = layouts(layoutsBySession[id])
    const shown = sharedBySession[id] === true
    // An entry that says nothing ("hidden", no drawings, no layouts) has nothing to move.
    if (Object.keys(own).length === 0 && lay.length === 0 && !shown) continue
    sessions[id] = { drawings: own, layouts: lay, sharedVisible: shown }
  }
  const tpls = templates(state.styleTemplates)
  const wanted = state.newDrawingTemplateId
  return {
    shared: overlaysByInstrument(state.overlaysByInstrument),
    templates: tpls,
    newTemplateId: typeof wanted === 'string' && tpls.some((t) => t.id === wanted) ? wanted : null,
    recentTools: Array.isArray(state.recentTools) ? state.recentTools.filter((t): t is string => typeof t === 'string') : [],
    sessions,
  }
}

// Whether there is anything the server needs to be given (the favourites row is not).
export function hasLegacyData(l: LegacyDrawings): boolean {
  return Object.keys(l.shared).length > 0 || l.templates.length > 0 || Object.keys(l.sessions).length > 0
}

// What the first G9 left in browser storage, or null when there is none (or it cannot be
// read -- an unreadable blob is left exactly where it is).
export function readLegacyDrawings(storage: LegacyStorage = localStorage): LegacyDrawings | null {
  try {
    const state = readBlob(storage)
    return state ? normalise(state) : null
  } catch {
    return null
  }
}

export function buildImport(legacy: LegacyDrawings): BrowserDrawingsImport {
  const sessions: BrowserDrawingsImport['sessions'] = {}
  for (const [id, s] of Object.entries(legacy.sessions)) {
    sessions[id] = { drawings: s.drawings, layouts: s.layouts.map(toWireLayout), shared_visible: s.sharedVisible }
  }
  return {
    shared: legacy.shared,
    style_templates: legacy.templates.map(toWireTemplate),
    new_drawing_template_id: legacy.newTemplateId,
    sessions,
  }
}

// Removes what the server holds from the browser copy. The shared layer and templates go
// together (they are one import); each session's entries go when that session was
// imported. What is left (sessions this server does not have) stays; with nothing left,
// the key itself is removed.
export function dropMigrated(result: BrowserDrawingsImportResult, storage: LegacyStorage = localStorage): void {
  try {
    const raw = storage.getItem(LEGACY_DRAWINGS_KEY)
    if (!raw) return
    const blob = JSON.parse(raw) as { state?: Record<string, unknown>; version?: number }
    const state = blob.state
    if (!isObject(state)) return
    const next: Record<string, unknown> = { ...state }
    if (result.workspace_imported) {
      delete next.overlaysByInstrument
      delete next.styleTemplates
      delete next.newDrawingTemplateId
    }
    // recentTools was adopted by the caller before the import.
    delete next.recentTools
    for (const field of ['overlaysBySession', 'layoutsBySession', 'sharedVisibleBySession'] as const) {
      const map = next[field]
      if (!isObject(map)) continue
      const kept: Record<string, unknown> = {}
      for (const [id, v] of Object.entries(map)) if (!result.sessions_imported.includes(id)) kept[id] = v
      next[field] = kept
    }
    if (hasLegacyData(normalise(next))) storage.setItem(LEGACY_DRAWINGS_KEY, JSON.stringify({ ...blob, state: next }))
    else storage.removeItem(LEGACY_DRAWINGS_KEY)
  } catch {
    /* storage unavailable or unreadable: leave it as it is */
  }
}

// Removes the key outright (used when nothing but the favourites row was in it).
export function forgetLegacyDrawings(storage: LegacyStorage = localStorage): void {
  try {
    storage.removeItem(LEGACY_DRAWINGS_KEY)
  } catch {
    /* nothing to clean */
  }
}
