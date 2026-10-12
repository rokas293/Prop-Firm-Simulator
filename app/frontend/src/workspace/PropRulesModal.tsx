// FXR_V2_SPEC.md section 6 (G8), after reference R7: the Prop Rules modal, opened
// from the bottom bar or Tab. Three progress cards (profit target, max loss, daily
// loss), the rules table and the restrictions checklist.
//
// Engine-truth: every figure is what `GET .../prop-rules` returned -- read from
// propbt's PropRulesTracker after replaying the journaled trades plus the open
// position's float (the sim broker's number, passed in as `openPnl`). Nothing here
// adds, subtracts or compares a dollar amount; it formats and draws what it was
// given. Replaces the G1 popover.
import { useRef } from 'react'
import { Check, X } from 'lucide-react'
import { usePropRulesStatus } from '../api/hooks'
import type { PropProgress, PropRulesStatus } from '../api/types'
import { useModalFocus } from '../components/useModalFocus'
import Skeleton from '../components/Skeleton'
import { fmtPct, fmtUsd } from '../format'

const STATUS_WORD = { passed: 'Passed', failed: 'Failed', incomplete: 'In progress' } as const
const FAIL_REASON_TEXT: Record<string, string> = { mll_breach: 'Max loss limit breached' }

export function ProgressCard({
  title,
  progress,
  usedLabel,
  tone,
  note,
}: {
  title: string
  progress: PropProgress
  usedLabel: string
  // Which semantic colour the filled part takes: profit is positive data, a loss budget negative.
  tone: 'positive' | 'negative'
  note?: string
}) {
  const off = progress.limit === null
  const pct = Math.round(progress.fraction * 100)
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2 rounded bg-surface-2 p-3" data-testid={`card-${title}`}>
      <div className="micro-label">{title}</div>
      {off ? (
        <div className="text-[13px] text-text-muted">Off</div>
      ) : (
        <>
          <div className="flex items-baseline gap-2">
            <span className="text-[16px] font-medium tabular-nums text-text" data-testid="used">
              {fmtUsd(progress.used)}
            </span>
            <span className="text-xs tabular-nums text-text-muted">
              {usedLabel} · {pct}%
            </span>
          </div>
          <div
            className="h-1 w-full overflow-hidden rounded bg-surface"
            role="progressbar"
            aria-label={`${title} progress`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
          >
            <div
              className={`h-full rounded ${tone === 'positive' ? 'bg-positive-fg' : 'bg-negative-fg'}`}
              style={{ width: `${Math.round(Math.min(1, Math.max(0, progress.fraction)) * 1000) / 10}%` }}
            />
          </div>
          <div className="flex items-baseline justify-between gap-2 text-xs tabular-nums">
            <span className="text-text" data-testid="left">
              {fmtUsd(progress.left)} <span className="text-text-muted">left</span>
            </span>
            {note && <span className="truncate text-text-muted">{note}</span>}
          </div>
        </>
      )}
    </div>
  )
}

function verdictLine(s: PropRulesStatus, ended: boolean): string {
  if (s.status === 'failed') return FAIL_REASON_TEXT[s.fail_reason ?? ''] ?? s.fail_reason ?? 'Failed'
  if (s.status === 'passed') return 'Profit target reached, consistency satisfied'
  if (s.target_hit && s.consistency_passed === false) return 'Target reached, consistency rule not met'
  if (ended) return 'Not passed'
  return STATUS_WORD.incomplete
}

