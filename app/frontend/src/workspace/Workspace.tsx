import { useCallback, useEffect, useRef, useState, type FunctionComponent } from 'react'
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
import { applyAnalysisLayout, PRESETS } from './presets'
import { CHART_PANEL_ID, DASHBOARD_PANEL_ID, EQUITY_PANEL_ID, PANEL_DEFS, PROP_RISK_PANEL_ID, TRADE_LIST_PANEL_ID } from './panelIds'

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
// job is just registering panel components, restoring/auto-saving the
// layout, and offering preset/reset/add-panel controls.
export default function Workspace() {
  const runId = useUiStore((s) => s.selectedRunId)
  const clearFilters = useTradeStore((s) => s.clearFilters)
  const selectTrade = useTradeStore((s) => s.selectTrade)
  const resetChartViewForNewRun = useChartViewStore((s) => s.resetForNewRun)

  const lastLayout = useLayoutStore((s) => s.lastLayout)
  const setLastLayout = useLayoutStore((s) => s.setLastLayout)
  const clearLastLayout = useLayoutStore((s) => s.clearLastLayout)
  const setApi = useWorkspaceApiStore((s) => s.setApi)

  // Workspace stays mounted for as long as some run is selected (App.tsx
  // only swaps it out for the runs list / compare view), so this is the
  // one place a run-change reset is guaranteed to fire exactly once per
  // switch regardless of which panels happen to be open at the time.
  useEffect(() => {
    clearFilters()
    selectTrade(null)
    resetChartViewForNewRun()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId])

  const apiRef = useRef<DockviewReadyEvent['api'] | null>(null)
  const saveTimeoutRef = useRef<number | null>(null)
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  // Bumped on every layout change so the "+" menu's open/closed panel list
  // (derived from apiRef, not React state) recomputes on the next render.
  const [layoutTick, setLayoutTick] = useState(0)

  const scheduleSave = useCallback(() => {
    if (saveTimeoutRef.current !== null) window.clearTimeout(saveTimeoutRef.current)
    saveTimeoutRef.current = window.setTimeout(() => {
      if (apiRef.current) setLastLayout(apiRef.current.toJSON())
    }, SAVE_DEBOUNCE_MS)
  }, [setLastLayout])

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
        setLayoutTick((n) => n + 1)
      })
    },
    [lastLayout, scheduleSave, setApi],
  )

  const resetLayout = () => {
    if (!apiRef.current) return
    clearLastLayout()
    applyAnalysisLayout(apiRef.current)
  }

  const openPanelIds = new Set(apiRef.current?.panels.map((p) => p.id) ?? [])
  const closedPanels = PANEL_DEFS.filter((p) => !openPanelIds.has(p.id))
  void layoutTick // recomputation trigger only; value itself is unused

  const addPanel = (id: string) => {
    const def = PANEL_DEFS.find((p) => p.id === id)
    if (!def || !apiRef.current) return
    apiRef.current.addPanel({ id: def.id, component: def.component, title: def.title })
    setAddMenuOpen(false)
  }

  return (
    <div className="flex h-[calc(100vh-49px)] flex-col">
      <div className="flex items-center gap-2 border-b border-border px-4 py-1.5 text-xs">
        <span className="text-text-muted">Layout:</span>
        {PRESETS.map((p) => (
          <button
            key={p.name}
            onClick={() => apiRef.current && p.apply(apiRef.current)}
            className="rounded bg-surface-2 px-2 py-1 text-text hover:bg-surface-2-hover"
          >
            {p.name}
          </button>
        ))}
        <button
          onClick={resetLayout}
          className="rounded bg-surface-2 px-2 py-1 text-text hover:bg-surface-2-hover"
        >
          Reset layout
        </button>

        <div className="relative ml-auto">
          <button
            onClick={() => setAddMenuOpen((o) => !o)}
            className="rounded bg-surface-2 px-2 py-1 text-text hover:bg-surface-2-hover"
          >
            + Panel
          </button>
          {addMenuOpen && (
            <div className="absolute right-0 top-full z-10 mt-1 w-40 rounded border border-border bg-surface py-1 shadow-lg">
              {closedPanels.length === 0 ? (
                <div className="px-3 py-1.5 text-text-muted">All panels open</div>
              ) : (
                closedPanels.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => addPanel(p.id)}
                    className="block w-full px-3 py-1.5 text-left text-text hover:bg-surface-2"
                  >
                    {p.title}
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1">
        <DockviewReact className="dockview-theme-propbt" components={COMPONENTS} onReady={onReady} />
      </div>
    </div>
  )
}
