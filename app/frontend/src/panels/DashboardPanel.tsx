import { useEffect, useMemo, useState } from 'react'
import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from 'recharts'
import type { IDockviewPanelProps } from 'dockview-react'
import { useAiStatus, useRun, useStats, useSummarizeRun, useTrades, type StatsScope } from '../api/hooks'
import { useUiStore } from '../state/uiStore'
import { scopeTradeParams, useTradeStore, type TradeFilters } from '../state/tradeStore'
import { CHART_PANEL_ID, PROP_RISK_PANEL_ID } from '../workspace/panelIds'
import { byHoldTime, byHourOfDay, byWeekday, summarizeStreaks, type BucketStats, type StreakSummary } from '../compass/breakdowns'
import { computeMaeMfeRegime, isClippedStop } from '../compass/regime'
import { computeCompassScore, type CompassScore } from '../compass/score'
import KpiTile from '../components/KpiTile'
import Card from '../components/Card'
import BreakdownTable from '../components/BreakdownTable'
import EmptyState from '../components/EmptyState'
import EquitySparkline from '../components/EquitySparkline'
import { KpiRowSkeleton } from '../components/Skeleton'
import { useThemeStore } from '../state/themeStore'
import { fmtPct, fmtR, fmtUsd } from '../format'
import type { TradeRecord } from '../api/types'

const SCOPES: { key: StatsScope; label: string }[] = [
  { key: 'oos', label: 'Out-of-sample' },
  { key: 'is', label: 'In-sample' },
  { key: 'all', label: 'All' },
]

// CLAUDE.md section 3: the Topstep $50k Combine's default trailing-drawdown
// budget. The bundle doesn't expose a run's actually-configured MLL size
// (prop rules are configurable per CLAUDE.md section 3), so the hero row
// frames drawdown against this documented default -- accurate for the
// common case, and the label says "of $2k MLL" rather than implying it's
// read from the run itself.
const DEFAULT_MLL_USD = 2000

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

