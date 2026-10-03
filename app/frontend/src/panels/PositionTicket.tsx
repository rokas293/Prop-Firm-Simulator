// FXR_SPEC.md phases F2/F3: the sim broker's compact position panel --
// one-click Buy/Sell/Close, "New Trade" (arms the drag ticket, see
// TradeTicketPanel.tsx), a working (placed-but-unfilled) order's readout,
// and the live open PnL/R. Buy/Sell are the one documented exception to
// DESIGN_LANGUAGE.md section 2's "color is data, not actions" rule (see
// that file's own "Trading-action exception" bullet) -- muted green/red
// via the same low-opacity badge recipe already used for DashboardPanel's
// accent filter chip (`bg-{token}/15 text-{token}`), never a solid/neon
// fill. Close, New Trade, Cancel, and everything else here stays neutral.
import { fmtUsd } from '../format'

export interface PositionSummary {
  instrument: string
  side: 'long' | 'short'
  contracts: number
  entryPrice: number
  slPrice: number | null
  tpPrice: number | null
  pnlUsd: number
  rMultiple: number | null
}

export interface WorkingOrderSummary {
  instrument: string
  side: 'long' | 'short'
  orderType: 'limit' | 'stop'
  price: number
  contracts: number
  slPrice: number | null
  tpPrice: number | null
}

interface PositionTicketProps {
  disabled: boolean
  position: PositionSummary | null
  workingOrder: WorkingOrderSummary | null
  onBuy: () => void
  onSell: () => void
  onNewTrade: () => void
  onClose: () => void
  onCancelOrder: () => void
  closing: boolean
  // FXR_SPEC.md phase F4's optional toggles. Dual-purpose depending on
  // whether a position is open: FLAT, these arm the toggle for the NEXT
  // trade (Buy/Sell/ticket confirm); OPEN, they read/write the live
  // position's own fields directly (SessionWorkspace decides which one
  // these mean -- this panel just renders whatever it's handed). Same
  // pattern for partial close: only meaningful (and only enabled) once a
  // position with >=2 contracts is open.
  autoBreakeven: boolean
  onAutoBreakevenChange: (v: boolean) => void
  trailingPoints: number | null
  onTrailingPointsChange: (v: number | null) => void
  onPartialClose: () => void
  partialCloseDisabled: boolean
}

function slTp(slPrice: number | null, tpPrice: number | null): string {
  const parts: string[] = []
  if (slPrice !== null) parts.push(`SL ${slPrice.toFixed(2)}`)
  if (tpPrice !== null) parts.push(`TP ${tpPrice.toFixed(2)}`)
  return parts.join(' · ')
}

export default function PositionTicket({
  disabled,
  position,
  workingOrder,
  onBuy,
  onSell,
  onNewTrade,
  onClose,
  onCancelOrder,
  closing,
  autoBreakeven,
  onAutoBreakevenChange,
  trailingPoints,
  onTrailingPointsChange,
  onPartialClose,
  partialCloseDisabled,
}: PositionTicketProps) {
  const flat = !position && !workingOrder

  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-border px-6 py-2 text-xs">
      <button
        onClick={onBuy}
        disabled={disabled || !flat}
        className="rounded bg-positive/15 px-3 h-7 text-positive-fg hover:bg-positive/25 disabled:opacity-40"
      >
        Buy
      </button>
      <button
        onClick={onSell}
        disabled={disabled || !flat}
        className="rounded bg-negative/15 px-3 h-7 text-negative-fg hover:bg-negative/25 disabled:opacity-40"
      >
        Sell
      </button>
      <button
        onClick={onNewTrade}
        disabled={disabled || !flat}
        className="rounded bg-surface-2 px-3 h-7 text-text hover:bg-surface-2-hover disabled:opacity-40"
      >
        New Trade
      </button>
      <button
        onClick={onClose}
        disabled={disabled || position === null || closing}
        className="rounded bg-surface-2 px-3 h-7 text-text hover:bg-surface-2-hover disabled:opacity-40"
      >
        {closing ? 'Closing…' : 'Close'}
      </button>
      {position && (
        <button
          onClick={onPartialClose}
          disabled={disabled || partialCloseDisabled || closing}
          className="rounded bg-surface-2 px-3 h-7 text-text hover:bg-surface-2-hover disabled:opacity-40"
        >
          Close ½
        </button>
      )}
      {workingOrder && (
        <button onClick={onCancelOrder} className="rounded bg-surface-2 px-3 h-7 text-text hover:bg-surface-2-hover">
          Cancel order
        </button>
      )}

      <div className="h-4 w-px bg-surface-2" />

      {/* DESIGN_LANGUAGE.md section 4: every gap/padding here stays on the
          4px grid (gap-2/px-2/py-1), matching the buttons' own px-3 h-7 --
          so the input sits at the same height as the controls beside it. The
          number field follows section 6's "faint border only on focus":
          borderless at rest (it reads as part of the label), accent ring on
          focus-visible, same as every other input in the app. */}
      <label className="flex items-center gap-2 text-text-muted">
        <input
          type="checkbox"
          checked={autoBreakeven}
          onChange={(e) => onAutoBreakevenChange(e.target.checked)}
          className="accent-accent"
        />
        BE @+1R
      </label>
      <label className="flex items-center gap-2 text-text-muted">
        Trail
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
          className="propbt-input w-16"
        />
        pts
      </label>

      <div className="h-4 w-px bg-surface-2" />

      {position ? (
        <>
          <span className="text-text-muted">
            {position.instrument} <span className="text-text">{position.side}</span> {position.contracts} @{' '}
            <span className="tabular-nums text-text">{position.entryPrice.toFixed(2)}</span>
          </span>
          {(position.slPrice !== null || position.tpPrice !== null) && (
            <span className="tabular-nums text-text-muted">{slTp(position.slPrice, position.tpPrice)}</span>
          )}
          <span>
            PnL:{' '}
            <span className={`tabular-nums ${position.pnlUsd >= 0 ? 'text-positive-fg' : 'text-negative-fg'}`}>
              {fmtUsd(position.pnlUsd)}
            </span>
          </span>
          <span className="tabular-nums text-text-muted">
            {position.rMultiple !== null ? `${position.rMultiple >= 0 ? '+' : ''}${position.rMultiple.toFixed(2)}R` : '—'}
          </span>
        </>
      ) : workingOrder ? (
        <span className="text-text-muted">
          Working: <span className="text-text">{workingOrder.side}</span> {workingOrder.orderType}{' '}
          {workingOrder.contracts} {workingOrder.instrument} @{' '}
          <span className="tabular-nums text-text">{workingOrder.price.toFixed(2)}</span>
          {(workingOrder.slPrice !== null || workingOrder.tpPrice !== null) && (
            <> · <span className="tabular-nums">{slTp(workingOrder.slPrice, workingOrder.tpPrice)}</span></>
          )}
        </span>
      ) : (
        <span className="text-text-muted">Flat — no open position</span>
      )}
    </div>
  )
}
