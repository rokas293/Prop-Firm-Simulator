// FXR_V2_SPEC.md section 2 (G1): the slide-up trade panel -- tabs Positions |
// Orders | History. Rows render what the sim broker holds (the open position,
// the working order) and the journaled trades; nothing is recomputed here.
// Text tabs with an underline (DESIGN_LANGUAGE.md section 6), one 28px row
// height, tabular right-aligned numbers, hover as a background step.
import { useState } from 'react'
import type { ManualTrade } from '../api/types'
import { fmtPrice, fmtR, fmtUsd } from '../format'
import { partialCloseRefusal } from '../chart/orderEntry'
import { fmtEtDateTime } from '../timeFormat'
import type { TradePanelTab } from '../state/sessionPrefsStore'

export interface PositionRow {
  instrument: string
  side: 'long' | 'short'
  contracts: number
  entryPrice: number
  slPrice: number | null
  tpPrice: number | null
  pnlUsd: number
  rMultiple: number | null
}

export interface WorkingOrderRow {
  instrument: string
  side: 'long' | 'short'
  orderType: 'limit' | 'stop'
  price: number
  contracts: number
  slPrice: number | null
  tpPrice: number | null
}

export const HISTORY_PAGE_SIZE = 10

// One page of the history list, newest first, plus the page count (>= 1).
export function historyPage<T>(items: readonly T[], page: number, pageSize = HISTORY_PAGE_SIZE) {
  const pages = Math.max(1, Math.ceil(items.length / pageSize))
  const clamped = Math.max(0, Math.min(pages - 1, page))
  const newestFirst = [...items].reverse()
  return { rows: newestFirst.slice(clamped * pageSize, (clamped + 1) * pageSize), page: clamped, pages }
}

const TH = 'micro-label h-7 px-2 text-left font-medium'
const THN = 'micro-label h-7 px-2 text-right font-medium'
const TD = 'h-7 px-2 text-xs text-text'
const TDN = 'num h-7 px-2 text-xs text-text'
const ROW_ACTION =
  'h-7 rounded px-2 text-xs text-text-muted transition-colors hover:bg-surface-2-hover hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-text-muted'

function sign(v: number): string {
  return v > 0 ? 'text-positive-fg' : v < 0 ? 'text-negative-fg' : 'text-text'
}

function Empty({ children }: { children: string }) {
  return <p className="px-2 py-6 text-xs text-text-muted">{children}</p>
}

// FXR_V2_SPEC.md 3.6: close ANY whole quantity of the open position, with the
// refusal reason inline (the same rule the workspace re-checks). Defaults to
// half; re-defaults whenever the open size changes.
function PartialClose({ contracts, disabled, onPartialClose }: { contracts: number; disabled: boolean; onPartialClose: (qty: number) => void }) {
  const half = String(Math.max(1, Math.round(contracts / 2)))
  const [draft, setDraft] = useState(half)
  const [lastContracts, setLastContracts] = useState(contracts)
  if (lastContracts !== contracts) {
    setLastContracts(contracts)
    setDraft(half)
  }
  const qty = Number(draft)
  const refusal = partialCloseRefusal(qty, contracts)
  return (
    <span className="inline-flex items-center gap-1">
      <input
        type="number"
        min={1}
        max={Math.max(1, contracts - 1)}
        step={1}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        aria-label="Partial close quantity (contracts)"
        title={refusal ?? `Contracts to close at market (1 to ${contracts - 1})`}
        disabled={contracts < 2}
        className="propbt-input w-14 text-right"
      />
      <button
        type="button"
        onClick={() => onPartialClose(qty)}
        disabled={disabled || contracts < 2 || refusal !== null}
        title={refusal ?? `Close ${qty} of ${contracts} contracts at market`}
        className={ROW_ACTION}
      >
        Close partial
      </button>
    </span>
  )
}

