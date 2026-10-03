import { useState } from 'react'
import { usePrefetchRun, useRuns } from '../api/hooks'
import { useUiStore } from '../state/uiStore'
import Skeleton from '../components/Skeleton'

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

  // DESIGN_AUDIT.md global sweep: this is the app's actual entry screen
  // (the first thing rendered on load), so a bare "Loading runs…" line was
  // the least-shaped loading state in the app -- shaped like the table
  // that's about to replace it instead, matching Trade List's own skeleton
  // pattern.
  if (isLoading) {
    return (
      <div className="p-6">
        <Skeleton className="mb-4 h-6 w-24" />
        <div className="flex flex-col gap-2">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-8" />
          ))}
        </div>
      </div>
    )
  }
  if (isError) {
    // DESIGN_AUDIT.md follow-up re-audit, item 2: color the status, not the
    // surrounding detail (DESIGN_LANGUAGE.md section 9) -- only "Failed to
    // load runs" is negative now; the raw exception text is secondary/muted,
    // same as any other supporting detail next to a colored status word.
    return (
      <div className="p-6">
        <span className="text-negative">Failed to load runs</span>
        <span className="text-text-muted">: {(error as Error).message}</span>
      </div>
    )
  }
  if (!runs || runs.length === 0) {
    return (
      <div className="p-6 text-text-muted">
        No runs yet. Generate one with{' '}
        <code className="rounded bg-surface-2 px-1 py-1 text-text">
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
          <div className="flex items-center gap-2 text-sm text-text-muted">
            <span>{compareSelection.length} / 2 selected for compare</span>
            <button
              onClick={() => setCompareSelection([])}
              className="rounded bg-surface-2 px-2 py-1 text-text hover:bg-surface-2-hover"
            >
              Clear
            </button>
            <button
              onClick={() => setCompareRunIds([compareSelection[0], compareSelection[1]])}
              disabled={compareSelection.length !== 2}
              className="rounded bg-accent px-3 py-1 text-white disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-text-muted"
            >
              Compare
            </button>
          </div>
        )}
      </div>
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="h-8 border-b border-border text-left">
            <th className="micro-label py-1 pr-4 text-left" title="Select up to 2 runs to compare">
              Cmp
            </th>
            <th className="micro-label py-1 pr-4 text-left">Run</th>
            <th className="micro-label py-1 pr-4 text-left">Instrument</th>
            <th className="micro-label py-1 pr-4 text-left">Date range</th>
            <th className="micro-label py-1 pr-4 text-left">Result</th>
            <th className="num micro-label py-1 pr-4">Params</th>
            <th className="micro-label py-1 pr-4 text-left"></th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr
              key={run.run_id}
              onMouseEnter={() => prefetchRun(run.run_id)}
              // Accessibility audit: the individual <td onClick> cells below
              // had no keyboard equivalent at all -- a plain <td> isn't
              // focusable and Enter/Space on it does nothing. One tab stop
              // for the whole row (matching TradeListPanel/BreakdownTable's
              // own row convention) rather than trying to make five separate
              // cells independently focusable for the same action.
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  selectRun(run.run_id)
                }
              }}
              className={`h-8 border-b border-border hover:bg-surface ${
                selectedRunId === run.run_id ? 'bg-surface' : ''
              }`}
            >
              <td className="pr-4">
                {/* No explicit accent-color class -- inherits the theme's
                    live accent-color from :root (POLISH_ROADMAP Phase P6). */}
                <input
                  type="checkbox"
                  checked={compareSelection.includes(run.run_id)}
                  onChange={() => toggleCompareSelection(run.run_id)}
                  onClick={(e) => e.stopPropagation()}
                />
              </td>
              <td className="cursor-pointer pr-4 tabular-nums text-text" onClick={() => selectRun(run.run_id)}>
                {run.run_id}
              </td>
              <td className="cursor-pointer pr-4" onClick={() => selectRun(run.run_id)}>
                {run.instrument}
              </td>
              <td className="cursor-pointer pr-4 text-text" onClick={() => selectRun(run.run_id)}>
                {run.date_from} &rarr; {run.date_to}
              </td>
              <td className="cursor-pointer pr-4" onClick={() => selectRun(run.run_id)}>
                {run.result.passed ? (
                  <span className="text-positive">PASSED</span>
                ) : run.result.fail_reason ? (
                  // DESIGN_AUDIT.md follow-up re-audit, item R3: color the
                  // status word only, not the parenthetical detail --
                  // matches the error-state fix above.
                  <>
                    <span className="text-negative">FAILED</span>
                    <span className="text-text-muted"> ({run.result.fail_reason})</span>
                  </>
                ) : (
                  <span className="text-negative">INCOMPLETE</span>
                )}
              </td>
              <td className="num cursor-pointer pr-4 text-text" onClick={() => selectRun(run.run_id)}>
                {run.params_count}
              </td>
              <td className="pr-4">
                <a
                  href={`/api/runs/${run.run_id}/export.html`}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="text-xs text-text-muted underline hover:text-text"
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
