import { useRuns } from '../api/hooks'
import { useUiStore } from '../state/uiStore'

export default function RunsListPage() {
  const { data: runs, isLoading, isError, error } = useRuns()
  const selectedRunId = useUiStore((s) => s.selectedRunId)
  const selectRun = useUiStore((s) => s.selectRun)

  if (isLoading) {
    return <div className="p-6 text-neutral-400">Loading runs…</div>
  }
  if (isError) {
    return <div className="p-6 text-red-400">Failed to load runs: {(error as Error).message}</div>
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
      <h1 className="mb-4 text-xl font-semibold">Runs</h1>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-neutral-800 text-left text-neutral-400">
            <th className="py-2 pr-4 font-medium">Run</th>
            <th className="py-2 pr-4 font-medium">Instrument</th>
            <th className="py-2 pr-4 font-medium">Date range</th>
            <th className="py-2 pr-4 font-medium">Result</th>
            <th className="py-2 pr-4 font-medium">Params</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr
              key={run.run_id}
              onClick={() => selectRun(run.run_id)}
              className={`cursor-pointer border-b border-neutral-900 hover:bg-neutral-900 ${
                selectedRunId === run.run_id ? 'bg-neutral-900' : ''
              }`}
            >
              <td className="py-2 pr-4 font-mono text-xs text-neutral-300">{run.run_id}</td>
              <td className="py-2 pr-4">{run.instrument}</td>
              <td className="py-2 pr-4 text-neutral-300">
                {run.date_from} &rarr; {run.date_to}
              </td>
              <td className="py-2 pr-4">
                {run.result.passed ? (
                  <span className="text-green-400">PASSED</span>
                ) : (
                  <span className="text-red-400">
                    {run.result.fail_reason ? `FAILED (${run.result.fail_reason})` : 'INCOMPLETE'}
                  </span>
                )}
              </td>
              <td className="py-2 pr-4 text-neutral-300">{run.params_count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
