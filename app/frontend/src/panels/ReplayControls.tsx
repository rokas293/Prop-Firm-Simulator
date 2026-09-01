import type { Bar, EquityPoint } from '../api/types'
import { fmtUsd } from '../format'

const SPEEDS = [0.5, 1, 2, 4, 8, 16] as const

function fmtTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 19).replace('T', ' ')
}

interface ReplayControlsProps {
  active: boolean
  onToggleActive: () => void
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
  runningPnl: number
  runningR: number
  equity: EquityPoint | null
}

export default function ReplayControls({
  active,
  onToggleActive,
  bars,
  cursorIndex,
  onCursorIndexChange,
  isPlaying,
  onTogglePlaying,
  speed,
  onSpeedChange,
  followLatestBar,
  onToggleFollowLatestBar,
  runningPnl,
  runningR,
  equity,
}: ReplayControlsProps) {
  const lastIndex = Math.max(0, bars.length - 1)
  const cursorBar = bars[cursorIndex]

  return (
    <div className="border-b border-border px-6 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={onToggleActive}
          className={`rounded px-2 py-1 ${
            active ? 'bg-accent text-white' : 'bg-surface-2 text-text hover:bg-surface-2-hover'
          }`}
        >
          {active ? 'Exit replay' : 'Replay'}
        </button>

        {active && bars.length > 0 && (
          <>
            <button
              onClick={() => onCursorIndexChange(Math.max(0, cursorIndex - 1))}
              disabled={cursorIndex <= 0}
              className="rounded bg-surface-2 px-2 py-1 text-text hover:bg-surface-2-hover disabled:opacity-40"
            >
              &larr; Step
            </button>
            <button
              onClick={onTogglePlaying}
              className="rounded bg-surface-2 px-2 py-1 text-text hover:bg-surface-2-hover"
            >
              {isPlaying ? 'Pause' : 'Play'}
            </button>
            <button
              onClick={() => onCursorIndexChange(Math.min(lastIndex, cursorIndex + 1))}
              disabled={cursorIndex >= lastIndex}
              className="rounded bg-surface-2 px-2 py-1 text-text hover:bg-surface-2-hover disabled:opacity-40"
            >
              Step &rarr;
            </button>

            <select
              value={speed}
              onChange={(e) => onSpeedChange(Number(e.target.value))}
              className="rounded bg-surface-2 px-2 py-1 text-text"
            >
              {SPEEDS.map((s) => (
                <option key={s} value={s}>
                  {s}x
                </option>
              ))}
            </select>

            <button
              onClick={onToggleFollowLatestBar}
              title="Keep the newest revealed bar in view while stepping (a minimal scroll, never a hard recenter). Off by default -- pan around freely and keep stepping."
              aria-pressed={followLatestBar}
              className={`rounded px-2 py-1 ${
                followLatestBar ? 'bg-accent text-white' : 'bg-surface-2 text-text hover:bg-surface-2-hover'
              }`}
            >
              Follow
            </button>

            {/* No explicit accent-color class -- inherits the theme's live
                accent-color from :root (POLISH_ROADMAP Phase P6). */}
            <input
              type="range"
              min={0}
              max={lastIndex}
              value={cursorIndex}
              onChange={(e) => onCursorIndexChange(Number(e.target.value))}
              className="min-w-[160px] flex-1"
            />

            {cursorBar && <span className="whitespace-nowrap font-mono text-text-muted">{fmtTime(cursorBar.time)}</span>}
          </>
        )}
      </div>

      {active && (
        <div className="mt-2 flex flex-wrap items-center gap-4 text-text-muted">
          <span>
            Running:{' '}
            <span className={`tabular-nums ${runningPnl >= 0 ? 'text-positive' : 'text-negative'}`}>
              {fmtUsd(runningPnl)}
            </span>{' '}
            <span className="tabular-nums text-text-muted">({runningR.toFixed(2)}R)</span>
          </span>
          {equity ? (
            <>
              <span>
                Equity: <span className="tabular-nums text-text">{fmtUsd(equity.equity)}</span>
              </span>
              <span>
                MLL floor: <span className="tabular-nums text-text">{fmtUsd(equity.mll_floor)}</span>
              </span>
              <span>
                Distance to breach:{' '}
                <span className={`tabular-nums ${equity.equity - equity.mll_floor > 0 ? 'text-text' : 'text-negative'}`}>
                  {fmtUsd(equity.equity - equity.mll_floor)}
                </span>
              </span>
            </>
          ) : (
            <span className="text-text-muted">No equity data at cursor</span>
          )}
        </div>
      )}
    </div>
  )
}
