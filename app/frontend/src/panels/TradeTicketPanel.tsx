// FXR_SPEC.md phase F3's "New Trade" ticket -- floats over the chart (G1)
// while a ticket is armed (drag the 3 ghost lines on the
// chart; see ChartKL.tsx's tradeTicket prop for the actual drag). This
// panel is the live readout: side (derived from where TP sits relative to
// entry, not chosen up front), R:R, $ risk, auto-sized contracts, and
// Confirm/Cancel -- everything here stays neutral per DESIGN_LANGUAGE.md;
// only the bottom bar's Buy/Sell carry the trading-action color
// exception.
import { fmtPrice, fmtUsd } from '../format'

export interface TicketReadout {
  instrument: string
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
    <div className="flex flex-wrap items-center gap-3 rounded bg-surface px-3 py-2 text-xs shadow-lg" role="status" aria-label="New trade">
      <button onClick={onConfirm} className="h-7 rounded bg-accent px-3 text-on-accent transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
        Confirm
      </button>
      <button onClick={onCancel} className="h-7 rounded px-3 text-text-muted transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
        Cancel
      </button>

      <div className="h-4 w-px bg-border" />

      <span className="text-text-muted">
        New trade: <span className="text-text">{ticket.side === 'long' ? 'Long' : 'Short'}</span>{' '}
        <span className="tabular-nums text-text">{ticket.contracts}</span>
      </span>
      <span className="tabular-nums text-text-muted">
        Entry <span className="text-text">{fmtPrice(ticket.entryPrice, ticket.instrument)}</span>
      </span>
      <span className="tabular-nums text-text-muted">
        SL <span className="text-text">{fmtPrice(ticket.slPrice, ticket.instrument)}</span>
      </span>
      <span className="tabular-nums text-text-muted">
        TP <span className="text-text">{fmtPrice(ticket.tpPrice, ticket.instrument)}</span>
      </span>
      <span className="tabular-nums text-text-muted">{ticket.rr !== null ? `1:${ticket.rr.toFixed(2)}` : '—'}</span>
      <span className="tabular-nums text-text-muted">
        Risk: <span className="text-text">{ticket.dollarRisk !== null ? fmtUsd(ticket.dollarRisk) : '—'}</span>
      </span>
    </div>
  )
}
