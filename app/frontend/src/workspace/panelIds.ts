// Stable panel identifiers shared across the workspace: dockview panel
// registration, layout presets, cross-panel "reveal" actions (Dashboard's
// leg/session cross-filter, the command palette), and layout persistence.
// Keep these stable -- changing one invalidates anyone's saved layout that
// references it (WorkspaceLayoutStore already tolerates unknown ids by
// falling back to the default layout, but it's still churn to avoid).
//
// The Compass panel (id 'compass') was folded into Dashboard as tabs
// (REDESIGN_APPROACH.md Phase B2) -- a saved layout that still references
// it will fail api.fromJSON() and fall back to the default layout
// (Workspace.tsx's own try/catch), the same graceful path already used for
// any other stale/incompatible saved layout.
export const CHART_PANEL_ID = 'chart'
export const TRADE_LIST_PANEL_ID = 'trade-list'
export const DASHBOARD_PANEL_ID = 'dashboard'
export const PROP_RISK_PANEL_ID = 'prop-risk'
export const EQUITY_PANEL_ID = 'equity'

export type PanelId =
  | typeof CHART_PANEL_ID
  | typeof TRADE_LIST_PANEL_ID
  | typeof DASHBOARD_PANEL_ID
  | typeof PROP_RISK_PANEL_ID
  | typeof EQUITY_PANEL_ID

export interface PanelDef {
  id: PanelId
  title: string
  component: PanelId
}

export const PANEL_DEFS: PanelDef[] = [
  { id: CHART_PANEL_ID, title: 'Chart', component: CHART_PANEL_ID },
  { id: TRADE_LIST_PANEL_ID, title: 'Trade List', component: TRADE_LIST_PANEL_ID },
  { id: DASHBOARD_PANEL_ID, title: 'Dashboard', component: DASHBOARD_PANEL_ID },
  { id: PROP_RISK_PANEL_ID, title: 'Prop Risk', component: PROP_RISK_PANEL_ID },
  { id: EQUITY_PANEL_ID, title: 'Equity', component: EQUITY_PANEL_ID },
]
