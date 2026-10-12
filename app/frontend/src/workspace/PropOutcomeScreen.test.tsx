// FXR_V2_SPEC.md section 6 (G8): the pass / fail screens of a prop session, and that
// "Try again" creates a session on the same rules with the chosen start.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BacktestSessionDetail, StatsResponse, StatsResult } from '../api/types'
import { etWallTimeToUnix } from '../timeFormat'

const hooks = vi.hoisted(() => ({
  mutate: null as unknown as ReturnType<typeof import('vitest').vi.fn>,
}))
vi.mock('../api/hooks', async () => {
  const { vi } = await import('vitest')
  hooks.mutate = vi.fn()
  return {
    useCreateBtSession: () => ({ mutate: hooks.mutate, isPending: false, isError: false, error: null }),
    useSessionSetupOptions: () => ({
      data: {
        ranges: { MNQ: { min: 1626393600, max: 1784159940 }, MES: { min: 1626393600, max: 1784159940 } },
        presets: [
          {
            id: 'topstep_50k',
            label: 'Topstep 50k',
            starting_balance: 50000,
            rules: {
              profit_target: 3000,
              max_loss_type: 'eod_trailing',
              max_loss: 2000,
              max_loss_locks_at_start: true,
              daily_loss_limit: 1000,
              consistency_pct: 50,
              max_contracts: 5,
              no_overnight: false,
              no_weekend: false,
              no_news: false,
              news_window_minutes: 5,
              close_time: '16:00',
            },
          },
        ],
        default_commissions: { MNQ: 1.3, MES: 1.3 },
      },
    }),
  }
})

import PropOutcomeScreen from './PropOutcomeScreen'
import TryAgainDialog from './TryAgainDialog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  hooks.mutate.mockClear()
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const text = () => host.textContent ?? ''
const button = (label: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent === label) as HTMLButtonElement

const RESULT = (over: Partial<StatsResult>): StatsResult => ({
  status: 'incomplete',
  fail_reason: null,
  target_hit: false,
  consistency_passed: null,
  final_balance: 50000,
  trading_days: 2,
  ...over,
})
const STATS: StatsResponse = {
  scope: 'all',
  overall: { trades: 6, net_pnl_usd: 3120, net_r: null, win_rate: 0.5, expectancy_usd: null, expectancy_r: null, profit_factor: 2.4, max_drawdown_usd: 0 },
  by_leg: {},
  by_session: {},
  result: null,
} as StatsResponse

describe('PropOutcomeScreen', () => {
  const handlers = () => ({ onTryAgain: vi.fn(), onAnalytics: vi.fn(), onDismiss: vi.fn() })

  it('a failed session states the cause and offers Try again and View analytics', () => {
    const h = handlers()
    const result = RESULT({
      status: 'failed',
      fail_reason: 'mll_breach',
      resolved_trade_id: 4,
      trades_to_result: 4,
      resolved_time: 1741700000,
      equity_at_result: 47950,
      mll_floor_at_result: 48000,
    })
    act(() => root.render(<PropOutcomeScreen name="March drill" result={result} stats={STATS} {...h} />))
    expect(text()).toContain('Challenge failed')
    expect(host.querySelector('[data-testid="outcome-cause"]')?.textContent).toContain('Trailing max loss limit breached')
    expect(host.querySelector('[data-testid="outcome-cause"]')?.textContent).toContain('$47,950.00')
    expect(host.querySelector('[data-testid="outcome-cause"]')?.textContent).toContain('$48,000.00')
    expect(host.querySelector('[data-testid="outcome-summary"]')).toBeNull()
    act(() => button('Try again').click())
    act(() => button('View analytics').click())
    act(() => button('Review chart').click())
    expect(h.onTryAgain).toHaveBeenCalledTimes(1)
    expect(h.onAnalytics).toHaveBeenCalledTimes(1)
    expect(h.onDismiss).toHaveBeenCalledTimes(1)
  })

  it('a passed session shows its summary card and no Try again', () => {
    const h = handlers()
    const result = RESULT({ status: 'passed', target_hit: true, consistency_passed: true, final_balance: 53120, trading_days: 5 })
    act(() => root.render(<PropOutcomeScreen name="March drill" result={result} stats={STATS} {...h} />))
    expect(text()).toContain('Challenge passed')
    const summary = host.querySelector('[data-testid="outcome-summary"]')?.textContent ?? ''
    expect(summary).toContain('$3,120.00')
    expect(summary).toContain('$53,120.00')
    expect(summary).toContain('50.0%')
    expect(summary).toContain('2.40')
    expect(button('Try again')).toBeUndefined()
    act(() => button('View analytics').click())
    expect(h.onAnalytics).toHaveBeenCalledTimes(1)
  })
})

