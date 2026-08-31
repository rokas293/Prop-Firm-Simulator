import { useMemo } from 'react'
import { useTrades } from '../api/hooks'
import { useUiStore } from '../state/uiStore'
import { filtersToParams, useTradeStore } from '../state/tradeStore'
import { applyCompassFilters } from '../compass/breakdowns'
import { describeFilters } from '../panels/DashboardPanel'

// Accessibility fix: the trade count ("1191 trades" -> "49 trades" as
// filters change, TradeListPanel's own footer line) and the cross-filter
// badge appearing/clearing (DashboardPanel's own visible badge) were both
// shown only visually -- a screen reader user got no indication either had
// changed. One shared, visually-hidden live region, mounted once at the
// App level, rather than wiring an announcement into each panel that
// already computes this -- both already derive from the same
// runId+filters state this component reads independently (React Query
// caches the identical useTrades call, so this doesn't add a second
// network request).
export default function LiveRegion() {
  const runId = useUiStore((s) => s.selectedRunId)
  const filters = useTradeStore((s) => s.filters)

  const filterParams = useMemo(() => filtersToParams(filters), [filters])
  const { data: rawTrades } = useTrades(runId, filterParams)
  const trades = useMemo(() => applyCompassFilters(rawTrades ?? [], filters), [rawTrades, filters])

  const hasActiveFilter = Object.values(filters).some((v) => v !== null)

  if (!runId || rawTrades === undefined) {
    return (
      <div role="status" aria-live="polite" className="sr-only">
        {' '}
      </div>
    )
  }

  const message = hasActiveFilter
    ? `${trades.length} trades, filtered by ${describeFilters(filters)}`
    : `${trades.length} trades`

  return (
    <div role="status" aria-live="polite" className="sr-only">
      {message}
    </div>
  )
}
