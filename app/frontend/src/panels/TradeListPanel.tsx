import { useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useRun, useTrades } from '../api/hooks'
import type { TradeRecord } from '../api/types'
import { EXIT_TYPE_OPTIONS, SIDE_OPTIONS, filtersToParams, useTradeStore, type ResultFilter } from '../state/tradeStore'
import { useChartViewStore } from '../state/chartViewStore'
import { useUiStore } from '../state/uiStore'
import { applyCompassFilters, nyHourOfDay } from '../compass/breakdowns'
import EmptyState from '../components/EmptyState'
import { FILTER_SELECT, FilterChips, FilterField, FiltersPopover } from '../components/FilterBar'
import { activeFilterChips } from '../compass/filterChips'
import Skeleton from '../components/Skeleton'
import { fmtEtDateTime } from '../timeFormat'
import { fmtPoints, fmtPrice, fmtUsd } from '../format'

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
  | 'setup_name'
  | 'grade'
  | 'tags'

// Width lives with the column definition (not a separate Tailwind class per
// cell) so the header row and every virtualized body row derive their grid
// from exactly the same source -- see GRID_TEMPLATE/GRID_TOTAL_WIDTH below
// (POLISH_ROADMAP Phase P4: row-virtualized table, not a native <table>
// with content-driven column widths).
// `numeric` drives both the header's alignment (right, over its column's
// numbers -- DESIGN_LANGUAGE.md section 6) and which cells get the `.num`
// tabular/right-aligned treatment below (DESIGN_AUDIT.md T1/T2).
const COLUMNS: { key: SortColumn; label: string; width: number; numeric?: boolean }[] = [
  { key: 'entry_time', label: 'Entry time', width: 150 },
  { key: 'leg', label: 'Leg', width: 110 },
  { key: 'session', label: 'Session', width: 90 },
  { key: 'side', label: 'Side', width: 64 },
  { key: 'size_contracts', label: 'Size', width: 56, numeric: true },
  { key: 'entry_price', label: 'Entry', width: 84, numeric: true },
  { key: 'exit_price', label: 'Exit', width: 84, numeric: true },
  { key: 'exit_type', label: 'Exit type', width: 84 },
  { key: 'pnl_usd', label: 'PnL', width: 84, numeric: true },
  { key: 'r_multiple', label: 'R', width: 64, numeric: true },
  { key: 'mae_points', label: 'MAE', width: 64, numeric: true },
  { key: 'mfe_points', label: 'MFE', width: 64, numeric: true },
]

// FXR_SPEC.md phase F6: a manual run's trades have no strategy "leg", so that
// column becomes the journal's setup name, and grade + tags are added -- the
// same table, the journal's own dimensions.
const MANUAL_COLUMNS: typeof COLUMNS = [
  ...COLUMNS.slice(0, 1),
  { key: 'setup_name', label: 'Setup', width: 128 },
  ...COLUMNS.slice(2),
  { key: 'grade', label: 'Grade', width: 56 },
  { key: 'tags', label: 'Tags', width: 160 },
]
const GRADE_OPTIONS = ['A', 'B', 'C'] as const
const ROW_HEIGHT = 28


