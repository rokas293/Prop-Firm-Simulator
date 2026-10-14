// FXR_V2_SPEC.md section 2 (G1): the session workspace's one-row top bar.
// Left: back, session name, settings gear (a small popover with the replay
// options that used to be loose buttons). Centre: the playback pill. Right:
// the actions. Everything is a ghost control on the bar's own background
// (DESIGN_LANGUAGE.md section 6); the only accent is an armed/active toggle.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ArrowLeft,
  BookOpen,
  Bot,
  GripVertical,
  Lock,
  Maximize2,
  Minimize2,
  Moon,
  Pause,
  Play,
  PlusSquare,
  Settings,
  SkipBack,
  SkipForward,
  Sun,
} from 'lucide-react'
import { SPEEDS } from '../panels/ReplayControls'
import { SESSION_TIMEFRAMES } from '../chart/replayBars'
import { POPOVER_FORM_PADDING, POPOVER_MENU_ROW, POPOVER_SHELL } from '../components/popoverStyles'
import Switch from '../components/Switch'
import { fmtSignedUsd } from '../chart/orderEntry'
import { fmtPrice } from '../format'
import type { AutopilotConfigInfo, AutopilotState } from '../api/types'

// Colour is composed per state (never two text-* utilities on one element: they race on
// Tailwind's own generated order), so a pressed button really does read brighter.
const ICON_LAYOUT =
  'inline-flex h-7 shrink-0 items-center justify-center rounded transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-text-muted'
const ICON_REST = 'text-text-muted hover:bg-surface-2 hover:text-text active:bg-surface-2-hover'
// Pressed/open view toggles take a background step AND the primary text colour, not the accent
// (accent is reserved for the one armed state, DESIGN_LANGUAGE.md section 2).
const ICON_PRESSED = 'bg-surface-2 text-text hover:bg-surface-2-hover active:bg-surface-2-hover'
export const ICON_BUTTON = `${ICON_LAYOUT} w-7 ${ICON_REST}`

export function IconButton({
  label,
  onClick,
  disabled,
  pressed,
  expanded,
  haspopup = 'menu',
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  pressed?: boolean
  expanded?: boolean
  haspopup?: 'menu' | 'dialog'
  children: ReactNode
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={expanded === undefined ? pressed : undefined}
      aria-haspopup={expanded === undefined ? undefined : haspopup}
      aria-expanded={expanded}
      disabled={disabled}
      onClick={onClick}
      className={`${ICON_LAYOUT} w-7 ${pressed ? ICON_PRESSED : ICON_REST}`}
    >
      {children}
    </button>
  )
}

export interface SessionMenuProps {
  followLatestBar: boolean
  onToggleFollowLatestBar: () => void
  pickingReplayStart: boolean
  onTogglePickingReplayStart: () => void
  magnifierArmed: boolean
  // Only offered for a >1-minute session (the magnifier shows 1m bars).
  onToggleMagnifier?: () => void
  // Set when starting the replay elsewhere would rewind it (prop sessions).
  replayStartBlockedReason?: string
  // G5: glide the forming candle between steps during auto-play (cosmetic).
  smoothCandles: boolean
  onToggleSmoothCandles: () => void
  onOpenAppSettings: () => void
  onOpenShortcuts: () => void
}

export interface PlaybackProps {
  isPlaying: boolean
  onTogglePlaying: () => void
  speed: number
  onSpeedChange: (s: number) => void
  onStepBack: () => void
  onStepForward: () => void
  canStepBack: boolean
  // Prop sessions: step back stays visible but inert, and says why.
  stepBackBlockedReason?: string
  canStepForward: boolean
  // How far one step advances: a timeframe id ('1min' ... '4h'), independent of the
  // chart's own timeframe (G5).
  stepSize: string
  onStepSizeChange: (id: string) => void
  autoPlay: boolean
  onToggleAutoPlay: () => void
  // The cursor's wall time, ET -- shown quietly after the pill.
  cursorLabel: string | null
  // G10: Autopilot, in the pill. Absent = the control is not offered.
  autopilot?: AutopilotControlProps
}

