import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { PersistedOverlay } from '../chart/kl/drawingOverlays'
import type { IndicatorPrefs } from './indicatorStore'

// Drawings for the KLineCharts engine (PART_A_REVISED_klinecharts.md Phase A2) and, since
// FXR_V2_SPEC.md section 7 (G9), named layouts and drawing-style templates.
//
// G9b: this store is the workspace's IN-MEMORY working copy. The backend is the source of
// truth -- a session's drawings and layouts sit in its own folder, the shared layer and the
// style templates in one file beside the sessions (app/backend/services/drawings_service.py).
// state/drawingsSync.ts loads them into this store and saves every change back; nothing
// here is read from or written to browser storage any more, except `recentTools` (a view
// preference, like the indicator toggles) under its own key. What the first G9 left in
// localStorage is moved to the server once, then removed (state/legacyDrawings.ts).
//
// A session's drawings belong to THAT session (`overlaysBySession`), so markings don't
// bleed between sessions. `overlaysByInstrument` is the "shared" layer (what used to be
// the only set, per instrument): a session never edits or deletes it, and shows it only
// when that session's "Shared drawings" toggle is on. The automated-run review chart (no
// session) draws on it directly.

// REPLICA_ROADMAP.md Batch 4's drawing-toolbar favorites row: the last few
// DISTINCT tool names armed, most-recent-first. Lives here (not new local
// state in KLDrawingToolbar) so it survives a reload the same way the
// drawings themselves do. Capped well below the full ~20-tool catalog so the
// flyout stays a quick-pick, not a second copy of the tool list.
const MAX_RECENT_TOOLS = 5

// A drawing's style as the style popover edits it (colour + line width).
export interface DrawingStyle {
  color: string
  width: number
}

export interface DrawingStyleTemplate {
  id: string
  name: string
  style: DrawingStyle
}

// A named chart layout, saved per session: the indicators on, the chart type
// and timeframe, and which drawings are visible (the session's own drawings,
// per instrument, with their per-drawing hidden flags, plus the shared layer).
export interface NamedLayout {
  id: string
  name: string
  indicators: Pick<IndicatorPrefs, 'sessionShading' | 'fairValue' | 'newsEvents' | 'vwap' | 'ema20' | 'ema50' | 'atr14' | 'volume'>
  candleType: string
  timeframe: string
  drawings: Record<string, PersistedOverlay[]>
  sharedVisible: boolean
}

