// FXR_SPEC.md phases F1/F2: a lean chart-only workspace for a manual-replay
// session -- deliberately NOT the full Workspace.tsx/ChartPanel.tsx (those
// are dockable-panel/trade-review machinery built around a COMPLETED
// automated-backtest run's fixed trades/equity, which doesn't exist here).
// Renders ChartKL directly in permanent replay mode, restores the cursor
// saved on the session, PATCHes it back to the backend as the user steps
// (F1), and (F2) drives the sim broker: one-click Buy/Sell/Close against
// chart/simBroker.ts's pure fill logic, journaling each closed trade.
import { useEffect, useMemo, useRef, useState } from 'react'
import ChartKL from '../chart/kl/ChartKL'
import type { SessionBand } from '../chart/kl/sessionOverlay'
import { runningTotals } from '../chart/replay'
import {
  closePosition,
  getContractSpec,
  marketFillPrice,
  openPositionAsTradeRecord,
  riskUsdAtEntry,
  type OpenPosition,
  type Side,
} from '../chart/simBroker'
import ReplayControls from '../panels/ReplayControls'
import PositionTicket from '../panels/PositionTicket'
import {
  useBtSession,
  useBtSessionTrades,
  useBars,
  useCreateManualTrade,
  useIndicators,
  useSessions,
  useUpdateBtSessionCursor,
} from '../api/hooks'
import { useIndicatorStore } from '../state/indicatorStore'
import type { Bar, IndicatorName, TradeRecord } from '../api/types'
import EmptyState from '../components/EmptyState'

// Sized so the fetched window still resolves at the session's own
// base_timeframe (bar_service.get_bars silently steps to a COARSER
// timeframe if a window would exceed max_points -- see its own comment --
// so this stays comfortably under that ceiling rather than right at it).
const MAX_POINTS = 3000
const BASE_TF_SECONDS: Record<string, number> = { '1min': 60, '5min': 300, '15min': 900, '1h': 3600 }

// Exported for direct unit testing (same pattern as client.ts's buildQuery)
// -- this is the exact-cursor-restore logic the F1 verification scenario
// depends on, so it's worth testing without mounting the whole workspace.
export function computeWindow(anchorTime: number, timeframe: string) {
  const barSeconds = BASE_TF_SECONDS[timeframe] ?? 300
  const totalSpanSeconds = barSeconds * MAX_POINTS
  // More room ahead than behind -- replay only ever moves forward from the
  // anchor, so most of the budget should be spent on not needing a refetch
  // as the cursor advances.
  return { from: anchorTime - totalSpanSeconds * 0.3, to: anchorTime + totalSpanSeconds * 0.7 }
}

export function resyncCursorIndex(bars: Bar[], targetTime: number | null): number {
  if (targetTime === null || bars.length === 0) return 0
  const exact = bars.findIndex((b) => b.time === targetTime)
  if (exact >= 0) return exact
  // No exact bar at that timestamp (can happen after a timeframe change) --
  // fall back to the latest bar at or before it, never one after (no
  // look-ahead past the saved cursor).
  let best = 0
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].time <= targetTime) best = i
  }
  return best
}

