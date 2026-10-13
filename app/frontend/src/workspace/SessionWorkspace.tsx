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
// (F3) right-click limit/stop orders against chart/simBroker.ts's pure fill
// logic, journaling each closed trade. (G3) The Long/Short Position tool and the
// Place Order dialog replaced F3's drag-to-place "New Trade" ticket.
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import ChartKL, { type ChartKLHandle, type OrderLineSpec, type PositionToolSpec } from '../chart/kl/ChartKL'
import { revealedSessionBands, type SessionBand } from '../chart/kl/sessionOverlay'
import { capRoom, openContractsElsewhere, positionCapMessage } from '../chart/positionCap'
import { entryRefusal, flattenNotice, holdingRule } from '../chart/holdingRestrictions'
import { newsRule, newsWindowRefusal } from '../chart/newsWindow'
import { defaultToolLevels } from '../chart/positionTool'
import { balanceFor, riskPctFromUsd, type OrderContext, type OrderKind, type OrderRequest, type PositionToolLevels } from '../chart/orderTicket'
import { DEFAULT_SCALPER, entryBrackets, fromScalperConfig, scalperPreview, toScalperConfig, type ScalperBrackets } from '../chart/scalper'
import {
  averageTrueRange,
  breakevenRefusal,
  fmtSignedUsd,
  ghostLevels,
  ghostsApply,
  levelReadout,
  levelRefusal,
  partialCloseChoices,
  partialCloseRefusal,
  rightClickOrders,
  roundToTick,
  withBracketsNote,
  tradeOpenContracts,
  type LevelKind,
} from '../chart/orderEntry'
import { isPropRewind, isRewindBlocked, lockFloorIndex, PROP_REWIND_MESSAGE, REWIND_BLOCKED_MESSAGE } from '../chart/discipline'
import { magnifierRange } from '../chart/magnifier'
import { useSessionHotkeys } from '../keyboard/useSessionHotkeys'
import { combineBanner } from '../compass/propResult'
import {
  EMPTY_BOOK,
  advanceSession,
  closePosition,
  closePositionPartialAtMarket,
  fromPersistedPosition,
  fromPersistedWorkingOrder,
  getContractSpec,
  marketFillPrice,
  openPositionAsTradeRecord,
  riskUsdAtEntry,
  toPersistedPosition,
  toPersistedWorkingOrder,
  sessionUnrealizedPnl,
  unrealizedPnl as positionPnl,
  type ClosedTradeResult,
  type InstrumentBook,
  type OpenPosition,
  NO_JOURNAL,
  type OrderJournal,
  type Side,
  type WorkingOrder,
} from '../chart/simBroker'
import type { ContextMenuEntry } from '../components/ContextMenu'
import { stepSpeed } from '../panels/ReplayControls'
import MagnifierPanel from '../panels/MagnifierPanel'
import PlaceOrderDialog from './PlaceOrderDialog'
import SessionTopBar from './SessionTopBar'
import SessionBottomBar from './SessionBottomBar'
import SessionChartToolbar from './SessionChartToolbar'
import KLDrawingToolbar from '../panels/KLDrawingToolbar'
import IndicatorDialog from '../panels/IndicatorDialog'
import type { PersistedOverlay } from '../chart/kl/drawingOverlays'
import { canRedo, canUndo, emptyHistory, recordDrawings, redo, undo, type DrawingHistory } from '../chart/kl/drawingHistory'
import { flushDrawings, loadSessionDrawings } from '../state/drawingsSync'
import { cloneDrawings, useKLDrawingStore, type NamedLayout } from '../state/klDrawingStore'
import { DRAWING_SHORTCUTS, isTypingTarget } from '../keyboard/shortcuts'
import TradePanel, { type PositionRow, type WorkingOrderRow } from './TradePanel'
import PropRulesModal from './PropRulesModal'
import PropOutcomeScreen from './PropOutcomeScreen'
import TryAgainDialog from './TryAgainDialog'
import SessionCompleteCard from './SessionCompleteCard'
import { isSessionEnded, lastAllowedIndex, sessionDisplayName } from '../chart/sessionEnd'
import {
  HISTORY_BARS,
  MAX_HISTORY_BARS,
  SESSION_TIMEFRAMES,
  bucketStart,
  heldBaseBars,
  historyBarsFor,
  historyWindow,
  lastIndexAtOrBefore,
  nextStepIndex,
  prevStepIndex,
  shiftTimeframe,
  timeframeSeconds,
} from '../chart/replayBars'
import { smoothDurationMs } from '../chart/smoothCandle'
import { spliceTail } from '../chart/replayIndicators'
import { useReplayIndicators } from './useReplayIndicators'
import { clampPanelHeight, PANEL_DEFAULT_HEIGHT, useSessionPrefsStore } from '../state/sessionPrefsStore'
import { dropLegacyScalper, readLegacyScalper, readScalper, useScalperStore } from '../state/scalperStore'
import {
  useBtSession,
  useBtSessionTrades,
  useBars,
  useCreateManualTrade,
  useAddTradeScreenshot,
  useDeleteTradeScreenshot,
  useIndicators,
  useSessions,
  useNewsEvents,
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
  type NewsEvent,
  type TradeRecord,
  type UpdateTradeJournalRequest,
} from '../api/types'
import EmptyState from '../components/EmptyState'
import { fmtEtDateTime, fmtEtLongDate, fmtEtLongDateTime } from '../timeFormat'
import { fmtPrice } from '../format'
import { OPEN_ENTRY_ID, type OpenJournalEntry } from '../panels/journalEntry'

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
const BASE_TF_SECONDS: Record<string, number> = Object.fromEntries(SESSION_TIMEFRAMES.map((t) => [t.id, t.seconds]))

// Mid-replay re-anchor: when the cursor is within REANCHOR_TRIGGER_BARS of the
// last loaded bar, the window is rebuilt with the cursor REANCHOR_LOOKAHEAD_BARS
// from its far end -- most of the budget stays as history behind the cursor
// (so the user's view survives the swap), with a margin of lookahead so the
// next trigger is a long way off. LOOKAHEAD must stay > TRIGGER.
const NO_ORDERS: WorkingOrder[] = []
const NO_LAYOUTS: NamedLayout[] = []
const REANCHOR_TRIGGER_BARS = 20
const REANCHOR_LOOKAHEAD_BARS = 200
// The same, backwards (a rewind, G5): within REANCHOR_BACK_TRIGGER_BARS of the first
// loaded 1-minute bar the window is rebuilt with the cursor REANCHOR_BACK_LOOKAHEAD_BARS
// from its far end -- history and room ahead in equal measure. The trigger stays
// above 4h of minutes (240) so the forming candle of the largest timeframe is always
// fully inside the window.
const SESSION_BANDS_MAX_DAYS = 45
const REANCHOR_BACK_TRIGGER_BARS = 300
const REANCHOR_BACK_LOOKAHEAD_BARS = 1500

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

