import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useEquity, useRun } from '../api/hooks'
import { useUiStore } from '../state/uiStore'
import { useThemeStore } from '../state/themeStore'
import EmptyState from '../components/EmptyState'
import Skeleton from '../components/Skeleton'
import Card from '../components/Card'
import { fmtUsd, fmtUsdWhole } from '../format'
import { AXIS_TICK_STYLE, AXIS_LINE_STYLE, TOOLTIP_CONTENT_STYLE } from '../chart/rechartsTheme'

// A standalone dockable panel: the full-run equity curve at a glance
// (Recharts, quick overview). For the interactive, marker-annotated,
// day-navigable version see the Prop Risk panel (RiskChart, Lightweight
// Charts) -- this one is deliberately the lightweight companion.
export default function EquityPanel() {
  const runId = useUiStore((s) => s.selectedRunId)
  const { data: run } = useRun(runId)
  const { data: equity } = useEquity(runId)
  const colors = useThemeStore((s) => s.colors)
  // A manual session without a prop ruleset has no MLL floor to plot (null
  // on every row) -- an all-null Line would just be an empty legend entry.
  const hasMllFloor = (equity ?? []).some((p) => p.mll_floor !== null)

  if (!runId) {
    return <EmptyState title="No run selected" hint="Pick a run from the Runs list, or press Ctrl/Cmd+K to open one." />
  }

  // POLISH_ROADMAP Phase P6: a consistent skeleton instead of two blank
  // charts flashing empty (`equity ?? []`) while the fetch is in flight --
  // rare in practice since Part P4's prefetch-on-hover usually already has
  // this warm by the time the panel mounts, but a real gap on a genuinely
  // cold load (e.g. jumping straight to a run via the command palette).
  if (equity === undefined) {
    return (
      <div className="flex h-full w-full flex-col gap-4 overflow-auto p-4">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-[260px]" />
        <Skeleton className="h-[220px]" />
      </div>
    )
  }

  return (
    <div className="flex h-full w-full flex-col gap-4 overflow-auto p-4">
      <div className="text-xs text-text-muted">
        {run ? `${run.instrument} · ${run.date_from} → ${run.date_to}` : 'Loading…'}
      </div>

      <Card
        title={
          hasMllFloor
            ? 'Equity & trailing MLL (full run)'
            : (run?.session_ids?.length ?? 0) > 1
              ? 'Cumulative net P&L (pooled sessions)'
              : 'Equity (full run)'
        }
      >
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={equity ?? []}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-grid)" />
            <XAxis
              dataKey="time"
              tick={AXIS_TICK_STYLE}
              axisLine={AXIS_LINE_STYLE}
              tickLine={AXIS_LINE_STYLE}
              tickFormatter={(t) => new Date(t * 1000).toISOString().slice(0, 10)}
            />
            <YAxis tick={AXIS_TICK_STYLE} axisLine={AXIS_LINE_STYLE} tickLine={AXIS_LINE_STYLE} domain={['auto', 'auto']} tickFormatter={(v) => fmtUsdWhole(Number(v))} />
            <Tooltip
              contentStyle={TOOLTIP_CONTENT_STYLE}
              labelFormatter={(t) => new Date((t as number) * 1000).toISOString()}
              formatter={(v) => fmtUsd(Number(v))}
            />
            <Line type="stepAfter" dataKey="equity" stroke={colors.accent} dot={false} strokeWidth={1.5} />
            {hasMllFloor && (
              <Line type="stepAfter" dataKey="mll_floor" stroke={colors.negative} dot={false} strokeWidth={1} strokeDasharray="4 3" />
            )}
          </LineChart>
        </ResponsiveContainer>
      </Card>

      <Card title="Drawdown from peak equity (full run)">
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={equity ?? []}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-grid)" />
            <XAxis
              dataKey="time"
              tick={AXIS_TICK_STYLE}
              axisLine={AXIS_LINE_STYLE}
              tickLine={AXIS_LINE_STYLE}
              tickFormatter={(t) => new Date(t * 1000).toISOString().slice(0, 10)}
            />
            <YAxis tick={AXIS_TICK_STYLE} axisLine={AXIS_LINE_STYLE} tickLine={AXIS_LINE_STYLE} reversed />
            <Tooltip
              contentStyle={TOOLTIP_CONTENT_STYLE}
              labelFormatter={(t) => new Date((t as number) * 1000).toISOString()}
              formatter={(v) => fmtUsd(Number(v))}
            />
            <Line type="stepAfter" dataKey="drawdown_usd" stroke={colors.negative} dot={false} strokeWidth={1.5} />
          </LineChart>
        </ResponsiveContainer>
      </Card>
    </div>
  )
}
