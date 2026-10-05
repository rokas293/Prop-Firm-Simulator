// FXR_V2_SPEC.md phase G1: the session screen is one full-bleed chart between
// a thin top bar (SessionTopBar: back/name/settings, the playback pill, the
// actions) and a thin bottom bar (SessionBottomBar: Buy/Sell/Quantity, the
// balances), with a slide-up Positions | Orders | History panel (TradePanel).
// The dock panels (Dashboard, Prop Risk, Equity, Trade List) are NOT here --
// they live on the Analytics route (Workspace.tsx, reached from the bottom
// bar). All the v1 behaviour below is unchanged; only the chrome moved.
//
// FXR_SPEC.md phases F1/F2/F3: a lean chart-only workspace for a manual-
// replay session -- deliberately NOT the full Workspace.tsx/ChartPanel.tsx
// (those are dockable-panel/trade-review machinery built around a
// COMPLETED automated-backtest run's fixed trades/equity, which doesn't
// exist here). Renders ChartKL directly in permanent replay mode, restores
// the cursor saved on the session, PATCHes it back to the backend as the
// user steps (F1), drives the sim broker's market Buy/Sell/Close (F2), and
// (F3) the "New Trade" drag ticket + right-click limit/stop orders against
// chart/simBroker.ts's pure fill logic, journaling each closed trade.
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import ChartKL, { type ChartKLHandle } from '../chart/kl/ChartKL'
import type { SessionBand } from '../chart/kl/sessionOverlay'
import { positionCapMessage } from '../chart/positionCap'
import { isPropRewind, isRewindBlocked, lockFloorIndex, PROP_REWIND_MESSAGE, REWIND_BLOCKED_MESSAGE } from '../chart/discipline'
import { magnifierRange } from '../chart/magnifier'
import { useSessionHotkeys } from '../keyboard/useSessionHotkeys'
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
import { stepSpeed } from '../panels/ReplayControls'
import MagnifierPanel from '../panels/MagnifierPanel'
import TradeTicketPanel, { type TicketReadout } from '../panels/TradeTicketPanel'
import SessionTopBar from './SessionTopBar'
import SessionBottomBar from './SessionBottomBar'
import SessionChartToolbar from './SessionChartToolbar'
import KLDrawingToolbar from '../panels/KLDrawingToolbar'
import IndicatorDialog from '../panels/IndicatorDialog'
import type { PersistedOverlay } from '../chart/kl/drawingOverlays'
import { canRedo, canUndo, emptyHistory, recordDrawings, redo, undo, type DrawingHistory } from '../chart/kl/drawingHistory'
import { useKLDrawingStore } from '../state/klDrawingStore'
import { DRAWING_SHORTCUTS, isTypingTarget } from '../keyboard/shortcuts'
import TradePanel, { type PositionRow, type WorkingOrderRow } from './TradePanel'
import PropRulesPopover from './PropRulesPopover'
import {
  isSessionEnded,
  lastAllowedIndex,
  sessionDisplayName,
  STEP_GRANULARITIES,
  stepBarCount,
  steppedIndex,
  type StepGranularityLabel,
} from '../chart/sessionEnd'
import { clampPanelHeight, PANEL_DEFAULT_HEIGHT, useSessionPrefsStore } from '../state/sessionPrefsStore'
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
  useUpdateBtSessionSettings,
  useUpdateTradeJournal,
} from '../api/hooks'
import { useIndicatorStore } from '../state/indicatorStore'
import { useUiStore } from '../state/uiStore'
import { useThemeBase, useThemeStore } from '../state/themeStore'
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
import { fmtEtDate, fmtEtDateTime } from '../timeFormat'

// The journal drawer loads on first open, not in the entry chunk.
const JournalPanel = lazy(() => import('../panels/JournalPanel'))

// Sized so the fetched window can NEVER make bar_service.get_bars step to a
// COARSER timeframe (it does that silently when a window would hold more than
// max_points bars, which would change the session's bars under the replay).
// computeWindow spans at most MAX_POINTS - 1 base-timeframe intervals, i.e. at
// most MAX_POINTS bars even counting both inclusive ends (session gaps only
// ever remove bars), so the limit is never exceeded at the session's own
// timeframe.
const MAX_POINTS = 3000
const BASE_TF_SECONDS: Record<string, number> = { '1min': 60, '5min': 300, '15min': 900, '1h': 3600 }

