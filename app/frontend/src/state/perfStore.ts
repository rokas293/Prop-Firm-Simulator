// Backs the perf HUD (POLISH_ROADMAP Phase P4: "a tiny perf HUD (toggle)
// showing render time / fetch time while developing"). Not persisted --
// this is a dev-session diagnostic, not user preference. Kept as plain
// ring buffers rather than growing forever, since a long session could
// otherwise leak thousands of entries.
import { create } from 'zustand'

export interface FetchSample {
  path: string
  ms: number
  at: number
}

export interface RenderSample {
  id: string
  phase: 'mount' | 'update' | 'nested-update'
  ms: number
  at: number
}

const MAX_SAMPLES = 40

interface PerfState {
  enabled: boolean
  toggle: () => void
  fetchSamples: FetchSample[]
  renderSamples: RenderSample[]
  recordFetch: (path: string, ms: number) => void
  recordRender: (id: string, phase: RenderSample['phase'], ms: number) => void
}

export const usePerfStore = create<PerfState>((set, get) => ({
  enabled: false,
  toggle: () => set((s) => ({ enabled: !s.enabled })),
  fetchSamples: [],
  renderSamples: [],
  // Callers (client.ts's request(), PerfProfiler's onRender) invoke these
  // unconditionally on every fetch/render -- gate on `enabled` here, not at
  // every call site, so turning the HUD off actually stops the bookkeeping
  // instead of just hiding it.
  recordFetch: (path, ms) => {
    if (!get().enabled) return
    set((s) => ({ fetchSamples: [...s.fetchSamples.slice(-(MAX_SAMPLES - 1)), { path, ms, at: Date.now() }] }))
  },
  recordRender: (id, phase, ms) => {
    if (!get().enabled) return
    set((s) => ({
      renderSamples: [...s.renderSamples.slice(-(MAX_SAMPLES - 1)), { id, phase, ms, at: Date.now() }],
    }))
  },
}))
