import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface IndicatorPrefs {
  sessionShading: boolean
  fairValue: boolean
  vwap: boolean
  ema20: boolean
  ema50: boolean
  atr14: boolean
}

const DEFAULT_PREFS: IndicatorPrefs = {
  sessionShading: true,
  fairValue: true,
  vwap: true,
  ema20: false,
  ema50: false,
  atr14: false,
}

interface IndicatorState extends IndicatorPrefs {
  toggle: (key: keyof IndicatorPrefs) => void
}

// Persisted to localStorage so a user's overlay choices survive a reload
// (VIZ_SPEC Phase V5: "remember choices in localStorage").
export const useIndicatorStore = create<IndicatorState>()(
  persist(
    (set) => ({
      ...DEFAULT_PREFS,
      toggle: (key) => set((s) => ({ [key]: !s[key] }) as Partial<IndicatorState>),
    }),
    { name: 'propbt-viz:indicator-prefs' },
  ),
)
