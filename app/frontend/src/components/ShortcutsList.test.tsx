import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { SESSION_SHORTCUT_IDS, SHORTCUTS } from '../keyboard/shortcuts'
import ShortcutsList from './ShortcutsList'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let host: HTMLElement | null = null
function renderList(): string[] {
  host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
  act(() => root!.render(<ShortcutsList />))
  return [...host.querySelectorAll('span, kbd')].map((n) => n.textContent ?? '')
}

afterEach(() => {
  act(() => root?.unmount())
  root = null
  host?.remove()
})

describe('the "?" overlay lists every session hotkey', () => {
  it("shows each one's description and key label", () => {
    const texts = renderList()
    for (const id of SESSION_SHORTCUT_IDS) {
      const def = SHORTCUTS.find((s) => s.id === id)!
      expect(texts, `${id} description`).toContain(def.description)
      expect(texts, `${id} label`).toContain(def.label)
    }
  })

  it('names the new keys', () => {
    const texts = renderList()
    for (const label of ['Shift+M', 'Shift+L', 'Shift+T', 'Shift+[', 'Shift+]', '. / Shift+Space']) {
      expect(texts, label).toContain(label)
    }
  })
})
