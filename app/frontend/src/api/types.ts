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

export interface SessionWindow {
  trading_day: string
  session: string
  start: number
  end: number
  fair_value: number | null
  fair_value_time: number | null
}