function sortValue(t: TradeRecord, col: SortColumn): string | number | null {
  if (col === 'tags') return t.tags && t.tags.length > 0 ? t.tags.join(', ') : null
  return t[col] ?? null
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
  const setTradeNavFocused = useTradeStore((s) => s.setTradeNavFocused)
  const selectTradeView = useChartViewStore((s) => s.selectTradeView)
  const openJournalTrade = useUiStore((s) => s.openJournalTrade)

  const { data: run } = useRun(runId)
  const manual = run?.source === 'manual'
  const columns = manual ? MANUAL_COLUMNS : COLUMNS
  const gridTemplate = columns.map((c) => `${c.width}px`).join(' ')
  const gridTotalWidth = columns.reduce((sum, c) => sum + c.width, 0)

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
  // Journal dimensions (manual runs) + time of day (any run).
  const tagOptions = useMemo(() => [...new Set((allTrades ?? []).flatMap((t) => t.tags ?? []))].sort(), [allTrades])
  const setupOptions = useMemo(
    () => [...new Set((allTrades ?? []).map((t) => t.setup_name).filter((v): v is string => !!v))].sort(),
    [allTrades],
  )
  const backtestSessionOptions = useMemo(
    () => [...new Set((allTrades ?? []).map((t) => t.session_id).filter((v): v is string => !!v))].sort(),
    [allTrades],
  )
  const hourOptions = useMemo(
    () => [...new Set((allTrades ?? []).map((t) => nyHourOfDay(t.entry_time)))].sort((a, b) => a - b),
    [allTrades],
  )
  const selectedManualTrade = manual ? ((allTrades ?? []).find((t) => t.trade_id === selectedTradeId) ?? null) : null

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
    setTradeNavFocused(true)
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
  // Only the very first load swaps the whole panel for a skeleton. A filter
  // change also makes rawTrades undefined for a moment (new query key); the
  // toolbar must survive that, or its Filters popover is unmounted -- and so
  // closed -- the instant you pick a value. The list area shows the skeleton.
  if (rawTrades === undefined && allTrades === undefined) {
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
      {/* One row (DESIGN_LANGUAGE.md section 1/5): the form lives in a popover,
          what is applied is always visible as chips, and the count + journal
          link sit at the right. */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs">
        <FiltersPopover count={activeFilterChips(filters).length}>
          {manual ? (
            <>
              <FilterField label="Tag">
                <select
                  value={filters.tag ?? ''}
                  onChange={(e) => setFilter('tag', e.target.value || null)}
                  aria-label="Filter by tag"
                  className={FILTER_SELECT}
                >
                  <option value="">All</option>
                  {tagOptions.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </FilterField>
              <FilterField label="Setup">
                <select
                  value={filters.setup ?? ''}
                  onChange={(e) => setFilter('setup', e.target.value || null)}
                  aria-label="Filter by setup"
                  className={FILTER_SELECT}
                >
                  <option value="">All</option>
                  {setupOptions.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </FilterField>
              <FilterField label="Grade">
                <select
                  value={filters.grade ?? ''}
                  onChange={(e) => setFilter('grade', e.target.value || null)}
                  aria-label="Filter by grade"
                  className={FILTER_SELECT}
                >
                  <option value="">All</option>
                  {GRADE_OPTIONS.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </FilterField>
              {backtestSessionOptions.length > 1 && (
                <FilterField label="Backtest session">
                  <select
                    value={filters.sessionId ?? ''}
                    onChange={(e) => setFilter('sessionId', e.target.value || null)}
                    aria-label="Filter by backtest session"
                    className={FILTER_SELECT}
                  >
                    <option value="">All</option>
                    {backtestSessionOptions.map((v) => (
                      <option key={v} value={v}>
                        {v.slice(0, 13)}
                      </option>
                    ))}
                  </select>
                </FilterField>
              )}
            </>
          ) : (
            <FilterField label="Leg">
              <select
                value={filters.leg ?? ''}
                onChange={(e) => setFilter('leg', e.target.value || null)}
                aria-label="Filter by leg"
                className={FILTER_SELECT}
              >
                <option value="">All</option>
                {legOptions.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </FilterField>
          )}
          <FilterField label="Session">
            <select
              value={filters.session ?? ''}
              onChange={(e) => setFilter('session', e.target.value || null)}
              aria-label="Filter by session"
              className={FILTER_SELECT}
            >
              <option value="">All</option>
              {sessionOptions.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </FilterField>
          <FilterField label="Side">
            <select
              value={filters.side ?? ''}
              onChange={(e) => setFilter('side', e.target.value || null)}
              aria-label="Filter by side"
              className={FILTER_SELECT}
            >
              <option value="">All</option>
              {SIDE_OPTIONS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </FilterField>
          <FilterField label="Result">
            <select
              value={filters.result ?? ''}
              onChange={(e) => setFilter('result', (e.target.value || null) as ResultFilter)}
              aria-label="Filter by result"
              className={FILTER_SELECT}
            >
              <option value="">All</option>
              <option value="win">Win</option>
              <option value="loss">Loss</option>
            </select>
          </FilterField>
          <FilterField label="Exit">
            <select
              value={filters.exitType ?? ''}
              onChange={(e) => setFilter('exitType', e.target.value || null)}
              aria-label="Filter by exit type"
              className={FILTER_SELECT}
            >
              <option value="">All</option>
              {EXIT_TYPE_OPTIONS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </FilterField>
          <FilterField label="Hour">
            <select
              value={filters.entryHourNy === null ? '' : String(filters.entryHourNy)}
              onChange={(e) => setFilter('entryHourNy', e.target.value === '' ? null : Number(e.target.value))}
              aria-label="Filter by entry hour (ET)"
              className={FILTER_SELECT}
            >
              <option value="">All</option>
              {hourOptions.map((h) => (
                <option key={h} value={h}>
                  {String(h).padStart(2, '0')}:00 ET
                </option>
              ))}
            </select>
          </FilterField>
          <FilterField label="From">
            <input
              id="trade-list-date-from"
              type="date"
              value={filters.dateFrom ?? ''}
              onChange={(e) => setFilter('dateFrom', e.target.value || null)}
              className={FILTER_SELECT}
            />
          </FilterField>
          <FilterField label="To">
            <input
              id="trade-list-date-to"
              type="date"
              value={filters.dateTo ?? ''}
              onChange={(e) => setFilter('dateTo', e.target.value || null)}
              className={FILTER_SELECT}
            />
          </FilterField>
        </FiltersPopover>
        <FilterChips />
        <span className="ml-auto flex-none whitespace-nowrap tabular-nums text-text-muted">{sorted.length} trades</span>
        {selectedManualTrade?.session_id && selectedManualTrade.session_trade_id != null && (
          <button
            onClick={() => openJournalTrade(selectedManualTrade.session_id!, selectedManualTrade.session_trade_id!)}
            className="h-7 flex-none whitespace-nowrap rounded px-2 text-text-muted hover:bg-surface-2 hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            title="Open this trade's notes, tags and screenshots in its session's journal"
          >
            Open in journal
          </button>
        )}
      </div>

      <div ref={parentRef} className="min-h-0 flex-1 overflow-auto">
        <div
          className="sticky top-0 z-10 grid border-b border-border bg-bg"
          style={{ gridTemplateColumns: gridTemplate, minWidth: gridTotalWidth }}
        >
          {columns.map((c) => {
            const active = sortCol === c.key
            return (
              <div
                key={c.key}
                onClick={() => toggleSort(c.key)}
                className={`group micro-label cursor-pointer select-none whitespace-nowrap px-2 py-1 hover:text-text ${
                  c.numeric ? 'text-right' : 'text-left'
                }`}
              >
                {c.label}
                {/* Sort affordance (DESIGN_LANGUAGE.md section 6: "sortable
                    affordance appears on hover") -- the active column's own
                    direction arrow is always visible; every other column
                    shows a neutral hint only on hover, at reduced opacity so
                    it reads as a hint, not a second active indicator. */}
                <span className={active ? 'ml-1' : 'ml-1 opacity-0 group-hover:opacity-50'}>
                  {active ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}
                </span>
              </div>
            )
          })}
        </div>

        {rawTrades === undefined ? (
          <div className="flex flex-col gap-2 p-3">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-[26px]" />
            ))}
          </div>
        ) : sorted.length === 0 ? (
          <EmptyState
            title="No trades match the current filters."
            hint={hasFilters ? undefined : 'This run has no trades.'}
          >
            {hasFilters && (
              <button onClick={clearFilters} className="h-7 rounded bg-surface-2 px-2 text-text hover:bg-surface-2-hover">
                Clear filters
              </button>
            )}
          </EmptyState>
        ) : (
          <div
            style={{ height: rowVirtualizer.getTotalSize(), minWidth: gridTotalWidth, position: 'relative' }}
          >
            {rowVirtualizer.getVirtualItems().map((vRow) => {
              const t = sorted[vRow.index]
              const selected = selectedTradeId === t.trade_id
              return (
                <div
                  key={t.trade_id}
                  onClick={() => onSelect(t.trade_id)}
                  // Keyboard-focusable + Enter/Space-activatable (DESIGN_LANGUAGE.md
                  // section 6: every interactive element needs a complete
                  // state set, focus included) -- a plain onClick div was
                  // otherwise unreachable by keyboard, so it could never
                  // show a focus-visible ring at all. Same onSelect the
                  // click already calls, so the chart cross-link is
                  // identical either way.
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      onSelect(t.trade_id)
                    }
                  }}
                  aria-selected={selected}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    height: vRow.size,
                    transform: `translateY(${vRow.start}px)`,
                    gridTemplateColumns: gridTemplate,
                  }}
                  // No row border (DESIGN_LANGUAGE.md section 6: "zebra-free
                  // (use hover)... hover is a subtle background step, not a
                  // border") -- rows are told apart by row height + hover/
                  // selected background only.
                  className={`grid cursor-pointer items-center text-xs hover:bg-surface ${
                    selected ? 'bg-surface-2' : ''
                  }`}
                >
                  <div className="truncate whitespace-nowrap px-2 tabular-nums text-text">
                    {fmtEtDateTime(t.entry_time)}
                  </div>
                  {manual ? (
                    <div className="truncate px-2 text-text">{t.setup_name ?? '-'}</div>
                  ) : (
                    <div className="truncate px-2 text-text">{t.leg ?? '-'}</div>
                  )}
                  <div className="truncate px-2 text-text">{t.session ?? '-'}</div>
                  <div className="truncate px-2 text-text">{t.side}</div>
                  <div className="num truncate px-2 text-text">{t.size_contracts}</div>
                  <div className="num truncate px-2 text-text">{fmtPrice(t.entry_price, t.instrument)}</div>
                  <div className="num truncate px-2 text-text">{fmtPrice(t.exit_price, t.instrument)}</div>
                  <div className="truncate px-2 text-text">{t.exit_type}</div>
                  <div className={`num truncate px-2 ${t.pnl_usd >= 0 ? 'text-positive-fg' : 'text-negative-fg'}`}>
                    {fmtUsd(t.pnl_usd)}
                  </div>
                  <div className="num truncate px-2 text-text">
                    {t.r_multiple !== null ? t.r_multiple.toFixed(2) : '-'}
                  </div>
                  <div className="num truncate px-2 text-text">{fmtPoints(t.mae_points)}</div>
                  <div className="num truncate px-2 text-text">{fmtPoints(t.mfe_points)}</div>
                  {manual && (
                    <>
                      <div className="truncate px-2 text-text">{t.grade ?? '-'}</div>
                      <div className="truncate px-2 text-text-muted">{t.tags && t.tags.length > 0 ? t.tags.join(', ') : '-'}</div>
                    </>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
