// FXR_SPEC.md section F, phase F7b: the optional "no rewind past a placed
// trade" lock. Pure and framework-free like replay.ts -- the workspace asks
// "may the cursor go to index i?", the backend enforces the same floor on
// save (bt_session_service.update_cursor), and this is tested on its own.
import type { Bar } from '../api/types'

// Index of the bar the first trade was placed on, in the CURRENTLY loaded bars
// (a re-anchored window re-indexes everything, so only the time is durable --
// same reasoning as resyncCursorIndex). Latest bar at or before the floor
// time; 0 when the window starts after it (every loaded bar is already past
// the floor, so the lock can't bind within it).
export function lockFloorIndex(bars: Bar[], floorTime: number | null): number {
  if (floorTime === null || bars.length === 0) return 0
  let best = 0
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].time <= floorTime) best = i
    else break
  }
  return best
}

// Whether moving the cursor to `targetIndex` is refused. Moving forward, or
// back to (not past) the placement bar, is always fine.
export function isRewindBlocked(lockOn: boolean, floorTime: number | null, bars: Bar[], targetIndex: number): boolean {
  if (!lockOn || floorTime === null) return false
  return targetIndex < lockFloorIndex(bars, floorTime)
}

export const REWIND_BLOCKED_MESSAGE =
  "Discipline lock is on: the replay can't go back past the bar where you placed your first trade."
