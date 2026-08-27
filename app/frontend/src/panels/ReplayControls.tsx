import type { Bar, EquityPoint } from '../api/types'

const SPEEDS = [0.5, 1, 2, 4, 8, 16] as const

function fmtTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 19).replace('T', ' ')
}

function fmtUsd(v: number): string {
  const sign = v >= 0 ? '' : '-'
  return `${sign}$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
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
  runningPnl,
  runningR,
  equity,
}: ReplayControlsProps) {
  const lastIndex = Math.max(0, bars.length - 1)
  const cursorBar = bars[cursorIndex]

  return (
    <div className="border-b border-neutral-800 px-6 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={onToggleActive}
          className={`rounded px-2 py-1 ${
            active ? 'bg-accent-blue text-white' : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700'
          }`}
        >
          {active ? 'Exit replay' : 'Replay'}
        </button>

        {active && bars.length > 0 && (
          <>
            <button
              onClick={() => onCursorIndexChange(Math.max(0, cursorIndex - 1))}
              disabled={cursorIndex <= 0}
              className="rounded bg-neutral-800 px-2 py-1 text-neutral-300 hover:bg-neutral-700 disabled:opacity-40"
            >
              &larr; Step
            </button>
            <button
              onClick={onTogglePlaying}
              className="rounded bg-neutral-800 px-2 py-1 text-neutral-300 hover:bg-neutral-700"
            >
              {isPlaying ? 'Pause' : 'Play'}
            </button>
            <button
              onClick={() => onCursorIndexChange(Math.min(lastIndex, cursorIndex + 1))}
              disabled={cursorIndex >= lastIndex}
              className="rounded bg-neutral-800 px-2 py-1 text-neutral-300 hover:bg-neutral-700 disabled:opacity-40"
            >
              Step &rarr;
            </button>

            <select
              value={speed}
              onChange={(e) => onSpeedChange(Number(e.target.value))}
              className="rounded bg-neutral-800 px-1.5 py-1 text-neutral-200"
            >
              {SPEEDS.map((s) => (
                <option key={s} value={s}>
                  {s}x
                </option>
              ))}
            </select>

            <input
              type="range"
              min={0}
              max={lastIndex}
              value={cursorIndex}
              onChange={(e) => onCursorIndexChange(Number(e.target.value))}
              className="min-w-[160px] flex-1 accent-blue-600"
            />

            {cursorBar && <span className="whitespace-nowrap font-mono text-neutral-400">{fmtTime(cursorBar.time)}</span>}
          </>
        )}
      </div>

      {active && (
        <div className="mt-1.5 flex flex-wrap items-center gap-4 text-neutral-400">
          <span>
            Running: <span className={runningPnl >= 0 ? 'text-accent-green' : 'text-accent-red'}>{fmtUsd(runningPnl)}</span>{' '}
            <span className="text-neutral-500">({runningR.toFixed(2)}R)</span>
          </span>
          {equity ? (
            <>
              <span>
                Equity: <span className="text-neutral-200">{fmtUsd(equity.equity)}</span>
              </span>
              <span>
                MLL floor: <span className="text-neutral-200">{fmtUsd(equity.mll_floor)}</span>
              </span>
              <span>
                Distance to breach:{' '}
                <span className={equity.equity - equity.mll_floor > 0 ? 'text-neutral-200' : 'text-accent-red'}>
                  {fmtUsd(equity.equity - equity.mll_floor)}
                </span>
              </span>
            </>
          ) : (
            <span className="text-neutral-600">No equity data at cursor</span>
          )}
        </div>
      )}
    </div>
  )
}
