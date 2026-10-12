// FXR_V2_SPEC.md section 6 (G8): "what if my target had been nR". The simulation is
// the backend's (services/rr_simulator.py: each qualifying trade's real 1m path from
// its entry, the stop it was opened with, a target at n x that risk); this only lays
// the result out as a table and a chart and says how many trades qualified.
import { Bar, CartesianGrid, Cell, ComposedChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useRrSimulator } from '../api/hooks'
import type { RrRow } from '../api/types'
import { AXIS_LINE_STYLE, AXIS_TICK_STYLE, TOOLTIP_CONTENT_STYLE } from '../chart/rechartsTheme'
import Skeleton from '../components/Skeleton'
import { fmtPct, fmtR, fmtUsd, fmtUsdWhole } from '../format'
import { useThemeStore } from '../state/themeStore'

const EXCLUSION_TEXT: Record<string, string> = {
  no_stop_at_entry: 'had no stop-loss at entry',
  still_open: 'are still partly open',
  stop_on_wrong_side: 'had a stop on the wrong side of the entry',
  no_price_data: 'have no price data',
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

function profitFactor(row: RrRow): string {
  if (row.profit_factor !== null) return row.profit_factor.toFixed(2)
  return row.net_pnl_usd > 0 ? '∞' : '-'
}

const signClass = (v: number) => (v > 0 ? 'text-positive-fg' : v < 0 ? 'text-negative-fg' : 'text-text')

export function exclusionSummary(excluded: Record<string, number>): string {
  const parts = Object.entries(excluded)
    .filter(([, n]) => n > 0)
    .map(([reason, n]) => `${n} ${EXCLUSION_TEXT[reason] ?? reason}`)
  return parts.join('; ')
}

export default function RrSimulatorCard({ runId, instrument }: { runId: string; instrument: string | null }) {
  const { data, isLoading, isError } = useRrSimulator(runId, instrument)
  const colors = useThemeStore((s) => s.colors)

  if (isLoading) return <Skeleton className="h-[320px]" />
  if (isError || !data) return <p className="text-xs text-text-muted">The simulator could not be loaded for this scope.</p>

  const excluded = exclusionSummary(data.excluded)
  const header = (
    <p className="text-xs text-text-muted" data-testid="rr-qualified">
      {data.qualified} of {plural(data.total_trades, 'trade')} qualified
      {excluded ? `; left out: ${excluded}.` : '.'} Only a stop-loss set at entry counts; one added or moved later is ignored.
    </p>
  )

  if (!data.enough) {
    return (
      <div className="flex flex-col gap-2">
        {header}
        <p className="text-xs text-text" role="status">
          The simulator needs at least {data.min_trades} trades with a stop-loss at entry. {data.qualified === 0 ? 'None qualify yet.' : `${plural(data.qualified, 'trade')} qualify so far.`}
        </p>
      </div>
    )
  }

  const chartRows = data.rows.map((r) => ({ label: `${r.n}R`, n: r.n, pnl: r.net_pnl_usd, winRate: r.win_rate === null ? null : r.win_rate * 100 }))

  return (
    <div className="flex flex-col gap-4">
      {header}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-xs tabular-nums" aria-label="RR simulator results">
          <thead>
            <tr className="h-7 text-right">
              <th className="micro-label pr-4 text-left font-medium">Target</th>
              <th className="micro-label px-2 font-medium">Win rate</th>
              <th className="micro-label px-2 font-medium">Net P&amp;L</th>
              <th className="micro-label px-2 font-medium">Profit factor</th>
              <th className="micro-label px-2 font-medium">Avg drawdown</th>
              <th className="micro-label pl-2 font-medium">Avg drawdown (R)</th>
            </tr>
          </thead>
          <tbody>
            {data.actual && <RrTableRow label="As taken" row={data.actual} muted />}
            {data.rows.map((r) => (
              <RrTableRow key={r.n} label={`${r.n}R`} row={r} />
            ))}
          </tbody>
        </table>
      </div>

      <div>
        <div className="micro-label mb-2">Net P&amp;L by target (win rate is in the table)</div>
        <ResponsiveContainer width="100%" height={220}>
          <ComposedChart data={chartRows} margin={{ left: 8, right: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-grid)" />
            <XAxis dataKey="label" tick={AXIS_TICK_STYLE} axisLine={AXIS_LINE_STYLE} tickLine={AXIS_LINE_STYLE} />
            <YAxis yAxisId="pnl" tick={AXIS_TICK_STYLE} axisLine={AXIS_LINE_STYLE} tickLine={AXIS_LINE_STYLE} tickFormatter={(v) => fmtUsdWhole(Number(v))} />
            <Tooltip
              contentStyle={TOOLTIP_CONTENT_STYLE}
              formatter={(v) => [fmtUsd(Number(v)), 'Net P&L']}
            />
            <ReferenceLine yAxisId="pnl" y={0} stroke="var(--color-border)" />
            <Bar yAxisId="pnl" dataKey="pnl" name="Net P&L" isAnimationActive={false} maxBarSize={36}>
              {chartRows.map((r) => (
                <Cell key={r.n} fill={r.pnl >= 0 ? colors.positive : colors.negative} fillOpacity={0.75} />
              ))}
            </Bar>
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

function RrTableRow({ label, row, muted = false }: { label: string; row: RrRow; muted?: boolean }) {
  return (
    <tr className={`h-7 text-right transition-colors hover:bg-surface-2 ${muted ? 'text-text-muted' : 'text-text'}`}>
      <td className="pr-4 text-left">{label}</td>
      <td className="px-2">{fmtPct(row.win_rate)}</td>
      <td className={`px-2 ${muted ? '' : signClass(row.net_pnl_usd)}`}>{fmtUsd(row.net_pnl_usd)}</td>
      <td className="px-2">{profitFactor(row)}</td>
      <td className="px-2">{fmtUsd(row.avg_drawdown_usd)}</td>
      <td className="pl-2">{fmtR(row.avg_drawdown_r)}</td>
    </tr>
  )
}
