import { useEffect, useMemo, useRef, useState } from 'react'
import { Maximize2, Minimize2 } from 'lucide-react'
import ChartKL, { type ChartKLHandle } from '../chart/kl/ChartKL'
import type { SessionBand } from '../chart/kl/sessionOverlay'
import { equityAtCursor, runningTotals } from '../chart/replay'
import { withMargin } from '../chart/windowMargin'
import ChartLayoutMenu from './ChartLayoutMenu'
import IndicatorDialog from './IndicatorDialog'
import KLDrawingToolbar from './KLDrawingToolbar'
import type { PersistedOverlay } from '../chart/kl/drawingOverlays'
import ReplayControls from './ReplayControls'
import SymbolSearch from './SymbolSearch'
import TimeframeMenu from './TimeframeMenu'
import { useBars, useEquity, useIndicators, useRun, useSessions, useTrades } from '../api/hooks'
import { useUiStore } from '../state/uiStore'
import { filtersToParams, useTradeStore } from '../state/tradeStore'
import { useIndicatorStore, type IndicatorPrefs } from '../state/indicatorStore'
import { useChartViewStore } from '../state/chartViewStore'
import { useChartDefaultsStore } from '../state/chartDefaultsStore'
import { useWorkspaceApiStore } from '../state/workspaceApiStore'
import { CHART_PANEL_ID } from '../workspace/panelIds'
import { applyCompassFilters } from '../compass/breakdowns'
import { isShortcut, DRAWING_SHORTCUTS } from '../keyboard/shortcuts'
import EmptyState from '../components/EmptyState'
import type { IndicatorName } from '../api/types'
import { fmtUsd } from '../format'

const TIMEFRAMES = ['1min', '5min', '15min', '1h'] as const
type Timeframe = (typeof TIMEFRAMES)[number]

// How much context to load around a trade when fitting to it, in seconds.
const MIN_PAD_SECONDS = 2 * 60 * 60

// How much context to show by default when a trade is selected/fitted --
// bigger than a thin sliver of the trade itself so you're not left having
// to zoom out by hand every time you switch trades.
const MIN_FIT_PAD_SECONDS = 30 * 60

const EMPTY_INDICATORS = { vwap: [], ema20: [], ema50: [], atr14: [] }
const INDICATORS_OFF: IndicatorPrefs = {
  sessionShading: true,
  fairValue: true,
  vwap: false,
  ema20: false,
  ema50: false,
  atr14: false,
  // Preserves the secondary split-view chart's pre-Batch-3 behavior --
  // volume used to be an unconditional mount-time indicator there, now
  // gated by this same pref (see IndicatorPrefs' own comment).
  volume: true,
}

