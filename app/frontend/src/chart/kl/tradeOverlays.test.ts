import { describe, expect, it } from 'vitest'
import {
  ENTRY_EXIT_GROUP,
  SL_TP_LINE_GROUP,
  ZONE_GROUP,
  buildEntryExitOverlays,
  buildSelectedTradeOverlays,
  buildTradeBracketOverlays,
} from './tradeOverlays'
import type { TradeRecord } from '../../api/types'
import type { ThemeColors } from '../../state/themeStore'
import type { ReplayTradeView } from '../replay'

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

// Non-replay mode's shape (chart/replay.ts's filterTradesForReplay
// returns exactly this for cursorTime === null) -- matches what
// ChartKL actually passes in outside of replay.
function makeView(overrides: Partial<TradeRecord> = {}): ReplayTradeView {
  const trade = makeTrade(overrides)
  return { trade, showExit: true, openSpanEnd: trade.exit_time }
}

const bars = [
  { time: 900, high: 101 },
  { time: 1000, high: 102 },
  { time: 1900, high: 108 },
]

describe('buildEntryExitOverlays', () => {
  it('creates one entry + one exit annotation per closed trade', () => {
    const overlays = buildEntryExitOverlays([makeView()], bars, null, colors)
    expect(overlays).toHaveLength(2)
    expect(overlays.every((o) => o.name === 'simpleAnnotation')).toBe(true)
    expect(overlays.every((o) => o.groupId === ENTRY_EXIT_GROUP)).toBe(true)
  })

  it('colors the entry with the accent color and a winning exit with the up color', () => {
    const [entry, exit] = buildEntryExitOverlays([makeView()], bars, null, colors)
    expect((entry.styles as { line: { color: string } }).line.color).toBe(colors.accent)
    expect((exit.styles as { line: { color: string } }).line.color).toBe(colors.up)
  })

  it('colors a losing exit with the down color', () => {
    const [, exit] = buildEntryExitOverlays([makeView({ pnl_usd: -10 })], bars, null, colors)
    expect((exit.styles as { line: { color: string } }).line.color).toBe(colors.down)
  })

  it('emphasizes only the selected trade', () => {
    const views = [makeView({ trade_id: 1 }), makeView({ trade_id: 2, entry_time: 2000, exit_time: 2900 })]
    const overlays = buildEntryExitOverlays(views, bars, 2, colors)
    const t1Entry = overlays.find((o) => o.id === 'kl-entry-1')!
    const t2Entry = overlays.find((o) => o.id === 'kl-entry-2')!
    expect((t1Entry.styles as { line: { size: number } }).line.size).toBe(1)
    expect((t2Entry.styles as { line: { size: number } }).line.size).toBe(2)
  })

  it('anchors above the bar high at or before the trade time, not the raw entry price', () => {
    const [entry] = buildEntryExitOverlays([makeView({ entry_price: 100 })], bars, null, colors)
    const anchor = entry.points![0].value as number
    expect(anchor).toBeGreaterThan(102) // bar at time 1000 has high 102
  })

  it('converts point timestamps to milliseconds -- klinecharts data is ms, TradeRecord is seconds', () => {
    const [entry, exit] = buildEntryExitOverlays([makeView({ entry_time: 1000, exit_time: 1900 })], bars, null, colors)
    expect(entry.points![0].timestamp).toBe(1000_000)
    expect(exit.points![0].timestamp).toBe(1900_000)
  })

  // Replay/no-look-ahead (Phase A4, VIZ_SPEC §0): a trade whose entry has
  // happened but whose exit hasn't (as of the replay cursor) must still
  // show its entry marker, but never its exit marker/outcome -- the whole
  // point of filterTradesForReplay's showExit flag.
  it('omits the exit marker while the trade is still open as of the cursor (showExit: false)', () => {
    const view: ReplayTradeView = { trade: makeTrade(), showExit: false, openSpanEnd: 1500 }
    const overlays = buildEntryExitOverlays([view], bars, null, colors)
    expect(overlays).toHaveLength(1)
    expect(overlays[0].id).toBe('kl-entry-1')
  })
})

