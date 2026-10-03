// FXR_SPEC.md phase F3's "New Trade" ticket -- shown INSTEAD of
// PositionTicket while a ticket is armed (drag the 3 ghost lines on the
// chart; see ChartKL.tsx's tradeTicket prop for the actual drag). This
// panel is the live readout: side (derived from where TP sits relative to
// entry, not chosen up front), R:R, $ risk, auto-sized contracts, and
// Confirm/Cancel -- everything here stays neutral per DESIGN_LANGUAGE.md;
// only the position ticket's Buy/Sell carry the trading-action color
// exception.
import { fmtUsd } from '../format'

export interface TicketReadout {
  side: 'long' | 'short'
  entryPrice: number
  slPrice: number
  tpPrice: number
  rr: number | null
  contracts: number
  dollarRisk: number | null
}

export default function TradeTicketPanel({
  ticket,
  onConfirm,
  onCancel,
}: {
  ticket: TicketReadout
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-border px-6 py-2 text-xs">
      <button onClick={onConfirm} className="rounded bg-accent px-3 py-1 text-on-accent hover:opacity-90">
        Confirm
      </button>
      <button onClick={onCancel} className="rounded bg-surface-2 px-3 py-1 text-text hover:bg-surface-2-hover">
        Cancel
      </button>

      <div className="h-4 w-px bg-surface-2" />

      <span className="text-text-muted">
        New trade: <span className="text-text">{ticket.side}</span>{' '}
        <span className="tabular-nums text-text">{ticket.contracts}</span>
      </span>
      <span className="tabular-nums text-text-muted">
        Entry <span className="text-text">{ticket.entryPrice.toFixed(2)}</span>
      </span>
      <span className="tabular-nums text-text-muted">
        SL <span className="text-warning">{ticket.slPrice.toFixed(2)}</span>
      </span>
      <span className="tabular-nums text-text-muted">
        TP <span className="text-positive-fg">{ticket.tpPrice.toFixed(2)}</span>
      </span>
      <span className="tabular-nums text-text-muted">{ticket.rr !== null ? `${ticket.rr.toFixed(2)}R:R` : '—'}</span>
      <span className="tabular-nums text-text-muted">
        Risk: <span className="text-text">{ticket.dollarRisk !== null ? fmtUsd(ticket.dollarRisk) : '—'}</span>
      </span>
    </div>
  )
}
