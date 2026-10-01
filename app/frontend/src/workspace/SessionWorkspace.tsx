// FXR_SPEC.md phases F1/F2/F3: a lean chart-only workspace for a manual-
// replay session -- deliberately NOT the full Workspace.tsx/ChartPanel.tsx
// (those are dockable-panel/trade-review machinery built around a
// COMPLETED automated-backtest run's fixed trades/equity, which doesn't
// exist here). Renders ChartKL directly in permanent replay mode, restores
// the cursor saved on the session, PATCHes it back to the backend as the
// user steps (F1), drives the sim broker's market Buy/Sell/Close (F2), and
// (F3) the "New Trade" drag ticket + right-click limit/stop orders against
// chart/simBroker.ts's pure fill logic, journaling each closed trade.
import { useEffect, useMemo, useRef, useState } from 'react'
import ChartKL, { type ChartKLHandle } from '../chart/kl/ChartKL'
import type { SessionBand } from '../chart/kl/sessionOverlay'
import { runningTotals } from '../chart/replay'
import { positionCapMessage } from '../chart/positionCap'
import { combineBanner } from '../compass/propResult'
import {
  advanceReplay,
  closePosition,
  closePositionPartialAtMarket,
  computeAutoSize,
  fromPersistedPosition,
  fromPersistedWorkingOrder,
  getContractSpec,
  impliedOrderType,
  marketFillPrice,
  openPositionAsTradeRecord,
  riskUsdAtEntry,
  toPersistedPosition,
  toPersistedWorkingOrder,
  type ClosedTradeResult,
  type OpenPosition,
  type PendingOrderType,
  type Side,
  type WorkingOrder,
} from '../chart/simBroker'
import type { ContextMenuEntry } from '../components/ContextMenu'
import ReplayControls from '../panels/ReplayControls'
import PositionTicket, { type WorkingOrderSummary } from '../panels/PositionTicket'
import TradeTicketPanel, { type TicketReadout } from '../panels/TradeTicketPanel'
import JournalPanel from '../panels/JournalPanel'
import {
  useBtSession,
  useBtSessionTrades,
  useBars,
  useCreateManualTrade,
  useAddTradeScreenshot,
  useDeleteTradeScreenshot,
  useIndicators,
  useSessions,
  useStats,
  useUpdateBtSessionCursor,
  useUpdateBtSessionNotes,
  useUpdateTradeJournal,
} from '../api/hooks'
import { useIndicatorStore } from '../state/indicatorStore'
import { useUiStore } from '../state/uiStore'
import { useThemeBase } from '../state/themeStore'
import {
  manualRunId,
  type AddScreenshotRequest,
  type Bar,
  type CreateManualTradeRequest,
  type IndicatorName,
  type ManualTrade,
  type TradeRecord,
  type UpdateTradeJournalRequest,
} from '../api/types'
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

// The CAMERA's default view is deliberately much tighter than the FETCH
// window above -- same split ChartPanel.tsx already makes between "how
// much to fetch" (a wide margin, so panning/stepping rarely needs a
// refetch -- see withMargin's own comment) and "what fitRange shows by
// default" (ChartPanel calls fitTrade/fitRange to just the relevant
// range, not the whole fetched window). Without this split, the camera
// showed the full ~10-day fetch window at once, so a single trade
// (typically a handful of bars) was invisible without the user manually
// zooming in first.
const DEFAULT_FIT_BARS = 120

export function defaultFitWindow(anchorTime: number, timeframe: string) {
  const barSeconds = BASE_TF_SECONDS[timeframe] ?? 300
  const totalSpanSeconds = barSeconds * DEFAULT_FIT_BARS
  return { from: anchorTime - totalSpanSeconds * 0.3, to: anchorTime + totalSpanSeconds * 0.7 }
}

// FXR_SPEC.md section C, phase F5's trade-review jump: pads a journaled
// trade's own entry/exit span so both lines are comfortably in view, not
// pinned to the edges. Deliberately a pure, directly-testable function
// (same "testable without mounting the workspace" pattern as
// computeWindow/defaultFitWindow above) -- the caller (handleJumpToTrade)
// clamps this against whatever bars are ACTUALLY loaded before handing it
// to ChartKL's fitRange, since a trade from earlier in a long session can
// fall outside the currently fetched window.
const REVIEW_PAD_BARS = 15

export function reviewFitWindow(entryTime: number, exitTime: number, timeframe: string) {
  const barSeconds = BASE_TF_SECONDS[timeframe] ?? 300
  const pad = barSeconds * REVIEW_PAD_BARS
  const lo = Math.min(entryTime, exitTime)
  const hi = Math.max(entryTime, exitTime)
  return { from: lo - pad, to: hi + pad }
}

