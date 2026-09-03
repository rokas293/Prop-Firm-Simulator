// FXR_SPEC.md section 3/6, phase F2: the sim broker's fill/PnL logic --
// pure and framework-free (no React, no fetch), same "testable without
// mounting anything" discipline as chart/replay.ts and chart/tradeBracket.ts.
// SessionWorkspace calls these; the RESULT is then persisted to the backend
// for durability, but the numbers themselves are computed here, once,
// deterministically from (bars, position) -- never recomputed differently
// anywhere else (VIZ_SPEC section 0 / FXR_SPEC section 6: "the sim computes
// fills from bars deterministically; nothing is recomputed inconsistently").
//
// FILL CONVENTION (F2 -- market orders only, no limit/stop/SL/TP yet):
// a market order fills at the CLOSE of the replay cursor's current bar --
// the last fully-revealed price at the instant of the click. This app
// reveals whole bars, never partial/intrabar ticks, so the cursor bar's
// close is already fully known on screen the moment a click can happen;
// filling there is NOT a look-ahead. This deliberately differs from the
// automated engine's own t+1-open convention (CLAUDE.md section 2, propbt/
// engine/broker.py): that rule exists because THAT engine decides from a
// completed bar and must act on the NEXT one to avoid look-ahead. Here the
// decision (clicking Buy) and the fill happen at the same instant a human
// trader would act, against a price already printed -- there is no "next
// bar" to defer to without breaking the whole premise of manual replay.
import type { Bar, TradeRecord } from '../api/types'

export type Side = 'long' | 'short'

export interface ContractSpec {
  pointValue: number // $ per point
  tickSize: number
}

// Mirrors CLAUDE.md section 2's contract spec table. ZN is out of scope for
// this platform (FXR_SPEC.md section 1: "scoped to MNQ + MES").
export const CONTRACT_SPECS: Record<'MES' | 'MNQ', ContractSpec> = {
  MES: { pointValue: 5, tickSize: 0.25 },
  MNQ: { pointValue: 2, tickSize: 0.25 },
}

export function getContractSpec(instrument: string): ContractSpec {
  const spec = CONTRACT_SPECS[instrument as 'MES' | 'MNQ']
  if (!spec) throw new Error(`no contract spec for instrument ${instrument} (FXR platform is MNQ/MES only)`)
  return spec
}

export function sideSign(side: Side): 1 | -1 {
  return side === 'long' ? 1 : -1
}

export function marketFillPrice(bar: Bar): number {
  return bar.close
}

// Freezes the account's configured risk-per-trade into a dollar figure AT
// ENTRY. F2 market orders carry no price-level stop (that's F3's drag
// ticket), so this is the only "1R" basis available yet -- freezing it
// means a later balance change (from THIS trade or others) never
// retroactively changes what an already-open trade's R means.
export function riskUsdAtEntry(
  balanceAtEntry: number,
  riskPercent: number | null,
  riskUsdFixed: number | null,
): number | null {
  if (riskPercent !== null && riskPercent !== undefined) return balanceAtEntry * (riskPercent / 100)
  if (riskUsdFixed !== null && riskUsdFixed !== undefined) return riskUsdFixed
  return null
}

export function unrealizedPnl(
  side: Side,
  entryPrice: number,
  markPrice: number,
  contracts: number,
  spec: ContractSpec,
): number {
  return sideSign(side) * (markPrice - entryPrice) * spec.pointValue * contracts
}

export function toR(pnlUsd: number, riskUsd: number | null): number | null {
  if (!riskUsd) return null
  return pnlUsd / riskUsd
}

export interface MaeMfe {
  maePoints: number
  mfePoints: number
}

// Scans bars[entryIndex..exitIndexInclusive] (both ends included, matching
// propbt/reporting/run_bundle.py's own `_mae_mfe` inclusive .loc[entry_ts:
// exit_ts] window) for the worst adverse move and best favorable move
// relative to entry -- same convention an automated trade's numbers use, so
// a manual trade reads the same way.
export function computeMaeMfe(
  bars: Bar[],
  entryIndex: number,
  exitIndexInclusive: number,
  entryPrice: number,
  side: Side,
): MaeMfe {
  let lo = Infinity
  let hi = -Infinity
  for (let i = entryIndex; i <= exitIndexInclusive; i++) {
    lo = Math.min(lo, bars[i].low)
    hi = Math.max(hi, bars[i].high)
  }
  if (side === 'long') {
    return { maePoints: Math.max(0, entryPrice - lo), mfePoints: Math.max(0, hi - entryPrice) }
  }
  return { maePoints: Math.max(0, hi - entryPrice), mfePoints: Math.max(0, entryPrice - lo) }
}

