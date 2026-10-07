import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSessionHotkeys, type SessionHotkeyHandlers } from './useSessionHotkeys'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Mounts the hook in a throwaway component (this project has no testing-library).
let root: Root | null = null
function Probe({ handlers, enabled }: { handlers: SessionHotkeyHandlers; enabled: boolean }) {
  useSessionHotkeys(handlers, enabled)
  return null
}
function mount(handlers: SessionHotkeyHandlers, enabled = true) {
  const host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
  const render = (on: boolean) => act(() => root!.render(<Probe handlers={handlers} enabled={on} />))
  render(enabled)
  return { setEnabled: render }
}

function press(init: KeyboardEventInit & { key: string }, target: EventTarget = document.body): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(e)
  return e
}

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

describe('useSessionHotkeys: when a hotkey may act', () => {
  it('fires its handler on the page and cancels the browser default', () => {
    const step = vi.fn()
    mount({ sessionStep: step })
    const e = press({ key: ' ', shiftKey: true })
    expect(step).toHaveBeenCalledTimes(1)
    expect(e.defaultPrevented).toBe(true)
  })

  it('does not fire while typing in an input, a select, a textarea or contenteditable', () => {
    const buy = vi.fn()
    const newMarket = vi.fn()
    mount({ sessionBuy: buy, sessionNewMarket: newMarket })
    for (const tag of ['input', 'select', 'textarea']) {
      const el = document.body.appendChild(document.createElement(tag))
      press({ key: 'B', shiftKey: true }, el)
      press({ key: 'M', shiftKey: true }, el)
    }
    const editable = document.body.appendChild(document.createElement('div'))
    Object.defineProperty(editable, 'isContentEditable', { value: true })
    press({ key: 'B', shiftKey: true }, editable)
    expect(buy).not.toHaveBeenCalled()
    expect(newMarket).not.toHaveBeenCalled()
  })

  it('does not fire while a modal dialog is open (the order dialog, Settings, the "?" overlay)', () => {
    const calls = vi.fn()
    mount({ sessionBuy: calls, sessionStep: calls, sessionNewLimit: calls, sessionGranularityUp: calls })
    const dialog = document.body.appendChild(document.createElement('div'))
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')
    press({ key: 'B', shiftKey: true })
    press({ key: '.' })
    press({ key: 'L', shiftKey: true })
    press({ key: '}', code: 'BracketRight', shiftKey: true })
    expect(calls).not.toHaveBeenCalled()
    // And they work again once it closes.
    dialog.remove()
    press({ key: '.' })
    expect(calls).toHaveBeenCalledTimes(1)
  })

  it("Space on a focused button is that button's own activation, so Play/Pause does not double-fire", () => {
    const playPause = vi.fn()
    mount({ sessionPlayPause: playPause })
    const button = document.body.appendChild(document.createElement('button'))
    press({ key: ' ' }, button)
    expect(playPause).not.toHaveBeenCalled()
    press({ key: ' ' })
    expect(playPause).toHaveBeenCalledTimes(1)
  })

  it('a held key repeats only the step, never an order, a dialog or a size change', () => {
    const handlers = {
      sessionStep: vi.fn(),
      sessionBuy: vi.fn(),
      sessionNewStop: vi.fn(),
      sessionSpeedUp: vi.fn(),
      sessionGranularityDown: vi.fn(),
    }
    mount(handlers)
    press({ key: '.', repeat: true })
    press({ key: 'B', shiftKey: true, repeat: true })
    press({ key: 'T', shiftKey: true, repeat: true })
    press({ key: ']', code: 'BracketRight', repeat: true })
    press({ key: '{', code: 'BracketLeft', shiftKey: true, repeat: true })
    expect(handlers.sessionStep).toHaveBeenCalledTimes(1)
    expect(handlers.sessionBuy).not.toHaveBeenCalled()
    expect(handlers.sessionNewStop).not.toHaveBeenCalled()
    expect(handlers.sessionSpeedUp).not.toHaveBeenCalled()
    expect(handlers.sessionGranularityDown).not.toHaveBeenCalled()
  })

  it('ignores IME composition, and nothing fires when disabled', () => {
    const step = vi.fn()
    const { setEnabled } = mount({ sessionStep: step })
    press({ key: '.', isComposing: true })
    expect(step).not.toHaveBeenCalled()
    setEnabled(false)
    press({ key: '.' })
    expect(step).not.toHaveBeenCalled()
  })

  it('a key with no handler passed is left alone (no preventDefault)', () => {
    mount({})
    expect(press({ key: ' ' }).defaultPrevented).toBe(false)
  })

  it('routes every new action to its own handler', () => {
    const h = {
      sessionNewMarket: vi.fn(),
      sessionNewLimit: vi.fn(),
      sessionNewStop: vi.fn(),
      sessionGranularityUp: vi.fn(),
      sessionGranularityDown: vi.fn(),
      sessionStep: vi.fn(),
    }
    mount(h)
    press({ key: 'M', shiftKey: true })
    press({ key: 'L', shiftKey: true })
    press({ key: 'T', shiftKey: true })
    press({ key: '}', code: 'BracketRight', shiftKey: true })
    press({ key: '{', code: 'BracketLeft', shiftKey: true })
    press({ key: ' ', shiftKey: true })
    for (const fn of Object.values(h)) expect(fn).toHaveBeenCalledTimes(1)
  })
})
