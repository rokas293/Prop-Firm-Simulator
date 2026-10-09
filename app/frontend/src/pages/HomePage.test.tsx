// FXR_V2_SPEC.md section 4 (G6): the home page's cards as rendered -- what each
// one shows for the API's numbers, and that the session card's buttons do what they say.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionCard, TimeInTradeCard, TradesTakenCard, WeekdayChart, WinRateCard } from './HomePage'
import { useUiStore } from '../state/uiStore'
import type { BacktestSessionSummary, HomeKpis, SessionProgress, WeekdayWinRate } from '../api/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  useUiStore.setState({ selectedSessionId: null, selectedRunId: null })
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const KPIS: HomeKpis = { trades: 8, buys: 5, sells: 3, wins: 3, win_rate: 0.375, avg_time_in_trade_seconds: 750 }
const EMPTY: HomeKpis = { trades: 0, buys: 0, sells: 0, wins: 0, win_rate: null, avg_time_in_trade_seconds: null }
const text = () => host.textContent ?? ''

describe('KPI cards', () => {
  it('trades taken: the count and the buy/sell split', () => {
    act(() => root.render(<TradesTakenCard kpis={KPIS} />))
    expect(text()).toContain('Trades taken')
    expect(text()).toContain('8')
    expect(text()).toContain('5 buys (62.5%)')
    expect(text()).toContain('3 sells (37.5%)')
    expect(host.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('62.5% buys, 37.5% sells')
  })

  it('win rate and time in trade', () => {
    act(() => root.render(<><WinRateCard kpis={KPIS} /><TimeInTradeCard kpis={KPIS} /></>))
    expect(text()).toContain('37.5%')
    expect(text()).toContain('3 of 8 trades won')
    expect(text()).toContain('12m') // 750 s
  })

  it('say so plainly when there are no trades', () => {
    act(() => root.render(<><TradesTakenCard kpis={EMPTY} /><WinRateCard kpis={EMPTY} /><TimeInTradeCard kpis={EMPTY} /></>))
    expect(text().match(/No trades yet/g)).toHaveLength(3)
    expect(text()).toContain('-') // the dashes for the absent rates
  })
})

describe('WeekdayChart', () => {
  const DAYS: WeekdayWinRate[] = [
    { weekday: 0, label: 'Mon', trades: 4, wins: 3, win_rate: 0.75 },
    { weekday: 1, label: 'Tue', trades: 2, wins: 0, win_rate: 0 },
    { weekday: 2, label: 'Wed', trades: 0, wins: 0, win_rate: null },
    { weekday: 3, label: 'Thu', trades: 1, wins: 1, win_rate: 1 },
    { weekday: 4, label: 'Fri', trades: 1, wins: 0, win_rate: 0 },
  ]

  it('draws a bar per weekday that has trades, sized to its win rate', () => {
    act(() => root.render(<WeekdayChart days={DAYS} />))
    const mon = host.querySelector('[aria-label="Mon 75.0%"]') as HTMLElement
    expect(mon.style.height).toBe('75%')
    expect((host.querySelector('[aria-label="Thu 100.0%"]') as HTMLElement).style.height).toBe('100%')
    expect(host.querySelector('[aria-label^="Wed"]')).toBeNull() // no trades, no bar
    expect(text()).toContain('4 trades')
    expect(text()).toContain('1 trade')
    expect(host.querySelector('[title="Mon: 75.0% (3 of 4)"]')).not.toBeNull()
  })

  it('is one quiet line before any trade', () => {
    act(() => root.render(<WeekdayChart days={DAYS.map((d) => ({ ...d, trades: 0, wins: 0, win_rate: null }))} />))
    expect(text()).toContain('Trades you take will show their win rate')
    expect(host.querySelector('[role="list"]')).toBeNull()
  })
})

const progress = (over: Partial<SessionProgress> = {}): SessionProgress => ({
  fraction: 0.4,
  trading_days_total: 5,
  trading_days_remaining: 3,
  complete: false,
  trades: 6,
  net_pnl_usd: 215,
  win_rate: 0.5,
  ...over,
})

const SESSION: BacktestSessionSummary = {
  id: 's1',
  name: 'Custom prop NQ',
  instrument: 'MNQ',
  assets: ['MNQ'],
  base_timeframe: '5min',
  start_time: 1709562600, // 2024-03-04 09:30 ET
  end_date: 1710215999, // 2024-03-11 23:59:59 ET
  quick_quantity: 1,
  checklist: ['Wait for the sweep'],
  scalper: null,
  created_at: '2026-10-07T00:00:00Z',
  updated_at: '2026-10-07T00:00:00Z',
  cursor_time: 1709640000,
  status: 'active',
  account: {
    id: 'a',
    starting_balance: 50000,
    balance: 50215,
    currency: 'USD',
    risk_per_trade_percent: 1,
    risk_per_trade_usd: null,
    commission_per_contract: 0.62,
    prop_ruleset: 'custom',
    max_contracts: 5,
    prop_rules: {
      profit_target: 2500,
      max_loss_type: 'intraday_trailing',
      max_loss: 1500,
      max_loss_locks_at_start: true,
      daily_loss_limit: 600,
      consistency_pct: null,
      max_contracts: 5,
      no_overnight: true,
      no_weekend: false,
      no_news: false,
      close_time: '16:00',
    },
  },
  position: null,
  working_orders: [],
  notes: null,
  discipline_lock: true,
  lock_floor_time: null,
  prop_status: { status: 'incomplete', fail_reason: null, resolved_trade_id: null, trades_to_result: null },
  progress: progress(),
}

describe('SessionCard', () => {
  it('shows the name, asset, date range, progress and the days remaining', () => {
    act(() => root.render(<SessionCard session={SESSION} />))
    expect(text()).toContain('Custom prop NQ')
    expect(text()).toContain('MNQ · 4 Mar 2024 → 11 Mar 2024')
    expect(text()).toContain('3 days remaining')
    const bar = host.querySelector('[role="progressbar"]') as HTMLElement
    expect(bar.getAttribute('aria-valuenow')).toBe('40')
  })

  it('says "1 day remaining", "Complete" and "No end date" in their own cases', () => {
    act(() => root.render(<SessionCard session={{ ...SESSION, progress: progress({ trading_days_remaining: 1 }) }} />))
    expect(text()).toContain('1 day remaining')
    act(() => root.render(<SessionCard session={{ ...SESSION, progress: progress({ fraction: 1, complete: true, trading_days_remaining: 0 }) }} />))
    expect(text()).toContain('Complete')
    expect(text()).not.toContain('remaining')
    act(() => root.render(<SessionCard session={{ ...SESSION, end_date: null, progress: progress({ fraction: null, trading_days_remaining: null }) }} />))
    expect(text()).toContain('No end date')
    expect(text()).toContain('from 4 Mar 2024')
    expect(host.querySelector('[role="progressbar"]')).toBeNull()
  })

  it('the play button resumes the session', () => {
    act(() => root.render(<SessionCard session={SESSION} />))
    act(() => (host.querySelector('[aria-label="Resume Custom prop NQ"]') as HTMLButtonElement).click())
    expect(useUiStore.getState().selectedSessionId).toBe('s1')
  })

  it('the chevron expands the details: rules, verdict, P&L, checklist, and an Analytics link', () => {
    act(() => root.render(<SessionCard session={SESSION} />))
    expect(text()).not.toContain('Discipline lock')
    const chevron = host.querySelector('[aria-label="Show details of Custom prop NQ"]') as HTMLButtonElement
    expect(chevron.getAttribute('aria-expanded')).toBe('false')
    act(() => chevron.click())
    expect(chevron.getAttribute('aria-expanded')).toBe('true')
    expect(text()).toContain('Custom prop rules')
    expect(text()).toContain('In progress')
    expect(text()).toContain('$215.00')
    expect(text()).toContain('Target $2,500 · Max loss $1,500 (intraday trailing) · Daily loss $600 · Cap 5 contracts · No overnight holding')
    expect(text()).toContain('Checklist: Wait for the sweep')
    expect(text()).toContain('On') // discipline lock
    act(() => (Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Analytics') as HTMLButtonElement).click())
    expect(useUiStore.getState().selectedRunId).toBe('bt:s1')
    act(() => chevron.click())
    expect(text()).not.toContain('Discipline lock')
  })

  it('an ended session that neither passed nor failed reads "Not passed", not "In progress"', () => {
    act(() => root.render(<SessionCard session={{ ...SESSION, progress: progress({ fraction: 1, complete: true, trading_days_remaining: 0 }) }} />))
    act(() => (host.querySelector('[aria-label="Show details of Custom prop NQ"]') as HTMLButtonElement).click())
    expect(text()).toContain('Not passed')
    expect(text()).not.toContain('In progress')
  })

  it('a practice session has no rules line', () => {
    const practice = { ...SESSION, prop_status: null, account: { ...SESSION.account, prop_ruleset: null, prop_rules: null }, checklist: [] }
    act(() => root.render(<SessionCard session={practice} />))
    act(() => (host.querySelector('[aria-label="Show details of Custom prop NQ"]') as HTMLButtonElement).click())
    expect(text()).toContain('Practice')
    expect(text()).not.toContain('Target $')
  })
})