export interface OpenPosition {
  side: Side
  contracts: number
  entryPrice: number
  entryTime: number
  entryIndex: number
  riskUsd: number | null
}

export interface ClosedTradeResult {
  side: Side
  contracts: number
  entryTime: number
  entryPrice: number
  exitTime: number
  exitPrice: number
  pnlUsd: number // net of commission
  commissionUsd: number
  rMultiple: number | null
  maePoints: number
  mfePoints: number
  maeR: number | null
  mfeR: number | null
  barsHeld: number
}

// Deterministic close: a pure function of (bars, position, exitIndex, spec,
// commission) -- the exact reproducibility FXR_SPEC section 3/6 requires
// ("fills must be reproducible from (bars, orders)"). Commission is charged
// ONCE, on exit -- matching propbt/engine/broker.py's own convention
// (entry fills carry commission=0.0; the exit fill's commission covers the
// whole round-turn), so a manual trade's cost model matches the automated
// engine's exactly.
export function closePosition(
  bars: Bar[],
  position: OpenPosition,
  exitIndex: number,
  spec: ContractSpec,
  commissionPerContract: number,
): ClosedTradeResult {
  const exitBar = bars[exitIndex]
  const exitPrice = marketFillPrice(exitBar)
  const grossPnl = unrealizedPnl(position.side, position.entryPrice, exitPrice, position.contracts, spec)
  const commissionUsd = commissionPerContract * position.contracts
  const pnlUsd = grossPnl - commissionUsd
  const rMultiple = toR(pnlUsd, position.riskUsd)

  const { maePoints, mfePoints } = computeMaeMfe(
    bars,
    position.entryIndex,
    exitIndex,
    position.entryPrice,
    position.side,
  )
  // risk_usd has no real SL distance behind it in F2 (see the module
  // header) -- back out an equivalent point distance so mae_r/mfe_r stay
  // on the SAME basis as r_multiple above, rather than being left null
  // while r_multiple has a value.
  const riskPointsEquivalent = position.riskUsd ? position.riskUsd / (spec.pointValue * position.contracts) : null
  const maeR = riskPointsEquivalent ? maePoints / riskPointsEquivalent : null
  const mfeR = riskPointsEquivalent ? mfePoints / riskPointsEquivalent : null

  return {
    side: position.side,
    contracts: position.contracts,
    entryTime: position.entryTime,
    entryPrice: position.entryPrice,
    exitTime: exitBar.time,
    exitPrice,
    pnlUsd,
    commissionUsd,
    rMultiple,
    maePoints,
    mfePoints,
    maeR,
    mfeR,
    barsHeld: exitIndex - position.entryIndex + 1,
  }
}

export interface OpenPositionView {
  position: OpenPosition
  instrument: string
  cursorIndex: number
  markPrice: number
  cursorTime: number
}

// Renders the currently-open position as a TradeRecord so it can flow
// through the EXACT SAME chart trade-overlay pipeline a closed automated
// trade uses (chart/kl/tradeOverlays.ts, chart/replay.ts's
// filterTradesForReplay) with zero chart-side changes -- "reuse the
// trade-overlay conventions" per the F2 prompt. exit_time is set to
// cursorTime + 1 (strictly after the cursor) specifically so
// filterTradesForReplay's own `showExit = exit_time <= cursorTime` check
// always reads false while the position is open: no real exit exists yet,
// so nothing downstream may treat this as a completed, priced trade.
// trade_id 0 is a reserved sentinel that real journaled trades (assigned
// server-side starting at 1, see app/backend/services/bt_session_service.py)
// never collide with.
export function openPositionAsTradeRecord(view: OpenPositionView): TradeRecord {
  const spec = getContractSpec(view.instrument)
  const pnlUsd = unrealizedPnl(view.position.side, view.position.entryPrice, view.markPrice, view.position.contracts, spec)
  const rMultiple = toR(pnlUsd, view.position.riskUsd)
  return {
    trade_id: 0,
    entry_time: view.position.entryTime,
    exit_time: view.cursorTime + 1,
    instrument: view.instrument,
    side: view.position.side,
    leg: null,
    session: null,
    trading_day: null,
    size_contracts: view.position.contracts,
    entry_price: view.position.entryPrice,
    exit_price: view.markPrice,
    sl_price: null,
    tp_price: null,
    sl_points: null,
    tp_points: null,
    rr_planned: null,
    exit_type: 'open',
    pnl_usd: pnlUsd,
    r_multiple: rMultiple,
    commission_usd: 0,
    mae_points: 0,
    mfe_points: 0,
    mae_r: null,
    mfe_r: null,
    bars_held: view.cursorIndex - view.position.entryIndex + 1,
  }
}
