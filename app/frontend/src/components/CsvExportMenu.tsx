// FXR_V2_SPEC.md section 7 (G9): "Export CSV" -- the trades with their journal fields, for
// the session in view or for every session. Used by the Analytics page and the journal.
import { useEffect, useRef, useState } from 'react'
import { Download } from 'lucide-react'
import { tradesCsvUrl } from '../analytics/tradesCsv'
import { POPOVER_MENU_ROW, POPOVER_SHELL } from './popoverStyles'

export default function CsvExportMenu({ sessionId, align = 'right' }: { sessionId: string | null; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false)
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

  const items = [
    ...(sessionId ? [{ key: 'one', label: 'This session', href: tradesCsvUrl(sessionId) }] : []),
    { key: 'all', label: 'All sessions', href: tradesCsvUrl(null) },
  ]
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Download the trades with their journal fields as a CSV"
        className={`flex h-7 items-center gap-1 rounded px-2 text-xs transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
          open ? 'bg-surface-2 text-text' : 'text-text-muted hover:bg-surface-2 hover:text-text'
        }`}
      >
        <Download size={14} aria-hidden />
        Export CSV
      </button>
      {open && (
        <div role="menu" aria-label="Export CSV" className={`${POPOVER_SHELL} absolute top-9 z-30 w-40 py-1 ${align === 'right' ? 'right-0' : 'left-0'}`}>
          {items.map((it) => (
            <a key={it.key} role="menuitem" href={it.href} download onClick={() => setOpen(false)} className={POPOVER_MENU_ROW}>
              {it.label}
            </a>
          ))}
        </div>
      )}
    </div>
  )
}
