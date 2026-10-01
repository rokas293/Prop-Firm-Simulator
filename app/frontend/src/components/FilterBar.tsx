import { useEffect, useRef, useState, type ReactNode } from 'react'
import { SlidersHorizontal } from 'lucide-react'
import { activeFilterChips } from '../compass/filterChips'
import { useTradeStore } from '../state/tradeStore'
import { POPOVER_FORM_PADDING, POPOVER_SHELL } from './popoverStyles'

// The shared filter toolbar pieces (FXR phase F6 follow-up): a compact
// "Filters" popover that holds the form, and a chips row that always shows
// what is currently applied. Together they keep a filter toolbar to ONE row
// (DESIGN_LANGUAGE.md section 1/5: controls recede, the content is the point)
// without ever hiding that a filter is active (section 6: states are visible).

// A labeled form field inside the popover.
export function FilterField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="micro-label">{label}</span>
      {children}
    </label>
  )
}

export function FiltersPopover({
  count,
  children,
  align = 'left',
}: {
  count: number
  children: ReactNode
  align?: 'left' | 'right'
}) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // Same dismissal behavior as every other popover in the app (see
  // ChartLayoutMenu): outside press or Escape closes it.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={containerRef} className="relative flex-none">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={`flex h-7 items-center gap-1.5 rounded px-2 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
          open || count > 0 ? 'bg-surface-2 text-text' : 'text-text-muted hover:bg-surface-2 hover:text-text'
        }`}
      >
        <SlidersHorizontal size={14} />
        Filters
        {count > 0 && <span className="tabular-nums text-text-muted">{count}</span>}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Filters"
          className={`${POPOVER_SHELL} absolute top-full z-30 mt-1 w-[288px] max-w-[calc(100vw-32px)] ${POPOVER_FORM_PADDING} ${
            align === 'right' ? 'right-0' : 'left-0'
          }`}
        >
          <div className="grid grid-cols-2 gap-3">{children}</div>
          {count > 0 && (
            // "Clear all" lives here, not in the toolbar row: in a ~400px
            // column the row has no room for it next to a chip and the count.
            <div className="mt-3 flex justify-end">
              <button
                onClick={() => useTradeStore.getState().clearFilters()}
                className="h-7 rounded px-2 text-text-muted hover:bg-surface hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              >
                Clear all
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// What is applied right now, one removable chip per dimension. Neutral, not
// accent: the accent is reserved for the one primary action in a context
// (section 2), and a filter is state, not an action. Scrolls sideways instead
// of wrapping, so the row never grows.
// `maxVisible` keeps the row one line in a narrow column: the first few chips
// show, the rest collapse into a "+N" chip (its tooltip lists them), so an
// active filter is never scrolled out of sight.
export function FilterChips({ maxVisible = 1 }: { maxVisible?: number }) {
  const filters = useTradeStore((s) => s.filters)
  const setFilter = useTradeStore((s) => s.setFilter)
  const chips = activeFilterChips(filters)
  if (chips.length === 0) return null
  const shown = chips.slice(0, maxVisible)
  const hidden = chips.slice(maxVisible)
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1" aria-label="Active filters">
      {/* Only the chips scroll; "Clear" stays pinned so a narrow drawer can
          never cut it off. */}
      <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
        {shown.map((c) => (
          <span
            key={c.key}
            title={c.label}
            className="flex h-6 min-w-0 max-w-[168px] flex-none items-center gap-1 rounded bg-surface-2 pl-2 pr-1 text-xs text-text-muted"
          >
            <span className="truncate">{c.label}</span>
            <button
              onClick={() => setFilter(c.key, null as never)}
              aria-label={`Remove ${c.label} filter`}
              className="flex h-4 w-4 items-center justify-center rounded text-text-muted hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              &times;
            </button>
          </span>
        ))}
        {hidden.length > 0 && (
          <span
            title={hidden.map((c) => c.label).join(', ')}
            className="flex h-6 flex-none items-center rounded bg-surface-2 px-2 text-xs tabular-nums text-text-muted"
          >
            +{hidden.length}
          </span>
        )}
      </div>
    </div>
  )
}

export const FILTER_SELECT =
  'h-7 w-full rounded bg-surface px-2 text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent'
