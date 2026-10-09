// FXR_V2_SPEC.md section 2 (G1): the session workspace's one-row bottom bar.
// Left: hide-trades eye, Buy, Sell, Quantity, Scalper button (opens the Scalper
// Mode settings popover; accent while armed, G4). Centre: a grip that opens/drags up the trade panel. Right:
// Analytics, Prop Rules (prop sessions only), the three balance figures
// (colour on the number only, DESIGN_LANGUAGE.md section 9), hide-balances
// eye, expand-panel chevron and fullscreen.
//
// Buy/Sell keep DESIGN_LANGUAGE.md section 2's one trading-action exception
// (muted bg-{token}/15 badges, never a solid fill).
import { useRef, useState } from 'react'
import { BarChart3, ChevronUp, Eye, EyeOff, GripHorizontal, Maximize2, Minimize2, ShieldCheck, Zap } from 'lucide-react'
import { fmtUsd } from '../format'
import { ICON_BUTTON, IconButton } from './SessionTopBar'
import ScalperPopover, { type ScalperPopoverProps } from './ScalperPopover'

const MASK = '••••'

function signClass(v: number): string {
  return v > 0 ? 'text-positive-fg' : v < 0 ? 'text-negative-fg' : 'text-text'
}

function Figure({ label, value, hidden, signed }: { label: string; value: number; hidden: boolean; signed: boolean }) {
  return (
    <span className="flex items-baseline gap-1 whitespace-nowrap">
      <span className="micro-label">{label}</span>
      <span className={`min-w-[64px] text-xs tabular-nums ${hidden ? 'text-text-muted' : signed ? signClass(value) : 'text-text'}`}>
        {hidden ? MASK : fmtUsd(value)}
      </span>
    </span>
  )
}

export interface QuantityProps {
  value: number
  // The prop position cap (Topstep: 5), or null when uncapped.
  max: number | null
  onChange: (n: number) => void
}

function QuantityInput({ value, max, onChange }: QuantityProps) {
  // A text draft so the field can be momentarily empty while typing; only a
  // whole number >= 1 (clamped to the cap) is ever committed.
  const [draft, setDraft] = useState<string | null>(null)
  const commit = (raw: string) => {
    const n = Math.floor(Number(raw))
    if (!Number.isFinite(n) || n < 1) return
    const clamped = max !== null ? Math.min(n, max) : n
    // Show the cap right away rather than leaving the over-cap digits typed.
    if (clamped !== n) setDraft(String(clamped))
    onChange(clamped)
  }
  return (
    <label className="flex items-center gap-2">
      <span className="micro-label">Qty</span>
      <input
        type="number"
        inputMode="numeric"
        min={1}
        max={max ?? undefined}
        step={1}
        value={draft ?? String(value)}
        onChange={(e) => {
          setDraft(e.target.value)
          commit(e.target.value)
        }}
        onBlur={() => setDraft(null)}
        aria-label="Quick quantity (contracts)"
        title={max !== null ? `Contracts per Buy/Sell (max ${max} on this session)` : 'Contracts per Buy/Sell'}
        className="propbt-input w-14 text-right"
      />
    </label>
  )
}

export interface ScalperBarProps {
  // Accent while armed: the one active thing on the bar (DESIGN_LANGUAGE.md section 2).
  armed: boolean
  open: boolean
  onToggleOpen: () => void
  popover: ScalperPopoverProps
}

function ScalperButton({ scalper }: { scalper: ScalperBarProps }) {
  const { armed, open } = scalper
  return (
    <div className="relative">
      <button
        type="button"
        onClick={scalper.onToggleOpen}
        aria-label={armed ? 'Scalper Mode (armed)' : 'Scalper Mode'}
        title={armed ? 'Scalper Mode is armed: Buy/Sell and right-click orders carry your SL/TP' : 'Scalper Mode: preset SL / TP / break-even for every entry'}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={
          armed
            ? 'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded bg-accent text-on-accent transition-colors hover:brightness-110 active:brightness-95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'
            : `${ICON_BUTTON} ${open ? 'bg-surface-2 text-text' : ''}`
        }
      >
        <Zap size={16} aria-hidden />
      </button>
      {open && <ScalperPopover {...scalper.popover} />}
    </div>
  )
}