describe('TryAgainDialog', () => {
  const START = etWallTimeToUnix('2024-03-04T09:30') as number
  const session = {
    id: 'old',
    name: 'March drill',
    instrument: 'MNQ',
    assets: ['MNQ', 'MES'],
    start_time: START,
    end_date: START + 4 * 86400,
    discipline_lock: true,
    checklist: ['Trend aligned'],
    account: {
      starting_balance: 50000,
      commission_per_contract: 1.1,
      commissions: { MNQ: 1.1, MES: 0.62 },
      prop_ruleset: 'topstep_50k',
      prop_rules: {
        profit_target: 3000,
        max_loss_type: 'eod_trailing',
        max_loss: 2000,
        max_loss_locks_at_start: true,
        daily_loss_limit: 1000,
        consistency_pct: 50,
        max_contracts: 5,
        no_overnight: false,
        no_weekend: false,
        no_news: false,
        news_window_minutes: 5,
        close_time: '16:00',
      },
    },
  } as unknown as BacktestSessionDetail

  const type = (label: string, value: string) => {
    const input = host.querySelector(`[aria-label="${label}"]`) as HTMLInputElement
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    act(() => {
      set.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  it('summarises the rules it will reuse', () => {
    act(() => root.render(<TryAgainDialog session={session} onClose={vi.fn()} onCreated={vi.fn()} />))
    const summary = host.querySelector('[data-testid="retry-summary"]')?.textContent ?? ''
    expect(summary).toContain('Same rules as before')
    expect(summary).toContain('Topstep 50k')
    expect(summary).toContain('MNQ and MES')
    expect(summary).toContain('Target $3,000')
  })

  it('a picked start creates a session with the same rules and that window', () => {
    const onCreated = vi.fn()
    act(() => root.render(<TryAgainDialog session={session} onClose={vi.fn()} onCreated={onCreated} />))
    type('Start date', '2023-01-09')
    type('End date', '2023-01-13')
    act(() => button('Start new session').click())
    expect(hooks.mutate).toHaveBeenCalledTimes(1)
    const [body, opts] = hooks.mutate.mock.calls[0]
    expect(body).toMatchObject({
      assets: ['MNQ', 'MES'],
      starting_balance: 50000,
      commissions: { MNQ: 1.1, MES: 0.62 },
      prop_ruleset: 'topstep_50k',
      discipline_lock: true,
      checklist: ['Trend aligned'],
      start_time: etWallTimeToUnix('2023-01-09T09:30'),
    })
    expect(body.prop_rules).toEqual(session.account.prop_rules)
    expect(body.random_start).toBeUndefined()
    // The created session is opened by the caller.
    opts.onSuccess({ id: 'new' })
    expect(onCreated).toHaveBeenCalledWith('new')
  })

  it('a random start sends the length and no date', () => {
    act(() => root.render(<TryAgainDialog session={session} onClose={vi.fn()} onCreated={vi.fn()} />))
    act(() => button('Random start').click())
    type('Length in days', '10')
    act(() => button('Start new session').click())
    const [body] = hooks.mutate.mock.calls[0]
    expect(body).toMatchObject({ random_start: true, start_time: null, random_duration_seconds: 10 * 86400, prop_ruleset: 'topstep_50k', starting_balance: 50000 })
    expect(body.prop_rules).toEqual(session.account.prop_rules)
  })

  it('refuses a start outside the data and says why', () => {
    act(() => root.render(<TryAgainDialog session={session} onClose={vi.fn()} onCreated={vi.fn()} />))
    type('Start date', '2019-01-02')
    expect(button('Start new session').disabled).toBe(true)
    expect(text()).toContain('before')
    act(() => button('Start new session').click())
    expect(hooks.mutate).not.toHaveBeenCalled()
  })
})