export default function SessionWorkspace({ sessionId }: { sessionId: string }) {
  const { data: session, isLoading, isError, error } = useBtSession(sessionId)
  const { data: manualTrades } = useBtSessionTrades(sessionId)
  const updateCursor = useUpdateBtSessionCursor()
  const createTrade = useCreateManualTrade()

  // FXR_SPEC.md phase F2: the sim broker's single open position. Local
  // state only, not persisted -- F2's own verify checklist doesn't require
  // an open position to survive a reload (unlike F1's cursor/account, which
  // explicitly does), and FXR_SPEC's "restores... open positions" is listed
  // among F4's fuller order-management scope, not F2's MVP. Documented
  // limitation, not an oversight: reloading mid-trade currently loses the
  // open position (the trade simply never got journaled).
  const [position, setPosition] = useState<OpenPosition | null>(null)

  const [windowAnchor, setWindowAnchor] = useState<number | null>(null)
  const [cursorIndex, setCursorIndexState] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [followLatestBar, setFollowLatestBar] = useState(false)
  const [pickingReplayStart, setPickingReplayStart] = useState(false)

  // The logical "current cursor time" this session should be at, kept in
  // sync with every setCursorIndexState call -- authoritative across a
  // bars refetch (a re-anchored window has a different array, so the
  // INDEX from before is meaningless; the TIME is what's real).
  const cursorTimeRef = useRef<number | null>(null)
  const loadedSessionIdRef = useRef<string | null>(null)

  // New session loaded (first mount, or switching sessions): anchor the
  // window on its saved cursor, not its start_time -- resuming should show
  // exactly where the session left off.
  useEffect(() => {
    if (!session || loadedSessionIdRef.current === session.id) return
    loadedSessionIdRef.current = session.id
    cursorTimeRef.current = session.cursor_time
    setWindowAnchor(session.cursor_time)
    setIsPlaying(false)
    setPosition(null)
  }, [session])

  const barsWindow = useMemo(
    () => (windowAnchor !== null && session ? computeWindow(windowAnchor, session.base_timeframe) : null),
    [windowAnchor, session?.base_timeframe],
  )

  const { data: bars, isFetching: barsFetching } = useBars(
    session?.instrument ?? null,
    session?.base_timeframe ?? '5min',
    barsWindow?.from ?? null,
    barsWindow?.to ?? null,
    MAX_POINTS,
  )

  // Every time a (possibly re-anchored) bars array lands, resolve the
  // logical cursor time back to an index into THIS array -- covers both
  // the initial resume and any later window shift the same way.
  useEffect(() => {
    if (!bars || bars.length === 0) return
    setCursorIndexState(resyncCursorIndex(bars, cursorTimeRef.current))
  }, [bars])

  const saveCursor = (cursorTime: number) => {
    if (!session) return
    cursorTimeRef.current = cursorTime
    updateCursor.mutate({ sessionId: session.id, cursorTime })
  }

  const handleCursorIndexChange = (i: number) => {
    setCursorIndexState(i)
    const t = bars?.[i]?.time
    if (t !== undefined) saveCursor(t)
    // Nearing the end of the loaded window -- shift the anchor forward so
    // continued stepping/playback keeps having bars to advance into,
    // instead of running off the end of a static window.
    if (bars && i >= bars.length - 20 && bars.length === MAX_POINTS) {
      setWindowAnchor(bars[i].time)
    }
  }

  useEffect(() => {
    if (!isPlaying || !bars || bars.length === 0) return
    const id = setInterval(() => {
      setCursorIndexState((prev) => {
        if (prev >= bars.length - 1) {
          setIsPlaying(false)
          return prev
        }
        const next = prev + 1
        saveCursor(bars[next].time)
        if (next >= bars.length - 20 && bars.length === MAX_POINTS) {
          setWindowAnchor(bars[next].time)
        }
        return next
      })
    }, 1000 / speed)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, bars, speed])

  const cursorTime = bars && bars[cursorIndex] ? bars[cursorIndex].time : null

  const { data: sessionsInView } = useSessions(
    session?.instrument ?? null,
    barsWindow?.from ?? null,
    barsWindow?.to ?? null,
  )
  const sessionBands: SessionBand[] = useMemo(
    () =>
      (sessionsInView ?? []).map((s) => ({
        start: s.start,
        end: s.end,
        session: s.session,
        fairValue: s.fair_value,
      })),
    [sessionsInView],
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
    session?.instrument ?? null,
    session?.base_timeframe ?? '5min',
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

  // FXR_SPEC.md section 3/6: market orders fill at the current cursor bar's
  // close (chart/simBroker.ts's documented convention) -- entry and exit
  // both read `bars[cursorIndex]` only, never a bar beyond it.
  const enterPosition = (side: Side) => {
    if (!session || !bars || !bars[cursorIndex] || position) return
    const entryBar = bars[cursorIndex]
    setPosition({
      side,
      contracts: session.account.default_contracts,
      entryPrice: marketFillPrice(entryBar),
      entryTime: entryBar.time,
      entryIndex: cursorIndex,
      riskUsd: riskUsdAtEntry(
        session.account.balance,
        session.account.risk_per_trade_percent,
        session.account.risk_per_trade_usd,
      ),
    })
  }

  const handleClosePosition = () => {
    if (!session || !bars || !position) return
    const spec = getContractSpec(session.instrument)
    const result = closePosition(bars, position, cursorIndex, spec, session.account.commission_per_contract)
    createTrade.mutate(
      {
        sessionId: session.id,
        body: {
          entry_time: result.entryTime,
          exit_time: result.exitTime,
          instrument: session.instrument,
          side: result.side,
          leg: null,
          session: null,
          trading_day: null,
          size_contracts: result.contracts,
          entry_price: result.entryPrice,
          exit_price: result.exitPrice,
          sl_price: null,
          tp_price: null,
          sl_points: null,
          tp_points: null,
          rr_planned: null,
          exit_type: 'manual_close',
          pnl_usd: result.pnlUsd,
          r_multiple: result.rMultiple,
          commission_usd: result.commissionUsd,
          mae_points: result.maePoints,
          mfe_points: result.mfePoints,
          mae_r: result.maeR,
          mfe_r: result.mfeR,
          bars_held: result.barsHeld,
        },
      },
      { onSuccess: () => setPosition(null) },
    )
  }

  // The open position rendered through the SAME TradeRecord shape a closed
  // trade uses (see openPositionAsTradeRecord's own comment) -- zero
  // chart-side changes needed to show it with the existing entry marker/
  // trade-overlay conventions.
  const openPositionRecord: TradeRecord | null =
    position && session && bars && bars[cursorIndex]
      ? openPositionAsTradeRecord({
          position,
          instrument: session.instrument,
          cursorIndex,
          markPrice: bars[cursorIndex].close,
          cursorTime: bars[cursorIndex].time,
        })
      : null

  const chartTrades: TradeRecord[] = useMemo(
    () => [...(manualTrades ?? []), ...(openPositionRecord ? [openPositionRecord] : [])],
    [manualTrades, openPositionRecord],
  )

  const replayTotals = useMemo(() => runningTotals(manualTrades ?? [], cursorTime), [manualTrades, cursorTime])

  const handleCandleBarClick = (bar: { timestamp: number }) => {
    if (!pickingReplayStart || !bars) return
    const clickedTimeSec = bar.timestamp / 1000
    const index = bars.findIndex((b) => b.time === clickedTimeSec)
    if (index >= 0) handleCursorIndexChange(index)
    setPickingReplayStart(false)
  }

  if (isLoading) {
    return <EmptyState title="Loading session…" />
  }
  if (isError || !session) {
    return <EmptyState title="Failed to load session" hint={(error as Error | undefined)?.message} />
  }

  return (
    <div className="flex h-full w-full flex-col">
      <ReplayControls
        active
        bars={bars ?? []}
        cursorIndex={cursorIndex}
        onCursorIndexChange={handleCursorIndexChange}
        isPlaying={isPlaying}
        onTogglePlaying={() => setIsPlaying((v) => !v)}
        speed={speed}
        onSpeedChange={setSpeed}
        followLatestBar={followLatestBar}
        onToggleFollowLatestBar={() => setFollowLatestBar((v) => !v)}
        pickingReplayStart={pickingReplayStart}
        onTogglePickingReplayStart={() => setPickingReplayStart((v) => !v)}
        runningPnl={replayTotals.pnlUsd}
        runningR={replayTotals.r}
        equity={null}
      />
      <PositionTicket
        disabled={!bars || bars.length === 0}
        position={
          position && openPositionRecord
            ? {
                instrument: session.instrument,
                side: position.side,
                contracts: position.contracts,
                entryPrice: position.entryPrice,
                pnlUsd: openPositionRecord.pnl_usd,
                rMultiple: openPositionRecord.r_multiple,
              }
            : null
        }
        onBuy={() => enterPosition('long')}
        onSell={() => enterPosition('short')}
        onClose={handleClosePosition}
        closing={createTrade.isPending}
      />
      <div className="min-h-0 flex-1">
        <ChartKL
          instrument={session.instrument}
          timeframe={session.base_timeframe}
          from={barsWindow?.from ?? null}
          to={barsWindow?.to ?? null}
          trades={chartTrades}
          selectedTrade={openPositionRecord}
          indicators={indicators}
          sessionBands={sessionBands}
          prefs={indicatorPrefs}
          loading={barsFetching}
          cursorTime={cursorTime}
          followLatestBar={followLatestBar}
          onCandleBarClick={handleCandleBarClick}
          pickMode={pickingReplayStart}
        />
      </div>
    </div>
  )
}