// Bucket bars are colored by net PnL sign (win-green/loss-red) -- a single
// series needs no legend box (dataviz skill: "the chart's title already
// says what is plotted"). winColor/lossColor come from the theme, passed
// down rather than each chart reading the store itself.
function BucketBarChart({
  data,
  onSelect,
  valueLabel,
  winColor,
  lossColor,
}: {
  data: BucketStats[]
  onSelect: (key: string) => void
  valueLabel: string
  winColor: string
  lossColor: string
}) {
  return (
    <ResponsiveContainer width="100%" height={180}>
      <BarChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-grid)" />
        <XAxis dataKey="key" tick={{ fill: 'var(--color-text-muted)', fontSize: 11 }} />
        <YAxis tick={{ fill: 'var(--color-text-muted)', fontSize: 11 }} />
        <Tooltip
          contentStyle={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
          formatter={(v) => [fmtUsd(Number(v)), valueLabel]}
          labelFormatter={(k) => `${k}`}
        />
        <Bar dataKey="netPnlUsd" cursor="pointer" onClick={(d) => onSelect((d.payload as BucketStats).key)}>
          {data.map((b, i) => (
            <Cell key={i} fill={b.netPnlUsd >= 0 ? winColor : lossColor} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

function StreakChart({
  streaks,
  onSelect,
  winColor,
  lossColor,
}: {
  streaks: StreakSummary
  onSelect: (type: 'win' | 'loss', length: number) => void
  winColor: string
  lossColor: string
}) {
  return (
    <ResponsiveContainer width="100%" height={180}>
      <BarChart data={streaks.distribution}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-grid)" />
        <XAxis
          dataKey="length"
          tick={{ fill: 'var(--color-text-muted)', fontSize: 11 }}
          label={{ value: 'Streak length', position: 'insideBottom', offset: -5, fill: 'var(--color-text-muted)', fontSize: 11 }}
        />
        <YAxis tick={{ fill: 'var(--color-text-muted)', fontSize: 11 }} allowDecimals={false} />
        <Tooltip contentStyle={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }} />
        <Bar
          dataKey="winCount"
          name="Win streaks"
          fill={winColor}
          cursor="pointer"
          onClick={(d) => onSelect('win', (d.payload as { length: number }).length)}
        />
        <Bar
          dataKey="lossCount"
          name="Loss streaks"
          fill={lossColor}
          cursor="pointer"
          onClick={(d) => onSelect('loss', (d.payload as { length: number }).length)}
        />
      </BarChart>
    </ResponsiveContainer>
  )
}

// No per-component border/background box -- spacing (the grid gap) and
// typography do the separating instead of nested borders (REDESIGN_APPROACH.md
// Phase B2: "kill nested borders").
function ScoreCard({ score }: { score: CompassScore }) {
  return (
    <Card title="Compass score">
      <p className="mb-3 text-xs text-text-muted">
        Formula: the plain average of four 0-100 components below (each equally weighted, 25%). This is a
        descriptive summary, not a prop-rule outcome -- it doesn't affect pass/fail.
      </p>
      <div className="mb-4 flex items-baseline gap-3">
        <span className="text-4xl font-bold text-text">{score.total}</span>
        <span className="text-sm text-text-muted">/ 100</span>
      </div>
      <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
        {score.components.map((c) => (
          <div key={c.key}>
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-text">{c.label}</span>
              <span
                className={`text-sm font-semibold ${
                  c.score >= 67 ? 'text-positive' : c.score >= 34 ? 'text-warning' : 'text-negative'
                }`}
              >
                {c.score}
              </span>
            </div>
            <div className="mt-1 text-[11px] text-text-muted">{c.detail}</div>
          </div>
        ))}
      </div>
    </Card>
  )
}

// Short human-readable label for whichever single dimension crossFilter()
// last set -- crossFilter always clears everything else first, so at most
// one of these is ever non-null in practice.
function describeFilters(filters: TradeFilters): string {
  if (filters.leg !== null) return `leg = ${filters.leg}`
  if (filters.session !== null) return `session = ${filters.session}`
  if (filters.side !== null) return `side = ${filters.side}`
  if (filters.result !== null) return `result = ${filters.result}`
  if (filters.exitType !== null) return `exit type = ${filters.exitType}`
  if (filters.dateFrom !== null || filters.dateTo !== null) return `date range`
  if (filters.entryHourNy !== null) return `hour = ${String(filters.entryHourNy).padStart(2, '0')}:00 NY`
  if (filters.weekday !== null) return `weekday = ${filters.weekday}`
  if (filters.holdTimeBucket !== null) return `hold time = ${filters.holdTimeBucket}`
  if (filters.streakSelector !== null) return `${filters.streakSelector.type} streak of ${filters.streakSelector.length}`
  return ''
}

type TabKey = 'overview' | 'breakdowns' | 'distributions' | 'score'
const TABS: { key: TabKey; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'breakdowns', label: 'Breakdowns' },
  { key: 'distributions', label: 'Distributions' },
  { key: 'score', label: 'Score & AI' },
]

// The merged Dashboard panel (REDESIGN_APPROACH.md Phase B2): one scope, one
// stats/trades fetch, one copy of the leg/session tables -- previously split
// across two separate dockable panels (Dashboard + Compass) that each kept
// their own independent scope toggle and duplicated the leg/session tables
// verbatim. A 5-item hero row stays always visible; everything else lives
// in tabs, only the active one rendered (dataviz skill: KPI row of stat
// tiles for headline numbers, one primary visual by default).
export default function DashboardPanel({ containerApi }: IDockviewPanelProps) {
  const runId = useUiStore((s) => s.selectedRunId)
  const filters = useTradeStore((s) => s.filters)
  const setFilter = useTradeStore((s) => s.setFilter)
  const clearFilters = useTradeStore((s) => s.clearFilters)

  const [scope, setScope] = useState<StatsScope>('oos')
  const [activeTab, setActiveTab] = useState<TabKey>('overview')
  const colors = useThemeStore((s) => s.colors)

  const { data: run } = useRun(runId)
  const { data: stats } = useStats(runId, scope)
  const tradeParams = useMemo(() => scopeTradeParams(scope, run?.is_oos_split_date ?? null), [scope, run])
  const { data: scopedTrades } = useTrades(runId, tradeParams)
  const trades = useMemo(() => scopedTrades ?? [], [scopedTrades])

  const histogram = useMemo(() => buildRHistogram(trades), [trades])
  const hourBuckets = useMemo(() => byHourOfDay(trades), [trades])
  const weekdayBuckets = useMemo(() => byWeekday(trades), [trades])
  const holdTimeBuckets = useMemo(() => byHoldTime(trades), [trades])
  const streaks = useMemo(() => summarizeStreaks(trades), [trades])
  const regime = useMemo(() => computeMaeMfeRegime(trades), [trades])
  const score = useMemo(() => (stats ? computeCompassScore(stats.overall, trades) : null), [stats, trades])

  // "Would've won but got stopped": exited at SL yet still traveled at
  // least the planned TP distance in favorable excursion at some point. One
  // pass building all three buckets together rather than three separate
  // re-filters of the same set.
  const { wins, losses, clippedStops } = useMemo(() => {
    const wins: (TradeRecord & { win: boolean; clipped: boolean })[] = []
    const losses: (TradeRecord & { win: boolean; clipped: boolean })[] = []
    const clippedStops: (TradeRecord & { win: boolean; clipped: boolean })[] = []
    for (const t of trades) {
      const win = t.pnl_usd > 0
      const clipped = isClippedStop(t)
      const row = { ...t, win, clipped }
      if (clipped) clippedStops.push(row)
      else if (win) wins.push(row)
      else losses.push(row)
    }
    return { wins, losses, clippedStops }
  }, [trades])

  const aiStatusQuery = useAiStatus()
  const summarizeMutation = useSummarizeRun()
  // A stale summary from a previous scope would otherwise keep showing
  // after switching scopes -- clear it so the panel never displays text
  // that doesn't match the currently-selected scope.
  useEffect(() => {
    summarizeMutation.reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, runId])

  const revealChart = () => containerApi.getPanel(CHART_PANEL_ID)?.api.setActive()
  const revealPropRisk = () => containerApi.getPanel(PROP_RISK_PANEL_ID)?.api.setActive()

  function crossFilter<K extends keyof TradeFilters>(key: K, value: TradeFilters[K]) {
    clearFilters()
    setFilter(key, value)
    revealChart()
  }

  const hasActiveFilter = Object.values(filters).some((v) => v !== null)
  const activeFilterDescription = describeFilters(filters)

  if (!runId) {
    return <EmptyState title="No run selected" hint="Pick a run from the Runs list, or press Ctrl/Cmd+K to open one." />
  }
  if (!stats || !score) {
    return (
      <div className="h-full overflow-auto p-4">
        <KpiRowSkeleton />
      </div>
    )
  }

  const { overall, by_leg, by_session, result } = stats
  const resultAccent = !result ? undefined : result.status === 'passed' ? true : result.status === 'failed' ? false : undefined
  const drawdownPctOfMll = Math.round((Math.abs(overall.max_drawdown_usd) / DEFAULT_MLL_USD) * 100)

  return (
    <div className="h-full overflow-auto p-4">
      <div className="mb-4 flex flex-wrap items-center gap-2">
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
            {s.key === 'oos' && <span className="ml-1 text-[10px] opacity-70">(headline)</span>}
          </button>
        ))}
        {!run?.is_oos_split_date && (
          <span className="text-xs text-text-muted">this run has no IS/OOS split date -- scope has no effect</span>
        )}
        {hasActiveFilter && (
          <span className="flex items-center gap-1.5 rounded bg-accent/15 px-2 py-1 text-xs text-accent">
            Trade List + Chart filtered by {activeFilterDescription}
            <button onClick={clearFilters} className="text-accent hover:text-text">
              &times;
            </button>
          </span>
        )}
      </div>

      {/* Hero row: the 5 numbers this dashboard leads with. Everything else
          is one click away in a tab below (REDESIGN_APPROACH.md Phase B2). */}
      <div className="mb-2 grid grid-cols-2 gap-3 sm:grid-cols-5">
        <KpiTile label="Result" value={result ? result.status.toUpperCase() : '-'} sub={result?.fail_reason ?? undefined} accent={resultAccent} />
        <KpiTile
          label="Net P&L"
          value={fmtUsd(overall.net_pnl_usd)}
          sub={overall.net_r !== null ? fmtR(overall.net_r) : undefined}
          accent={overall.net_pnl_usd >= 0}
        />
        <KpiTile
          label="Max drawdown"
          value={fmtUsd(overall.max_drawdown_usd)}
          sub={`${drawdownPctOfMll}% of $2k MLL`}
          accent={false}
        />
        <KpiTile label="Expectancy" value={overall.expectancy_r !== null ? fmtR(overall.expectancy_r) : '-'} accent={(overall.expectancy_r ?? 0) >= 0} />
        <KpiTile
          label="Profit factor"
          value={overall.profit_factor !== null ? overall.profit_factor.toFixed(2) : '-'}
          accent={overall.profit_factor !== null ? overall.profit_factor >= 1 : undefined}
        />
      </div>
      <div className="mb-4 text-xs text-text-muted">
        {overall.trades} trades · {result ? result.trading_days : '-'} trading days
      </div>

      <div className="mb-4 flex gap-1 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setActiveTab(t.key)}
            className={`rounded-t px-3 py-1.5 text-sm ${
              activeTab === t.key
                ? 'border-b-2 border-accent text-text'
                : 'text-text-muted hover:text-text'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === 'overview' && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <KpiTile label="Win rate" value={fmtPct(overall.win_rate)} />
            {run?.result.days_to_fail != null && <KpiTile label="Days to fail" value={String(run.result.days_to_fail)} accent={false} />}
          </div>
          {result && (
            <div className="text-xs text-text-muted">
              target hit: {result.target_hit ? 'yes' : 'no'} · consistency:{' '}
              {result.consistency_passed === null ? 'n/a' : result.consistency_passed ? 'passed' : 'failed'} · final balance:{' '}
              {fmtUsd(result.final_balance)}
            </div>
          )}
          <Card>
            <EquitySparkline runId={runId} onViewFull={revealPropRisk} />
          </Card>
        </div>
      )}

      {activeTab === 'breakdowns' && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <BreakdownTable title="By leg" rows={by_leg} onRowClick={(k) => crossFilter('leg', k)} />
          <BreakdownTable title="By session" rows={by_session} onRowClick={(k) => crossFilter('session', k)} />
        </div>
      )}

      {activeTab === 'distributions' && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card title="R-multiple distribution">
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={histogram}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-grid)" />
                  <XAxis dataKey="r" tick={{ fill: 'var(--color-text-muted)', fontSize: 11 }} tickFormatter={(v) => `${v}R`} />
                  <YAxis tick={{ fill: 'var(--color-text-muted)', fontSize: 11 }} allowDecimals={false} />
                  <Tooltip contentStyle={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }} labelFormatter={(v) => `${v}R bucket`} />
                  <ReferenceLine x={0} stroke="var(--color-border)" />
                  <Bar dataKey="count">
                    {histogram.map((h, i) => (
                      <Cell key={i} fill={h.r >= 0 ? colors.positive : colors.negative} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </Card>

            <Card title="MAE vs MFE (stop-tightness view)">
              <div className="mb-2 text-xs text-text-muted">
                {clippedStops.length} trade{clippedStops.length === 1 ? '' : 's'} exited at SL after reaching at least the planned TP
                distance in favorable excursion (amber) -- the stop likely clipped a winner.
              </div>
              <ResponsiveContainer width="100%" height={180}>
                <ScatterChart>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-grid)" />
                  <XAxis
                    type="number"
                    dataKey="mae_points"
                    name="MAE"
                    tick={{ fill: 'var(--color-text-muted)', fontSize: 11 }}
                    label={{ value: 'MAE (pts)', position: 'insideBottom', offset: -5, fill: 'var(--color-text-muted)', fontSize: 11 }}
                  />
                  <YAxis
                    type="number"
                    dataKey="mfe_points"
                    name="MFE"
                    tick={{ fill: 'var(--color-text-muted)', fontSize: 11 }}
                    label={{ value: 'MFE (pts)', angle: -90, position: 'insideLeft', fill: 'var(--color-text-muted)', fontSize: 11 }}
                  />
                  <ZAxis range={[24, 24]} />
                  <Tooltip
                    cursor={{ strokeDasharray: '3 3' }}
                    contentStyle={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
                    formatter={(v, name) => [Number(v).toFixed(2), String(name)]}
                  />
                  <Scatter data={wins} fill={colors.positive} fillOpacity={0.6} />
                  <Scatter data={losses} fill={colors.negative} fillOpacity={0.6} />
                  <Scatter data={clippedStops} fill="var(--color-warning)" fillOpacity={0.9} />
                </ScatterChart>
              </ResponsiveContainer>
              <div className="mt-3 grid grid-cols-2 gap-3 border-t border-border pt-3 sm:grid-cols-4">
                <KpiTile label="Losses" value={String(regime.losses)} />
                <KpiTile label="Clipped stops" value={String(regime.clippedStops)} accent={regime.clippedStops === 0} />
                <KpiTile
                  label="Clipped share"
                  value={regime.clippedStopsShare !== null ? fmtPct(regime.clippedStopsShare) : '-'}
                  accent={regime.clippedStopsShare !== null ? regime.clippedStopsShare < 0.2 : undefined}
                />
                <KpiTile label="Avg MAE / SL" value={regime.avgMaeToSlRatio !== null ? regime.avgMaeToSlRatio.toFixed(2) : '-'} />
              </div>
            </Card>
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card title="Net PnL by hour of day (America/New_York)">
              <BucketBarChart data={hourBuckets} valueLabel="Net PnL" onSelect={(k) => crossFilter('entryHourNy', Number(k))} winColor={colors.positive} lossColor={colors.negative} />
            </Card>
            <Card title="Net PnL by weekday">
              <BucketBarChart data={weekdayBuckets} valueLabel="Net PnL" onSelect={(k) => crossFilter('weekday', k)} winColor={colors.positive} lossColor={colors.negative} />
            </Card>
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card title="Net PnL by hold time (bars_held)">
              <BucketBarChart data={holdTimeBuckets} valueLabel="Net PnL" onSelect={(k) => crossFilter('holdTimeBucket', k)} winColor={colors.positive} lossColor={colors.negative} />
            </Card>
            <Card title="Win/loss streak distribution">
              <StreakChart streaks={streaks} onSelect={(type, length) => crossFilter('streakSelector', { type, length })} winColor={colors.positive} lossColor={colors.negative} />
              <div className="mt-2 flex items-center gap-4 text-[11px] text-text-muted">
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-2 w-2 rounded-sm" style={{ background: colors.positive }} /> Win streaks
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-2 w-2 rounded-sm" style={{ background: colors.negative }} /> Loss streaks
                </span>
                <span className="ml-auto">
                  Longest win {streaks.longestWin} &middot; longest loss {streaks.longestLoss}
                </span>
              </div>
            </Card>
          </div>
        </div>
      )}

      {activeTab === 'score' && (
        <div className="space-y-4">
          <ScoreCard score={score} />
          <Card>
            <div className="mb-2 flex items-center justify-between">
              <div className="text-sm font-medium text-text">AI insight (optional)</div>
              <button
                onClick={() => runId && summarizeMutation.mutate({ runId, scope })}
                disabled={!aiStatusQuery.data?.available || summarizeMutation.isPending}
                className="rounded bg-accent px-3 py-1 text-xs text-white disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-text-muted"
              >
                {summarizeMutation.isPending ? 'Summarizing…' : 'Summarize this run'}
              </button>
            </div>
            {!aiStatusQuery.data?.available && (
              <p className="text-xs text-text-muted">
                Not configured -- set ANTHROPIC_API_KEY on the backend to enable this. Sends only the aggregated stats shown on this page
                (never raw trades or bars) to Claude for a short plain-English read.
              </p>
            )}
            {summarizeMutation.isError && <p className="text-xs text-negative">{(summarizeMutation.error as Error).message}</p>}
            {summarizeMutation.data && <p className="whitespace-pre-line text-sm text-text">{summarizeMutation.data.summary}</p>}
          </Card>
        </div>
      )}
    </div>
  )
}
