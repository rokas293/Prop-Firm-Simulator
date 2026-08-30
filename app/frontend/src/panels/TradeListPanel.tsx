import { useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useTrades } from '../api/hooks'
import type { TradeRecord } from '../api/types'
import { EXIT_TYPE_OPTIONS, SIDE_OPTIONS, filtersToParams, useTradeStore, type ResultFilter } from '../state/tradeStore'
import { useChartViewStore } from '../state/chartViewStore'
import { useUiStore } from '../state/uiStore'
import { applyCompassFilters } from '../compass/breakdowns'
import EmptyState from '../components/EmptyState'
import Skeleton from '../components/Skeleton'

type SortColumn =
  | 'entry_time'
  | 'leg'
  | 'session'
  | 'side'
  | 'size_contracts'
  | 'entry_price'
  | 'exit_price'
  | 'exit_type'
  | 'pnl_usd'
  | 'r_multiple'
  | 'mae_points'
  | 'mfe_points'

// Width lives with the column definition (not a separate Tailwind class per
// cell) so the header row and every virtualized body row derive their grid
// from exactly the same source -- see GRID_TEMPLATE/GRID_TOTAL_WIDTH below
// (POLISH_ROADMAP Phase P4: row-virtualized table, not a native <table>
// with content-driven column widths).
const COLUMNS: { key: SortColumn; label: string; width: number }[] = [
  { key: 'entry_time', label: 'Entry time', width: 150 },
  { key: 'leg', label: 'Leg', width: 110 },
  { key: 'session', label: 'Session', width: 90 },
  { key: 'side', label: 'Side', width: 64 },
  { key: 'size_contracts', label: 'Size', width: 56 },
  { key: 'entry_price', label: 'Entry', width: 84 },
  { key: 'exit_price', label: 'Exit', width: 84 },
  { key: 'exit_type', label: 'Exit type', width: 84 },
  { key: 'pnl_usd', label: 'PnL', width: 84 },
  { key: 'r_multiple', label: 'R', width: 64 },
  { key: 'mae_points', label: 'MAE', width: 64 },
  { key: 'mfe_points', label: 'MFE', width: 64 },
]
const GRID_TEMPLATE = COLUMNS.map((c) => `${c.width}px`).join(' ')
const GRID_TOTAL_WIDTH = COLUMNS.reduce((sum, c) => sum + c.width, 0)
const ROW_HEIGHT = 28

function fmtTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 16).replace('T', ' ')
}

function sortValue(t: TradeRecord, col: SortColumn): string | number | null {
  return t[col]
}

