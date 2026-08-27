import { useMemo, useState } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from 'recharts'
import type { IDockviewPanelProps } from 'dockview-react'
import { useRun, useStats, useTrades, type StatsScope } from '../api/hooks'
import { useUiStore } from '../state/uiStore'
import { scopeTradeParams, useTradeStore } from '../state/tradeStore'
import { CHART_PANEL_ID } from '../workspace/panelIds'
import { isClippedStop } from '../compass/regime'
import KpiTile from '../components/KpiTile'
import ChartCard from '../components/ChartCard'
import BreakdownTable from '../components/BreakdownTable'
import EmptyState from '../components/EmptyState'
import { KpiRowSkeleton } from '../components/Skeleton'
import { useThemeStore } from '../state/themeStore'
import { fmtPct, fmtR, fmtUsd } from '../format'
import type { TradeRecord } from '../api/types'

const SCOPES: { key: StatsScope; label: string }[] = [
  { key: 'oos', label: 'Out-of-sample' },
  { key: 'is', label: 'In-sample' },
  { key: 'all', label: 'All' },
]

const R_BUCKET_WIDTH = 0.5

function buildRHistogram(trades: TradeRecord[]): { r: number; count: number }[] {
  const rValues = trades.map((t) => t.r_multiple).filter((r): r is number => r !== null)
  if (rValues.length === 0) return []
  const min = Math.floor(Math.min(...rValues) / R_BUCKET_WIDTH) * R_BUCKET_WIDTH
  const max = Math.ceil(Math.max(...rValues) / R_BUCKET_WIDTH) * R_BUCKET_WIDTH
  const buckets = new Map<number, number>()
  for (let b = min; b <= max; b = +(b + R_BUCKET_WIDTH).toFixed(2)) buckets.set(b, 0)
  for (const r of rValues) {
    const b = +(Math.floor(r / R_BUCKET_WIDTH) * R_BUCKET_WIDTH).toFixed(2)
    buckets.set(b, (buckets.get(b) ?? 0) + 1)
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([r, count]) => ({ r, count }))
}

