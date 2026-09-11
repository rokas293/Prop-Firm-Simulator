import { describe, expect, it, vi } from 'vitest'
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

const colors: ThemeColors = { accent: '#58a6ff', positive: '#3fb950', negative: '#f85149', upCandle: '#3fb950', downCandle: '#f85149' }

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

interface MarkerExtendData {
  direction: 'up' | 'down'
  color: string
  label?: string
}

function markerData(overlay: { extendData?: unknown }): MarkerExtendData {
  return overlay.extendData as MarkerExtendData
}

describe('buildEntryExitOverlays', () => {
  it('creates one entry + one exit marker per closed trade, each a single point at the ACTUAL fill price', () => {
    const overlays = buildEntryExitOverlays([makeView()], null, colors)
    expect(overlays).toHaveLength(2)
    expect(overlays.every((o) => o.name === 'klTradeMarker')).toBe(true)
    expect(overlays.every((o) => o.groupId === ENTRY_EXIT_GROUP)).toBe(true)
    const [entry, exit] = overlays
    expect(entry.points).toEqual([{ timestamp: 1000_000, value: 100 }]) // entry_price, not a padded bar high
    expect(exit.points).toEqual([{ timestamp: 1900_000, value: 105 }]) // exit_price
  })

  it('points a long entry up (buy) and colors it with the accent color', () => {
    const [entry] = buildEntryExitOverlays([makeView({ side: 'long' })], null, colors)
    const data = markerData(entry)
    expect(data.direction).toBe('up')
    expect(data.color).toBe(colors.accent)
  })

  it('points a short entry down (sell), still colored with the accent color', () => {
    const [entry] = buildEntryExitOverlays([makeView({ side: 'short' })], null, colors)
    expect(markerData(entry).direction).toBe('down')
    expect(markerData(entry).color).toBe(colors.accent)
  })

  it('points a long exit down (sell-to-close) -- the opposite action of its up entry', () => {
    const [, exit] = buildEntryExitOverlays([makeView({ side: 'long' })], null, colors)
    expect(markerData(exit).direction).toBe('down')
  })

  it('points a short exit up (buy-to-cover) -- the opposite action of its down entry', () => {
    const [, exit] = buildEntryExitOverlays([makeView({ side: 'short' })], null, colors)
    expect(markerData(exit).direction).toBe('up')
  })

  it('colors a winning exit with the positive color and a losing exit with the negative color', () => {
    const [, winExit] = buildEntryExitOverlays([makeView({ pnl_usd: 25 })], null, colors)
    expect(markerData(winExit).color).toBe(colors.positive)
    const [, lossExit] = buildEntryExitOverlays([makeView({ pnl_usd: -10 })], null, colors)
    expect(markerData(lossExit).color).toBe(colors.negative)
  })

  it('gives no inline label to a non-selected trade\'s markers', () => {
    const [entry, exit] = buildEntryExitOverlays([makeView()], 999, colors)
    expect(markerData(entry).label).toBeUndefined()
    expect(markerData(exit).label).toBeUndefined()
  })

  it('gives the selected trade a compact inline label: entry price on entry, R multiple on exit', () => {
    const [entry, exit] = buildEntryExitOverlays([makeView({ trade_id: 7, entry_price: 4523.25, r_multiple: 1.5 })], 7, colors)
    expect(markerData(entry).label).toBe('4523.25')
    expect(markerData(exit).label).toBe('+1.50R')
  })

  it('falls back to a dollar PnL label when r_multiple is unavailable', () => {
    const [, exit] = buildEntryExitOverlays([makeView({ trade_id: 7, r_multiple: null, pnl_usd: -42 })], 7, colors)
    expect(markerData(exit).label).toBe('-$42')
  })

  it('converts point timestamps to milliseconds -- klinecharts data is ms, TradeRecord is seconds', () => {
    const [entry, exit] = buildEntryExitOverlays([makeView({ entry_time: 1000, exit_time: 1900 })], null, colors)
    expect(entry.points![0].timestamp).toBe(1000_000)
    expect(exit.points![0].timestamp).toBe(1900_000)
  })

  // Replay/no-look-ahead (Phase A4, VIZ_SPEC §0): a trade whose entry has
  // happened but whose exit hasn't (as of the replay cursor) must still
  // show its entry marker, but never its exit marker/outcome -- the whole
  // point of filterTradesForReplay's showExit flag.
  it('omits the exit marker while the trade is still open as of the cursor (showExit: false)', () => {
    const view: ReplayTradeView = { trade: makeTrade(), showExit: false, openSpanEnd: 1500 }
    const overlays = buildEntryExitOverlays([view], null, colors)
    expect(overlays).toHaveLength(1)
    expect(overlays[0].id).toBe('kl-entry-1')
  })
})

