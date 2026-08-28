import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type ChartEngine = 'lwc' | 'kl'

interface ChartEngineState {
  engine: ChartEngine
  setEngine: (engine: ChartEngine) => void
}

// REDESIGN_APPROACH.md Phase A0 / PART_A_REVISED_klinecharts.md's feature
// flag: lightweight-charts stays the default engine until the KLineCharts
// migration reaches verified parity, at which point this flag and the old
// engine both get deleted per that plan's "keep the old chart until
// parity, then delete" principle -- this is a temporary comparison switch,
// not a permanent user preference.
//
// Storage key bumped from the original TradingView-era attempt
// (:chart-engine -> :chart-engine-v2) since that store's values were
// 'lwc' | 'tv' -- 'tv' would otherwise linger in a browser's localStorage
// and no longer match either of this store's valid engine values.
export const useChartEngineStore = create<ChartEngineState>()(
  persist(
    (set) => ({
      engine: 'lwc',
      setEngine: (engine) => set({ engine }),
    }),
    { name: 'propbt-viz:chart-engine-v2' },
  ),
)
