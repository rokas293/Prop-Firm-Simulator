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
}

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
}

export interface EquityPoint {
  time: number
  balance: number
  open_pnl: number
  equity: number
  mll_floor: number
  daily_loss_floor: number
  target_level: number
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
}

export interface StatsResponse {
  scope: string
  overall: GroupStats
  by_leg: Record<string, GroupStats>
  by_session: Record<string, GroupStats>
  result: StatsResult | null
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