// A standalone dockable panel: run-level KPIs, breakdowns, and
// distributions. The equity/drawdown curves live in their own Equity
// panel -- see EquityPanel.tsx.
export default function DashboardPanel({ containerApi }: IDockviewPanelProps) {
  const runId = useUiStore((s) => s.selectedRunId)
  const setFilter = useTradeStore((s) => s.setFilter)
  const clearFilters = useTradeStore((s) => s.clearFilters)

  const [scope, setScope] = useState<StatsScope>('oos')
  const colors = useThemeStore((s) => s.colors)

  const { data: run } = useRun(runId)
  const { data: stats } = useStats(runId, scope)

  const tradeParams = useMemo(() => scopeTradeParams(scope, run?.is_oos_split_date ?? null), [scope, run])
  const { data: scopedTrades } = useTrades(runId, tradeParams)

  const histogram = useMemo(() => buildRHistogram(scopedTrades ?? []), [scopedTrades])

  // "Would've won but got stopped": exited at SL yet still traveled at
  // least the planned TP distance in favorable excursion at some point.
  // One pass building all three buckets together (POLISH_ROADMAP Phase P4:
  // "memoize derived selectors") -- previously each bucket re-filtered the
  // full scatter set on every render, including renders triggered by
  // completely unrelated state (e.g. a sibling panel's own re-render).
  const { wins, losses, clippedStops } = useMemo(() => {
    const wins: (TradeRecord & { win: boolean; clipped: boolean })[] = []
    const losses: (TradeRecord & { win: boolean; clipped: boolean })[] = []
    const clippedStops: (TradeRecord & { win: boolean; clipped: boolean })[] = []
    for (const t of scopedTrades ?? []) {
      const win = t.pnl_usd > 0
      const clipped = isClippedStop(t)
      const row = { ...t, win, clipped }
      if (clipped) clippedStops.push(row)
      else if (win) wins.push(row)
      else losses.push(row)
    }
    return { wins, losses, clippedStops }
  }, [scopedTrades])

  const crossFilter = (key: 'leg' | 'session', value: string) => {
    clearFilters()
    setFilter(key, value)
    containerApi.getPanel(CHART_PANEL_ID)?.api.setActive()
  }

  if (!runId) {
    return <EmptyState title="No run selected" hint="Pick a run from the Runs list, or press Ctrl/Cmd+K to open one." />
  }
  if (!stats) {
    return (
      <div className="h-full overflow-auto p-4">
        <KpiRowSkeleton />
      </div>
    )
  }

  const { overall, by_leg, by_session, result } = stats

  return (
    <div className="h-full overflow-auto p-4">
      <div className="mb-4 flex items-center gap-2">
        <span className="text-xs text-neutral-500">Scope:</span>
        {SCOPES.map((s) => (
          <button
            key={s.key}
            onClick={() => setScope(s.key)}
            className={`rounded px-3 py-1 text-sm ${
              scope === s.key ? 'bg-accent-blue text-white' : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700'
            }`}
          >
            {s.label}
            {s.key === 'oos' && <span className="ml-1 text-[10px] opacity-70">(headline)</span>}
          </button>
        ))}
        {!run?.is_oos_split_date && (
          <span className="text-xs text-neutral-600">this run has no IS/OOS split date -- scope has no effect</span>
        )}
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
        <KpiTile label="Net PnL" value={fmtUsd(overall.net_pnl_usd)} accent={overall.net_pnl_usd >= 0} />
        <KpiTile label="Net R" value={overall.net_r !== null ? fmtR(overall.net_r) : '-'} accent={(overall.net_r ?? 0) >= 0} />
        <KpiTile label="Win rate" value={fmtPct(overall.win_rate)} />
        <KpiTile
          label="Expectancy"
          value={fmtUsd(overall.expectancy_usd)}
          accent={(overall.expectancy_usd ?? 0) >= 0}
        />
        <KpiTile
          label="Profit factor"
          value={overall.profit_factor !== null ? overall.profit_factor.toFixed(2) : '-'}
        />
        <KpiTile label="Max drawdown" value={fmtUsd(overall.max_drawdown_usd)} accent={false} />
        <KpiTile label="Trades" value={String(overall.trades)} />
        <KpiTile label="Trading days" value={result ? String(result.trading_days) : '-'} />
      </div>

      {result && (
        <div className="mb-6 rounded border border-neutral-800 bg-neutral-900 px-4 py-3 text-sm">
          <span
            className={`font-semibold ${
              result.status === 'passed'
                ? 'text-accent-green'
                : result.status === 'failed'
                  ? 'text-accent-red'
                  : 'text-neutral-300'
            }`}
          >
            {result.status.toUpperCase()}
          </span>
          {result.fail_reason && <span className="ml-2 text-neutral-400">({result.fail_reason})</span>}
          <span className="ml-4 text-neutral-400">target hit: {result.target_hit ? 'yes' : 'no'}</span>
          <span className="ml-4 text-neutral-400">
            consistency: {result.consistency_passed === null ? 'n/a' : result.consistency_passed ? 'passed' : 'failed'}
          </span>
          <span className="ml-4 text-neutral-400">final balance: {fmtUsd(result.final_balance)}</span>
        </div>
      )}

      <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <BreakdownTable title="By leg" rows={by_leg} onRowClick={(k) => crossFilter('leg', k)} />
        <BreakdownTable title="By session" rows={by_session} onRowClick={(k) => crossFilter('session', k)} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard title="R-multiple distribution">
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={histogram}>
              <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
              <XAxis dataKey="r" tick={{ fill: '#8b949e', fontSize: 11 }} tickFormatter={(v) => `${v}R`} />
              <YAxis tick={{ fill: '#8b949e', fontSize: 11 }} allowDecimals={false} />
              <Tooltip
                contentStyle={{ background: '#161b22', border: '1px solid #30363d' }}
                labelFormatter={(v) => `${v}R bucket`}
              />
              <ReferenceLine x={0} stroke="#30363d" />
              <Bar dataKey="count">
                {histogram.map((h, i) => (
                  <Cell key={i} fill={h.r >= 0 ? colors.up : colors.down} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="MAE vs MFE (stop-tightness view)">
          <div className="mb-2 text-xs text-neutral-500">
            {clippedStops.length} trade{clippedStops.length === 1 ? '' : 's'} exited at SL after reaching at least
            the planned TP distance in favorable excursion (amber) -- the stop likely clipped a winner.
          </div>
          <ResponsiveContainer width="100%" height={260}>
            <ScatterChart>
              <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
              <XAxis
                type="number"
                dataKey="mae_points"
                name="MAE"
                tick={{ fill: '#8b949e', fontSize: 11 }}
                label={{ value: 'MAE (pts)', position: 'insideBottom', offset: -5, fill: '#8b949e', fontSize: 11 }}
              />
              <YAxis
                type="number"
                dataKey="mfe_points"
                name="MFE"
                tick={{ fill: '#8b949e', fontSize: 11 }}
                label={{ value: 'MFE (pts)', angle: -90, position: 'insideLeft', fill: '#8b949e', fontSize: 11 }}
              />
              <ZAxis range={[24, 24]} />
              <Tooltip
                cursor={{ strokeDasharray: '3 3' }}
                contentStyle={{ background: '#161b22', border: '1px solid #30363d' }}
                formatter={(v, name) => [Number(v).toFixed(2), String(name)]}
              />
              <Scatter data={wins} fill={colors.up} fillOpacity={0.6} />
              <Scatter data={losses} fill={colors.down} fillOpacity={0.6} />
              <Scatter data={clippedStops} fill="#d29922" fillOpacity={0.9} />
            </ScatterChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
    </div>
  )
}