describe('buildSelectedTradeOverlays', () => {
  it('returns nothing when there is no selected trade', () => {
    expect(buildSelectedTradeOverlays(null, colors)).toEqual([])
  })

  it('builds SL/TP levels spanning only the trade\'s own time range (entry_time -> its own close), not the whole chart', () => {
    const overlays = buildSelectedTradeOverlays(makeView(), colors)
    const slLine = overlays.find((o) => o.id === 'kl-sl-line-1')!
    const tpLine = overlays.find((o) => o.id === 'kl-tp-line-1')!
    expect(slLine.name).toBe('horizontalSegment')
    expect(slLine.groupId).toBe(SL_TP_LINE_GROUP)
    expect(slLine.points).toEqual([
      { timestamp: 1000_000, value: 95 },
      { timestamp: 1900_000, value: 95 }, // openSpanEnd -- the trade's own close, not an infinite line
    ])
    expect(tpLine.points).toEqual([
      { timestamp: 1000_000, value: 110 },
      { timestamp: 1900_000, value: 110 },
    ])
    // Zones live in buildTradeBracketOverlays now, not here.
    expect(overlays.some((o) => o.groupId === ZONE_GROUP)).toBe(false)
  })

  it('grows the SL/TP span to openSpanEnd (the replay cursor), not the real future exit, while still open', () => {
    const view: ReplayTradeView = { trade: makeTrade(), showExit: false, openSpanEnd: 1500 }
    const overlays = buildSelectedTradeOverlays(view, colors)
    const slLine = overlays.find((o) => o.id === 'kl-sl-line-1')!
    expect(slLine.points![1].timestamp).toBe(1500_000)
  })

  it('omits SL/TP lines when the trade has no stop or target', () => {
    const overlays = buildSelectedTradeOverlays(makeView({ sl_price: null, tp_price: null }), colors)
    expect(overlays).toHaveLength(0)
  })

  it('defaults the SL line to colors.negative -- the automated-backtest view keeps its own established color', () => {
    const [slLine, tpLine] = buildSelectedTradeOverlays(makeView(), colors)
    expect((slLine.styles as { line: { color: string } }).line.color).toBe(colors.negative)
    expect((tpLine.styles as { line: { color: string } }).line.color).toBe(colors.positive)
  })

  it('accepts an SL color override -- FXR_SPEC.md phase F3\'s manual-session orange convention', () => {
    // The real caller (SessionWorkspace) passes ThemeBase's warning token
    // (the orange used elsewhere for warnings) -- this override is just a
    // plain string, so a literal stands in for it here.
    const orange = '#d29922'
    const [slLine, tpLine] = buildSelectedTradeOverlays(makeView(), colors, orange)
    expect((slLine.styles as { line: { color: string } }).line.color).toBe(orange)
    // TP is untouched by the override -- only SL's color is FXR_SPEC's
    // documented exception.
    expect((tpLine.styles as { line: { color: string } }).line.color).toBe(colors.positive)
  })

  // klinecharts' built-in horizontalSegment uses the interactive `line`
  // figure, whose DEFAULT right-click behavior is to delete the overlay
  // outright unless onRightClick calls preventDefault -- without this, a
  // stray right-click on a stop/target line would silently delete it.
  it('suppresses klinecharts\' default right-click-deletes-the-overlay behavior on both SL and TP lines', () => {
    const [slLine, tpLine] = buildSelectedTradeOverlays(makeView(), colors)
    const preventDefaultSl = vi.fn()
    const preventDefaultTp = vi.fn()
    slLine.onRightClick?.({ preventDefault: preventDefaultSl } as never)
    tpLine.onRightClick?.({ preventDefault: preventDefaultTp } as never)
    expect(preventDefaultSl).toHaveBeenCalledOnce()
    expect(preventDefaultTp).toHaveBeenCalledOnce()
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

  it('keeps the PnL zone quiet (a low fill alpha) so the entry/exit markers read as the primary signal', () => {
    const pnl = buildTradeBracketOverlays([makeView()], null, 'full', wide, colors).find(
      (o) => o.id === 'kl-bracket-pnl-1',
    )!
    const rectStyle = (pnl.styles as { rect: { color: string; borderColor: string } }).rect
    // hexToRgba(colors.positive, 0.1) / (colors.positive, 0.55)
    expect(rectStyle.color).toContain('0.1)')
    expect(rectStyle.borderColor).toContain('0.55)')
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