export default function SessionBottomBar({
  hideTrades,
  onToggleHideTrades,
  onBuy,
  onSell,
  tradingDisabled,
  disabledReason,
  quantity,
  scalper,
  panelOpen,
  onTogglePanel,
  onGripDrag,
  onAnalytics,
  propRules,
  balance,
  realizedPnl,
  unrealizedPnl,
  hideBalances,
  onToggleHideBalances,
  onToggleFullscreen,
  isFullscreen,
}: {
  hideTrades: boolean
  onToggleHideTrades: () => void
  onBuy: () => void
  onSell: () => void
  // Flat gate / no bars yet / session ended.
  tradingDisabled: boolean
  // Shown as the Buy/Sell tooltip while disabled.
  disabledReason: string
  quantity: QuantityProps
  scalper: ScalperBarProps
  panelOpen: boolean
  onTogglePanel: () => void
  // Called with the pointer's vertical movement (px, up = positive) since the
  // drag began; the workspace turns it into a panel height.
  onGripDrag: (deltaUp: number, phase: 'start' | 'move' | 'end') => void
  onAnalytics: () => void
  // null = not a prop session.
  propRules: { onOpen: () => void; open: boolean } | null
  balance: number
  realizedPnl: number
  unrealizedPnl: number
  hideBalances: boolean
  onToggleHideBalances: () => void
  onToggleFullscreen: () => void
  isFullscreen: boolean
}) {
  // Click toggles the panel; a drag of more than a few px resizes it instead.
  const dragRef = useRef<{ startY: number; moved: boolean } | null>(null)
  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { startY: e.clientY, moved: false }
    onGripDrag(0, 'start')
  }
  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current
    if (!d) return
    const up = d.startY - e.clientY
    if (!d.moved && Math.abs(up) < 4) return
    d.moved = true
    onGripDrag(up, 'move')
  }
  const onPointerUp = () => {
    const d = dragRef.current
    dragRef.current = null
    if (!d) return
    onGripDrag(0, 'end')
    if (!d.moved) onTogglePanel()
  }

  return (
    <footer className="relative flex h-10 shrink-0 items-center gap-2 bg-bg px-2" aria-label="Trading">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <IconButton label={hideTrades ? 'Show trades on chart' : 'Hide trades on chart'} onClick={onToggleHideTrades} pressed={hideTrades}>
          {hideTrades ? <EyeOff size={16} aria-hidden /> : <Eye size={16} aria-hidden />}
        </IconButton>
        <button
          type="button"
          onClick={onBuy}
          disabled={tradingDisabled}
          title={tradingDisabled ? disabledReason : 'Buy at market (Shift+B)'}
          className="h-7 shrink-0 rounded bg-positive/15 px-3 text-xs text-positive-fg transition-colors hover:bg-positive/25 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40"
        >
          Buy
        </button>
        <button
          type="button"
          onClick={onSell}
          disabled={tradingDisabled}
          title={tradingDisabled ? disabledReason : 'Sell at market (Shift+S)'}
          className="h-7 shrink-0 rounded bg-negative/15 px-3 text-xs text-negative-fg transition-colors hover:bg-negative/25 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40"
        >
          Sell
        </button>
        <QuantityInput {...quantity} />
        <ScalperButton scalper={scalper} />
      </div>

      <button
        type="button"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onTogglePanel()
          }
        }}
        aria-label={panelOpen ? 'Trade panel: drag to resize, click to close' : 'Trade panel: click to open, drag up to resize'}
        aria-expanded={panelOpen}
        title="Positions, orders and history: click to toggle, drag up to resize"
        className="flex h-7 w-16 flex-none cursor-row-resize touch-none items-center justify-center rounded text-text-muted transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      >
        <GripHorizontal size={16} aria-hidden />
      </button>

      <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
        <button
          type="button"
          onClick={onAnalytics}
          aria-label="Analytics"
          title="Open this session's analytics: stats, equity, Monte Carlo, prop-firm result"
          className="flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded px-2 text-xs text-text-muted transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        >
          <BarChart3 size={14} aria-hidden />
          <span className="hidden xl:inline">Analytics</span>
        </button>
        {propRules && (
          <button
            type="button"
            onClick={propRules.onOpen}
            aria-expanded={propRules.open}
            aria-haspopup="dialog"
            aria-label="Prop Rules"
            data-prop-rules-toggle
            title="Prop rules and Combine status"
            className={`flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded px-2 text-xs transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
              propRules.open ? 'bg-surface-2 text-text' : 'text-text-muted hover:bg-surface-2 hover:text-text'
            }`}
          >
            <ShieldCheck size={14} aria-hidden />
            <span className="hidden xl:inline">Prop Rules</span>
          </button>
        )}
        <div className="hidden items-center gap-4 xl:flex">
          <Figure label="Balance" value={balance} hidden={hideBalances} signed={false} />
          <Figure label="Realized" value={realizedPnl} hidden={hideBalances} signed />
          <Figure label="Unrealized" value={unrealizedPnl} hidden={hideBalances} signed />
        </div>
        <IconButton label={hideBalances ? 'Show balances' : 'Hide balances'} onClick={onToggleHideBalances} pressed={hideBalances}>
          {hideBalances ? <EyeOff size={16} aria-hidden /> : <Eye size={16} aria-hidden />}
        </IconButton>
        <IconButton label={panelOpen ? 'Collapse trade panel' : 'Expand trade panel'} onClick={onTogglePanel}>
          <ChevronUp size={16} aria-hidden className={panelOpen ? 'rotate-180' : ''} />
        </IconButton>
        <IconButton label={isFullscreen ? 'Exit full screen' : 'Full screen'} onClick={onToggleFullscreen}>
          {isFullscreen ? <Minimize2 size={16} aria-hidden /> : <Maximize2 size={16} aria-hidden />}
        </IconButton>
      </div>
    </footer>
  )
}
