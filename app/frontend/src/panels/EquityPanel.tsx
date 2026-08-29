import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useEquity, useRun } from '../api/hooks'
import { useUiStore } from '../state/uiStore'
import { useThemeStore } from '../state/themeStore'
import EmptyState from '../components/EmptyState'

function fmtUsd(v: number | null | undefined): string {
  if (v === null || v === undefined) return '-'
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

// A standalone dockable panel: the full-run equity curve at a glance
// (Recharts, quick overview). For the interactive, marker-annotated,
// day-navigable version see the Prop Risk panel (RiskChart, Lightweight
// Charts) -- this one is deliberately the lightweight companion.
export default function EquityPanel() {
  const runId = useUiStore((s) => s.selectedRunId)
  const { data: run } = useRun(runId)
  const { data: equity } = useEquity(runId)
  const colors = useThemeStore((s) => s.colors)

  if (!runId) {
    return <EmptyState title="No run selected" hint="Pick a run from the Runs list, or press Ctrl/Cmd+K to open one." />
  }

  return (
    <div className="flex h-full w-full flex-col gap-4 overflow-auto p-4">
      <div className="text-xs text-text-muted">
        {run ? `${run.instrument} · ${run.date_from} → ${run.date_to}` : 'Loading…'}
      </div>

      <div className="rounded border border-border bg-surface p-4">
        <div className="mb-2 text-sm font-medium text-text">Equity & trailing MLL (full run)</div>
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={equity ?? []}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-grid)" />
            <XAxis
              dataKey="time"
              tick={{ fill: 'var(--color-text-muted)', fontSize: 11 }}
              tickFormatter={(t) => new Date(t * 1000).toISOString().slice(0, 10)}
            />
            <YAxis tick={{ fill: 'var(--color-text-muted)', fontSize: 11 }} domain={['auto', 'auto']} />
            <Tooltip
              contentStyle={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
              labelFormatter={(t) => new Date((t as number) * 1000).toISOString()}
              formatter={(v) => fmtUsd(Number(v))}
            />
            <Line type="stepAfter" dataKey="equity" stroke={colors.accent} dot={false} strokeWidth={1.5} />
            <Line type="stepAfter" dataKey="mll_floor" stroke={colors.negative} dot={false} strokeWidth={1} strokeDasharray="4 3" />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="rounded border border-border bg-surface p-4">
        <div className="mb-2 text-sm font-medium text-text">Drawdown from peak equity (full run)</div>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={equity ?? []}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-grid)" />
            <XAxis
              dataKey="time"
              tick={{ fill: 'var(--color-text-muted)', fontSize: 11 }}
              tickFormatter={(t) => new Date(t * 1000).toISOString().slice(0, 10)}
            />
            <YAxis tick={{ fill: 'var(--color-text-muted)', fontSize: 11 }} reversed />
            <Tooltip
              contentStyle={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
              labelFormatter={(t) => new Date((t as number) * 1000).toISOString()}
              formatter={(v) => fmtUsd(Number(v))}
            />
            <Line type="stepAfter" dataKey="drawdown_usd" stroke={colors.negative} dot={false} strokeWidth={1.5} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
