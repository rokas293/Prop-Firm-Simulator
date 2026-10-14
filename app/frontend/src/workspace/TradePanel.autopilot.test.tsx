// G10: the Autopilot bot's open position and trades in the trade panel are labelled and
// read-only; nothing in the row can close or edit them.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManualTrade } from '../api/types'
import TradePanel, { type PositionRow } from './TradePanel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const manual: PositionRow = { instrument: 'MES', side: 'long', contracts: 2, entryPrice: 5000, slPrice: null, tpPrice: null, pnlUsd: 10, rMultiple: null }
const bot: PositionRow = { instrument: 'MNQ', side: 'short', contracts: 1, entryPrice: 20000, slPrice: 20010, tpPrice: 19985, pnlUsd: -4, rMultiple: null, bot: true }

const TRADE = (over: Partial<ManualTrade>): ManualTrade =>
  ({
    trade_id: 1,
    entry_time: 1700000000,
    exit_time: 1700000600,
    instrument: 'MNQ',
    side: 'long',
    leg: null,
    session: null,
    trading_day: null,
    size_contracts: 1,
    entry_price: 20000,
    exit_price: 20010,
    sl_price: null,
    tp_price: null,
    sl_points: null,
    tp_points: null,
    rr_planned: null,
    exit_type: 'take_profit',
    pnl_usd: 18.7,
    r_multiple: null,
    commission_usd: 1.3,
    mae_points: 0,
    mfe_points: 10,
    mae_r: null,
    mfe_r: null,
    bars_held: 10,
    session_id: 's',
    source: 'manual',
    notes: '',
    tags: [],
    setup_name: null,
    grade: null,
    screenshots: [],
    ...over,
  }) as ManualTrade

function render(tab: 'positions' | 'history', positions: PositionRow[], trades: ManualTrade[]) {
  act(() =>
    root.render(
      <TradePanel
        height={240}
        tab={tab}
        onTabChange={vi.fn()}
        positions={positions}
        workingOrders={[]}
        activeInstrument="MNQ"
        trades={trades}
        closing={false}
        onClosePosition={vi.fn()}
        onPartialClose={vi.fn()}
        onBreakeven={vi.fn()}
        onCancelOrder={vi.fn()}
        autoBreakeven={false}
        onAutoBreakevenChange={vi.fn()}
        trailingPoints={null}
        onTrailingPointsChange={vi.fn()}
        onOpenTrade={vi.fn()}
      />,
    ),
  )
}

describe('trade panel with an Autopilot bot', () => {
  it("the bot's position row is labelled and offers no close / partial / break-even", () => {
    render('positions', [manual, bot], [])
    const rows = [...host.querySelectorAll('tbody tr')]
    expect(rows).toHaveLength(2)
    const [manualRow, botRow] = rows
    expect(manualRow.textContent).toContain('Close')
    expect(botRow.textContent).toContain('Bot')
    expect(botRow.textContent).toContain('Managed by Autopilot')
    expect(botRow.textContent).not.toContain('Close')
    expect(botRow.textContent).not.toContain('Break-even')
    expect(botRow.querySelector('input')).toBeNull()
  })

  it('history chips bot trades, and marks one taken after an interruption', () => {
    render('history', [], [
      TRADE({ trade_id: 1, source: 'manual' }),
      TRADE({ trade_id: 2, source: 'bot', bot_segment: 0 }),
      TRADE({ trade_id: 3, source: 'bot', bot_segment: 1 }),
    ])
    const rows = [...host.querySelectorAll('tbody tr')]
    // newest first
    expect(rows[0].textContent).toContain('Bot · resumed')
    expect(rows[1].textContent).toContain('Bot')
    expect(rows[1].textContent).not.toContain('resumed')
    expect(rows[2].textContent).not.toContain('Bot')
  })
})
