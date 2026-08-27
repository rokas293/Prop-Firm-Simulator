// Wraps a subtree in React's Profiler API, feeding render durations into
// perfStore for the perf HUD (POLISH_ROADMAP Phase P4). Only mounts the
// actual <Profiler> (which carries its own small measurement overhead even
// when nobody's looking at the numbers) while the HUD is toggled on --
// otherwise this is a no-op passthrough.
import { Profiler, type ReactNode } from 'react'
import { usePerfStore } from '../state/perfStore'

export default function PerfProfiler({ id, children }: { id: string; children: ReactNode }) {
  const enabled = usePerfStore((s) => s.enabled)
  const recordRender = usePerfStore((s) => s.recordRender)

  if (!enabled) return <>{children}</>

  return (
    <Profiler id={id} onRender={(_id, phase, actualDuration) => recordRender(id, phase, actualDuration)}>
      {children}
    </Profiler>
  )
}
