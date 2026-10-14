// FXR_V2_SPEC.md section 8 (G10): the Autopilot control in the playback pill. It only
// renders what the server stored (state) and asks the server to switch -- it computes
// nothing about the bot.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutopilotConfigInfo, AutopilotState } from '../api/types'
import SessionTopBar, { type AutopilotControlProps } from './SessionTopBar'

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

const CONFIGS: AutopilotConfigInfo[] = [
  {
    id: 'strategy',
    label: 'strategy',
    symbol: 'MNQ',
    legs: ['continuation', 'mean_reversion', 'news_continuation'],
    summary: [],
    supported: false,
    reason: 'strategy.yaml enables news_continuation, which Autopilot cannot run yet, and it will not run a subset.',
  },
  {
    id: 'strategy_session_open',
    label: 'strategy session open',
    symbol: 'MNQ',
    legs: ['continuation', 'mean_reversion'],
    summary: ['continuation · asia/london/ny · SL 10 pt · RR 1.5 · 1 ct'],
    supported: true,
    reason: null,
  },
]

const STATE: AutopilotState = {
  enabled: true,
  config_id: 'strategy_session_open',
  config_label: 'strategy session open',
  config_hash: 'abc',
  symbol: 'MNQ',
  legs: ['continuation', 'mean_reversion'],
  status: 'running',
  status_detail: null,
  daily_locked: false,
  interrupted: false,
  segments: [{ on_time: 1, off_time: null }],
  trading_start: 1,
  processed_to: 100,
  bot_balance: 50000,
  position: {
    instrument: 'MNQ',
    side: 'long',
    contracts: 1,
    entry_price: 20000.25,
    entry_time: 90,
    sl_price: 19990.25,
    tp_price: 20015.25,
    leg: 'continuation',
    unrealized_usd: 12.5,
  },
  pending: [],
  trades: 3,
  rejections: 0,
  slippage_ticks: 1,
  commission_per_contract: 1.3,
}

function render(ap: AutopilotControlProps) {
  const noop = () => undefined
  act(() =>
    root.render(
      <SessionTopBar
        name="MNQ session"
        subtitle=""
        disciplineLock={null}
        onBack={noop}
        menu={{
          followLatestBar: true,
          onToggleFollowLatestBar: noop,
          pickingReplayStart: false,
          onTogglePickingReplayStart: noop,
          magnifierArmed: false,
          smoothCandles: false,
          onToggleSmoothCandles: noop,
          onOpenAppSettings: noop,
          onOpenShortcuts: noop,
        }}
        playback={{
          isPlaying: false,
          onTogglePlaying: noop,
          speed: 1,
          onSpeedChange: noop,
          onStepBack: noop,
          onStepForward: noop,
          canStepBack: true,
          canStepForward: true,
          stepSize: '1min',
          onStepSizeChange: noop,
          autoPlay: false,
          onToggleAutoPlay: noop,
          cursorLabel: null,
          autopilot: ap,
        }}
        actions={{
          onPlaceOrder: noop,
          placeOrderDisabled: false,
          placeOrderReady: false,
          onToggleJournal: noop,
          journalOpen: false,
          onToggleTheme: noop,
          isDark: true,
          onToggleFullscreen: noop,
          isFullscreen: false,
        }}
      />,
    ),
  )
}

const open = () => {
  const btn = host.querySelector('button[aria-label="Autopilot"]') as HTMLButtonElement
  act(() => btn.click())
  return host.querySelector('[role="dialog"][aria-label="Autopilot"]') as HTMLElement
}

