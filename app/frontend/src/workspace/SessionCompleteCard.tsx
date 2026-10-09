// FXR_V2_SPEC.md section 4 (G6): "a session ends when the cursor reaches its end
// date. The session then shows a completion state with links to analytics."
// Shown over the chart when the replay reaches the end date: the result (the
// engine's own numbers for the session, and the PropRulesTracker verdict for a
// prop session) and the ways on -- Analytics, the Journal, or back to the chart.
// It renders what the API returned; it judges nothing itself.
import { useRef } from 'react'
import { useModalFocus } from '../components/useModalFocus'
import { describePropResult } from '../compass/propResult'
import { fmtPct, fmtUsd } from '../format'
import { fmtEtLongDate } from '../timeFormat'
import type { StatsResponse } from '../api/types'

const VERDICT_WORD = { passed: 'Passed', failed: 'Failed', incomplete: 'Not passed' } as const

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="micro-label">{label}</span>
      <span className="text-[14px] tabular-nums text-text">{children}</span>
    </div>
  )
}

export default function SessionCompleteCard({
  name,
  endDate,
  balance,
  isProp,
  stats,
  onAnalytics,
  onJournal,
  onDismiss,
}: {
  name: string
  endDate: number | null
  balance: number
  isProp: boolean
  stats: StatsResponse | undefined
  onAnalytics: () => void
  onJournal: () => void
  onDismiss: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useModalFocus(ref, true)
  const overall = stats?.overall
  const narrative = isProp && stats?.result ? describePropResult(stats.result, overall?.trades ?? 0) : null
  const pnl = overall?.net_pnl_usd ?? 0

  return (
    <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center px-4">
      <div
        ref={ref}
        role="dialog"
        aria-label="Session complete"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onDismiss()
        }}
        className="propbt-fade-in pointer-events-auto flex w-full max-w-sm flex-col gap-4 rounded bg-surface-2 p-4 shadow-[var(--shadow-panel-float)]"
      >
        <div>
          <h2 className="text-base font-medium text-text">Session complete</h2>
          <p className="text-xs text-text-muted">
            {name}
            {endDate !== null ? ` · reached its end date, ${fmtEtLongDate(endDate)}.` : '.'}
          </p>
        </div>

        {narrative && (
          <div className="flex flex-col gap-1 text-xs">
            <span className={narrative.status === 'passed' ? 'text-positive-fg' : narrative.status === 'failed' ? 'text-negative-fg' : 'text-text'}>
              {VERDICT_WORD[narrative.status]}
              <span className="text-text"> · {narrative.headline}</span>
            </span>
            {narrative.details.map((d) => (
              <span key={d} className="text-text-muted">
                {d}
              </span>
            ))}
          </div>
        )}

        {overall ? (
          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            <Stat label="Net P&L">
              <span className={pnl > 0 ? 'text-positive-fg' : pnl < 0 ? 'text-negative-fg' : ''}>{fmtUsd(pnl)}</span>
            </Stat>
            <Stat label="Balance">{fmtUsd(balance)}</Stat>
            <Stat label="Trades">{overall.trades}</Stat>
            <Stat label="Win rate">{fmtPct(overall.win_rate)}</Stat>
          </div>
        ) : (
          <div className="h-16 rounded bg-surface" aria-label="Loading the result" />
        )}

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onDismiss}
            className="h-7 rounded px-2 text-xs text-text-muted transition-colors hover:bg-surface-2-hover hover:text-text active:bg-surface-2-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          >
            Review chart
          </button>
          <button
            type="button"
            onClick={onJournal}
            className="h-7 rounded px-2 text-xs text-text transition-colors hover:bg-surface-2-hover active:bg-surface-2-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          >
            Open journal
          </button>
          <button
            type="button"
            onClick={onAnalytics}
            className="h-7 rounded bg-accent px-3 text-xs text-on-accent transition-opacity hover:opacity-90 active:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            View analytics
          </button>
        </div>
      </div>
    </div>
  )
}
