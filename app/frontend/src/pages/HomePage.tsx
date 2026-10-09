// Home (FXR_V2_SPEC.md section 4, G6; layout after reference R9): KPI cards over
// every active session's journaled trades, a win-rate-by-weekday chart, and the
// recent sessions as cards -- each with its progress, a resume button and an
// expandable detail -- with "+ New session" the one accent action.
//
// Engine-truth: every number here is read from the API (journaled trades, the
// PropRulesTracker verdict, replay progress); nothing is recomputed. Buys and
// sells are told apart by weight, not colour: colour is for win/loss data.
import { useMemo, useState } from 'react'
import { ChevronDown, Play } from 'lucide-react'
import { useBtSessions, useHomeOverview, useSessionSetupOptions } from '../api/hooks'
import { useUiStore } from '../state/uiStore'
import Skeleton from '../components/Skeleton'
import NewSessionDialog from '../components/NewSessionDialog'
import { FirstRunGuide } from '../components/OnboardingGuide'
import { fmtDuration, fmtPct, fmtUsd } from '../format'
import { fmtEtLongDate } from '../timeFormat'
import { sessionDisplayName } from '../chart/sessionEnd'
import { describeRules, rulesLabel } from '../chart/sessionSetup'
import { manualAllRunId, manualRunId } from '../api/types'
import type { BacktestSessionSummary, HomeKpis, WeekdayWinRate } from '../api/types'

const RECENT_LIMIT = 6

function KpiCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-28 flex-col gap-2 rounded bg-surface p-4">
      <div className="micro-label">{label}</div>
      {children}
    </div>
  )
}

function Hero({ children }: { children: React.ReactNode }) {
  return <div className="text-[24px] font-semibold leading-[1.1] tabular-nums text-text">{children}</div>
}

export function TradesTakenCard({ kpis }: { kpis: HomeKpis }) {
  const buyShare = kpis.trades > 0 ? kpis.buys / kpis.trades : 0
  return (
    <KpiCard label="Trades taken">
      <Hero>{kpis.trades.toLocaleString('en-US')}</Hero>
      <div className="flex flex-col gap-1">
        {/* The split: the filled part is buys, the rest sells. */}
        <div
          className="h-1 overflow-hidden rounded-full bg-surface-2"
          role="img"
          aria-label={kpis.trades > 0 ? `${fmtPct(buyShare)} buys, ${fmtPct(1 - buyShare)} sells` : 'No trades yet'}
        >
          <div className="h-full bg-text-muted" style={{ width: `${buyShare * 100}%` }} />
        </div>
        <div className="text-[11px] tabular-nums text-text-muted">
          {kpis.trades > 0 ? `${kpis.buys} buys (${fmtPct(buyShare)}) · ${kpis.sells} sells (${fmtPct(1 - buyShare)})` : 'No trades yet'}
        </div>
      </div>
    </KpiCard>
  )
}

export function WinRateCard({ kpis }: { kpis: HomeKpis }) {
  return (
    <KpiCard label="Overall win rate">
      <Hero>{fmtPct(kpis.win_rate)}</Hero>
      <div className="text-[11px] tabular-nums text-text-muted">{kpis.trades > 0 ? `${kpis.wins} of ${kpis.trades} trades won` : 'No trades yet'}</div>
    </KpiCard>
  )
}

export function TimeInTradeCard({ kpis }: { kpis: HomeKpis }) {
  return (
    <KpiCard label="Average time in trade">
      <Hero>{fmtDuration(kpis.avg_time_in_trade_seconds)}</Hero>
      <div className="text-[11px] text-text-muted">{kpis.trades > 0 ? 'Entry to last exit' : 'No trades yet'}</div>
    </KpiCard>
  )
}

const CHART_HEIGHT = 160
const GRID_LINES = [0, 0.5, 1]

