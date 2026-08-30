// Shared Recharts chrome (DESIGN_AUDIT.md "quiet Recharts chrome"), used by
// every Recharts chart in the app (DashboardPanel, EquityPanel). Recharts'
// own defaults for axisLine/tickLine are a hardcoded mid-gray, not tied to
// the theme at all -- confirmed live (getComputedStyle) brighter than even
// --color-border, so it stood out against the deliberately muted grid
// instead of receding with it.
//
// Tabular figures on the tick text itself are index.css's
// .recharts-cartesian-axis-tick-value rule, not set here -- Recharts
// converts this style object to SVG presentation attributes (fill,
// font-size), silently dropping fontVariantNumeric, confirmed by inspecting
// the rendered <text>'s own attributes. The Tooltip's contentStyle DOES
// work as a normal inline style (it's a plain HTML div, not SVG), so
// fontVariantNumeric is set here for that one.
export const AXIS_TICK_STYLE = { fill: 'var(--color-text-muted)', fontSize: 11 }
export const AXIS_LINE_STYLE = { stroke: 'var(--color-border)' }
export const TOOLTIP_CONTENT_STYLE = {
  background: 'var(--color-surface)',
  border: '1px solid var(--color-border)',
  fontVariantNumeric: 'tabular-nums' as const,
}
