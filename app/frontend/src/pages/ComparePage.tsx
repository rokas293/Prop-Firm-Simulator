import { useMemo, useState } from 'react'
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useEquity, useRun, useStats, type StatsScope } from '../api/hooks'
import { useUiStore } from '../state/uiStore'
import { useThemeStore, COMPARE_B_COLOR } from '../state/themeStore'

const SCOPES: { key: StatsScope; label: string }[] = [
  { key: 'oos', label: 'Out-of-sample' },
  { key: 'is', label: 'In-sample' },
  { key: 'all', label: 'All' },
]

function fmtUsd(v: number | null | undefined): string {
  if (v === null || v === undefined) return '-'
  const sign = v >= 0 ? '' : '-'
  return `${sign}$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined) return '-'
  return `${(v * 100).toFixed(1)}%`
}
function fmtR(v: number | null | undefined): string {
  if (v === null || v === undefined) return '-'
  return `${v.toFixed(2)}R`
}

interface MergedPoint {
  elapsedDays: number
  equityA?: number
  equityB?: number
}

export default function ComparePage() {
  const compareRunIds = useUiStore((s) => s.compareRunIds)
  const setCompareRunIds = useUiStore((s) => s.setCompareRunIds)
  const [scope, setScope] = useState<StatsScope>('oos')
  const colorA = useThemeStore((s) => s.colors.accent)

  const [idA, idB] = compareRunIds ?? [null, null]

  const { data: runA } = useRun(idA)
  const { data: runB } = useRun(idB)
  const { data: statsA } = useStats(idA, scope)
  const { data: statsB } = useStats(idB, scope)
  const { data: equityA } = useEquity(idA, 3000)
  const { data: equityB } = useEquity(idB, 3000)

  // Runs rarely share a date range, so the overlay is normalized to
  // elapsed days since each run's OWN start -- a shape-for-shape
  // comparison (e.g. MES vs MNQ SL-scaling), not a calendar overlay. This
  // is a time-origin subtraction for display, not a financial computation.
  const chartData = useMemo(() => {
    const merged = new Map<number, MergedPoint>()
    const startA = equityA?.[0]?.time
    const startB = equityB?.[0]?.time
    if (startA !== undefined) {
      for (const e of equityA ?? []) {
        const day = +(((e.time - startA) / 86400).toFixed(3))
        merged.set(day, { ...(merged.get(day) ?? { elapsedDays: day }), equityA: e.equity })
      }
    }
    if (startB !== undefined) {
      for (const e of equityB ?? []) {
        const day = +(((e.time - startB) / 86400).toFixed(3))
        merged.set(day, { ...(merged.get(day) ?? { elapsedDays: day }), equityB: e.equity })
      }
    }
    return [...merged.values()].sort((a, b) => a.elapsedDays - b.elapsedDays)
  }, [equityA, equityB])

  if (!compareRunIds) return null

  // `isText` marks the two rows that hold a status word rather than a
  // number (Result/Fail reason) so the table below can right-align/tabular
  // every genuinely numeric row (DESIGN_AUDIT.md item 1) without also
  // right-aligning "passed"/"mll_breach" text -- same per-row-numeric
  // pattern as TradeListPanel's COLUMNS.
  const rows: { label: string; a: string; b: string; isText?: boolean }[] = statsA && statsB
    ? [
        { label: 'Net PnL', a: fmtUsd(statsA.overall.net_pnl_usd), b: fmtUsd(statsB.overall.net_pnl_usd) },
        { label: 'Net R', a: fmtR(statsA.overall.net_r), b: fmtR(statsB.overall.net_r) },
        { label: 'Win rate', a: fmtPct(statsA.overall.win_rate), b: fmtPct(statsB.overall.win_rate) },
        { label: 'Expectancy', a: fmtUsd(statsA.overall.expectancy_usd), b: fmtUsd(statsB.overall.expectancy_usd) },
        {
          label: 'Profit factor',
          a: statsA.overall.profit_factor?.toFixed(2) ?? '-',
          b: statsB.overall.profit_factor?.toFixed(2) ?? '-',
        },
        { label: 'Max drawdown', a: fmtUsd(statsA.overall.max_drawdown_usd), b: fmtUsd(statsB.overall.max_drawdown_usd) },
        { label: 'Trades', a: String(statsA.overall.trades), b: String(statsB.overall.trades) },
        {
          label: 'Trading days',
          a: statsA.result ? String(statsA.result.trading_days) : '-',
          b: statsB.result ? String(statsB.result.trading_days) : '-',
        },
        { label: 'Result', a: statsA.result?.status ?? '-', b: statsB.result?.status ?? '-', isText: true },
        {
          label: 'Fail reason',
          a: statsA.result?.fail_reason ?? '-',
          b: statsB.result?.fail_reason ?? '-',
          isText: true,
        },
      ]
    : []

  return (
    <div className="h-[calc(100vh-49px)] overflow-auto p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Compare runs</h1>
        <button
          onClick={() => setCompareRunIds(null)}
          className="rounded bg-surface-2 px-3 py-1 text-sm text-text hover:bg-surface-2-hover"
        >
          Exit compare
        </button>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-4 text-sm">
        <RunHeader color={colorA} label="A" run={runA} />
        <RunHeader color={COMPARE_B_COLOR} label="B" run={runB} />
      </div>

      <div className="mb-4 flex items-center gap-2">
        <span className="text-xs text-text-muted">Scope:</span>
        {SCOPES.map((s) => (
          <button
            key={s.key}
            onClick={() => setScope(s.key)}
            className={`rounded px-3 py-1 text-sm ${
              scope === s.key ? 'bg-accent text-white' : 'bg-surface-2 text-text hover:bg-surface-2-hover'
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="mb-6 rounded border border-border bg-surface p-4">
        <div className="mb-2 text-sm font-medium text-text">
          Equity vs elapsed trading time (each run re-based to day 0 at its own start)
        </div>
        <ResponsiveContainer width="100%" height={320}>
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-grid)" />
            <XAxis
              dataKey="elapsedDays"
              type="number"
              tick={{ fill: 'var(--color-text-muted)', fontSize: 11 }}
              label={{ value: 'Elapsed days', position: 'insideBottom', offset: -5, fill: 'var(--color-text-muted)', fontSize: 11 }}
            />
            <YAxis tick={{ fill: 'var(--color-text-muted)', fontSize: 11 }} domain={['auto', 'auto']} />
            <Tooltip
              contentStyle={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
              formatter={(v) => fmtUsd(Number(v))}
              labelFormatter={(v) => `day ${v}`}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Line
              type="stepAfter"
              dataKey="equityA"
              name={runA?.instrument ? `A: ${runA.instrument}` : 'A'}
              stroke={colorA}
              dot={false}
              strokeWidth={1.5}
              connectNulls
            />
            <Line
              type="stepAfter"
              dataKey="equityB"
              name={runB?.instrument ? `B: ${runB.instrument}` : 'B'}
              stroke={COMPARE_B_COLOR}
              dot={false}
              strokeWidth={1.5}
              connectNulls
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="rounded border border-border bg-surface p-4">
        <div className="mb-2 text-sm font-medium text-text">Side-by-side stats ({scope})</div>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="micro-label py-1.5 pr-3 text-left"></th>
              <th className="micro-label py-1.5 pr-3 text-right" style={{ color: colorA }}>
                A &middot; {runA?.instrument ?? '...'}
              </th>
              <th className="micro-label py-1.5 pr-3 text-right" style={{ color: COMPARE_B_COLOR }}>
                B &middot; {runB?.instrument ?? '...'}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} className="border-b border-border">
                <td className="py-1.5 pr-3 text-text-muted">{r.label}</td>
                <td className={`py-1.5 pr-3 text-text ${r.isText ? 'text-right' : 'num'}`}>{r.a}</td>
                <td className={`py-1.5 pr-3 text-text ${r.isText ? 'text-right' : 'num'}`}>{r.b}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={3} className="py-3 text-center text-text-muted">
                  Loading stats…
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function RunHeader({ color, label, run }: { color: string; label: string; run: { run_id: string; instrument: string; date_from: string; date_to: string } | undefined }) {
  return (
    <div className="rounded border border-border bg-surface p-3">
      <div className="flex items-center gap-2">
        <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: color }} />
        <span className="font-semibold text-text">Run {label}</span>
      </div>
      {run ? (
        <div className="mt-1 text-xs text-text-muted">
          <div className="font-mono">{run.run_id}</div>
          <div>
            {run.instrument} &middot; {run.date_from} &rarr; {run.date_to}
          </div>
        </div>
      ) : (
        <div className="mt-1 text-xs text-text-muted">Loading…</div>
      )}
    </div>
  )
}
