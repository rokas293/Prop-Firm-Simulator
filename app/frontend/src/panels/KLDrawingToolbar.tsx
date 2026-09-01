import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import {
  Circle,
  Eye,
  EyeOff,
  History,
  Layers,
  Lock,
  Magnet,
  Minus,
  Paintbrush,
  Ruler,
  Slash,
  Square,
  Tag,
  MessageSquare,
  Trash2,
  TrendingUp,
  Triangle,
  Unlock,
} from 'lucide-react'
import { DRAWING_TOOLS, KL_CIRCLE, KL_MEASURE, KL_TRIANGLE, KL_ZONE, type DrawingGroup, type DrawingTool } from '../chart/kl/drawingOverlays'
import type { ChartKLHandle } from '../chart/kl/ChartKL'
import type { PersistedOverlay } from '../chart/kl/drawingOverlays'
import { DRAWING_SHORTCUTS } from '../keyboard/shortcuts'
import { useKLDrawingStore } from '../state/klDrawingStore'

const GROUP_ORDER: DrawingGroup[] = ['lines', 'fibonacci', 'shapes', 'annotations']
const GROUP_LABELS: Record<DrawingGroup, string> = {
  lines: 'Lines',
  fibonacci: 'Fibonacci',
  shapes: 'Shapes',
  annotations: 'Notes',
}

