import type { Bar, EquityPoint } from '../api/types'
import { fmtUsd } from '../format'
import { fmtEtDateTimeSec } from '../timeFormat'

export const SPEEDS = [0.5, 1, 2, 4, 8, 16] as const

// The speed one notch up (+1) or down (-1) the SPEEDS ladder, clamped at the
// ends; a speed not on the ladder snaps to the nearest notch first.
export function stepSpeed(speed: number, direction: 1 | -1): number {
  let nearest = 0
  SPEEDS.forEach((s, i) => {
    if (Math.abs(s - speed) < Math.abs(SPEEDS[nearest] - speed)) nearest = i
  })
  return SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, nearest + direction))]
}


interface ReplayControlsProps {
  active: boolean
  bars: Bar[]
  cursorIndex: number
  onCursorIndexChange: (i: number) => void
  isPlaying: boolean
  onTogglePlaying: () => void
  speed: number
  onSpeedChange: (s: number) => void
  // "Follow latest bar" (REPLICA_ROADMAP.md Batch 1: "free camera") --
  // default off, so stepping never touches the camera unless opted in.
  followLatestBar: boolean
  onToggleFollowLatestBar: () => void
  // "Click a bar to set the replay start" (REPLICA_ROADMAP.md Batch 5) --
  // armed here, the actual pick happens on the chart itself (ChartKL's
  // onCandleBarClick, wired up in ChartPanel.tsx).
  pickingReplayStart: boolean
  onTogglePickingReplayStart: () => void
  runningPnl: number
  runningR: number
  equity: EquityPoint | null
  // FXR_SPEC.md section C, phase F5: toggles SessionWorkspace's journal
  // drawer -- lives here (not a standalone header button) since this is
  // already the one persistent control row a replay session shows.
  // Optional/undefined for ChartPanel.tsx's OTHER use of this component (a
  // completed automated-backtest run's replay, which has no journal
  // concept at all) -- the button simply doesn't render there.
  journalOpen?: boolean
  onToggleJournal?: () => void
  // FXR_SPEC.md phase F6: opens this session's analytics (Dashboard, equity,
  // Monte Carlo, prop result) -- same optional/manual-session-only deal.
  onOpenAnalytics?: () => void
  // FXR_SPEC.md phase F7b. `minIndex` is the discipline lock's floor (the
  // placement bar): step-back stops there and the scrub slider starts there.
  // `onToggleMagnifier` is only passed for a >1-minute session; the pick
  // itself happens on the chart (SessionWorkspace's onCandleBarClick).
  minIndex?: number
  magnifierArmed?: boolean
  onToggleMagnifier?: () => void
}

