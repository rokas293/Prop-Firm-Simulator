import { useEffect, useMemo, useState } from 'react'
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from 'cmdk'
import { useRuns, useTrades } from '../api/hooks'
import { useUiStore } from '../state/uiStore'
import { useTradeStore } from '../state/tradeStore'
import { useChartViewStore } from '../state/chartViewStore'
import { useWorkspaceApiStore } from '../state/workspaceApiStore'
import { isShortcut } from '../keyboard/shortcuts'
import { PRESETS } from './presets'
import { CHART_PANEL_ID, PANEL_DEFS } from './panelIds'
import { fmtUsd } from '../format'

// Global fuzzy command palette (POLISH_ROADMAP Phase P1), opened with
// Cmd/Ctrl-K from anywhere in the app. A flat, single-level list rather
// than cmdk's optional nested "pages" pattern -- simpler, and every action
// here is already a single pick (a run, a panel, a layout), not a
// multi-step flow.
export default function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')

  const selectedRunId = useUiStore((s) => s.selectedRunId)
  const selectRun = useUiStore((s) => s.selectRun)
  const selectTrade = useTradeStore((s) => s.selectTrade)
  const selectTradeView = useChartViewStore((s) => s.selectTradeView)
  const toggleReplay = useChartViewStore((s) => s.toggleReplay)
  const workspaceApi = useWorkspaceApiStore((s) => s.api)

  const { data: runs } = useRuns()
  const { data: trades } = useTrades(selectedRunId)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (isShortcut(e, 'openPalette')) {
        e.preventDefault()
        setOpen((o) => !o)
      } else if (isShortcut(e, 'closeOverlay')) {
        setOpen(false)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const run = (fn: () => void) => {
    fn()
    setOpen(false)
    setSearch('')
  }

  const instruments = useMemo(() => [...new Set((runs ?? []).map((r) => r.instrument))].sort(), [runs])

  // Recognizes "trade 42" or "#42" as a request to jump to that trade_id
  // in the current run. Requires an explicit "trade"/"#" marker (not a
  // bare number) so typing digits for any other reason -- searching a run
  // by date, say -- doesn't spuriously suggest a trade jump.
  const tradeJumpMatch = search.match(/(?:trade\s*#?|#)\s*(\d+)\s*$/i)
  const jumpTradeId = tradeJumpMatch ? Number(tradeJumpMatch[1]) : null
  const jumpTarget = jumpTradeId !== null ? trades?.find((t) => t.trade_id === jumpTradeId) : undefined

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      label="Command palette"
      shouldFilter
      contentClassName="propbt-cmdk-content"
      overlayClassName="propbt-cmdk-overlay"
    >
      <CommandInput
        value={search}
        onValueChange={setSearch}
        placeholder="Open a run, jump to trade #, switch layout…"
        className="propbt-cmdk-input"
      />
      <CommandList className="propbt-cmdk-list">
        <CommandEmpty className="propbt-cmdk-empty">No matching command.</CommandEmpty>

        {jumpTarget && selectedRunId && (
          <CommandGroup heading="Trade">
            <CommandItem
              value={`jump-trade-${jumpTarget.trade_id}`}
              onSelect={() =>
                run(() => {
                  selectTrade(jumpTarget.trade_id)
                  selectTradeView()
                  workspaceApi?.getPanel(CHART_PANEL_ID)?.api.setActive()
                })
              }
            >
              Jump to trade #{jumpTarget.trade_id} ({jumpTarget.side}, {jumpTarget.leg ?? 'unknown leg'},{' '}
              {fmtUsd(jumpTarget.pnl_usd)})
            </CommandItem>
          </CommandGroup>
        )}

        <CommandGroup heading="Runs">
          {(runs ?? []).map((r) => (
            <CommandItem key={r.run_id} value={`open-run-${r.run_id}-${r.instrument}`} onSelect={() => run(() => selectRun(r.run_id))}>
              Open run: {r.instrument} · {r.date_from} → {r.date_to} ({r.run_id})
            </CommandItem>
          ))}
        </CommandGroup>

        {instruments.length > 0 && (
          <CommandGroup heading="Instruments">
            {instruments.map((inst) => {
              const firstRun = (runs ?? []).find((r) => r.instrument === inst)
              if (!firstRun) return null
              return (
                <CommandItem
                  key={inst}
                  value={`switch-instrument-${inst}`}
                  onSelect={() => run(() => selectRun(firstRun.run_id))}
                >
                  Switch instrument: {inst}
                </CommandItem>
              )
            })}
          </CommandGroup>
        )}

        {selectedRunId && (
          <CommandGroup heading="Chart">
            <CommandItem value="toggle-replay" onSelect={() => run(toggleReplay)}>
              Toggle replay
            </CommandItem>
          </CommandGroup>
        )}

        {selectedRunId && workspaceApi && (
          <CommandGroup heading="Layout">
            {PRESETS.map((p) => (
              <CommandItem
                key={p.name}
                value={`switch-layout-${p.name}`}
                onSelect={() => run(() => p.apply(workspaceApi))}
              >
                Switch layout: {p.name}
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {selectedRunId && workspaceApi && (
          <CommandGroup heading="Panels">
            {PANEL_DEFS.filter((p) => !workspaceApi.getPanel(p.id)).map((p) => (
              <CommandItem
                key={p.id}
                value={`add-panel-${p.id}`}
                onSelect={() =>
                  run(() => workspaceApi.addPanel({ id: p.id, component: p.component, title: p.title }))
                }
              >
                Add panel: {p.title}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  )
}