const ICON_SIZE = 16
const SVG_PROPS = {
  width: ICON_SIZE,
  height: ICON_SIZE,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

// lucide-react doesn't ship every glyph a trading toolbar needs (no
// horizontal/vertical ray or segment, no channel or Fibonacci-ladder
// icons) -- these fill exactly those gaps, drawn at the same 24x24
// viewBox/2px-stroke/round-cap convention as lucide's own icons so they
// read as one consistent set (DESIGN_LANGUAGE.md §7).
function HorizontalRayIcon() {
  return (
    <svg {...SVG_PROPS}>
      <circle cx="5" cy="12" r="1.5" />
      <line x1="8" y1="12" x2="21" y2="12" />
    </svg>
  )
}
function HorizontalSegmentIcon() {
  return (
    <svg {...SVG_PROPS}>
      <circle cx="5" cy="12" r="1.5" />
      <circle cx="19" cy="12" r="1.5" />
      <line x1="7.5" y1="12" x2="16.5" y2="12" />
    </svg>
  )
}
function VerticalRayIcon() {
  return (
    <svg {...SVG_PROPS}>
      <circle cx="12" cy="19" r="1.5" />
      <line x1="12" y1="16" x2="12" y2="3" />
    </svg>
  )
}
function VerticalSegmentIcon() {
  return (
    <svg {...SVG_PROPS}>
      <circle cx="12" cy="5" r="1.5" />
      <circle cx="12" cy="19" r="1.5" />
      <line x1="12" y1="7.5" x2="12" y2="16.5" />
    </svg>
  )
}
function DiagonalRayIcon() {
  return (
    <svg {...SVG_PROPS}>
      <circle cx="5" cy="19" r="1.5" />
      <line x1="7" y1="17" x2="21" y2="5" />
    </svg>
  )
}
function PriceLineIcon() {
  return (
    <svg {...SVG_PROPS}>
      <line x1="3" y1="12" x2="17" y2="12" />
      <path d="M17 8v8l4-4z" fill="currentColor" stroke="none" />
    </svg>
  )
}
function ParallelChannelIcon() {
  return (
    <svg {...SVG_PROPS}>
      <line x1="4" y1="18" x2="14" y2="6" />
      <line x1="10" y1="20" x2="20" y2="8" />
    </svg>
  )
}
function PriceChannelIcon() {
  return (
    <svg {...SVG_PROPS}>
      <line x1="3" y1="8" x2="21" y2="5" />
      <line x1="3" y1="19" x2="21" y2="16" />
    </svg>
  )
}
function FibonacciIcon() {
  return (
    <svg {...SVG_PROPS}>
      <line x1="3" y1="5" x2="21" y2="5" />
      <line x1="3" y1="10" x2="16" y2="10" />
      <line x1="3" y1="14" x2="12" y2="14" />
      <line x1="3" y1="19" x2="21" y2="19" />
    </svg>
  )
}

// Every DRAWING_TOOLS entry gets exactly one glyph -- lucide where a good
// match exists, one of the custom icons above where it doesn't.
function toolIcon(name: string): ReactNode {
  switch (name) {
    case 'horizontalStraightLine':
      return <Minus size={ICON_SIZE} />
    case 'horizontalRayLine':
      return <HorizontalRayIcon />
    case 'horizontalSegment':
      return <HorizontalSegmentIcon />
    case 'verticalStraightLine':
      return <Minus size={ICON_SIZE} className="rotate-90" />
    case 'verticalRayLine':
      return <VerticalRayIcon />
    case 'verticalSegment':
      return <VerticalSegmentIcon />
    case 'segment':
      return <TrendingUp size={ICON_SIZE} />
    case 'rayLine':
      return <DiagonalRayIcon />
    case 'straightLine':
      return <Slash size={ICON_SIZE} />
    case 'priceLine':
      return <PriceLineIcon />
    case 'parallelStraightLine':
      return <ParallelChannelIcon />
    case 'priceChannelLine':
      return <PriceChannelIcon />
    case 'fibonacciLine':
      return <FibonacciIcon />
    case KL_ZONE:
      return <Square size={ICON_SIZE} />
    case KL_CIRCLE:
      return <Circle size={ICON_SIZE} />
    case KL_TRIANGLE:
      return <Triangle size={ICON_SIZE} />
    case 'simpleAnnotation':
      return <MessageSquare size={ICON_SIZE} />
    case 'simpleTag':
      return <Tag size={ICON_SIZE} />
    case KL_MEASURE:
      return <Ruler size={ICON_SIZE} />
    case 'brush':
      return <Paintbrush size={ICON_SIZE} />
    default:
      return <Square size={ICON_SIZE} />
  }
}

function shortcutFor(toolName: string): string | undefined {
  return Object.entries(DRAWING_SHORTCUTS).find(([, name]) => name === toolName)?.[0]
}

function tooltipText(tool: DrawingTool): string {
  const key = shortcutFor(tool.name)
  return key ? `${tool.label} (${key.toUpperCase()})` : tool.label
}

// A hover/focus tooltip in the exact surface-2/shadow/12px style
// DESIGN_LANGUAGE.md §6 specifies for tooltips & menus -- CSS-only (no
// mount/unmount state) via Tailwind's group-hover/group-focus-visible, so
// it's always present in the DOM for tests to query directly rather than
// needing a simulated hover.
function IconButtonTooltip({ text, suppressed }: { text: string; suppressed?: boolean }) {
  if (suppressed) return null
  return (
    <span
      role="tooltip"
      className="pointer-events-none absolute left-full top-1/2 z-30 ml-2 -translate-y-1/2 whitespace-nowrap rounded bg-surface-2 px-2 py-1 text-xs text-text opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
    >
      {text}
    </span>
  )
}

function initialLastUsedByGroup(): Record<DrawingGroup, string> {
  const map = {} as Record<DrawingGroup, string>
  for (const group of GROUP_ORDER) {
    map[group] = DRAWING_TOOLS.find((t) => t.group === group)!.name
  }
  return map
}

// The TradingView-style left drawing toolbar (Phase A2 -> DESIGN_LANGUAGE.md
// icon-toolbar redesign), docked to the KL chart panel. Every button just
// calls the chart's own createOverlay via ChartKLHandle.startDrawing --
// point-by-point placement, drag-to-edit, and selection are all
// klinecharts' own overlay system, not anything built here (see
// ChartKL.tsx's startDrawing/cancelActiveDrawing).
//
// ~20 tools collapse into 4 group buttons (Lines/Fibonacci/Shapes/Notes).
// Clicking a group button whose tool is already armed opens a flyout of
// its variants (the small chevron always opens it directly); otherwise it
// re-arms that group's own last-used tool -- so one click resumes the tool
// you were just using, a second click lets you switch it, matching
// TradingView's own group-button behavior.
export default function KLDrawingToolbar({
  klChartRef,
  drawings,
  armedTool,
}: {
  klChartRef: RefObject<ChartKLHandle | null>
  drawings: PersistedOverlay[]
  // Currently-armed tool name, or null -- the one accent-colored state in
  // this sidebar (DESIGN_AUDIT.md chart-workspace elevation: "accent only
  // on the active tool"), same on/off pattern as ChartPanel's timeframe
  // buttons. Owned by ChartPanel (see its own comment) since it's the one
  // place already wiring both the toolbar's clicks and the keyboard
  // shortcuts' calls into ChartKL's startDrawing/cancelActiveDrawing.
  armedTool: string | null
}) {
  const [openGroup, setOpenGroup] = useState<DrawingGroup | null>(null)
  const [manageOpen, setManageOpen] = useState(false)
  const [recentOpen, setRecentOpen] = useState(false)
  const [lastUsedByGroup, setLastUsedByGroup] = useState<Record<DrawingGroup, string>>(initialLastUsedByGroup)
  const recentTools = useKLDrawingStore((s) => s.recentTools)
  const recordToolUsed = useKLDrawingStore((s) => s.recordToolUsed)
  // Magnet/snap (REPLICA_ROADMAP.md Batch 2) -- local to this toolbar, not
  // a persisted preference (matches `openGroup`/`manageOpen` above, not
  // `followLatestBar`'s chartViewStore treatment): it's a "how the next
  // point lands" drawing-tool setting scoped to this one toolbar/chart
  // pairing, not a cross-session view preference, and the secondary
  // split-view chart has no drawing toolbar of its own to share it with.
  const [magnetOn, setMagnetOn] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const allVisible = drawings.every((d) => d.visible !== false)
  const allLocked = drawings.length > 0 && drawings.every((d) => d.lock === true)

  // Keeps the group buttons' glyphs in sync with whatever tool is actually
  // armed, regardless of whether it got armed via a toolbar click, a
  // flyout pick, or a keyboard shortcut (DRAWING_SHORTCUTS) -- armedTool is
  // the single source of truth (see the prop comment above).
  useEffect(() => {
    if (!armedTool) return
    const tool = DRAWING_TOOLS.find((t) => t.name === armedTool)
    if (!tool) return
    setLastUsedByGroup((prev) => (prev[tool.group] === armedTool ? prev : { ...prev, [tool.group]: armedTool }))
    // REPLICA_ROADMAP.md Batch 4's favorites row -- armedTool is already
    // the single source of truth for "a tool just got armed" regardless of
    // how (toolbar click, a flyout pick, or a DRAWING_SHORTCUTS keypress
    // handled entirely in ChartPanel.tsx), so recording it here catches
    // every path without duplicating that logic three times.
    recordToolUsed(armedTool)
  }, [armedTool, recordToolUsed])

  // Close any open flyout on an outside click or Escape -- same dismissal
  // contract as every other popover in the app (SettingsPanel, command
  // palette).
  useEffect(() => {
    if (!openGroup && !manageOpen && !recentOpen) return
    const handlePointerDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpenGroup(null)
        setManageOpen(false)
        setRecentOpen(false)
      }
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpenGroup(null)
        setManageOpen(false)
        setRecentOpen(false)
      }
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [openGroup, manageOpen, recentOpen])

  function toggleMagnet() {
    const next = !magnetOn
    setMagnetOn(next)
    klChartRef.current?.setMagnetMode(next)
  }

  function activateTool(name: string) {
    klChartRef.current?.startDrawing(name)
    setOpenGroup(null)
  }

  function handleGroupClick(group: DrawingGroup) {
    if (openGroup === group) {
      setOpenGroup(null)
      return
    }
    const armedGroup = armedTool ? DRAWING_TOOLS.find((t) => t.name === armedTool)?.group : null
    if (armedGroup === group) {
      // This group's tool is already active -- open the flyout to switch.
      setOpenGroup(group)
    } else {
      // Quick re-arm: jump straight to this group's last-used tool.
      activateTool(lastUsedByGroup[group])
    }
  }

  return (
    <div ref={containerRef} className="flex h-full w-11 flex-none flex-col items-center border-r border-border bg-bg py-2">
      {/* No overflow-y-auto here (unlike the old ~20-row text list, which
          needed to scroll): only 4 group buttons now, and critically,
          `overflow-y: auto` with the x-axis left at its default 'visible'
          gets silently force-promoted to 'auto' on BOTH axes per the CSS
          overflow spec -- which would clip every flyout below, since they
          intentionally render past this rail's right edge. */}
      <div className="flex flex-1 flex-col items-center gap-1">
        {GROUP_ORDER.map((group) => {
          const groupTools = DRAWING_TOOLS.filter((t) => t.group === group)
          const activeToolName = lastUsedByGroup[group]
          const groupIsArmed = armedTool !== null && groupTools.some((t) => t.name === armedTool)
          const flyoutOpen = openGroup === group

          return (
            <div key={group} className="group relative">
              <button
                onClick={() => handleGroupClick(group)}
                aria-pressed={groupIsArmed}
                aria-expanded={flyoutOpen}
                aria-haspopup="menu"
                aria-label={`${GROUP_LABELS[group]}: ${tooltipText(DRAWING_TOOLS.find((t) => t.name === activeToolName)!)}`}
                className={`flex h-8 w-8 items-center justify-center rounded transition-colors ${
                  groupIsArmed ? 'bg-accent text-white' : 'text-text-muted hover:bg-surface-2 hover:text-text'
                }`}
              >
                {toolIcon(activeToolName)}
              </button>
              {/* Explicit "open the variant picker" affordance -- always
                  available regardless of the main button's quick-arm
                  behavior above (TradingView's own small corner caret). */}
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  setOpenGroup((g) => (g === group ? null : group))
                }}
                aria-label={`More ${GROUP_LABELS[group]} tools`}
                className="absolute -bottom-0.5 -right-0.5 flex h-3 w-3 items-center justify-center rounded-sm bg-bg text-text-muted hover:text-text"
              >
                <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3}>
                  <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>

              <IconButtonTooltip text={`${GROUP_LABELS[group]} – ${tooltipText(DRAWING_TOOLS.find((t) => t.name === activeToolName)!)}`} suppressed={flyoutOpen} />

              {flyoutOpen && (
                <div
                  role="menu"
                  aria-label={`${GROUP_LABELS[group]} tools`}
                  className="absolute left-full top-0 z-30 ml-1 w-48 rounded border border-border bg-surface-2 py-1 shadow-lg"
                >
                  {groupTools.map((tool) => {
                    const active = tool.name === armedTool
                    const key = shortcutFor(tool.name)
                    return (
                      <button
                        key={tool.name}
                        role="menuitem"
                        onClick={() => activateTool(tool.name)}
                        aria-pressed={active}
                        className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs ${
                          active ? 'text-accent' : 'text-text hover:bg-surface-2-hover'
                        }`}
                      >
                        <span className="flex h-4 w-4 flex-none items-center justify-center">{toolIcon(tool.name)}</span>
                        <span className="flex-1 truncate">{tool.label}</span>
                        {key && <span className="micro-label flex-none text-text-muted">{key.toUpperCase()}</span>}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Outside the scrollable tool list (not `mt-auto` inside it) so this
          bottom cluster stays reachable without scrolling past the groups. */}
      <div className="flex flex-none flex-col items-center gap-1 border-t border-border pt-2">
        {/* Favorites/recently-used (REPLICA_ROADMAP.md Batch 4) -- the
            last few DISTINCT tools actually armed, most-recent-first,
            sourced straight from DRAWING_TOOLS/toolIcon so a favorite
            renders identically to its entry in the group flyouts above. */}
        <div className="group relative">
          <button
            onClick={() => setRecentOpen((o) => !o)}
            aria-expanded={recentOpen}
            aria-haspopup="menu"
            aria-label="Recently used tools"
            disabled={recentTools.length === 0}
            className={`flex h-8 w-8 items-center justify-center rounded transition-colors disabled:opacity-30 ${
              recentOpen ? 'bg-surface-2 text-text' : 'text-text-muted hover:bg-surface-2 hover:text-text'
            }`}
          >
            <History size={ICON_SIZE} />
          </button>
          <IconButtonTooltip text="Recently used" suppressed={recentOpen} />

          {recentOpen && recentTools.length > 0 && (
            <div
              role="menu"
              aria-label="Recently used tools"
              className="absolute bottom-0 left-full z-30 ml-1 w-48 rounded border border-border bg-surface-2 py-1 shadow-lg"
            >
              {recentTools.map((name) => {
                const tool = DRAWING_TOOLS.find((t) => t.name === name)
                if (!tool) return null
                const active = tool.name === armedTool
                const key = shortcutFor(tool.name)
                return (
                  <button
                    key={tool.name}
                    role="menuitem"
                    onClick={() => activateTool(tool.name)}
                    aria-pressed={active}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs ${
                      active ? 'text-accent' : 'text-text hover:bg-surface-2-hover'
                    }`}
                  >
                    <span className="flex h-4 w-4 flex-none items-center justify-center">{toolIcon(tool.name)}</span>
                    <span className="flex-1 truncate">{tool.label}</span>
                    {key && <span className="micro-label flex-none text-text-muted">{key.toUpperCase()}</span>}
                  </button>
                )
              })}
            </div>
          )}
        </div>

        <div className="group relative">
          <button
            onClick={toggleMagnet}
            aria-pressed={magnetOn}
            aria-label="Magnet: snap drawing points to the nearest OHLC value"
            className={`flex h-8 w-8 items-center justify-center rounded transition-colors ${
              magnetOn ? 'bg-accent text-white' : 'text-text-muted hover:bg-surface-2 hover:text-text'
            }`}
          >
            <Magnet size={ICON_SIZE} />
          </button>
          <IconButtonTooltip text="Magnet -- snap to OHLC" />
        </div>

        <div className="group relative">
          <button
            onClick={() => setManageOpen((o) => !o)}
            aria-expanded={manageOpen}
            aria-haspopup="menu"
            aria-label={`Drawings (${drawings.length})`}
            className={`relative flex h-8 w-8 items-center justify-center rounded transition-colors ${
              manageOpen ? 'bg-surface-2 text-text' : 'text-text-muted hover:bg-surface-2 hover:text-text'
            }`}
          >
            <Layers size={ICON_SIZE} />
            {drawings.length > 0 && (
              <span className="tabular-nums absolute -bottom-1 -right-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent px-0.5 text-[9px] leading-none text-white">
                {drawings.length}
              </span>
            )}
          </button>
          <IconButtonTooltip text={`Drawings (${drawings.length})`} suppressed={manageOpen} />

          {manageOpen && (
            <div className="absolute bottom-0 left-full z-30 ml-1 w-64 rounded border border-border bg-surface-2 py-1 shadow-lg">
              {drawings.length === 0 ? (
                // POLISH_ROADMAP Phase P6: a helpful empty state rather than
                // an empty dropdown (previously this button was just
                // `disabled` at 0, so there was nothing to open at all).
                <div className="px-3 py-2 text-text-muted">No drawings yet -- pick a tool above to start.</div>
              ) : (
                <>
                  {/* Bulk toggles (REPLICA_ROADMAP.md Batch 2) -- a
                      select-all-checkbox-style flip: while anything is
                      still visible/unlocked, the action is "hide/lock
                      all"; once everything already is, it flips to
                      "show/unlock all" instead of doing nothing. */}
                  <div className="flex items-center justify-between px-3 pb-1.5">
                    <span className="micro-label text-text-muted">Drawings ({drawings.length})</span>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => klChartRef.current?.setAllDrawingsVisible(!allVisible)}
                        title={allVisible ? 'Hide all drawings' : 'Show all drawings'}
                        aria-pressed={!allVisible}
                        className="flex h-5 w-5 items-center justify-center rounded text-text-muted hover:bg-surface-2-hover hover:text-text"
                      >
                        {allVisible ? <Eye size={13} /> : <EyeOff size={13} />}
                      </button>
                      <button
                        onClick={() => klChartRef.current?.setAllDrawingsLocked(!allLocked)}
                        title={allLocked ? 'Unlock all drawings' : 'Lock all drawings'}
                        aria-pressed={allLocked}
                        className="flex h-5 w-5 items-center justify-center rounded text-text-muted hover:bg-surface-2-hover hover:text-text"
                      >
                        {allLocked ? <Lock size={13} /> : <Unlock size={13} />}
                      </button>
                    </div>
                  </div>
                  <div className="max-h-64 overflow-y-auto">
                    {drawings.map((d) => {
                      const hidden = d.visible === false
                      const locked = d.lock === true
                      return (
                        <div
                          key={d.id}
                          role="button"
                          tabIndex={0}
                          onClick={() => klChartRef.current?.selectDrawing(d.id)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') klChartRef.current?.selectDrawing(d.id)
                          }}
                          title="Click to frame this drawing on the chart"
                          className={`flex cursor-pointer items-center justify-between px-3 py-1 hover:bg-surface-2-hover ${
                            hidden ? 'opacity-50' : ''
                          }`}
                        >
                          <span className="flex min-w-0 items-center gap-2 truncate text-text">
                            <span className="flex h-4 w-4 flex-none items-center justify-center text-text-muted">
                              {toolIcon(d.name)}
                            </span>
                            <span className="truncate">{DRAWING_TOOLS.find((t) => t.name === d.name)?.label ?? d.name}</span>
                          </span>
                          <span className="ml-2 flex flex-none items-center gap-0.5">
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                klChartRef.current?.toggleDrawingVisible(d.id)
                              }}
                              title={hidden ? 'Show' : 'Hide'}
                              className="flex h-5 w-5 items-center justify-center rounded text-text-muted hover:bg-surface-2-hover hover:text-text"
                            >
                              {hidden ? <EyeOff size={13} /> : <Eye size={13} />}
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                klChartRef.current?.toggleDrawingLock(d.id)
                              }}
                              title={locked ? 'Unlock' : 'Lock'}
                              className="flex h-5 w-5 items-center justify-center rounded text-text-muted hover:bg-surface-2-hover hover:text-text"
                            >
                              {locked ? <Lock size={13} /> : <Unlock size={13} />}
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                klChartRef.current?.removeDrawing(d.id)
                              }}
                              title="Delete"
                              className="flex h-5 w-5 items-center justify-center rounded text-text-muted hover:bg-surface-2-hover hover:text-negative"
                            >
                              <Trash2 size={13} />
                            </button>
                          </span>
                        </div>
                      )
                    })}
                  </div>
                  <div className="mt-1 border-t border-border px-3 pt-2">
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