// Mid-replay re-anchor: when the cursor is within REANCHOR_TRIGGER_BARS of the
// last loaded bar, the window is rebuilt with the cursor REANCHOR_LOOKAHEAD_BARS
// from its far end -- most of the budget stays as history behind the cursor
// (so the user's view survives the swap), with a margin of lookahead so the
// next trigger is a long way off. LOOKAHEAD must stay > TRIGGER.
const REANCHOR_TRIGGER_BARS = 20
const REANCHOR_LOOKAHEAD_BARS = 200

// Exported for direct unit testing (same pattern as client.ts's buildQuery)
// -- this is the exact-cursor-restore logic the F1 verification scenario
// depends on, so it's worth testing without mounting the whole workspace.
// `lookaheadBars` omitted = the open/resume window (weighted 30/70 toward the
// future); given = a re-anchor window ending that many bars after the anchor.
export function computeWindow(anchorTime: number, timeframe: string, lookaheadBars?: number) {
  const barSeconds = BASE_TF_SECONDS[timeframe] ?? 300
  const totalSpanSeconds = barSeconds * (MAX_POINTS - 1)
  if (lookaheadBars !== undefined) {
    const to = anchorTime + barSeconds * lookaheadBars
    return { from: to - totalSpanSeconds, to }
  }
  // More room ahead than behind -- replay only ever moves forward from the
  // anchor, so most of the budget should be spent on not needing a refetch
  // as the cursor advances.
  return { from: anchorTime - totalSpanSeconds * 0.3, to: anchorTime + totalSpanSeconds * 0.7 }
}

