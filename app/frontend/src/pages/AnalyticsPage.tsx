// FXR_V2_SPEC.md section 6 (G8): the Analytics page for MANUAL sessions -- one
// scrolling page of sections, scoped to one session or all of them and filterable by
// instrument. (The dock workspace stays for automated propbt runs.)
//
// Engine-truth: every number here is the server's -- the summary endpoint
// (services/manual_analytics.analytics_summary), the RR simulator, the same trade
// list the table pages through, and the existing Monte Carlo. This file lays them out.
import CsvExportMenu from '../components/CsvExportMenu'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useAnalyticsSummary, useBtSessions, useRun, useStats, useTrades } from '../api/hooks'
import { MANUAL_ALL_SESSIONS_RUN_ID, manualRunId, type GroupStats, type PeriodBucket, type TradeRecord } from '../api/types'
import AnalyticsTradesTable from '../analytics/AnalyticsTradesTable'
import RrSimulatorCard from '../analytics/RrSimulatorCard'
import { AXIS_LINE_STYLE, AXIS_TICK_STYLE, TOOLTIP_CONTENT_STYLE } from '../chart/rechartsTheme'
import { sessionDisplayName } from '../chart/sessionEnd'
import KpiTile from '../components/KpiTile'
import MonteCarloCard from '../components/MonteCarloCard'
import Skeleton, { KpiRowSkeleton } from '../components/Skeleton'
import { fmtPct, fmtR, fmtUsd, fmtUsdWhole } from '../format'
import { useThemeStore } from '../state/themeStore'
import { useUiStore } from '../state/uiStore'
import { fmtEtDate, fmtEtLongDate } from '../timeFormat'

const SECTIONS = [
  { id: 'stats', label: 'Session stats' },
  { id: 'charts', label: 'Charts' },
  { id: 'drawdown', label: 'Drawdown' },
  { id: 'rr', label: 'RR simulator' },
  { id: 'monte-carlo', label: 'Monte Carlo' },
  { id: 'trades', label: 'Trades' },
] as const

const CHIP =
  'h-7 rounded px-3 text-xs transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent'

function Section({ id, title, hint, children }: { id: string; title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section id={`analytics-${id}`} aria-labelledby={`analytics-${id}-title`} className="flex scroll-mt-16 flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id={`analytics-${id}-title`} className="text-base font-medium text-text">
          {title}
        </h2>
        {hint && <p className="text-xs text-text-muted">{hint}</p>}
      </div>
      {children}
    </section>
  )
}