// Whether stepping BACK should re-anchor the fetch window: the cursor is within
// `triggerBars` of the first loaded bar. `lastReanchoredAtFirstBarTime` is the first
// bar a re-anchor was already requested for -- if the first loaded bar is still that
// one, the data has run out at its start, so asking again would refetch forever.
export function shouldReanchorBack(
  cursorIndex: number,
  firstBarTime: number | undefined,
  lastReanchoredAtFirstBarTime: number | null,
  triggerBars = REANCHOR_BACK_TRIGGER_BARS,
): boolean {
  if (firstBarTime === undefined) return false
  if (cursorIndex >= triggerBars) return false
  return firstBarTime !== lastReanchoredAtFirstBarTime
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

// Empty chart to the right of the newest bar (FXR_V2_SPEC.md G2, references
// R10/R11): wide enough for a ghost SL/TP label, so order labels never cover
// recent price action.
export const ORDER_LABEL_MARGIN_PX = 400

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

// "MES" / "MNQ and MES": the instruments other than `except` that hold a position,
// for the cap's refusal message (empty when none does).
export function elsewhereLabel(books: Record<string, InstrumentBook>, except: string | undefined): string {
  return Object.entries(books)
    .filter(([symbol, b]) => symbol !== except && b.position)
    .map(([symbol]) => symbol)
    .join(' and ')
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
  // FXR_V2_SPEC.md section 5 (G5): the chart's timeframe and the step size are the
  // session's own, independent settings -- local state is what the UI reads (so a
  // click never waits for the save), mirrored to the session file; re-seeded from the
  // saved values when a session loads.
  const [chartTf, setChartTf] = useState('5min')
  const [stepSize, setStepSize] = useState('5min')
  // The chart's HISTORY (the completed candles before the one forming) is cut at the
  // cursor time it was last anchored on; a Go To to an older date asks for more.
  const [historyAnchor, setHistoryAnchor] = useState<number | null>(null)
  const [historyBars, setHistoryBars] = useState(HISTORY_BARS)
  const [goTo, setGoTo] = useState<{ time: number; nonce: number } | null>(null)
  // The chart view is parked on a past date by a Go To (shows the way back).
  const [viewDetached, setViewDetached] = useState(false)
  // FXR_V2_SPEC.md 3.4 (G4): Scalper Mode -- preset SL/TP/break-even distances
  // for every Quick Buy/Sell and right-click order while armed. Remembered per
  // session: the session file is the source of truth (loaded below, saved on
  // change), the store is the in-memory working copy; `scalperOpen` is just the popover.
  const scalperBySession = useScalperStore((s) => s.bySession)
  const seedScalper = useScalperStore((s) => s.seed)
  const setScalperArmed = useScalperStore((s) => s.setArmed)
  const patchScalper = useScalperStore((s) => s.patch)
  const scalper = useMemo(() => readScalper(scalperBySession, sessionId), [scalperBySession, sessionId])
  const [scalperOpen, setScalperOpen] = useState(false)
  // Which session the working copy was loaded for, and the JSON last known to be
  // in the session file (so only a real change is saved, never the load itself).
  const scalperSeededForRef = useRef<string | null>(null)
  const scalperSavedRef = useRef<string>('null')
  const scalperSaveTimerRef = useRef<number | null>(null)
  const scalperPendingRef = useRef<{ sessionId: string; json: string } | null>(null)
  const saveScalperNow = () => {
    const pending = scalperPendingRef.current
    if (scalperSaveTimerRef.current !== null) window.clearTimeout(scalperSaveTimerRef.current)
    scalperSaveTimerRef.current = null
    scalperPendingRef.current = null
    if (!pending) return
    scalperSavedRef.current = pending.json
    updateSessionSettings.mutate(
      { sessionId: pending.sessionId, body: { scalper: JSON.parse(pending.json) } },
      { onSuccess: () => dropLegacyScalper(pending.sessionId) },
    )
  }
  const saveScalperNowRef = useRef(saveScalperNow)
  saveScalperNowRef.current = saveScalperNow
  // Save a real change to the session file: a toggle of Armed at once, typing in
  // the popover after a short pause, and whatever is pending when the workspace
  // closes. The load itself never counts as a change (scalperSavedRef).
  useEffect(() => {
    if (!session || scalperSeededForRef.current !== session.id) return
    const json = JSON.stringify(toScalperConfig(scalper.armed, scalper.settings))
    if (json === scalperSavedRef.current) {
      scalperPendingRef.current = null
      return
    }
    const armedChanged = (JSON.parse(scalperSavedRef.current) as { armed?: boolean } | null)?.armed !== scalper.armed
    scalperPendingRef.current = { sessionId: session.id, json }
    if (scalperSaveTimerRef.current !== null) window.clearTimeout(scalperSaveTimerRef.current)
    if (armedChanged) saveScalperNowRef.current()
    else scalperSaveTimerRef.current = window.setTimeout(() => saveScalperNowRef.current(), 300)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scalper, session?.id])
  useEffect(() => () => saveScalperNowRef.current(), [])
  // Whatever drawing edit is still waiting out its short delay goes out as the workspace closes.
  useEffect(() => () => void flushDrawings(), [])
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
  // A short confirmation after a level is placed/removed or a partial closes
  // (FXR_V2_SPEC.md 3.2: "releasing sets the level and shows a toast").
  const [toast, setToast] = useState<string | null>(null)
  // Bumped to make ChartKL re-sync the order lines to the broker's state after
  // a drag the broker refused (the line would otherwise stay where it was dropped).
  const [lineNonce, setLineNonce] = useState(0)
  // A Topstep session's Combine verdict (the same PropRulesTracker result the
  // analytics Dashboard shows); disabled (null run id) for a practice session.
  const propRunId = session?.account.prop_ruleset ? manualRunId(session.id) : null
  const { data: propStats } = useStats(propRunId, 'all')
  const banner = combineBanner(propStats?.result)
  // G6: the no-overnight / no-weekend rule the sim broker enforces (null = none).
  const holding = useMemo(() => holdingRule(session?.account.prop_rules), [session?.account.prop_rules])
  // G7: the no-news window (null = the session does not restrict news trading).
  const newsGate = useMemo(() => newsRule(session?.account.prop_rules), [session?.account.prop_rules])
  // The calendar's schedule for the loaded window (set where it is fetched, below);
  // what advanceTo and the entry paths judge a news window against.
  const newsEventsRef = useRef<NewsEvent[] | undefined>(undefined)
  // The completion card's own dismissal, per session.
  const [completeDismissedFor, setCompleteDismissedFor] = useState<string | null>(null)
  // G8: the pass / fail screen of a prop session, dismissed per session; "Try again" is its own dialog.
  const [outcomeDismissedFor, setOutcomeDismissedFor] = useState<string | null>(null)
  const [tryAgainOpen, setTryAgainOpen] = useState(false)
  // FXR_SPEC.md phase F6: "Open in journal" from the analytics workspace
  // lands here with one trade to show -- opens the drawer on it, once.
  const selectRun = useUiStore((s) => s.selectRun)
  const pendingJournalTrade = useUiStore((s) => s.pendingJournalTrade)
  const consumeJournalTrade = useUiStore((s) => s.consumeJournalTrade)
  const [journalInitialTrade, setJournalInitialTrade] = useState<number | null>(null)
  // "Save & Journal": the open trade's entry (it has no journaled trade until its
  // first exit) -- open the drawer on it.
  // The open entry belongs to the charted instrument's position -- or, when a journaled
  // order filled in the OTHER instrument, to that one (`journalSymbol`, until the chart
  // is switched).
  const [journalSymbol, setJournalSymbol] = useState<string | null>(null)
  const openOpenEntryInJournal = (symbol?: string) => {
    setJournalSymbol(symbol ?? null)
    setJournalInitialTrade(OPEN_ENTRY_ID)
    setJournalOpen(true)
  }
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
  //
  // G7 (multi-asset): one BOOK per instrument -- at most one position and its resting
  // orders each -- sharing the one cursor and the one account. `books` is the render
  // copy, `booksRef` the live one. Everything below that says position /
  // workingOrders means the ACTIVE instrument's (the one on the chart); the shims
  // keep that code as it was. advanceTo walks every book together (advanceSession).
  const [books, setBooks] = useState<Record<string, InstrumentBook>>({})
  const booksRef = useRef<Record<string, InstrumentBook>>({})
  const [activeSymbol, setActiveSymbol] = useState('')
  const activeRef = useRef('')
  const activeInstrument: string = session ? (session.assets?.includes(activeSymbol) ? activeSymbol : session.instrument) : ''
  const activeInstrumentOrNull = session ? activeInstrument : null
  activeRef.current = activeInstrument
  const position = books[activeInstrument]?.position ?? null
  const workingOrders = books[activeInstrument]?.workingOrders ?? NO_ORDERS
  const writeBook = (symbol: string, patch: Partial<InstrumentBook>) => {
    booksRef.current = { ...booksRef.current, [symbol]: { ...(booksRef.current[symbol] ?? EMPTY_BOOK), ...patch } }
    setBooks(booksRef.current)
  }
  const setPosition = (p: OpenPosition | null) => writeBook(activeRef.current, { position: p })
  const setWorkingOrders = (o: WorkingOrder[]) => writeBook(activeRef.current, { workingOrders: o })
  // FXR_V2_SPEC.md 3.5 (G3): the Long/Short Position tool on the chart (entry,
  // stop and target; the side is the tool's own), and whether the Place Order
  // dialog is open over it. The tool is a plan on screen, not an order: it
  // places nothing until the dialog's Save.
  const [positionTool, setPositionTool] = useState<PositionToolLevels | null>(null)
  const [orderDialogOpen, setOrderDialogOpen] = useState(false)
  // The type the order dialog opened on (the Shift+M / L / T hotkeys); null = the
  // dialog's own default, derived from the price.
  const [orderDialogType, setOrderDialogType] = useState<OrderKind | null>(null)
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
  // G8: a prop session whose Combine has just passed or failed stops playing -- the
  // outcome screen is what you are meant to look at.
  const resolvedStatus = propStats?.result?.status
  useEffect(() => {
    if (resolvedStatus === 'passed' || resolvedStatus === 'failed') setIsPlaying(false)
  }, [resolvedStatus])
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
  // What advanceTo (called from the play interval's closure) needs to read live.
  const chartTfSecondsRef = useRef(300)
  const startIndexRef = useRef(0)
  const historyFromRef = useRef<number | null>(null)
  const lastReanchoredBackAtFirstBarTimeRef = useRef<number | null>(null)
  // Mirrors cursorIndex/position/workingOrders for synchronous reads from
  // the play-interval's setInterval callback (a plain function, not a
  // React reducer -- see advanceTo's own comment for why that distinction
  // matters here).
  const cursorIndexRef = useRef(0)
  // The active instrument's position / orders, read and written through the books.
  const positionRef = {
    get current(): OpenPosition | null {
      return booksRef.current[activeRef.current]?.position ?? null
    },
    set current(p: OpenPosition | null) {
      const sym = activeRef.current
      booksRef.current = { ...booksRef.current, [sym]: { ...(booksRef.current[sym] ?? EMPTY_BOOK), position: p } }
    },
  }
  const workingOrdersRef = {
    get current(): WorkingOrder[] {
      return booksRef.current[activeRef.current]?.workingOrders ?? NO_ORDERS
    },
    set current(o: WorkingOrder[]) {
      const sym = activeRef.current
      booksRef.current = { ...booksRef.current, [sym]: { ...(booksRef.current[sym] ?? EMPTY_BOOK), workingOrders: o } }
    },
  }
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
    // G9b: the session's drawings, layouts and shared-layer toggle live on the server;
    // the chart redraws when they arrive (ChartKL watches the store's serverRevision).
    loadSessionDrawings(session.id).catch((e) => console.error('drawings: could not load this session', e))
    setPropRulesOpen(false)
    if (quickQtySeededRef.current !== session.id) {
      quickQtySeededRef.current = session.id
      setQuickQty(session.quick_quantity)
    }
    // Scalper Mode: the session file's saved state; a session that has none yet
    // adopts what the first G4 kept in browser storage (saved to the file below,
    // then dropped from storage once the server has it).
    const legacyScalper = session.scalper ? null : readLegacyScalper(session.id)
    const savedScalper = session.scalper ? fromScalperConfig(session.scalper) : (legacyScalper ?? { armed: false, settings: DEFAULT_SCALPER })
    scalperSavedRef.current = JSON.stringify(legacyScalper ? null : toScalperConfig(savedScalper.armed, savedScalper.settings))
    seedScalper(session.id, savedScalper)
    scalperSeededForRef.current = session.id
    setMagnifyBarTime(null)
    setMagnifierArmed(false)
    setChartTf(session.chart_timeframe ?? session.base_timeframe)
    setStepSize(session.step_size ?? session.base_timeframe)
    setHistoryAnchor(session.cursor_time)
    setHistoryBars(HISTORY_BARS)
    setGoTo(null)
    initialFitAppliedRef.current = false
    setWindowAnchor(session.cursor_time)
    setWindowLookahead(null)
    lastReanchoredAtBarTimeRef.current = null
    lastReanchoredBackAtFirstBarTimeRef.current = null
    reanchoredAnchorRef.current = null
    setIsPlaying(false)
    booksRef.current = {}
    setBooks({})
    activeRef.current = session.instrument
    setActiveSymbol(session.instrument)
    setPositionTool(null)
    setOrderDialogOpen(false)
  }, [session])

  // The replay's FEED: 1-minute bars around the cursor (G5). Every step, fill and
  // forming candle is built from these, whatever the chart timeframe or step size;
  // a re-anchor swaps the window as the cursor nears either end.
  const barsWindow = useMemo(
    () => (windowAnchor !== null && session ? computeWindow(windowAnchor, '1min', windowLookahead ?? undefined) : null),
    [windowAnchor, windowLookahead, session?.id],
  )

  // One 1-minute feed per asset of the session over the same window (G7): the
  // shared cursor is a TIME, and each instrument's fills only ever meet its own
  // bars at or before it. The chart shows the active instrument's.
  const primarySymbol = session?.instrument ?? null
  const secondarySymbol = session?.assets?.find((a) => a !== session.instrument) ?? null
  const primaryQuery = useBars(primarySymbol, '1min', barsWindow?.from ?? null, barsWindow?.to ?? null, MAX_POINTS, true)
  const secondaryQuery = useBars(secondarySymbol, '1min', barsWindow?.from ?? null, barsWindow?.to ?? null, MAX_POINTS, true)
  const onSecondary = secondarySymbol !== null && activeInstrument === secondarySymbol
  const bars = onSecondary ? secondaryQuery.data : primaryQuery.data
  const barsFetching = onSecondary ? secondaryQuery.isFetching : primaryQuery.isFetching
  const feeds: Record<string, Bar[] | undefined> = {}
  if (primarySymbol) feeds[primarySymbol] = primaryQuery.data
  if (secondarySymbol) feeds[secondarySymbol] = secondaryQuery.data
  const feedsRef = useRef(feeds)
  feedsRef.current = feeds
  const feedsReady = !!session && session.assets.every((a) => !!feeds[a] && feeds[a]!.length > 0)

  // The chart's history window for the current timeframe (see historyAnchor).
  const chartTfSeconds = timeframeSeconds(chartTf)
  chartTfSecondsRef.current = chartTfSeconds
  const chartHistory = useMemo(
    () => (historyAnchor !== null ? historyWindow(historyAnchor, chartTfSeconds, historyBars) : null),
    [historyAnchor, chartTfSeconds, historyBars],
  )
  historyFromRef.current = chartHistory?.from ?? null

  // FXR_V2_SPEC.md section 4: the cursor stops at end_date -- the furthest bar
  // it may reach in the loaded window (chart/sessionEnd.ts). Read by the step,
  // play and hotkey paths below; advanceTo clamps to it as the one choke
  // point, and the backend refuses a later cursor on save too.
  const lastAllowed = bars ? lastAllowedIndex(bars, session?.end_date ?? null) : -1
  const lastAllowedRef = useRef(lastAllowed)
  lastAllowedRef.current = lastAllowed
  const sessionEnded = bars ? isSessionEnded(bars, cursorIndex, session?.end_date ?? null) : false
  // The result the completion card shows (the same stats query as the prop verdict
  // when this is a prop session, so it is not fetched twice).
  const { data: endStats } = useStats(sessionEnded && session ? manualRunId(session.id) : null, 'all')

  // F4: once this (new) session's bars have loaded, restore its persisted
  // position/working orders -- entry_time/placed_time are re-resolved to
  // indices into THIS bars array via resyncCursorIndex, the exact same
  // time->index recovery cursor_time itself already uses (see that
  // function's own comment for why an index can never survive a reload
  // directly). Runs at most once per session id (restoredForSessionRef).
  useEffect(() => {
    if (!session || !feedsReady || restoredForSessionRef.current === session.id) return
    restoredForSessionRef.current = session.id
    const restored: Record<string, InstrumentBook> = {}
    for (const p of session.positions) {
      const sym = p.instrument ?? session.instrument
      const feed = feedsRef.current[sym]
      if (!feed) continue
      restored[sym] = { ...(restored[sym] ?? EMPTY_BOOK), position: fromPersistedPosition(p, resyncCursorIndex(feed, p.entry_time)) }
    }
    for (const o of session.working_orders) {
      const sym = o.instrument ?? session.instrument
      const feed = feedsRef.current[sym]
      if (!feed) continue
      const book = restored[sym] ?? EMPTY_BOOK
      restored[sym] = { ...book, workingOrders: [...book.workingOrders, fromPersistedWorkingOrder(o, resyncCursorIndex(feed, o.placed_time))] }
    }
    if (Object.keys(restored).length === 0) return
    booksRef.current = { ...booksRef.current, ...restored }
    setBooks(booksRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, feedsReady])

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

  // The sim broker's indices are positions in a feed array, which a re-anchor (or a
  // feed arriving late) replaces: re-resolve every open position's entry and every
  // order's placement, in ITS OWN instrument's feed, from their times -- or MAE/MFE
  // would scan the wrong bars.
  const [syncedFeeds, setSyncedFeeds] = useState<(Bar[] | undefined)[]>([])
  const feedA = primarySymbol ? feeds[primarySymbol] : undefined
  const feedB = secondarySymbol ? feeds[secondarySymbol] : undefined
  if (feedA !== syncedFeeds[0] || feedB !== syncedFeeds[1]) {
    setSyncedFeeds([feedA, feedB])
    let next = booksRef.current
    for (const [sym, book] of Object.entries(booksRef.current)) {
      const feed = feeds[sym]
      if (!feed || feed.length === 0) continue
      const held = book.position
      const heldIndex = held ? resyncCursorIndex(feed, held.entryTime) : 0
      const position = held && heldIndex !== held.entryIndex ? { ...held, entryIndex: heldIndex } : held
      const stale = book.workingOrders.some((o) => o.placedIndex !== resyncCursorIndex(feed, o.placedTime))
      const workingOrders = stale
        ? book.workingOrders.map((o) => ({ ...o, placedIndex: resyncCursorIndex(feed, o.placedTime) }))
        : book.workingOrders
      if (position !== held || workingOrders !== book.workingOrders) {
        next = { ...next, [sym]: { position, workingOrders } }
      }
    }
    if (next !== booksRef.current) {
      booksRef.current = next
      setBooks(next)
    }
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
  const handleChartVisibleRangeChange = (range: { from: number; to: number } | null) => {
    // null means ChartKL's own data list is still empty (see its own
    // handleVisibleRangeChange) -- not yet the "real data is ready" signal.
    if (!range || initialFitAppliedRef.current || windowAnchor === null || !session) return
    initialFitAppliedRef.current = true
    if (!shouldRefitOnLoad(reanchoredAnchorRef.current === windowAnchor)) return
    klChartRef.current?.showLatest(DEFAULT_FIT_BARS)
  }

  // F4: every position-changing action (not just a replay step) PATCHes
  // the FULL current broker-state snapshot -- see UpdateSessionStateRequest's
  // own comment for why this is a full snapshot, never a partial patch.
  // Reads position/workingOrders from the REFS (always current, unlike
  // React state inside the same synchronous handler that just called
  // setPosition/setWorkingOrders) so every call site can update the refs
  // first and then call this with no extra parameters.
  //
  // Saves are SERIALISED: two quick actions (a level removed right after one
  // was placed, a partial close then a step) used to fire concurrent PATCHes,
  // and the browser may deliver them out of order, leaving the OLDER snapshot
  // as the saved one. Each queued save reads the refs when it is SENT, so it
  // always carries the latest full state, and they go one at a time.
  const persistQueueRef = useRef<Promise<unknown>>(Promise.resolve())
  const persist = (cursorTimeOverride?: number) => {
    if (!session) return
    const cursorTime = cursorTimeOverride ?? cursorTimeRef.current
    if (cursorTime === null) return
    cursorTimeRef.current = cursorTime
    const held = Object.values(booksRef.current)
    if (session.discipline_lock && lockFloorRef.current === null && held.some((b) => b.position || b.workingOrders.length > 0)) {
      lockFloorRef.current = cursorTime
    }
    const sessionId = session.id
    persistQueueRef.current = persistQueueRef.current
      .catch(() => undefined)
      .then(() =>
        updateCursor.mutateAsync({
          sessionId,
          cursorTime: cursorTimeRef.current ?? cursorTime,
          // Read when the save is SENT: every instrument's book, so the account's
          // whole state is one snapshot.
          positions: Object.entries(booksRef.current).flatMap(([symbol, b]) =>
            b.position ? [{ ...toPersistedPosition(b.position), instrument: symbol }] : [],
          ),
          workingOrders: Object.entries(booksRef.current).flatMap(([symbol, b]) =>
            b.workingOrders.map((o) => ({ ...toPersistedWorkingOrder(o), instrument: symbol })),
          ),
        }),
      )
      .catch(() => undefined)
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
  const journalClosedTrade = async (trade: ClosedTradeResult, instrument: string = activeRef.current) => {
    if (!session) return
    const feed = feedsRef.current[instrument] ?? bars
    const slPoints = trade.slPrice !== null ? Math.abs(trade.entryPrice - trade.slPrice) : null
    const tpPoints = trade.tpPrice !== null ? Math.abs(trade.tpPrice - trade.entryPrice) : null
    const body: CreateManualTradeRequest = {
      entry_time: trade.entryTime,
      exit_time: trade.exitTime,
      instrument,
      side: trade.side,
      leg: null,
      session: sessionForTime(sessionBands, trade.entryTime),
      trading_day: null,
      size_contracts: trade.contracts,
      entry_price: trade.entryPrice,
      exit_price: trade.exitPrice,
      sl_price: trade.slPrice,
      entry_sl_price: trade.entrySlPrice,
      entry_tp_price: trade.entryTpPrice,
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
      // The replay counts in 1m bars; v1 journaled the session's own base bars, and
      // a session's trades keep that unit whatever the chart timeframe is.
      bars_held: feed ? heldBaseBars(feed, trade.entryTime, trade.exitTime, BASE_TF_SECONDS[session.base_timeframe] ?? 60) : trade.barsHeld,
      // One exit of a position (FXR_V2_SPEC.md 3.6): the server merges every
      // exit sharing this key into a single trade.
      trade_key: trade.tradeKey,
      initial_contracts: trade.initialContracts,
      risk_usd: trade.riskUsd,
      // FXR_V2_SPEC.md 3.5: what the Place Order dialog attached (the server only
      // applies these when this exit creates the trade).
      tags: trade.journal?.tags ?? [],
      checklist: trade.journal?.checklist ?? [],
      notes: trade.journal?.notes ?? '',
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
  // The step size (the pill's dropdown, saved on the session): one step advances to
  // the end of a candle of this size (chart/replayBars.ts nextStepIndex). The chart
  // timeframe is independent of it, and every fill is evaluated on every 1m bar the
  // step passes over (advanceReplay), so how it is stepped never changes a result.
  const stepSeconds = timeframeSeconds(stepSize)

  const advanceTo = async (newIndex: number) => {
    if (!session || !bars) return
    // end_date: never step past the last allowed bar. Reaching it ends playback.
    if (lastAllowedRef.current >= 0 && newIndex > lastAllowedRef.current) {
      newIndex = lastAllowedRef.current
      setIsPlaying(false)
      if (newIndex === cursorIndexRef.current) return
    }
    // Never before the session's start (see minIndex).
    if (newIndex < cursorIndexRef.current && newIndex < startIndexRef.current) {
      newIndex = Math.min(cursorIndexRef.current, startIndexRef.current)
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
    // G7: every instrument's book moves together on the one clock. A multi-asset
    // session steps only once every asset's feed is loaded (a missing one would
    // silently skip its fills).
    const feedMap: Record<string, Bar[]> = {}
    for (const a of session.assets) {
      const f = feedsRef.current[a]
      if (!f || f.length === 0) return
      feedMap[a] = f
    }
    // With a no-news rule the step needs the calendar: stepping without it would let a
    // resting order fill inside a window. It loads with the bars; wait for it.
    if (newsGate && newsEventsRef.current === undefined) return
    const active = activeRef.current
    const booksBefore = booksRef.current
    const positionBefore = booksBefore[active]?.position ?? null
    const commissions: Record<string, number> = {}
    for (const a of session.assets) commissions[a] = session.account.commissions?.[a] ?? session.account.commission_per_contract
    const fromTime = cursorTimeRef.current ?? bars[cursorIndexRef.current]?.time ?? bars[newIndex].time
    const result = advanceSession({
      feeds: feedMap,
      books: booksBefore,
      fromTime,
      toTime: bars[newIndex].time,
      commissions,
      holding,
      cap: session.account.max_contracts ?? null,
      newsRefusal: (barTime) => newsWindowRefusal(newsEventsRef.current, newsGate, barTime),
      capMessage: (contracts, elsewhere) =>
        positionCapMessage(contracts, session.account.max_contracts, 'Order', elsewhere, elsewhereLabel(booksBefore, undefined)) ??
        `This fill would take the account over its ${session.account.max_contracts}-contract limit.`,
    })
    // A no-overnight / no-weekend close flattened the position (and cancelled working
    // orders): say so, and stop auto-play so it is seen.
    if (result.flattenedAtClose && holding) {
      setIsPlaying(false)
      setOrderNotice(flattenNotice(holding, active))
    }
    // A resting order the account's rules refused at the moment it would have
    // filled (the cross-instrument cap): cancelled with its reason.
    if (result.rejectedOrders.length > 0) {
      setIsPlaying(false)
      setOrderNotice(result.rejectedOrders.map((r) => `${r.instrument}: ${r.reason}`).join(' '))
    }
    // "Save & Journal" on a limit/stop order: the journal entry opens when it fills
    // (when it is the charted instrument's: the drawer reads that position).
    // The instrument (charted one first) whose journaled order filled in this step.
    const journalFillSymbol =
      [active, ...session.assets.filter((a) => a !== active)].find(
        (a) =>
          (result.books[a]?.position ?? null) !== null &&
          (booksBefore[a]?.workingOrders ?? []).some((o) => o.journalOnFill && result.filledOrderIds.includes(o.id)),
      ) ?? null
    booksRef.current = result.books
    setBooks(result.books)
    // Auto break-even just moved the stop to the entry (this step, not before).
    const after = result.books[active]?.position ?? null
    if (
      positionBefore &&
      after &&
      after.tradeKey === positionBefore.tradeKey &&
      after.autoBreakeven &&
      positionBefore.slPrice !== positionBefore.entryPrice &&
      after.slPrice === after.entryPrice
    ) {
      setToast(`Stop moved to break-even at ${fmtPrice(after.entryPrice, active)}`)
    }
    if (journalFillSymbol) {
      setIsPlaying(false)
      openOpenEntryInJournal(journalFillSymbol === active ? undefined : journalFillSymbol)
    }

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
    for (const trade of result.closedTrades) await journalClosedTrade(trade, trade.instrument)
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
    } else if (shouldReanchorBack(newIndex, bars[0]?.time, lastReanchoredBackAtFirstBarTimeRef.current)) {
      // A rewind nearing the first loaded bar: rebuild the window around the cursor.
      lastReanchoredBackAtFirstBarTimeRef.current = bars[0].time
      reanchoredAnchorRef.current = bars[newIndex].time
      setWindowAnchor(bars[newIndex].time)
      setWindowLookahead(REANCHOR_BACK_LOOKAHEAD_BARS)
    }
    // ...and the chart's history too, once a rewind has gone behind what it loaded.
    const historyFrom = historyFromRef.current
    if (t !== undefined && historyFrom !== null && bucketStart(t, chartTfSecondsRef.current) < historyFrom + 50 * chartTfSecondsRef.current) {
      setHistoryAnchor(t)
      setHistoryBars(HISTORY_BARS)
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
      advanceTo(nextStepIndex(bars, prev, stepSeconds, lastAllowedRef.current))
    }, 1000 / speed)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, bars, speed, stepSeconds])


  // While the window swaps (bars briefly undefined) keep the logical cursor
  // time, never null: a null cursor means "no replay", which would reveal
  // every bar of the incoming window (look-ahead).
  const cursorTime = bars ? (bars[cursorIndex]?.time ?? null) : cursorTimeRef.current

  // What the chart is built from (null until the feed has loaded: it draws nothing).
  const replayFeed = useMemo(() => (bars && bars.length > 0 ? { feed: bars, cursorIndex } : null), [bars, cursorIndex])

  // Session shading wherever candles are shown: the chart's history reaches further back
  // than the 1m feed, so the range spans both (capped, whole days so the query is stable).
  const sessionsFrom = useMemo(() => {
    if (!barsWindow) return null
    const earliest = Math.max(Math.min(barsWindow.from, chartHistory?.from ?? barsWindow.from), barsWindow.to - SESSION_BANDS_MAX_DAYS * 86400)
    return Math.floor(earliest / 86400) * 86400
  }, [barsWindow?.from, barsWindow?.to, chartHistory?.from])
  const { data: sessionsInView } = useSessions(activeInstrumentOrNull, sessionsFrom, barsWindow?.to ?? null)
  // G7: the economic calendar over the same span -- schedule only. The chart draws it
  // (ahead of the cursor too: a scheduled release is public in advance) and, with a
  // no-news rule, the broker gate and the entry buttons read it.
  const newsFrom = sessionsFrom
  const newsTo = barsWindow ? Math.ceil(barsWindow.to / 86400) * 86400 + 86400 : null
  const { data: newsEvents } = useNewsEvents(newsFrom, newsTo)
  newsEventsRef.current = newsEvents
  const sessionBands: SessionBand[] = useMemo(
    () =>
      (sessionsInView ?? []).map((s) => ({
        start: s.start,
        end: s.end,
        session: s.session,
        fairValue: s.fair_value,
        fairValueTime: s.fair_value_time,
      })),
    [sessionsInView],
  )
  // What the CHART may show: only sessions the cursor has reached, and a fair value only
  // once it is known (/api/sessions lists the window's future sessions too, fair values
  // from prices the replay has not shown). Memoised on what is actually revealed, so the
  // chart's session overlays are rebuilt when a session starts or a fair value appears --
  // not on every step.
  const revealedBands = revealedSessionBands(sessionBands, cursorTime ?? 0)
  const revealedBandsKey = revealedBands.map((b) => `${b.session}${b.start}:${b.fairValue ?? ''}`).join('|')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const chartBands = useMemo(() => revealedBands, [revealedBandsKey, sessionBands])

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
    const fit = reviewFitWindow(trade.entry_time, trade.exit_time, chartTf)
    // Clamped to what the chart has loaded: its history up to the revealed cursor.
    const from = Math.max(fit.from, chartHistory?.from ?? bars[0].time)
    const to = Math.min(fit.to, cursorTimeRef.current ?? bars[bars.length - 1].time)
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
  // G5: the history's indicators load once (every candle in it is complete); the
  // candles built since -- the forming one included -- come from the backend as of
  // the cursor on every step (useReplayIndicators). Nothing is computed in the
  // browser: the two are only spliced where the tail starts.
  const { data: indicatorHistory } = useIndicators(
    activeInstrumentOrNull,
    chartTf,
    chartHistory?.from ?? null,
    chartHistory?.to ?? null,
    enabledIndicators,
  )
  const indicatorTail = useReplayIndicators({
    instrument: activeInstrumentOrNull,
    timeframe: chartTf,
    tfSeconds: chartTfSeconds,
    historyFrom: chartHistory?.from ?? null,
    historyEnd: chartHistory?.to ?? null,
    cursorTime,
    which: enabledIndicators,
  })
  const indicators = useMemo(
    () => ({
      vwap: spliceTail(indicatorHistory?.vwap ?? [], indicatorTail.vwap ?? []),
      ema20: spliceTail(indicatorHistory?.ema20 ?? [], indicatorTail.ema20 ?? []),
      ema50: spliceTail(indicatorHistory?.ema50 ?? [], indicatorTail.ema50 ?? []),
      atr14: spliceTail(indicatorHistory?.atr14 ?? [], indicatorTail.atr14 ?? []),
    }),
    [indicatorHistory, indicatorTail],
  )

  // True while nothing is working/open -- the shared gate for every action
  // that starts a new trade (Buy/Sell, Place Order, a right-click order): at
  // most one position-in-progress at a time, same single-position
  // simplification F2 already established.
  const flat = !position && workingOrders.length === 0
  // G7: why a new entry on the bar opening at `barTime` is refused by the session's
  // no-news rule (a high-impact event within its window), or null.
  const newsEntryRefusal = (barTime: number): string | null => newsWindowRefusal(newsEventsRef.current, newsGate, barTime)
  // Why trading is refused right now (null = open): the end date, a no-overnight /
  // no-weekend close, an open trade, or no bars yet. Buy, Sell, Place order and the
  // position tool dim with this as their tooltip.
  const tradeBlock: string | null = sessionEnded
    ? 'The session has ended'
    : (bars && bars[cursorIndex] ? entryRefusal(holding, bars[cursorIndex].time) : null) ??
      (bars && bars[cursorIndex] ? newsEntryRefusal(bars[cursorIndex].time) : null) ??
      (newsGate && newsEvents === undefined ? 'Loading the economic calendar' : null) ??
      (!flat ? 'Close or cancel the open trade first' : !bars || bars.length === 0 ? 'Waiting for bars' : null)
  // A position tool is a plan for the NEXT trade: once any trade is open or
  // working (a Quick Buy/Sell, a right-click order) it has nothing left to plan.
  useEffect(() => {
    if (!flat) setPositionTool(null)
  }, [flat])

  const accountRiskUsd = () =>
    session ? riskUsdAtEntry(session.account.balance, session.account.risk_per_trade_percent, session.account.risk_per_trade_usd) : null

  // The armed Scalper's brackets for an entry at `entry`, or null when it is
  // not armed (then everything behaves exactly as in G2).
  const armedScalperBrackets = (side: Side, entry: number, contracts: number, spec: ReturnType<typeof getContractSpec>): ScalperBrackets | null =>
    entryBrackets(scalper, side, entry, contracts, spec)

  const scalperToast = (side: Side, contracts: number, pos: Pick<OpenPosition, 'entryPrice' | 'slPrice' | 'tpPrice'>, instrument: string) => {
    const levels = [
      pos.slPrice !== null ? `SL ${fmtPrice(pos.slPrice, instrument)}` : null,
      pos.tpPrice !== null ? `TP ${fmtPrice(pos.tpPrice, instrument)}` : null,
    ].filter(Boolean)
    return `Scalper: ${side === 'long' ? 'Buy' : 'Sell'} ${contracts} ${instrument} at ${fmtPrice(pos.entryPrice, instrument)}${levels.length ? ` | ${levels.join(' | ')}` : ''}`
  }

  // FXR_SPEC.md section 3/6: market orders fill at the current cursor bar's
  // close (chart/simBroker.ts's documented convention) -- entry and exit
  // both read `bars[cursorIndex]` only, never a bar beyond it.
  // The position cap is ONE number for the account, counted across instruments
  // (positionCap.ts): what is open in the OTHER instrument(s) is what an order
  // here has less room for.
  const capContext = () => ({
    elsewhere: openContractsElsewhere(booksRef.current, activeInstrument),
    label: elsewhereLabel(booksRef.current, activeInstrument),
  })

  const enterPosition = (side: Side) => {
    if (!session || !bars || !bars[cursorIndex] || !flat || sessionEnded) return
    const cc = capContext()
    const capMsg = positionCapMessage(quickQty, session.account.max_contracts, 'Market order', cc.elsewhere, cc.label)
    if (capMsg) {
      setOrderNotice(capMsg)
      return
    }
    const holdMsg = entryRefusal(holding, bars[cursorIndex].time) ?? newsEntryRefusal(bars[cursorIndex].time)
    if (holdMsg) {
      setOrderNotice(holdMsg)
      return
    }
    setOrderNotice(null)
    const entryBar = bars[cursorIndex]
    const entryPrice = marketFillPrice(entryBar)
    const spec = getContractSpec(activeInstrument)
    // FXR_V2_SPEC.md 3.4: an armed Scalper Mode brackets the entry from its preset
    // distances, measured from the fill, and no ghost lines appear.
    const sc = armedScalperBrackets(side, entryPrice, quickQty, spec)
    // FXR_V2_SPEC.md 3.2: otherwise a Quick entry carries no SL/TP, so ghost lines
    // appear at sensible defaults (an ATR of the bars revealed so far).
    const ghosts = !sc && ghostsApply(null, null) ? ghostLevels(side, entryPrice, spec, averageTrueRange(bars, cursorIndex)) : null
    const newPosition: OpenPosition = {
      side,
      contracts: quickQty,
      entryPrice,
      entryTime: entryBar.time,
      entryIndex: cursorIndex,
      riskUsd: sc?.riskUsd ?? accountRiskUsd(),
      slPrice: sc?.slPrice ?? null,
      tpPrice: sc?.tpPrice ?? null,
      entrySlPrice: sc?.slPrice ?? null,
      entryTpPrice: sc?.tpPrice ?? null,
      autoBreakeven: (sc?.autoBreakeven ?? false) || armedAutoBreakeven,
      breakevenR: sc?.breakevenR ?? null,
      breakevenPoints: sc?.breakevenPoints ?? null,
      trailingPoints: armedTrailingPoints,
      tradeKey: crypto.randomUUID(),
      initialContracts: quickQty,
      ghostSl: ghosts?.sl ?? null,
      ghostTp: ghosts?.tp ?? null,
    }
    positionRef.current = newPosition
    setPosition(newPosition)
    persist()
    if (sc) setToast(scalperToast(side, quickQty, newPosition, activeInstrument))
  }

  // The feed a book's trade is judged on, and where the shared cursor is in it: the
  // latest bar of THAT instrument at or before the cursor time (never after).
  const cursorIn = (symbol: string): { feed: Bar[]; index: number } | null => {
    const feed = symbol === activeInstrument ? bars : feedsRef.current[symbol]
    if (!feed || feed.length === 0) return null
    if (symbol === activeInstrument) return { feed, index: cursorIndex }
    const index = lastIndexAtOrBefore(feed, cursorTimeRef.current ?? Number.POSITIVE_INFINITY)
    return index >= 0 ? { feed, index } : null
  }
  const commissionOf = (symbol: string) => session?.account.commissions?.[symbol] ?? session?.account.commission_per_contract ?? 0

  const handleClosePosition = async (symbol: string = activeInstrument) => {
    const pos = booksRef.current[symbol]?.position
    const at = cursorIn(symbol)
    if (!session || !at || !pos) return
    const result = closePosition(at.feed, pos, at.index, getContractSpec(symbol), commissionOf(symbol))
    writeBook(symbol, { position: null })
    // Journal BEFORE persisting -- see journalClosedTrade's own comment on
    // why the order matters (both endpoints race on the same session.json
    // otherwise).
    await journalClosedTrade(result, symbol)
    persist()
  }

  // FXR_V2_SPEC.md 3.6: closes ANY whole quantity (1 .. open-1) at market
  // (the full size is a plain Close). The slice is journaled as ONE EXIT of the
  // position's trade -- the server merges it with the remainder's later exits,
  // so R and P&L are computed across all of them. The remainder keeps the same
  // entry/SL/TP. With no quantity given it closes half (the Shift hotkey).
  const handlePartialClose = async (quantity?: number, symbol: string = activeInstrument) => {
    const pos = booksRef.current[symbol]?.position
    const at = cursorIn(symbol)
    if (!session || !at || !pos) return
    const qty = quantity ?? Math.max(1, Math.round(pos.contracts / 2))
    const refusal = partialCloseRefusal(qty, pos.contracts)
    if (refusal) {
      setOrderNotice(refusal)
      return
    }
    const result = closePositionPartialAtMarket(at.feed, pos, at.index, qty, getContractSpec(symbol), commissionOf(symbol))
    writeBook(symbol, { position: result.remainingPosition })
    setToast(`Closed ${qty} of ${pos.contracts} ${symbol} at ${fmtPrice(result.closedTrade.exitPrice, symbol)} | ${fmtSignedUsd(result.closedTrade.pnlUsd)}`)
    await journalClosedTrade(result.closedTrade, symbol)
    persist()
  }

  // FXR_V2_SPEC.md 3.2/3.6: set, move or remove one of the position's two
  // levels. Every change is persisted; a level on the wrong side of the market
  // is refused (it would fill on the next bar) and the line snaps back.
  const setLevel = (kind: LevelKind, price: number | null, source: 'ghost' | 'placed', symbol: string = activeInstrument) => {
    const pos = booksRef.current[symbol]?.position
    const at = cursorIn(symbol)
    if (!session || !at || !at.feed[at.index] || !pos) return
    const spec = getContractSpec(symbol)
    let toastText: string | null = null
    let next: OpenPosition
    if (price === null) {
      next = kind === 'sl' ? { ...pos, slPrice: null, ghostSl: null } : { ...pos, tpPrice: null, ghostTp: null }
      toastText = kind === 'sl' ? 'Stop loss removed' : 'Take profit removed'
    } else {
      const snapped = roundToTick(price, spec.tickSize)
      const refusal = levelRefusal(pos.side, kind, snapped, at.feed[at.index].close, spec.tickSize)
      if (refusal) {
        setOrderNotice(refusal)
        setLineNonce((n) => n + 1)
        return
      }
      const r = levelReadout(pos.side, pos.entryPrice, snapped, pos.contracts, spec)
      toastText = `${kind === 'sl' ? 'Stop loss' : 'Take profit'} ${source === 'ghost' ? 'set' : 'moved'} to ${fmtPrice(snapped, symbol)} | ${fmtSignedUsd(r.pnlUsd)} | ${r.ticks} ticks`
      next =
        kind === 'sl' ? { ...pos, slPrice: snapped, ghostSl: null } : { ...pos, tpPrice: snapped, ghostTp: null }
    }
    writeBook(symbol, { position: next })
    setLineNonce((n) => n + 1)
    persist()
    if (toastText) setToast(toastText)
  }

  // Brings a removed ghost back at the default distance ("Add stop loss").
  const addGhost = (kind: LevelKind) => {
    if (!session || !bars || !positionRef.current) return
    const pos = positionRef.current
    // Default distances are measured from the entry, as the originals were.
    const g = ghostLevels(pos.side, pos.entryPrice, getContractSpec(activeInstrument), averageTrueRange(bars, cursorIndex))
    const next = kind === 'sl' ? { ...pos, ghostSl: g.sl } : { ...pos, ghostTp: g.tp }
    positionRef.current = next
    setPosition(next)
    persist()
  }

  // One-click break-even: the stop to the entry price, once the trade is in profit.
  const handleBreakeven = (symbol: string = activeInstrument) => {
    const pos = booksRef.current[symbol]?.position
    const at = cursorIn(symbol)
    if (!session || !at || !at.feed[at.index] || !pos) return
    const refusal = breakevenRefusal(pos, at.feed[at.index].close)
    if (refusal) {
      setOrderNotice(refusal)
      return
    }
    setLevel('sl', pos.entryPrice, 'placed', symbol)
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

  // The default risk budget (the session's configured risk) on the chosen
  // balance basis: what the position tool's live labels size against, and what
  // the Place Order dialog opens with.
  const riskBasis = prefs.riskBasis
  const balances = session ? { initial: session.account.starting_balance, current: session.account.balance } : null
  const defaultRiskPct = (() => {
    if (!session || !balances) return 1
    const { risk_per_trade_percent: pct, risk_per_trade_usd: usd } = session.account
    if (pct !== null) return pct
    return usd !== null ? riskPctFromUsd(usd, balanceFor(riskBasis, balances)) : 1
  })()
  const defaultRiskUsd = balances ? Math.round((defaultRiskPct / 100) * balanceFor(riskBasis, balances) * 100) / 100 : null
  // What the dialog, the tool's sizing and the quantity box bound against: the cap
  // less what is open in the other instrument (null = uncapped).
  const positionCap = capRoom(session?.account.max_contracts ?? null, openContractsElsewhere(books, activeInstrument))

  // What the dialog (and its rules) need to know about the market right now --
  // the cursor bar's close and the ATR up to it, never a later bar.
  const buildOrderContext = (): OrderContext | null => {
    if (!session || !balances || !bars || !bars[cursorIndex]) return null
    return {
      instrument: activeInstrument,
      spec: getContractSpec(activeInstrument),
      mark: bars[cursorIndex].close,
      balances,
      cap: positionCap,
      openElsewhere: openContractsElsewhere(books, activeInstrument),
      elsewhereLabel: elsewhereLabel(books, activeInstrument),
      quickQuantity: quickQty,
      atr: averageTrueRange(bars, cursorIndex),
    }
  }

  // The Long / Short Position tool (toolbar): arms ChartKL's one-click
  // placement. The tool appears at the CURRENT price with the default stop and
  // target; nothing is ordered until the dialog saves.
  const startPositionTool = (side: Side) => {
    const ctx = buildOrderContext()
    if (!ctx || !flat || sessionEnded) return
    setIsPlaying(false)
    const levels = defaultToolLevels(side, ctx.mark, ctx.spec, ctx.atr)
    // Cleared first so a tool already on the chart is replaced, not restored.
    setPositionTool(null)
    klChartRef.current?.startPositionTool({ levels, spec: ctx.spec, sizing: { riskUsd: defaultRiskUsd, cap: positionCap } })
  }
  const positionToolSpec = useMemo<PositionToolSpec | null>(
    () =>
      positionTool && session
        ? { levels: positionTool, spec: getContractSpec(activeInstrument), sizing: { riskUsd: defaultRiskUsd, cap: positionCap } }
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [positionTool, activeInstrument, defaultRiskUsd, positionCap],
  )

  // Opening the dialog (the top bar's Place order, Shift+N, the tool's menu)
  // always pauses the replay: the market would otherwise run under the form.
  // `type` is the Shift+M / L / T hotkeys' preset; the buttons pass none.
  const openOrderDialog = (type?: OrderKind) => {
    if (!bars || !bars[cursorIndex] || !flat || sessionEnded) return
    setIsPlaying(false)
    setOrderDialogType(type ?? null)
    setOrderDialogOpen(true)
  }

  // Save / Save & Journal. A Market order fills now (the cursor bar's close,
  // like Buy/Sell, but with the dialog's SL/TP, size and tags); a Limit / Stop
  // becomes the working order. The dialog already refused an over-cap size with
  // its reason -- this re-checks, as every entry path does.
  const placeOrder = (order: OrderRequest, journal: boolean) => {
    if (!session || !bars || !bars[cursorIndex] || !flat || sessionEnded) return
    const cc = capContext()
    const capMsg = positionCapMessage(order.contracts, session.account.max_contracts, 'Order', cc.elsewhere, cc.label)
    if (capMsg) {
      setOrderNotice(capMsg)
      return
    }
    const holdMsg = entryRefusal(holding, bars[cursorIndex].time) ?? newsEntryRefusal(bars[cursorIndex].time)
    if (holdMsg) {
      setOrderNotice(holdMsg)
      return
    }
    setOrderNotice(null)
    const marketBar = bars[cursorIndex]
    const spec = getContractSpec(activeInstrument)
    const orderJournal: OrderJournal = { tags: order.tags, checklist: order.checklist, notes: '' }
    const verb = order.side === 'long' ? 'Buy' : 'Sell'
    if (order.type === 'market') {
      // No SL/TP at all: the ghost lines appear, as for a Quick entry (3.1).
      const ghosts = ghostsApply(order.slPrice, order.tpPrice)
        ? ghostLevels(order.side, marketBar.close, spec, averageTrueRange(bars, cursorIndex))
        : null
      const newPosition: OpenPosition = {
        side: order.side,
        contracts: order.contracts,
        entryPrice: marketFillPrice(marketBar),
        entryTime: marketBar.time,
        entryIndex: cursorIndex,
        riskUsd: order.riskUsd,
        slPrice: order.slPrice,
        tpPrice: order.tpPrice,
        entrySlPrice: order.slPrice,
        entryTpPrice: order.tpPrice,
        autoBreakeven: order.autoBreakeven,
        trailingPoints: armedTrailingPoints,
        tradeKey: crypto.randomUUID(),
        initialContracts: order.contracts,
        ghostSl: ghosts?.sl ?? null,
        ghostTp: ghosts?.tp ?? null,
        journal: orderJournal,
      }
      positionRef.current = newPosition
      setPosition(newPosition)
      setToast(`${verb} ${order.contracts} ${activeInstrument} at market, ${fmtPrice(newPosition.entryPrice, activeInstrument)}`)
    } else {
      const working: WorkingOrder = {
        id: crypto.randomUUID(),
        side: order.side,
        orderType: order.type,
        price: order.entryPrice,
        contracts: order.contracts,
        slPrice: order.slPrice,
        tpPrice: order.tpPrice,
        riskUsd: order.riskUsd,
        placedTime: marketBar.time,
        placedIndex: cursorIndex,
        autoBreakeven: order.autoBreakeven,
        trailingPoints: armedTrailingPoints,
        journal: orderJournal,
        journalOnFill: journal,
      }
      workingOrdersRef.current = [working]
      setWorkingOrders([working])
      setToast(`${verb} ${order.type} ${order.contracts} ${activeInstrument} placed at ${fmtPrice(order.entryPrice, activeInstrument)}`)
    }
    setPositionTool(null)
    setOrderDialogOpen(false)
    persist()
    // A market order has filled already: its journal entry opens now. A limit /
    // stop opens it when it fills (advanceTo).
    if (journal && order.type === 'market') openOpenEntryInJournal()
  }

  const cancelWorkingOrder = (symbol: string = activeInstrument) => {
    writeBook(symbol, { workingOrders: [] })
    persist()
  }

  // Right-click order placement (FXR_V2_SPEC.md 3.3, reference R5): the pair
  // that is meaningful at the clicked price -- above market a sell limit and a
  // buy stop, below a buy limit and a sell stop (orderEntry.ts rightClickOrders)
  // -- sized by the Quick quantity, labelled "Buy 2 MNQ @ 20,050.25 limit". No
  // SL/TP rides along unless Scalper Mode is armed (G4), which brackets it.
  const handleEmptyAreaMenuItems = (info: { time: number; price: number }): ContextMenuEntry[] => {
    if (!session || !bars || !bars[cursorIndex] || !flat || sessionEnded) return []
    const spec = getContractSpec(activeInstrument)
    const marketPrice = bars[cursorIndex].close
    return rightClickOrders(info.price, marketPrice, quickQty, activeInstrument, spec).map((o) => ({
      label: withBracketsNote(o.label, armedScalperBrackets(o.side, o.price, o.contracts, spec)),
      onSelect: () => {
        if (!bars[cursorIndex]) return
        const cc = capContext()
        const capMsg = positionCapMessage(o.contracts, session.account.max_contracts, 'Order', cc.elsewhere, cc.label)
        if (capMsg) {
          setOrderNotice(capMsg)
          return
        }
        const holdMsg = entryRefusal(holding, bars[cursorIndex].time) ?? newsEntryRefusal(bars[cursorIndex].time)
        if (holdMsg) {
          setOrderNotice(holdMsg)
          return
        }
        setOrderNotice(null)
        // An armed Scalper brackets the order from ITS price (where it will fill).
        const sc = armedScalperBrackets(o.side, o.price, o.contracts, spec)
        const order: WorkingOrder = {
          id: crypto.randomUUID(),
          side: o.side,
          orderType: o.orderType,
          price: o.price,
          contracts: o.contracts,
          slPrice: sc?.slPrice ?? null,
          tpPrice: sc?.tpPrice ?? null,
          riskUsd: sc?.riskUsd ?? accountRiskUsd(),
          placedTime: bars[cursorIndex].time,
          placedIndex: cursorIndex,
          autoBreakeven: (sc?.autoBreakeven ?? false) || armedAutoBreakeven,
          breakevenR: sc?.breakevenR ?? null,
          breakevenPoints: sc?.breakevenPoints ?? null,
          trailingPoints: armedTrailingPoints,
        }
        workingOrdersRef.current = [order]
        setWorkingOrders([order])
        persist()
      },
    }))
  }

  // The open position rendered through the SAME TradeRecord shape a closed
  // trade uses (see openPositionAsTradeRecord's own comment) -- zero
  // chart-side changes needed to show it with the existing entry marker/
  // trade-overlay conventions, now also carrying real SL/TP when the
  // position has them (F3).
  // `symbol`'s open position as a TradeRecord, marked at the latest bar of THAT
  // instrument at or before the shared cursor.
  const openRecordFor = (symbol: string): TradeRecord | null => {
    const pos = books[symbol]?.position
    const at = cursorIn(symbol)
    const bar = at?.feed[at.index]
    if (!pos || !session || !at || !bar) return null
    return {
      ...openPositionAsTradeRecord({ position: pos, instrument: symbol, cursorIndex: at.index, markPrice: bar.close, cursorTime: bar.time }),
      // Counted in the session's base timeframe, like every journaled trade.
      bars_held: heldBaseBars(at.feed, pos.entryTime, bar.time, BASE_TF_SECONDS[session.base_timeframe] ?? 60),
    }
  }
  const openPositionRecord: TradeRecord | null = openRecordFor(activeInstrument)

  // A trade with contracts still open (a partial close) is drawn through the
  // live position record instead -- not twice.
  const chartTrades: TradeRecord[] = useMemo(
    // The chart plots one instrument's price scale: that instrument's trades only.
    () => [
      ...(manualTrades ?? []).filter((t) => tradeOpenContracts(t) === 0 && (t.instrument ?? primarySymbol) === activeInstrument),
      ...(openPositionRecord ? [openPositionRecord] : []),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [manualTrades, openPositionRecord, activeInstrument],
  )

  // FXR_V2_SPEC.md section 2/3: the position line, its SL/TP (placed, or ghost
  // until placed) and working orders, as ChartKL order lines. Ids are stable per
  // line so ChartKL syncs rather than rebuilds them (and never mid-drag).
  const markPrice = bars?.[cursorIndex]?.close ?? null
  const orderLines = useMemo<OrderLineSpec[]>(() => {
    if (!session || prefs.hideTrades || markPrice === null) return []
    const spec = getContractSpec(activeInstrument)
    const lines: OrderLineSpec[] = []
    if (position) {
      const base = { side: position.side, entryPrice: position.entryPrice, contracts: position.contracts, spec }
      lines.push({
        id: 'pos',
        price: position.entryPrice,
        draggable: false,
        info: { ...base, role: 'position', pnlUsd: positionPnl(position.side, position.entryPrice, markPrice, position.contracts, spec) },
      })
      if (position.slPrice !== null) lines.push({ id: 'pos-sl', price: position.slPrice, draggable: true, info: { ...base, role: 'sl' } })
      else if (position.ghostSl !== null) lines.push({ id: 'ghost-sl', price: position.ghostSl, draggable: true, info: { ...base, role: 'ghost-sl' } })
      if (position.tpPrice !== null) lines.push({ id: 'pos-tp', price: position.tpPrice, draggable: true, info: { ...base, role: 'tp' } })
      else if (position.ghostTp !== null) lines.push({ id: 'ghost-tp', price: position.ghostTp, draggable: true, info: { ...base, role: 'ghost-tp' } })
    }
    for (const o of workingOrders) {
      const base = { side: o.side, entryPrice: o.price, contracts: o.contracts, spec }
      lines.push({ id: `order-${o.id}`, price: o.price, draggable: false, info: { ...base, role: 'order', orderType: o.orderType } })
      if (o.slPrice !== null) lines.push({ id: `order-${o.id}-sl`, price: o.slPrice, draggable: false, info: { ...base, role: 'sl' } })
      if (o.tpPrice !== null) lines.push({ id: `order-${o.id}-tp`, price: o.tpPrice, draggable: false, info: { ...base, role: 'tp' } })
    }
    return lines
    // lineNonce forces a fresh list after a refused drag so ChartKL re-syncs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeInstrument, prefs.hideTrades, markPrice, position, workingOrders, lineNonce])

  // A line's gesture. Pressing one pauses the replay (the market must not run
  // under a drag); releasing places the level -- or refuses it (setLevel).
  const handleOrderLineDrag = (id: string, price: number, phase: 'start' | 'move' | 'end') => {
    if (phase === 'start') setIsPlaying(false)
    if (phase !== 'end') return
    if (id === 'pos-sl' || id === 'ghost-sl') setLevel('sl', price, id === 'ghost-sl' ? 'ghost' : 'placed')
    else if (id === 'pos-tp' || id === 'ghost-tp') setLevel('tp', price, id === 'ghost-tp' ? 'ghost' : 'placed')
  }

  // The label's x: closes the position, removes a level, or cancels an order.
  const handleOrderLineClose = (id: string) => {
    if (id === 'pos') {
      if (!createTrade.isPending) void handleClosePosition()
    } else if (id === 'pos-sl' || id === 'ghost-sl') setLevel('sl', null, 'placed')
    else if (id === 'pos-tp' || id === 'ghost-tp') setLevel('tp', null, 'placed')
    else if (id.startsWith('order-')) {
      if (id.endsWith('-sl') || id.endsWith('-tp')) {
        const kind = id.endsWith('-sl') ? 'slPrice' : 'tpPrice'
        const orderId = id.slice('order-'.length, -3)
        const updated = workingOrdersRef.current.map((o) => (o.id === orderId ? { ...o, [kind]: null } : o))
        workingOrdersRef.current = updated
        setWorkingOrders(updated)
        persist()
      } else cancelWorkingOrder(activeInstrument)
    }
  }

  // Right-click on the position line (partial close, break-even, levels) or on
  // any other order line.
  const getOrderLineMenu = (id: string): ContextMenuEntry[] => {
    setIsPlaying(false)
    if (id === 'pos' && position) {
      const items: ContextMenuEntry[] = [{ label: 'Close position', onSelect: () => void handleClosePosition(activeInstrument) }]
      const choices = partialCloseChoices(position.contracts)
      if (choices.length > 0) {
        items.push(...choices.map((q) => ({ label: `Close ${q} of ${position.contracts}`, onSelect: () => void handlePartialClose(q, activeInstrument) })))
      }
      items.push({ separator: true }, { label: 'Move stop to break-even', onSelect: () => handleBreakeven(activeInstrument) })
      if (position.slPrice === null && position.ghostSl === null) items.push({ label: 'Add stop loss', onSelect: () => addGhost('sl') })
      if (position.tpPrice === null && position.ghostTp === null) items.push({ label: 'Add take profit', onSelect: () => addGhost('tp') })
      return items
    }
    if (id === 'pos-sl') {
      return [
        { label: 'Move to break-even', onSelect: () => handleBreakeven(activeInstrument) },
        { label: 'Remove stop loss', onSelect: () => setLevel('sl', null, 'placed'), destructive: true },
      ]
    }
    if (id === 'pos-tp') return [{ label: 'Remove take profit', onSelect: () => setLevel('tp', null, 'placed'), destructive: true }]
    if (id === 'ghost-sl') return [{ label: 'Remove stop loss', onSelect: () => setLevel('sl', null, 'placed'), destructive: true }]
    if (id === 'ghost-tp') return [{ label: 'Remove take profit', onSelect: () => setLevel('tp', null, 'placed'), destructive: true }]
    if (id.startsWith('order-') && !id.endsWith('-sl') && !id.endsWith('-tp')) {
      return [{ label: 'Cancel order', onSelect: () => cancelWorkingOrder(activeInstrument), destructive: true }]
    }
    return []
  }

  // Moves the replay cursor to `time` (a rewind: "Set replay start"). Inside the loaded
  // feed it is a plain move; before it, the feed is re-anchored on the target first.
  // The prop and discipline-lock rules apply either way.
  const jumpCursorToTime = (requestedTime: number) => {
    if (!session || !bars) return
    const time = Math.max(requestedTime, session.start_time)
    const index = lastIndexAtOrBefore(bars, time)
    if (index >= 0) {
      handleCursorIndexChange(index)
      return
    }
    if (session.account.prop_ruleset) {
      setOrderNotice(PROP_REWIND_MESSAGE)
      return
    }
    if (session.discipline_lock && lockFloorRef.current !== null && time < lockFloorRef.current) {
      setOrderNotice(REWIND_BLOCKED_MESSAGE)
      return
    }
    setIsPlaying(false)
    cursorTimeRef.current = time
    reanchoredAnchorRef.current = time
    lastReanchoredBackAtFirstBarTimeRef.current = null
    setWindowAnchor(time)
    setWindowLookahead(REANCHOR_BACK_LOOKAHEAD_BARS)
    setHistoryAnchor(time)
    setHistoryBars(HISTORY_BARS)
    persist(time)
  }
  const handleCandleBarClick = (bar: { timestamp: number }) => {
    const barTime = bar.timestamp / 1000
    if (magnifierArmed) {
      // Only a bar the cursor has reached can be magnified (chart/magnifier.ts).
      if (magnifierRange(barTime, chartTfSeconds, cursorTime) !== null) setMagnifyBarTime(barTime)
      setMagnifierArmed(false)
      return
    }
    if (!pickingReplayStart || !bars) return
    // The replay restarts at the END of the clicked candle (never past the cursor).
    jumpCursorToTime(Math.min(barTime + chartTfSeconds - 60, cursorTime ?? barTime))
    setPickingReplayStart(false)
  }

  // The open position's journal entry, until its first exit creates the trade
  // (record_trade): notes and tags written now ride on the position and land on
  // that trade. After a partial close the real trade exists and the drawer
  // shows it instead.
  const journalInstrument = journalSymbol && session?.assets.includes(journalSymbol) ? journalSymbol : activeInstrument
  const journalPosition = books[journalInstrument]?.position ?? null
  const journalOpenEntry: OpenJournalEntry | null =
    journalPosition && session && !(manualTrades ?? []).some((t) => t.trade_key === journalPosition.tradeKey)
      ? {
          tradeKey: journalPosition.tradeKey,
          instrument: journalInstrument,
          side: journalPosition.side,
          contracts: journalPosition.initialContracts,
          entryTime: journalPosition.entryTime,
          entryPrice: journalPosition.entryPrice,
          slPrice: journalPosition.slPrice,
          tpPrice: journalPosition.tpPrice,
          tags: journalPosition.journal?.tags ?? [],
          checklist: journalPosition.journal?.checklist ?? [],
          notes: journalPosition.journal?.notes ?? '',
        }
      : null
  const handleUpdateOpenEntry = (patch: Partial<Pick<OrderJournal, 'notes' | 'tags'>>) => {
    const pos = booksRef.current[journalInstrument]?.position ?? null
    if (!pos) return
    const next: OpenPosition = { ...pos, journal: { ...(pos.journal ?? NO_JOURNAL), ...patch } }
    writeBook(journalInstrument, { position: next })
    persist()
  }

  // Every instrument's position and orders, for the panel (one row each).
  const symbols = session?.assets ?? []
  const workingOrderRows: WorkingOrderRow[] = symbols.flatMap((symbol) =>
    (books[symbol]?.workingOrders ?? []).map((o) => ({
      instrument: symbol,
      side: o.side,
      orderType: o.orderType,
      price: o.price,
      contracts: o.contracts,
      slPrice: o.slPrice,
      tpPrice: o.tpPrice,
    })),
  )
  const positionRows: PositionRow[] = symbols.flatMap((symbol) => {
    const pos = books[symbol]?.position
    const record = pos ? openRecordFor(symbol) : null
    return pos && record
      ? [
          {
            instrument: symbol,
            side: pos.side,
            contracts: pos.contracts,
            entryPrice: pos.entryPrice,
            slPrice: pos.slPrice,
            tpPrice: pos.tpPrice,
            pnlUsd: record.pnl_usd,
            rMultiple: record.r_multiple,
          },
        ]
      : []
  })
  const holdingSymbols = symbols.filter((s) => books[s]?.position || (books[s]?.workingOrders.length ?? 0) > 0)

  // Switching the chart's symbol touches nothing but the view: the cursor (a time),
  // the account and every book stay; the plan on the chart is for the other symbol.
  const switchSymbol = (symbol: string) => {
    if (!session || symbol === activeRef.current || !session.assets.includes(symbol)) return
    setIsPlaying(false)
    setPositionTool(null)
    setOrderDialogOpen(false)
    activeRef.current = symbol
    setActiveSymbol(symbol)
    setJournalSymbol(null)
    setLineNonce((n) => n + 1)
  }

  // The earliest the cursor may go: the discipline lock's floor, and never before the
  // session's own start (the backend refuses to save a cursor before it, so a rewind
  // past it would leave the screen and the saved session disagreeing).
  const startIndex = bars && session ? Math.min(bars.length - 1, lastIndexAtOrBefore(bars, session.start_time - 1) + 1) : 0
  startIndexRef.current = startIndex
  const minIndex = Math.max(startIndex, session?.discipline_lock && bars ? lockFloorIndex(bars, lockFloorRef.current) : 0)

  // One pill step forward/back: `stepCount` base bars, clamped to the allowed
  // range (end_date forward, the lock floor back). advanceTo runs every fill
  // check across the bars passed over.
  const stepForward = () => {
    if (!bars || lastAllowedRef.current < 0 || cursorIndexRef.current >= lastAllowedRef.current) return
    handleCursorIndexChange(nextStepIndex(bars, cursorIndexRef.current, stepSeconds, lastAllowedRef.current))
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
    handleCursorIndexChange(prevStepIndex(bars, cursorIndexRef.current, stepSeconds, minIndex))
  }

  // The chart's timeframe: the cursor and the broker are untouched; the chart reloads
  // its history for the new candle size, cut at the cursor, and keeps the camera in time
  // (ChartKL's timeframe-switch view).
  const saveSetting = (body: { chart_timeframe?: string; step_size?: string }) => {
    if (session) updateSessionSettings.mutate({ sessionId: session.id, body })
  }
  const handleChartTimeframeChange = (tf: string) => {
    if (tf === chartTf) return
    setChartTf(tf)
    setHistoryAnchor(cursorTimeRef.current)
    setHistoryBars(HISTORY_BARS)
    saveSetting({ chart_timeframe: tf })
  }
  const handleStepSizeChange = (tf: string) => {
    if (tf === stepSize) return
    setStepSize(tf)
    saveSetting({ step_size: tf })
  }

  // A view-only Go To (G5): the chart is centred on a past date; the replay cursor, the
  // broker and the saved session do not move. A date past the cursor is not revealed, so
  // it lands on the cursor; one further back than the history cap allows lands on the
  // earliest the chart can load, and says so.
  const handleGoTo = (time: number) => {
    if (!session || cursorTimeRef.current === null) return
    const cursor = cursorTimeRef.current
    if (time >= cursor) {
      klChartRef.current?.scrollToLatest()
      setToast('Go To shows what the replay has revealed: back at the cursor')
      return
    }
    const need = historyBarsFor(historyAnchor ?? cursor, time, chartTfSeconds)
    if (need.bars > historyBars) setHistoryBars(need.bars)
    if (!need.reachable) setToast(`Go To reaches back about ${MAX_HISTORY_BARS.toLocaleString()} candles on this timeframe; showing the earliest it can load`)
    setGoTo({ time, nonce: (goTo?.nonce ?? 0) + 1 })
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
    useKLDrawingStore.getState().setOverlaysForSession(session.id, activeInstrument, step.restore)
    klChartRef.current?.reloadDrawings()
    setHistoryVersion((v) => v + 1)
  }
  // G9: this session's own drawings (the shared layer is read-only and shown only when
  // switched on), and its named layouts.
  const sharedVisible = useKLDrawingStore((s) => !!s.sharedVisibleBySession[session?.id ?? ''])
  const sharedCount = useKLDrawingStore((s) => s.overlaysByInstrument[activeInstrument]?.length ?? 0)
  const savedLayouts = useKLDrawingStore((s) => s.layoutsBySession[session?.id ?? ''] ?? NO_LAYOUTS)
  const saveCurrentLayout = (name: string) => {
    if (!session) return
    const prefsNow = useIndicatorStore.getState()
    const store = useKLDrawingStore.getState()
    const layout: NamedLayout = {
      id: `layout-${crypto.randomUUID()}`,
      name,
      indicators: {
        sessionShading: prefsNow.sessionShading,
        fairValue: prefsNow.fairValue,
        newsEvents: prefsNow.newsEvents,
        vwap: prefsNow.vwap,
        ema20: prefsNow.ema20,
        ema50: prefsNow.ema50,
        atr14: prefsNow.atr14,
        volume: prefsNow.volume,
      },
      candleType: prefs.candleType,
      timeframe: chartTf,
      drawings: cloneDrawings(store.overlaysBySession[session.id] ?? {}),
      sharedVisible: !!store.sharedVisibleBySession[session.id],
    }
    store.saveLayout(session.id, layout)
  }
  const loadLayout = (id: string) => {
    if (!session) return
    const store = useKLDrawingStore.getState()
    const layout = (store.layoutsBySession[session.id] ?? []).find((l) => l.id === id)
    if (!layout) return
    useIndicatorStore.setState({ ...layout.indicators })
    prefs.setCandleType(layout.candleType as typeof prefs.candleType)
    handleChartTimeframeChange(layout.timeframe)
    store.setSessionDrawings(session.id, cloneDrawings(layout.drawings))
    store.setSharedVisible(session.id, layout.sharedVisible)
    klChartRef.current?.reloadDrawings()
  }
  const handleUndo = () => applyHistoryStep(undo(drawingHistoryRef.current))
  const handleRedo = () => applyHistoryStep(redo(drawingHistoryRef.current))

  const handleScreenshot = () => {
    const url = klChartRef.current?.captureScreenshot()
    if (!url || !session) return
    const a = document.createElement('a')
    a.href = url
    a.download = `${activeInstrument}-${fmtEtDateTime(cursorTimeRef.current ?? session.cursor_time).replace(/[: ]/g, '-')}.jpg`
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
      if (position && !createTrade.isPending) handleClosePosition(activeInstrument)
    },
    sessionCloseHalf: () => {
      if (position && position.contracts >= 2 && !createTrade.isPending) handlePartialClose(undefined, activeInstrument)
    },
    sessionNewTrade: () => openOrderDialog(),
    sessionNewMarket: () => openOrderDialog('market'),
    sessionNewLimit: () => openOrderDialog('limit'),
    sessionNewStop: () => openOrderDialog('stop'),
    sessionGranularityUp: () => handleStepSizeChange(shiftTimeframe(stepSize, 1)),
    sessionGranularityDown: () => handleStepSizeChange(shiftTimeframe(stepSize, -1)),
    sessionStep: stepForward,
    sessionStepBack: stepBack,
    sessionPlayPause: () => setIsPlaying((v) => !v),
    sessionSpeedUp: () => setSpeed((s) => stepSpeed(s, 1)),
    sessionSpeedDown: () => setSpeed((s) => stepSpeed(s, -1)),
    // G8: Tab opens the prop-rules modal (a prop session only).
    sessionPropRules: session?.account.prop_ruleset ? () => setPropRulesOpen(true) : undefined,
  })

  // A refusal notice is informational: it clears itself after a few seconds
  // (the x still dismisses it sooner).
  useEffect(() => {
    if (!orderNotice) return
    const id = window.setTimeout(() => setOrderNotice(null), 6000)
    return () => window.clearTimeout(id)
  }, [orderNotice])

  useEffect(() => {
    if (!toast) return
    const id = window.setTimeout(() => setToast(null), 4000)
    return () => window.clearTimeout(id)
  }, [toast])

  const magnifyActive = magnifyBarTime !== null && magnifierRange(magnifyBarTime, chartTfSeconds, cursorTime) !== null

  if (isLoading) {
    return <EmptyState title="Loading session…" />
  }
  if (isError || !session) {
    return <EmptyState title="Failed to load session" hint={(error as Error | undefined)?.message} />
  }

  const cursorBar = bars?.[cursorIndex]
  // Open P&L across every instrument, each marked in its own feed (one account).
  const marks: Record<string, number | undefined> = {}
  for (const symbol of symbols) {
    const at = cursorIn(symbol)
    marks[symbol] = at?.feed[at.index]?.close
  }
  const unrealizedPnl = sessionUnrealizedPnl(books, marks)
  const hasNotices = orderNotice !== null || toast !== null || banner !== null

  return (
    <div className="flex h-full w-full flex-col bg-bg">
      <SessionTopBar
        name={sessionDisplayName(session, fmtEtLongDate)}
        subtitle={session.end_date !== null ? `to ${fmtEtLongDate(session.end_date)}` : ''}
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
            chartTfSeconds > 60
              ? () => {
                  setPickingReplayStart(false)
                  setMagnifierArmed((v) => !v)
                }
              : undefined,
          replayStartBlockedReason: session.account.prop_ruleset ? PROP_REWIND_MESSAGE : undefined,
          smoothCandles: prefs.smoothCandles,
          onToggleSmoothCandles: () => prefs.setSmoothCandles(!prefs.smoothCandles),
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
          stepSize,
          onStepSizeChange: handleStepSizeChange,
          autoPlay: isPlaying,
          onToggleAutoPlay: () => setIsPlaying((v) => !v),
          cursorLabel: cursorBar ? fmtEtLongDateTime(cursorBar.time) : null,
        }}
        actions={{
          onPlaceOrder: () => openOrderDialog(),
          placeOrderDisabled: tradeBlock !== null,
          // A position tool is on the chart: Place order is the next step.
          placeOrderReady: positionTool !== null,
          placeOrderDisabledReason: tradeBlock ?? undefined,
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
        instrument={activeInstrument}
        onInstrumentChange={session.assets.length > 1 ? switchSymbol : undefined}
        holding={holdingSymbols}
        chartTimeframe={chartTf}
        onChartTimeframeChange={handleChartTimeframeChange}
        goTo={{
          // ET wall-clock bounds for the picker: nothing past the cursor.
          max: cursorTime,
          onGoTo: handleGoTo,
          onBackToCursor: () => klChartRef.current?.scrollToLatest(),
        }}
        calendar={{
          cursorTime,
          showEvents: indicatorPrefs.newsEvents,
          onShowEventsChange: () => indicatorPrefs.toggle('newsEvents'),
          windowMinutes: newsGate?.windowMinutes ?? null,
        }}
        indicatorCount={activeIndicatorCount}
        onOpenIndicators={() => setIndicatorDialogOpen(true)}
        layouts={{
          layouts: savedLayouts.map((l) => ({ id: l.id, name: l.name })),
          onSave: saveCurrentLayout,
          onLoad: loadLayout,
          onDelete: (id) => session && useKLDrawingStore.getState().deleteLayout(session.id, id),
        }}
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
        <KLDrawingToolbar
          klChartRef={klChartRef}
          drawings={klDrawings}
          sharedLayer={{
            count: sharedCount,
            visible: sharedVisible,
            onToggle: (v) => session && useKLDrawingStore.getState().setSharedVisible(session.id, v),
          }}
          armedTool={armedTool}
          positionTools={{
            onStart: startPositionTool,
            disabled: tradeBlock !== null,
            disabledReason: tradeBlock ?? undefined,
          }}
        />
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
            instrument={activeInstrument}
            timeframe={chartTf}
            from={chartHistory?.from ?? null}
            to={chartHistory?.to ?? null}
            replay={replayFeed}
            smoothCandles={prefs.smoothCandles && isPlaying}
            smoothMs={smoothDurationMs(speed)}
            goTo={goTo}
            onDetachedChange={setViewDetached}
            trades={prefs.hideTrades ? [] : chartTrades}
            selectedTrade={prefs.hideTrades ? null : openPositionRecord}
            indicators={indicators}
            sessionBands={chartBands}
            newsEvents={newsEvents}
            prefs={indicatorPrefs}
            loading={barsFetching}
            preserveViewOnWindowChange
            cursorTime={cursorTime}
            followLatestBar={followLatestBar}
            onCandleBarClick={handleCandleBarClick}
            onVisibleRangeChange={handleChartVisibleRangeChange}
            pickMode={pickingReplayStart || magnifierArmed}
            slLineColor={themeBase.warning}
            positionTool={positionToolSpec}
            onPositionToolDrawn={setPositionTool}
            onPositionToolChange={setPositionTool}
            onPositionToolRemove={() => setPositionTool(null)}
            onPositionToolInteract={() => setIsPlaying(false)}
            getPositionToolMenu={() => {
              setIsPlaying(false)
              return [
                { label: 'Place order…', onSelect: () => openOrderDialog() },
                { separator: true },
                { label: 'Delete', onSelect: () => setPositionTool(null), destructive: true },
              ]
            }}
            orderLines={orderLines}
            onOrderLineDrag={handleOrderLineDrag}
            onOrderLineClose={handleOrderLineClose}
            getOrderLineMenu={getOrderLineMenu}
            onEmptyAreaMenuOpen={() => setIsPlaying(false)}
            getEmptyAreaMenuExtraItems={handleEmptyAreaMenuItems}
            rightMarginPx={ORDER_LABEL_MARGIN_PX}
            onDrawingsChange={handleDrawingsChange}
            onDrawingArmedChange={setArmedTool}
            candleType={prefs.candleType}
            drawingScope={{ sessionId: session.id, showShared: sharedVisible }}
          />
          {/* Transient messages float over the chart's upper edge (clear of the
              volume pane and time axis) so they never shift the chart's size: why an order
              was refused, the resolved Combine, and the session-complete state. */}
          {viewDetached && (
            <button
              type="button"
              onClick={() => klChartRef.current?.scrollToLatest()}
              title="The chart is parked on a past date; the replay has not moved. Show the cursor again."
              className="absolute bottom-10 right-20 z-10 h-7 rounded bg-surface-2 px-3 text-xs text-text-muted transition-colors hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              Back to cursor
            </button>
          )}
          {hasNotices && (
            <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex flex-col items-center gap-2 px-4">
              {banner && (
                <p className="pointer-events-auto rounded bg-surface-2 px-3 py-2 text-xs text-text-muted shadow-lg" role="status">
                  {banner}
                </p>
              )}
              {toast && (
                <p className="pointer-events-auto rounded bg-surface-2 px-3 py-2 text-xs tabular-nums text-text shadow-lg" role="status">
                  {toast}
                </p>
              )}
              {orderNotice && (
                <p className="propbt-fade-in pointer-events-auto flex max-w-xl items-center gap-2 rounded bg-surface-2 py-1 pl-3 pr-1 text-xs text-text-muted shadow-lg" role="status">
                  <span>{orderNotice}</span>
                  <button
                    onClick={() => setOrderNotice(null)}
                    aria-label="Dismiss"
                    className="h-7 w-7 shrink-0 rounded text-text-muted hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                  >
                    &times;
                  </button>
                </p>
              )}
            </div>
          )}
          {propStats?.result && (propStats.result.status === 'passed' || propStats.result.status === 'failed') && outcomeDismissedFor !== session.id && !tryAgainOpen && (
            <PropOutcomeScreen
              name={sessionDisplayName(session, fmtEtLongDate)}
              result={propStats.result}
              stats={propStats}
              onTryAgain={() => setTryAgainOpen(true)}
              onAnalytics={() => selectRun(manualRunId(session.id))}
              onDismiss={() => setOutcomeDismissedFor(session.id)}
            />
          )}
          {sessionEnded && completeDismissedFor !== session.id && !(propStats?.result && propStats.result.status !== 'incomplete') && (
            <SessionCompleteCard
              name={sessionDisplayName(session, fmtEtLongDate)}
              endDate={session.end_date}
              balance={session.account.balance}
              isProp={!!session.account.prop_ruleset}
              stats={endStats}
              onAnalytics={() => selectRun(manualRunId(session.id))}
              onJournal={() => {
                setCompleteDismissedFor(session.id)
                setJournalOpen(true)
              }}
              onDismiss={() => setCompleteDismissedFor(session.id)}
            />
          )}
        </div>
        {journalOpen && (
          <Suspense fallback={null}>
            <JournalPanel
              key={journalInitialTrade ?? 'journal'}
              trades={manualTrades ?? []}
              openEntry={journalOpenEntry}
              showInstrument={session.assets.length > 1}
              sessionId={session.id}
              onUpdateOpenEntry={handleUpdateOpenEntry}
              checklistRules={session.checklist ?? []}
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

      {propRulesOpen && session.account.prop_ruleset && (
        <PropRulesModal
          sessionId={session.id}
          openPnl={unrealizedPnl}
          cursorTime={cursorTime}
          tradeCount={manualTrades?.length ?? 0}
          ended={sessionEnded}
          onOpenAnalytics={() => selectRun(manualRunId(session.id))}
          onClose={() => setPropRulesOpen(false)}
        />
      )}

      {tryAgainOpen && (
        <TryAgainDialog
          session={session}
          onClose={() => setTryAgainOpen(false)}
          onCreated={(id) => {
            setTryAgainOpen(false)
            selectSession(id)
          }}
        />
      )}

      {orderDialogOpen &&
        (() => {
          const ctx = buildOrderContext()
          if (!ctx) return null
          return (
            <PlaceOrderDialog
              ctx={ctx}
              tool={positionTool}
              initial={{ riskPct: defaultRiskPct, basis: riskBasis, autoBreakeven: armedAutoBreakeven, type: orderDialogType ?? undefined }}
              existingTags={[...new Set((manualTrades ?? []).flatMap((t) => t.tags))].sort()}
              checklistRules={session.checklist ?? []}
              capLabel={session.account.prop_ruleset ? (session.account.prop_ruleset === 'topstep_50k' ? 'Topstep' : 'prop rules') : null}
              onBasisChange={prefs.setRiskBasis}
              onSave={placeOrder}
              onDiscard={() => {
                setPositionTool(null)
                setOrderDialogOpen(false)
              }}
              onClose={() => setOrderDialogOpen(false)}
            />
          )
        })()}

      {magnifyActive && magnifyBarTime !== null && (
        <MagnifierPanel
          instrument={activeInstrument}
          timeframe={chartTf}
          tfSeconds={chartTfSeconds}
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
          positions={positionRows}
          workingOrders={workingOrderRows}
          activeInstrument={activeInstrument}
          trades={manualTrades ?? []}
          closing={createTrade.isPending}
          onClosePosition={(symbol) => void handleClosePosition(symbol)}
          onPartialClose={(symbol, qty) => void handlePartialClose(qty, symbol)}
          onBreakeven={(symbol) => handleBreakeven(symbol)}
          onCancelOrder={(symbol) => cancelWorkingOrder(symbol)}
          autoBreakeven={position ? position.autoBreakeven : armedAutoBreakeven}
          onAutoBreakevenChange={handleAutoBreakevenChange}
          trailingPoints={position ? position.trailingPoints : armedTrailingPoints}
          onTrailingPointsChange={handleTrailingPointsChange}
          onOpenTrade={openTradeInJournal}
        />
      )}

      <div className="relative">
        <SessionBottomBar
          hideTrades={prefs.hideTrades}
          onToggleHideTrades={() => prefs.setHideTrades(!prefs.hideTrades)}
          onBuy={() => enterPosition('long')}
          onSell={() => enterPosition('short')}
          tradingDisabled={tradeBlock !== null}
          disabledReason={tradeBlock ?? ""}
          quantity={{ value: quickQty, max: positionCap, onChange: handleQuantityChange }}
          scalper={{
            armed: scalper.armed,
            open: scalperOpen,
            onToggleOpen: () => setScalperOpen((v) => !v),
            popover: {
              armed: scalper.armed,
              onArmedChange: (armed) => setScalperArmed(session.id, armed),
              settings: scalper.settings,
              onChange: (patch) => patchScalper(session.id, patch),
              preview: markPrice !== null ? scalperPreview(scalper.settings, markPrice, quickQty, getContractSpec(activeInstrument)) : null,
              quantity: quickQty,
              instrument: activeInstrument,
              onClose: () => setScalperOpen(false),
            },
          }}
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
