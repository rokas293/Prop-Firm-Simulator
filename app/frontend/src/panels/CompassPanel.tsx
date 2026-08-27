import { useEffect, useMemo, useState } from 'react'
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { IDockviewPanelProps } from 'dockview-react'
import { useAiStatus, useRun, useStats, useSummarizeRun, useTrades, type StatsScope } from '../api/hooks'
import { useUiStore } from '../state/uiStore'
import { scopeTradeParams, useTradeStore, type TradeFilters } from '../state/tradeStore'
import { CHART_PANEL_ID } from '../workspace/panelIds'
import {
  byHoldTime,
  byHourOfDay,
  byWeekday,
  summarizeStreaks,
  type BucketStats,
  type StreakSummary,
} from '../compass/breakdowns'
import { computeMaeMfeRegime } from '../compass/regime'
import { computeCompassScore, type CompassScore } from '../compass/score'
import KpiTile from '../components/KpiTile'
import ChartCard from '../components/ChartCard'
import BreakdownTable from '../components/BreakdownTable'
import EmptyState from '../components/EmptyState'
import { KpiRowSkeleton } from '../components/Skeleton'
import { useThemeStore } from '../state/themeStore'
import { fmtPct, fmtUsd } from '../format'

const SCOPES: { key: StatsScope; label: string }[] = [
  { key: 'oos', label: 'Out-of-sample' },
  { key: 'is', label: 'In-sample' },
  { key: 'all', label: 'All' },
]

// Bucket bars are colored by net PnL sign (win-green/loss-red), same
// convention as DashboardPanel's R-histogram -- a single series needs no
// legend (dataviz skill: "a single series needs no legend box -- the title
// names it"). winColor/lossColor come from the theme (POLISH_ROADMAP Phase
// P6), passed down from CompassPanel rather than each chart reading the
// store itself.
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
        <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
        <XAxis dataKey="key" tick={{ fill: '#8b949e', fontSize: 11 }} />
        <YAxis tick={{ fill: '#8b949e', fontSize: 11 }} />
        <Tooltip
          contentStyle={{ background: '#161b22', border: '1px solid #30363d' }}
          formatter={(v) => [fmtUsd(Number(v)), valueLabel]}
          labelFormatter={(k) => `${k}`}
        />
        <Bar
          dataKey="netPnlUsd"
          cursor="pointer"
          onClick={(d) => onSelect((d.payload as BucketStats).key)}
        >
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
        <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
        <XAxis dataKey="length" tick={{ fill: '#8b949e', fontSize: 11 }} label={{ value: 'Streak length', position: 'insideBottom', offset: -5, fill: '#8b949e', fontSize: 11 }} />
        <YAxis tick={{ fill: '#8b949e', fontSize: 11 }} allowDecimals={false} />
        <Tooltip contentStyle={{ background: '#161b22', border: '1px solid #30363d' }} />
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

