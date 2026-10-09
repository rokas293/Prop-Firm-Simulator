// The home page's "How this works" card: dismissible, and once dismissed it stays collapsed to
// one quiet line that reopens the tour (G6).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FirstRunGuide } from './OnboardingGuide'
import { useOnboardingStore } from '../state/onboardingStore'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  useOnboardingStore.setState({ dismissed: false, tourOpen: false })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const button = (name: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent === name) as HTMLButtonElement

describe('FirstRunGuide', () => {
  it('shows the four steps until dismissed', () => {
    act(() => root.render(<FirstRunGuide />))
    expect(host.querySelectorAll('li')).toHaveLength(4)
    expect(button('Got it')).toBeDefined()
  })

  it('collapses to one line once dismissed, and that line reopens the tour', () => {
    act(() => root.render(<FirstRunGuide />))
    act(() => button('Got it').click())
    expect(host.querySelectorAll('li')).toHaveLength(0)
    expect(host.querySelector('section')).toBeNull()
    expect(useOnboardingStore.getState().dismissed).toBe(true)
    act(() => button('How this works').click())
    expect(useOnboardingStore.getState().tourOpen).toBe(true)
  })

  it('stays collapsed on the next render of an already-dismissed state', () => {
    useOnboardingStore.setState({ dismissed: true })
    act(() => root.render(<FirstRunGuide />))
    expect(host.querySelector('section')).toBeNull()
    expect(button('How this works')).toBeDefined()
  })
})
