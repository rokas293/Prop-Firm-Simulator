import { useEffect, useRef, useState } from 'react'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from 'cmdk'
import { ChevronDown } from 'lucide-react'
import { useRuns } from '../api/hooks'
import { useUiStore } from '../state/uiStore'
import { INSTRUMENTS } from '../chart/kl/instruments'
import { POPOVER_SHELL } from '../components/popoverStyles'

// REPLICA_ROADMAP.md Batch 4's symbol search -- TradingView-style: a
// compact trigger showing the current symbol, opening an ANCHORED
// dropdown (not a centered modal like CommandPalette/IndicatorDialog --
// this reads as part of the toolbar, not a separate overlay) with a
// search box and the matching instruments. Reuses cmdk (same library, same
// [cmdk-item]/[cmdk-group-heading] global styles from index.css) but its
// own small popover shell rather than the shared .propbt-cmdk-content,
// since that one is sized/positioned for a centered dialog.
//
// "Switching symbol" means the same thing CommandPalette's own
// "Switch instrument" entries already do (confirmed there first, reused
// here rather than reinvented): jump to that instrument's first run. This
// app has no free-floating "symbol" independent of a loaded run.
export default function SymbolSearch() {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)

  const { data: runs } = useRuns()
  const selectedRunId = useUiStore((s) => s.selectedRunId)
  const selectRun = useUiStore((s) => s.selectRun)

  const currentRun = (runs ?? []).find((r) => r.run_id === selectedRunId)
  const availableSymbols = INSTRUMENTS.filter((i) => (runs ?? []).some((r) => r.instrument === i.symbol))

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false)
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  const pick = (symbol: string) => {
    const firstRun = (runs ?? []).find((r) => r.instrument === symbol)
    if (firstRun) selectRun(firstRun.run_id)
    setOpen(false)
    setSearch('')
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={`Symbol: ${currentRun?.instrument ?? 'none selected'}`}
        className="flex h-7 items-center gap-1 rounded bg-surface-2 px-2 text-xs font-medium text-text hover:bg-surface-2-hover"
      >
        {currentRun?.instrument ?? 'Symbol'}
        <ChevronDown size={13} className="text-text-muted" />
      </button>

      {open && (
        <Command shouldFilter label="Symbol search" className={`${POPOVER_SHELL} absolute left-0 top-full z-30 mt-1 w-64`}>
          <CommandInput
            autoFocus
            value={search}
            onValueChange={setSearch}
            placeholder="Search symbol…"
            className="propbt-cmdk-input"
          />
          <CommandList className="max-h-72 overflow-y-auto p-2">
            <CommandEmpty className="propbt-cmdk-empty">No matching symbol.</CommandEmpty>
            <CommandGroup heading="Symbols">
              {availableSymbols.map((inst) => {
                const active = currentRun?.instrument === inst.symbol
                return (
                  <CommandItem
                    key={inst.symbol}
                    value={`${inst.symbol} ${inst.description}`}
                    onSelect={() => pick(inst.symbol)}
                    className={`!flex !items-center !justify-between !gap-3 ${active ? '!text-accent' : ''}`}
                  >
                    <span className="font-medium">{inst.symbol}</span>
                    <span className="flex-1 truncate text-right text-text-muted">{inst.description}</span>
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      )}
    </div>
  )
}
