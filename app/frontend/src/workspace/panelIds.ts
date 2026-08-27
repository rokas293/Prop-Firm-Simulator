// Stable panel identifiers shared across the workspace: dockview panel
// registration, layout presets, cross-panel "reveal" actions (Dashboard's
// leg/session cross-filter, the command palette), and layout persistence.
// Keep these stable -- changing one invalidates anyone's saved layout that
// references it (WorkspaceLayoutStore already tolerates unknown ids by
// falling back to the default layout, but it's still churn to avoid).
export const CHART_PANEL_ID = 'chart'
export const TRADE_LIST_PANEL_ID = 'trade-list'
export const DASHBOARD_PANEL_ID = 'dashboard'
export const PROP_RISK_PANEL_ID = 'prop-risk'
export const EQUITY_PANEL_ID = 'equity'
export const COMPASS_PANEL_ID = 'compass'

export type PanelId =
  | typeof CHART_PANEL_ID
  | typeof TRADE_LIST_PANEL_ID
  | typeof DASHBOARD_PANEL_ID
  | typeof PROP_RISK_PANEL_ID
  | typeof EQUITY_PANEL_ID
  | typeof COMPASS_PANEL_ID

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
  { id: COMPASS_PANEL_ID, title: 'Compass', component: COMPASS_PANEL_ID },
]
