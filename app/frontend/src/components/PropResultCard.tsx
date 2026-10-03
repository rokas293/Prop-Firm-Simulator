import type { StatsResult } from '../api/types'
import { describePropResult } from '../compass/propResult'
import { fmtUsd } from '../format'
import Card from './Card'
import MiniStat from './MiniStat'

// FXR_SPEC.md section D, phase F6: "if the session used the Topstep ruleset,
// show pass/fail + how it happened". The verdict itself comes from propbt's
// PropRulesTracker (server-side, via StatsResult); this only words it and
// points at the existing Prop Risk panel for the equity-vs-floor picture.
export default function PropResultCard({
  result,
  totalTrades,
  rulesetLabel,
  onViewRisk,
}: {
  result: StatsResult
  totalTrades: number
  rulesetLabel: string
  onViewRisk?: () => void
}) {
  const n = describePropResult(result, totalTrades)
  return (
    <Card>
      <div className="mb-2 flex items-center justify-between">
        <div className="text-base font-medium text-text">Prop-firm result</div>
        <span className="text-xs text-text-muted">{rulesetLabel}</span>
      </div>
      {/* The verdict itself (PASSED / FAILED / OPEN) is stated once, as the
          coloured hero Result tile above; this card only explains how it
          came about, so its headline is neutral text. */}
      <div className="text-[14px] font-medium text-text">{n.headline}</div>
      <div className="mt-1 space-y-1 text-xs text-text-muted">
        {n.details.map((d) => (
          <p key={d}>{d}</p>
        ))}
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MiniStat label="Target hit" value={result.target_hit ? 'Yes' : 'No'} />
        <MiniStat
          label="Consistency"
          value={result.consistency_passed === null ? 'n/a' : result.consistency_passed ? 'Passed' : 'Not met'}
        />
        <MiniStat label="Balance at result" value={fmtUsd(result.final_balance)} />
        <MiniStat label="Trading days" value={String(result.trading_days)} />
      </div>
      <div className="mt-3 flex items-center justify-between gap-4">
        <p className="text-[11px] text-text-muted">
          Replayed through the same rule engine as the automated backtest, at trade resolution: each trade&apos;s worst
          point (MAE) is checked against the floor, stamped at its exit time.
        </p>
        {onViewRisk && (
          <button onClick={onViewRisk} className="whitespace-nowrap text-xs text-accent-fg hover:text-text">
            View in Prop Risk &rarr;
          </button>
        )}
      </div>
    </Card>
  )
}
