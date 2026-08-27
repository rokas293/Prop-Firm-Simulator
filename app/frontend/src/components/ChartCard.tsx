import type { ReactNode } from 'react'

// Shared chart-with-title card frame -- extracted from DashboardPanel
// (POLISH_ROADMAP Phase P5) so every Recharts panel across Dashboard and
// Compass shares the same chrome.
export default function ChartCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded border border-neutral-800 bg-neutral-900 p-4">
      <div className="mb-2 text-sm font-medium text-neutral-300">{title}</div>
      {children}
    </div>
  )
}
