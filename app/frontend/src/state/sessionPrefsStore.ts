// FXR_V2_SPEC.md section 2 (G1): per-viewer preferences of the session
// workspace shell -- the smooth-candles option (G5; the step size and chart
// timeframe are per SESSION now and live on it), the
// bottom bar's hide-trades / hide-balances eyes, and the trade panel's open
// state and height. Persisted to localStorage like the other view-state
// stores; none of it is session data (that lives on the backend).
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { KLCandleType } from '../chart/kl/ChartKL'
import type { BalanceBasis } from '../chart/orderTicket'

export const PANEL_MIN_HEIGHT = 96
export const PANEL_DEFAULT_HEIGHT = 192
// The panel may take at most this fraction of the viewport height.
export const PANEL_MAX_VIEWPORT_FRACTION = 0.6

export type TradePanelTab = 'positions' | 'orders' | 'history'

export function clampPanelHeight(height: number, viewportHeight: number): number {
  const max = Math.max(PANEL_MIN_HEIGHT, Math.floor(viewportHeight * PANEL_MAX_VIEWPORT_FRACTION))
  return Math.max(PANEL_MIN_HEIGHT, Math.min(max, Math.round(height)))
}

interface SessionPrefsState {
  // G5: glide the forming candle between steps during auto-play. Cosmetic only.
  smoothCandles: boolean
  setSmoothCandles: (v: boolean) => void
  candleType: KLCandleType
  setCandleType: (t: KLCandleType) => void
  hideTrades: boolean
  setHideTrades: (v: boolean) => void
  hideBalances: boolean
  setHideBalances: (v: boolean) => void
  panelOpen: boolean
  setPanelOpen: (v: boolean) => void
  panelHeight: number
  setPanelHeight: (h: number) => void
  panelTab: TradePanelTab
  setPanelTab: (t: TradePanelTab) => void
  // The Place Order dialog's balance basis (FXR_V2_SPEC.md 3.5): what a risk
  // percentage is a percentage OF. Remembered between orders.
  riskBasis: BalanceBasis
  setRiskBasis: (b: BalanceBasis) => void
}

export const useSessionPrefsStore = create<SessionPrefsState>()(
  persist(
    (set) => ({
      smoothCandles: false,
      setSmoothCandles: (smoothCandles) => set({ smoothCandles }),
      candleType: 'candle_solid',
      setCandleType: (candleType) => set({ candleType }),
      hideTrades: false,
      setHideTrades: (hideTrades) => set({ hideTrades }),
      hideBalances: false,
      setHideBalances: (hideBalances) => set({ hideBalances }),
      panelOpen: false,
      setPanelOpen: (panelOpen) => set({ panelOpen }),
      panelHeight: PANEL_DEFAULT_HEIGHT,
      setPanelHeight: (panelHeight) => set({ panelHeight }),
      panelTab: 'positions',
      setPanelTab: (panelTab) => set({ panelTab }),
      riskBasis: 'current',
      setRiskBasis: (riskBasis) => set({ riskBasis }),
    }),
    { name: 'propbt-viz:session-prefs' },
  ),
)
