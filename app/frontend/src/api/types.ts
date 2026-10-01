// Mirrors app/backend/models.py exactly -- keep these in sync by hand for
// now (VIZ_SPEC.md section 6: "generate/maintain matching TypeScript
// types"). All times are UNIX seconds UTC.

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
}

export const MANUAL_RUN_PREFIX = 'bt:'
export const manualRunId = (sessionId: string) => `${MANUAL_RUN_PREFIX}${sessionId}`
export const manualAllRunId = (instrument: string) => `${MANUAL_RUN_PREFIX}all:${instrument}`
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
export interface SimAccount {
  id: string
  starting_balance: number
  balance: number
  currency: string
  risk_per_trade_percent: number | null
  risk_per_trade_usd: number | null
  default_contracts: number
  commission_per_contract: number
  // F6: "topstep_50k" = the Topstep Combine ruleset; null/absent = practice account.
  prop_ruleset?: string | null
  // Position limit in contracts (Topstep: 5); null/absent = uncapped.
  max_contracts?: number | null
}

// FXR_SPEC.md section B/3, phase F4: the sim broker's open position and
// working orders, persisted WITH the session (see UpdateSessionStateRequest
// below) so a mid-trade reload restores them. Deliberately no *_index
// field -- see the backend model's own comment for why only the TIME
// survives a reload, never a bars-array index.
export interface PersistedPosition {
  side: 'long' | 'short'
  contracts: number
  entry_price: number
  entry_time: number
  risk_usd: number | null
  sl_price: number | null
  tp_price: number | null
  auto_breakeven: boolean
  trailing_points: number | null
}

export interface PersistedWorkingOrder {
  id: string
  side: 'long' | 'short'
  order_type: 'limit' | 'stop'
  price: number
  contracts: number
  sl_price: number | null
  tp_price: number | null
  risk_usd: number | null
  placed_time: number
}

export interface PropStatus {
  status: 'passed' | 'failed' | 'incomplete'
  fail_reason: string | null
  resolved_trade_id: number | null
  trades_to_result: number | null
}

export interface BacktestSessionSummary {
  id: string
  instrument: string
  base_timeframe: string
  start_time: number
  created_at: string
  updated_at: string
  cursor_time: number
  status: 'active' | 'archived'
  account: SimAccount
  position: PersistedPosition | null
  working_orders: PersistedWorkingOrder[]
  // FXR_SPEC.md section C, phase F5: session-level journal notes.
  notes: string | null
  // Only on the sessions LIST, for Topstep sessions.
  prop_status?: PropStatus | null
}

export type BacktestSessionDetail = BacktestSessionSummary

export interface UpdateSessionNotesRequest {
  notes: string
}

export interface CreateSessionRequest {
  instrument: string
  base_timeframe: string
  start_time?: number | null
  random_start?: boolean
  starting_balance: number
  risk_per_trade_percent?: number | null
  risk_per_trade_usd?: number | null
  default_contracts: number
  commission_per_contract: number
  prop_ruleset?: string | null
}

// F4: every cursor update carries the FULL current broker state, never a
// partial patch -- see the backend model's own comment for why (unambiguous
// "flat" vs "unchanged"). Used standalone (cursor_time left at whatever it
// already is) by every position-changing action, not just replay steps.
export interface UpdateSessionStateRequest {
  cursor_time: number
  position?: PersistedPosition | null
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

export interface ManualTrade extends TradeRecord {
  session_id: string
  source: 'manual'
  notes: string
  tags: string[]
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