function ScoreCard({ score }: { score: CompassScore }) {
  return (
    <ChartCard title="Compass score">
      <p className="mb-3 text-xs text-neutral-500">
        Formula: the plain average of four 0-100 components below (each equally weighted, 25%). This is a
        descriptive summary, not a prop-rule outcome -- it doesn't affect pass/fail.
      </p>
      <div className="mb-3 flex items-baseline gap-3">
        <span className="text-4xl font-bold text-neutral-100">{score.total}</span>
        <span className="text-sm text-neutral-500">/ 100</span>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {score.components.map((c) => (
          <div key={c.key} className="rounded border border-neutral-800 bg-neutral-950 px-3 py-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-neutral-300">{c.label}</span>
              <span
                className={`text-sm font-semibold ${
                  c.score >= 67 ? 'text-accent-green' : c.score >= 34 ? 'text-amber-400' : 'text-accent-red'
                }`}
              >
                {c.score}
              </span>
            </div>
            <div className="mt-1 text-[11px] text-neutral-500">{c.detail}</div>
          </div>
        ))}
      </div>
    </ChartCard>
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

// A standalone dockable panel (POLISH_ROADMAP Phase P5): TradeSea
// "Compass"-style behavioral/pattern analytics over a run's trades. Per-leg
// and per-session breakdowns reuse StatsResponse.by_leg/by_session directly
// (already server-computed); everything else here is descriptive
// aggregation over already-fetched trades (see compass/breakdowns.ts's
// header comment) -- no financial recomputation (VIZ_SPEC section 0).
export default function CompassPanel({ containerApi }: IDockviewPanelProps) {
  const runId = useUiStore((s) => s.selectedRunId)
  const filters = useTradeStore((s) => s.filters)
  const setFilter = useTradeStore((s) => s.setFilter)
  const clearFilters = useTradeStore((s) => s.clearFilters)

  const [scope, setScope] = useState<StatsScope>('oos')
  const colors = useThemeStore((s) => s.colors)

  const { data: run } = useRun(runId)
  const { data: stats } = useStats(runId, scope)
  const tradeParams = useMemo(() => scopeTradeParams(scope, run?.is_oos_split_date ?? null), [scope, run])
  const { data: scopedTrades } = useTrades(runId, tradeParams)
  const trades = useMemo(() => scopedTrades ?? [], [scopedTrades])

  const hourBuckets = useMemo(() => byHourOfDay(trades), [trades])
  const weekdayBuckets = useMemo(() => byWeekday(trades), [trades])
  const holdTimeBuckets = useMemo(() => byHoldTime(trades), [trades])
  const streaks = useMemo(() => summarizeStreaks(trades), [trades])
  const regime = useMemo(() => computeMaeMfeRegime(trades), [trades])
  const score = useMemo(() => (stats ? computeCompassScore(stats.overall, trades) : null), [stats, trades])

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

  // Reuses the exact same clear-then-set-one-filter pattern as
  // DashboardPanel's crossFilter -- "reuse existing filter state," not a
  // parallel filtering mechanism. See tradeStore.ts's TradeFilters comment
  // for which of these dimensions are server-filtered vs. client-only.
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
        <KpiRowSkeleton count={4} />
      </div>
    )
  }

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
        {hasActiveFilter && (
          <span className="flex items-center gap-1.5 rounded bg-accent-blue/15 px-2 py-1 text-xs text-accent-blue">
            Trade List + Chart filtered by {activeFilterDescription}
            <button onClick={clearFilters} className="text-accent-blue hover:text-neutral-100">
              &times;
            </button>
          </span>
        )}
        <span className="ml-auto text-xs text-neutral-600">{trades.length} trades in scope</span>
      </div>

      <div className="mb-6">
        <ScoreCard score={score} />
      </div>

      <div className="mb-6 rounded border border-neutral-800 bg-neutral-900 p-4">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-sm font-medium text-neutral-300">AI insight (optional)</div>
          <button
            onClick={() => runId && summarizeMutation.mutate({ runId, scope })}
            disabled={!aiStatusQuery.data?.available || summarizeMutation.isPending}
            className="rounded bg-accent-blue px-3 py-1 text-xs text-white disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500"
          >
            {summarizeMutation.isPending ? 'Summarizing…' : 'Summarize this run'}
          </button>
        </div>
        {!aiStatusQuery.data?.available && (
          <p className="text-xs text-neutral-600">
            Not configured -- set ANTHROPIC_API_KEY on the backend to enable this. Sends only the aggregated stats
            shown on this page (never raw trades or bars) to Claude for a short plain-English read.
          </p>
        )}
        {summarizeMutation.isError && (
          <p className="text-xs text-accent-red">{(summarizeMutation.error as Error).message}</p>
        )}
        {summarizeMutation.data && (
          <p className="whitespace-pre-line text-sm text-neutral-300">{summarizeMutation.data.summary}</p>
        )}
      </div>

      <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <BreakdownTable title="By leg" rows={stats.by_leg} onRowClick={(k) => crossFilter('leg', k)} />
        <BreakdownTable title="By session" rows={stats.by_session} onRowClick={(k) => crossFilter('session', k)} />
      </div>

      <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard title="Net PnL by hour of day (America/New_York)">
          <BucketBarChart
            data={hourBuckets}
            valueLabel="Net PnL"
            onSelect={(k) => crossFilter('entryHourNy', Number(k))}
            winColor={colors.up}
            lossColor={colors.down}
          />
        </ChartCard>
        <ChartCard title="Net PnL by weekday">
          <BucketBarChart
            data={weekdayBuckets}
            valueLabel="Net PnL"
            onSelect={(k) => crossFilter('weekday', k)}
            winColor={colors.up}
            lossColor={colors.down}
          />
        </ChartCard>
      </div>

      <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard title="Net PnL by hold time (bars_held)">
          <BucketBarChart
            data={holdTimeBuckets}
            valueLabel="Net PnL"
            onSelect={(k) => crossFilter('holdTimeBucket', k)}
            winColor={colors.up}
            lossColor={colors.down}
          />
        </ChartCard>
        <ChartCard title="Win/loss streak distribution">
          <StreakChart
            streaks={streaks}
            onSelect={(type, length) => crossFilter('streakSelector', { type, length })}
            winColor={colors.up}
            lossColor={colors.down}
          />
          <div className="mt-2 flex items-center gap-4 text-[11px] text-neutral-500">
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-2 w-2 rounded-sm" style={{ background: colors.up }} /> Win streaks
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-2 w-2 rounded-sm" style={{ background: colors.down }} /> Loss streaks
            </span>
            <span className="ml-auto">
              Longest win {streaks.longestWin} &middot; longest loss {streaks.longestLoss}
            </span>
          </div>
        </ChartCard>
      </div>

      <ChartCard title="Stop-tightness read (MAE/MFE regime)">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <KpiTile label="Losses" value={String(regime.losses)} />
          <KpiTile
            label="Clipped stops"
            value={String(regime.clippedStops)}
            accent={regime.clippedStops === 0}
          />
          <KpiTile
            label="Clipped share of losses"
            value={regime.clippedStopsShare !== null ? fmtPct(regime.clippedStopsShare) : '-'}
            accent={regime.clippedStopsShare !== null ? regime.clippedStopsShare < 0.2 : undefined}
          />
          <KpiTile
            label="Avg MAE / SL"
            value={regime.avgMaeToSlRatio !== null ? regime.avgMaeToSlRatio.toFixed(2) : '-'}
          />
        </div>
        <p className="mt-3 text-xs text-neutral-500">
          "Clipped stops" are trades that exited at the stop loss yet still reached the planned take-profit
          distance in favorable excursion at some point (VIZ_SPEC section 4) -- a high share means the stop is
          likely cutting off winners rather than catching real losers.
        </p>
      </ChartCard>
    </div>
  )
}
