// FXR_V2_SPEC.md section 6 (G8): the Analytics page's trades table -- paginated, with
// a rows-per-page setting and filters by tag, setup, grade, side, time of day and
// instrument. A row opens that trade in its session's journal. The rows are the
// server's trade list for the page's scope; this only narrows and pages it.
import BotChip from '../components/BotChip'
import { useEffect, useMemo, useState } from 'react'
import type { TradeRecord } from '../api/types'
import { fmtPrice, fmtR, fmtUsd } from '../format'
import { fmtEtLongDate, fmtEtTime } from '../timeFormat'
import {
  DEFAULT_ROWS_PER_PAGE,
  NO_FILTERS,
  ROWS_PER_PAGE_OPTIONS,
  filterOptions,
  filterTrades,
  hourLabel,
  newestFirst,
  paginate,
  type TableFilters,
} from './tradeTable'

const GHOST_BUTTON =
  'h-7 rounded px-2 text-xs text-text-muted transition-colors hover:bg-surface-2 hover:text-text active:bg-surface-2-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-text-muted'

function FilterSelect({
  label,
  value,
  options,
  onChange,
  format = (v) => v,
}: {
  label: string
  value: string | null
  options: string[]
  onChange: (v: string | null) => void
  format?: (v: string) => string
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="micro-label">{label}</span>
      <select
        aria-label={label}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
        className="propbt-input min-w-24"
      >
        <option value="">All</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {format(o)}
          </option>
        ))}
      </select>
    </label>
  )
}

export default function AnalyticsTradesTable({
  trades,
  onOpenTrade,
  showInstrumentFilter = true,
}: {
  trades: TradeRecord[]
  onOpenTrade: (t: TradeRecord) => void
  showInstrumentFilter?: boolean
}) {
  const [filters, setFilters] = useState<TableFilters>(NO_FILTERS)
  const [perPage, setPerPage] = useState<number>(DEFAULT_ROWS_PER_PAGE)
  const [page, setPage] = useState(1)

  const options = useMemo(() => filterOptions(trades), [trades])
  const filtered = useMemo(() => newestFirst(filterTrades(trades, filters)), [trades, filters])
  const view = paginate(filtered, page, perPage)
  const active = Object.values(filters).some((v) => v !== null)

  // A filter, the page size or a new scope's trades puts you back on the first page.
  useEffect(() => setPage(1), [filters, perPage, trades])

  const set = <K extends keyof TableFilters>(key: K, value: TableFilters[K]) => setFilters((f) => ({ ...f, [key]: value }))

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3" role="group" aria-label="Trade filters">
        <FilterSelect label="Tag" value={filters.tag} options={options.tags} onChange={(v) => set('tag', v)} />
        <FilterSelect label="Setup" value={filters.setup} options={options.setups} onChange={(v) => set('setup', v)} />
        <FilterSelect label="Grade" value={filters.grade} options={options.grades} onChange={(v) => set('grade', v)} />
        <FilterSelect
          label="Side"
          value={filters.side}
          options={['long', 'short']}
          onChange={(v) => set('side', v as TableFilters['side'])}
          format={(v) => (v === 'long' ? 'Long' : 'Short')}
        />
        <FilterSelect
          label="Time of day (ET)"
          value={filters.hour === null ? null : String(filters.hour)}
          options={options.hours.map(String)}
          onChange={(v) => set('hour', v === null ? null : Number(v))}
          format={(v) => hourLabel(Number(v))}
        />
        {showInstrumentFilter && options.instruments.length > 1 && (
          <FilterSelect label="Instrument" value={filters.instrument} options={options.instruments} onChange={(v) => set('instrument', v)} />
        )}
        {active && (
          <button type="button" onClick={() => setFilters(NO_FILTERS)} className={GHOST_BUTTON}>
            Clear filters
          </button>
        )}
      </div>

      {filtered.length === 0 ? (
        <p className="py-8 text-center text-xs text-text-muted">
          {trades.length === 0 ? 'No trades in this scope yet.' : 'No trades match these filters.'}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-xs tabular-nums" aria-label="Trades">
            <thead>
              <tr className="h-7 text-right">
                <th className="micro-label pr-3 text-left font-medium">Entry (ET)</th>
                <th className="micro-label px-3 text-left font-medium">Symbol</th>
                <th className="micro-label px-3 text-left font-medium">Side</th>
                <th className="micro-label px-3 font-medium">Qty</th>
                <th className="micro-label px-3 font-medium">Entry</th>
                <th className="micro-label px-3 font-medium">Exit</th>
                <th className="micro-label px-3 font-medium">Net P&amp;L</th>
                <th className="micro-label px-3 font-medium">R</th>
                <th className="micro-label px-3 text-left font-medium">Setup</th>
                <th className="micro-label px-3 text-left font-medium">Grade</th>
                <th className="micro-label pl-3 text-left font-medium">Tags</th>
              </tr>
            </thead>
            <tbody>
              {view.rows.map((t) => (
                <tr
                  key={`${t.session_id}:${t.session_trade_id ?? t.trade_id}`}
                  onClick={() => onOpenTrade(t)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      onOpenTrade(t)
                    }
                  }}
                  tabIndex={0}
                  title="Open in the journal"
                  className="h-7 cursor-pointer text-right text-text transition-colors hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                >
                  <td className="pr-3 text-left">{fmtEtLongDate(t.entry_time)} {fmtEtTime(t.entry_time)} ET</td>
                  <td className="px-3 text-left">
                    {t.instrument}
                    {t.source === 'bot' && <BotChip interrupted={(t.bot_segment ?? 0) > 0} />}
                  </td>
                  <td className="px-3 text-left">{t.side === 'long' ? 'Long' : 'Short'}</td>
                  <td className="px-3">{t.size_contracts}</td>
                  <td className="px-3">{fmtPrice(t.entry_price, t.instrument)}</td>
                  <td className="px-3">{fmtPrice(t.exit_price, t.instrument)}</td>
                  <td className={`px-3 ${t.pnl_usd > 0 ? 'text-positive-fg' : t.pnl_usd < 0 ? 'text-negative-fg' : ''}`}>{fmtUsd(t.pnl_usd)}</td>
                  <td className="px-3">{fmtR(t.r_multiple)}</td>
                  <td className="max-w-40 truncate px-3 text-left text-text-muted">{t.setup_name ?? '-'}</td>
                  <td className="px-3 text-left text-text-muted">{t.grade ?? '-'}</td>
                  <td className="max-w-48 truncate pl-3 text-left text-text-muted">{(t.tags ?? []).join(', ') || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-text-muted">
        <label className="flex items-center gap-2">
          Rows per page
          <select aria-label="Rows per page" value={perPage} onChange={(e) => setPerPage(Number(e.target.value))} className="propbt-input">
            {ROWS_PER_PAGE_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-center gap-2">
          <span className="tabular-nums" aria-live="polite" data-testid="page-range">
            {view.total === 0 ? '0 trades' : `${view.from}–${view.to} of ${view.total}`}
          </span>
          <button type="button" onClick={() => setPage(view.page - 1)} disabled={view.page <= 1} className={GHOST_BUTTON} aria-label="Previous page">
            Previous
          </button>
          <span className="tabular-nums">
            Page {view.page} of {view.pageCount}
          </span>
          <button type="button" onClick={() => setPage(view.page + 1)} disabled={view.page >= view.pageCount} className={GHOST_BUTTON} aria-label="Next page">
            Next
          </button>
        </div>
      </div>
    </div>
  )
}
