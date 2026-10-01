import { useCallback, useEffect, useRef, type FunctionComponent } from 'react'
import {
  DockviewReact,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
  type SerializedDockview,
} from 'dockview-react'
import 'dockview-react/dist/styles/dockview.css'
import ChartPanel from '../panels/ChartPanel'
import TradeListPanel from '../panels/TradeListPanel'
import DashboardPanel from '../panels/DashboardPanel'
import RiskPanel from '../panels/RiskPanel'
import EquityPanel from '../panels/EquityPanel'
import PerfProfiler from '../components/PerfProfiler'
import { useLayoutStore } from '../state/layoutStore'
import { useWorkspaceApiStore } from '../state/workspaceApiStore'
import { useUiStore } from '../state/uiStore'
import { useTradeStore } from '../state/tradeStore'
import { useChartViewStore } from '../state/chartViewStore'
import { applyAnalysisLayout } from './presets'
import { CHART_PANEL_ID, DASHBOARD_PANEL_ID, EQUITY_PANEL_ID, PROP_RISK_PANEL_ID, TRADE_LIST_PANEL_ID } from './panelIds'

// Perf-instruments every panel from one place (POLISH_ROADMAP Phase P4)
// rather than touching all 5 panel files -- each panel is registered with
// dockview exactly once, here, so this is the natural seam. PerfProfiler
// itself is a no-op passthrough unless the HUD is toggled on.
function withPerf(id: string, Component: FunctionComponent<IDockviewPanelProps>): FunctionComponent<IDockviewPanelProps> {
  return function PerfWrapped(props) {
    return (
      <PerfProfiler id={id}>
        <Component {...props} />
      </PerfProfiler>
    )
  }
}

const COMPONENTS: Record<string, FunctionComponent<IDockviewPanelProps>> = {
  [CHART_PANEL_ID]: withPerf('Chart', ChartPanel),
  [TRADE_LIST_PANEL_ID]: withPerf('Trade List', TradeListPanel),
  [DASHBOARD_PANEL_ID]: withPerf('Dashboard', DashboardPanel),
  [PROP_RISK_PANEL_ID]: withPerf('Prop Risk', RiskPanel),
  [EQUITY_PANEL_ID]: withPerf('Equity', EquityPanel),
}

const SAVE_DEBOUNCE_MS = 400

// The dockable workspace shell (POLISH_ROADMAP Phase P1), replacing the old
// fixed Chart/Dashboard/Risk tab bar. Layout state (which panels are open,
// their arrangement/sizes) lives entirely inside dockview; this component's
// job is just registering panel components and restoring/auto-saving the
// layout. Preset/reset/add-panel controls (REPLICA_AUDIT.md Top 10 #8) live
// in ChartLayoutMenu.tsx's popover now, not as a permanent row here -- they
// read/drive the same `useWorkspaceApiStore` instance this component
// publishes below, so moving them cost no coordination.
export default function Workspace() {
  const runId = useUiStore((s) => s.selectedRunId)
  const clearFilters = useTradeStore((s) => s.clearFilters)
  const selectTrade = useTradeStore((s) => s.selectTrade)
  const setTradeNavFocused = useTradeStore((s) => s.setTradeNavFocused)
  const resetChartViewForNewRun = useChartViewStore((s) => s.resetForNewRun)

  const lastLayout = useLayoutStore((s) => s.lastLayout)
  const setLastLayout = useLayoutStore((s) => s.setLastLayout)
  const setApi = useWorkspaceApiStore((s) => s.setApi)
  // REPLICA_ROADMAP.md Batch 5's distraction-free mode.
  const distractionFree = useUiStore((s) => s.distractionFree)

  // Workspace stays mounted for as long as some run is selected (App.tsx
  // only swaps it out for the runs list / compare view), so this is the
  // one place a run-change reset is guaranteed to fire exactly once per
  // switch regardless of which panels happen to be open at the time.
  useEffect(() => {
    clearFilters()
    selectTrade(null)
    setTradeNavFocused(false)
    resetChartViewForNewRun()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId])

  const apiRef = useRef<DockviewReadyEvent['api'] | null>(null)
  const saveTimeoutRef = useRef<number | null>(null)

  const scheduleSave = useCallback(() => {
    if (saveTimeoutRef.current !== null) window.clearTimeout(saveTimeoutRef.current)
    saveTimeoutRef.current = window.setTimeout(() => {
      const api = apiRef.current
      // Never persist an empty dock: tearing the workspace down (e.g. "Open in
      // journal" -> the session view) makes dockview drop its panels, which
      // fires a layout change; saving THAT would restore blank groups with no
      // tabs the next time the workspace opens.
      if (api && api.panels.length > 0) setLastLayout(api.toJSON())
    }, SAVE_DEBOUNCE_MS)
  }, [setLastLayout])

  // And a save still pending when the workspace unmounts must not fire at all.
  useEffect(
    () => () => {
      if (saveTimeoutRef.current !== null) window.clearTimeout(saveTimeoutRef.current)
      apiRef.current = null
    },
    [],
  )

  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      const api = event.api
      apiRef.current = api
      setApi(api)

      let restored = false
      if (lastLayout?.data) {
        try {
          api.fromJSON(lastLayout.data as SerializedDockview)
          restored = true
        } catch {
          // Stale/incompatible saved layout (e.g. after a panel-id change
          // during development) -- fall back to the default rather than
          // leaving the workspace blank.
          restored = false
        }
      }
      if (!restored) {
        applyAnalysisLayout(api)
      }

      api.onDidLayoutChange(() => {
        scheduleSave()
      })
    },
    [lastLayout, scheduleSave, setApi],
  )

  return (
    <div className={`flex flex-col ${distractionFree ? 'h-screen' : 'h-[calc(100vh-49px)]'}`}>
      <div className="min-h-0 flex-1">
        <DockviewReact className="dockview-theme-propbt" components={COMPONENTS} onReady={onReady} />
      </div>
    </div>
  )
}
