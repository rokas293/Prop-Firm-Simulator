import type { ReactNode } from 'react'

// The one card frame for chart/table/content boxes (REDESIGN_APPROACH.md
// Phase B2) -- consolidates what used to be ChartCard, BreakdownTable's own
// duplicate wrapper markup, and a handful of ad hoc `rounded border
// border-border bg-surface p-4` divs scattered across
// Dashboard/Compass/Equity into one component. `title` covers the common
// "chart or table in a labeled box" case; for a compound header (title +
// an action button, e.g. the AI insight card) render your own header row
// as the first child instead of passing `title`.
export default function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="rounded border border-border bg-surface p-4">
      {title && <div className="mb-2 text-sm font-medium text-text">{title}</div>}
      {children}
    </div>
  )
}
