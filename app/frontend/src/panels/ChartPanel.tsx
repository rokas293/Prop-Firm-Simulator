import { useEffect, useMemo, useRef, useState } from 'react'
import PriceChart, { type PriceChartHandle } from '../chart/PriceChart'
import ChartKL, { type ChartKLHandle } from '../chart/kl/ChartKL'
import type { SessionBand } from '../chart/SessionBandsPrimitive'
import { equityAtCursor, runningTotals } from '../chart/replay'
import { withMargin } from '../chart/windowMargin'
import IndicatorTogglePanel from './IndicatorTogglePanel'
import KLDrawingToolbar, { DRAWING_SHORTCUTS } from './KLDrawingToolbar'
import type { PersistedOverlay } from '../chart/kl/drawingOverlays'
import ReplayControls from './ReplayControls'
import { useBars, useEquity, useIndicators, useRun, useSessions, useTrades } from '../api/hooks'
import { useUiStore } from '../state/uiStore'
import { filtersToParams, useTradeStore } from '../state/tradeStore'
import { useIndicatorStore, type IndicatorPrefs } from '../state/indicatorStore'
import { useChartViewStore } from '../state/chartViewStore'
import { useChartDefaultsStore } from '../state/chartDefaultsStore'
import { useChartEngineStore } from '../state/chartEngineStore'
import { applyCompassFilters } from '../compass/breakdowns'
import { isShortcut } from '../keyboard/shortcuts'
import EmptyState from '../components/EmptyState'
import type { BracketDensity } from '../chart/tradeBracket'
import type { IndicatorName } from '../api/types'

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

  const filters = useTradeStore((s) => s.filters)
  const clearFilters = useTradeStore((s) => s.clearFilters)
  const selectedTradeId = useTradeStore((s) => s.selectedTradeId)
  const selectTrade = useTradeStore((s) => s.selectTrade)

  const viewMode = useChartViewStore((s) => s.viewMode)
  const explicitDayWindow = useChartViewStore((s) => s.explicitDayWindow)
  const selectTradeView = useChartViewStore((s) => s.selectTradeView)
  const selectFullDay = useChartViewStore((s) => s.selectFullDay)
  const selectExplicitDay = useChartViewStore((s) => s.selectExplicitDay)
  const replayActive = useChartViewStore((s) => s.replayActive)
  const cursorIndex = useChartViewStore((s) => s.cursorIndex)
  const isPlaying = useChartViewStore((s) => s.isPlaying)
  const speed = useChartViewStore((s) => s.speed)
  const toggleReplay = useChartViewStore((s) => s.toggleReplay)
  const setCursorIndex = useChartViewStore((s) => s.setCursorIndex)
  const advanceCursor = useChartViewStore((s) => s.advanceCursor)
  const setIsPlaying = useChartViewStore((s) => s.setIsPlaying)
  const setSpeed = useChartViewStore((s) => s.setSpeed)
  const resetCursorForNewBars = useChartViewStore((s) => s.resetCursorForNewBars)

  const { data: run } = useRun(runId)
  const filterParams = useMemo(() => filtersToParams(filters), [filters])
  const { data: rawTrades } = useTrades(runId, filterParams)
  // Compass cross-filters, applied client-side same as TradeListPanel --
  // see tradeStore.ts's TradeFilters comment (POLISH_ROADMAP Phase P5).
  const trades = useMemo(() => applyCompassFilters(rawTrades ?? [], filters), [rawTrades, filters])

  const chartRef = useRef<PriceChartHandle>(null)
  const klChartRef = useRef<ChartKLHandle>(null)

  // Split view: a second, independently-timeframed chart of the same
  // instrument (POLISH_ROADMAP Phase P2), synced to the primary's visible
  // range + crosshair. `syncingRef` is a plain re-entrancy guard owned
  // here (not inside PriceChart): since ChartPanel drives both chart refs
  // directly and synchronously, it can guarantee a sibling's mirrored
  // change never bounces back, without guessing at Lightweight Charts'
  // internal event-dispatch timing (an earlier attempt at reactive
  // pan-driven fetching broke exactly on that uncertainty -- this sync is
  // deliberately just direct imperative calls between two known chart
  // instances, not a trigger for new data fetches).
  const [splitView, setSplitView] = useState(false)
  const [secondaryTimeframe, setSecondaryTimeframe] = useState<Timeframe>('15min')
  // Lifted out of ChartKL (PART_A_REVISED_klinecharts.md Phase A2) so
  // KLDrawingToolbar's manage dropdown can list/delete drawings without
  // polling the chart instance -- ChartKL calls back via onDrawingsChange
  // whenever the set actually changes (placed, dragged, removed, restored).
  const [klDrawings, setKlDrawings] = useState<PersistedOverlay[]>([])
  const secondaryChartRef = useRef<PriceChartHandle>(null)
  const syncingRef = useRef(false)

  // On-chart trade bracket density (POLISH_ROADMAP Phase P3): 'auto'
  // simplifies individually-narrow brackets to markers, 'full' always
  // draws the whole box, 'markers' always simplifies -- see
  // chart/tradeBracket.ts's shouldSimplify.
  // Persisted "data default" (POLISH_ROADMAP Phase P6's Settings panel),
  // not local state -- also settable from Settings, both reading the same
  // store.
  const bracketDensity = useChartDefaultsStore((s) => s.bracketDensity)
  const setBracketDensity = useChartDefaultsStore((s) => s.setBracketDensity)

  // KLineCharts engine feature flag (PART_A_REVISED_klinecharts.md Phase
  // A0'). Every control below this point that isn't yet wired up for the
  // KL engine (trade fitting, split view, brackets, indicators, drawings,
  // replay -- later phases) is hidden rather than left dead when
  // engine === 'kl', so there's never a button on screen that visibly does
  // nothing.
  const engine = useChartEngineStore((s) => s.engine)
  const setEngine = useChartEngineStore((s) => s.setEngine)
  const lwcEngine = engine === 'lwc'

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

  const { data: secondaryBars, isFetching: secondaryBarsFetching } = useBars(
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
    chartRef.current?.fitRange(selectedTrade.entry_time - pad, selectedTrade.exit_time + pad)
    klChartRef.current?.fitRange(selectedTrade.entry_time - pad, selectedTrade.exit_time + pad)
  }

  const pickTrade = (tradeId: number) => {
    selectTrade(tradeId)
    selectTradeView()
    // Immediate pan attempt (PART_A_REVISED_klinecharts.md Phase A1:
    // "clicking a trade... scrolls the chart to it") -- no-ops via the
    // ready-guard if this trade's bars haven't loaded into KL yet; the
    // bars-loaded effect below applies the real fit once they do.
    const trade = trades?.find((t) => t.trade_id === tradeId)
    if (trade) klChartRef.current?.scrollToTrade(trade.entry_time)
  }

  // Once new bars land for the active view, fit the chart to them. `bars`
  // is lightweight-charts' own fetch, but both engines are handed the same
  // computed window (see barsWindow below), so it's a reasonable proxy for
  // "the target window is now ready" for KL too -- KL's own fitRange
  // no-ops harmlessly via its ready-guard if its independent fetch hasn't
  // resolved yet.
  useEffect(() => {
    if (!bars || bars.length === 0) return
    if (viewMode === 'trade') {
      fitTrade()
    } else {
      chartRef.current?.fitContent()
      if (targetWindow) klChartRef.current?.fitRange(targetWindow.from, targetWindow.to)
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
      } else if (!lwcEngine && e.key === 'Escape') {
        // Cancel a still-in-progress drawing (PART_A_REVISED_klinecharts.md
        // Phase A2) -- shares the Escape key with the global
        // 'closeOverlay' shortcut (command palette/settings), which is
        // harmless: cancelActiveDrawing no-ops when nothing is being drawn.
        klChartRef.current?.cancelActiveDrawing()
      } else if (!lwcEngine && !e.ctrlKey && !e.metaKey && DRAWING_SHORTCUTS[e.key.toLowerCase()]) {
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
  }, [trades, tradeIdx, selectedTrade, lwcEngine])

  // Sync handlers: direct, synchronous imperative calls between the two
  // known chart instances -- see the syncingRef declaration's comment for
  // why this is safe without needing to guess at event-timing.
  const withSyncGuard = (fn: () => void) => {
    if (syncingRef.current) return
    syncingRef.current = true
    fn()
    queueMicrotask(() => {
      syncingRef.current = false
    })
  }

  const handlePrimaryVisibleRangeChange = (range: { from: number; to: number } | null) => {
    if (!splitView || !range) return
    withSyncGuard(() => secondaryChartRef.current?.setVisibleRange(range.from, range.to))
  }
  const handleSecondaryVisibleRangeChange = (range: { from: number; to: number } | null) => {
    if (!splitView || !range) return
    withSyncGuard(() => chartRef.current?.setVisibleRange(range.from, range.to))
  }
  const handlePrimaryCrosshairMove = (time: number | null) => {
    if (!splitView) return
    withSyncGuard(() => {
      if (time !== null) secondaryChartRef.current?.setCrosshairAt(time)
      else secondaryChartRef.current?.clearCrosshair()
    })
  }
  const handleSecondaryCrosshairMove = (time: number | null) => {
    if (!splitView) return
    withSyncGuard(() => {
      if (time !== null) chartRef.current?.setCrosshairAt(time)
      else chartRef.current?.clearCrosshair()
    })
  }

  if (!runId) {
    return <EmptyState title="No run selected" hint="Pick a run from the Runs list, or press Ctrl/Cmd+K to open one." />
  }

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-neutral-800 px-4 py-2 text-sm">
        {run && <span className="text-neutral-400">{run.instrument}</span>}

        <div className="mx-1 h-4 w-px bg-neutral-800" />

        <div className="flex gap-1">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf}
              onClick={() => setTimeframe(tf)}
              className={`rounded px-2 py-1 ${
                timeframe === tf
                  ? 'bg-accent-blue text-white'
                  : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700'
              }`}
            >
              {tf}
            </button>
          ))}
        </div>

        <div className="mx-1 h-4 w-px bg-neutral-800" />

        <button
          onClick={() => tradeIdx > 0 && trades && pickTrade(trades[tradeIdx - 1].trade_id)}
          disabled={tradeIdx <= 0}
          className="rounded bg-neutral-800 px-2 py-1 text-neutral-300 hover:bg-neutral-700 disabled:opacity-40"
        >
          &larr; Prev trade
        </button>
        <span className="text-neutral-400">
          {trades && trades.length > 0 ? `Trade ${tradeIdx + 1} / ${trades.length}` : 'No trades'}
        </span>
        <button
          onClick={() => trades && tradeIdx < trades.length - 1 && pickTrade(trades[tradeIdx + 1].trade_id)}
          disabled={!trades || tradeIdx < 0 || tradeIdx >= trades.length - 1}
          className="rounded bg-neutral-800 px-2 py-1 text-neutral-300 hover:bg-neutral-700 disabled:opacity-40"
        >
          Next trade &rarr;
        </button>

        <div className="mx-1 h-4 w-px bg-neutral-800" />

        <button
          onClick={fitTrade}
          disabled={!selectedTrade}
          className="rounded bg-neutral-800 px-2 py-1 text-neutral-300 hover:bg-neutral-700 disabled:opacity-40"
        >
          Fit trade
        </button>
        <button
          onClick={selectFullDay}
          disabled={!selectedTrade}
          className="rounded bg-neutral-800 px-2 py-1 text-neutral-300 hover:bg-neutral-700 disabled:opacity-40"
        >
          Full day
        </button>

        {lwcEngine && (
          <>
            <div className="mx-1 h-4 w-px bg-neutral-800" />

            <button
              onClick={() => setSplitView((v) => !v)}
              className={`rounded px-2 py-1 ${
                splitView ? 'bg-accent-blue text-white' : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700'
              }`}
            >
              Split view
            </button>
            {splitView && (
              <div className="flex gap-1">
                {TIMEFRAMES.filter((tf) => tf !== timeframe).map((tf) => (
                  <button
                    key={tf}
                    onClick={() => setSecondaryTimeframe(tf)}
                    className={`rounded px-2 py-1 ${
                      secondaryTimeframe === tf
                        ? 'bg-accent-blue text-white'
                        : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700'
                    }`}
                  >
                    {tf}
                  </button>
                ))}
              </div>
            )}

            <div className="mx-1 h-4 w-px bg-neutral-800" />

            <span className="text-neutral-500">Brackets</span>
            <div className="flex gap-1">
              {(['auto', 'full', 'markers'] as BracketDensity[]).map((d) => (
                <button
                  key={d}
                  onClick={() => setBracketDensity(d)}
                  title={
                    d === 'auto'
                      ? 'Simplify narrow brackets to markers when zoomed out'
                      : d === 'full'
                        ? 'Always show full brackets'
                        : 'Always show markers only'
                  }
                  className={`rounded px-2 py-1 capitalize ${
                    bracketDensity === d ? 'bg-accent-blue text-white' : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700'
                  }`}
                >
                  {d === 'markers' ? 'Off' : d}
                </button>
              ))}
            </div>
          </>
        )}

        <div className="mx-1 h-4 w-px bg-neutral-800" />

        {/* REDESIGN_APPROACH.md / PART_A_REVISED_klinecharts.md feature flag
            -- dropped once the KL engine reaches parity and
            lightweight-charts retires. */}
        <span className="text-neutral-500">Engine</span>
        <div className="flex gap-1">
          {(['lwc', 'kl'] as const).map((e) => (
            <button
              key={e}
              onClick={() => setEngine(e)}
              title={e === 'lwc' ? 'lightweight-charts (current)' : 'KLineCharts (in migration)'}
              className={`rounded px-2 py-1 uppercase ${
                engine === e ? 'bg-accent-blue text-white' : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700'
              }`}
            >
              {e}
            </button>
          ))}
        </div>

        {selectedTrade && (
          <span className="ml-auto text-xs text-neutral-500">
            #{selectedTrade.trade_id} &middot; {selectedTrade.leg ?? '-'} &middot;{' '}
            {selectedTrade.session ?? '-'} &middot; {selectedTrade.side} &middot; $
            {selectedTrade.pnl_usd.toFixed(2)}
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-800 px-4 py-1.5">
        <IndicatorTogglePanel />
      </div>

      <ReplayControls
        active={replayActive}
        onToggleActive={toggleReplay}
        bars={bars ?? []}
        cursorIndex={cursorIndex}
        onCursorIndexChange={setCursorIndex}
        isPlaying={isPlaying}
        onTogglePlaying={() => setIsPlaying(!isPlaying)}
        speed={speed}
        onSpeedChange={setSpeed}
        runningPnl={replayTotals.pnlUsd}
        runningR={replayTotals.r}
        equity={equityAtCursorPoint}
      />

      {lwcEngine ? (
        <div className={`min-h-0 flex-1 ${splitView ? 'flex flex-col' : ''}`}>
          <div className={splitView ? 'min-h-0 flex-1 border-b border-neutral-800' : 'h-full'}>
            <PriceChart
              ref={chartRef}
              instrument={run?.instrument ?? null}
              bars={bars ?? []}
              trades={visibleTrades}
              selectedTrade={selectedTrade}
              sessionBands={sessionBands}
              indicators={indicators}
              prefs={indicatorPrefs}
              bracketDensity={bracketDensity}
              loading={barsFetching}
              cursorTime={cursorTime}
              onVisibleRangeChange={splitView ? handlePrimaryVisibleRangeChange : undefined}
              onCrosshairMove={splitView ? handlePrimaryCrosshairMove : undefined}
            />
          </div>
          {splitView && (
            <div className="min-h-0 flex-1">
              <PriceChart
                ref={secondaryChartRef}
                instrument={run?.instrument ?? null}
                bars={secondaryBars ?? []}
                trades={visibleTrades}
                selectedTrade={selectedTrade}
                sessionBands={sessionBands}
                indicators={EMPTY_INDICATORS}
                prefs={INDICATORS_OFF}
                bracketDensity={bracketDensity}
                loading={secondaryBarsFetching}
                cursorTime={cursorTime}
                onVisibleRangeChange={handleSecondaryVisibleRangeChange}
                onCrosshairMove={handleSecondaryCrosshairMove}
              />
            </div>
          )}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <KLDrawingToolbar klChartRef={klChartRef} drawings={klDrawings} />
          <div className="min-h-0 flex-1">
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
              cursorTime={cursorTime}
              onDrawingsChange={setKlDrawings}
            />
          </div>
        </div>
      )}
    </div>
  )
}
