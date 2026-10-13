// FXR_V2_SPEC.md section 7 (G9): named chart layouts, saved per session. A layout is the
// indicators on, the chart type and timeframe, and which drawings are visible; loading one
// puts the chart back exactly there. One quiet popover off the chart toolbar, like Go To.
import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { POPOVER_FORM_PADDING, POPOVER_SHELL } from '../components/popoverStyles'

export interface LayoutsProps {
  layouts: { id: string; name: string }[]
  onSave: (name: string) => void
  onLoad: (id: string) => void
  onDelete: (id: string) => void
}

const GHOST =
  'flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded px-2 text-xs text-text-muted transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent'

export default function LayoutsMenu({ layouts, onSave, onLoad, onDelete }: LayoutsProps) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const save = () => {
    const trimmed = name.trim()
    if (!trimmed) return
    onSave(trimmed)
    setName('')
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="A layout keeps the indicators, chart type, timeframe and visible drawings"
        aria-label={`Layouts, ${layouts.length} saved`}
        className={`${GHOST} ${open ? 'bg-surface-2 text-text' : ''}`}
      >
        Layouts
        {layouts.length > 0 && <span className="tabular-nums text-text-muted">{layouts.length}</span>}
      </button>
      {open && (
        <div role="dialog" aria-label="Chart layouts" className={`${POPOVER_SHELL} ${POPOVER_FORM_PADDING} absolute left-0 top-9 z-30 w-64`}>
          <div className="micro-label mb-2">Layouts in this session</div>
          {layouts.length === 0 ? (
            <p className="mb-3 text-text-muted">No saved layouts.</p>
          ) : (
            <ul className="mb-3 flex flex-col">
              {layouts.map((l) => (
                <li key={l.id} className="group flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      onLoad(l.id)
                      setOpen(false)
                    }}
                    title="Load this layout"
                    className="h-7 min-w-0 flex-1 truncate rounded px-1 text-left text-text hover:bg-surface-2-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                  >
                    {l.name}
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete(l.id)}
                    aria-label={`Delete layout ${l.name}`}
                    className="flex h-7 w-7 flex-none items-center justify-center rounded text-text-muted opacity-0 hover:bg-surface-2-hover hover:text-text focus-visible:opacity-100 group-hover:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                  >
                    <X size={14} aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <form
            className="flex items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault()
              save()
            }}
          >
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Layout name"
              aria-label="Layout name"
              maxLength={40}
              className="propbt-input propbt-input--well min-w-0 flex-1"
            />
            <button
              type="submit"
              disabled={!name.trim()}
              className="h-7 flex-none rounded px-2 text-text-muted hover:bg-surface-2-hover hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40"
            >
              Save
            </button>
          </form>
        </div>
      )}
    </div>
  )
}