// FXR_SPEC.md section C: auto-tags a journaled trade with the trading
// session (Asia/London/NY, etc.) its entry falls in -- reuses the exact
// band data already fetched for the chart's session-band overlay
// (`sessionsInView` below), rather than re-deriving it. This repoints
// ManualTrade's pre-existing `session` field (schema-compat with the
// automated-backtest trade model, FXR_SPEC section 2) to something real
// instead of always sending null, and is what the journal's "filter by
// session" reads.
export function sessionForTime(bands: SessionBand[], time: number): string | null {
  const band = bands.find((b) => time >= b.start && time < b.end)
  return band ? band.session : null
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

// FXR_SPEC.md phase F3's "New Trade" ticket defaults -- a simple fixed
// starting point the user is expected to drag to fit their own analysis,
// not a "smart" volatility-derived guess (the whole point is the 3 lines
// are draggable). Deliberately the same for MES/MNQ despite their
// different point values -- it's a STARTING offset, not a risk figure.
const DEFAULT_TICKET_SL_POINTS = 10
const DEFAULT_TICKET_RR = 2

// Snap a right-click/drag price to the instrument's own tick size so a
// pixel-converted price never shows an ugly, unfillable-in-reality
// fraction (e.g. 5661.2382).
function roundToTick(price: number, tickSize: number): number {
  return Math.round(price / tickSize) * tickSize
}

export default function SessionWorkspace({ sessionId }: { sessionId: string }) {
  const { data: session, isLoading, isError, error } = useBtSession(sessionId)
  const { data: manualTrades } = useBtSessionTrades(sessionId)
  const updateCursor = useUpdateBtSessionCursor()
  const createTrade = useCreateManualTrade()
  const updateSessionNotes = useUpdateBtSessionNotes()
  const updateTradeJournal = useUpdateTradeJournal()
  const addTradeScreenshot = useAddTradeScreenshot()
  const deleteTradeScreenshot = useDeleteTradeScreenshot()
  const themeBase = useThemeBase()

  // FXR_SPEC.md section C, phase F5: the journal drawer -- local UI state,
  // not persisted (unlike everything it shows, which lives on the backend).
  const [journalOpen, setJournalOpen] = useState(false)
  // Why the last order was refused (Topstep position cap) -- quiet, dismissible.
  const [orderNotice, setOrderNotice] = useState<string | null>(null)
  // A Topstep session's Combine verdict (the same PropRulesTracker result the
  // analytics Dashboard shows); disabled (null run id) for a practice session.
  const propRunId = session?.account.prop_ruleset ? manualRunId(session.id) : null
  const { data: propStats } = useStats(propRunId, 'all')
  const banner = combineBanner(propStats?.result)
  // FXR_SPEC.md phase F6: "Open in journal" from the analytics workspace
  // lands here with one trade to show -- opens the drawer on it, once.
  const selectRun = useUiStore((s) => s.selectRun)
  const pendingJournalTrade = useUiStore((s) => s.pendingJournalTrade)
  const consumeJournalTrade = useUiStore((s) => s.consumeJournalTrade)
  const [journalInitialTrade, setJournalInitialTrade] = useState<number | null>(null)
  useEffect(() => {
    if (pendingJournalTrade === null) return
    setJournalInitialTrade(pendingJournalTrade)
    setJournalOpen(true)
    consumeJournalTrade()
  }, [pendingJournalTrade, consumeJournalTrade])

  // FXR_SPEC.md phase F2/F3/F4: the sim broker's single open position and
  // working orders. Local state, mirrored to the backend on every change
  // (see `persist` below) -- F4 closes the F2/F3-era gap where a mid-trade
  // reload silently lost the open position/working order; restore-on-load
  // is the effect further down keyed on `restoredForSessionRef`.
  //
  // Single-position limit (documented, not implemented as multiple
  // concurrent positions -- FXR_SPEC.md phase F4 explicitly allows
  // documenting this instead): `position` is a single OpenPosition | null,
  // and every entry path (enterPosition/confirmTicket/advanceReplay's
  // order-fill branch) is gated on `flat` below, same as F2/F3. A second
  // position can't be opened until the first is fully closed.
  const [position, setPosition] = useState<OpenPosition | null>(null)
  const [workingOrders, setWorkingOrders] = useState<WorkingOrder[]>([])
  // The "New Trade" drag ticket in progress -- entry/SL/TP prices only;
  // side is DERIVED (tpPrice relative to entryPrice), never stored, so it
  // can never drift out of sync with the lines actually drawn.
  const [ticket, setTicket] = useState<{ entryPrice: number; slPrice: number; tpPrice: number } | null>(null)
  // F4's optional toggles, ARMED state for the next trade while flat --
  // once a position is open, PositionTicket's same two controls instead
  // read/write that position's own autoBreakeven/trailingPoints fields
  // directly (see handleAutoBreakevenChange/handleTrailingPointsChange).
  const [armedAutoBreakeven, setArmedAutoBreakeven] = useState(false)
  const [armedTrailingPoints, setArmedTrailingPoints] = useState<number | null>(null)

  const [windowAnchor, setWindowAnchor] = useState<number | null>(null)
  const [cursorIndex, setCursorIndexState] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  // ON by default in a REPLAY session (ChartKL's own prop defaults to off,
  // which is right for reviewing a finished backtest where nothing moves).
  // With it off, the camera is frozen by design -- correct for panning back
  // through history, but it means the replay cursor walks off the right
  // edge after ~5 steps and the user has to pan after every one. Following
  // keeps the newly revealed bar in view, nudging by exactly one bar only
  // once it reaches the edge (see chart/kl/cameraPreserve.ts), which is the
  // behavior FX Replay itself has and what FXR_SPEC section 4A's step/play
  // loop assumes.
  const [followLatestBar, setFollowLatestBar] = useState(true)
  const [pickingReplayStart, setPickingReplayStart] = useState(false)

  // The logical "current cursor time" this session should be at, kept in
  // sync with every setCursorIndexState call -- authoritative across a
  // bars refetch (a re-anchored window has a different array, so the
  // INDEX from before is meaningless; the TIME is what's real).
  const cursorTimeRef = useRef<number | null>(null)
  // Mirrors cursorIndex/position/workingOrders for synchronous reads from
  // the play-interval's setInterval callback (a plain function, not a
  // React reducer -- see advanceTo's own comment for why that distinction
  // matters here).
  const cursorIndexRef = useRef(0)
  const positionRef = useRef<OpenPosition | null>(null)
  const workingOrdersRef = useRef<WorkingOrder[]>([])
  const loadedSessionIdRef = useRef<string | null>(null)
  // F4 restore-on-load: guards the restore effect below against re-running
  // for the SAME session -- `session` itself changes identity on every
  // persist (its onSuccess writes the fresh response into the query cache),
  // so without this guard every local change would immediately be
  // overwritten by re-restoring from what was just echoed back.
  const restoredForSessionRef = useRef<string | null>(null)
  const klChartRef = useRef<ChartKLHandle>(null)

  // New session loaded (first mount, or switching sessions): anchor the
  // window on its saved cursor, not its start_time -- resuming should show
  // exactly where the session left off.
  useEffect(() => {
    if (!session || loadedSessionIdRef.current === session.id) return
    loadedSessionIdRef.current = session.id
    restoredForSessionRef.current = null
    cursorTimeRef.current = session.cursor_time
    setWindowAnchor(session.cursor_time)
    setIsPlaying(false)
    setPosition(null)
    positionRef.current = null
    setWorkingOrders([])
    workingOrdersRef.current = []
    setTicket(null)
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

  // F4: once this (new) session's bars have loaded, restore its persisted
  // position/working orders -- entry_time/placed_time are re-resolved to
  // indices into THIS bars array via resyncCursorIndex, the exact same
  // time->index recovery cursor_time itself already uses (see that
  // function's own comment for why an index can never survive a reload
  // directly). Runs at most once per session id (restoredForSessionRef).
  useEffect(() => {
    if (!session || !bars || bars.length === 0 || restoredForSessionRef.current === session.id) return
    restoredForSessionRef.current = session.id
    if (session.position) {
      const entryIndex = resyncCursorIndex(bars, session.position.entry_time)
      const restored = fromPersistedPosition(session.position, entryIndex)
      positionRef.current = restored
      setPosition(restored)
    }
    if (session.working_orders.length > 0) {
      const restored = session.working_orders.map((o) => fromPersistedWorkingOrder(o, resyncCursorIndex(bars, o.placed_time)))
      workingOrdersRef.current = restored
      setWorkingOrders(restored)
    }
  }, [session, bars])

  // Every time a (possibly re-anchored) bars array lands, resolve the
  // logical cursor time back to an index into THIS array -- covers both
  // the initial resume and any later window shift the same way. This is
  // React's documented "adjust state during render" pattern (setState
  // called mid-render, not inside useEffect) -- deliberately NOT a
  // useEffect: an effect-based resync commits ONE extra render with
  // cursorIndex still at its stale default (0 -> bars[0].time, which for
  // the wide fetch window is ~3 days before the real cursor) BEFORE the
  // correction lands, and ChartKL reacts to every `cursorTime` change with
  // its own resetData()+camera-preserve effect (see its own comment), so
  // that one bad render was enough to permanently poison the preserved
  // camera position.
  //
  // The "have we synced this bars array yet" tracker MUST be useState,
  // not a ref: confirmed live under StrictMode (main.tsx wraps the app in
  // it) that a ref mutated conditionally during render is not safe here --
  // StrictMode intentionally double-invokes the render body, and the ref
  // write from the first (thrown-away) invocation persists into the
  // second, so the second invocation sees the ref already "caught up" and
  // skips the corresponding setCursorIndexState call, leaving the actually-
  // committed render on the stale index. useState's bookkeeping is,
  // unlike a ref, itself part of what StrictMode re-derives correctly on
  // each invocation -- this is React's own documented pattern for exactly
  // this "adjust state when a prop changes" case, ref-based prevValue
  // tracking is explicitly not it.
  const [syncedBars, setSyncedBars] = useState<Bar[] | null>(null)
  if (bars && bars !== syncedBars) {
    setSyncedBars(bars)
    const resynced = resyncCursorIndex(bars, cursorTimeRef.current)
    if (resynced !== cursorIndex) setCursorIndexState(resynced)
    cursorIndexRef.current = resynced
  }

  // Fit the camera to a tight window around the anchor -- see
  // defaultFitWindow's own comment for why this is deliberately much
  // narrower than the fetch window. NOT driven off `bars` (the parent's
  // own query resolving): ChartKL fetches its OWN bars internally via a
  // separate async call (setDataLoader's getBars), so a `bars`-keyed
  // effect races it -- confirmed live, klChartRef.current.fitRange() was
  // firing while ChartKL's internal loadedBarsRef still held a single
  // placeholder bar, so the call landed on stale data and got overwritten
  // by klinecharts' own default zoom-to-fit-everything once the real data
  // arrived. onVisibleRangeChange fires once ChartKL's real data has
  // actually rendered (its own auto-range on load included) -- a reliable
  // "child is ready" signal the imperative handle has no callback for.
  const initialFitAppliedRef = useRef(false)
  useEffect(() => {
    initialFitAppliedRef.current = false
  }, [bars])
  const handleChartVisibleRangeChange = (range: { from: number; to: number } | null) => {
    // null means ChartKL's own data list is still empty (see its own
    // handleVisibleRangeChange) -- not yet the "real data is ready" signal.
    if (!range || initialFitAppliedRef.current || windowAnchor === null || !session) return
    initialFitAppliedRef.current = true
    const fit = defaultFitWindow(windowAnchor, session.base_timeframe)
    klChartRef.current?.fitRange(fit.from, fit.to)
  }

  // F4: every position-changing action (not just a replay step) PATCHes
  // the FULL current broker-state snapshot -- see UpdateSessionStateRequest's
  // own comment for why this is a full snapshot, never a partial patch.
  // Reads position/workingOrders from the REFS (always current, unlike
  // React state inside the same synchronous handler that just called
  // setPosition/setWorkingOrders) so every call site can update the refs
  // first and then call this with no extra parameters.
  const persist = (cursorTimeOverride?: number) => {
    if (!session) return
    const cursorTime = cursorTimeOverride ?? cursorTimeRef.current
    if (cursorTime === null) return
    cursorTimeRef.current = cursorTime
    updateCursor.mutate({
      sessionId: session.id,
      cursorTime,
      position: positionRef.current ? toPersistedPosition(positionRef.current) : null,
      workingOrders: workingOrdersRef.current.map(toPersistedWorkingOrder),
    })
  }

  // Builds the journal request body from a closed trade -- shared by a
  // manual Close (F2), a partial close (F4), and an SL/TP auto-close
  // during replay advance (F3), so all three never drift into two
  // different ideas of what a "closed trade" record looks like.
  //
  // Returns the mutation's promise (mutateAsync, not the fire-and-forget
  // `mutate`) so callers can AWAIT it before their own persist() call --
  // both this (POST /trades) and persist() (PATCH .../cursor) do their own
  // read-modify-write of the SAME session.json server-side (see
  // bt_session_service.py's record_trade/update_cursor), so firing them
  // without a real ordering guarantee races: whichever one's own _read()
  // happens to land first would silently overwrite the OTHER's write with
  // stale data once it writes back. Confirmed live during F4 verification
  // (a partial close's persisted position reverted to its PRE-close
  // contract count) before this await was added.
  const journalClosedTrade = async (trade: ClosedTradeResult) => {
    if (!session) return
    const slPoints = trade.slPrice !== null ? Math.abs(trade.entryPrice - trade.slPrice) : null
    const tpPoints = trade.tpPrice !== null ? Math.abs(trade.tpPrice - trade.entryPrice) : null
    const body: CreateManualTradeRequest = {
      entry_time: trade.entryTime,
      exit_time: trade.exitTime,
      instrument: session.instrument,
      side: trade.side,
      leg: null,
      session: sessionForTime(sessionBands, trade.entryTime),
      trading_day: null,
      size_contracts: trade.contracts,
      entry_price: trade.entryPrice,
      exit_price: trade.exitPrice,
      sl_price: trade.slPrice,
      tp_price: trade.tpPrice,
      sl_points: slPoints,
      tp_points: tpPoints,
      rr_planned: slPoints && tpPoints ? tpPoints / slPoints : null,
      exit_type: trade.exitType,
      pnl_usd: trade.pnlUsd,
      r_multiple: trade.rMultiple,
      commission_usd: trade.commissionUsd,
      mae_points: trade.maePoints,
      mfe_points: trade.mfePoints,
      mae_r: trade.maeR,
      mfe_r: trade.mfeR,
      bars_held: trade.barsHeld,
    }
    await createTrade.mutateAsync({ sessionId: session.id, body })
  }

  // The single place replay ever moves the cursor forward or back --
  // FXR_SPEC.md section 3's no-look-ahead fill loop (chart/simBroker.ts's
  // advanceReplay) runs here so working orders/SL/TP are evaluated against
  // every bar in between, not just the destination one. Deliberately a
  // plain function called from event handlers/setInterval, NOT a
  // setCursorIndexState(prev => ...) functional updater: React (in
  // StrictMode) double-invokes updater functions to catch impure ones,
  // and this one's side effects (mutating the position/order state,
  // POSTing a journaled trade, PATCHing the cursor) must fire exactly
  // once per step, not twice -- reading cursorIndexRef instead of an
  // updater's `prev` gets the same "always current" guarantee without
  // that risk.
  const advanceTo = async (newIndex: number) => {
    if (!session || !bars) return
    const spec = getContractSpec(session.instrument)
    const result = advanceReplay(
      bars,
      cursorIndexRef.current,
      newIndex,
      positionRef.current,
      workingOrdersRef.current,
      spec,
      session.account.commission_per_contract,
    )
    positionRef.current = result.position
    workingOrdersRef.current = result.workingOrders
    setPosition(result.position)
    setWorkingOrders(result.workingOrders)

    cursorIndexRef.current = newIndex
    setCursorIndexState(newIndex)
    const t = bars[newIndex]?.time
    // Journal any closed trade(s) BEFORE persisting -- both this (POST
    // /trades) and persist() (PATCH .../cursor) do their own read-modify-
    // write of the SAME session.json server-side, so awaiting the journal
    // first (see journalClosedTrade's own comment) guarantees persist's
    // own read sees the post-trade balance AND that persist's write --
    // carrying the correct post-close position/working_orders -- lands
    // last, rather than racing and possibly being silently overwritten.
    for (const trade of result.closedTrades) await journalClosedTrade(trade)
    if (t !== undefined) persist(t)
    // Nearing the end of the loaded window -- shift the anchor forward so
    // continued stepping/playback keeps having bars to advance into,
    // instead of running off the end of a static window.
    if (newIndex >= bars.length - 20 && bars.length === MAX_POINTS) {
      setWindowAnchor(bars[newIndex].time)
    }
  }

  const handleCursorIndexChange = (i: number) => advanceTo(i)

  useEffect(() => {
    if (!isPlaying || !bars || bars.length === 0) return
    const id = setInterval(() => {
      const prev = cursorIndexRef.current
      if (prev >= bars.length - 1) {
        setIsPlaying(false)
        return
      }
      advanceTo(prev + 1)
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

  // FXR_SPEC.md section C, phase F5's trade-review jump: a camera-only pan
  // (fitRange), never a change to replay state (cursorIndex/position/
  // working orders) -- reviewing an old trade must be side-effect-free, so
  // it can never re-trigger a fill or desync the cursor from the session's
  // actual live progress. Clamped to whatever bars are ALREADY loaded (see
  // reviewFitWindow's own comment) rather than re-anchoring the fetch
  // window to reach a trade outside it -- that would swap out the loaded
  // `bars` array under the live cursor's feet, which IS unsafe (advanceTo
  // indexes into `bars` by position, not time).
  const handleJumpToTrade = (trade: ManualTrade) => {
    if (!session || !bars || bars.length === 0) return
    const fit = reviewFitWindow(trade.entry_time, trade.exit_time, session.base_timeframe)
    const from = Math.max(fit.from, bars[0].time)
    const to = Math.min(fit.to, bars[bars.length - 1].time)
    if (from >= to) return
    klChartRef.current?.fitRange(from, to)
  }

  const handleUpdateSessionNotes = (notes: string) => {
    if (!session) return
    updateSessionNotes.mutate({ sessionId: session.id, notes })
  }

  const handleUpdateTradeJournal = (tradeId: number, body: UpdateTradeJournalRequest) => {
    if (!session) return
    updateTradeJournal.mutate({ sessionId: session.id, tradeId, body })
  }

  const handleAddScreenshot = (tradeId: number, body: AddScreenshotRequest) => {
    if (!session) return
    addTradeScreenshot.mutate({ sessionId: session.id, tradeId, body })
  }

  const handleDeleteScreenshot = (tradeId: number, screenshotId: string) => {
    if (!session) return
    deleteTradeScreenshot.mutate({ sessionId: session.id, tradeId, screenshotId })
  }

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

  // True while nothing is armed/working/open -- the shared gate for every
  // action that starts a new trade (Buy/Sell, New Trade, a right-click
  // order): at most one position-in-progress at a time, same single-
  // position simplification F2 already established.
  const flat = !position && workingOrders.length === 0 && !ticket

  // FXR_SPEC.md section 3/6: market orders fill at the current cursor bar's
  // close (chart/simBroker.ts's documented convention) -- entry and exit
  // both read `bars[cursorIndex]` only, never a bar beyond it.
  const enterPosition = (side: Side) => {
    if (!session || !bars || !bars[cursorIndex] || !flat) return
    const capMsg = positionCapMessage(session.account.default_contracts, session.account.max_contracts, 'Market order')
    if (capMsg) {
      setOrderNotice(capMsg)
      return
    }
    setOrderNotice(null)
    const entryBar = bars[cursorIndex]
    const newPosition: OpenPosition = {
      side,
      contracts: session.account.default_contracts,
      entryPrice: marketFillPrice(entryBar),
      entryTime: entryBar.time,
      entryIndex: cursorIndex,
      riskUsd: riskUsdAtEntry(session.account.balance, session.account.risk_per_trade_percent, session.account.risk_per_trade_usd),
      slPrice: null,
      tpPrice: null,
      autoBreakeven: armedAutoBreakeven,
      trailingPoints: armedTrailingPoints,
    }
    positionRef.current = newPosition
    setPosition(newPosition)
    persist()
  }

  const handleClosePosition = async () => {
    if (!session || !bars || !position) return
    const spec = getContractSpec(session.instrument)
    const result = closePosition(bars, position, cursorIndex, spec, session.account.commission_per_contract)
    positionRef.current = null
    setPosition(null)
    // Journal BEFORE persisting -- see journalClosedTrade's own comment on
    // why the order matters (both endpoints race on the same session.json
    // otherwise).
    await journalClosedTrade(result)
    persist()
  }

  // FXR_SPEC.md phase F4: closes half the position at market, journaling
  // that slice as its own closed trade and leaving the remainder open
  // (same avg entry/SL/TP -- there's only ever one entry fill in this
  // model, see closePositionPartial's own comment). Rounds to the nearest
  // whole contract; if that's the WHOLE position (e.g. 1 contract), this
  // is equivalent to a full Close.
  const handlePartialClose = async () => {
    if (!session || !bars || !position) return
    const spec = getContractSpec(session.instrument)
    const half = Math.max(1, Math.round(position.contracts / 2))
    const result = closePositionPartialAtMarket(bars, position, cursorIndex, half, spec, session.account.commission_per_contract)
    positionRef.current = result.remainingPosition
    setPosition(result.remainingPosition)
    await journalClosedTrade(result.closedTrade)
    persist()
  }

  // FXR_SPEC.md phase F4's optional toggles: FLAT, these arm the toggle
  // for the next trade; with a position OPEN, they read/write its live
  // fields directly and re-persist immediately (PositionTicket's own
  // comment explains the dual purpose -- this is where it's decided).
  const handleAutoBreakevenChange = (v: boolean) => {
    if (position) {
      const updated = { ...position, autoBreakeven: v }
      positionRef.current = updated
      setPosition(updated)
      persist()
    } else {
      setArmedAutoBreakeven(v)
    }
  }
  const handleTrailingPointsChange = (v: number | null) => {
    if (position) {
      const updated = { ...position, trailingPoints: v }
      positionRef.current = updated
      setPosition(updated)
      persist()
    } else {
      setArmedTrailingPoints(v)
    }
  }

  // ChartKL's F4 draggable open-position SL/TP lines (see its
  // openPositionEditor prop) -- re-computes open R live off the new
  // levels for free, since PositionTicket's readout already derives R
  // from `openPositionRecord`, which itself derives from `position`.
  const handleOpenPositionSlTpChange = (next: { slPrice: number | null; tpPrice: number | null }) => {
    if (!position) return
    const updated = { ...position, slPrice: next.slPrice, tpPrice: next.tpPrice }
    positionRef.current = updated
    setPosition(updated)
    persist()
  }

  // "New Trade" (FXR_SPEC.md section B): arms the ticket at sensible
  // defaults around the current market price -- the user drags all 3
  // lines from there (see ChartKL's tradeTicket prop).
  const openTicket = () => {
    if (!bars || !bars[cursorIndex] || !flat) return
    const marketPrice = bars[cursorIndex].close
    setTicket({
      entryPrice: marketPrice,
      slPrice: marketPrice - DEFAULT_TICKET_SL_POINTS,
      tpPrice: marketPrice + DEFAULT_TICKET_SL_POINTS * DEFAULT_TICKET_RR,
    })
  }
  const handleTicketChange = (prices: { entryPrice: number; slPrice: number; tpPrice: number }) => {
    setTicket(prices)
  }
  const cancelTicket = () => setTicket(null)

  // Confirm: at the current market price, fills immediately as a position
  // (identical to Buy/Sell, just with real SL/TP attached); anywhere else,
  // places a working limit/stop order instead -- auto-detected from which
  // side of market the dragged entry line ended up on (impliedOrderType).
  const confirmTicket = () => {
    if (!ticket || !session || !bars || !bars[cursorIndex]) return
    const spec = getContractSpec(session.instrument)
    const side: Side = ticket.tpPrice >= ticket.entryPrice ? 'long' : 'short'
    const riskUsd = riskUsdAtEntry(session.account.balance, session.account.risk_per_trade_percent, session.account.risk_per_trade_usd)
    const contracts = computeAutoSize(riskUsd, ticket.entryPrice, ticket.slPrice, spec)
    const capMsg = positionCapMessage(contracts, session.account.max_contracts, 'Auto-sized order')
    if (capMsg) {
      // Keep the ticket open so the lines can be dragged to a size that fits.
      setOrderNotice(capMsg)
      return
    }
    setOrderNotice(null)
    const marketBar = bars[cursorIndex]

    if (ticket.entryPrice === marketBar.close) {
      const newPosition: OpenPosition = {
        side,
        contracts,
        entryPrice: marketBar.close,
        entryTime: marketBar.time,
        entryIndex: cursorIndex,
        riskUsd,
        slPrice: ticket.slPrice,
        tpPrice: ticket.tpPrice,
        autoBreakeven: armedAutoBreakeven,
        trailingPoints: armedTrailingPoints,
      }
      positionRef.current = newPosition
      setPosition(newPosition)
    } else {
      const orderType = impliedOrderType(side, ticket.entryPrice, marketBar.close)
      const order: WorkingOrder = {
        id: crypto.randomUUID(),
        side,
        orderType,
        price: ticket.entryPrice,
        contracts,
        slPrice: ticket.slPrice,
        tpPrice: ticket.tpPrice,
        riskUsd,
        placedTime: marketBar.time,
        placedIndex: cursorIndex,
        autoBreakeven: armedAutoBreakeven,
        trailingPoints: armedTrailingPoints,
      }
      workingOrdersRef.current = [order]
      setWorkingOrders([order])
    }
    setTicket(null)
    persist()
  }

  const cancelWorkingOrder = () => {
    workingOrdersRef.current = []
    setWorkingOrders([])
    persist()
  }

  // Right-click order placement (FXR_SPEC.md section B): BOTH order-type/
  // side combinations that are actually meaningful at the clicked price
  // are offered -- a price above market can be either a buy STOP (chase
  // the breakout up) or a sell LIMIT (fade back down to it); a price
  // below market is either a buy LIMIT (wait for the pullback) or a sell
  // STOP (chase the breakdown). Whichever side/type the user picks is what
  // impliedOrderType would derive for THAT combination -- offering only
  // one auto-picked pairing (as an earlier version of this did) meant a
  // limit order could never actually be placed via right-click at all,
  // since the "obvious" breakout direction is always a stop. No SL/TP
  // attached via this quick path (the drag ticket above is the "full" flow
  // for that); size uses the account's plain default_contracts, same as a
  // quick Buy/Sell, since there's no SL distance here to auto-size against.
  const handleEmptyAreaMenuItems = (info: { time: number; price: number }): ContextMenuEntry[] => {
    if (!session || !bars || !bars[cursorIndex] || !flat) return []
    const spec = getContractSpec(session.instrument)
    const marketPrice = bars[cursorIndex].close
    const price = roundToTick(info.price, spec.tickSize)
    if (price === marketPrice) return []

    const place = (side: Side, orderType: PendingOrderType) => () => {
      if (!bars[cursorIndex]) return
      const capMsg = positionCapMessage(session.account.default_contracts, session.account.max_contracts, 'Order')
      if (capMsg) {
        setOrderNotice(capMsg)
        return
      }
      setOrderNotice(null)
      const order: WorkingOrder = {
        id: crypto.randomUUID(),
        side,
        orderType,
        price,
        contracts: session.account.default_contracts,
        slPrice: null,
        tpPrice: null,
        riskUsd: riskUsdAtEntry(session.account.balance, session.account.risk_per_trade_percent, session.account.risk_per_trade_usd),
        placedTime: bars[cursorIndex].time,
        placedIndex: cursorIndex,
        autoBreakeven: armedAutoBreakeven,
        trailingPoints: armedTrailingPoints,
      }
      workingOrdersRef.current = [order]
      setWorkingOrders([order])
      persist()
    }

    // impliedOrderType already derives the correct type FOR each side
    // relative to this price/market pair -- both sides are always
    // offered, no need to branch on which side of market was clicked.
    const sides: Side[] = ['long', 'short']
    return sides.map((side) => {
      const orderType = impliedOrderType(side, price, marketPrice)
      return {
        label: `${side === 'long' ? 'Buy' : 'Sell'} ${orderType} here @ ${price.toFixed(2)}`,
        onSelect: place(side, orderType),
      }
    })
  }

  // The open position rendered through the SAME TradeRecord shape a closed
  // trade uses (see openPositionAsTradeRecord's own comment) -- zero
  // chart-side changes needed to show it with the existing entry marker/
  // trade-overlay conventions, now also carrying real SL/TP when the
  // position has them (F3).
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

  // The live R:R/$risk/contracts readout for TradeTicketPanel -- purely
  // derived from `ticket` + the account's risk config on every render, no
  // separate effect needed.
  const ticketReadout: TicketReadout | null =
    ticket && session
      ? (() => {
          const spec = getContractSpec(session.instrument)
          const side: Side = ticket.tpPrice >= ticket.entryPrice ? 'long' : 'short'
          const slDistance = Math.abs(ticket.entryPrice - ticket.slPrice)
          const tpDistance = Math.abs(ticket.tpPrice - ticket.entryPrice)
          const riskUsd = riskUsdAtEntry(
            session.account.balance,
            session.account.risk_per_trade_percent,
            session.account.risk_per_trade_usd,
          )
          const contracts = computeAutoSize(riskUsd, ticket.entryPrice, ticket.slPrice, spec)
          return {
            side,
            entryPrice: ticket.entryPrice,
            slPrice: ticket.slPrice,
            tpPrice: ticket.tpPrice,
            rr: slDistance > 0 ? tpDistance / slDistance : null,
            contracts,
            dollarRisk: slDistance > 0 ? slDistance * spec.pointValue * contracts : null,
          }
        })()
      : null

  const workingOrderSummary: WorkingOrderSummary | null =
    workingOrders[0] && session
      ? {
          instrument: session.instrument,
          side: workingOrders[0].side,
          orderType: workingOrders[0].orderType,
          price: workingOrders[0].price,
          contracts: workingOrders[0].contracts,
          slPrice: workingOrders[0].slPrice,
          tpPrice: workingOrders[0].tpPrice,
        }
      : null

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
        journalOpen={journalOpen}
        onToggleJournal={() => setJournalOpen((v) => !v)}
        onOpenAnalytics={() => selectRun(manualRunId(session.id))}
      />
      {ticketReadout ? (
        <TradeTicketPanel ticket={ticketReadout} onConfirm={confirmTicket} onCancel={cancelTicket} />
      ) : (
        <PositionTicket
          disabled={!bars || bars.length === 0}
          position={
            position && openPositionRecord
              ? {
                  instrument: session.instrument,
                  side: position.side,
                  contracts: position.contracts,
                  entryPrice: position.entryPrice,
                  slPrice: position.slPrice,
                  tpPrice: position.tpPrice,
                  pnlUsd: openPositionRecord.pnl_usd,
                  rMultiple: openPositionRecord.r_multiple,
                }
              : null
          }
          workingOrder={workingOrderSummary}
          onBuy={() => enterPosition('long')}
          onSell={() => enterPosition('short')}
          onNewTrade={openTicket}
          onClose={handleClosePosition}
          onCancelOrder={cancelWorkingOrder}
          closing={createTrade.isPending}
          autoBreakeven={position ? position.autoBreakeven : armedAutoBreakeven}
          onAutoBreakevenChange={handleAutoBreakevenChange}
          trailingPoints={position ? position.trailingPoints : armedTrailingPoints}
          onTrailingPointsChange={handleTrailingPointsChange}
          onPartialClose={handlePartialClose}
          partialCloseDisabled={!position || position.contracts < 2}
        />
      )}
      {(orderNotice || banner) && (
        <div className="flex flex-col gap-1 bg-surface px-4 py-2 text-xs text-text-muted">
          {banner && <p>{banner}</p>}
          {orderNotice && (
            <p className="flex items-start gap-2" role="status">
              <span>{orderNotice}</span>
              <button
                onClick={() => setOrderNotice(null)}
                aria-label="Dismiss"
                className="rounded px-1 text-text-muted hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              >
                &times;
              </button>
            </p>
          )}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        {/* min-w-0 matters here, not just min-h-0: without it, this flex
            item's automatic minimum width is its content's min-content size
            -- klinecharts' canvas still carries its PRE-drawer pixel width
            until its own ResizeObserver catches up, so on first Journal
            toggle the flex item refused to shrink for that one frame and
            the 360px drawer got pushed off the right edge of the viewport
            entirely (confirmed live: the drawer's DOM/text was present per
            an accessibility query, just not on-screen). */}
        <div className="min-h-0 min-w-0 flex-1">
          <ChartKL
            ref={klChartRef}
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
            onVisibleRangeChange={handleChartVisibleRangeChange}
            pickMode={pickingReplayStart}
            slLineColor={themeBase.warning}
            tradeTicket={ticket}
            onTradeTicketChange={handleTicketChange}
            workingOrderView={
              workingOrders[0]
                ? {
                    side: workingOrders[0].side,
                    price: workingOrders[0].price,
                    slPrice: workingOrders[0].slPrice,
                    tpPrice: workingOrders[0].tpPrice,
                  }
                : null
            }
            getEmptyAreaMenuExtraItems={handleEmptyAreaMenuItems}
            openPositionEditor={
              position ? { entryTime: position.entryTime, side: position.side, slPrice: position.slPrice, tpPrice: position.tpPrice } : null
            }
            onOpenPositionSlTpChange={handleOpenPositionSlTpChange}
          />
        </div>
        {journalOpen && (
          <JournalPanel
            trades={manualTrades ?? []}
            sessionNotes={session.notes}
            onUpdateSessionNotes={handleUpdateSessionNotes}
            onJumpToTrade={handleJumpToTrade}
            captureScreenshot={() => klChartRef.current?.captureScreenshot() ?? null}
            onUpdateTradeJournal={handleUpdateTradeJournal}
            onAddScreenshot={handleAddScreenshot}
            onDeleteScreenshot={handleDeleteScreenshot}
            onClose={() => setJournalOpen(false)}
            initialSelectedId={journalInitialTrade}
          />
        )}
      </div>
    </div>
  )
}