// A standalone dockable panel (POLISH_ROADMAP Phase P1). Coordinates with
// the (now sibling, not child) Trade List panel purely through shared
// stores -- see chartViewStore.ts.
export default function ChartPanel() {
  const runId = useUiStore((s) => s.selectedRunId)
  const pendingDayJump = useUiStore((s) => s.pendingDayJump)
  const consumeDayJump = useUiStore((s) => s.consumeDayJump)
  const timeframe = useUiStore((s) => s.timeframe)
  const setTimeframe = useUiStore((s) => s.setTimeframe)
  const distractionFree = useUiStore((s) => s.distractionFree)
  const setDistractionFree = useUiStore((s) => s.setDistractionFree)
  const workspaceApi = useWorkspaceApiStore((s) => s.api)

  const filters = useTradeStore((s) => s.filters)
  const clearFilters = useTradeStore((s) => s.clearFilters)
  const selectedTradeId = useTradeStore((s) => s.selectedTradeId)
  const selectTrade = useTradeStore((s) => s.selectTrade)
  const tradeNavFocused = useTradeStore((s) => s.tradeNavFocused)
  const setTradeNavFocused = useTradeStore((s) => s.setTradeNavFocused)

  const viewMode = useChartViewStore((s) => s.viewMode)
  const explicitDayWindow = useChartViewStore((s) => s.explicitDayWindow)
  const selectTradeView = useChartViewStore((s) => s.selectTradeView)
  const selectFullDay = useChartViewStore((s) => s.selectFullDay)
  const selectExplicitDay = useChartViewStore((s) => s.selectExplicitDay)
  const replayActive = useChartViewStore((s) => s.replayActive)
  const cursorIndex = useChartViewStore((s) => s.cursorIndex)
  const isPlaying = useChartViewStore((s) => s.isPlaying)
  const speed = useChartViewStore((s) => s.speed)
  const followLatestBar = useChartViewStore((s) => s.followLatestBar)
  const toggleReplay = useChartViewStore((s) => s.toggleReplay)
  const setCursorIndex = useChartViewStore((s) => s.setCursorIndex)
  const advanceCursor = useChartViewStore((s) => s.advanceCursor)
  const setIsPlaying = useChartViewStore((s) => s.setIsPlaying)
  const setSpeed = useChartViewStore((s) => s.setSpeed)
  const toggleFollowLatestBar = useChartViewStore((s) => s.toggleFollowLatestBar)
  const resetCursorForNewBars = useChartViewStore((s) => s.resetCursorForNewBars)

  const { data: run } = useRun(runId)
  const filterParams = useMemo(() => filtersToParams(filters), [filters])
  const { data: rawTrades } = useTrades(runId, filterParams)
  // Compass cross-filters, applied client-side same as TradeListPanel --
  // see tradeStore.ts's TradeFilters comment (POLISH_ROADMAP Phase P5).
  const trades = useMemo(() => applyCompassFilters(rawTrades ?? [], filters), [rawTrades, filters])

  const klChartRef = useRef<ChartKLHandle>(null)

  // Split view: a second, independently-timeframed chart of the same
  // instrument (POLISH_ROADMAP Phase P2), synced to the primary's visible
  // range. `klSyncingRef` is a plain re-entrancy guard owned here: since
  // ChartPanel drives both chart refs directly and synchronously, it can
  // guarantee a sibling's mirrored change never bounces back, without
  // guessing at klinecharts' internal event-dispatch timing (an earlier
  // attempt at reactive pan-driven fetching broke exactly on that
  // uncertainty -- this sync is deliberately just direct imperative calls
  // between two known chart instances, not a trigger for new data fetches).
  const [splitView, setSplitView] = useState(false)
  const [secondaryTimeframe, setSecondaryTimeframe] = useState<Timeframe>('15min')
  // Lifted out of ChartKL (PART_A_REVISED_klinecharts.md Phase A2) so
  // KLDrawingToolbar's manage dropdown can list/delete drawings without
  // polling the chart instance -- ChartKL calls back via onDrawingsChange
  // whenever the set actually changes (placed, dragged, removed, restored).
  const [klDrawings, setKlDrawings] = useState<PersistedOverlay[]>([])
  // Owned here (not in KLDrawingToolbar) since both the toolbar's clicks AND
  // this component's own keydown handler below call startDrawing --
  // ChartKL's onDrawingArmedChange is the single source of truth for
  // whether a tool is actually armed right now (DESIGN_AUDIT.md chart-
  // workspace elevation).
  const [armedTool, setArmedTool] = useState<string | null>(null)
  // REPLICA_ROADMAP.md Batch 5's "click-to-set replay start" -- armed via
  // ReplayControls' own button (or the 'S' shortcut), disarmed the moment
  // a bar is actually picked (handlePickReplayStart below) or Escape.
  const [pickingReplayStart, setPickingReplayStart] = useState(false)
  // REPLICA_ROADMAP.md Batch 3's add-indicator dialog -- replaces the old
  // always-visible checkbox row (IndicatorTogglePanel) now that the
  // on-chart legend itself shows which indicators are active.
  const [indicatorDialogOpen, setIndicatorDialogOpen] = useState(false)
  const klSecondaryChartRef = useRef<ChartKLHandle>(null)
  const klSyncingRef = useRef(false)

  // On-chart trade bracket density (POLISH_ROADMAP Phase P3): 'auto'
  // simplifies individually-narrow brackets to markers, 'full' always
  // draws the whole box, 'markers' always simplifies -- see
  // chart/tradeBracket.ts's shouldSimplify.
  // Persisted "data default" (POLISH_ROADMAP Phase P6's Settings panel),
  // not local state -- also settable from Settings, both reading the same
  // store.
  const bracketDensity = useChartDefaultsStore((s) => s.bracketDensity)
  const setBracketDensity = useChartDefaultsStore((s) => s.setBracketDensity)

  // Distraction-free chart mode (REPLICA_ROADMAP.md Batch 5) -- pairs
  // uiStore's own flag (which App.tsx/Workspace.tsx react to, hiding the
  // outer header/layout row) with dockview's NATIVE panel-maximize API
  // (confirmed in dockview-core's public component.api.d.ts:
  // maximizeGroup/exitMaximizedGroup/onDidMaximizedGroupChange), which
  // collapses the sibling panels (Trade List, Dashboard, ...) without this
  // app needing to hand-roll that part. Both sides are driven from ONE
  // toggle so they can't drift apart; the effect below re-syncs uiStore's
  // flag if dockview's OWN maximize state ever changes some other way.
  //
  // Reads useUiStore.getState().distractionFree fresh rather than closing
  // over the destructured `distractionFree` above -- this is called from
  // the keydown handler further down, whose own effect deps deliberately
  // DON'T include every piece of state every branch touches (matches that
  // effect's existing, established pattern -- see its own comment), so a
  // closed-over boolean there would go stale the moment this toggles
  // without ALSO triggering a trades/tradeIdx/selectedTrade change.
  const toggleDistractionFree = () => {
    if (useUiStore.getState().distractionFree) {
      workspaceApi?.exitMaximizedGroup()
      setDistractionFree(false)
      return
    }
    const panel = workspaceApi?.getPanel(CHART_PANEL_ID)
    if (!panel) return
    workspaceApi?.maximizeGroup(panel)
    setDistractionFree(true)
  }
  useEffect(() => {
    if (!workspaceApi) return
    const disposable = workspaceApi.onDidMaximizedGroupChange((e) => {
      if (!e.isMaximized) setDistractionFree(false)
    })
    return () => disposable.dispose()
  }, [workspaceApi, setDistractionFree])

  // Reset to a clean state whenever a different run is opened.
  useEffect(() => {
    if (!runId) setSplitView(false)
  }, [runId])

  // Keep a selection valid: if nothing is selected, or the current
  // selection got filtered out, fall back to the first matching trade.
  // Guards on `rawTrades` (undefined while the fetch is in flight), not the
  // always-an-array `trades` -- otherwise every filter change would
  // momentarily see an empty compass-filtered array before the real data
  // lands and wrongly clear the selection (POLISH_ROADMAP Phase P5).
  useEffect(() => {
    if (!rawTrades) return
    if (trades.length === 0) {
      if (selectedTradeId !== null) selectTrade(null)
      return
    }
    if (!trades.some((t) => t.trade_id === selectedTradeId)) {
      selectTrade(trades[0].trade_id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trades, rawTrades])

  const selectedTrade = trades.find((t) => t.trade_id === selectedTradeId) ?? null

  const tradeWindow = useMemo(() => {
    if (!selectedTrade) return null
    const pad = Math.max(MIN_PAD_SECONDS, selectedTrade.exit_time - selectedTrade.entry_time)
    return { from: selectedTrade.entry_time - pad, to: selectedTrade.exit_time + pad }
  }, [selectedTrade])

  // Wide enough to reliably contain the trade's whole CME trading day,
  // looked up from the server rather than reimplemented in JS (VIZ_SPEC
  // section 0: frontend does zero financial/temporal math).
  const sessionLookupWindow = useMemo(() => {
    if (!selectedTrade) return null
    return { from: selectedTrade.entry_time - 2 * 24 * 3600, to: selectedTrade.exit_time + 24 * 3600 }
  }, [selectedTrade])

  const { data: sessions } = useSessions(
    run?.instrument ?? null,
    sessionLookupWindow?.from ?? null,
    sessionLookupWindow?.to ?? null,
  )

  const dayWindow = useMemo(() => {
    if (!selectedTrade || !sessions) return null
    const daySessions = sessions.filter((s) => s.trading_day === selectedTrade.trading_day)
    if (daySessions.length === 0) return null
    return {
      from: Math.min(...daySessions.map((s) => s.start)),
      to: Math.max(...daySessions.map((s) => s.end)),
    }
  }, [selectedTrade, sessions])

  // Wide lookup window derived purely from the target trading_day string
  // (not from any trade), for a day-jump that may land on a day with zero
  // trades. The exact boundary still comes from the server (/api/sessions);
  // this is just a generous net to fetch through, same pattern as the
  // trade-based sessionLookupWindow above.
  const dayJumpLookupWindow = useMemo(() => {
    if (!pendingDayJump) return null
    const dayStartMs = Date.parse(`${pendingDayJump}T00:00:00Z`)
    return { from: Math.floor(dayStartMs / 1000) - 2 * 24 * 3600, to: Math.floor(dayStartMs / 1000) + 2 * 24 * 3600 }
  }, [pendingDayJump])

  const { data: dayJumpSessions } = useSessions(
    run?.instrument ?? null,
    dayJumpLookupWindow?.from ?? null,
    dayJumpLookupWindow?.to ?? null,
  )

  useEffect(() => {
    if (!pendingDayJump || !dayJumpSessions) return
    const daySessions = dayJumpSessions.filter((s) => s.trading_day === pendingDayJump)
    if (daySessions.length > 0) {
      clearFilters()
      selectTrade(null)
      selectExplicitDay({
        from: Math.min(...daySessions.map((s) => s.start)),
        to: Math.max(...daySessions.map((s) => s.end)),
      })
    }
    consumeDayJump()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingDayJump, dayJumpSessions])

  const targetWindow = explicitDayWindow ?? (viewMode === 'day' && dayWindow ? dayWindow : tradeWindow)

  // Smoothness (POLISH_ROADMAP Phase P2): fetch target window + a static
  // margin so ordinary panning inside it never needs a refetch. See
  // chart/windowMargin.ts's comment for why this is deliberately NOT a
  // reactive pan-triggered fetch.
  const barsWindow = useMemo(() => (targetWindow ? withMargin(targetWindow) : null), [targetWindow])

  const { data: bars, isFetching: barsFetching } = useBars(
    run?.instrument ?? null,
    timeframe,
    barsWindow?.from ?? null,
    barsWindow?.to ?? null,
  )

  // KL's own DataLoader fetches the secondary chart's bars itself (see
  // ChartKL.tsx) -- this query's `data` is unused now that PriceChart is
  // gone; kept only for `isFetching`, which feeds the secondary chart's
  // loading indicator with the same timing signal.
  const { isFetching: secondaryBarsFetching } = useBars(
    splitView ? (run?.instrument ?? null) : null,
    secondaryTimeframe,
    barsWindow?.from ?? null,
    barsWindow?.to ?? null,
  )

  // A new bars window (trade switch, day-jump, timeframe change) always
  // restarts replay from the beginning of what's now on screen.
  useEffect(() => {
    resetCursorForNewBars()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bars])

  useEffect(() => {
    if (!replayActive || !isPlaying || !bars || bars.length === 0) return
    const id = setInterval(() => {
      advanceCursor(bars.length - 1)
    }, 1000 / speed)
    return () => clearInterval(id)
  }, [replayActive, isPlaying, bars, speed, advanceCursor])

  const cursorTime = replayActive && bars && bars[cursorIndex] ? bars[cursorIndex].time : null

  // Live readout: equity/MLL scoped to just this window (not the full run
  // -- see useEquity's comment), looked up at the cursor, and running
  // PnL/R summed from already-computed per-trade fields. No math the
  // engine hasn't already done (VIZ_SPEC section 0).
  const { data: equityWindow } = useEquity(
    replayActive ? runId : null,
    5000,
    barsWindow?.from ?? null,
    barsWindow?.to ?? null,
  )
  const equityAtCursorPoint = useMemo(() => equityAtCursor(equityWindow ?? [], cursorTime), [equityWindow, cursorTime])

  // Sessions covering exactly what's on screen, for background shading +
  // fair-value lines (VIZ_SPEC Phase V5). Separate from the narrower
  // trade-based/day-jump lookups above, which exist only to COMPUTE a day's
  // boundaries, not to display every session in the visible range.
  const { data: visibleSessions } = useSessions(
    run?.instrument ?? null,
    barsWindow?.from ?? null,
    barsWindow?.to ?? null,
  )
  const sessionBands: SessionBand[] = useMemo(
    () =>
      (visibleSessions ?? []).map((s) => ({
        start: s.start,
        end: s.end,
        session: s.session,
        fairValue: s.fair_value,
      })),
    [visibleSessions],
  )

  const indicatorPrefs = useIndicatorStore()
  const activeIndicatorCount = [
    indicatorPrefs.sessionShading,
    indicatorPrefs.fairValue,
    indicatorPrefs.vwap,
    indicatorPrefs.ema20,
    indicatorPrefs.ema50,
    indicatorPrefs.atr14,
    indicatorPrefs.volume,
  ].filter(Boolean).length
  const enabledIndicators = useMemo(() => {
    const names: IndicatorName[] = []
    if (indicatorPrefs.vwap) names.push('vwap')
    if (indicatorPrefs.ema20) names.push('ema20')
    if (indicatorPrefs.ema50) names.push('ema50')
    if (indicatorPrefs.atr14) names.push('atr14')
    return names
  }, [indicatorPrefs.vwap, indicatorPrefs.ema20, indicatorPrefs.ema50, indicatorPrefs.atr14])

  const { data: indicatorData } = useIndicators(
    run?.instrument ?? null,
    timeframe,
    barsWindow?.from ?? null,
    barsWindow?.to ?? null,
    enabledIndicators,
  )
  const indicators = useMemo(
    () => ({
      vwap: indicatorData?.vwap ?? [],
      ema20: indicatorData?.ema20 ?? [],
      ema50: indicatorData?.ema50 ?? [],
      atr14: indicatorData?.atr14 ?? [],
    }),
    [indicatorData],
  )

  // Only trades that are both filter-matched (already true of `trades`,
  // fetched via /api/trades query params + client-side compass filters)
  // AND within the loaded bars window get a marker -- so filtering hides
  // markers same as table rows.
  const visibleTrades = useMemo(() => {
    if (!barsWindow) return []
    return trades.filter((t) => t.exit_time >= barsWindow.from && t.entry_time <= barsWindow.to)
  }, [trades, barsWindow])

  const replayTotals = useMemo(() => runningTotals(visibleTrades, cursorTime), [visibleTrades, cursorTime])

  const tradeIdx = trades?.findIndex((t) => t.trade_id === selectedTradeId) ?? -1

  const fitTrade = () => {
    if (!selectedTrade) return
    selectTradeView()
    // At least MIN_FIT_PAD_SECONDS of context, or 1.5x the trade's own
    // duration for longer trades -- enough to see the surrounding
    // structure by default instead of having to zoom out by hand.
    const pad = Math.max(MIN_FIT_PAD_SECONDS, (selectedTrade.exit_time - selectedTrade.entry_time) * 1.5)
    klChartRef.current?.fitRange(selectedTrade.entry_time - pad, selectedTrade.exit_time + pad)
  }

  const pickTrade = (tradeId: number) => {
    selectTrade(tradeId)
    setTradeNavFocused(true)
    selectTradeView()
    // Immediate pan attempt (PART_A_REVISED_klinecharts.md Phase A1:
    // "clicking a trade... scrolls the chart to it") -- no-ops via the
    // ready-guard if this trade's bars haven't loaded into KL yet; the
    // bars-loaded effect below applies the real fit once they do.
    const trade = trades?.find((t) => t.trade_id === tradeId)
    if (trade) klChartRef.current?.scrollToTrade(trade.entry_time)
  }

  // REPLICA_ROADMAP.md Batch 5's click-to-set-replay-start -- ChartKL's
  // onCandleBarClick fires on EVERY bar click regardless of mode (see its
  // own comment), so this only acts while pickingReplayStart is armed.
  // Matches by TIMESTAMP, not klinecharts' own dataIndex: the clicked
  // bar's index into klinecharts' internal (possibly replay-clipped) data
  // list isn't guaranteed to line up with this component's own `bars`
  // array position (same reasoning as the Batch 1 camera fix).
  const handlePickReplayStart = (bar: { timestamp: number }) => {
    if (!pickingReplayStart || !bars) return
    const clickedTimeSec = bar.timestamp / 1000
    const index = bars.findIndex((b) => b.time === clickedTimeSec)
    if (index >= 0) setCursorIndex(index)
    setPickingReplayStart(false)
  }

  // Once new bars land for the active view, fit the chart to them. `bars`
  // and KL's own independent fetch are handed the same computed window
  // (see barsWindow below), so this is a reasonable proxy for "the target
  // window is now ready" -- KL's own fitRange no-ops harmlessly via its
  // ready-guard if its fetch hasn't resolved yet.
  useEffect(() => {
    if (!bars || bars.length === 0) return
    if (viewMode === 'trade') {
      fitTrade()
    } else if (targetWindow) {
      klChartRef.current?.fitRange(targetWindow.from, targetWindow.to)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bars, viewMode])

  // Keyboard shortcuts: next/prev trade, toggle replay, fit trade, switch
  // timeframe. Matched via keyboard/shortcuts.ts's isShortcut() (the same
  // registry the "?" overlay renders), not hand-rolled key comparisons, so
  // the overlay can never list a binding that doesn't actually fire.
  // Ignored while typing in a form control (e.g. Trade List panel's date
  // filters, the command palette) so shortcuts never fight normal text entry.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || target?.isContentEditable) return

      if (isShortcut(e, 'nextTrade')) {
        if (trades && tradeIdx >= 0 && tradeIdx < trades.length - 1) {
          e.preventDefault()
          pickTrade(trades[tradeIdx + 1].trade_id)
        }
      } else if (isShortcut(e, 'prevTrade')) {
        if (trades && tradeIdx > 0) {
          e.preventDefault()
          pickTrade(trades[tradeIdx - 1].trade_id)
        }
      } else if (isShortcut(e, 'toggleReplay')) {
        e.preventDefault()
        toggleReplay()
      } else if (isShortcut(e, 'fitTrade')) {
        if (selectedTrade) {
          e.preventDefault()
          fitTrade()
        }
      } else if (isShortcut(e, 'toggleFullscreen')) {
        e.preventDefault()
        toggleDistractionFree()
      } else if (isShortcut(e, 'setReplayStart')) {
        if (useChartViewStore.getState().replayActive) {
          e.preventDefault()
          setPickingReplayStart((v) => !v)
        }
      } else if (e.key === 'Escape') {
        // Cancel a still-in-progress drawing (PART_A_REVISED_klinecharts.md
        // Phase A2) -- shares the Escape key with the global
        // 'closeOverlay' shortcut (command palette/settings), which is
        // harmless: cancelActiveDrawing no-ops when nothing is being drawn.
        klChartRef.current?.cancelActiveDrawing()
        // Same "harmless no-op" reasoning extends to both of these
        // (REPLICA_ROADMAP.md Batch 5) -- Escape is the universal "get out
        // of whatever mode I'm in" key, so it doubles as the "clear way
        // back" for distraction-free mode and cancels an armed "click a
        // bar to set the replay start" pick without needing its own
        // separate handler.
        if (useUiStore.getState().distractionFree) toggleDistractionFree()
        setPickingReplayStart(false)
      } else if (!e.ctrlKey && !e.metaKey && !e.shiftKey && DRAWING_SHORTCUTS[e.key.toLowerCase()]) {
        e.preventDefault()
        klChartRef.current?.startDrawing(DRAWING_SHORTCUTS[e.key.toLowerCase()])
      } else {
        const tfIndex = TIMEFRAMES.findIndex((tf) => isShortcut(e, `timeframe-${tf}`))
        if (tfIndex >= 0) {
          e.preventDefault()
          setTimeframe(TIMEFRAMES[tfIndex])
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trades, tradeIdx, selectedTrade])

  // Split-view sync (Phase A5) -- fitRange doubles as the "set visible
  // range" lever here (see ChartKLHandle's own comment: klinecharts has no
  // direct setVisibleRange-by-time). No crosshair sync -- see ChartKL.tsx's
  // header comment for why that's not implemented.
  const withKLSyncGuard = (fn: () => void) => {
    if (klSyncingRef.current) return
    klSyncingRef.current = true
    fn()
    queueMicrotask(() => {
      klSyncingRef.current = false
    })
  }
  const handlePrimaryKLVisibleRangeChange = (range: { from: number; to: number } | null) => {
    if (!splitView || !range) return
    withKLSyncGuard(() => klSecondaryChartRef.current?.fitRange(range.from, range.to))
  }
  const handleSecondaryKLVisibleRangeChange = (range: { from: number; to: number } | null) => {
    if (!splitView || !range) return
    withKLSyncGuard(() => klChartRef.current?.fitRange(range.from, range.to))
  }

  if (!runId) {
    return <EmptyState title="No run selected" hint="Pick a run from the Runs list, or press Ctrl/Cmd+K to open one." />
  }

  return (
    <div className="flex h-full w-full flex-col">
      {/* REPLICA_ROADMAP.md Batch 4: one clean top row -- symbol,
          timeframe, indicators, replay, layout -- matching TradingView's
          own top bar. Trade navigation/fit/day (row below, used
          constantly while reviewing a run) and the occasional split-
          view/bracket-density settings (folded into the Layout popover)
          deliberately stay OUT of this row so it never gets crowded. */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <SymbolSearch />
        <TimeframeMenu timeframes={TIMEFRAMES} value={timeframe} onChange={(tf) => setTimeframe(tf as Timeframe)} />

        <button
          onClick={() => setIndicatorDialogOpen(true)}
          className="flex h-7 items-center gap-2 rounded bg-surface-2 px-2 text-xs text-text hover:bg-surface-2-hover"
        >
          Indicators
          <span className="tabular-nums flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[11px] leading-none text-on-accent">
            {activeIndicatorCount}
          </span>
        </button>

        <button
          onClick={toggleReplay}
          aria-pressed={replayActive}
          className={`h-7 rounded px-2 text-xs ${
            replayActive ? 'bg-accent text-on-accent' : 'bg-surface-2 text-text hover:bg-surface-2-hover'
          }`}
        >
          {replayActive ? 'Exit replay' : 'Replay'}
        </button>

        <div className="ml-auto flex items-center gap-2">
          <ChartLayoutMenu
            splitView={splitView}
            onToggleSplitView={() => setSplitView((v) => !v)}
            timeframes={TIMEFRAMES}
            timeframe={timeframe}
            secondaryTimeframe={secondaryTimeframe}
            onSecondaryTimeframeChange={(tf) => setSecondaryTimeframe(tf as Timeframe)}
            bracketDensity={bracketDensity}
            onBracketDensityChange={setBracketDensity}
          />
          {/* REPLICA_ROADMAP.md Batch 5: distraction-free chart mode --
              expands the chart to fill the window, hiding the app header,
              the workspace's "Layout:" row, and every sibling panel (via
              dockview's own maximizeGroup). Escape or this same button
              (now accent-filled) is the way back. */}
          <button
            onClick={toggleDistractionFree}
            aria-pressed={distractionFree}
            title="Distraction-free chart mode (D)"
            className={`flex h-7 w-7 items-center justify-center rounded ${
              distractionFree ? 'bg-accent text-on-accent' : 'text-text-muted hover:bg-surface-2 hover:text-text'
            }`}
          >
            {distractionFree ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
        </div>
      </div>
      <IndicatorDialog open={indicatorDialogOpen} onClose={() => setIndicatorDialogOpen(false)} />

      {/* Trade navigation -- used on nearly every click ONCE you're
          reviewing a specific trade, but ChartPanel auto-selects trade #1
          on every run load (a separate feature -- it also drives the
          chart's default fitted window), so gating this on "a trade is
          selected" would show it permanently again in practice
          (REPLICA_AUDIT.md Top 10 #3). Gated on `tradeNavFocused` instead
          -- set only by an explicit user action (a Trade List row click, or
          this row's own Prev/Next/keyboard shortcuts once it's already
          visible), never by the auto-select effect -- so this is genuinely
          absent on first load and appears the moment someone starts
          navigating trades by any of those paths. */}
      {tradeNavFocused && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2 text-xs">
          <button
            onClick={() => tradeIdx > 0 && trades && pickTrade(trades[tradeIdx - 1].trade_id)}
            disabled={tradeIdx <= 0}
            className="h-7 rounded bg-surface-2 px-2 text-text hover:bg-surface-2-hover disabled:opacity-40"
          >
            &larr; Prev trade
          </button>
          <span className="tabular-nums text-text-muted">
            {trades && trades.length > 0 ? `Trade ${tradeIdx + 1} / ${trades.length}` : 'No trades'}
          </span>
          <button
            onClick={() => trades && tradeIdx < trades.length - 1 && pickTrade(trades[tradeIdx + 1].trade_id)}
            disabled={!trades || tradeIdx < 0 || tradeIdx >= trades.length - 1}
            className="h-7 rounded bg-surface-2 px-2 text-text hover:bg-surface-2-hover disabled:opacity-40"
          >
            Next trade &rarr;
          </button>

          <div className="mx-1 h-4 w-px bg-surface-2" />

          <button
            onClick={fitTrade}
            disabled={!selectedTrade}
            className="h-7 rounded bg-surface-2 px-2 text-text hover:bg-surface-2-hover disabled:opacity-40"
          >
            Fit trade
          </button>
          <button
            onClick={selectFullDay}
            disabled={!selectedTrade}
            className="h-7 rounded bg-surface-2 px-2 text-text hover:bg-surface-2-hover disabled:opacity-40"
          >
            Full day
          </button>

          {selectedTrade && (
            <span className="ml-auto text-xs text-text-muted">
              #{selectedTrade.trade_id} &middot; {selectedTrade.leg ?? '-'} &middot;{' '}
              {selectedTrade.session ?? '-'} &middot; {selectedTrade.side} &middot;{' '}
              <span className={`tabular-nums ${selectedTrade.pnl_usd >= 0 ? 'text-positive-fg' : 'text-negative-fg'}`}>
                {fmtUsd(selectedTrade.pnl_usd)}
              </span>
            </span>
          )}
        </div>
      )}

      <ReplayControls
        active={replayActive}
        bars={bars ?? []}
        cursorIndex={cursorIndex}
        onCursorIndexChange={setCursorIndex}
        isPlaying={isPlaying}
        onTogglePlaying={() => setIsPlaying(!isPlaying)}
        speed={speed}
        onSpeedChange={setSpeed}
        followLatestBar={followLatestBar}
        onToggleFollowLatestBar={toggleFollowLatestBar}
        pickingReplayStart={pickingReplayStart}
        onTogglePickingReplayStart={() => setPickingReplayStart((v) => !v)}
        runningPnl={replayTotals.pnlUsd}
        runningR={replayTotals.r}
        equity={equityAtCursorPoint}
      />

      <div className="flex min-h-0 flex-1">
        <KLDrawingToolbar klChartRef={klChartRef} drawings={klDrawings} armedTool={armedTool} />
        <div className={`min-h-0 min-w-0 flex-1 ${splitView ? 'flex flex-col' : ''}`}>
          <div className={splitView ? 'min-h-0 flex-1 border-b border-border' : 'h-full'}>
            <ChartKL
              ref={klChartRef}
              instrument={run?.instrument ?? null}
              timeframe={timeframe}
              from={barsWindow?.from ?? null}
              to={barsWindow?.to ?? null}
              trades={visibleTrades}
              selectedTrade={selectedTrade}
              indicators={indicators}
              sessionBands={sessionBands}
              prefs={indicatorPrefs}
              bracketDensity={bracketDensity}
              loading={barsFetching}
              cursorTime={cursorTime}
              followLatestBar={followLatestBar}
              onDrawingsChange={setKlDrawings}
              onDrawingArmedChange={setArmedTool}
              onVisibleRangeChange={splitView ? handlePrimaryKLVisibleRangeChange : undefined}
              onCandleBarClick={handlePickReplayStart}
              pickMode={pickingReplayStart}
            />
          </div>
          {splitView && (
            <div className="min-h-0 flex-1">
              <ChartKL
                ref={klSecondaryChartRef}
                instrument={run?.instrument ?? null}
                timeframe={secondaryTimeframe}
                from={barsWindow?.from ?? null}
                to={barsWindow?.to ?? null}
                trades={visibleTrades}
                selectedTrade={selectedTrade}
                indicators={EMPTY_INDICATORS}
                sessionBands={sessionBands}
                prefs={INDICATORS_OFF}
                bracketDensity={bracketDensity}
                loading={secondaryBarsFetching}
                cursorTime={cursorTime}
                followLatestBar={followLatestBar}
                onVisibleRangeChange={handleSecondaryKLVisibleRangeChange}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
