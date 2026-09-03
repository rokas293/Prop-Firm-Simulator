// FXR_SPEC.md phase F2: the sim broker's compact position panel -- one-click
// Buy/Sell/Close plus the live open PnL/R readout. Buy/Sell/Close are kept
// in the app's ordinary neutral button style (not colored green/red) per
// DESIGN_LANGUAGE.md section 2: color is reserved for DATA (the PnL figure
// itself, which IS colored below), not for actions -- a deliberate reading
// of the spec even though colored buy/sell buttons are the trading-app norm.
import { fmtUsd } from '../format'

export interface PositionSummary {
  instrument: string
  side: 'long' | 'short'
  contracts: number
  entryPrice: number
  pnlUsd: number
  rMultiple: number | null
}

interface PositionTicketProps {
  disabled: boolean
  position: PositionSummary | null
  onBuy: () => void
  onSell: () => void
  onClose: () => void
  closing: boolean
}

export default function PositionTicket({ disabled, position, onBuy, onSell, onClose, closing }: PositionTicketProps) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-border px-6 py-2 text-xs">
      <button
        onClick={onBuy}
        disabled={disabled || position !== null}
        className="rounded bg-surface-2 px-3 py-1 text-text hover:bg-surface-2-hover disabled:opacity-40"
      >
        Buy
      </button>
      <button
        onClick={onSell}
        disabled={disabled || position !== null}
        className="rounded bg-surface-2 px-3 py-1 text-text hover:bg-surface-2-hover disabled:opacity-40"
      >
        Sell
      </button>
      <button
        onClick={onClose}
        disabled={disabled || position === null || closing}
        className="rounded bg-surface-2 px-3 py-1 text-text hover:bg-surface-2-hover disabled:opacity-40"
      >
        {closing ? 'Closing…' : 'Close'}
      </button>

      <div className="h-4 w-px bg-surface-2" />

      {position ? (
        <>
          <span className="text-text-muted">
            {position.instrument} <span className="text-text">{position.side}</span> {position.contracts} @{' '}
            <span className="tabular-nums text-text">{position.entryPrice.toFixed(2)}</span>
          </span>
          <span>
            PnL:{' '}
            <span className={`tabular-nums ${position.pnlUsd >= 0 ? 'text-positive' : 'text-negative'}`}>
              {fmtUsd(position.pnlUsd)}
            </span>
          </span>
          <span className="tabular-nums text-text-muted">
            {position.rMultiple !== null ? `${position.rMultiple >= 0 ? '+' : ''}${position.rMultiple.toFixed(2)}R` : '—'}
          </span>
        </>
      ) : (
        <span className="text-text-muted">Flat — no open position</span>
      )}
    </div>
  )
}
