// FXR_V2_SPEC.md 3.4 (G4): Scalper Mode's settings and armed state. The session
// file (backend, `session.scalper`) is the source of truth, like the Quick
// quantity; this store is the workspace's in-memory working copy of it, so a
// keystroke in the popover is reflected at once and saved on a short debounce
// (SessionWorkspace). Nothing here is persisted to browser storage any more --
// except the one-off migration of what the first version of G4 left there.
import { create } from 'zustand'
import { DEFAULT_SCALPER, editScalper, normalizeScalper, type ScalperSettings } from '../chart/scalper'

export interface ScalperSessionState {
  armed: boolean
  settings: ScalperSettings
}

const DEFAULT_STATE: ScalperSessionState = { armed: false, settings: DEFAULT_SCALPER }

interface ScalperStoreState {
  bySession: Record<string, ScalperSessionState>
  // Loads a session's saved state (or its defaults) without it counting as an edit.
  seed: (sessionId: string, state: ScalperSessionState) => void
  setArmed: (sessionId: string, armed: boolean) => void
  patch: (sessionId: string, patch: Partial<ScalperSettings>) => void
}

// Whatever came from storage or the server is re-normalized: an older or
// hand-edited shape can never put an impossible combination (break-even without
// a stop) in play.
export function readScalper(bySession: Record<string, ScalperSessionState>, sessionId: string | null): ScalperSessionState {
  const saved = sessionId ? bySession[sessionId] : undefined
  if (!saved) return DEFAULT_STATE
  return { armed: saved.armed === true, settings: normalizeScalper(saved.settings) }
}

export const useScalperStore = create<ScalperStoreState>()((set) => ({
  bySession: {},
  seed: (sessionId, state) =>
    set((s) => ({ bySession: { ...s.bySession, [sessionId]: { armed: state.armed === true, settings: normalizeScalper(state.settings) } } })),
  setArmed: (sessionId, armed) =>
    set((s) => ({ bySession: { ...s.bySession, [sessionId]: { ...readScalper(s.bySession, sessionId), armed } } })),
  patch: (sessionId, patch) =>
    set((s) => {
      const current = readScalper(s.bySession, sessionId)
      return { bySession: { ...s.bySession, [sessionId]: { ...current, settings: editScalper(current.settings, patch) } } }
    }),
}))

// --- migration from browser storage -----------------------------------------
// The first version of G4 kept this per session in localStorage under this key
// (zustand persist's { state: { bySession }, version }). A session with nothing
// on the server yet adopts its entry once, and the entry is removed.
export const LEGACY_SCALPER_KEY = 'propbt-viz:scalper'

type LegacyStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
type LegacyBlob = { state?: { bySession?: Record<string, ScalperSessionState> } }

function readBlob(storage: LegacyStorage): LegacyBlob | null {
  const raw = storage.getItem(LEGACY_SCALPER_KEY)
  return raw ? (JSON.parse(raw) as LegacyBlob) : null
}

// What the first G4 left for this session in browser storage, or null.
export function readLegacyScalper(sessionId: string, storage: LegacyStorage = localStorage): ScalperSessionState | null {
  try {
    const entry = readBlob(storage)?.state?.bySession?.[sessionId]
    return entry ? { armed: entry.armed === true, settings: normalizeScalper(entry.settings) } : null
  } catch {
    return null
  }
}

// Removes that entry (and the whole key once it is empty). Called only AFTER the
// session file has accepted the migrated values, so a failed save loses nothing.
export function dropLegacyScalper(sessionId: string, storage: LegacyStorage = localStorage): void {
  try {
    const blob = readBlob(storage)
    const bySession = blob?.state?.bySession
    if (!blob || !bySession || !(sessionId in bySession)) return
    const { [sessionId]: _dropped, ...rest } = bySession
    void _dropped
    if (Object.keys(rest).length === 0) storage.removeItem(LEGACY_SCALPER_KEY)
    else storage.setItem(LEGACY_SCALPER_KEY, JSON.stringify({ ...blob, state: { ...blob.state, bySession: rest } }))
  } catch {
    /* storage unavailable: nothing to clean */
  }
}
