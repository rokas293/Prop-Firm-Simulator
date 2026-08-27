import type { AddPanelOptions, DockviewApi } from 'dockview-react'
import { CHART_PANEL_ID, DASHBOARD_PANEL_ID, EQUITY_PANEL_ID, PANEL_DEFS, PROP_RISK_PANEL_ID, TRADE_LIST_PANEL_ID } from './panelIds'

function titleFor(id: string): string {
  return PANEL_DEFS.find((p) => p.id === id)?.title ?? id
}

function add(api: DockviewApi, options: AddPanelOptions): void {
  api.addPanel(options)
}

// The default layout, and the "Analysis" preset: Chart is the hero (large,
// top-left), Trade List alongside it, Dashboard/Prop Risk/Equity tabbed
// together below so all three are one click away without crowding the chart.
export function applyAnalysisLayout(api: DockviewApi): void {
  api.clear()
  add(api, { id: CHART_PANEL_ID, component: CHART_PANEL_ID, title: titleFor(CHART_PANEL_ID) })
  add(api, {
    id: TRADE_LIST_PANEL_ID,
    component: TRADE_LIST_PANEL_ID,
    title: titleFor(TRADE_LIST_PANEL_ID),
    position: { direction: 'right', referencePanel: CHART_PANEL_ID },
    initialWidth: 420,
  })
  add(api, {
    id: DASHBOARD_PANEL_ID,
    component: DASHBOARD_PANEL_ID,
    title: titleFor(DASHBOARD_PANEL_ID),
    position: { direction: 'below', referencePanel: CHART_PANEL_ID },
    // initialHeight alone was landing close to a 50/50 split in practice --
    // maximumHeight structurally caps this group so Chart stays the hero
    // regardless of window size, not just as an initial-size hint.
    initialHeight: 260,
    maximumHeight: 340,
  })
  add(api, {
    id: PROP_RISK_PANEL_ID,
    component: PROP_RISK_PANEL_ID,
    title: titleFor(PROP_RISK_PANEL_ID),
    position: { direction: 'within', referencePanel: DASHBOARD_PANEL_ID },
  })
  add(api, {
    id: EQUITY_PANEL_ID,
    component: EQUITY_PANEL_ID,
    title: titleFor(EQUITY_PANEL_ID),
    position: { direction: 'within', referencePanel: DASHBOARD_PANEL_ID },
  })
  api.getPanel(CHART_PANEL_ID)?.api.setActive()
}

// "Chart-focused": just the chart and the trade list that drives it.
// Dashboard/Prop Risk/Equity are closed, not hidden -- reopen any of them
// from the "+" menu or the command palette when needed.
export function applyChartFocusedLayout(api: DockviewApi): void {
  api.clear()
  add(api, { id: CHART_PANEL_ID, component: CHART_PANEL_ID, title: titleFor(CHART_PANEL_ID) })
  add(api, {
    id: TRADE_LIST_PANEL_ID,
    component: TRADE_LIST_PANEL_ID,
    title: titleFor(TRADE_LIST_PANEL_ID),
    position: { direction: 'right', referencePanel: CHART_PANEL_ID },
    initialWidth: 340,
  })
  api.getPanel(CHART_PANEL_ID)?.api.setActive()
}

// "Stats": Dashboard/Prop Risk/Equity given the most room, Chart + Trade
// List demoted to a smaller tabbed corner for quick reference.
export function applyStatsLayout(api: DockviewApi): void {
  api.clear()
  add(api, { id: DASHBOARD_PANEL_ID, component: DASHBOARD_PANEL_ID, title: titleFor(DASHBOARD_PANEL_ID) })
  add(api, {
    id: PROP_RISK_PANEL_ID,
    component: PROP_RISK_PANEL_ID,
    title: titleFor(PROP_RISK_PANEL_ID),
    position: { direction: 'right', referencePanel: DASHBOARD_PANEL_ID },
  })
  add(api, {
    id: EQUITY_PANEL_ID,
    component: EQUITY_PANEL_ID,
    title: titleFor(EQUITY_PANEL_ID),
    position: { direction: 'within', referencePanel: PROP_RISK_PANEL_ID },
  })
  add(api, {
    id: CHART_PANEL_ID,
    component: CHART_PANEL_ID,
    title: titleFor(CHART_PANEL_ID),
    position: { direction: 'below', referencePanel: DASHBOARD_PANEL_ID },
    initialHeight: 280,
  })
  add(api, {
    id: TRADE_LIST_PANEL_ID,
    component: TRADE_LIST_PANEL_ID,
    title: titleFor(TRADE_LIST_PANEL_ID),
    position: { direction: 'within', referencePanel: CHART_PANEL_ID },
  })
  api.getPanel(DASHBOARD_PANEL_ID)?.api.setActive()
}

export interface PresetDef {
  name: string
  apply: (api: DockviewApi) => void
}

export const PRESETS: PresetDef[] = [
  { name: 'Analysis', apply: applyAnalysisLayout },
  { name: 'Chart-focused', apply: applyChartFocusedLayout },
  { name: 'Stats', apply: applyStatsLayout },
]