export default function PropRulesModal({
  sessionId,
  openPnl,
  cursorTime,
  tradeCount,
  ended = false,
  onOpenAnalytics,
  onClose,
}: {
  sessionId: string
  // The open position's float at `cursorTime`, from the sim broker.
  openPnl: number
  cursorTime: number | null
  // Journaled trades so far: a new one re-reads the status.
  tradeCount: number
  ended?: boolean
  onOpenAnalytics: () => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useModalFocus(ref, true)
  const { data: s, isError } = usePropRulesStatus(sessionId, openPnl, cursorTime, tradeCount)

  return (
    <div className="propbt-cmdk-overlay" onClick={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label="Prop rules"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
        }}
        className="propbt-settings-content flex max-h-[80vh] flex-col"
      >
        <div className="flex flex-none items-center justify-between gap-3 px-4 py-3">
          <div className="flex min-w-0 flex-col">
            <h2 className="text-base font-medium text-text">Prop rules</h2>
            {s && (
              <p className="text-xs text-text-muted" data-testid="verdict">
                {s.label} · <span className={s.status === 'failed' ? 'text-negative-fg' : s.status === 'passed' ? 'text-positive-fg' : ''}>{verdictLine(s, ended)}</span>
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-7 w-7 items-center justify-center rounded text-text-muted transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          >
            <X size={16} aria-hidden />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 pb-4">
          {isError && !s && <p className="text-xs text-text-muted">The rules could not be loaded for this session.</p>}
          {!s && !isError && (
            <div className="grid grid-cols-3 gap-3" aria-label="Loading the rules">
              <Skeleton className="h-24" />
              <Skeleton className="h-24" />
              <Skeleton className="h-24" />
            </div>
          )}
          {s && (
            <>
              <div className="flex flex-col gap-2 sm:flex-row">
                <ProgressCard title="Profit target" progress={s.profit} usedLabel="profit" tone="positive" />
                <ProgressCard
                  title="Max loss"
                  progress={s.max_loss}
                  usedLabel="used"
                  tone="negative"
                  note={`Floor ${fmtUsd(s.max_loss_floor)}${s.max_loss_frozen ? ' (locked)' : s.max_loss_type === 'static' ? '' : ' (trailing)'}`}
                />
                <ProgressCard
                  title="Max daily loss"
                  progress={s.daily_loss}
                  usedLabel="used"
                  tone="negative"
                  note={s.daily_locked ? 'Locked for the day' : undefined}
                />
              </div>

              <p className="-mt-3 text-[11px] tabular-nums text-text-muted" data-testid="equity-line">
                Balance {fmtUsd(s.balance)}
                {s.open_pnl !== 0 ? ` · open P&L ${fmtUsd(s.open_pnl)} · equity ${fmtUsd(s.equity)}` : ''}
                {s.best_day_pnl !== null && s.consistency_pct !== null
                  ? ` · best day ${fmtUsd(s.best_day_pnl)}${s.best_day_share !== null ? ` (${fmtPct(s.best_day_share)} of profit, limit ${s.consistency_pct}%)` : ''}`
                  : ''}
              </p>

              <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
                <section aria-label="Rules" className="flex flex-col gap-2">
                  <h3 className="text-[14px] font-medium text-text">Profit and drawdown</h3>
                  <dl className="flex flex-col">
                    {s.rules.map((r) => (
                      <div key={r.key} className="flex h-7 items-center justify-between gap-3 text-xs">
                        <dt className="text-text-muted">{r.label}</dt>
                        <dd className="text-right tabular-nums text-text">{r.value}</dd>
                      </div>
                    ))}
                  </dl>
                </section>

                <section aria-label="Restrictions" className="flex flex-col gap-2">
                  <h3 className="text-[14px] font-medium text-text">Restrictions</h3>
                  <ul className="flex flex-col">
                    {s.restrictions.map((r) => (
                      <li key={r.key} className="flex min-h-7 items-center justify-between gap-3 text-xs">
                        <span className="flex min-w-0 flex-col py-1">
                          <span className="text-text">{r.label}</span>
                          {r.on && <span className="text-[11px] text-text-muted">{r.detail}</span>}
                        </span>
                        <span className="flex shrink-0 items-center gap-1 text-text-muted">
                          {r.on ? (
                            <>
                              <Check size={14} aria-hidden /> Enforced
                            </>
                          ) : (
                            'Allowed'
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              </div>
            </>
          )}

          <div>
            <button
              type="button"
              onClick={onOpenAnalytics}
              className="-ml-2 h-7 rounded px-2 text-xs text-text transition-colors hover:bg-surface-2 active:bg-surface-2-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              Full result in Analytics
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
