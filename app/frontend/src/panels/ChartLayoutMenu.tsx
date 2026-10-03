import { useEffect, useRef, useState } from 'react'
import { LayoutPanelTop } from 'lucide-react'
import type { BracketDensity } from '../chart/tradeBracket'
import { POPOVER_FORM_PADDING, POPOVER_MENU_ROW, POPOVER_SHELL } from '../components/popoverStyles'
import { useWorkspaceApiStore } from '../state/workspaceApiStore'
import { useLayoutStore } from '../state/layoutStore'
import { applyAnalysisLayout, PRESETS } from '../workspace/presets'
import { PANEL_DEFS } from '../workspace/panelIds'

const BRACKET_DENSITIES: BracketDensity[] = ['auto', 'full', 'markers']
const BRACKET_LABEL: Record<BracketDensity, string> = { auto: 'Auto', full: 'Full', markers: 'Off' }
const BRACKET_TITLE: Record<BracketDensity, string> = {
  auto: 'Simplify narrow brackets to markers when zoomed out',
  full: 'Always show full brackets',
  markers: 'Always show markers only',
}

// REPLICA_ROADMAP.md Batch 4's "settings/layout" toolbar item -- the
// chart-display choices that are genuinely occasional (split view,
// bracket density), grouped into one popover instead of sitting
// permanently in the always-visible top row. Trade navigation (prev/next/
// fit/day) stays out of here on purpose: those are used constantly while
// reviewing a run, not "settings" -- burying them would hurt, not help.
//
// REPLICA_AUDIT.md Top 10 #8/#3 -- workspace-level layout presets and the
// "+ Panel" reopen list used to live in their own permanently-visible row
// above the chart (Workspace.tsx), duplicating Settings' own LAYOUT
// section for no reason other than "it was already there." Folded in here
// instead: one less permanent chrome row, and this popover already lives
// in the one place (the chart toolbar) that's on-screen in every layout.
// Settings keeps its own copy as the deep-link/discoverability path for
// someone who never notices this button.
export default function ChartLayoutMenu({
  splitView,
  onToggleSplitView,
  timeframes,
  timeframe,
  secondaryTimeframe,
  onSecondaryTimeframeChange,
  bracketDensity,
  onBracketDensityChange,
}: {
  splitView: boolean
  onToggleSplitView: () => void
  timeframes: readonly string[]
  timeframe: string
  secondaryTimeframe: string
  onSecondaryTimeframeChange: (tf: string) => void
  bracketDensity: BracketDensity
  onBracketDensityChange: (d: BracketDensity) => void
}) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const workspaceApi = useWorkspaceApiStore((s) => s.api)
  const clearLastLayout = useLayoutStore((s) => s.clearLastLayout)
  // Same "bump a tick on layout change" pattern Workspace.tsx uses for its
  // own +Panel list -- workspaceApi.panels is a live getter on the
  // DockviewApi instance, not itself reactive, so without this the closed-
  // panels list below would only ever reflect whatever it was when this
  // component first mounted.
  const [layoutTick, setLayoutTick] = useState(0)
  useEffect(() => {
    if (!workspaceApi) return
    const disposable = workspaceApi.onDidLayoutChange(() => setLayoutTick((n) => n + 1))
    return () => disposable.dispose()
  }, [workspaceApi])
  void layoutTick

  const resetLayout = () => {
    if (!workspaceApi) return
    clearLastLayout()
    applyAnalysisLayout(workspaceApi)
  }
  const openPanelIds = new Set(workspaceApi?.panels.map((p) => p.id) ?? [])
  const closedPanels = PANEL_DEFS.filter((p) => !openPanelIds.has(p.id))
  const addPanel = (id: string) => {
    const def = PANEL_DEFS.find((p) => p.id === id)
    if (!def || !workspaceApi) return
    workspaceApi.addPanel({ id: def.id, component: def.component, title: def.title })
  }

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

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-pressed={splitView}
        className={`flex h-7 items-center gap-2 rounded px-2 text-xs ${
          open || splitView ? 'bg-surface-2 text-text' : 'text-text-muted hover:bg-surface-2 hover:text-text'
        }`}
      >
        <LayoutPanelTop size={14} />
        Layout
      </button>

      {open && (
        <div role="menu" aria-label="Chart layout" className={`${POPOVER_SHELL} absolute right-0 top-full z-30 mt-1 w-64 ${POPOVER_FORM_PADDING}`}>
          <div className="flex items-center justify-between">
            <span className="text-text-muted">Split view</span>
            <button
              onClick={onToggleSplitView}
              aria-pressed={splitView}
              className={`h-6 rounded px-2 ${splitView ? 'bg-accent text-white' : 'bg-surface text-text hover:bg-surface-2-hover'}`}
            >
              {splitView ? 'On' : 'Off'}
            </button>
          </div>

          {splitView && (
            <div className="mt-2 flex items-center justify-between gap-2">
              <span className="text-text-muted">Second pane</span>
              <div className="flex gap-1">
                {timeframes
                  .filter((tf) => tf !== timeframe)
                  .map((tf) => (
                    <button
                      key={tf}
                      onClick={() => onSecondaryTimeframeChange(tf)}
                      aria-pressed={secondaryTimeframe === tf}
                      className={`h-6 rounded px-2 ${
                        secondaryTimeframe === tf ? 'bg-accent text-white' : 'bg-surface text-text hover:bg-surface-2-hover'
                      }`}
                    >
                      {tf}
                    </button>
                  ))}
              </div>
            </div>
          )}

          <div className="mt-3 border-t border-border pt-3">
            <div className="mb-2 text-text-muted">Trade brackets</div>
            <div className="flex gap-1">
              {BRACKET_DENSITIES.map((d) => (
                <button
                  key={d}
                  onClick={() => onBracketDensityChange(d)}
                  title={BRACKET_TITLE[d]}
                  aria-pressed={bracketDensity === d}
                  className={`h-6 flex-1 rounded px-2 ${
                    bracketDensity === d ? 'bg-accent text-white' : 'bg-surface text-text hover:bg-surface-2-hover'
                  }`}
                >
                  {BRACKET_LABEL[d]}
                </button>
              ))}
            </div>
          </div>

          {workspaceApi && (
            <>
              <div className="mt-3 border-t border-border pt-3">
                <div className="mb-2 text-text-muted">Workspace layout</div>
                <div className="flex gap-1">
                  {PRESETS.map((p) => (
                    <button
                      key={p.name}
                      onClick={() => {
                        p.apply(workspaceApi)
                        setOpen(false)
                      }}
                      className="h-6 whitespace-nowrap rounded bg-surface px-2 text-text hover:bg-surface-2-hover"
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => {
                    resetLayout()
                    setOpen(false)
                  }}
                  className="mt-2 h-6 w-full rounded bg-surface px-2 text-text hover:bg-surface-2-hover"
                >
                  Reset layout
                </button>
              </div>

              <div className="mt-3 border-t border-border pt-3">
                <div className="mb-2 text-text-muted">Panels</div>
                {closedPanels.length === 0 ? (
                  <div className="text-text-muted">All panels open</div>
                ) : (
                  <div className="-mx-3 -my-1 flex flex-col py-1">
                    {closedPanels.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => addPanel(p.id)}
                        className={POPOVER_MENU_ROW}
                      >
                        + {p.title}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
