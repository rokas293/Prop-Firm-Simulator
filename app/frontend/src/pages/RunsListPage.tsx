import { useState } from 'react'
import { usePrefetchRun, useRuns } from '../api/hooks'
import { useUiStore } from '../state/uiStore'

export default function RunsListPage() {
  const { data: runs, isLoading, isError, error } = useRuns()
  const selectedRunId = useUiStore((s) => s.selectedRunId)
  const selectRun = useUiStore((s) => s.selectRun)
  const setCompareRunIds = useUiStore((s) => s.setCompareRunIds)
  const prefetchRun = usePrefetchRun()

  const [compareSelection, setCompareSelection] = useState<string[]>([])

  const toggleCompareSelection = (runId: string) => {
    setCompareSelection((prev) => {
      if (prev.includes(runId)) return prev.filter((id) => id !== runId)
      if (prev.length >= 2) return [prev[1], runId] // keep it a rolling window of 2
      return [...prev, runId]
    })
  }

  if (isLoading) {
    return <div className="p-6 text-neutral-400">Loading runs…</div>
  }
  if (isError) {
    return <div className="p-6 text-accent-red">Failed to load runs: {(error as Error).message}</div>
  }
  if (!runs || runs.length === 0) {
    return (
      <div className="p-6 text-neutral-400">
        No runs yet. Generate one with{' '}
        <code className="rounded bg-neutral-800 px-1.5 py-0.5 text-neutral-200">
          python run.py review --config propbt/config/strategy.yaml
        </code>
        .
      </div>
    )
  }

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Runs</h1>
        {compareSelection.length > 0 && (
          <div className="flex items-center gap-2 text-sm text-neutral-400">
            <span>{compareSelection.length} / 2 selected for compare</span>
            <button
              onClick={() => setCompareSelection([])}
              className="rounded bg-neutral-800 px-2 py-1 text-neutral-300 hover:bg-neutral-700"
            >
              Clear
            </button>
            <button
              onClick={() => setCompareRunIds([compareSelection[0], compareSelection[1]])}
              disabled={compareSelection.length !== 2}
              className="rounded bg-accent-blue px-3 py-1 text-white disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500"
            >
              Compare
            </button>
          </div>
        )}
      </div>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-neutral-800 text-left text-neutral-400">
            <th className="py-2 pr-4 font-medium" title="Select up to 2 runs to compare">
              Cmp
            </th>
            <th className="py-2 pr-4 font-medium">Run</th>
            <th className="py-2 pr-4 font-medium">Instrument</th>
            <th className="py-2 pr-4 font-medium">Date range</th>
            <th className="py-2 pr-4 font-medium">Result</th>
            <th className="py-2 pr-4 font-medium">Params</th>
            <th className="py-2 pr-4 font-medium"></th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr
              key={run.run_id}
              onMouseEnter={() => prefetchRun(run.run_id)}
              className={`border-b border-neutral-900 hover:bg-neutral-900 ${
                selectedRunId === run.run_id ? 'bg-neutral-900' : ''
              }`}
            >
              <td className="py-2 pr-4">
                {/* No explicit accent-color class -- inherits the theme's
                    live accent-color from :root (POLISH_ROADMAP Phase P6). */}
                <input
                  type="checkbox"
                  checked={compareSelection.includes(run.run_id)}
                  onChange={() => toggleCompareSelection(run.run_id)}
                  onClick={(e) => e.stopPropagation()}
                />
              </td>
              <td className="cursor-pointer py-2 pr-4 font-mono text-xs text-neutral-300" onClick={() => selectRun(run.run_id)}>
                {run.run_id}
              </td>
              <td className="cursor-pointer py-2 pr-4" onClick={() => selectRun(run.run_id)}>
                {run.instrument}
              </td>
              <td className="cursor-pointer py-2 pr-4 text-neutral-300" onClick={() => selectRun(run.run_id)}>
                {run.date_from} &rarr; {run.date_to}
              </td>
              <td className="cursor-pointer py-2 pr-4" onClick={() => selectRun(run.run_id)}>
                {run.result.passed ? (
                  <span className="text-accent-green">PASSED</span>
                ) : (
                  <span className="text-accent-red">
                    {run.result.fail_reason ? `FAILED (${run.result.fail_reason})` : 'INCOMPLETE'}
                  </span>
                )}
              </td>
              <td className="cursor-pointer py-2 pr-4 text-neutral-300" onClick={() => selectRun(run.run_id)}>
                {run.params_count}
              </td>
              <td className="py-2 pr-4">
                <a
                  href={`/api/runs/${run.run_id}/export.html`}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="text-xs text-neutral-500 underline hover:text-neutral-300"
                  title="Export a self-contained static HTML snapshot of this run"
                >
                  Export
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
