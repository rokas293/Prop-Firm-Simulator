// FXR_V2_SPEC.md section 4 (G6): the completion state -- the result as the API gave it, and
// the three ways on.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SessionCompleteCard from './SessionCompleteCard'
import type { StatsResponse } from '../api/types'

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

const GROUP = { trades: 3, net_pnl_usd: 215, net_r: null, win_rate: 2 / 3, expectancy_usd: null, expectancy_r: null, profit_factor: null, max_drawdown_usd: 0 }
const stats = (result?: Partial<NonNullable<StatsResponse['result']>>): StatsResponse =>
  ({
    scope: 'all',
    overall: GROUP,
    by_leg: {},
    by_session: {},
    result: result
      ? { status: 'incomplete', fail_reason: null, target_hit: false, consistency_passed: null, final_balance: 50215, trading_days: 2, ...result }
      : null,
  }) as StatsResponse

function render(over: Partial<React.ComponentProps<typeof SessionCompleteCard>> = {}) {
  const props = {
    name: 'Finish line',
    endDate: 1709701199, // 2024-03-05 23:59:59 ET
    balance: 50215,
    isProp: false,
    stats: stats(),
    onAnalytics: vi.fn(),
    onJournal: vi.fn(),
    onDismiss: vi.fn(),
    ...over,
  }
  act(() => root.render(<SessionCompleteCard {...props} />))
  return props
}
const text = () => host.textContent ?? ''
const click = (name: string) => act(() => (Array.from(host.querySelectorAll('button')).find((b) => b.textContent === name) as HTMLButtonElement).click())

describe('SessionCompleteCard', () => {
  it('names the session and its end date, and shows the result', () => {
    render()
    expect(host.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Session complete')
    expect(text()).toContain('Finish line · reached its end date, 5 Mar 2024.')
    expect(text()).toContain('$215.00')
    expect(text()).toContain('$50,215.00')
    expect(text()).toContain('66.7%')
    expect(text()).not.toContain('Passed')
  })

  it('a prop session adds the engine verdict', () => {
    render({ isProp: true, stats: stats({ status: 'passed', resolved_trade_id: 3, trades_to_result: 3, resolved_time: 1709650000, final_balance: 53100 }) })
    expect(text()).toContain('Passed')
    expect(text()).toContain('Profit target reached')
  })

  it('a prop session that ended without a result says so', () => {
    render({ isProp: true, stats: stats({ status: 'incomplete' }) })
    expect(text()).toContain('Not passed')
    expect(text()).toContain('Profit target not yet reached')
  })

  it('a failed prop session says how', () => {
    render({ isProp: true, stats: stats({ status: 'failed', fail_reason: 'mll_breach', resolved_trade_id: 2, trades_to_result: 2, resolved_time: 1709650000, equity_at_result: 48400, mll_floor_at_result: 48500 }) })
    expect(text()).toContain('Failed')
    expect(text()).toContain('Trailing max loss limit breached')
  })

  it('shows a placeholder, not numbers, while the result loads', () => {
    render({ stats: undefined })
    expect(host.querySelector('[aria-label="Loading the result"]')).not.toBeNull()
    expect(text()).not.toContain('Net P&L')
  })

  it('links to Analytics and the Journal, and can be set aside', () => {
    const p = render()
    click('View analytics')
    expect(p.onAnalytics).toHaveBeenCalledOnce()
    click('Open journal')
    expect(p.onJournal).toHaveBeenCalledOnce()
    click('Review chart')
    expect(p.onDismiss).toHaveBeenCalledOnce()
  })

  it('Escape sets it aside', () => {
    const p = render()
    act(() => {
      host.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(p.onDismiss).toHaveBeenCalledOnce()
  })
})
