import type { Bar, EquityPoint } from '../api/types'
import { fmtUsd } from '../format'

const SPEEDS = [0.5, 1, 2, 4, 8, 16] as const

function fmtTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 19).replace('T', ' ')
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

            <button
              onClick={onTogglePickingReplayStart}
              title="Click a bar on the chart to start replay from there, instead of session open (S)"
              aria-pressed={pickingReplayStart}
              className={`rounded px-2 py-1 ${
                pickingReplayStart ? 'bg-accent text-white' : 'bg-surface-2 text-text hover:bg-surface-2-hover'
              }`}
            >
              {pickingReplayStart ? 'Click a bar…' : 'Set start'}
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
        {onToggleJournal && (
          <button
            onClick={onToggleJournal}
            aria-pressed={journalOpen}
            className={`ml-auto rounded px-2 py-1 ${
              journalOpen ? 'bg-accent text-white' : 'bg-surface-2 text-text hover:bg-surface-2-hover'
            }`}
          >
            Journal
          </button>
        )}
      </div>

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
    </div>
  )
}
