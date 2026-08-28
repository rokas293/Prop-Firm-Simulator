// Static instrument specs for the KLineCharts engine (REDESIGN_APPROACH.md
// Phase A0' -- carried over from the original TradingView-based A0 scaffold,
// PART_A_REVISED_klinecharts.md's "A0 scaffolding carries over" note).
// Values come straight from CLAUDE.md §2's contract specs table.
import type { Period } from 'klinecharts'

export interface InstrumentSpec {
  symbol: 'MES' | 'MNQ' | 'ZN'
  description: string
  pointValueUsd: number
  tickSize: number
  tickValueUsd: number
  // TradingView-style price-step encoding (price step = minmov/pricescale),
  // kept from the original A0 scaffold and now the SOURCE for klinecharts'
  // own decimal-precision price format via pricePrecisionFromTick below,
  // per PART_A_REVISED_klinecharts.md Phase A0' step 3.
  pricescale: number
  minmov: number
}

export const INSTRUMENTS: InstrumentSpec[] = [
  {
    symbol: 'MES',
    description: 'Micro E-mini S&P 500',
    pointValueUsd: 5,
    tickSize: 0.25,
    tickValueUsd: 1.25,
    pricescale: 100,
    minmov: 25,
  },
  {
    symbol: 'MNQ',
    description: 'Micro E-mini Nasdaq-100',
    pointValueUsd: 2,
    tickSize: 0.25,
    tickValueUsd: 0.5,
    pricescale: 100,
    minmov: 25,
  },
  {
    symbol: 'ZN',
    description: '10-Year T-Note',
    pointValueUsd: 1000,
    tickSize: 1 / 64,
    tickValueUsd: 15.625,
    // 1/64 pt tick (CLAUDE.md §2). KLineCharts has no native fractional
    // bond-quote formatter (unlike TradingView's fractional pricescale) --
    // pricePrecisionFromTick derives enough decimal digits (6) to keep
    // every 1/64 increment visually distinct as a plain decimal instead.
    // A true 32nds/64ths display would need a custom formatter; out of
    // scope for A0'.
    pricescale: 64,
    minmov: 1,
  },
]

// Mirrors ChartPanel.tsx's TIMEFRAMES exactly -- the KL engine supports no
// more and no less than the lightweight-charts engine does today, so the
// two stay comparable during the migration's side-by-side period.
const TF_TO_PERIOD: Record<string, Period> = {
  '1min': { type: 'minute', span: 1 },
  '5min': { type: 'minute', span: 5 },
  '15min': { type: 'minute', span: 15 },
  '1h': { type: 'hour', span: 1 },
}

export function tfToPeriod(tf: string): Period | null {
  return TF_TO_PERIOD[tf] ?? null
}

export function findInstrument(symbol: string): InstrumentSpec | undefined {
  return INSTRUMENTS.find((i) => i.symbol === symbol)
}

// Derives the number of decimal digits needed to render a tick size
// exactly (price step = minmov/pricescale), for klinecharts' SymbolInfo.
// pricePrecision. E.g. MES/MNQ's 25/100 = 0.25 -> 2; ZN's 1/64 = 0.015625
// -> 6. Capped at 8 as a safety net against float noise that never
// resolves exactly.
export function pricePrecisionFromTick(minmov: number, pricescale: number): number {
  const tick = minmov / pricescale
  for (let digits = 0; digits <= 8; digits++) {
    const scale = 10 ** digits
    if (Math.abs(Math.round(tick * scale) / scale - tick) < 1e-9) return digits
  }
  return 8
}
