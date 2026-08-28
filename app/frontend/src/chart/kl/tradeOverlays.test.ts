import { describe, expect, it } from 'vitest'
import {
  ENTRY_EXIT_GROUP,
  SL_TP_LINE_GROUP,
  ZONE_GROUP,
  buildEntryExitOverlays,
  buildSelectedTradeOverlays,
} from './tradeOverlays'
import type { TradeRecord } from '../../api/types'
import type { ThemeColors } from '../../state/themeStore'

const colors: ThemeColors = { accent: '#58a6ff', up: '#3fb950', down: '#f85149' }

function makeTrade(overrides: Partial<TradeRecord> = {}): TradeRecord {
  return {
    trade_id: 1,
    entry_time: 1000,
    exit_time: 1900,
    instrument: 'MNQ',
    side: 'long',
    leg: 'continuation',
    session: 'ny',
    trading_day: '2024-01-01',
    size_contracts: 1,
    entry_price: 100,
    exit_price: 105,
    sl_price: 95,
    tp_price: 110,
    sl_points: 5,
    tp_points: 10,
    rr_planned: 2,
    exit_type: 'tp',
    pnl_usd: 25,
    r_multiple: 1,
    commission_usd: 1,
    mae_points: 1,
    mfe_points: 6,
    mae_r: 0.2,
    mfe_r: 1.2,
    bars_held: 3,
    ...overrides,
  }
}

const bars = [
  { time: 900, high: 101 },
  { time: 1000, high: 102 },
  { time: 1900, high: 108 },
]

describe('buildEntryExitOverlays', () => {
  it('creates one entry + one exit annotation per closed trade', () => {
    const overlays = buildEntryExitOverlays([makeTrade()], bars, null, colors)
    expect(overlays).toHaveLength(2)
    expect(overlays.every((o) => o.name === 'simpleAnnotation')).toBe(true)
    expect(overlays.every((o) => o.groupId === ENTRY_EXIT_GROUP)).toBe(true)
  })

  it('colors the entry with the accent color and a winning exit with the up color', () => {
    const [entry, exit] = buildEntryExitOverlays([makeTrade()], bars, null, colors)
    expect((entry.styles as { line: { color: string } }).line.color).toBe(colors.accent)
    expect((exit.styles as { line: { color: string } }).line.color).toBe(colors.up)
  })

  it('colors a losing exit with the down color', () => {
    const [, exit] = buildEntryExitOverlays([makeTrade({ pnl_usd: -10 })], bars, null, colors)
    expect((exit.styles as { line: { color: string } }).line.color).toBe(colors.down)
  })

  it('emphasizes only the selected trade', () => {
    const trades = [makeTrade({ trade_id: 1 }), makeTrade({ trade_id: 2, entry_time: 2000, exit_time: 2900 })]
    const overlays = buildEntryExitOverlays(trades, bars, 2, colors)
    const t1Entry = overlays.find((o) => o.id === 'kl-entry-1')!
    const t2Entry = overlays.find((o) => o.id === 'kl-entry-2')!
    expect((t1Entry.styles as { line: { size: number } }).line.size).toBe(1)
    expect((t2Entry.styles as { line: { size: number } }).line.size).toBe(2)
  })

  it('anchors above the bar high at or before the trade time, not the raw entry price', () => {
    const [entry] = buildEntryExitOverlays([makeTrade({ entry_price: 100 })], bars, null, colors)
    const anchor = entry.points![0].value as number
    expect(anchor).toBeGreaterThan(102) // bar at time 1000 has high 102
  })

  it('converts point timestamps to milliseconds -- klinecharts data is ms, TradeRecord is seconds', () => {
    const [entry, exit] = buildEntryExitOverlays([makeTrade({ entry_time: 1000, exit_time: 1900 })], bars, null, colors)
    expect(entry.points![0].timestamp).toBe(1000_000)
    expect(exit.points![0].timestamp).toBe(1900_000)
  })
})

describe('buildSelectedTradeOverlays', () => {
  it('returns nothing when there is no selected trade or no left edge', () => {
    expect(buildSelectedTradeOverlays(null, 900, colors)).toEqual([])
    expect(buildSelectedTradeOverlays(makeTrade(), null, colors)).toEqual([])
  })

  it('builds SL/TP price lines anchored at the left edge, plus PnL/SL/TP zones', () => {
    const overlays = buildSelectedTradeOverlays(makeTrade(), 900, colors)
    const slLine = overlays.find((o) => o.id === 'kl-sl-line-1')!
    const tpLine = overlays.find((o) => o.id === 'kl-tp-line-1')!
    expect(slLine.groupId).toBe(SL_TP_LINE_GROUP)
    expect(slLine.points![0]).toEqual({ timestamp: 900000, value: 95 })
    expect(tpLine.points![0]).toEqual({ timestamp: 900000, value: 110 })

    const zones = overlays.filter((o) => o.groupId === ZONE_GROUP)
    expect(zones.map((z) => z.id).sort()).toEqual(['kl-pnl-zone-1', 'kl-sl-zone-1', 'kl-tp-zone-1'])
  })

  it('omits SL/TP lines and zones when the trade has no stop or target', () => {
    const overlays = buildSelectedTradeOverlays(makeTrade({ sl_price: null, tp_price: null }), 900, colors)
    expect(overlays.some((o) => o.id?.includes('sl'))).toBe(false)
    expect(overlays.some((o) => o.id?.includes('tp'))).toBe(false)
    expect(overlays.some((o) => o.id === 'kl-pnl-zone-1')).toBe(true)
  })
})
