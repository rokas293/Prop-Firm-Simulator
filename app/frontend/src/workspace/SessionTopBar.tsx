// FXR_V2_SPEC.md section 2 (G1): the session workspace's one-row top bar.
// Left: back, session name, settings gear (a small popover with the replay
// options that used to be loose buttons). Centre: the playback pill. Right:
// the actions. Everything is a ghost control on the bar's own background
// (DESIGN_LANGUAGE.md section 6); the only accent is an armed/active toggle.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ArrowLeft,
  BookOpen,
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
import { POPOVER_MENU_ROW, POPOVER_SHELL } from '../components/popoverStyles'

export const ICON_BUTTON =
  'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-text-muted transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-text-muted'
// Pressed/open view toggles take a background step, not the accent (accent is
// reserved for the one armed state, DESIGN_LANGUAGE.md section 2).
const ICON_BUTTON_ACTIVE = 'bg-surface-2 text-text'

export function IconButton({
  label,
  onClick,
  disabled,
  pressed,
  expanded,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  pressed?: boolean
  expanded?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={expanded === undefined ? pressed : undefined}
      aria-haspopup={expanded === undefined ? undefined : 'menu'}
      aria-expanded={expanded}
      disabled={disabled}
      onClick={onClick}
      className={`${ICON_BUTTON} ${pressed ? ICON_BUTTON_ACTIVE : ''}`}
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
