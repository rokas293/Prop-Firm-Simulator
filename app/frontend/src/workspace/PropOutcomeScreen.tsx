// FXR_V2_SPEC.md section 6 (G8): the screen a prop session ends on. A FAILED
// Combine says why and offers "Try again" (a new session on the same rules) and
// "View analytics"; a PASSED one shows a summary card. Like the completion card it
// renders what the API returned -- the verdict is PropRulesTracker's
// (StatsResult), the numbers are the server's.
import { useRef } from 'react'
import { useModalFocus } from '../components/useModalFocus'
import { describePropResult } from '../compass/propResult'
import { fmtPct, fmtUsd } from '../format'
import type { StatsResponse, StatsResult } from '../api/types'

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="micro-label">{label}</span>
      <span className="text-[14px] tabular-nums text-text">{children}</span>
    </div>
  )
}

const GHOST =
  'h-7 rounded px-2 text-xs text-text-muted transition-colors hover:bg-surface-2-hover hover:text-text active:bg-surface-2-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent'
const PRIMARY =
  'h-7 rounded bg-accent px-3 text-xs text-on-accent transition-opacity hover:opacity-90 active:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'

export default function PropOutcomeScreen({
  name,
  result,
  stats,
  onTryAgain,
  onAnalytics,
  onDismiss,
}: {
  name: string
  result: StatsResult
  stats: StatsResponse | undefined
  onTryAgain: () => void
  onAnalytics: () => void
  onDismiss: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useModalFocus(ref, true)
  const failed = result.status === 'failed'
  const overall = stats?.overall
  const narrative = describePropResult(result, overall?.trades ?? 0)
  const pnl = overall?.net_pnl_usd ?? 0

  return (
    <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center px-4">
      <div
        ref={ref}
        role="dialog"
        aria-label={failed ? 'Challenge failed' : 'Challenge passed'}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onDismiss()
        }}
        className="propbt-fade-in pointer-events-auto flex w-full max-w-sm flex-col gap-4 rounded bg-surface-2 p-4 shadow-[var(--shadow-panel-float)]"
      >
        <div>
          <h2 className="text-base font-medium text-text">{failed ? 'Challenge failed' : 'Challenge passed'}</h2>
          <p className="text-xs text-text-muted">{name}</p>
        </div>

        <div className="flex flex-col gap-1 text-xs" data-testid="outcome-cause">
          <span className="text-[14px] font-medium text-text">{narrative.headline}</span>
          {narrative.details.map((d) => (
            <span key={d} className="text-text-muted">
              {d}
            </span>
          ))}
        </div>

        {!failed &&
          (overall ? (
            <div className="grid grid-cols-2 gap-x-4 gap-y-3" data-testid="outcome-summary">
              <Stat label="Net P&L">
                <span className={pnl > 0 ? 'text-positive-fg' : pnl < 0 ? 'text-negative-fg' : ''}>{fmtUsd(pnl)}</span>
              </Stat>
              <Stat label="Final balance">{fmtUsd(result.final_balance)}</Stat>
              <Stat label="Trades">{overall.trades}</Stat>
              <Stat label="Win rate">{fmtPct(overall.win_rate)}</Stat>
              <Stat label="Trading days">{result.trading_days}</Stat>
              <Stat label="Profit factor">{overall.profit_factor === null ? (pnl > 0 ? '∞' : '-') : overall.profit_factor.toFixed(2)}</Stat>
            </div>
          ) : (
            <div className="h-16 rounded bg-surface" aria-label="Loading the summary" />
          ))}

        <div className="flex flex-row-reverse items-center justify-start gap-2">
          {failed ? (
            <>
              <button type="button" onClick={onTryAgain} className={PRIMARY}>
                Try again
              </button>
              <button type="button" onClick={onAnalytics} className={`${GHOST} text-text`}>
                View analytics
              </button>
            </>
          ) : (
            <button type="button" onClick={onAnalytics} className={PRIMARY}>
              View analytics
            </button>
          )}
          <button type="button" onClick={onDismiss} className={GHOST}>
            Review chart
          </button>
        </div>
      </div>
    </div>
  )
}