interface KLDrawingState {
  // The shared layer (and the review chart's drawings): per instrument.
  overlaysByInstrument: Record<string, PersistedOverlay[]>
  setOverlaysForInstrument: (instrument: string, overlays: PersistedOverlay[]) => void
  clearForInstrument: (instrument: string) => void
  // G9: a session's own drawings, per instrument.
  overlaysBySession: Record<string, Record<string, PersistedOverlay[]>>
  setOverlaysForSession: (sessionId: string, instrument: string, overlays: PersistedOverlay[]) => void
  setSessionDrawings: (sessionId: string, drawings: Record<string, PersistedOverlay[]>) => void
  // Whether a session shows the shared layer (off until switched on).
  sharedVisibleBySession: Record<string, boolean>
  setSharedVisible: (sessionId: string, visible: boolean) => void
  layoutsBySession: Record<string, NamedLayout[]>
  saveLayout: (sessionId: string, layout: NamedLayout) => void
  deleteLayout: (sessionId: string, layoutId: string) => void
  styleTemplates: DrawingStyleTemplate[]
  saveStyleTemplate: (template: DrawingStyleTemplate) => void
  deleteStyleTemplate: (id: string) => void
  // The template new drawings are created with (null = the default style).
  newDrawingTemplateId: string | null
  setNewDrawingTemplateId: (id: string | null) => void
  recentTools: string[]
  recordToolUsed: (name: string) => void
  // Bumped each time drawingsSync loads server data into the store, so a chart that
  // already restored (from what was then an empty store) draws again.
  serverRevision: number
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
      overlaysBySession: {},
      setOverlaysForSession: (sessionId, instrument, overlays) =>
        set((s) => ({
          overlaysBySession: {
            ...s.overlaysBySession,
            [sessionId]: { ...(s.overlaysBySession[sessionId] ?? {}), [instrument]: overlays },
          },
        })),
      setSessionDrawings: (sessionId, drawings) =>
        set((s) => ({ overlaysBySession: { ...s.overlaysBySession, [sessionId]: drawings } })),
      sharedVisibleBySession: {},
      setSharedVisible: (sessionId, visible) =>
        set((s) => ({ sharedVisibleBySession: { ...s.sharedVisibleBySession, [sessionId]: visible } })),
      layoutsBySession: {},
      saveLayout: (sessionId, layout) =>
        set((s) => {
          const existing = s.layoutsBySession[sessionId] ?? []
          // Saving under a name already used replaces that layout.
          const kept = existing.filter((l) => l.id !== layout.id && l.name.toLowerCase() !== layout.name.toLowerCase())
          return { layoutsBySession: { ...s.layoutsBySession, [sessionId]: [...kept, layout] } }
        }),
      deleteLayout: (sessionId, layoutId) =>
        set((s) => ({
          layoutsBySession: {
            ...s.layoutsBySession,
            [sessionId]: (s.layoutsBySession[sessionId] ?? []).filter((l) => l.id !== layoutId),
          },
        })),
      styleTemplates: [],
      saveStyleTemplate: (template) =>
        set((s) => ({
          styleTemplates: [
            ...s.styleTemplates.filter((t) => t.id !== template.id && t.name.toLowerCase() !== template.name.toLowerCase()),
            template,
          ],
        })),
      deleteStyleTemplate: (id) =>
        set((s) => ({
          styleTemplates: s.styleTemplates.filter((t) => t.id !== id),
          newDrawingTemplateId: s.newDrawingTemplateId === id ? null : s.newDrawingTemplateId,
        })),
      newDrawingTemplateId: null,
      setNewDrawingTemplateId: (newDrawingTemplateId) => set({ newDrawingTemplateId }),
      recentTools: [],
      recordToolUsed: (name) =>
        set((s) => ({ recentTools: [name, ...s.recentTools.filter((t) => t !== name)].slice(0, MAX_RECENT_TOOLS) })),
      serverRevision: 0,
    }),
    {
      // A NEW key, and only the favourites row: the old 'propbt-viz:kl-drawings' blob is
      // read by the one-off migration alone (legacyDrawings.ts), never rehydrated into here.
      name: 'propbt-viz:kl-recent-tools',
      partialize: (s) => ({ recentTools: s.recentTools }),
    },
  ),
)

export function overlaysForInstrument(
  overlaysByInstrument: Record<string, PersistedOverlay[]>,
  instrument: string | null,
): PersistedOverlay[] {
  if (!instrument) return []
  return overlaysByInstrument[instrument] ?? []
}

// A session's own drawings on one instrument (never the shared layer).
export function overlaysForSession(
  overlaysBySession: Record<string, Record<string, PersistedOverlay[]>>,
  sessionId: string,
  instrument: string | null,
): PersistedOverlay[] {
  if (!instrument) return []
  return overlaysBySession[sessionId]?.[instrument] ?? []
}

// What a chart shows for (session, instrument): the session's own drawings, and the shared
// layer only when it is switched on. `shared` overlays are display-only copies: they are drawn
// locked and never written back anywhere.
export function drawingLayers(
  state: Pick<KLDrawingState, 'overlaysByInstrument' | 'overlaysBySession' | 'sharedVisibleBySession'>,
  sessionId: string,
  instrument: string | null,
): { own: PersistedOverlay[]; shared: PersistedOverlay[] } {
  return {
    own: overlaysForSession(state.overlaysBySession, sessionId, instrument),
    shared: state.sharedVisibleBySession[sessionId] ? overlaysForInstrument(state.overlaysByInstrument, instrument) : [],
  }
}

// A layout's drawings with the snapshot's per-drawing state, deep-copied so a later edit of the
// live drawings can never reach into a saved layout (or the reverse).
export function cloneDrawings(drawings: Record<string, PersistedOverlay[]>): Record<string, PersistedOverlay[]> {
  return JSON.parse(JSON.stringify(drawings)) as Record<string, PersistedOverlay[]>
}
