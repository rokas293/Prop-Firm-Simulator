// FXR_V2_SPEC.md 3.5 (G3): the dialog as rendered -- the pure rules are tested in
// chart/orderTicket.test.ts; this proves the form is wired to them (pre-fill from
// the tool, the linked fields, the cap refusal, and the three actions).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PlaceOrderDialog, { type PlaceOrderDialogProps } from './PlaceOrderDialog'
import type { OrderContext, PositionToolLevels } from '../chart/orderTicket'
import { CONTRACT_SPECS } from '../chart/simBroker'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const MARK = 20050.25
const CTX: OrderContext = {
  instrument: 'MNQ',
  spec: CONTRACT_SPECS.MNQ,
  mark: MARK,
  balances: { initial: 50000, current: 52000 },
  cap: null,
  quickQuantity: 1,
  atr: 10,
}
const TOOL: PositionToolLevels = { side: 'long', entry: MARK, sl: MARK - 10, tp: MARK + 20 }

let host: HTMLDivElement
let root: Root

function render(overrides: Partial<PlaceOrderDialogProps> = {}) {
  const props: PlaceOrderDialogProps = {
    ctx: CTX,
    tool: TOOL,
    initial: { riskPct: 1, basis: 'initial', autoBreakeven: false },
    existingTags: ['breakout', 'reversal'],
    checklistRules: [],
    capLabel: null,
    onBasisChange: vi.fn(),
    onSave: vi.fn(),
    onDiscard: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  }
  act(() => root.render(<PlaceOrderDialog {...props} />))
  return props
}

const dialog = () => host.querySelector('[role="dialog"]') as HTMLElement
const input = (label: string): HTMLInputElement => {
  const l = Array.from(host.querySelectorAll('label')).find((el) => el.textContent === label)
  if (!l) throw new Error(`no label ${label}`)
  return host.querySelector(`#${CSS.escape(l.htmlFor)}`) as HTMLInputElement
}
const button = (name: string | RegExp) =>
  Array.from(host.querySelectorAll('button')).find((b) => (typeof name === 'string' ? b.textContent?.trim() === name : name.test(b.textContent ?? ''))) as HTMLButtonElement