function PositionsTab({
  positions,
  activeInstrument,
  closing,
  onClose,
  onPartialClose,
  onBreakeven,
  autoBreakeven,
  onAutoBreakevenChange,
  trailingPoints,
  onTrailingPointsChange,
}: {
  positions: PositionRow[]
  // The charted instrument: the toggles below arm / edit ITS trade.
  activeInstrument: string
  closing: boolean
  onClose: (instrument: string) => void
  onPartialClose: (instrument: string, qty: number) => void
  onBreakeven: (instrument: string) => void
  autoBreakeven: boolean
  onAutoBreakevenChange: (v: boolean) => void
  trailingPoints: number | null
  onTrailingPointsChange: (v: number | null) => void
}) {
  return (
    <div className="flex flex-col gap-2">
      {/* Dual-purpose, as v1's toggles were: flat, they arm the NEXT trade;
          with a position open they edit that position directly. */}
      <div className="flex items-center gap-4 px-2 pt-1 text-xs text-text-muted">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={autoBreakeven} onChange={(e) => onAutoBreakevenChange(e.target.checked)} className="accent-accent" />
          {positions.some((p) => p.instrument === activeInstrument) ? `${activeInstrument} break-even at +1R` : `Next ${activeInstrument} trade: break-even at +1R`}
        </label>
        <label className="flex items-center gap-2">
          {activeInstrument} trail
          <input
            type="number"
            min={0}
            step={0.25}
            value={trailingPoints ?? ''}
            onChange={(e) => {
              const v = e.target.value === '' ? null : Number(e.target.value)
              onTrailingPointsChange(v !== null && v > 0 ? v : null)
            }}
            placeholder="off"
            aria-label="Trailing stop distance in points"
            className="propbt-input w-16"
          />
          pts
        </label>
      </div>
      {positions.length > 0 ? (
        // table-fixed + a <colgroup>: the columns keep their widths whatever the
        // numbers do (an SL appearing, a P&L gaining a digit), so nothing reflows.
        <table className="w-full table-fixed border-collapse">
          <colgroup>
            <col className="w-20" />
            <col className="w-16" />
            <col className="w-16" />
            <col className="w-28" />
            <col className="w-28" />
            <col className="w-28" />
            <col className="w-28" />
            <col className="w-24" />
            <col />
          </colgroup>
          <thead>
            <tr>
              <th className={TH}>Symbol</th>
              <th className={TH}>Side</th>
              <th className={THN}>Qty</th>
              <th className={THN}>Avg entry</th>
              <th className={THN}>SL</th>
              <th className={THN}>TP</th>
              <th className={THN}>P&amp;L</th>
              <th className={THN}>R</th>
              <th className="h-7 px-2" />
            </tr>
          </thead>
          <tbody>
            {positions.map((position) => (
            <tr key={position.instrument} className="hover:bg-surface-2">
              <td className={`${TD} ${position.instrument === activeInstrument ? '' : 'text-text-muted'}`}>{position.instrument}</td>
              <td className={TD}>{position.side === 'long' ? 'Long' : 'Short'}</td>
              <td className={TDN}>{position.contracts}</td>
              <td className={TDN}>{fmtPrice(position.entryPrice, position.instrument)}</td>
              <td className={TDN}>{position.slPrice !== null ? fmtPrice(position.slPrice, position.instrument) : '—'}</td>
              <td className={TDN}>{position.tpPrice !== null ? fmtPrice(position.tpPrice, position.instrument) : '—'}</td>
              <td className={`num h-7 px-2 text-xs ${sign(position.pnlUsd)}`}>{fmtUsd(position.pnlUsd)}</td>
              <td className={`num h-7 px-2 text-xs ${position.rMultiple !== null ? sign(position.rMultiple) : 'text-text-muted'}`}>
                {position.rMultiple !== null ? `${position.rMultiple > 0 ? '+' : ''}${fmtR(position.rMultiple)}` : '—'}
              </td>
              <td className="h-7 whitespace-nowrap px-2 text-right">
                <PartialClose contracts={position.contracts} disabled={closing} onPartialClose={(qty) => onPartialClose(position.instrument, qty)} />
                <button
                  type="button"
                  onClick={() => onBreakeven(position.instrument)}
                  disabled={closing}
                  title="Move the stop loss to the entry price (needs the trade in profit)"
                  className={ROW_ACTION}
                >
                  Break-even
                </button>
                <button type="button" onClick={() => onClose(position.instrument)} disabled={closing} className={ROW_ACTION}>
                  {closing ? 'Closing…' : 'Close'}
                </button>
              </td>
            </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>Flat. No open position.</Empty>
      )}
    </div>
  )
}

function OrdersTab({ orders, onCancel }: { orders: WorkingOrderRow[]; onCancel: (instrument: string) => void }) {
  if (orders.length === 0) return <Empty>No working orders.</Empty>
  return (
    <table className="w-full border-collapse">
      <thead>
        <tr>
          <th className={TH}>Symbol</th>
          <th className={TH}>Side</th>
          <th className={TH}>Type</th>
          <th className={THN}>Qty</th>
          <th className={THN}>Price</th>
          <th className={THN}>SL</th>
          <th className={THN}>TP</th>
          <th className="h-7 px-2" />
        </tr>
      </thead>
      <tbody>
        {orders.map((order, i) => (
          <tr key={`${order.instrument}-${i}`} className="hover:bg-surface-2">
            <td className={TD}>{order.instrument}</td>
            <td className={TD}>{order.side === 'long' ? 'Buy' : 'Sell'}</td>
            <td className={TD}>{order.orderType === 'limit' ? 'Limit' : 'Stop'}</td>
            <td className={TDN}>{order.contracts}</td>
            <td className={TDN}>{fmtPrice(order.price, order.instrument)}</td>
            <td className={TDN}>{order.slPrice !== null ? fmtPrice(order.slPrice, order.instrument) : '—'}</td>
            <td className={TDN}>{order.tpPrice !== null ? fmtPrice(order.tpPrice, order.instrument) : '—'}</td>
            <td className="h-7 px-2 text-right">
              <button type="button" onClick={() => onCancel(order.instrument)} className={ROW_ACTION}>
                Cancel
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function HistoryTab({ trades, onOpenTrade }: { trades: readonly ManualTrade[]; onOpenTrade: (tradeId: number) => void }) {
  const [page, setPage] = useState(0)
  if (trades.length === 0) return <Empty>No closed trades yet.</Empty>
  const { rows, page: current, pages } = historyPage(trades, page)
  return (
    <div className="flex flex-col">
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <th className={THN}>#</th>
            <th className={TH}>Closed (ET)</th>
            <th className={TH}>Symbol</th>
            <th className={TH}>Side</th>
            <th className={THN}>Qty</th>
            <th className={THN}>Entry</th>
            <th className={THN}>Exit</th>
            <th className={THN}>Exits</th>
            <th className={THN}>P&amp;L</th>
            <th className={THN}>R</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr
              key={t.trade_id}
              tabIndex={0}
              onClick={() => onOpenTrade(t.trade_id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onOpenTrade(t.trade_id)
                }
              }}
              title="Open in the journal"
              className="cursor-pointer hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              <td className={`${TDN} text-text-muted`}>{t.trade_id}</td>
              <td className={`${TD} tabular-nums text-text-muted`}>{fmtEtDateTime(t.exit_time)}</td>
              <td className={TD}>{t.instrument}</td>
              <td className={TD}>{t.side === 'long' ? 'Long' : 'Short'}</td>
              <td className={TDN}>{t.size_contracts}</td>
              <td className={TDN}>{fmtPrice(t.entry_price, t.instrument)}</td>
              <td className={TDN} title={t.exits && t.exits.length > 1 ? 'Contract-weighted average of the exits' : undefined}>
                {fmtPrice(t.exit_price, t.instrument)}
              </td>
              <td className={`${TDN} text-text-muted`}>{t.exits && t.exits.length > 0 ? t.exits.length : 1}</td>
              <td className={`num h-7 px-2 text-xs ${sign(t.pnl_usd)}`}>{fmtUsd(t.pnl_usd)}</td>
              <td className={`num h-7 px-2 text-xs ${t.r_multiple !== null ? sign(t.r_multiple) : 'text-text-muted'}`}>
                {t.r_multiple !== null ? `${t.r_multiple > 0 ? '+' : ''}${fmtR(t.r_multiple)}` : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {pages > 1 && (
        <div className="flex items-center justify-end gap-2 px-2 py-2 text-xs text-text-muted">
          <button type="button" className={ROW_ACTION} disabled={current === 0} onClick={() => setPage(current - 1)}>
            Previous
          </button>
          <span className="tabular-nums">
            {current + 1} / {pages}
          </span>
          <button type="button" className={ROW_ACTION} disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>
            Next
          </button>
        </div>
      )}
    </div>
  )
}

const TABS: { id: TradePanelTab; label: string }[] = [
  { id: 'positions', label: 'Positions' },
  { id: 'orders', label: 'Orders' },
  { id: 'history', label: 'History' },
]

export default function TradePanel({
  height,
  tab,
  onTabChange,
  positions,
  workingOrders,
  activeInstrument,
  trades,
  closing,
  onClosePosition,
  onPartialClose,
  onBreakeven,
  onCancelOrder,
  autoBreakeven,
  onAutoBreakevenChange,
  trailingPoints,
  onTrailingPointsChange,
  onOpenTrade,
}: {
  height: number
  tab: TradePanelTab
  onTabChange: (t: TradePanelTab) => void
  // One row per instrument holding something (G7: positions and orders in both
  // MNQ and MES, whichever is on the chart). Row actions name the instrument.
  positions: PositionRow[]
  workingOrders: WorkingOrderRow[]
  activeInstrument: string
  trades: readonly ManualTrade[]
  closing: boolean
  onClosePosition: (instrument: string) => void
  onPartialClose: (instrument: string, qty: number) => void
  onBreakeven: (instrument: string) => void
  onCancelOrder: (instrument: string) => void
  autoBreakeven: boolean
  onAutoBreakevenChange: (v: boolean) => void
  trailingPoints: number | null
  onTrailingPointsChange: (v: number | null) => void
  onOpenTrade: (tradeId: number) => void
}) {
  const counts: Record<TradePanelTab, number> = {
    positions: positions.length,
    orders: workingOrders.length,
    history: trades.length,
  }
  return (
    <section style={{ height }} className="propbt-fade-in flex shrink-0 flex-col overflow-hidden bg-surface" aria-label="Trade panel">
      <div role="tablist" aria-label="Trade panel" className="flex h-8 shrink-0 items-center gap-4 px-4">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`trade-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls="trade-panel-body"
            onClick={() => onTabChange(t.id)}
            className={`h-8 border-b-2 text-xs transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
              tab === t.id ? 'border-accent text-text' : 'border-transparent text-text-muted hover:text-text'
            }`}
          >
            {t.label}
            <span className="ml-1 tabular-nums text-text-muted">{counts[t.id]}</span>
          </button>
        ))}
      </div>
      <div id="trade-panel-body" role="tabpanel" aria-labelledby={`trade-tab-${tab}`} className="min-h-0 flex-1 overflow-auto px-2 pb-2">
        {tab === 'positions' && (
          <PositionsTab
            positions={positions}
            activeInstrument={activeInstrument}
            closing={closing}
            onClose={onClosePosition}
            onPartialClose={onPartialClose}
            onBreakeven={onBreakeven}
            autoBreakeven={autoBreakeven}
            onAutoBreakevenChange={onAutoBreakevenChange}
            trailingPoints={trailingPoints}
            onTrailingPointsChange={onTrailingPointsChange}
          />
        )}
        {tab === 'orders' && <OrdersTab orders={workingOrders} onCancel={onCancelOrder} />}
        {tab === 'history' && <HistoryTab trades={trades} onOpenTrade={onOpenTrade} />}
      </div>
    </section>
  )
}
