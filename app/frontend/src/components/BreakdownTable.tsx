import Card from './Card'
import { fmtPct, fmtR, fmtUsd } from '../format'
import type { GroupStats } from '../api/types'

// Shared per-group stats table with click-to-filter rows -- the one copy
// the merged Dashboard panel's Breakdowns tab renders (REDESIGN_APPROACH.md
// Phase B2; previously duplicated verbatim between the old Dashboard and
// Compass panels).
export default function BreakdownTable({
  title,
  rows,
  onRowClick,
}: {
  title: string
  rows: Record<string, GroupStats>
  onRowClick: (key: string) => void
}) {
  const entries = Object.entries(rows).sort((a, b) => b[1].trades - a[1].trades)
  return (
    <Card title={title}>
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-b border-border text-left">
            <th className="micro-label py-1.5 pr-3 text-left"></th>
            <th className="num micro-label py-1.5 pr-3">Trades</th>
            <th className="num micro-label py-1.5 pr-3">Win rate</th>
            <th className="num micro-label py-1.5 pr-3">Expectancy</th>
            <th className="num micro-label py-1.5 pr-3">Total R</th>
          </tr>
        </thead>
        <tbody>
          {entries.map(([key, g]) => (
            <tr
              key={key}
              onClick={() => onRowClick(key)}
              className="cursor-pointer border-b border-border hover:bg-surface-2"
              title={`Filter trade list + chart to ${key}`}
            >
              <td className="py-1.5 pr-3 text-text">{key}</td>
              <td className="num py-1.5 pr-3 text-text">{g.trades}</td>
              <td className="num py-1.5 pr-3 text-text">{fmtPct(g.win_rate)}</td>
              <td className={`num py-1.5 pr-3 ${(g.expectancy_usd ?? 0) >= 0 ? 'text-positive' : 'text-negative'}`}>
                {fmtUsd(g.expectancy_usd)}
              </td>
              <td className="num py-1.5 pr-3 text-text">{g.net_r !== null ? fmtR(g.net_r) : '-'}</td>
            </tr>
          ))}
          {entries.length === 0 && (
            <tr>
              <td colSpan={5} className="py-3 text-center text-text-muted">
                No trades in this scope.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </Card>
  )
}
