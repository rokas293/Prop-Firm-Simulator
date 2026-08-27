import { fmtPct, fmtR, fmtUsd } from '../format'
import type { GroupStats } from '../api/types'

// Shared per-group stats table with click-to-filter rows -- extracted from
// DashboardPanel (POLISH_ROADMAP Phase P5) so CompassPanel's leg/session
// breakdowns reuse the exact same server-computed GroupStats display and
// cross-filter behavior instead of re-deriving them from raw trades.
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
    <div className="rounded border border-neutral-800 bg-neutral-900 p-4">
      <div className="mb-2 text-sm font-medium text-neutral-300">{title}</div>
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-b border-neutral-800 text-left text-neutral-500">
            <th className="py-1.5 pr-3 font-medium"></th>
            <th className="py-1.5 pr-3 font-medium">Trades</th>
            <th className="py-1.5 pr-3 font-medium">Win rate</th>
            <th className="py-1.5 pr-3 font-medium">Expectancy</th>
            <th className="py-1.5 pr-3 font-medium">Total R</th>
          </tr>
        </thead>
        <tbody>
          {entries.map(([key, g]) => (
            <tr
              key={key}
              onClick={() => onRowClick(key)}
              className="cursor-pointer border-b border-neutral-900 hover:bg-neutral-800"
              title={`Filter trade list + chart to ${key}`}
            >
              <td className="py-1.5 pr-3 text-neutral-200">{key}</td>
              <td className="py-1.5 pr-3 text-neutral-300">{g.trades}</td>
              <td className="py-1.5 pr-3 text-neutral-300">{fmtPct(g.win_rate)}</td>
              <td className={`py-1.5 pr-3 ${(g.expectancy_usd ?? 0) >= 0 ? 'text-accent-green' : 'text-accent-red'}`}>
                {fmtUsd(g.expectancy_usd)}
              </td>
              <td className="py-1.5 pr-3 text-neutral-300">{g.net_r !== null ? fmtR(g.net_r) : '-'}</td>
            </tr>
          ))}
          {entries.length === 0 && (
            <tr>
              <td colSpan={5} className="py-3 text-center text-neutral-500">
                No trades in this scope.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
