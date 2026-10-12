// FXR_V2_SPEC.md section 6 / phase G1: the bottom bar's "Prop Rules" popover
// for a prop session. A light read of the engine's verdict (the same
// PropRulesTracker result the Analytics page shows, worded by
// describePropResult) plus the position cap; the full Stats & Rules modal is
// phase G8. It only renders what the engine decided -- nothing here judges a
// rule.
import { useEffect, useRef } from 'react'
import { useModalFocus } from '../components/useModalFocus'
import type { PropRules, StatsResult } from '../api/types'
import { describeRules } from '../chart/sessionSetup'
import { describePropResult } from '../compass/propResult'
import Skeleton from '../components/Skeleton'
import { POPOVER_SHELL } from '../components/popoverStyles'

const STATUS_LABEL = { passed: 'Passed', failed: 'Failed', incomplete: 'In progress' } as const

export default function PropRulesPopover({
  result,
  totalTrades,
  rulesetLabel,
  maxContracts,
  rules,
  ended = false,
  onOpenAnalytics,
  onClose,
}: {
  result: StatsResult | null | undefined
  totalTrades: number
  rulesetLabel: string
  maxContracts: number | null
  // The rule set this session is judged by (null for a session that predates it).
  rules?: PropRules | null
  // The replay has reached its end date: an open Combine reads "Not passed", as on the completion card.
  ended?: boolean
  onOpenAnalytics: () => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  // Focus moves in on open, Tab cycles inside, and focus returns to the Prop
  // Rules button on close (Escape and outside-click close it below).
  useModalFocus(ref, true)
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      // The toggle button lives outside this popover; let its own click close it.
      const t = e.target as HTMLElement
      if (!ref.current?.contains(t) && !t.closest('[data-prop-rules-toggle]')) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const narrative = result ? describePropResult(result, totalTrades) : null
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Prop rules"
      className={`${POPOVER_SHELL} absolute bottom-full right-2 z-30 mb-2 flex w-80 flex-col gap-3 p-4`}
    >
      <div className="flex items-baseline justify-between">
        <span className="text-sm text-text">{rulesetLabel}</span>
        <span className="text-xs text-text-muted">
          {narrative?.status === 'incomplete' && ended ? 'Not passed' : STATUS_LABEL[narrative?.status ?? 'incomplete']}
        </span>
      </div>
      {narrative ? (
        <div className="flex flex-col gap-1 text-xs">
          <span className="text-text">{narrative.headline}</span>
          {narrative.details.map((d) => (
            <span key={d} className="text-text-muted">
              {d}
            </span>
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-2" aria-label="Loading the Combine result">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      )}
      {rules && (
        <ul className="flex flex-col gap-1 text-xs text-text-muted" aria-label="Rules">
          {/* One cap for the account, counted across every instrument it trades. */}
          {describeRules(rules).map((line) => (
            <li key={line}>{line.startsWith('Cap ') ? `${line} across instruments` : line}</li>
          ))}
          {(rules.no_overnight || rules.no_weekend) && <li>Flat by {rules.close_time} ET</li>}
        </ul>
      )}
      {/* The rules list already says it; this row is for a session with no saved rules. */}
      {!rules && (
        <div className="flex items-baseline justify-between text-xs">
          <span className="micro-label">Position cap</span>
          <span className="tabular-nums text-text">{maxContracts !== null ? `${maxContracts} contracts across instruments` : 'None'}</span>
        </div>
      )}
      <button
        type="button"
        onClick={onOpenAnalytics}
        className="-ml-2 h-7 self-start rounded px-2 text-xs text-text transition-colors hover:bg-surface-2-hover active:bg-surface-2-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      >
        Full result in Analytics
      </button>
    </div>
  )
}
