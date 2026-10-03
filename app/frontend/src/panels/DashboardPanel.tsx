import { useEffect, useMemo, useState } from 'react'
import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from 'recharts'
import type { IDockviewPanelProps } from 'dockview-react'
import { useAiStatus, useRun, useStats, useSummarizeRun, useTrades, type StatsScope } from '../api/hooks'
import { useUiStore } from '../state/uiStore'
import { filtersToStatsParams, scopeTradeParams, useTradeStore, type TradeFilters } from '../state/tradeStore'
import { CHART_PANEL_ID, PROP_RISK_PANEL_ID } from '../workspace/panelIds'
import { bySessionHour, byHoldTime, byHourOfDay, byWeekday, sessionsPresent, summarizeStreaks, type BucketStats, type StreakSummary } from '../compass/breakdowns'
import { computeMaeMfeRegime, isClippedStop } from '../compass/regime'
import { heatSummary } from '../compass/heat'
import { describeFilters } from '../compass/describeFilters'
import { computeCompassScore, type CompassScore } from '../compass/score'
import KpiTile from '../components/KpiTile'
import MiniStat from '../components/MiniStat'
import MonteCarloCard from '../components/MonteCarloCard'
import PropResultCard from '../components/PropResultCard'
import Card from '../components/Card'
import BreakdownTable from '../components/BreakdownTable'
import EmptyState from '../components/EmptyState'
import EquitySparkline from '../components/EquitySparkline'
import { KpiRowSkeleton } from '../components/Skeleton'
import { useThemeStore } from '../state/themeStore'
import { fmtPct, fmtR, fmtUsd } from '../format'
import { AXIS_TICK_STYLE, AXIS_LINE_STYLE, TOOLTIP_CONTENT_STYLE } from '../chart/rechartsTheme'
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
        <XAxis dataKey="key" tick={AXIS_TICK_STYLE} axisLine={AXIS_LINE_STYLE} tickLine={AXIS_LINE_STYLE} />
        <YAxis tick={AXIS_TICK_STYLE} axisLine={AXIS_LINE_STYLE} tickLine={AXIS_LINE_STYLE} />
        <Tooltip
          contentStyle={TOOLTIP_CONTENT_STYLE}
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
          tick={AXIS_TICK_STYLE}
          axisLine={AXIS_LINE_STYLE}
          tickLine={AXIS_LINE_STYLE}
          label={{ value: 'Streak length', position: 'insideBottom', offset: -5, fill: 'var(--color-text-muted)', fontSize: 11 }}
        />
        <YAxis tick={AXIS_TICK_STYLE} axisLine={AXIS_LINE_STYLE} tickLine={AXIS_LINE_STYLE} allowDecimals={false} />
        <Tooltip contentStyle={TOOLTIP_CONTENT_STYLE} />
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
        descriptive summary, not a prop-rule outcome – it doesn't affect pass/fail.
      </p>
      {/* 28px = DESIGN_LANGUAGE.md section 3's top hero-KPI step, semibold
          (600) -- the ONE number on this tab reserved for that weight
          (section 3: "semibold only for hero numbers"). Was 36px/bold
          (700), off-scale on both axes (DESIGN_AUDIT.md S1). */}
      <div className="mb-4 flex items-baseline gap-3">
        <span className="text-[28px] font-semibold tabular-nums text-text">{score.total}</span>
        <span className="text-sm text-text-muted">/ 100</span>
      </div>
      <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
        {score.components.map((c) => (
          <div key={c.key}>
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-text">{c.label}</span>
              {/* Medium (500), not semibold -- these are secondary
                  component scores, not the tab's hero number (DESIGN_AUDIT.md
                  S1/S2: reserve 600 for the total above so there's a real,
                  deliberate two-tier hierarchy instead of every number on
                  the tab competing at the same weight). */}
              <span
                className={`text-sm font-medium tabular-nums ${
                  c.score >= 67 ? 'text-positive-fg' : c.score >= 34 ? 'text-warning' : 'text-negative-fg'
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

// A manual session's Combine can still be in progress ("incomplete"), which
// at the 20px KPI size is too wide for its tile -- say what it means instead.
function failReasonLabel(reason: string | null | undefined): string | undefined {
  if (!reason) return undefined
  return reason === 'mll_breach' ? 'Max loss limit breached' : reason
}

function resultLabel(status: string): string {
  return status === 'incomplete' ? 'OPEN' : status.toUpperCase()
}

type TabKey = 'overview' | 'breakdowns' | 'distributions' | 'montecarlo' | 'score'
const TABS: { key: TabKey; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'breakdowns', label: 'Breakdowns' },
  { key: 'distributions', label: 'Distributions' },
  { key: 'montecarlo', label: 'Monte Carlo' },
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
  // FXR_SPEC.md phase F6: a manual session (or all of an instrument's
  // sessions) is served through the same endpoints under a "bt:" run id.
  // It has no IS/OOS split, so the scope toggle is hidden for it, and its
  // stats can optionally be narrowed to the active journal filter (tag/
  // setup/grade/session/hour) -- off by default so the breakdown tables keep
  // showing every slice side by side.
  const manual = run?.source === 'manual'
  const [alsoFilterStats, setAlsoFilterStats] = useState(false)
  const statsFilters = useMemo(
    () => (manual && alsoFilterStats ? filtersToStatsParams(filters) : undefined),
    [manual, alsoFilterStats, filters],
  )
  const { data: stats } = useStats(runId, scope, statsFilters)
  const tradeParams = useMemo(
    () => ({ ...scopeTradeParams(scope, run?.is_oos_split_date ?? null), ...statsFilters }),
    [scope, run, statsFilters],
  )
  const { data: scopedTrades } = useTrades(runId, tradeParams)
  const trades = useMemo(() => scopedTrades ?? [], [scopedTrades])

  const histogram = useMemo(() => buildRHistogram(trades), [trades])
  const hourBuckets = useMemo(() => byHourOfDay(trades), [trades])
  const sessions = useMemo(() => sessionsPresent(trades), [trades])
  const sessionHourBuckets = useMemo(
    () => sessions.map((session) => ({ session, buckets: bySessionHour(trades, session) })),
    [trades, sessions],
  )
  const weekdayBuckets = useMemo(() => byWeekday(trades), [trades])
  const holdTimeBuckets = useMemo(() => byHoldTime(trades), [trades])
  const streaks = useMemo(() => summarizeStreaks(trades), [trades])
  const regime = useMemo(() => computeMaeMfeRegime(trades), [trades])
  const heat = useMemo(() => heatSummary(trades), [trades])
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

  // Accepts a patch of one or more filter dimensions at once -- most call
  // sites set a single key, but the session-hour facet needs to set session
  // + entryHourNy together (see describeFilters).
  function crossFilter(patch: Partial<TradeFilters>) {
    clearFilters()
    for (const key of Object.keys(patch) as (keyof TradeFilters)[]) {
      setFilter(key, patch[key] as never)
    }
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
  const noRuleset = manual && !run?.prop_ruleset
  // A pooled scope spans several accounts, so "no ruleset" would mislead.
  const pooled = manual && (run?.session_ids?.length ?? 0) > 1

  return (
    <div className="h-full overflow-auto p-4">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {!manual && (
          <>
            <span className="text-xs text-text-muted">Scope:</span>
            {SCOPES.map((s) => (
              <button
                key={s.key}
                onClick={() => setScope(s.key)}
                aria-pressed={scope === s.key}
                className={`rounded px-3 py-1 text-sm ${
                  scope === s.key ? 'bg-accent text-on-accent' : 'bg-surface-2 text-text hover:bg-surface-2-hover'
                }`}
              >
                {s.label}
                {s.key === 'oos' && <span className="ml-1 text-[11px] opacity-70">(headline)</span>}
              </button>
            ))}
            {!run?.is_oos_split_date && (
              <span className="text-xs text-text-muted">this run has no IS/OOS split date – scope has no effect</span>
            )}
          </>
        )}
        {hasActiveFilter && (
          <span className="flex items-center gap-1 rounded bg-accent/15 px-2 py-1 text-xs text-accent-fg">
            Trade List + Chart{manual ? ' + Journal' : ''} filtered by {activeFilterDescription}
            <button onClick={clearFilters} aria-label="Clear filter" className="text-accent-fg hover:text-text">
              &times;
            </button>
          </span>
        )}
        {manual && hasActiveFilter && (
          <label className="flex items-center gap-2 text-xs text-text-muted">
            <input type="checkbox" checked={alsoFilterStats} onChange={(e) => setAlsoFilterStats(e.target.checked)} />
            Also filter these stats
          </label>
        )}
      </div>

      {/* Hero row: the 5 numbers this dashboard leads with. Everything else
          is one click away in a tab below (REDESIGN_APPROACH.md Phase B2). */}
      <div className="mb-2 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-5">
        <KpiTile
          label="Result"
          value={noRuleset ? 'N/A' : result ? resultLabel(result.status) : '-'}
          sub={noRuleset ? (pooled ? 'per account only' : 'no prop ruleset') : manual ? (result?.status === 'incomplete' ? 'Combine still open' : undefined) : (failReasonLabel(result?.fail_reason) ?? (result?.status === 'incomplete' ? 'Combine still open' : undefined))}
          accent={resultAccent}
        />
        <KpiTile
          label="Net P&L"
          value={fmtUsd(overall.net_pnl_usd)}
          sub={overall.net_r !== null ? fmtR(overall.net_r) : undefined}
          accent={overall.net_pnl_usd >= 0}
        />
        <KpiTile
          label="Max drawdown"
          value={fmtUsd(Math.abs(overall.max_drawdown_usd))}
          sub={noRuleset ? undefined : `${drawdownPctOfMll}% of $2k MLL`}
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
        {overall.trades} trades{result ? ` · ${result.trading_days} trading days` : ''}
      </div>

      {/* Accessibility audit: this is semantically a tablist (one panel
          visible at a time, exactly one active) but had no ARIA roles at
          all -- a screen reader announced four plain buttons with no
          indication which one was selected or that they were a group. */}
      <div role="tablist" aria-label="Dashboard sections" className="mb-4 flex gap-1 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.key}
            id={`dashboard-tab-${t.key}`}
            role="tab"
            aria-selected={activeTab === t.key}
            aria-controls={`dashboard-tabpanel-${t.key}`}
            onClick={() => setActiveTab(t.key)}
            className={`px-3 py-1 text-sm ${
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
        <div id="dashboard-tabpanel-overview" role="tabpanel" aria-labelledby="dashboard-tab-overview" className="space-y-4">
          <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
            <KpiTile label="Win rate" value={fmtPct(overall.win_rate)} />
            {run?.result.days_to_fail != null && <KpiTile label="Days to fail" value={String(run.result.days_to_fail)} />}
          </div>
          {manual && result && (
            <PropResultCard
              result={result}
              totalTrades={overall.trades}
              rulesetLabel={run?.prop_ruleset === 'topstep_50k' ? 'Topstep $50k Combine' : (run?.prop_ruleset ?? '')}
              onViewRisk={revealPropRisk}
            />
          )}
          {noRuleset && (
            <p className="text-xs text-text-muted">
              {run?.session_ids && run.session_ids.length > 1
                ? 'Prop-firm results are per account, so they are not shown across pooled sessions – open a single Topstep session to see one.'
                : 'This session ran without a prop ruleset. Tick "Topstep $50k Combine rules" when creating a session to get a pass/fail result here.'}
            </p>
          )}
          {!manual && result && (
            <div className="text-xs text-text-muted">
              target hit: {result.target_hit ? 'yes' : 'no'} · consistency:{' '}
              {result.consistency_passed === null ? 'n/a' : result.consistency_passed ? 'passed' : 'failed'} · final balance:{' '}
              {fmtUsd(result.final_balance)}
            </div>
          )}
          <Card>
            <EquitySparkline runId={runId} onViewFull={manual && noRuleset ? undefined : revealPropRisk} />
          </Card>
        </div>
      )}

      {activeTab === 'breakdowns' && (
        <div
          id="dashboard-tabpanel-breakdowns"
          role="tabpanel"
          aria-labelledby="dashboard-tab-breakdowns"
          className="grid grid-cols-1 gap-4 lg:grid-cols-2"
        >
          {manual ? (
            <>
              <BreakdownTable
                title="By setup"
                rows={stats.by_setup ?? {}}
                onRowClick={(k) => k !== '(no setup)' && crossFilter({ setup: k })}
              />
              <BreakdownTable title="By tag" rows={stats.by_tag ?? {}} onRowClick={(k) => crossFilter({ tag: k })} />
              <BreakdownTable
                title="By grade"
                rows={stats.by_grade ?? {}}
                onRowClick={(k) => k !== 'ungraded' && crossFilter({ grade: k })}
              />
              <BreakdownTable title="By trading session" rows={by_session} onRowClick={(k) => crossFilter({ session: k })} />
              {stats.by_backtest_session && Object.keys(stats.by_backtest_session).length > 0 && (
                <BreakdownTable
                  title="By backtest session"
                  rows={stats.by_backtest_session}
                  onRowClick={(k) => crossFilter({ sessionId: k })}
                />
              )}
            </>
          ) : (
            <>
              <BreakdownTable title="By leg" rows={by_leg} onRowClick={(k) => crossFilter({ leg: k })} />
              <BreakdownTable title="By session" rows={by_session} onRowClick={(k) => crossFilter({ session: k })} />
            </>
          )}
        </div>
      )}

      {activeTab === 'distributions' && (
        <div id="dashboard-tabpanel-distributions" role="tabpanel" aria-labelledby="dashboard-tab-distributions" className="space-y-4">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card title="R-multiple distribution">
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={histogram}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-grid)" />
                  <XAxis dataKey="r" tick={AXIS_TICK_STYLE} axisLine={AXIS_LINE_STYLE} tickLine={AXIS_LINE_STYLE} tickFormatter={(v) => `${v}R`} />
                  <YAxis tick={AXIS_TICK_STYLE} axisLine={AXIS_LINE_STYLE} tickLine={AXIS_LINE_STYLE} allowDecimals={false} />
                  <Tooltip contentStyle={TOOLTIP_CONTENT_STYLE} labelFormatter={(v) => `${v}R bucket`} />
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
                distance in favorable excursion (amber) – the stop likely clipped a winner.
              </div>
              <ResponsiveContainer width="100%" height={180}>
                <ScatterChart>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-grid)" />
                  <XAxis
                    type="number"
                    dataKey="mae_points"
                    name="MAE"
                    tick={AXIS_TICK_STYLE}
                    axisLine={AXIS_LINE_STYLE}
                    tickLine={AXIS_LINE_STYLE}
                    label={{ value: 'MAE (pts)', position: 'insideBottom', offset: -5, fill: 'var(--color-text-muted)', fontSize: 11 }}
                  />
                  <YAxis
                    type="number"
                    dataKey="mfe_points"
                    name="MFE"
                    tick={AXIS_TICK_STYLE}
                    axisLine={AXIS_LINE_STYLE}
                    tickLine={AXIS_LINE_STYLE}
                    label={{ value: 'MFE (pts)', angle: -90, position: 'insideLeft', fill: 'var(--color-text-muted)', fontSize: 11 }}
                  />
                  <ZAxis range={[24, 24]} />
                  <Tooltip
                    cursor={{ strokeDasharray: '3 3' }}
                    contentStyle={TOOLTIP_CONTENT_STYLE}
                    formatter={(v, name) => [Number(v).toFixed(2), String(name)]}
                  />
                  <Scatter data={wins} fill={colors.positive} fillOpacity={0.6} />
                  <Scatter data={losses} fill={colors.negative} fillOpacity={0.6} />
                  <Scatter data={clippedStops} fill="var(--color-warning)" fillOpacity={0.9} />
                </ScatterChart>
              </ResponsiveContainer>
              {/* Flattened, borderless substats (DESIGN_AUDIT.md: flatten
                  nesting) -- these used to be 4 individually-bordered
                  KpiTiles inside this already-bordered Card, plus a
                  border-t divider on top of that. Whitespace (the grid gap
                  + the surrounding Card padding) does the separating now. */}
              <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <MiniStat label="Losses" value={String(regime.losses)} />
                <MiniStat label="Clipped stops" value={String(regime.clippedStops)} accent={regime.clippedStops === 0} />
                <MiniStat
                  label="Clipped share"
                  value={regime.clippedStopsShare !== null ? fmtPct(regime.clippedStopsShare) : '-'}
                  accent={regime.clippedStopsShare !== null ? regime.clippedStopsShare < 0.2 : undefined}
                />
                <MiniStat label="Avg MAE / SL" value={regime.avgMaeToSlRatio !== null ? regime.avgMaeToSlRatio.toFixed(2) : '-'} />
              </div>
            </Card>
          </div>

          <Card title="Heat – adverse excursion before resolution (R)">
            {heat.sample === 0 ? (
              <p className="text-xs text-text-muted">
                No trades with a defined stop in this scope, so adverse excursion cannot be expressed in R.
              </p>
            ) : (
              <>
                <p className="mb-2 text-xs text-text-muted">
                  How far each trade went against its entry, in multiples of its planned risk (MAE / stop distance). Winners
                  took a median {heat.winnersMedianR !== null ? fmtR(heat.winnersMedianR) : '-'} of heat before working;
                  losers {heat.losersMedianR !== null ? fmtR(heat.losersMedianR) : '-'}.
                </p>
                <ResponsiveContainer width="100%" height={180}>
                  <BarChart data={heat.buckets}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--color-grid)" />
                    <XAxis dataKey="r" tick={AXIS_TICK_STYLE} axisLine={AXIS_LINE_STYLE} tickLine={AXIS_LINE_STYLE} tickFormatter={(v) => `${v}R`} />
                    <YAxis tick={AXIS_TICK_STYLE} axisLine={AXIS_LINE_STYLE} tickLine={AXIS_LINE_STYLE} allowDecimals={false} />
                    <Tooltip contentStyle={TOOLTIP_CONTENT_STYLE} labelFormatter={(v) => `${v}R and beyond`} />
                    <Bar dataKey="winners" name="Winners" stackId="heat" fill={colors.positive} />
                    <Bar dataKey="losers" name="Losers" stackId="heat" fill={colors.negative} />
                  </BarChart>
                </ResponsiveContainer>
                <div className="mt-2 flex items-center gap-4 text-[11px] text-text-muted">
                  <span className="flex items-center gap-1">
                    <span className="inline-block h-2 w-2 rounded-sm" style={{ background: colors.positive }} /> Winners
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="inline-block h-2 w-2 rounded-sm" style={{ background: colors.negative }} /> Losers
                  </span>
                  <span className="ml-auto tabular-nums">{heat.sample} trades</span>
                </div>
              </>
            )}
          </Card>

          {/* Merged (DESIGN_AUDIT.md DI3): pooled hour-of-day and the
              per-session hour facet used to be two full Card borders for
              the same underlying dimension. One card now, with a muted
              subheading instead of a second border to separate the two
              views. */}
          <Card title="Net PnL by hour (ET)">
            <BucketBarChart data={hourBuckets} valueLabel="Net PnL" onSelect={(k) => crossFilter({ entryHourNy: Number(k) })} winColor={colors.positive} lossColor={colors.negative} />
            <div className="mb-2 mt-4 micro-label">By session</div>
            <p className="mb-2 text-xs text-text-muted">
              The chart above pools every session together, which can hide an hour that's only strong or weak within
              one specific session.
            </p>
            {sessionHourBuckets.length === 0 ? (
              <p className="text-xs text-text-muted">No session-tagged trades in this scope.</p>
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {sessionHourBuckets.map(({ session, buckets }) => (
                  <div key={session}>
                    <div className="mb-1 text-xs font-medium text-text">{session}</div>
                    <BucketBarChart
                      data={buckets}
                      valueLabel="Net PnL"
                      onSelect={(k) => crossFilter({ session, entryHourNy: Number(k) })}
                      winColor={colors.positive}
                      lossColor={colors.negative}
                    />
                  </div>
                ))}
              </div>
            )}
          </Card>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card title="Net PnL by weekday (ET)">
              <BucketBarChart data={weekdayBuckets} valueLabel="Net PnL" onSelect={(k) => crossFilter({ weekday: k })} winColor={colors.positive} lossColor={colors.negative} />
            </Card>
            <Card title="Net PnL by hold time (bars_held)">
              <BucketBarChart data={holdTimeBuckets} valueLabel="Net PnL" onSelect={(k) => crossFilter({ holdTimeBucket: k })} winColor={colors.positive} lossColor={colors.negative} />
            </Card>
          </div>

          <Card title="Win/loss streak distribution">
            <StreakChart streaks={streaks} onSelect={(type, length) => crossFilter({ streakSelector: { type, length } })} winColor={colors.positive} lossColor={colors.negative} />
            <div className="mt-2 flex items-center gap-4 text-[11px] text-text-muted">
              <span className="flex items-center gap-1">
                <span className="inline-block h-2 w-2 rounded-sm" style={{ background: colors.positive }} /> Win streaks
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block h-2 w-2 rounded-sm" style={{ background: colors.negative }} /> Loss streaks
              </span>
              <span className="ml-auto">
                Longest win {streaks.longestWin} &middot; longest loss {streaks.longestLoss}
              </span>
            </div>
          </Card>
        </div>
      )}

      {activeTab === 'montecarlo' && (
        <div id="dashboard-tabpanel-montecarlo" role="tabpanel" aria-labelledby="dashboard-tab-montecarlo">
          <MonteCarloCard runId={runId} filters={statsFilters} />
        </div>
      )}

      {activeTab === 'score' && (
        <div id="dashboard-tabpanel-score" role="tabpanel" aria-labelledby="dashboard-tab-score" className="space-y-4">
          <ScoreCard score={score} />
          <Card>
            <div className="mb-2 flex items-center justify-between">
              {/* 16px/medium, matching Card's own title prop exactly -- this
                  is a compound title+button header (Card's documented
                  escape hatch for that case), but it sits directly under
                  ScoreCard's 16px title above and should read as the same
                  weight class, not a smaller one. */}
              <div className="text-base font-medium text-text">AI insight (optional)</div>
              <button
                onClick={() => runId && summarizeMutation.mutate({ runId, scope })}
                disabled={!aiStatusQuery.data?.available || summarizeMutation.isPending}
                className="rounded bg-accent px-3 py-1 text-xs text-on-accent disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-text-muted"
              >
                {summarizeMutation.isPending ? 'Summarizing…' : 'Summarize this run'}
              </button>
            </div>
            {!aiStatusQuery.data?.available && (
              <p className="text-xs text-text-muted">
                Not configured – set ANTHROPIC_API_KEY on the backend to enable this. Sends only the aggregated stats shown on this page
                (never raw trades or bars) to Claude for a short plain-English read.
              </p>
            )}
            {summarizeMutation.isError && <p className="text-xs text-negative-fg">{(summarizeMutation.error as Error).message}</p>}
            {summarizeMutation.data && <p className="whitespace-pre-line text-sm text-text">{summarizeMutation.data.summary}</p>}
          </Card>
        </div>
      )}
    </div>
  )
}