export default function ReplayControls({
  active,
  bars,
  cursorIndex,
  onCursorIndexChange,
  isPlaying,
  onTogglePlaying,
  speed,
  onSpeedChange,
  followLatestBar,
  onToggleFollowLatestBar,
  pickingReplayStart,
  onTogglePickingReplayStart,
  runningPnl,
  runningR,
  equity,
  journalOpen,
  onToggleJournal,
  onOpenAnalytics,
  minIndex = 0,
  magnifierArmed = false,
  onToggleMagnifier,
}: ReplayControlsProps) {
  const lastIndex = Math.max(0, bars.length - 1)
  const cursorBar = bars[cursorIndex]

  // REPLICA_ROADMAP.md Batch 4: the enter/exit toggle now lives in
  // ChartPanel's top toolbar row (alongside symbol/timeframe/indicators),
  // matching TradingView's own top bar -- this component renders nothing
  // at all until replay is actually active, instead of always showing a
  // one-button row.
  if (!active) return null

  return (
    <div className="border-b border-border px-6 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-3">
        {bars.length > 0 && (
          <>
            <button
              onClick={() => onCursorIndexChange(Math.max(minIndex, cursorIndex - 1))}
              disabled={cursorIndex <= minIndex}
              className="rounded bg-surface-2 px-2 h-7 text-text hover:bg-surface-2-hover disabled:opacity-40"
            >
              &larr; Step
            </button>
            <button
              onClick={onTogglePlaying}
              className="rounded bg-surface-2 px-2 h-7 text-text hover:bg-surface-2-hover"
            >
              {isPlaying ? 'Pause' : 'Play'}
            </button>
            <button
              onClick={() => onCursorIndexChange(Math.min(lastIndex, cursorIndex + 1))}
              disabled={cursorIndex >= lastIndex}
              className="rounded bg-surface-2 px-2 h-7 text-text hover:bg-surface-2-hover disabled:opacity-40"
            >
              Step &rarr;
            </button>

            <button
              onClick={onTogglePickingReplayStart}
              title="Click a bar on the chart to start replay from there, instead of session open (S)"
              aria-pressed={pickingReplayStart}
              className={`rounded px-2 h-7 ${
                pickingReplayStart ? 'bg-accent text-on-accent' : 'bg-surface-2 text-text hover:bg-surface-2-hover'
              }`}
            >
              {pickingReplayStart ? 'Click a bar…' : 'Set start'}
            </button>

            {onToggleMagnifier && (
              <button
                onClick={onToggleMagnifier}
                title="Click a revealed bar to see the 1-minute bars inside it. Never shows anything past the replay cursor."
                aria-pressed={magnifierArmed}
                className={`rounded px-2 h-7 ${
                  magnifierArmed ? 'bg-accent text-on-accent' : 'bg-surface-2 text-text hover:bg-surface-2-hover'
                }`}
              >
                {magnifierArmed ? 'Click a bar…' : 'Magnify'}
              </button>
            )}

            <select
              value={speed}
              onChange={(e) => onSpeedChange(Number(e.target.value))}
              className="propbt-input"
            >
              {SPEEDS.map((s) => (
                <option key={s} value={s}>
                  {s}x
                </option>
              ))}
            </select>

            <button
              onClick={onToggleFollowLatestBar}
              title="Keep the newest revealed bar in view while stepping (a minimal scroll, never a hard recenter). Off by default – pan around freely and keep stepping."
              aria-pressed={followLatestBar}
              className={`rounded px-2 h-7 ${
                followLatestBar ? 'bg-accent text-on-accent' : 'bg-surface-2 text-text hover:bg-surface-2-hover'
              }`}
            >
              Follow
            </button>

            {/* No explicit accent-color class -- inherits the theme's live
                accent-color from :root (POLISH_ROADMAP Phase P6). */}
            <input
              type="range"
              min={minIndex}
              max={lastIndex}
              value={cursorIndex}
              onChange={(e) => onCursorIndexChange(Number(e.target.value))}
              className="min-w-[160px] flex-1"
            />

            {cursorBar && <span className="whitespace-nowrap tabular-nums text-text-muted">{fmtEtDateTimeSec(cursorBar.time)}</span>}
          </>
        )}
        {onOpenAnalytics && (
          <button
            onClick={onOpenAnalytics}
            title="Open this session's analytics: stats, equity, Monte Carlo, prop-firm result"
            className="ml-auto rounded bg-surface-2 px-2 h-7 text-text hover:bg-surface-2-hover"
          >
            Analytics
          </button>
        )}
        {onToggleJournal && (
          <button
            onClick={onToggleJournal}
            aria-pressed={journalOpen}
            className={`${onOpenAnalytics ? '' : 'ml-auto '}rounded px-2 h-7 ${
              journalOpen ? 'bg-accent text-on-accent' : 'bg-surface-2 text-text hover:bg-surface-2-hover'
            }`}
          >
            Journal
          </button>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-4 text-text-muted">
        <span>
          Running:{' '}
          <span className={`tabular-nums ${runningPnl >= 0 ? 'text-positive-fg' : 'text-negative-fg'}`}>
            {fmtUsd(runningPnl)}
          </span>{' '}
          <span className="tabular-nums text-text-muted">({runningR.toFixed(2)}R)</span>
        </span>
        {equity ? (
          <>
            <span>
              Equity: <span className="tabular-nums text-text">{fmtUsd(equity.equity)}</span>
            </span>
            {equity.mll_floor !== null && (
              <>
                <span>
                  MLL floor: <span className="tabular-nums text-text">{fmtUsd(equity.mll_floor)}</span>
                </span>
                <span>
                  Distance to breach:{' '}
                  <span className={`tabular-nums ${equity.equity - equity.mll_floor > 0 ? 'text-text' : 'text-negative-fg'}`}>
                    {fmtUsd(equity.equity - equity.mll_floor)}
                  </span>
                </span>
              </>
            )}
          </>
        ) : (
          <span className="text-text-muted">No equity data at cursor</span>
        )}
      </div>
    </div>
  )
}