describe('Autopilot control', () => {
  it('lists runnable configs and says why a refused one cannot run', () => {
    render({ state: null, configs: CONFIGS, busy: false, error: null, onSwitch: vi.fn() })
    const dialog = open()
    const options = [...dialog.querySelectorAll('select option')].map((o) => o.textContent)
    expect(options).toEqual(['Strategy session open · MNQ'])
    expect(dialog.textContent).toContain('cannot run')
    expect(dialog.textContent).toContain('will not run a subset')
  })

  it("switching on sends the chosen config; the server confirms it", () => {
    const onSwitch = vi.fn()
    render({ state: null, configs: CONFIGS, busy: false, error: null, onSwitch })
    const dialog = open()
    const sw = dialog.querySelector('[role="switch"]') as HTMLButtonElement
    expect(sw.getAttribute('aria-checked')).toBe('false')
    act(() => sw.click())
    expect(onSwitch).toHaveBeenCalledWith(true, 'strategy_session_open')
  })

  it('shows the run as the server stored it, and switching off sends no config', () => {
    const onSwitch = vi.fn()
    render({ state: STATE, configs: CONFIGS, busy: false, error: null, onSwitch })
    const dialog = open()
    expect(dialog.textContent).toContain('Running')
    expect(dialog.textContent).toContain('3 trades')
    expect(dialog.textContent).toContain('Holding long 1')
    expect(dialog.textContent).toContain('+$12.50')
    expect(dialog.textContent).toContain('1 tick')
    const sw = dialog.querySelector('[role="switch"]') as HTMLButtonElement
    expect(sw.getAttribute('aria-checked')).toBe('true')
    act(() => sw.click())
    expect(onSwitch).toHaveBeenCalledWith(false, undefined)
  })

  it('an interrupted run is flagged as no longer matching an offline backtest', () => {
    render({
      state: { ...STATE, enabled: false, status: 'off', interrupted: true, segments: [{ on_time: 1, off_time: 50 }, { on_time: 60, off_time: null }] },
      configs: CONFIGS,
      busy: false,
      error: null,
      onSwitch: vi.fn(),
    })
    const text = open().textContent
    expect(text).toContain('Interrupted')
    expect(text).toContain('offline backtest')
  })

  it("a pending decision says it fills at the next bar's open; an ended run cannot be switched back on", () => {
    render({
      state: {
        ...STATE,
        enabled: false,
        status: 'failed',
        position: null,
        pending: [{ instrument: 'MNQ', side: 'short', contracts: 1, decided_time: 99, reason: 'x', sl_points: null, tp_points: null }],
      },
      configs: CONFIGS,
      busy: false,
      error: null,
      onSwitch: vi.fn(),
    })
    const dialog = open()
    expect(dialog.textContent).toContain("fills at the next bar's open")
    expect(dialog.textContent).toContain('account failed')
    expect((dialog.querySelector('[role="switch"]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('a refusal from the server is shown inside the popover', () => {
    render({ state: null, configs: CONFIGS, busy: false, error: 'Autopilot cannot start: no news trading', onSwitch: vi.fn() })
    expect(open().textContent).toContain('no news trading')
  })

  it('an archived session cannot start it, and the tooltip says why', () => {
    render({ state: null, configs: CONFIGS, busy: false, error: null, blockedReason: 'This session is archived.', onSwitch: vi.fn() })
    const dialog = open()
    expect((dialog.querySelector('[role="switch"]') as HTMLButtonElement).disabled).toBe(true)
    expect(dialog.querySelector('[title="This session is archived."]')).not.toBeNull()
  })

  it('reports on/off to assistive tech and in the tooltip, and shows an unmistakable cue when on', () => {
    render({ state: STATE, configs: CONFIGS, busy: false, error: null, onSwitch: vi.fn() })
    const btn = host.querySelector('button[aria-label="Autopilot"]') as HTMLButtonElement
    expect(btn.getAttribute('aria-pressed')).toBe('true')
    expect(btn.title).toContain('Autopilot is on')
    expect(btn.textContent?.toLowerCase()).toContain('on')
  })

  it('Escape closes the popover, returns focus to the button, and does not reach the workspace hotkeys', () => {
    render({ state: null, configs: CONFIGS, busy: false, error: null, onSwitch: vi.fn() })
    const reached = vi.fn()
    window.addEventListener('keydown', reached)
    const dialog = open()
    expect(dialog).not.toBeNull()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    window.removeEventListener('keydown', reached)
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(host.querySelector('button[aria-label="Autopilot"]'))
    expect(reached).not.toHaveBeenCalled()
  })

  it('keys typed in the popover do not reach the single-key hotkeys', () => {
    render({ state: null, configs: CONFIGS, busy: false, error: null, onSwitch: vi.fn() })
    const reached = vi.fn()
    window.addEventListener('keydown', reached)
    const dialog = open()
    const sw = dialog.querySelector('[role="switch"]') as HTMLElement
    act(() => {
      sw.dispatchEvent(new KeyboardEvent('keydown', { key: 'B', shiftKey: true, bubbles: true }))
    })
    window.removeEventListener('keydown', reached)
    expect(reached).not.toHaveBeenCalled()
  })

  it('the refused config sits behind a disclosure and the caveats behind another', () => {
    render({ state: null, configs: CONFIGS, busy: false, error: null, onSwitch: vi.fn() })
    const dialog = open()
    const summaries = [...dialog.querySelectorAll('details > summary')].map((s) => s.textContent)
    expect(summaries).toEqual(['Strategy cannot run', 'How it works'])
    expect([...dialog.querySelectorAll('details')].every((d) => !d.open)).toBe(true)
  })
})