// G10 (FXR_V2_SPEC.md section 8, "Mixed mode"): the same session's results split by who took the
// trade. The server's numbers (by_source of the stats endpoint); an interrupted Autopilot run
// is flagged because it no longer equals an offline backtest of the same window.
function SourceSplit({ rows, interruptions }: { rows: Record<string, GroupStats>; interruptions: number }) {
  const order = ['manual', 'bot'].filter((k) => rows[k])
  const label: Record<string, string> = { manual: 'Manual', bot: 'Autopilot' }
  const note =
    interruptions > 0 ? (
      <p className="text-xs text-text">
        Autopilot was interrupted {interruptions === 1 ? 'once' : `${interruptions} times`} (switched off and on again):
        those runs no longer match an offline backtest of the same window.
      </p>
    ) : null
  // One source is the whole scope: the tiles above already are its numbers.
  if (order.length < 2) {
    return (
      <div className="flex flex-col gap-2" data-testid="source-split">
        <p className="text-xs text-text-muted">All of these trades are {order[0] === 'bot' ? "Autopilot's" : 'manual'}.</p>
        {note}
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-2" data-testid="source-split">
      <h3 className="micro-label">Results by source</h3>
      <table className="w-full max-w-[640px] border-collapse text-xs">
        <thead>
          <tr className="text-right">
            <th className="micro-label h-7 pr-3 text-left font-medium">Source</th>
            <th className="micro-label h-7 px-3 font-medium">Trades</th>
            <th className="micro-label h-7 px-3 font-medium">Net P&amp;L</th>
            <th className="micro-label h-7 px-3 font-medium">Win rate</th>
            <th className="micro-label h-7 px-3 font-medium">Expectancy</th>
            <th className="micro-label h-7 pl-3 font-medium">Profit factor</th>
          </tr>
        </thead>
        <tbody>
          {order.map((k) => {
            const g = rows[k]
            return (
              <tr key={k} className="text-right tabular-nums">
                <td className="h-7 pr-3 text-left text-text">{label[k]}</td>
                <td className="h-7 px-3">{g.trades}</td>
                <td className={`h-7 px-3 ${g.net_pnl_usd > 0 ? 'text-positive-fg' : g.net_pnl_usd < 0 ? 'text-negative-fg' : ''}`}>{fmtUsd(g.net_pnl_usd)}</td>
                <td className="h-7 px-3">{fmtPct(g.win_rate)}</td>
                <td className="h-7 px-3">{g.expectancy_usd === null ? '-' : fmtUsd(g.expectancy_usd)}</td>
                <td className="h-7 pl-3">{g.profit_factor === null ? '-' : g.profit_factor.toFixed(2)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {note}
    </div>
  )
}

const money = (v: number | null | undefined) => (v === null || v === undefined ? '-' : fmtUsd(v))
const sign = (v: number | null | undefined): boolean | undefined => (v === null || v === undefined || v === 0 ? undefined : v > 0)
const periodWord = (n: number, word: string) => `${n} active ${word}${n === 1 ? '' : 's'}`

function PnlBars({ data, height = 200, label }: { data: PeriodBucket[]; height?: number; label: string }) {
  const colors = useThemeStore((s) => s.colors)
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ left: 8, right: 8 }} aria-label={label}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-grid)" />
        <XAxis dataKey="label" tick={AXIS_TICK_STYLE} axisLine={AXIS_LINE_STYLE} tickLine={AXIS_LINE_STYLE} />
        <YAxis tick={AXIS_TICK_STYLE} axisLine={AXIS_LINE_STYLE} tickLine={AXIS_LINE_STYLE} tickFormatter={(v) => fmtUsdWhole(Number(v))} />
        <Tooltip
          contentStyle={TOOLTIP_CONTENT_STYLE}
          cursor={{ fill: 'var(--color-surface-2)' }}
          formatter={(v) => [fmtUsd(Number(v)), 'Net P&L']}
          labelFormatter={(l, items) => {
            const b = items?.[0]?.payload as PeriodBucket | undefined
            return b ? `${l} · ${b.trades} trade${b.trades === 1 ? '' : 's'} · ${fmtPct(b.win_rate)} win rate` : String(l)
          }}
        />
        <ReferenceLine y={0} stroke="var(--color-border)" />
        <Bar dataKey="net_pnl_usd" isAnimationActive={false} maxBarSize={32}>
          {data.map((b) => (
            <Cell key={b.key} fill={b.net_pnl_usd >= 0 ? colors.positive : colors.negative} fillOpacity={0.75} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

export default function AnalyticsPage() {
  const runId = useUiStore((s) => s.selectedRunId) as string
  const selectRun = useUiStore((s) => s.selectRun)
  const openJournalTrade = useUiStore((s) => s.openJournalTrade)
  const colors = useThemeStore((s) => s.colors)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [instrument, setInstrument] = useState<string | null>(null)

  const { data: run } = useRun(runId)
  const { data: allSessions } = useBtSessions(true)
  const { data: summary, isLoading } = useAnalyticsSummary(runId, instrument)
  // G10: manual vs Autopilot results, when a bot has traded in this scope.
  const { data: statsAll } = useStats(runId, 'all')
  const bySource = statsAll?.by_source ?? {}
  const botTraded = (run?.autopilot_sessions ?? 0) > 0 && Object.keys(bySource).length > 0
  const tradeParams = useMemo(() => (instrument ? { instrument } : undefined), [instrument])
  const { data: tradesData } = useTrades(runId, tradeParams)
  const trades = useMemo<TradeRecord[]>(() => tradesData ?? [], [tradesData])

  // The instrument filter belongs to a scope: a different scope starts unfiltered.
  useEffect(() => setInstrument(null), [runId])

  const scopeIsAll = runId === MANUAL_ALL_SESSIONS_RUN_ID || runId.startsWith(`${MANUAL_ALL_SESSIONS_RUN_ID}:`)
  const sessionOptions = useMemo(
    () =>
      (allSessions ?? []).map((s) => ({
        id: s.id,
        label: sessionDisplayName(s, fmtEtLongDate) + (s.status === 'archived' ? ' (archived)' : ''),
      })),
    [allSessions],
  )

  const equity = useMemo(() => {
    const steps = summary?.equity ?? []
    if (steps.length === 0) return []
    // Anchor the curve at zero just before the first exit.
    return [{ time: steps[0].time - 1, pnl_usd: 0 }, ...steps]
  }, [summary])

  const stats = summary?.stats
  const instruments = summary?.instruments ?? run?.instruments ?? []
  const empty = !!stats && stats.trades === 0
  const scrollTo = (id: string) => scrollRef.current?.querySelector(`#analytics-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })

  return (
    <div ref={scrollRef} className="h-[calc(100vh-52px)] overflow-y-auto" data-testid="analytics-page">
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-border bg-bg px-6 py-3">
        <label className="flex items-center gap-2 text-xs text-text-muted">
          Scope
          <select
            aria-label="Scope"
            value={scopeIsAll ? MANUAL_ALL_SESSIONS_RUN_ID : runId}
            onChange={(e) => selectRun(e.target.value === MANUAL_ALL_SESSIONS_RUN_ID ? MANUAL_ALL_SESSIONS_RUN_ID : manualRunId(e.target.value.replace(/^bt:/, '')))}
            className="propbt-input max-w-64"
          >
            <option value={MANUAL_ALL_SESSIONS_RUN_ID}>All sessions</option>
            {sessionOptions.map((o) => (
              <option key={o.id} value={manualRunId(o.id)}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        {instruments.length > 1 && (
          <div className="flex items-center gap-1" role="group" aria-label="Instrument">
            {[null, ...instruments].map((sym) => (
              <button
                key={sym ?? 'all'}
                type="button"
                aria-pressed={instrument === sym}
                onClick={() => setInstrument(sym)}
                className={`${CHIP} ${instrument === sym ? 'bg-surface-2 text-text' : 'text-text-muted hover:bg-surface-2 hover:text-text'}`}
              >
                {sym ?? 'All instruments'}
              </button>
            ))}
          </div>
        )}

        <CsvExportMenu sessionId={scopeIsAll ? null : runId.replace(/^bt:/, '')} align="left" />

        <nav aria-label="Sections" className="ml-auto flex flex-wrap items-center gap-1">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => scrollTo(s.id)}
              className={`${CHIP} text-text-muted hover:bg-surface-2 hover:text-text`}
            >
              {s.label}
            </button>
          ))}
        </nav>
      </div>

      <div className="mx-auto flex max-w-[1100px] flex-col gap-8 px-6 py-6">
        <Section
          id="stats"
          title="Session stats"
          hint={
            summary
              ? `${summary.sessions.length === 1 ? summary.sessions[0].name : `${summary.sessions.length} sessions`}${instrument ? ` · ${instrument}` : ''} · ${stats?.trades ?? 0} trades`
              : undefined
          }
        >
          {isLoading || !stats ? (
            <KpiRowSkeleton count={5} />
          ) : empty ? (
            <p className="py-6 text-xs text-text-muted">No trades in this scope yet. Close a trade in a session and it will appear here.</p>
          ) : (
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-5">
                <KpiTile label="Total P&L" value={fmtUsd(stats.net_pnl_usd)} accent={sign(stats.net_pnl_usd)} sub={`${stats.trades} trades`} />
                <KpiTile label="Win rate" value={fmtPct(stats.win_rate)} sub={`${stats.wins} won · ${stats.losses} lost`} />
                <KpiTile label="Avg R per trade" value={fmtR(stats.avg_r)} accent={sign(stats.avg_r)} sub={`mean realized R · ${stats.r_trades} trades with a stop`} />
                <KpiTile label="Profit factor" value={stats.profit_factor === null ? (stats.gross_profit_usd > 0 ? '∞' : '-') : stats.profit_factor.toFixed(2)} />
                <KpiTile label="Avg win / loss" value={`${money(stats.avg_win_usd)} / ${money(stats.avg_loss_usd)}`} />
              </div>
              <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
                <KpiTile
                  label="Avg planned R:R"
                  value={stats.avg_planned_rr === null ? '-' : `${stats.avg_planned_rr.toFixed(2)}R`}
                  sub={`${stats.planned_rr_trades} trades with a stop and target`}
                />
                <KpiTile
                  label="Avg gain / active month"
                  value={money(stats.avg_gain_month.value)}
                  accent={sign(stats.avg_gain_month.value)}
                  sub={periodWord(stats.avg_gain_month.periods, 'month')}
                />
                <KpiTile
                  label="Avg gain / active week"
                  value={money(stats.avg_gain_week.value)}
                  accent={sign(stats.avg_gain_week.value)}
                  sub={periodWord(stats.avg_gain_week.periods, 'week')}
                />
                <KpiTile
                  label="Avg gain / active day"
                  value={money(stats.avg_gain_day.value)}
                  accent={sign(stats.avg_gain_day.value)}
                  sub={periodWord(stats.avg_gain_day.periods, 'day')}
                />
              </div>
              <p className="text-xs text-text-muted">
                An active day, week or month is one with at least one trade; days are CME trading days of each trade&apos;s
                entry. Avg R per trade is the mean realized R; avg planned R:R is target distance over stop distance at entry.
                Each is shown with the number of trades it is based on.
              </p>
              {botTraded && <SourceSplit rows={bySource} interruptions={run?.autopilot_interruptions ?? 0} />}
            </div>
          )}
        </Section>

        {!empty && (
          <Section id="charts" title="Charts">
            {isLoading || !summary ? (
              <Skeleton className="h-[240px]" />
            ) : (
              <div className="flex flex-col gap-6">
                <div>
                  <div className="micro-label mb-2">Equity curve · cumulative net P&amp;L</div>
                  <ResponsiveContainer width="100%" height={240}>
                    <AreaChart data={equity} margin={{ left: 8, right: 8 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--color-grid)" />
                      <XAxis
                        dataKey="time"
                        type="number"
                        scale="time"
                        domain={['dataMin', 'dataMax']}
                        tick={AXIS_TICK_STYLE}
                        axisLine={AXIS_LINE_STYLE}
                        tickLine={AXIS_LINE_STYLE}
                        tickFormatter={(t) => fmtEtDate(Number(t))}
                        minTickGap={48}
                      />
                      <YAxis tick={AXIS_TICK_STYLE} axisLine={AXIS_LINE_STYLE} tickLine={AXIS_LINE_STYLE} tickFormatter={(v) => fmtUsdWhole(Number(v))} />
                      <Tooltip
                        contentStyle={TOOLTIP_CONTENT_STYLE}
                        labelFormatter={(t) => fmtEtDate(Number(t))}
                        formatter={(v) => [fmtUsd(Number(v)), 'Net P&L']}
                      />
                      <ReferenceLine y={0} stroke="var(--color-border)" />
                      <Area
                        dataKey="pnl_usd"
                        type="stepAfter"
                        stroke={colors.accent}
                        strokeWidth={2}
                        fill={colors.accent}
                        fillOpacity={0.08}
                        dot={false}
                        isAnimationActive={false}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
                <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                  <div>
                    <div className="micro-label mb-2">Monthly performance</div>
                    <PnlBars data={summary.monthly} label="Monthly performance" />
                  </div>
                  <div>
                    <div className="micro-label mb-2">Performance by weekday</div>
                    <PnlBars data={summary.weekday} label="Performance by weekday" />
                  </div>
                </div>
              </div>
            )}
          </Section>
        )}

        {!empty && (
          <Section
            id="drawdown"
            title="Drawdown analytics"
            hint="Heat on winners: how far the trades that went on to win traded against the entry first, in R (the broker's max adverse excursion over the stop distance)."
          >
            {!summary ? (
              <Skeleton className="h-14" />
            ) : summary.heat.sample === 0 ? (
              <p className="text-xs text-text-muted">No winning trade with a stop to measure heat against yet.</p>
            ) : (
              <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
                <KpiTile label="Average heat" value={fmtR(summary.heat.avg_r)} />
                <KpiTile label="Max heat" value={fmtR(summary.heat.max_r)} />
                <KpiTile label="Min heat" value={fmtR(summary.heat.min_r)} />
                <KpiTile label="Winners measured" value={String(summary.heat.sample)} />
              </div>
            )}
          </Section>
        )}

        <Section
          id="rr"
          title="RR simulator"
          hint="What if each target had been n times the risk? Every trade that had a stop at entry is replayed on its real 1-minute path with its own stop."
        >
          <RrSimulatorCard runId={runId} instrument={instrument} />
        </Section>

        {!empty && (
          <Section id="monte-carlo" title="Monte Carlo">
            <MonteCarloCard runId={runId} filters={tradeParams} />
          </Section>
        )}

        <Section id="trades" title="Trades" hint="Open a row to review it in its session's journal.">
          <AnalyticsTradesTable
            trades={trades}
            onOpenTrade={(t) => {
              if (t.session_id) openJournalTrade(t.session_id, t.session_trade_id ?? t.trade_id)
            }}
            showInstrumentFilter={false}
          />
        </Section>
      </div>
    </div>
  )
}