function type(el: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    set.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const click = (el: Element) => act(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true })))

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('PlaceOrderDialog', () => {
  it('is a modal dialog titled Place order', () => {
    render()
    expect(dialog().getAttribute('aria-modal')).toBe('true')
    expect(dialog().textContent).toContain('Place order')
  })

  it('opens pre-filled from the position tool', () => {
    render()
    expect(input('Entry price').value).toBe('20050.25')
    expect(input('Stop loss').value).toBe('20040.25')
    expect(input('Stop loss in ticks').value).toBe('40')
    expect(input('Take profit').value).toBe('20070.25')
    expect(input('Take profit in ticks').value).toBe('80')
    expect(input('Risk percent').value).toBe('1')
    expect(input('Risk amount').value).toBe('500.00')
    expect(input('Position size (contracts)').value).toBe('25')
    expect((host.querySelector('select[id$="-type"]') as HTMLSelectElement).value).toBe('market')
    expect((host.querySelector('select[id$="-side"]') as HTMLSelectElement).value).toBe('long')
  })

  it('shows the estimated loss and profit of the chosen size', () => {
    render()
    expect(host.querySelector('[data-testid="est-loss"]')?.textContent).toBe('-$500.00')
    expect(host.querySelector('[data-testid="est-profit"]')?.textContent).toBe('$1,000.00')
  })

  it('opened empty it is a market buy at the current price with default levels', () => {
    render({ tool: null })
    expect(input('Entry price').value).toBe('20050.25')
    expect(input('Stop loss').value).toBe('20040.25')
    expect(input('Take profit').value).toBe('20070.25')
  })

  it('typing ticks updates the price, typing a price updates the ticks', () => {
    render()
    type(input('Stop loss in ticks'), '100')
    expect(input('Stop loss').value).toBe('20025.25')
    type(input('Take profit'), '20100.25')
    expect(input('Take profit in ticks').value).toBe('200')
  })

  it('a risk chip sets Risk % and Risk $ together and re-sizes', () => {
    render()
    click(button('2%'))
    expect(input('Risk percent').value).toBe('2')
    expect(input('Risk amount').value).toBe('1000.00')
    expect(input('Position size (contracts)').value).toBe('50')
    type(input('Risk amount'), '250')
    expect(input('Risk percent').value).toBe('0.5')
  })

  it('names the actual risk when rounding changes it', () => {
    render({ tool: { side: 'long', entry: MARK, sl: MARK - 15, tp: MARK + 30 } })
    expect(host.querySelector('[data-testid="size-note"]')?.textContent).toContain('Rounded down from 16.67 contracts')
  })

  it('a buy limit above the market is refused at the Type field and Save is disabled', () => {
    render()
    type(input('Entry price'), '20060.25') // a buy above the market: auto-typed Stop
    const typeSelect = host.querySelector('select[id$="-type"]') as HTMLSelectElement
    expect(typeSelect.value).toBe('stop')
    act(() => {
      typeSelect.value = 'limit'
      typeSelect.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Buy limit must be below the current price')
    expect(button('Save').disabled).toBe(true)
    expect(button(/Save & Journal/).disabled).toBe(true)
  })

  it('a prop session refuses an over-cap size inside the dialog, with the reason', () => {
    render({ ctx: { ...CTX, cap: 5 }, capLabel: 'Topstep' })
    expect(input('Position size (contracts)').value).toBe('5') // auto-size is clamped
    expect(host.querySelector('[data-testid="size-note"]')?.textContent).toContain('Capped at 5 contracts')
    type(input('Position size (contracts)'), '7')
    const note = host.querySelector('[data-testid="size-note"]')
    expect(note?.getAttribute('role')).toBe('alert')
    expect(note?.textContent).toContain('5-contract position limit')
    expect(button('Save').disabled).toBe(true)
  })

  it('Save places the order without the journal, Save & Journal with it', () => {
    const props = render({ checklistRules: ['Trend aligned', 'News clear'] })
    const rule = Array.from(host.querySelectorAll('input[type="checkbox"]'))[0] as HTMLInputElement
    click(rule)
    click(button('Save'))
    expect(props.onSave).toHaveBeenCalledTimes(1)
    const [order, journal] = (props.onSave as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(journal).toBe(false)
    expect(order).toMatchObject({ side: 'long', type: 'market', entryPrice: MARK, contracts: 25, slPrice: MARK - 10, tpPrice: MARK + 20, checklist: ['Trend aligned'] })
    click(button(/Save & Journal/))
    expect((props.onSave as ReturnType<typeof vi.fn>).mock.calls[1][1]).toBe(true)
  })

  it('only offers a checklist when the session has one', () => {
    render()
    expect(dialog().textContent).not.toContain('Checklist')
    act(() => root.unmount())
    root = createRoot(host)
    render({ checklistRules: ['Trend aligned'] })
    expect(dialog().textContent).toContain('Checklist')
    expect(dialog().textContent).toContain('Trend aligned')
  })

  it('tags: picks an existing one, adds a new one on Enter, and removes one', () => {
    const props = render()
    click(button('breakout'))
    const tagInput = host.querySelector('input[placeholder^="Select a tag"]') as HTMLInputElement
    type(tagInput, 'fomo')
    act(() => {
      tagInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(host.querySelector('[aria-label="Selected tags"]')?.textContent).toContain('breakout')
    expect(host.querySelector('[aria-label="Selected tags"]')?.textContent).toContain('fomo')
    click(host.querySelector('[aria-label="Remove tag breakout"]')!)
    expect(host.querySelector('[aria-label="Selected tags"]')?.textContent).not.toContain('breakout')
    click(button('Save'))
    expect((props.onSave as ReturnType<typeof vi.fn>).mock.calls[0][0].tags).toEqual(['fomo'])
  })

  it('Discard discards; the x and Escape only close (the tool stays)', () => {
    const props = render()
    click(button('Discard'))
    expect(props.onDiscard).toHaveBeenCalledTimes(1)
    click(host.querySelector('[aria-label="Close"]')!)
    expect(props.onClose).toHaveBeenCalledTimes(1)
    act(() => {
      dialog().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(props.onClose).toHaveBeenCalledTimes(2)
    expect(props.onDiscard).toHaveBeenCalledTimes(1)
  })

  it('reports the balance basis choice, and re-prices the risk on it', () => {
    const props = render()
    const current = Array.from(host.querySelectorAll('input[type="radio"]'))[1] as HTMLInputElement
    click(current)
    expect(props.onBasisChange).toHaveBeenCalledWith('current')
    expect(input('Risk amount').value).toBe('520.00')
  })

  it('switching the side mirrors the stop and target', () => {
    render()
    const side = host.querySelector('select[id$="-side"]') as HTMLSelectElement
    act(() => {
      side.value = 'short'
      side.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(input('Stop loss').value).toBe('20060.25')
    expect(input('Take profit').value).toBe('20030.25')
  })
})
