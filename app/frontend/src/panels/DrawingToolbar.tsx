import { useState } from 'react'
import { drawingsForInstrument, useDrawingStore, type DrawingType } from '../state/drawingStore'

const TOOLS: { type: DrawingType; label: string }[] = [
  { type: 'hline', label: 'H-Line' },
  { type: 'ray', label: 'Ray' },
  { type: 'trendline', label: 'Trend' },
  { type: 'rect', label: 'Zone' },
  { type: 'measure', label: 'Measure' },
]

// Tool selection + a manage-drawings dropdown (POLISH_ROADMAP Phase P2).
// Placing a point happens on the chart itself (PriceChart's click
// handler); this is purely the tool picker + the "individually deletable"
// requirement's UI.
export default function DrawingToolbar({ instrument }: { instrument: string | null }) {
  const activeTool = useDrawingStore((s) => s.activeTool)
  const setActiveTool = useDrawingStore((s) => s.setActiveTool)
  const pendingPoint = useDrawingStore((s) => s.pendingPoint)
  const cancelDrawing = useDrawingStore((s) => s.cancelDrawing)
  const drawings = useDrawingStore((s) => s.drawings)
  const removeDrawing = useDrawingStore((s) => s.removeDrawing)
  const clearForInstrument = useDrawingStore((s) => s.clearForInstrument)

  const [manageOpen, setManageOpen] = useState(false)

  const mine = drawingsForInstrument(drawings, instrument)

  return (
    <div className="flex items-center gap-1 text-xs">
      {TOOLS.map((t) => (
        <button
          key={t.type}
          onClick={() => setActiveTool(activeTool === t.type ? null : t.type)}
          title={`Draw ${t.label}`}
          className={`rounded px-2 py-1 ${
            activeTool === t.type ? 'bg-accent-blue text-white' : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700'
          }`}
        >
          {t.label}
        </button>
      ))}

      {activeTool && (
        <button
          onClick={cancelDrawing}
          className="rounded bg-neutral-800 px-2 py-1 text-neutral-400 hover:bg-neutral-700"
        >
          {pendingPoint ? 'Click end point…' : 'Cancel'}
        </button>
      )}

      <div className="relative">
        <button
          onClick={() => setManageOpen((o) => !o)}
          disabled={mine.length === 0}
          className="rounded bg-neutral-800 px-2 py-1 text-neutral-300 hover:bg-neutral-700 disabled:opacity-40"
        >
          Drawings ({mine.length})
        </button>
        {manageOpen && mine.length > 0 && (
          <div className="absolute right-0 top-full z-10 mt-1 w-56 rounded border border-neutral-700 bg-neutral-900 py-1 shadow-lg">
            {mine.map((d) => (
              <div key={d.id} className="flex items-center justify-between px-3 py-1.5 hover:bg-neutral-800">
                <span className="text-neutral-300">
                  {TOOLS.find((t) => t.type === d.type)?.label ?? d.type}
                  {d.type === 'hline' && ` @ ${d.points[0].price.toFixed(2)}`}
                </span>
                <button onClick={() => removeDrawing(d.id)} className="text-neutral-500 hover:text-accent-red">
                  Delete
                </button>
              </div>
            ))}
            <div className="mt-1 border-t border-neutral-800 px-3 pt-1.5">
              <button
                onClick={() => {
                  if (instrument) clearForInstrument(instrument)
                  setManageOpen(false)
                }}
                className="text-neutral-500 hover:text-accent-red"
              >
                Clear all
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
