import { useEffect, useState } from 'react'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from 'cmdk'
import { Check, LineChart } from 'lucide-react'
import { useIndicatorStore, type IndicatorPrefs } from '../state/indicatorStore'
import { isShortcut } from '../keyboard/shortcuts'

// REPLICA_ROADMAP.md Batch 3's "indicator dialog for adding, with search"
// -- replaces the old always-visible checkbox row (IndicatorTogglePanel)
// with the same searchable-list pattern the command palette already uses
// (cmdk, .propbt-cmdk-* chrome from index.css -- zero new CSS). Unlike the
// palette, picking an item here does NOT close the dialog: every entry is
// a toggle you might flip several times in one visit, not a one-shot
// command.
//
// The catalog is deliberately just the SIX existing indicatorStore prefs
// (plus the newly-added `volume`) -- CLAUDE.md's engine-truth rule (and
// this file's own header comment in indicators.ts) rules out adding
// klinecharts' OWN built-in MA/EMA/ATR formulas as new options here: only
// what's already a backend pass-through or a zero-computation built-in
// (VOL) is offered. No calc-param inputs either -- these are fixed-logic
// server-computed series, not tunable studies.
interface IndicatorItem {
  key: keyof IndicatorPrefs
  label: string
  description: string
  placement: 'Overlay on price' | 'New pane'
}

const CATALOG: IndicatorItem[] = [
  { key: 'sessionShading', label: 'Session shading', description: 'Background tint per session (Asia/London/NY)', placement: 'Overlay on price' },
  { key: 'fairValue', label: 'Fair value', description: 'Reference price line at each session/news open', placement: 'Overlay on price' },
  { key: 'vwap', label: 'VWAP', description: 'Session volume-weighted average price', placement: 'Overlay on price' },
  { key: 'ema20', label: 'EMA 20', description: 'Exponential moving average, 20-period', placement: 'Overlay on price' },
  { key: 'ema50', label: 'EMA 50', description: 'Exponential moving average, 50-period', placement: 'Overlay on price' },
  { key: 'atr14', label: 'ATR(14)', description: 'Average true range, 14-period', placement: 'New pane' },
  { key: 'volume', label: 'Volume', description: "Each bar's own volume", placement: 'New pane' },
]

export default function IndicatorDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [search, setSearch] = useState('')
  const prefs = useIndicatorStore()
  const toggle = useIndicatorStore((s) => s.toggle)

  // Same global-listener close pattern CommandPalette.tsx uses (not an
  // onKeyDown prop on the Command element) -- confirmed live that Escape
  // typed into CommandInput doesn't reliably bubble up to a handler on the
  // wrapping Command component here, which left the dialog (and its
  // overlay, which sits ABOVE the chart) stuck open and silently eating
  // every subsequent mouse event over the chart.
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (isShortcut(e, 'closeOverlay')) onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="propbt-cmdk-overlay" onClick={onClose}>
      <Command shouldFilter label="Indicators" className="propbt-cmdk-content" onClick={(e) => e.stopPropagation()}>
        <CommandInput value={search} onValueChange={setSearch} placeholder="Search indicators…" className="propbt-cmdk-input" />
        <CommandList className="propbt-cmdk-list">
          <CommandEmpty className="propbt-cmdk-empty">No matching indicator.</CommandEmpty>
          <CommandGroup heading="Indicators">
            {CATALOG.map((item) => {
              const active = prefs[item.key]
              return (
                <CommandItem
                  key={item.key}
                  value={`${item.label} ${item.description}`}
                  onSelect={() => toggle(item.key)}
                  className="!flex !items-center !justify-between !gap-3"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className={`flex h-4 w-4 flex-none items-center justify-center ${active ? 'text-accent-fg' : 'text-transparent'}`}>
                      <Check size={14} />
                    </span>
                    <LineChart size={14} className="flex-none text-text-muted" />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-text">{item.label}</span>
                      <span className="truncate text-[11px] text-text-muted">{item.description}</span>
                    </span>
                  </span>
                  <span className="micro-label flex-none text-text-muted">{item.placement}</span>
                </CommandItem>
              )
            })}
          </CommandGroup>
        </CommandList>
      </Command>
    </div>
  )
}