export function WeekdayChart({ days }: { days: WeekdayWinRate[] }) {
  const any = days.some((d) => d.trades > 0)
  return (
    <div className="rounded bg-surface p-4">
      <h2 className="mb-8 text-base font-medium text-text">Win rate by weekday</h2>
      {!any ? (
        <p className="text-xs text-text-muted">Trades you take will show their win rate by the weekday they were entered.</p>
      ) : (
        <div className="flex gap-3">
          <div className="relative w-8 flex-none" style={{ height: CHART_HEIGHT }} aria-hidden>
            {GRID_LINES.map((g) => (
              <span key={g} className="absolute right-0 -translate-y-1/2 text-[11px] tabular-nums text-text-muted" style={{ top: `${(1 - g) * 100}%` }}>
                {g * 100}%
              </span>
            ))}
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="relative" style={{ height: CHART_HEIGHT }}>
              {GRID_LINES.map((g) => (
                <div key={g} className="absolute inset-x-0 border-t border-border/50" style={{ top: `${(1 - g) * 100}%` }} aria-hidden />
              ))}
              <div className="absolute inset-0 grid grid-cols-5 gap-4 px-2" role="list" aria-label="Win rate by weekday">
                {days.map((d) => (
                  <div
                    key={d.weekday}
                    role="listitem"
                    className="group relative flex items-end justify-center"
                    title={d.win_rate === null ? `${d.label}: no trades` : `${d.label}: ${fmtPct(d.win_rate)} (${d.wins} of ${d.trades})`}
                  >
                    {d.win_rate !== null && (
                      <>
                        <div
                          className="w-full max-w-12 rounded-t bg-text-muted/70 transition-colors group-hover:bg-text-muted"
                          style={{ height: `${d.win_rate * 100}%`, minHeight: 2 }}
                          aria-label={`${d.label} ${fmtPct(d.win_rate)}`}
                        />
                        <span className="absolute -translate-y-1 text-[11px] tabular-nums text-text" style={{ bottom: `${d.win_rate * 100}%` }}>
                          {fmtPct(d.win_rate)}
                        </span>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-5 gap-4 px-2">
              {days.map((d) => (
                <div key={d.weekday} className="flex flex-col items-center text-[11px]">
                  <span className="text-text-muted">{d.label}</span>
                  <span className="tabular-nums text-text-muted">{d.trades} {d.trades === 1 ? 'trade' : 'trades'}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="micro-label">{label}</span>
      <span className="truncate text-xs tabular-nums text-text">{children}</span>
    </div>
  )
}

const VERDICT = { passed: 'Passed', failed: 'Failed', incomplete: 'In progress' } as const
// The same session once its replay has ended without a pass or fail (matches the completion card).
const VERDICT_ENDED_OPEN = 'Not passed'

export function SessionCard({ session }: { session: BacktestSessionSummary }) {
  const [expanded, setExpanded] = useState(false)
  const selectSession = useUiStore((s) => s.selectSession)
  const selectRun = useUiStore((s) => s.selectRun)
  const p = session.progress
  const name = sessionDisplayName(session, fmtEtLongDate)
  const assets = session.assets.length > 0 ? session.assets.join(' + ') : session.instrument
  const range = session.end_date !== null ? `${fmtEtLongDate(session.start_time)} → ${fmtEtLongDate(session.end_date)}` : `from ${fmtEtLongDate(session.start_time)}`
  const rules = session.account.prop_rules
  const verdict = session.prop_status?.status
  const pnl = p?.net_pnl_usd ?? 0

  return (
    <article className="rounded bg-surface p-4" aria-label={`Session ${name}`}>
      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={() => selectSession(session.id)}
          aria-label={`Resume ${name}`}
          title={p?.complete ? 'Review this session' : 'Resume'}
          className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-surface-2 text-text transition-colors hover:bg-surface-2-hover active:bg-border focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <Play size={14} fill="currentColor" aria-hidden />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] text-text">{name}</div>
          <div className="truncate text-xs tabular-nums text-text-muted">
            {assets} · {range}
          </div>
        </div>
        <div className="hidden w-56 flex-none flex-col gap-1 sm:flex">
          {p?.fraction !== null && p?.fraction !== undefined ? (
            <>
              <div
                className="h-1 overflow-hidden rounded-full bg-surface-2"
                role="progressbar"
                aria-label="Session progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(p.fraction * 100)}
              >
                <div className="h-full bg-text-muted" style={{ width: `${p.fraction * 100}%` }} />
              </div>
              <div className="text-right text-[11px] tabular-nums text-text-muted">
                {p.complete
                  ? 'Complete'
                  : p.trading_days_remaining === null
                    ? ''
                    : `${p.trading_days_remaining} ${p.trading_days_remaining === 1 ? 'day' : 'days'} remaining`}
              </div>
            </>
          ) : (
            <div className="text-right text-[11px] text-text-muted">No end date</div>
          )}
        </div>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-label={expanded ? `Hide details of ${name}` : `Show details of ${name}`}
          className="flex h-7 w-7 flex-none items-center justify-center rounded text-text-muted transition-colors hover:bg-surface-2 hover:text-text active:bg-surface-2-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        >
          <ChevronDown size={16} aria-hidden className={`transition-transform duration-150 ${expanded ? 'rotate-180' : ''}`} />
        </button>
      </div>

      {expanded && (
        <div className="mt-4 flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
            <Detail label="Started">{fmtEtLongDate(session.start_time)}</Detail>
            <Detail label="Replay at">{fmtEtLongDate(session.cursor_time)}</Detail>
            <Detail label="Balance">{fmtUsd(session.account.balance)}</Detail>
            <Detail label="Net P&L">
              <span className={pnl > 0 ? 'text-positive-fg' : pnl < 0 ? 'text-negative-fg' : ''}>{fmtUsd(pnl)}</span>
            </Detail>
            <Detail label="Trades">{p?.trades ?? 0}</Detail>
            <Detail label="Win rate">{fmtPct(p?.win_rate)}</Detail>
            <Detail label="Rules">
              {rulesLabel(session.account.prop_ruleset)}
              {verdict && (
                <span className={`ml-2 ${verdict === 'passed' ? 'text-positive-fg' : verdict === 'failed' ? 'text-negative-fg' : 'text-text-muted'}`}>{verdict === 'incomplete' && p?.complete ? VERDICT_ENDED_OPEN : VERDICT[verdict]}</span>
              )}
            </Detail>
            <Detail label="Discipline lock">{session.discipline_lock ? 'On' : 'Off'}</Detail>
          </div>
          {rules && <p className="text-xs text-text-muted">{describeRules(rules).join(' · ')}</p>}
          {session.checklist.length > 0 && <p className="text-xs text-text-muted">Checklist: {session.checklist.join(' · ')}</p>}
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => selectRun(manualRunId(session.id))}
              className="-ml-2 h-7 rounded px-2 text-xs text-text-muted transition-colors hover:bg-surface-2 hover:text-text active:bg-surface-2-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              Analytics
            </button>
          </div>
        </div>
      )}
    </article>
  )
}

function HomeSkeleton() {
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-6" aria-label="Loading home">
      <div className="grid grid-cols-3 gap-4">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-28" />
        ))}
      </div>
      <Skeleton className="h-72" />
      <div className="flex flex-col gap-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-[68px]" />
        ))}
      </div>
    </div>
  )
}

export default function HomePage() {
  const { data: sessions, isLoading, isError, error } = useBtSessions()
  const { data: overview } = useHomeOverview()
  // Warm the New session form's data ranges (the first read loads the bar data).
  useSessionSetupOptions()
  const selectRun = useUiStore((s) => s.selectRun)
  const [newOpen, setNewOpen] = useState(false)
  const [showAll, setShowAll] = useState(false)

  const recent = useMemo(() => [...(sessions ?? [])].sort((a, b) => b.updated_at.localeCompare(a.updated_at)), [sessions])
  const shown = showAll ? recent : recent.slice(0, RECENT_LIMIT)

  if (isLoading) return <HomeSkeleton />
  if (isError) {
    return (
      <div className="p-6">
        <span className="text-negative-fg">Failed to load sessions</span>
        <span className="text-text-muted">: {(error as Error).message}</span>
      </div>
    )
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-6">
      <FirstRunGuide />

      {overview ? (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <TradesTakenCard kpis={overview.kpis} />
            <WinRateCard kpis={overview.kpis} />
            <TimeInTradeCard kpis={overview.kpis} />
          </div>
          <WeekdayChart days={overview.weekday} />
        </>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3" aria-label="Loading totals">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-28" />
            ))}
          </div>
          <Skeleton className="h-72" />
        </>
      )}

      <section className="flex flex-col gap-4" aria-label="Recent sessions">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-medium text-text">Recent sessions</h2>
          <div className="flex items-center gap-2">
            {/* Every session of one instrument, pooled (the chart plots one price scale). */}
            {(['MNQ', 'MES'] as const)
              .filter((sym) => sessions?.some((s) => s.instrument === sym))
              .map((sym) => (
                <button
                  key={sym}
                  type="button"
                  onClick={() => selectRun(manualAllRunId(sym))}
                  title={`Analytics across all ${sym} sessions combined`}
                  className="h-8 rounded px-2 text-xs text-text-muted transition-colors hover:bg-surface-2 hover:text-text active:bg-surface-2-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                >
                  All {sym} analytics
                </button>
              ))}
            <button
              type="button"
              onClick={() => setNewOpen(true)}
              className="h-8 rounded bg-accent px-3 text-xs text-on-accent transition-opacity hover:opacity-90 active:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              + New session
            </button>
          </div>
        </div>

        {recent.length === 0 ? (
          <p className="text-xs text-text-muted">No sessions yet. Start one with “+ New session”.</p>
        ) : (
          <>
            <div className="flex flex-col gap-2">
              {shown.map((s) => (
                <SessionCard key={s.id} session={s} />
              ))}
            </div>
            {recent.length > RECENT_LIMIT && (
              <button
                type="button"
                onClick={() => setShowAll((v) => !v)}
                className="-ml-2 h-7 self-start rounded px-2 text-xs text-text-muted transition-colors hover:bg-surface-2 hover:text-text active:bg-surface-2-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              >
                {showAll ? 'Show fewer' : `Show all ${recent.length} sessions`}
              </button>
            )}
          </>
        )}
      </section>

      <NewSessionDialog open={newOpen} onClose={() => setNewOpen(false)} />
    </div>
  )
}
