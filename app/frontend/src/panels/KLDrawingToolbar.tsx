import { useState, type RefObject } from 'react'
import { DRAWING_TOOLS, type DrawingGroup } from '../chart/kl/drawingOverlays'
import type { ChartKLHandle } from '../chart/kl/ChartKL'
import type { PersistedOverlay } from '../chart/kl/drawingOverlays'
import { DRAWING_SHORTCUTS } from '../keyboard/shortcuts'

const GROUP_ORDER: DrawingGroup[] = ['lines', 'fibonacci', 'shapes', 'annotations']
const GROUP_LABELS: Record<DrawingGroup, string> = {
  lines: 'Lines',
  fibonacci: 'Fibonacci',
  shapes: 'Shapes',
  annotations: 'Notes',
}

// The TradeSea/Topstep-style left drawing toolbar (Phase A2), docked to
// the KL chart panel. Every button just calls the chart's own
// createOverlay via ChartKLHandle.startDrawing -- point-by-point placement,
// drag-to-edit, and selection are all klinecharts' own overlay system, not
// anything built here (see ChartKL.tsx's startDrawing/cancelActiveDrawing).
export default function KLDrawingToolbar({
  klChartRef,
  drawings,
}: {
  klChartRef: RefObject<ChartKLHandle | null>
  drawings: PersistedOverlay[]
}) {
  const [manageOpen, setManageOpen] = useState(false)

  return (
    <div className="flex h-full w-32 flex-none flex-col border-r border-border bg-bg text-xs">
      <div className="flex-1 overflow-y-auto py-2">
        {GROUP_ORDER.map((group) => (
          <div key={group} className="mb-2">
            <div className="px-2 pb-1 text-[10px] uppercase tracking-wide text-text-muted">{GROUP_LABELS[group]}</div>
            {DRAWING_TOOLS.filter((t) => t.group === group).map((tool) => {
              const shortcutKey = Object.entries(DRAWING_SHORTCUTS).find(([, name]) => name === tool.name)?.[0]
              return (
                <button
                  key={tool.name}
                  onClick={() => klChartRef.current?.startDrawing(tool.name)}
                  title={shortcutKey ? `${tool.label} (${shortcutKey.toUpperCase()})` : tool.label}
                  className="block w-full px-2 py-1 text-left text-text hover:bg-surface-2"
                >
                  {tool.label}
                </button>
              )
            })}
          </div>
        ))}
      </div>

      {/* Outside the scrollable tool list (not `mt-auto` inside it) so the
          manage button stays reachable without scrolling past ~20 tools. */}
      <div className="flex-none border-t border-border py-2">
        <div className="relative px-2">
          <button
            onClick={() => setManageOpen((o) => !o)}
            className="w-full rounded bg-surface-2 px-2 py-1 text-left text-text hover:bg-surface-2-hover"
          >
            Drawings ({drawings.length})
          </button>
          {manageOpen && (
            <div className="absolute bottom-full left-2 z-10 mb-1 w-48 rounded border border-border bg-surface py-1 shadow-lg">
              {drawings.length === 0 ? (
                // POLISH_ROADMAP Phase P6: a helpful empty state rather than
                // an empty dropdown (previously this button was just
                // `disabled` at 0, so there was nothing to open at all).
                <div className="px-3 py-2 text-text-muted">No drawings yet -- pick a tool above to start.</div>
              ) : (
                <>
                  {drawings.map((d) => (
                    <div key={d.id} className="flex items-center justify-between px-3 py-1.5 hover:bg-surface-2">
                      <span className="truncate text-text">
                        {DRAWING_TOOLS.find((t) => t.name === d.name)?.label ?? d.name}
                      </span>
                      <button
                        onClick={() => klChartRef.current?.removeDrawing(d.id)}
                        className="ml-2 shrink-0 text-text-muted hover:text-negative"
                      >
                        Delete
                      </button>
                    </div>
                  ))}
                  <div className="mt-1 border-t border-border px-3 pt-1.5">
                    <button
                      onClick={() => {
                        klChartRef.current?.clearDrawings()
                        setManageOpen(false)
                      }}
                      className="text-text-muted hover:text-negative"
                    >
                      Clear all
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
