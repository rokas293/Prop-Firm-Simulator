// Mirrors app/backend/models.py exactly -- keep these in sync by hand for
// now (VIZ_SPEC.md section 6: "generate/maintain matching TypeScript
// types"). All times are UNIX seconds UTC.

import type { PersistedOverlay } from '../chart/kl/drawingOverlays'

export interface RunResult {
  passed: boolean
  fail_reason: string | null
  days_to_fail: number | null
}

export interface RunSummary {
  run_id: string
  created_at: string
  config_name: string
  instrument: string
  base_timeframe: string
  date_from: string
  date_to: string
  is_oos_split_date: string | null
  result: RunResult
  params_count: number
}

export interface RunMeta extends RunSummary {
  config_hash: string
  // FXR_SPEC.md phase F6: a manual session (run id "bt:<session_id>") or all
  // of one instrument's sessions ("bt:all:<INSTRUMENT>") is served through
  // the same run endpoints as an automated run -- see manualRunId() below.
  source?: 'engine' | 'manual'
  prop_ruleset?: string | null
  session_ids?: string[]
  // G7: the instruments the scope's trades are in (both, for a multi-asset session).
  instruments?: string[]
}

export const MANUAL_RUN_PREFIX = 'bt:'
export const manualRunId = (sessionId: string) => `${MANUAL_RUN_PREFIX}${sessionId}`
export const manualAllRunId = (instrument: string) => `${MANUAL_RUN_PREFIX}all:${instrument}`
// G8: every session of every instrument -- the Analytics page filters by instrument itself.
export const MANUAL_ALL_SESSIONS_RUN_ID = `${MANUAL_RUN_PREFIX}all`
export const isManualRunId = (runId: string | null): runId is string => runId !== null && runId.startsWith(MANUAL_RUN_PREFIX)

export interface TradeRecord {
  trade_id: number
  entry_time: number
  exit_time: number
  instrument: string
  side: 'long' | 'short'
  leg: string | null
  session: string | null
  trading_day: string | null
  size_contracts: number
  entry_price: number
  exit_price: number
  sl_price: number | null
  // G8: the stop at the position's fill (sl_price is the stop at close). null on trades with no stop at entry and on trades journaled before G8.
  entry_sl_price?: number | null
  entry_tp_price?: number | null
  tp_price: number | null
  sl_points: number | null
  tp_points: number | null
  rr_planned: number | null
  exit_type: string
  pnl_usd: number
  r_multiple: number | null
  commission_usd: number
  mae_points: number
  mfe_points: number
  mae_r: number | null
  mfe_r: number | null
  bars_held: number
  // Populated only on manual-run trades (FXR_SPEC section 2 schema compat).
  source?: string | null
  session_id?: string | null
  // The journal's own trade id within session_id (trade_id itself is
  // renumbered in a pooled all-sessions scope) -- links back to the journal.
  session_trade_id?: number | null
  tags?: string[] | null
  setup_name?: string | null
  grade?: string | null
}

export interface EquityPoint {
  time: number
  balance: number
  open_pnl: number
  equity: number
  // null on a manual run without a prop ruleset (no floors exist to draw).
  mll_floor: number | null
  daily_loss_floor: number | null
  target_level: number | null
  trading_day: string | null
  day_start_balance: number
  breached: boolean
  daily_locked: boolean
  drawdown_usd: number
}

export interface GroupStats {
  trades: number
  net_pnl_usd: number
  net_r: number | null
  win_rate: number | null
  expectancy_usd: number | null
  expectancy_r: number | null
  profit_factor: number | null
  max_drawdown_usd: number
}

export interface StatsResult {
  status: string
  fail_reason: string | null
  target_hit: boolean
  consistency_passed: boolean | null
  final_balance: number
  trading_days: number
  // Manual runs only (F6): how/when the Combine resolved.
  resolved_time?: number | null
  resolved_trade_id?: number | null
  trades_to_result?: number | null
  equity_at_result?: number | null
  mll_floor_at_result?: number | null
  daily_loss_lock_days?: number | null
}

export interface StatsResponse {
  scope: string
  overall: GroupStats
  by_leg: Record<string, GroupStats>
  by_session: Record<string, GroupStats>
  // Manual runs only (F6) -- the journal's own dimensions.
  by_setup?: Record<string, GroupStats>
  by_tag?: Record<string, GroupStats>
  by_grade?: Record<string, GroupStats>
  by_backtest_session?: Record<string, GroupStats>
  result: StatsResult | null
}