// Whether advancing the cursor should re-anchor the fetch window: the cursor
// is within `triggerBars` of the last loaded bar. `lastReanchoredAtBarTime` is
// the last bar a re-anchor was already requested for -- if the last loaded bar
// is still that one, the data has run out (end of the dataset), so asking again
// would just refetch the same window on every step.
export function shouldReanchor(
  cursorIndex: number,
  barCount: number,
  lastBarTime: number | undefined,
  lastReanchoredAtBarTime: number | null,
  triggerBars = REANCHOR_TRIGGER_BARS,
): boolean {
  if (barCount === 0 || lastBarTime === undefined) return false
  if (cursorIndex < barCount - 1 - triggerBars) return false
  return lastBarTime !== lastReanchoredAtBarTime
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

// A window load refits the camera to the default window only for a fresh
// anchor (open / resume / session switch). A mid-replay re-anchor keeps the
// view where it is, so long sessions never hop.
export function shouldRefitOnLoad(windowReanchored: boolean): boolean {
  return !windowReanchored
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
  const updateSessionSettings = useUpdateBtSessionSettings()
  const updateTradeJournal = useUpdateTradeJournal()
  const addTradeScreenshot = useAddTradeScreenshot()
  const deleteTradeScreenshot = useDeleteTradeScreenshot()
  const themeBase = useThemeBase()

  // FXR_SPEC.md section C, phase F5: the journal drawer -- local UI state,
  // not persisted (unlike everything it shows, which lives on the backend).
  const [journalOpen, setJournalOpen] = useState(false)
  // G1 shell state: the Prop Rules popover, the viewer's persisted prefs
  // (panel, eyes, auto-play, step granularity) and the Quick quantity box.
  const [propRulesOpen, setPropRulesOpen] = useState(false)
  // The chart toolbar row / left drawing toolbar (reused as-is from the
  // review workspace): the drawings list and armed tool ChartKL reports, the
  // Indicators dialog, and the drawing undo/redo history.
  const [klDrawings, setKlDrawings] = useState<PersistedOverlay[]>([])
  const [armedTool, setArmedTool] = useState<string | null>(null)
  const [indicatorDialogOpen, setIndicatorDialogOpen] = useState(false)
  const drawingHistoryRef = useRef<DrawingHistory>(emptyHistory())
  const [, setHistoryVersion] = useState(0)
  const prefs = useSessionPrefsStore()
  const themeMode = useThemeStore((s) => s.mode)
  const setThemeMode = useThemeStore((s) => s.setMode)
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen)
  const setShortcutsOpen = useUiStore((s) => s.setShortcutsOpen)
  const selectSession = useUiStore((s) => s.selectSession)
  const [isFullscreen, setIsFullscreen] = useState(() => document.fullscreenElement !== null)
  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement !== null)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void document.documentElement.requestFullscreen().catch(() => {})
  }
  // The Quick Buy/Sell quantity: local state is what orders read (so a Buy
  // right after typing never sees a stale cache), mirrored to the backend on a
  // short debounce. Re-seeded from the saved value when a session loads.
  const [quickQty, setQuickQty] = useState(1)
  const quickQtySeededRef = useRef<string | null>(null)
  const qtySaveTimerRef = useRef<number | null>(null)
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
  // null = the open/resume window shape; a number = a re-anchor window ending
  // that many bars past windowAnchor (see computeWindow).
  const [windowLookahead, setWindowLookahead] = useState<number | null>(null)
  const lastReanchoredAtBarTimeRef = useRef<number | null>(null)
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
  // FXR_SPEC.md phase F7b: the bar magnifier -- `armed` while waiting for a
  // click on a revealed bar, `magnifyBarTime` once one is picked.
  const [magnifierArmed, setMagnifierArmed] = useState(false)
  const [magnifyBarTime, setMagnifyBarTime] = useState<number | null>(null)

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
  // Discipline lock (F7b): the cursor time the first trade was placed at, or
  // null while none has been. Seeded from the saved session, then set locally
  // the moment a position/order is first persisted (the server's response
  // arrives later; a step-back in between must already be refused).
  const lockFloorRef = useRef<number | null>(null)
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
    lockFloorRef.current = session.lock_floor_time
    drawingHistoryRef.current = emptyHistory()
    setPropRulesOpen(false)
    if (quickQtySeededRef.current !== session.id) {
      quickQtySeededRef.current = session.id
      setQuickQty(session.quick_quantity)
    }
    setMagnifyBarTime(null)
    setMagnifierArmed(false)
    setWindowAnchor(session.cursor_time)
    setWindowLookahead(null)
    lastReanchoredAtBarTimeRef.current = null
    reanchoredAnchorRef.current = null
    setIsPlaying(false)
    setPosition(null)
    positionRef.current = null
    setWorkingOrders([])
    workingOrdersRef.current = []
    setTicket(null)
  }, [session])

  const barsWindow = useMemo(
    () => (windowAnchor !== null && session ? computeWindow(windowAnchor, session.base_timeframe, windowLookahead ?? undefined) : null),
    [windowAnchor, windowLookahead, session?.base_timeframe],
  )

  const { data: bars, isFetching: barsFetching } = useBars(
    session?.instrument ?? null,
    session?.base_timeframe ?? '5min',
    barsWindow?.from ?? null,
    barsWindow?.to ?? null,
    MAX_POINTS,
  )

  // FXR_V2_SPEC.md section 4: the cursor stops at end_date -- the furthest bar
  // it may reach in the loaded window (chart/sessionEnd.ts). Read by the step,
  // play and hotkey paths below; advanceTo clamps to it as the one choke
  // point, and the backend refuses a later cursor on save too.
  const lastAllowed = bars ? lastAllowedIndex(bars, session?.end_date ?? null) : -1
  const lastAllowedRef = useRef(lastAllowed)
  lastAllowedRef.current = lastAllowed
  const sessionEnded = bars ? isSessionEnded(bars, cursorIndex, session?.end_date ?? null) : false

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
  // Set when the fetch window is re-anchored mid-replay (advanceTo). The new
  // window's load must NOT refit the camera to the default window -- ChartKL
  // keeps the view on the same bars (preserveViewOnWindowChange), so a refit
  // would be the visible hop. Keyed to the anchor (not cleared on first use)
  // because the parent's bars query lands after ChartKL's own load and fires
  // a later range event for the same window.
  const reanchoredAnchorRef = useRef<number | null>(null)
  useEffect(() => {
    initialFitAppliedRef.current = false
  }, [bars])
  const handleChartVisibleRangeChange = (range: { from: number; to: number } | null) => {
    // null means ChartKL's own data list is still empty (see its own
    // handleVisibleRangeChange) -- not yet the "real data is ready" signal.
    if (!range || initialFitAppliedRef.current || windowAnchor === null || !session) return
    initialFitAppliedRef.current = true
    if (!shouldRefitOnLoad(reanchoredAnchorRef.current === windowAnchor)) return
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
    if (session.discipline_lock && lockFloorRef.current === null && (positionRef.current || workingOrdersRef.current.length > 0)) {
      lockFloorRef.current = cursorTime
    }
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
  // Step granularity (the pill's dropdown): one step advances this many base
  // bars. Until the 1m forming-candle replay (G5) a granularity finer than the
  // session's base timeframe is unavailable; a saved one that is falls back to
  // the base. advanceReplay evaluates every bar passed over, so a multi-bar
  // step fills and stops exactly as the same single steps would.
  const baseBarSeconds = session ? (BASE_TF_SECONDS[session.base_timeframe] ?? 300) : 300
  const availableGranularities = new Set<StepGranularityLabel>(
    STEP_GRANULARITIES.filter((g) => stepBarCount(g.seconds, baseBarSeconds) !== null).map((g) => g.label),
  )
  const granularity: StepGranularityLabel = availableGranularities.has(prefs.stepGranularity)
    ? prefs.stepGranularity
    : (STEP_GRANULARITIES.find((g) => availableGranularities.has(g.label))?.label ?? '1m')
  const stepCount = stepBarCount(STEP_GRANULARITIES.find((g) => g.label === granularity)?.seconds ?? baseBarSeconds, baseBarSeconds) ?? 1

  const advanceTo = async (newIndex: number) => {
    if (!session || !bars) return
    // end_date: never step past the last allowed bar. Reaching it ends playback.
    if (lastAllowedRef.current >= 0 && newIndex > lastAllowedRef.current) {
      newIndex = lastAllowedRef.current
      setIsPlaying(false)
      if (newIndex === cursorIndexRef.current) return
    }
    // Prop sessions never rewind (the backend refuses it too).
    if (isPropRewind(!!session.account.prop_ruleset, cursorIndexRef.current, newIndex)) {
      setIsPlaying(false)
      setOrderNotice(PROP_REWIND_MESSAGE)
      return
    }
    // Discipline lock: no stepping, scrubbing or start-resetting to before the
    // bar the first trade was placed on (the backend refuses it too).
    if (isRewindBlocked(session.discipline_lock, lockFloorRef.current, bars, newIndex)) {
      setIsPlaying(false)
      setOrderNotice(REWIND_BLOCKED_MESSAGE)
      return
    }
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
    // Nearing the end of the loaded window -- rebuild it around the cursor
    // (history behind, a small lookahead margin ahead) so continued
    // stepping/playback keeps having bars to advance into, instead of running
    // off the end of a static window.
    if (shouldReanchor(newIndex, bars.length, bars[bars.length - 1]?.time, lastReanchoredAtBarTimeRef.current)) {
      lastReanchoredAtBarTimeRef.current = bars[bars.length - 1].time
      reanchoredAnchorRef.current = bars[newIndex].time
      setWindowAnchor(bars[newIndex].time)
      setWindowLookahead(REANCHOR_LOOKAHEAD_BARS)
    }
  }

  const handleCursorIndexChange = (i: number) => advanceTo(i)

  useEffect(() => {
    if (!isPlaying || !bars || bars.length === 0) return
    const id = setInterval(() => {
      const prev = cursorIndexRef.current
      if (prev >= lastAllowedRef.current) {
        setIsPlaying(false)
        return
      }
      advanceTo(steppedIndex(prev, 1, stepCount, 0, lastAllowedRef.current))
    }, 1000 / speed)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, bars, speed, stepCount])


  // While the window swaps (bars briefly undefined) keep the logical cursor
  // time, never null: a null cursor means "no replay", which would reveal
  // every bar of the incoming window (look-ahead).
  const cursorTime = bars ? (bars[cursorIndex]?.time ?? null) : cursorTimeRef.current

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
    if (!session || !bars || !bars[cursorIndex] || !flat || sessionEnded) return
    const capMsg = positionCapMessage(quickQty, session.account.max_contracts, 'Market order')
    if (capMsg) {
      setOrderNotice(capMsg)
      return
    }
    setOrderNotice(null)
    const entryBar = bars[cursorIndex]
    const newPosition: OpenPosition = {
      side,
      contracts: quickQty,
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
    if (!bars || !bars[cursorIndex] || !flat || sessionEnded) return
    // The market would run under the lines being dragged: pause, unless the
    // pill's Auto-play is on.
    if (!prefs.autoPlay) setIsPlaying(false)
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
  // for that); size uses the Quick quantity, same as a
  // quick Buy/Sell, since there's no SL distance here to auto-size against.
  const handleEmptyAreaMenuItems = (info: { time: number; price: number }): ContextMenuEntry[] => {
    if (!session || !bars || !bars[cursorIndex] || !flat || sessionEnded) return []
    const spec = getContractSpec(session.instrument)
    const marketPrice = bars[cursorIndex].close
    const price = roundToTick(info.price, spec.tickSize)
    if (price === marketPrice) return []

    const place = (side: Side, orderType: PendingOrderType) => () => {
      if (!bars[cursorIndex]) return
      const capMsg = positionCapMessage(quickQty, session.account.max_contracts, 'Order')
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
        contracts: quickQty,
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

  const baseTfSeconds = session ? (BASE_TF_SECONDS[session.base_timeframe] ?? 300) : 300
  const handleCandleBarClick = (bar: { timestamp: number }) => {
    if (magnifierArmed) {
      const barTime = bar.timestamp / 1000
      // Only a bar the cursor has reached can be magnified (chart/magnifier.ts).
      if (magnifierRange(barTime, baseTfSeconds, cursorTime) !== null) setMagnifyBarTime(barTime)
      setMagnifierArmed(false)
      return
    }
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
            instrument: session.instrument,
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

  const workingOrderRow: WorkingOrderRow | null =
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

  const positionRow: PositionRow | null =
    position && openPositionRecord && session
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

  // The discipline lock's floor: the pill's step-back stops here (the scrub
  // slider that used to show it is gone; the lock itself is unchanged).
  const minIndex = session?.discipline_lock && bars ? lockFloorIndex(bars, lockFloorRef.current) : 0

  // One pill step forward/back: `stepCount` base bars, clamped to the allowed
  // range (end_date forward, the lock floor back). advanceTo runs every fill
  // check across the bars passed over.
  const stepForward = () => {
    if (!bars || lastAllowedRef.current < 0 || cursorIndexRef.current >= lastAllowedRef.current) return
    handleCursorIndexChange(steppedIndex(cursorIndexRef.current, 1, stepCount, 0, lastAllowedRef.current))
  }
  const stepBack = () => {
    if (!bars) return
    if (session?.account.prop_ruleset) {
      setOrderNotice(PROP_REWIND_MESSAGE)
      return
    }
    if (session?.discipline_lock && cursorIndexRef.current <= minIndex && lockFloorRef.current !== null) {
      setOrderNotice(REWIND_BLOCKED_MESSAGE)
      return
    }
    if (cursorIndexRef.current <= minIndex) return
    handleCursorIndexChange(steppedIndex(cursorIndexRef.current, -1, stepCount, minIndex, bars.length - 1))
  }

  const handleQuantityChange = (n: number) => {
    setQuickQty(n)
    if (!session) return
    const sessionIdForSave = session.id
    if (qtySaveTimerRef.current !== null) window.clearTimeout(qtySaveTimerRef.current)
    qtySaveTimerRef.current = window.setTimeout(() => {
      updateSessionSettings.mutate({ sessionId: sessionIdForSave, body: { quick_quantity: n } })
    }, 400)
  }

  // Dragging the bottom bar's grip up resizes (and opens) the trade panel.
  const panelDragBaseRef = useRef(0)
  const handleGripDrag = (deltaUp: number, phase: 'start' | 'move' | 'end') => {
    if (phase === 'start') panelDragBaseRef.current = prefs.panelOpen ? prefs.panelHeight : 0
    if (phase !== 'move') return
    if (!prefs.panelOpen) prefs.setPanelOpen(true)
    prefs.setPanelHeight(clampPanelHeight(panelDragBaseRef.current + deltaUp, window.innerHeight))
  }

  // A History row opens that trade in the journal drawer.
  const openTradeInJournal = (tradeId: number) => {
    setJournalInitialTrade(tradeId)
    setJournalOpen(true)
  }

  // Drawing history. ChartKL reports the persisted set on every change; an
  // undo/redo writes the earlier set back to the same per-instrument store the
  // chart already persists to (so it survives a reload) and asks it to redraw.
  const handleDrawingsChange = (overlays: PersistedOverlay[]) => {
    setKlDrawings(overlays)
    drawingHistoryRef.current = recordDrawings(drawingHistoryRef.current, overlays)
    setHistoryVersion((v) => v + 1)
  }
  const applyHistoryStep = (step: ReturnType<typeof undo>) => {
    if (!step || !session) return
    drawingHistoryRef.current = step.history
    useKLDrawingStore.getState().setOverlaysForInstrument(session.instrument, step.restore)
    klChartRef.current?.reloadDrawings()
    setHistoryVersion((v) => v + 1)
  }
  const handleUndo = () => applyHistoryStep(undo(drawingHistoryRef.current))
  const handleRedo = () => applyHistoryStep(redo(drawingHistoryRef.current))

  const handleScreenshot = () => {
    const url = klChartRef.current?.captureScreenshot()
    if (!url || !session) return
    const a = document.createElement('a')
    a.href = url
    a.download = `${session.instrument}-${fmtEtDateTime(cursorTimeRef.current ?? session.cursor_time).replace(/[: ]/g, '-')}.jpg`
    a.click()
  }

  // Drawing hotkeys (H/T/Z/M/B, unshifted) and Escape cancelling a drawing in
  // progress -- the same ones the review chart has. Trading hotkeys are
  // Shift-guarded, so the two sets do not collide.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || document.querySelector('[role="dialog"][aria-modal="true"]')) return
      if (e.key === 'Escape') {
        klChartRef.current?.cancelActiveDrawing()
      } else if (!e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && DRAWING_SHORTCUTS[e.key.toLowerCase()]) {
        e.preventDefault()
        klChartRef.current?.startDrawing(DRAWING_SHORTCUTS[e.key.toLowerCase()])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Trading / replay hotkeys (F7b). Trading ones need Shift (shortcuts.ts);
  // every one goes through the same guarded handlers as its on-screen button,
  // so the flat gate, position cap and discipline lock apply identically.
  useSessionHotkeys({
    sessionBuy: () => enterPosition('long'),
    sessionSell: () => enterPosition('short'),
    sessionClose: () => {
      if (position && !createTrade.isPending) handleClosePosition()
    },
    sessionCloseHalf: () => {
      if (position && position.contracts >= 2 && !createTrade.isPending) handlePartialClose()
    },
    sessionNewTrade: openTicket,
    sessionStep: stepForward,
    sessionStepBack: stepBack,
    sessionPlayPause: () => setIsPlaying((v) => !v),
    sessionSpeedUp: () => setSpeed((s) => stepSpeed(s, 1)),
    sessionSpeedDown: () => setSpeed((s) => stepSpeed(s, -1)),
  })

  // A refusal notice is informational: it clears itself after a few seconds
  // (the x still dismisses it sooner).
  useEffect(() => {
    if (!orderNotice) return
    const id = window.setTimeout(() => setOrderNotice(null), 6000)
    return () => window.clearTimeout(id)
  }, [orderNotice])

  const magnifyActive = magnifyBarTime !== null && magnifierRange(magnifyBarTime, baseTfSeconds, cursorTime) !== null

  if (isLoading) {
    return <EmptyState title="Loading session…" />
  }
  if (isError || !session) {
    return <EmptyState title="Failed to load session" hint={(error as Error | undefined)?.message} />
  }

  const cursorBar = bars?.[cursorIndex]
  const unrealizedPnl = openPositionRecord?.pnl_usd ?? 0
  const hasNotices = ticketReadout !== null || orderNotice !== null || banner !== null || sessionEnded

  return (
    <div className="flex h-full w-full flex-col bg-bg">
      <SessionTopBar
        name={sessionDisplayName(session, fmtEtDate)}
        subtitle={`${session.base_timeframe}${session.end_date !== null ? ` · to ${fmtEtDate(session.end_date)}` : ''}`}
        disciplineLock={session.discipline_lock ? { engaged: session.lock_floor_time !== null } : null}
        onBack={() => selectSession(null)}
        menu={{
          followLatestBar,
          onToggleFollowLatestBar: () => setFollowLatestBar((v) => !v),
          pickingReplayStart,
          onTogglePickingReplayStart: () => {
            setMagnifierArmed(false)
            setPickingReplayStart((v) => !v)
          },
          magnifierArmed,
          onToggleMagnifier:
            baseTfSeconds > 60
              ? () => {
                  setPickingReplayStart(false)
                  setMagnifierArmed((v) => !v)
                }
              : undefined,
          replayStartBlockedReason: session.account.prop_ruleset ? PROP_REWIND_MESSAGE : undefined,
          onOpenAppSettings: () => setSettingsOpen(true),
          onOpenShortcuts: () => setShortcutsOpen(true),
        }}
        playback={{
          isPlaying,
          onTogglePlaying: () => setIsPlaying((v) => !v),
          speed,
          onSpeedChange: setSpeed,
          onStepBack: stepBack,
          onStepForward: stepForward,
          canStepBack: !!bars && bars.length > 0 && cursorIndex > minIndex,
          stepBackBlockedReason: session.account.prop_ruleset ? PROP_REWIND_MESSAGE : undefined,
          canStepForward: !!bars && cursorIndex < lastAllowed,
          granularity,
          onGranularityChange: prefs.setStepGranularity,
          availableGranularities,
          autoPlay: prefs.autoPlay,
          onToggleAutoPlay: () => prefs.setAutoPlay(!prefs.autoPlay),
          cursorLabel: cursorBar ? fmtEtDateTime(cursorBar.time) : null,
        }}
        actions={{
          onPlaceOrder: openTicket,
          placeOrderDisabled: !bars || bars.length === 0 || !flat || sessionEnded,
          onToggleJournal: () => setJournalOpen((v) => !v),
          journalOpen,
          onToggleTheme: () => setThemeMode(themeMode === 'dark' ? 'light' : 'dark'),
          isDark: themeMode === 'dark',
          onToggleFullscreen: toggleFullscreen,
          isFullscreen,
        }}
      />

      <SessionChartToolbar
        assets={session.assets}
        instrument={session.instrument}
        baseTimeframe={session.base_timeframe}
        indicatorCount={activeIndicatorCount}
        onOpenIndicators={() => setIndicatorDialogOpen(true)}
        candleType={prefs.candleType}
        onCandleTypeChange={prefs.setCandleType}
        canUndo={canUndo(drawingHistoryRef.current)}
        canRedo={canRedo(drawingHistoryRef.current)}
        onUndo={handleUndo}
        onRedo={handleRedo}
        onScreenshot={handleScreenshot}
      />
      <IndicatorDialog open={indicatorDialogOpen} onClose={() => setIndicatorDialogOpen(false)} />

      <div className="flex min-h-0 flex-1">
        <KLDrawingToolbar klChartRef={klChartRef} drawings={klDrawings} armedTool={armedTool} />
        {/* min-w-0 matters here, not just min-h-0: without it, this flex
            item's automatic minimum width is its content's min-content size
            -- klinecharts' canvas still carries its PRE-drawer pixel width
            until its own ResizeObserver catches up, so on first Journal
            toggle the flex item refused to shrink for that one frame and
            the 360px drawer got pushed off the right edge of the viewport
            entirely (confirmed live: the drawer's DOM/text was present per
            an accessibility query, just not on-screen). */}
        <div className="relative min-h-0 min-w-0 flex-1">
          <ChartKL
            ref={klChartRef}
            instrument={session.instrument}
            timeframe={session.base_timeframe}
            from={barsWindow?.from ?? null}
            to={barsWindow?.to ?? null}
            trades={prefs.hideTrades ? [] : chartTrades}
            selectedTrade={prefs.hideTrades ? null : openPositionRecord}
            indicators={indicators}
            sessionBands={sessionBands}
            prefs={indicatorPrefs}
            loading={barsFetching}
            preserveViewOnWindowChange
            cursorTime={cursorTime}
            followLatestBar={followLatestBar}
            onCandleBarClick={handleCandleBarClick}
            onVisibleRangeChange={handleChartVisibleRangeChange}
            pickMode={pickingReplayStart || magnifierArmed}
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
            onDrawingsChange={handleDrawingsChange}
            onDrawingArmedChange={setArmedTool}
            candleType={prefs.candleType}
          />
          {/* Transient messages float over the chart's upper edge (clear of the
              volume pane and time axis) so they never shift the chart's size: the drag ticket's readout, why an order
              was refused, the resolved Combine, and the session-complete state. */}
          {hasNotices && (
            <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex flex-col items-center gap-2 px-4">
              {sessionEnded && (
                <p
                  className="pointer-events-auto flex items-center gap-3 rounded bg-surface px-3 py-2 text-xs text-text shadow-lg"
                  role="status"
                >
                  <span>
                    Session complete
                    <span className="text-text-muted">
                      {session.end_date !== null ? ` · the replay reached its end date, ${fmtEtDate(session.end_date)}.` : '.'}
                    </span>
                  </span>
                  <button
                    onClick={() => selectRun(manualRunId(session.id))}
                    className="h-7 rounded px-2 text-text-muted transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                  >
                    View analytics
                  </button>
                </p>
              )}
              {ticketReadout && (
                <div className="pointer-events-auto">
                  <TradeTicketPanel ticket={ticketReadout} onConfirm={confirmTicket} onCancel={cancelTicket} />
                </div>
              )}
              {banner && (
                <p className="pointer-events-auto rounded bg-surface-2 px-3 py-2 text-xs text-text-muted shadow-lg" role="status">
                  {banner}
                </p>
              )}
              {orderNotice && (
                <p className="pointer-events-auto flex items-start gap-2 rounded bg-surface-2 px-3 py-2 text-xs text-text-muted shadow-lg" role="status">
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
        </div>
        {journalOpen && (
          <Suspense fallback={null}>
            <JournalPanel
              key={journalInitialTrade ?? 'journal'}
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
          </Suspense>
        )}
      </div>

      {magnifyActive && magnifyBarTime !== null && (
        <MagnifierPanel
          instrument={session.instrument}
          timeframe={session.base_timeframe}
          tfSeconds={baseTfSeconds}
          barTime={magnifyBarTime}
          cursorTime={cursorTime}
          onClose={() => setMagnifyBarTime(null)}
        />
      )}

      {prefs.panelOpen && (
        <TradePanel
          height={clampPanelHeight(prefs.panelHeight || PANEL_DEFAULT_HEIGHT, window.innerHeight)}
          tab={prefs.panelTab}
          onTabChange={prefs.setPanelTab}
          position={positionRow}
          workingOrder={workingOrderRow}
          trades={manualTrades ?? []}
          closing={createTrade.isPending}
          onClosePosition={handleClosePosition}
          onPartialClose={handlePartialClose}
          partialCloseDisabled={!position || position.contracts < 2}
          onCancelOrder={cancelWorkingOrder}
          autoBreakeven={position ? position.autoBreakeven : armedAutoBreakeven}
          onAutoBreakevenChange={handleAutoBreakevenChange}
          trailingPoints={position ? position.trailingPoints : armedTrailingPoints}
          onTrailingPointsChange={handleTrailingPointsChange}
          onOpenTrade={openTradeInJournal}
        />
      )}

      <div className="relative">
        {propRulesOpen && session.account.prop_ruleset && (
          <PropRulesPopover
            result={propStats?.result}
            totalTrades={manualTrades?.length ?? 0}
            rulesetLabel={session.account.prop_ruleset === 'topstep_50k' ? 'Topstep $50k Combine' : session.account.prop_ruleset}
            maxContracts={session.account.max_contracts ?? null}
            onOpenAnalytics={() => selectRun(manualRunId(session.id))}
            onClose={() => setPropRulesOpen(false)}
          />
        )}
        <SessionBottomBar
          hideTrades={prefs.hideTrades}
          onToggleHideTrades={() => prefs.setHideTrades(!prefs.hideTrades)}
          onBuy={() => enterPosition('long')}
          onSell={() => enterPosition('short')}
          tradingDisabled={!bars || bars.length === 0 || !flat || sessionEnded}
          disabledReason={sessionEnded ? 'The session has ended' : !flat ? 'Close or cancel the open trade first' : 'Waiting for bars'}
          quantity={{ value: quickQty, max: session.account.max_contracts ?? null, onChange: handleQuantityChange }}
          panelOpen={prefs.panelOpen}
          onTogglePanel={() => prefs.setPanelOpen(!prefs.panelOpen)}
          onGripDrag={handleGripDrag}
          onAnalytics={() => selectRun(manualRunId(session.id))}
          propRules={session.account.prop_ruleset ? { open: propRulesOpen, onOpen: () => setPropRulesOpen((v) => !v) } : null}
          balance={session.account.balance}
          realizedPnl={session.account.balance - session.account.starting_balance}
          unrealizedPnl={unrealizedPnl}
          hideBalances={prefs.hideBalances}
          onToggleHideBalances={() => prefs.setHideBalances(!prefs.hideBalances)}
          onToggleFullscreen={toggleFullscreen}
          isFullscreen={isFullscreen}
        />
      </div>
    </div>
  )
}