describe('buildSelectedTradeOverlays', () => {
  it('returns nothing when there is no selected trade or no left edge', () => {
    expect(buildSelectedTradeOverlays(null, 900, colors)).toEqual([])
    expect(buildSelectedTradeOverlays(makeView(), null, colors)).toEqual([])
  })

  it('builds SL/TP price lines anchored at the left edge', () => {
    const overlays = buildSelectedTradeOverlays(makeView(), 900, colors)
    const slLine = overlays.find((o) => o.id === 'kl-sl-line-1')!
    const tpLine = overlays.find((o) => o.id === 'kl-tp-line-1')!
    expect(slLine.groupId).toBe(SL_TP_LINE_GROUP)
    expect(slLine.points![0]).toEqual({ timestamp: 900000, value: 95 })
    expect(tpLine.points![0]).toEqual({ timestamp: 900000, value: 110 })
    // Zones live in buildTradeBracketOverlays now, not here.
    expect(overlays.some((o) => o.groupId === ZONE_GROUP)).toBe(false)
  })

  it('omits SL/TP lines when the trade has no stop or target', () => {
    const overlays = buildSelectedTradeOverlays(makeView({ sl_price: null, tp_price: null }), 900, colors)
    expect(overlays).toHaveLength(0)
  })
})

describe('buildTradeBracketOverlays', () => {
  const wide = () => 100 // well above MIN_BRACKET_WIDTH_PX (28)
  const narrow = () => 10 // below it

  it('builds a PnL zone plus SL/TP zones for a wide, closed trade', () => {
    const overlays = buildTradeBracketOverlays([makeView()], null, 'auto', wide, colors)
    expect(overlays.map((o) => o.id).sort()).toEqual(['kl-bracket-pnl-1', 'kl-bracket-sl-1', 'kl-bracket-tp-1'])
    expect(overlays.every((o) => o.groupId === ZONE_GROUP)).toBe(true)
  })

  it('collapses to nothing when narrower than the density threshold', () => {
    const overlays = buildTradeBracketOverlays([makeView()], null, 'auto', narrow, colors)
    expect(overlays).toHaveLength(0)
  })

  it('always collapses under density "markers", even when wide', () => {
    const overlays = buildTradeBracketOverlays([makeView()], null, 'markers', wide, colors)
    expect(overlays).toHaveLength(0)
  })

  it('never collapses under density "full", even when narrow', () => {
    const overlays = buildTradeBracketOverlays([makeView()], null, 'full', narrow, colors)
    expect(overlays.length).toBeGreaterThan(0)
  })

  it('skips a trade entirely when widthPxFor returns null (off-screen)', () => {
    const overlays = buildTradeBracketOverlays([makeView()], null, 'full', () => null, colors)
    expect(overlays).toHaveLength(0)
  })

  it('thickens the border for the selected trade', () => {
    const pnlSelected = buildTradeBracketOverlays([makeView()], 1, 'full', wide, colors).find(
      (o) => o.id === 'kl-bracket-pnl-1',
    )!
    const pnlUnselected = buildTradeBracketOverlays([makeView()], 2, 'full', wide, colors).find(
      (o) => o.id === 'kl-bracket-pnl-1',
    )!
    expect((pnlSelected.styles as { rect: { borderSize: number } }).rect.borderSize).toBe(2)
    expect((pnlUnselected.styles as { rect: { borderSize: number } }).rect.borderSize).toBe(1)
  })

  // Replay/no-look-ahead (Phase A4): while a trade is still open as of the
  // cursor, its outcome (exit_price, win/loss color) isn't known yet -- the
  // PnL zone must not render, even though the SL/TP corridors (known at
  // entry) still do, growing to openSpanEnd (the cursor, not the real
  // future exit time).
  it('skips the PnL zone but still shows SL/TP zones (grown to openSpanEnd) while still open', () => {
    const view: ReplayTradeView = { trade: makeTrade(), showExit: false, openSpanEnd: 1500 }
    const overlays = buildTradeBracketOverlays([view], null, 'full', wide, colors)
    expect(overlays.some((o) => o.id === 'kl-bracket-pnl-1')).toBe(false)
    const slZone = overlays.find((o) => o.id === 'kl-bracket-sl-1')!
    expect(slZone.points![1].timestamp).toBe(1500_000) // openSpanEnd, not the real (future) exit_time
  })
})