// Percentile keys are strings on the wire ("5", "25", "50", "75", "95").
export interface MonteCarloResponse {
  method: 'bootstrap' | 'shuffle'
  n_trades: number
  n_sims: number
  seed: number
  drawdown_budget_usd: number
  final_pnl_pct: Record<string, number>
  max_drawdown_pct: Record<string, number>
  prob_profit: number
  prob_drawdown_breach: number
  actual_final_pnl: number
  actual_max_drawdown: number
  fan: Record<string, number[]>
  actual_path: number[]
}

export interface Bar {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface DailyRiskPoint {
  trading_day: string
  min_distance_to_mll_usd: number
  min_distance_time: number
  breached: boolean
  breach_time: number | null
  daily_locked: boolean
  daily_lock_time: number | null
  trades: number
}

export interface SessionWindow {
  trading_day: string
  session: string
  start: number
  end: number
  fair_value: number | null
  fair_value_time: number | null
}

// FXR_SPEC.md section 2: manual-backtest sessions (F1). "BacktestSession"
// (not "Session") throughout, matching the backend's own naming choice to
// stay unambiguous next to SessionWindow above (a trading-session window,
// a completely different concept).
// FXR_V2_SPEC.md section 4 (G6): a prop session's rule set -- the same levels
// propbt's PropRulesTracker enforces. Optional rules are null when the account
// does not have them.
export type MaxLossType = 'static' | 'eod_trailing' | 'intraday_trailing'

export interface PropRules {
  profit_target: number
  max_loss_type: MaxLossType
  max_loss: number
  // A trailing floor stops rising once it reaches the starting balance.
  max_loss_locks_at_start: boolean
  daily_loss_limit: number | null
  // The best single day may be at most this percent of total profit.
  consistency_pct: number | null
  max_contracts: number | null
  no_overnight: boolean
  no_weekend: boolean
  // G7: no entry within `news_window_minutes` either side of a high-impact event.
  no_news: boolean
  news_window_minutes: number
  // "HH:MM" Eastern Time: when no-overnight / no-weekend flatten.
  close_time: string
}

export interface PropPreset {
  id: string
  label: string
  starting_balance: number
  rules: PropRules
}

export interface InstrumentRange {
  min: number
  max: number
}

export interface SessionSetupOptions {
  ranges: Record<string, InstrumentRange>
  presets: PropPreset[]
  default_commissions: Record<string, number>
}

export interface SessionProgress {
  fraction: number | null
  trading_days_total: number | null
  trading_days_remaining: number | null
  complete: boolean
  trades: number
  net_pnl_usd: number
  win_rate: number | null
}

export interface HomeKpis {
  trades: number
  buys: number
  sells: number
  wins: number
  win_rate: number | null
  avg_time_in_trade_seconds: number | null
}

export interface WeekdayWinRate {
  weekday: number
  label: string
  trades: number
  wins: number
  win_rate: number | null
}

export interface HomeOverview {
  kpis: HomeKpis
  weekday: WeekdayWinRate[]
}

export interface SimAccount {
  id: string
  starting_balance: number
  balance: number
  currency: string
  risk_per_trade_percent: number | null
  risk_per_trade_usd: number | null
  commission_per_contract: number
  // F6: "topstep_50k" = the Topstep Combine ruleset; null/absent = practice account.
  prop_ruleset?: string | null
  // Position limit in contracts (Topstep: 5); null/absent = uncapped.
  max_contracts?: number | null
  // G6: the concrete rules (null for a practice account); `prop_ruleset` is the
  // label: "topstep_50k" when they are that preset's, else "custom".
  prop_rules?: PropRules | null
  commissions?: Record<string, number>
}

// FXR_SPEC.md section B/3, phase F4: the sim broker's open position and
// working orders, persisted WITH the session (see UpdateSessionStateRequest
// below) so a mid-trade reload restores them. Deliberately no *_index
// field -- see the backend model's own comment for why only the TIME
// survives a reload, never a bars-array index.
export interface PersistedPosition {
  // G7: which of the session's assets (the server stamps the primary on a saved
  // v1 position; one position per asset).
  instrument?: string | null
  side: 'long' | 'short'
  contracts: number
  entry_price: number
  entry_time: number
  risk_usd: number | null
  sl_price: number | null
  entry_sl_price?: number | null
  entry_tp_price?: number | null
  tp_price: number | null
  auto_breakeven: boolean
  trailing_points: number | null
  // FXR_V2_SPEC.md 3.4 (G4): where auto break-even triggers -- a multiple of the
  // risk, or a distance in price points. Both null = the original +1R.
  breakeven_r?: number | null
  breakeven_points?: number | null
  // FXR_V2_SPEC.md 3.6/3.2 (G2): journal identity + size at entry (every exit
  // journals under trade_key and merges into one trade), and the ghost SL/TP
  // levels still waiting to be placed. Optional: v1 positions lack them.
  trade_key?: string | null
  initial_contracts?: number | null
  ghost_sl?: number | null
  ghost_tp?: number | null
  // FXR_V2_SPEC.md 3.5 (G3): what the Place Order dialog attached. They ride on
  // the position until its first exit is journaled, then land on the trade.
  tags?: string[]
  checklist?: string[]
  journal_notes?: string
}

export interface PersistedWorkingOrder {
  id: string
  instrument?: string | null
  side: 'long' | 'short'
  order_type: 'limit' | 'stop'
  price: number
  contracts: number
  sl_price: number | null
  tp_price: number | null
  risk_usd: number | null
  placed_time: number
  // G3: the dialog's per-order choices, kept while the order is working and
  // handed to the position when it fills. journal_on_fill = "Save & Journal".
  auto_breakeven?: boolean
  trailing_points?: number | null
  breakeven_r?: number | null
  breakeven_points?: number | null
  tags?: string[]
  checklist?: string[]
  journal_notes?: string
  journal_on_fill?: boolean
}

export interface PropStatus {
  status: 'passed' | 'failed' | 'incomplete'
  fail_reason: string | null
  resolved_trade_id: number | null
  trades_to_result: number | null
}

export interface BacktestSessionSummary {
  id: string
  // FXR_V2_SPEC.md section 4 (G1). Display name (null = derive one from the
  // assets + start date, see sessionDisplayName).
  name: string | null
  // Primary instrument (== assets[0]) -- the chart's symbol.
  instrument: string
  assets: string[]
  base_timeframe: string
  // G5: the chart's timeframe and how far one replay step advances, each any
  // timeframe at or above 1m. Absent on a session saved before G5 (the backend
  // fills them from base_timeframe on load, but a missing one reads the same).
  chart_timeframe?: string | null
  step_size?: string | null
  start_time: number
  // Unix seconds the cursor may not pass; null = runs to the end of the data.
  end_date: number | null
  // The Quick Buy/Sell quantity box, persisted per session.
  quick_quantity: number
  // The session's strategy rules, tick-boxes in the Place Order dialog (G3; the
  // editor is G6). Empty = none.
  checklist: string[]
  // G4: Scalper Mode's saved settings; null = never configured (the defaults).
  scalper: ScalperConfig | null
  created_at: string
  updated_at: string
  // The open time of the last 1-minute bar revealed (G5: always counted in 1m
  // bars, whatever the chart timeframe or the step size).
  cursor_time: number
  status: 'active' | 'archived'
  account: SimAccount
  // G7: at most one open position per asset; they share the one cursor and account.
  positions: PersistedPosition[]
  working_orders: PersistedWorkingOrder[]
  // FXR_SPEC.md section C, phase F5: session-level journal notes.
  notes: string | null
  // FXR_SPEC.md section F, phase F7b: the optional "no rewind past a placed
  // trade" lock, and (once a trade has been placed) the cursor time it was
  // placed at -- the earliest the cursor may ever go again.
  discipline_lock: boolean
  lock_floor_time: number | null
  // Only on the sessions LIST, for Topstep sessions.
  prop_status?: PropStatus | null
  // Only on the sessions LIST (G6): the home page's progress bar.
  progress?: SessionProgress | null
}

export type BacktestSessionDetail = BacktestSessionSummary

export interface UpdateSessionNotesRequest {
  notes: string
}

// FXR_V2_SPEC.md 3.4 (G4): Scalper Mode's preset distances and armed state,
// saved with the session (the wire form of chart/scalper.ts's ScalperSettings).
export interface ScalperConfig {
  armed: boolean
  sl_on: boolean
  sl_value: number
  sl_unit: 'ticks' | 'percent' | 'usd'
  tp_on: boolean
  tp_value: number
  tp_unit: 'ticks' | 'percent' | 'r'
  be_on: boolean
  be_mode: 'r' | 'ticks'
  be_value: number
}

// Only the fields sent change (the backend applies exclude_unset).
export interface UpdateSessionSettingsRequest {
  name?: string | null
  quick_quantity?: number
  checklist?: string[]
  scalper?: ScalperConfig | null
  chart_timeframe?: string
  step_size?: string
}

// G9b: drawings, named layouts and style templates, persisted with the session
// (the wire form of state/klDrawingStore.ts; the mapping is state/drawingsWire.ts).
export interface WireLayout {
  id: string
  name: string
  indicators: {
    session_shading: boolean
    fair_value: boolean
    news_events: boolean
    vwap: boolean
    ema20: boolean
    ema50: boolean
    atr14: boolean
    volume: boolean
  }
  candle_type: string
  timeframe: string
  drawings: Record<string, PersistedOverlay[]>
  shared_visible: boolean
}

export interface WireStyleTemplate {
  id: string
  name: string
  color: string
  width: number
}

export interface SessionDrawingsDoc {
  drawings: Record<string, PersistedOverlay[]>
  layouts: WireLayout[]
  shared_visible: boolean
  imported_from_browser: boolean
}

// Only the fields sent change; `drawings` replaces the listed instruments' sets.
export interface UpdateSessionDrawingsRequest {
  drawings?: Record<string, PersistedOverlay[]>
  layouts?: WireLayout[]
  shared_visible?: boolean
}

export interface WorkspaceDrawingsDoc {
  shared: Record<string, PersistedOverlay[]>
  style_templates: WireStyleTemplate[]
  new_drawing_template_id: string | null
  imported_from_browser: boolean
}

export interface UpdateWorkspaceDrawingsRequest {
  shared?: Record<string, PersistedOverlay[]>
  style_templates?: WireStyleTemplate[]
  new_drawing_template_id?: string | null
}

export interface BrowserDrawingsImport {
  shared: Record<string, PersistedOverlay[]>
  style_templates: WireStyleTemplate[]
  new_drawing_template_id: string | null
  sessions: Record<string, { drawings: Record<string, PersistedOverlay[]>; layouts: WireLayout[]; shared_visible: boolean }>
}

export interface BrowserDrawingsImportResult {
  sessions_imported: string[]
  sessions_missing: string[]
  workspace_imported: boolean
}

export interface CreateSessionRequest {
  instrument?: string | null
  assets?: string[] | null
  name?: string | null
  base_timeframe: string
  // G5: default to base_timeframe.
  chart_timeframe?: string
  step_size?: string
  start_time?: number | null
  end_date?: number | null
  random_start?: boolean
  // G6: with random_start, how long the session runs from the (server-picked) start.
  random_duration_seconds?: number | null
  starting_balance: number
  risk_per_trade_percent?: number | null
  risk_per_trade_usd?: number | null
  quick_quantity?: number
  commission_per_contract: number
  commissions?: Record<string, number> | null
  prop_ruleset?: string | null
  prop_rules?: PropRules | null
  discipline_lock?: boolean
  checklist?: string[]
}

// F4: every cursor update carries the FULL current broker state, never a
// partial patch -- see the backend model's own comment for why (unambiguous
// "flat" vs "unchanged"). Used standalone (cursor_time left at whatever it
// already is) by every position-changing action, not just replay steps.
export interface UpdateSessionStateRequest {
  cursor_time: number
  positions?: PersistedPosition[]
  working_orders?: PersistedWorkingOrder[]
}

// FXR_SPEC.md section 2/6, phase F2: a journaled manual trade -- the exact
// same field set as TradeRecord above (schema-compatible per spec), plus
// session_id/source. ManualTrade structurally satisfies TradeRecord (a
// superset of its fields), so it can be passed anywhere a TradeRecord[] is
// expected (ChartKL's `trades` prop) with no adapter.
// FXR_SPEC.md section C, phase F5: a screenshot captured against a
// journaled trade. `url` points at the backend's own file-serving endpoint
// (GET .../screenshots/{filename}) -- the image bytes are never embedded
// here (mirrors app/backend/models.py's Screenshot exactly; see its own
// comment for why trades.json only ever holds this lightweight reference).
export interface JournalScreenshot {
  id: string
  caption: string | null
  moment: 'entry' | 'exit' | 'custom'
  url: string
  created_at: string
}

// One exit of a (possibly partially closed) trade -- FXR_V2_SPEC.md 3.6.
export interface TradeExit {
  time: number
  price: number
  contracts: number
  pnl_usd: number
  commission_usd: number
  exit_type: string
  risk_usd: number | null
  mae_points?: number | null
}

export interface ManualTrade extends TradeRecord {
  session_id: string
  source: 'manual'
  trade_key?: string | null
  // Empty for a trade journaled before G2 (one implicit exit).
  exits?: TradeExit[]
  notes: string
  tags: string[]
  // The checklist rules that were ticked in the Place Order dialog (G3).
  checklist?: string[]
  setup_name: string | null
  grade: 'A' | 'B' | 'C' | null
  screenshots: JournalScreenshot[]
}

export interface UpdateTradeJournalRequest {
  notes?: string
  tags?: string[]
  setup_name?: string | null
  grade?: 'A' | 'B' | 'C' | null
}

// A data URL (klinecharts' getConvertPictureUrl output) -- decoded and
// written to its own file server-side; see add_trade_screenshot's comment.
export interface AddScreenshotRequest {
  data_url: string
  moment: 'entry' | 'exit' | 'custom'
  caption?: string | null
}

export interface CreateManualTradeRequest {
  entry_time: number
  exit_time: number
  instrument: string
  side: 'long' | 'short'
  leg: string | null
  session: string | null
  trading_day: string | null
  size_contracts: number
  entry_price: number
  exit_price: number
  sl_price: number | null
  entry_sl_price?: number | null
  entry_tp_price?: number | null
  tp_price: number | null
  sl_points: number | null
  tp_points: number | null
  rr_planned: number | null
  exit_type: string
  pnl_usd: number
  r_multiple: number | null
  commission_usd: number
  mae_points: number
  mfe_points: number
  mae_r: number | null
  mfe_r: number | null
  bars_held: number
  // Partial exits (3.6): this request is ONE exit; a matching trade_key merges
  // it into the trade already journaled for that position.
  trade_key?: string | null
  initial_contracts?: number | null
  risk_usd?: number | null
  // G3: the dialog's tags / ticked rules / journal draft, applied when this
  // request creates the trade.
  tags?: string[]
  checklist?: string[]
  notes?: string
}

export interface RecordTradeResponse {
  trade: ManualTrade
  session: BacktestSessionDetail
}

export interface IndicatorPoint {
  time: number
  value: number
}

export type IndicatorName = 'vwap' | 'ema20' | 'ema50' | 'atr14'

export type IndicatorResponse = Partial<Record<IndicatorName, IndicatorPoint[]>>

export interface AiStatusResponse {
  available: boolean
}

export interface SummarizeResponse {
  summary: string
}

// FXR_V2_SPEC.md section 6 (G7): the economic calendar -- the SCHEDULE only (when,
// which event, how important). The file carries nothing about an outcome.
export interface NewsEvent {
  time: number
  event: string
  impact: string
}


// --- FXR_V2_SPEC.md section 6 (G8): the Analytics page and the prop-rules modal.
// Mirrors models.py; every number is computed server-side.

export interface RrRow {
  n: number | null
  trades: number
  wins: number
  win_rate: number | null
  net_pnl_usd: number
  profit_factor: number | null
  avg_drawdown_usd: number | null
  avg_drawdown_r: number | null
}

export interface RrSimulatorResponse {
  scope: string
  instrument: string | null
  total_trades: number
  qualified: number
  excluded: Record<string, number>
  min_trades: number
  enough: boolean
  rows: RrRow[]
  actual: RrRow | null
}

export interface PeriodAverage {
  value: number | null
  periods: number
}

export interface AnalyticsStats {
  trades: number
  wins: number
  losses: number
  win_rate: number | null
  net_pnl_usd: number
  gross_profit_usd: number
  gross_loss_usd: number
  profit_factor: number | null
  avg_win_usd: number | null
  avg_loss_usd: number | null
  avg_r: number | null
  r_trades: number
  avg_planned_rr: number | null
  planned_rr_trades: number
  avg_gain_month: PeriodAverage
  avg_gain_week: PeriodAverage
  avg_gain_day: PeriodAverage
}

export interface PeriodBucket {
  key: string
  label: string
  trades: number
  wins: number
  net_pnl_usd: number
  win_rate: number | null
}

export interface AnalyticsSummary {
  run_id: string
  instrument: string | null
  instruments: string[]
  sessions: { id: string; name: string; assets: string[] }[]
  starting_balance: number | null
  stats: AnalyticsStats
  equity: { time: number; pnl_usd: number }[]
  monthly: PeriodBucket[]
  weekday: PeriodBucket[]
  heat: { sample: number; avg_r: number | null; max_r: number | null; min_r: number | null }
}

export interface PropProgress {
  limit: number | null
  used: number
  left: number | null
  fraction: number
}

export interface PropRulesStatus {
  status: 'passed' | 'failed' | 'incomplete'
  fail_reason: string | null
  label: string
  starting_balance: number
  balance: number
  open_pnl: number
  equity: number
  profit: PropProgress
  max_loss: PropProgress
  max_loss_floor: number
  max_loss_type: string
  max_loss_frozen: boolean
  daily_loss: PropProgress
  daily_locked: boolean
  day_start_balance: number
  target_hit: boolean
  consistency_pct: number | null
  consistency_passed: boolean | null
  best_day_pnl: number | null
  best_day_share: number | null
  trading_days: number
  rules: { key: string; label: string; value: string }[]
  restrictions: { key: string; label: string; detail: string; on: boolean }[]
}
