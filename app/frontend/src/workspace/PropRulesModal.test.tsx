// FXR_V2_SPEC.md section 6 (G8): the Prop Rules modal draws exactly what the server
// (PropRulesTracker) returned. Every figure on a card is the API's, never a sum or a
// difference computed here.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PropRulesStatus } from '../api/types'

const status = vi.hoisted(() => ({ current: null as unknown, calls: [] as unknown[][] }))
vi.mock('../api/hooks', () => ({
  usePropRulesStatus: (...args: unknown[]) => {
    status.calls.push(args)
    return { data: status.current, isError: false }
  },
}))

import PropRulesModal from './PropRulesModal'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  status.calls = []
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

// The numbers are deliberately NOT consistent with each other (used + left != limit,
// fraction != used / limit): a modal that recomputed any of them would show something else.
const STATUS: PropRulesStatus = {
  status: 'incomplete',
  fail_reason: null,
  label: 'Topstep $50k Combine',
  starting_balance: 50000,
  balance: 50400,
  open_pnl: -600,
  equity: 49800,
  profit: { limit: 3000, used: 411, left: 2555, fraction: 0.137 },
  max_loss: { limit: 2000, used: 222, left: 1777, fraction: 0.111 },
  max_loss_floor: 48023,
  max_loss_type: 'eod_trailing',
  max_loss_frozen: false,
  daily_loss: { limit: 1000, used: 333, left: 666, fraction: 0.333 },
  daily_locked: false,
  day_start_balance: 50000,
  target_hit: false,
  consistency_pct: 50,
  consistency_passed: null,
  best_day_pnl: 400,
  best_day_share: 0.97,
  trading_days: 1,
  rules: [
    { key: 'profit_target', label: 'Profit target', value: '$3,000' },
    { key: 'max_loss', label: 'Max loss', value: '$2,000 · End-of-day trailing, locks at $50,000' },
    { key: 'daily_loss', label: 'Max daily loss', value: '$1,000' },
  ],
  restrictions: [
    { key: 'no_news', label: 'News trading', detail: 'No entries within 5 min of a high-impact event', on: true },
    { key: 'no_overnight', label: 'Holding overnight', detail: 'Allowed', on: false },
  ],
}

function render(over: Partial<React.ComponentProps<typeof PropRulesModal>> = {}) {
  const props = {
    sessionId: 's1',
    openPnl: -600,
    cursorTime: 1741700000,
    tradeCount: 3,
    onOpenAnalytics: vi.fn(),
    onClose: vi.fn(),
    ...over,
  }
  act(() => root.render(<PropRulesModal {...props} />))
  return props
}
const card = (title: string) => host.querySelector(`[data-testid="card-${title}"]`) as HTMLElement
const text = () => host.textContent ?? ''

describe('PropRulesModal', () => {
  it('asks for the status at the broker float, the cursor and the journal size', () => {
    status.current = STATUS
    render()
    expect(status.calls[0]).toEqual(['s1', -600, 1741700000, 3])
  })

  it('the three cards show the tracker numbers as given', () => {
    status.current = STATUS
    render()
    expect(card('Profit target').querySelector('[data-testid="used"]')?.textContent).toBe('$411.00')
    expect(card('Profit target').querySelector('[data-testid="left"]')?.textContent).toContain('$2,555.00')
    expect(card('Max loss').querySelector('[data-testid="used"]')?.textContent).toBe('$222.00')
    expect(card('Max loss').querySelector('[data-testid="left"]')?.textContent).toContain('$1,777.00')
    expect(card('Max daily loss').querySelector('[data-testid="used"]')?.textContent).toBe('$333.00')
    expect(card('Max daily loss').querySelector('[data-testid="left"]')?.textContent).toContain('$666.00')
  })

  it('each bar is drawn to the server fraction, not to used / limit', () => {
    status.current = STATUS
    render()
    const bar = (title: string) => card(title).querySelector('[role="progressbar"]') as HTMLElement
    expect((bar('Profit target').firstElementChild as HTMLElement).style.width).toBe('13.7%')
    expect((bar('Max loss').firstElementChild as HTMLElement).style.width).toBe('11.1%')
    expect((bar('Max daily loss').firstElementChild as HTMLElement).style.width).toBe('33.3%')
    expect(bar('Max loss').getAttribute('aria-valuenow')).toBe('11')
  })

  it('shows the floor, the equity line and the rules and restrictions', () => {
    status.current = STATUS
    render()
    expect(text()).toContain('Floor $48,023.00')
    expect(host.querySelector('[data-testid="equity-line"]')?.textContent).toContain('equity $49,800.00')
    expect(host.querySelector('[data-testid="equity-line"]')?.textContent).toContain('97.0% of profit, limit 50%')
    expect(text()).toContain('$2,000 · End-of-day trailing, locks at $50,000')
    const restrictions = host.querySelector('[aria-label="Restrictions"]') as HTMLElement
    expect(restrictions.textContent).toContain('News trading')
    expect(restrictions.textContent).toContain('Enforced')
    expect(restrictions.textContent).toContain('Allowed')
  })

  it('a daily loss lock and a failed verdict are stated', () => {
    status.current = { ...STATUS, daily_locked: true, status: 'failed', fail_reason: 'mll_breach' }
    render()
    expect(text()).toContain('Locked for the day')
    expect(host.querySelector('[data-testid="verdict"]')?.textContent).toContain('Max loss limit breached')
  })

  it('a rule that is off reads Off, not a zero', () => {
    status.current = { ...STATUS, daily_loss: { limit: null, used: 0, left: null, fraction: 0 } }
    render()
    expect(card('Max daily loss').textContent).toContain('Off')
  })

  it('closes from the button, Escape and the backdrop; the analytics link is offered', () => {
    status.current = STATUS
    const props = render()
    act(() => (host.querySelector('[aria-label="Close"]') as HTMLButtonElement).click())
    expect(props.onClose).toHaveBeenCalledTimes(1)
    act(() => {
      ;(host.querySelector('[role="dialog"]') as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(props.onClose).toHaveBeenCalledTimes(2)
    act(() => (host.querySelector('.propbt-cmdk-overlay') as HTMLElement).click())
    expect(props.onClose).toHaveBeenCalledTimes(3)
    const link = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Full result in Analytics') as HTMLButtonElement
    act(() => link.click())
    expect(props.onOpenAnalytics).toHaveBeenCalledTimes(1)
  })

  it('shows a skeleton while the status loads', () => {
    status.current = undefined
    render()
    expect(host.querySelector('[aria-label="Loading the rules"]')).not.toBeNull()
  })
})