// A standalone dockable panel (POLISH_ROADMAP Phase P1): no props from a
// parent -- it's a sibling of the Chart panel in the workspace, not a
// child, so it reads the run/filters/selection from the same shared
// stores the Chart panel uses and coordinates purely through them.
export default function TradeListPanel() {
  const runId = useUiStore((s) => s.selectedRunId)
  const filters = useTradeStore((s) => s.filters)
  const setFilter = useTradeStore((s) => s.setFilter)
  const clearFilters = useTradeStore((s) => s.clearFilters)
  const selectedTradeId = useTradeStore((s) => s.selectedTradeId)
  const selectTrade = useTradeStore((s) => s.selectTrade)
  const selectTradeView = useChartViewStore((s) => s.selectTradeView)

  const filterParams = useMemo(() => filtersToParams(filters), [filters])
  const { data: rawTrades } = useTrades(runId, filterParams)
  // Compass cross-filters (entry hour/weekday/hold-time bucket/streak) --
  // /api/trades can't filter on these server-side, so they're applied here
  // client-side to whatever the server already returned (POLISH_ROADMAP
  // Phase P5, see tradeStore.ts's TradeFilters comment).
  const trades = useMemo(() => applyCompassFilters(rawTrades ?? [], filters), [rawTrades, filters])

  // leg/session vocab isn't fixed (strategies add tags like
  // "news_continuation" or "globex_reopen" the spec prose doesn't
  // enumerate), so derive dropdown options from the run's own trades
  // instead of a hardcoded list. Unfiltered, so options never shrink as
  // other filters narrow the visible set.
  const { data: allTrades } = useTrades(runId)
  const legOptions = useMemo(
    () => [...new Set((allTrades ?? []).map((t) => t.leg).filter((v): v is string => v !== null))].sort(),
    [allTrades],
  )
  const sessionOptions = useMemo(
    () => [...new Set((allTrades ?? []).map((t) => t.session).filter((v): v is string => v !== null))].sort(),
    [allTrades],
  )

  const [sortCol, setSortCol] = useState<SortColumn>('entry_time')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')

  const sorted = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1
    return [...trades].sort((a, b) => {
      const av = sortValue(a, sortCol)
      const bv = sortValue(b, sortCol)
      if (av === bv) return 0
      if (av === null) return 1
      if (bv === null) return -1
      return av > bv ? dir : -dir
    })
  }, [trades, sortCol, sortDir])

  const toggleSort = (col: SortColumn) => {
    if (col === sortCol) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortCol(col)
      setSortDir('asc')
    }
  }

  const onSelect = (tradeId: number) => {
    selectTrade(tradeId)
    selectTradeView()
  }

  const hasFilters = Object.values(filters).some((v) => v !== null)

  // Row virtualization (POLISH_ROADMAP Phase P4): only the rows actually in
  // (or near) the viewport get a DOM node, so a 1000+ trade run scrolls at
  // the same frame rate as a 20-trade one. Must be called unconditionally
  // (rules of hooks), so it sits above the early "no run selected" return.
  const parentRef = useRef<HTMLDivElement>(null)
  const rowVirtualizer = useVirtualizer({
    count: sorted.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  })

  if (!runId) {
    return <EmptyState title="No run selected" hint="Pick a run from the Runs list, or press Ctrl/Cmd+K to open one." />
  }

  // POLISH_ROADMAP Phase P6: a skeleton of row-shaped bars instead of a
  // blank list while the first fetch is in flight (see EquityPanel.tsx's
  // own comment for why this is rare but real, post Part P4's prefetch).
  if (rawTrades === undefined) {
    return (
      <div className="flex h-full w-full flex-col gap-2 p-3">
        {Array.from({ length: 10 }, (_, i) => (
          <Skeleton key={i} className="h-[26px]" />
        ))}
      </div>
    )
  }

  return (
    <div className="flex h-full w-full flex-col">
      <div className="space-y-2 border-b border-border p-3 text-xs">
        <div className="flex flex-wrap gap-2">
          <select
            value={filters.leg ?? ''}
            onChange={(e) => setFilter('leg', e.target.value || null)}
            className="rounded bg-surface-2 px-1.5 py-1 text-text"
          >
            <option value="">Leg: all</option>
            {legOptions.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
          <select
            value={filters.session ?? ''}
            onChange={(e) => setFilter('session', e.target.value || null)}
            className="rounded bg-surface-2 px-1.5 py-1 text-text"
          >
            <option value="">Session: all</option>
            {sessionOptions.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
          <select
            value={filters.side ?? ''}
            onChange={(e) => setFilter('side', e.target.value || null)}
            className="rounded bg-surface-2 px-1.5 py-1 text-text"
          >
            <option value="">Side: all</option>
            {SIDE_OPTIONS.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
          <select
            value={filters.result ?? ''}
            onChange={(e) => setFilter('result', (e.target.value || null) as ResultFilter)}
            className="rounded bg-surface-2 px-1.5 py-1 text-text"
          >
            <option value="">Result: all</option>
            <option value="win">Win</option>
            <option value="loss">Loss</option>
          </select>
          <select
            value={filters.exitType ?? ''}
            onChange={(e) => setFilter('exitType', e.target.value || null)}
            className="rounded bg-surface-2 px-1.5 py-1 text-text"
          >
            <option value="">Exit: all</option>
            {EXIT_TYPE_OPTIONS.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-text-muted">From</label>
          <input
            type="date"
            value={filters.dateFrom ?? ''}
            onChange={(e) => setFilter('dateFrom', e.target.value || null)}
            className="rounded bg-surface-2 px-1.5 py-1 text-text"
          />
          <label className="text-text-muted">To</label>
          <input
            type="date"
            value={filters.dateTo ?? ''}
            onChange={(e) => setFilter('dateTo', e.target.value || null)}
            className="rounded bg-surface-2 px-1.5 py-1 text-text"
          />
          {hasFilters && (
            <button
              onClick={clearFilters}
              className="ml-auto rounded bg-surface-2 px-2 py-1 text-text hover:bg-surface-2-hover"
            >
              Clear
            </button>
          )}
        </div>
        <div className="text-text-muted">{sorted.length} trades</div>
      </div>

      <div ref={parentRef} className="min-h-0 flex-1 overflow-auto">
        <div
          className="sticky top-0 z-10 grid border-b border-border bg-bg text-left text-xs text-text-muted"
          style={{ gridTemplateColumns: GRID_TEMPLATE, minWidth: GRID_TOTAL_WIDTH }}
        >
          {COLUMNS.map((c) => (
            <div
              key={c.key}
              onClick={() => toggleSort(c.key)}
              className="cursor-pointer whitespace-nowrap px-2 py-1.5 font-medium hover:text-text"
            >
              {c.label}
              {sortCol === c.key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
            </div>
          ))}
        </div>

        {sorted.length === 0 ? (
          <EmptyState
            title="No trades match the current filters."
            hint={hasFilters ? undefined : 'This run has no trades.'}
          >
            {hasFilters && (
              <button onClick={clearFilters} className="rounded bg-surface-2 px-2 py-1 text-text hover:bg-surface-2-hover">
                Clear filters
              </button>
            )}
          </EmptyState>
        ) : (
          <div
            style={{ height: rowVirtualizer.getTotalSize(), minWidth: GRID_TOTAL_WIDTH, position: 'relative' }}
          >
            {rowVirtualizer.getVirtualItems().map((vRow) => {
              const t = sorted[vRow.index]
              return (
                <div
                  key={t.trade_id}
                  onClick={() => onSelect(t.trade_id)}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    height: vRow.size,
                    transform: `translateY(${vRow.start}px)`,
                    gridTemplateColumns: GRID_TEMPLATE,
                  }}
                  className={`grid cursor-pointer items-center border-b border-border text-xs hover:bg-surface ${
                    selectedTradeId === t.trade_id ? 'bg-surface-2' : ''
                  }`}
                >
                  <div className="truncate whitespace-nowrap px-2 font-mono text-text">
                    {fmtTime(t.entry_time)}
                  </div>
                  <div className="truncate px-2 text-text">{t.leg ?? '-'}</div>
                  <div className="truncate px-2 text-text">{t.session ?? '-'}</div>
                  <div className="truncate px-2 text-text">{t.side}</div>
                  <div className="truncate px-2 text-text">{t.size_contracts}</div>
                  <div className="truncate px-2 text-text">{t.entry_price.toFixed(2)}</div>
                  <div className="truncate px-2 text-text">{t.exit_price.toFixed(2)}</div>
                  <div className="truncate px-2 text-text">{t.exit_type}</div>
                  <div className={`truncate px-2 ${t.pnl_usd >= 0 ? 'text-positive' : 'text-negative'}`}>
                    {t.pnl_usd.toFixed(2)}
                  </div>
                  <div className="truncate px-2 text-text">
                    {t.r_multiple !== null ? t.r_multiple.toFixed(2) : '-'}
                  </div>
                  <div className="truncate px-2 text-text">{t.mae_points.toFixed(2)}</div>
                  <div className="truncate px-2 text-text">{t.mfe_points.toFixed(2)}</div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