export interface TopBarActionsProps {
  onPlaceOrder: () => void
  placeOrderDisabled: boolean
  // A position tool is on the chart, so Place order opens pre-filled from it.
  placeOrderReady: boolean
  // Why Place order is unavailable, for its tooltip.
  placeOrderDisabledReason?: string
  onToggleJournal: () => void
  journalOpen: boolean
  onToggleTheme: () => void
  isDark: boolean
  onToggleFullscreen: () => void
  isFullscreen: boolean
}

function SessionMenu({ menu }: { menu: SessionMenuProps }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const row = (label: string, onSelect: () => void, opts?: { pressed?: boolean; hint?: string; disabledReason?: string }) => (
    <button
      key={label}
      type="button"
      role="menuitem"
      disabled={opts?.disabledReason !== undefined}
      title={opts?.disabledReason}
      onClick={() => {
        onSelect()
        setOpen(false)
      }}
      className={`${POPOVER_MENU_ROW} focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent`}
    >
      <span className="flex-1">{label}</span>
      {opts?.pressed !== undefined && <span className="text-text-muted">{opts.pressed ? 'On' : 'Off'}</span>}
      {opts?.hint && <span className="text-text-muted">{opts.hint}</span>}
    </button>
  )

  return (
    <div ref={ref} className="relative">
      <IconButton label="Session settings" onClick={() => setOpen((v) => !v)} pressed={open} expanded={open}>
        <Settings size={16} aria-hidden />
      </IconButton>
      {open && (
        <div role="menu" className={`${POPOVER_SHELL} absolute left-0 top-9 z-30 w-56 py-1`}>
          {row('Follow latest bar', menu.onToggleFollowLatestBar, { pressed: menu.followLatestBar })}
          {row(menu.pickingReplayStart ? 'Click a bar to start…' : 'Set replay start', menu.onTogglePickingReplayStart, {
            pressed: menu.pickingReplayStart,
            disabledReason: menu.replayStartBlockedReason,
          })}
          {row('Smooth candles (auto-play)', menu.onToggleSmoothCandles, { pressed: menu.smoothCandles })}
          {menu.onToggleMagnifier &&
            row(menu.magnifierArmed ? 'Click a bar to magnify…' : 'Magnify a bar', menu.onToggleMagnifier, {
              pressed: menu.magnifierArmed,
            })}
          <div className="my-1 h-px bg-border" />
          {row('App settings…', menu.onOpenAppSettings)}
          {row('Keyboard shortcuts', menu.onOpenShortcuts, { hint: '?' })}
        </div>
      )}
    </div>
  )
}


// FXR_V2_SPEC.md section 8 (G10): Autopilot -- the propbt strategy trading this replay,
// stepped by the real engine on the server. A toggle-and-popover button in the pill (the
// accent stays with the one switch inside): the strategy, the on/off switch, one status
// line, and the caveats behind a disclosure.
export interface AutopilotControlProps {
  state: AutopilotState | null
  configs: AutopilotConfigInfo[]
  busy: boolean
  error: string | null
  // Why it cannot be switched on right now, for the switch's tooltip.
  blockedReason?: string
  onSwitch: (enabled: boolean, configId?: string) => void
}

const AUTOPILOT_ENDED: Record<string, string> = {
  failed: 'The run ended: the account failed its rules.',
  passed: 'The run ended: the profit target was reached.',
}

function sentenceCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function AutopilotControl({ ap }: { ap: AutopilotControlProps }) {
  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState('')
  const wrap = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)

  const close = () => {
    setOpen(false)
    button.current?.focus()
  }
  useEffect(() => {
    if (!open) return
    // Focus moves into the popover (the switch, else the select) and Escape returns it to the
    // button -- in the capture phase and stopped, so it does not also cancel a drawing.
    wrap.current?.querySelector<HTMLElement>('[role="switch"]:not(:disabled), select:not(:disabled)')?.focus()
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      close()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const st = ap.state
  const runnable = ap.configs.filter((c) => c.supported)
  const refused = ap.configs.filter((c) => !c.supported)
  const chosen = picked || st?.config_id || runnable[0]?.id || ''
  const chosenInfo = ap.configs.find((c) => c.id === chosen)
  const enabled = st?.enabled ?? false
  const ended = st !== null && (st.status === 'failed' || st.status === 'passed' || st.status === 'error')
  const switchDisabled = ap.busy || ended || (!enabled && (!chosen || ap.blockedReason !== undefined))
  const tooltip = enabled
    ? `Autopilot is on: ${st?.config_label}`
    : st?.interrupted
      ? 'Autopilot is off (this run was interrupted)'
      : 'Autopilot: let the strategy trade this replay'
  const headline =
    st === null
      ? null
      : st.status === 'running'
        ? 'Running'
        : st.status === 'off'
          ? 'Off'
          : st.status === 'error'
            ? 'Stopped on an error'
            : 'Run ended'

  return (
    <div ref={wrap} className="relative">
      <button
        ref={button}
        type="button"
        aria-label="Autopilot"
        aria-pressed={enabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={tooltip}
        onClick={() => setOpen((v) => !v)}
        className={`${ICON_LAYOUT} gap-1 px-1.5 ${enabled || open ? ICON_PRESSED : ICON_REST}`}
      >
        <Bot size={16} aria-hidden />
        {enabled && (
          <span className="text-[11px] font-medium uppercase tracking-wide text-text" aria-hidden>
            On
          </span>
        )}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Autopilot"
          // Keys typed inside the popover are the popover's: the workspace's single-key and
          // Shift trading hotkeys must not fire from the switch or the select.
          onKeyDown={(e) => {
            if (e.key !== 'Tab' && e.key !== 'Escape') e.stopPropagation()
          }}
          className={`${POPOVER_SHELL} ${POPOVER_FORM_PADDING} absolute right-0 top-9 z-30 flex w-80 flex-col gap-3`}
        >
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-text">Autopilot</span>
            <span title={!enabled && ap.blockedReason ? ap.blockedReason : undefined}>
              <Switch
                checked={enabled}
                disabled={switchDisabled}
                label="Autopilot"
                onChange={(v) => ap.onSwitch(v, v ? chosen : undefined)}
              />
            </span>
          </div>

          <label className="flex flex-col gap-1 text-xs text-text-muted">
            Strategy
            <select
              value={chosen}
              onChange={(e) => setPicked(e.target.value)}
              disabled={enabled || ended || ap.busy}
              aria-label="Strategy config"
              className="propbt-input propbt-input--well w-full"
            >
              {runnable.length === 0 && <option value="">No runnable config</option>}
              {runnable.map((c) => (
                <option key={c.id} value={c.id}>
                  {sentenceCase(c.label)} · {c.symbol}
                </option>
              ))}
            </select>
          </label>
          {chosenInfo && chosenInfo.summary.length > 0 && (
            <ul className="flex flex-col gap-1 text-xs text-text-muted">
              {chosenInfo.summary.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
          {refused.map((c) => (
            <details key={c.id} className="text-xs text-text-muted">
              <summary className="cursor-pointer text-text-muted hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
                {sentenceCase(c.label)} cannot run
              </summary>
              <p className="pt-1">{c.reason}</p>
            </details>
          ))}

          {st && (
            <div className="flex flex-col gap-1 text-xs">
              <span className="text-text" aria-live="polite">
                {headline}{' '}
                <span className="text-text-muted">
                  · {st.trades} trade{st.trades === 1 ? '' : 's'} · {st.config_label}
                </span>
              </span>
              {st.position && (
                <span className="text-text-muted">
                  Holding {st.position.side === 'long' ? 'long' : 'short'} {st.position.contracts} @{' '}
                  {fmtPrice(st.position.entry_price, st.position.instrument)} ·{' '}
                  <span className={st.position.unrealized_usd >= 0 ? 'text-positive-fg' : 'text-negative-fg'}>
                    {fmtSignedUsd(st.position.unrealized_usd)}
                  </span>
                </span>
              )}
              {st.pending.map((p) => (
                <span key={p.decided_time} className="text-text-muted">
                  Decided {p.side === 'long' ? 'BUY' : 'SELL'} {p.contracts}: fills at the next bar&apos;s open
                </span>
              ))}
              {st.daily_locked && <span className="text-text-muted">Daily loss limit reached: no new trades today.</span>}
              {AUTOPILOT_ENDED[st.status] && <span className="text-text-muted">{AUTOPILOT_ENDED[st.status]}</span>}
              {st.status === 'error' && st.status_detail && <span className="text-text">{st.status_detail}</span>}
              {st.interrupted && (
                <span className="text-text" aria-live="polite">
                  Interrupted: switched off and on again ({st.segments.length - 1}×). This run no longer matches an
                  offline backtest of the same window.
                </span>
              )}
            </div>
          )}
          {ap.error && (
            <p className="text-xs text-text" role="alert">
              {ap.error}
            </p>
          )}

          <details className="text-xs text-text-muted">
            <summary className="cursor-pointer hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
              How it works
            </summary>
            <p className="pt-1">
              Decides on a bar&apos;s close and fills at the next bar&apos;s open, with the engine&apos;s slippage
              {st ? ` (${st.slippage_ticks} tick${st.slippage_ticks === 1 ? '' : 's'})` : ''} and commission
              {st ? ` ($${st.commission_per_contract.toFixed(2)}/contract)` : ''}. Your manual trades share this account;
              the bot&apos;s loss limits and position cap see only its own trades.
            </p>
          </details>
        </div>
      )}
    </div>
  )
}

function PlaybackPill({ pb }: { pb: PlaybackProps }) {
  const speedIndex = Math.max(0, SPEEDS.indexOf(pb.speed as (typeof SPEEDS)[number]))
  return (
    <div className="flex h-8 items-center gap-1 rounded bg-surface px-1" role="group" aria-label="Replay controls">
      {/* The grip is the pill's drag affordance in the reference UI; here it
          only marks the group (the bar itself is fixed). */}
      <GripVertical size={14} className="text-text-muted opacity-60" aria-hidden />
      <input
        type="range"
        min={0}
        max={SPEEDS.length - 1}
        step={1}
        value={speedIndex}
        onChange={(e) => pb.onSpeedChange(SPEEDS[Number(e.target.value)])}
        aria-label="Play speed, steps per second"
        title={`Play speed: ${pb.speed} step${pb.speed === 1 ? '' : 's'} per second`}
        className="w-20"
      />
      <span className="w-8 text-right text-xs tabular-nums text-text-muted">{pb.speed}/s</span>
      {pb.stepBackBlockedReason ? (
        <button
          type="button"
          title={pb.stepBackBlockedReason}
          aria-label="Step back (unavailable)"
          aria-disabled="true"
          onClick={pb.onStepBack}
          className={`${ICON_BUTTON} cursor-not-allowed opacity-40 hover:bg-transparent hover:text-text-muted`}
        >
          <SkipBack size={16} aria-hidden />
        </button>
      ) : (
        <IconButton label="Step back" onClick={pb.onStepBack} disabled={!pb.canStepBack}>
          <SkipBack size={16} aria-hidden />
        </IconButton>
      )}
      <IconButton label={pb.isPlaying ? 'Pause' : 'Play'} onClick={pb.onTogglePlaying}>
        {pb.isPlaying ? <Pause size={16} aria-hidden /> : <Play size={16} aria-hidden />}
      </IconButton>
      <span className="micro-label pl-1" aria-hidden>
        Step
      </span>
      <select
        value={pb.stepSize}
        onChange={(e) => pb.onStepSizeChange(e.target.value)}
        aria-label="Step size"
        title="Step size: how far one step advances (Shift+[ and Shift+]). The chart timeframe is separate."
        className="propbt-input w-14"
      >
        {SESSION_TIMEFRAMES.map((t) => (
          <option key={t.id} value={t.id}>
            {t.label}
          </option>
        ))}
      </select>
      <IconButton label="Step forward" onClick={pb.onStepForward} disabled={!pb.canStepForward}>
        <SkipForward size={16} aria-hidden />
      </IconButton>
      <button
        type="button"
        aria-pressed={pb.autoPlay}
        onClick={pb.onToggleAutoPlay}
        title="Auto-play: run the replay continuously (same as Play). Opening an order ticket or dialog always pauses it."
        className={`h-7 rounded px-2 text-xs transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
          pb.autoPlay ? 'bg-accent text-on-accent' : 'text-text-muted hover:bg-surface-2 hover:text-text'
        }`}
      >
        Auto
      </button>
      {pb.autopilot && <AutopilotControl ap={pb.autopilot} />}
    </div>
  )
}

export default function SessionTopBar({
  name,
  subtitle,
  disciplineLock,
  onBack,
  menu,
  playback,
  actions,
}: {
  name: string
  // e.g. "to Mar 14", muted, after the name (the name already carries the asset; the
  // timeframes are on the chart toolbar and the pill). Empty = nothing shown.
  subtitle: string
  // null = no lock on this session; otherwise whether it has engaged.
  disciplineLock: { engaged: boolean } | null
  onBack: () => void
  menu: SessionMenuProps
  playback: PlaybackProps
  actions: TopBarActionsProps
}) {
  return (
    <header className="relative flex h-10 shrink-0 items-center gap-2 bg-bg px-2" aria-label="Session">
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <IconButton label="Back to sessions" onClick={onBack}>
          <ArrowLeft size={16} aria-hidden />
        </IconButton>
        <span className="truncate text-sm text-text" title={name}>
          {name}
        </span>
        {subtitle && <span className="ml-2 hidden whitespace-nowrap text-xs text-text-muted md:inline">{subtitle}</span>}
        {disciplineLock && (
          <span
            className="ml-1 hidden items-center gap-1 text-xs text-text-muted lg:flex"
            title={
              disciplineLock.engaged
                ? 'Discipline lock engaged: the replay cannot go back past your first placed trade.'
                : 'Discipline lock: once you place a trade, the replay cannot go back past it.'
            }
          >
            <Lock size={14} aria-hidden />
            {disciplineLock.engaged ? 'Locked' : 'Lock armed'}
          </span>
        )}
        <SessionMenu menu={menu} />
      </div>

      <div className="flex items-center gap-2">
        <PlaybackPill pb={playback} />
        {playback.cursorLabel && (
          <span className="hidden whitespace-nowrap text-xs tabular-nums text-text-muted lg:inline">{playback.cursorLabel}</span>
        )}
      </div>

      <div className="flex min-w-0 flex-1 items-center justify-end gap-1">
        {/* The one primary action on the bar, and only once a position tool is on
            the chart (then it is the next step); otherwise a quiet secondary. */}
        <button
          type="button"
          onClick={actions.onPlaceOrder}
          disabled={actions.placeOrderDisabled}
          title={actions.placeOrderDisabled && actions.placeOrderDisabledReason ? actions.placeOrderDisabledReason : actions.placeOrderReady ? 'Place order from the position tool (Shift+N)' : 'Place order (Shift+N)'}
          className={`inline-flex h-7 items-center gap-1 rounded px-3 text-xs transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 ${
            actions.placeOrderReady ? 'bg-accent text-on-accent hover:brightness-110 active:brightness-95' : 'bg-surface text-text hover:bg-surface-2 disabled:hover:bg-surface'
          }`}
        >
          <PlusSquare size={14} aria-hidden />
          Place order
        </button>
        <IconButton label="Journal" onClick={actions.onToggleJournal} pressed={actions.journalOpen}>
          <BookOpen size={16} aria-hidden />
        </IconButton>
        <IconButton label={actions.isDark ? 'Switch to light theme' : 'Switch to dark theme'} onClick={actions.onToggleTheme}>
          {actions.isDark ? <Sun size={16} aria-hidden /> : <Moon size={16} aria-hidden />}
        </IconButton>
        <IconButton label={actions.isFullscreen ? 'Exit full screen' : 'Full screen'} onClick={actions.onToggleFullscreen}>
          {actions.isFullscreen ? <Minimize2 size={16} aria-hidden /> : <Maximize2 size={16} aria-hidden />}
        </IconButton>
      </div>
    </header>
  )
}
