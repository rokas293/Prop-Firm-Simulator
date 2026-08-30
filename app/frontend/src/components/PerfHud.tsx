// Tiny perf HUD (POLISH_ROADMAP Phase P4): "render time / fetch time while
// developing." Reads perfStore's ring buffers (populated by client.ts's
// request(), workers/barsWorkerClient.ts, and PerfProfiler-wrapped panels)
// and renders nothing at all unless toggled on -- see App.tsx's header
// button.
import { usePerfStore } from '../state/perfStore'

function avg(nums: number[]): number {
  return nums.length === 0 ? 0 : nums.reduce((a, b) => a + b, 0) / nums.length
}
function max(nums: number[]): number {
  return nums.length === 0 ? 0 : Math.max(...nums)
}

export default function PerfHud() {
  const enabled = usePerfStore((s) => s.enabled)
  const fetchSamples = usePerfStore((s) => s.fetchSamples)
  const renderSamples = usePerfStore((s) => s.renderSamples)

  if (!enabled) return null

  const fetchMs = fetchSamples.map((s) => s.ms)
  const renderMs = renderSamples.map((s) => s.ms)

  return (
    <div className="fixed bottom-3 right-3 z-[200] w-72 rounded border border-border bg-bg/95 p-3 font-mono text-[11px] leading-relaxed text-text shadow-lg">
      <div className="mb-2 text-text-muted">PERF HUD</div>

      <div className="mb-1 text-text-muted">
        Fetches n={fetchMs.length} avg {avg(fetchMs).toFixed(1)}ms max {max(fetchMs).toFixed(1)}ms
      </div>
      {fetchSamples
        .slice()
        .reverse()
        .slice(0, 6)
        .map((s, i) => (
          <div key={i} className="flex justify-between gap-2">
            <span className="truncate">{s.path}</span>
            <span className={s.ms > 200 ? 'text-warning' : ''}>{s.ms.toFixed(1)}ms</span>
          </div>
        ))}

      <div className="mb-1 mt-2 text-text-muted">
        Renders n={renderMs.length} avg {avg(renderMs).toFixed(1)}ms max {max(renderMs).toFixed(1)}ms
      </div>
      {renderSamples
        .slice()
        .reverse()
        .slice(0, 6)
        .map((s, i) => (
          <div key={i} className="flex justify-between gap-2">
            <span className="truncate">
              {s.id} ({s.phase})
            </span>
            <span className={s.ms > 16 ? 'text-warning' : ''}>{s.ms.toFixed(1)}ms</span>
          </div>
        ))}
    </div>
  )
}
