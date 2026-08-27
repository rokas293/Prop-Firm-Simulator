// Persisted chart data defaults (POLISH_ROADMAP Phase P6's Settings panel:
// "manage... data defaults"). Bracket density used to be ChartPanel-local
// useState -- lifted here so it's a genuine cross-session default, settable
// from either ChartPanel's own toolbar or the Settings panel, both reading
// the same store.
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { BracketDensity } from '../chart/tradeBracket'

interface ChartDefaultsState {
  bracketDensity: BracketDensity
  setBracketDensity: (d: BracketDensity) => void
}

export const useChartDefaultsStore = create<ChartDefaultsState>()(
  persist(
    (set) => ({
      bracketDensity: 'auto',
      setBracketDensity: (d) => set({ bracketDensity: d }),
    }),
    { name: 'propbt-viz:chart-defaults' },
  ),
)
