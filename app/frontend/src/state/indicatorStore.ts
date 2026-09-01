import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface IndicatorPrefs {
  sessionShading: boolean
  fairValue: boolean
  vwap: boolean
  ema20: boolean
  ema50: boolean
  atr14: boolean
  // REPLICA_ROADMAP.md Batch 3: volume was previously an unconditional
  // mount-time createIndicator('VOL', ...) in ChartKL.tsx, not gated by any
  // pref at all -- pulled into the same on/off model as every other
  // indicator so the on-chart legend's "remove" and the add-indicator
  // dialog can actually turn it off (REPLICA_ROADMAP.md Batch 3's "remove
  // sub-panes" needs SOME toggle to remove volume's sub-pane through).
  volume: boolean
}

// Colorable indicators only -- the four backend pass-through LINE
// indicators (indicators.ts). Volume's color is theme-bound up/down bars,
// not a single line, so it has no swatch-worthy setting; session shading/
// fair value are overlays (sessionOverlay.ts), not klinecharts Indicators,
// and already carry their own theme-accent styling.
export type ColorableIndicatorKey = 'vwap' | 'ema20' | 'ema50' | 'atr14'

const DEFAULT_PREFS: IndicatorPrefs = {
  sessionShading: true,
  fairValue: true,
  vwap: true,
  ema20: false,
  ema50: false,
  atr14: false,
  volume: true,
}

interface IndicatorState extends IndicatorPrefs {
  // Per-indicator line-color override (REPLICA_ROADMAP.md Batch 3's
  // on-chart legend "settings" control) -- unset means "use the theme
  // default" (ChartKL.tsx resolves the fallback, same as every other
  // theme-driven color in this app). Persisted so a picked color survives
  // a reload, same as the on/off prefs below.
  colors: Partial<Record<ColorableIndicatorKey, string>>
  toggle: (key: keyof IndicatorPrefs) => void
  setIndicatorColor: (key: ColorableIndicatorKey, hex: string | null) => void
}

// Persisted to localStorage so a user's overlay choices survive a reload
// (VIZ_SPEC Phase V5: "remember choices in localStorage").
export const useIndicatorStore = create<IndicatorState>()(
  persist(
    (set) => ({
      ...DEFAULT_PREFS,
      colors: {},
      toggle: (key) => set((s) => ({ [key]: !s[key] }) as Partial<IndicatorState>),
      setIndicatorColor: (key, hex) =>
        set((s) => {
          const colors = { ...s.colors }
          if (hex === null) delete colors[key]
          else colors[key] = hex
          return { colors }
        }),
    }),
    { name: 'propbt-viz:indicator-prefs' },
  ),
)
