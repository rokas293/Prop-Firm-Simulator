import { describe, expect, it } from 'vitest'
import { SHORTCUTS, isShortcut, matchesCombo } from './shortcuts'

function keyEvent(init: Partial<KeyboardEventInit> & { key: string }): KeyboardEvent {
  return new KeyboardEvent('keydown', init)
}

describe('matchesCombo', () => {
  it('matches a plain key case-insensitively', () => {
    expect(matchesCombo(keyEvent({ key: 'N' }), { key: 'n' })).toBe(true)
    expect(matchesCombo(keyEvent({ key: 'n' }), { key: 'n' })).toBe(true)
  })

  it('rejects a different key', () => {
    expect(matchesCombo(keyEvent({ key: 'm' }), { key: 'n' })).toBe(false)
  })

  it('matches on code (layout-independent) for digit shortcuts', () => {
    expect(matchesCombo(keyEvent({ key: '1', code: 'Digit1' }), { code: 'Digit1' })).toBe(true)
    expect(matchesCombo(keyEvent({ key: '!', code: 'Digit1', shiftKey: true }), { code: 'Digit1' })).toBe(true)
  })

  it('requires an exact shift-state match when specified', () => {
    expect(matchesCombo(keyEvent({ key: '1', code: 'Digit1', shiftKey: true }), { code: 'Digit1', shift: false })).toBe(
      false,
    )
    expect(matchesCombo(keyEvent({ key: '1', code: 'Digit1', shiftKey: false }), { code: 'Digit1', shift: false })).toBe(
      true,
    )
    expect(
      matchesCombo(keyEvent({ key: '!', code: 'Digit1', shiftKey: true }), { code: 'Digit1', shift: true }),
    ).toBe(true)
  })

  it('requires ctrl or meta when ctrlOrMeta is true, either satisfies it', () => {
    const combo = { key: 'k', ctrlOrMeta: true }
    expect(matchesCombo(keyEvent({ key: 'k', ctrlKey: true }), combo)).toBe(true)
    expect(matchesCombo(keyEvent({ key: 'k', metaKey: true }), combo)).toBe(true)
    expect(matchesCombo(keyEvent({ key: 'k' }), combo)).toBe(false)
  })

  it('rejects ctrl/meta held when the combo requires it absent', () => {
    expect(matchesCombo(keyEvent({ key: 'n', ctrlKey: true }), { key: 'n', ctrlOrMeta: false })).toBe(false)
  })
})

describe('isShortcut', () => {
  it('matches any of a shortcut\'s combos (nextTrade: arrow or "n")', () => {
    expect(isShortcut(keyEvent({ key: 'ArrowRight' }), 'nextTrade')).toBe(true)
    expect(isShortcut(keyEvent({ key: 'n' }), 'nextTrade')).toBe(true)
    expect(isShortcut(keyEvent({ key: 'x' }), 'nextTrade')).toBe(false)
  })

  it('returns false for an unknown shortcut id', () => {
    expect(isShortcut(keyEvent({ key: 'n' }), 'does-not-exist')).toBe(false)
  })

  it('distinguishes a timeframe digit from its shifted panel-toggle counterpart', () => {
    const plain1 = keyEvent({ key: '1', code: 'Digit1', shiftKey: false })
    const shift1 = keyEvent({ key: '!', code: 'Digit1', shiftKey: true })
    expect(isShortcut(plain1, 'timeframe-1min')).toBe(true)
    expect(isShortcut(shift1, 'timeframe-1min')).toBe(false)
    expect(isShortcut(shift1, 'toggle-panel-chart')).toBe(true)
    expect(isShortcut(plain1, 'toggle-panel-chart')).toBe(false)
  })

  it('the "?" shortcut fires on the plain key event browsers report for Shift+/', () => {
    // Browsers report KeyboardEvent.key as '?' itself for Shift+/ on a US
    // layout -- the registry intentionally matches on .key here (not
    // .code+shift) for the same reason GitHub's own "press ?" works this way.
    expect(isShortcut(keyEvent({ key: '?', shiftKey: true }), 'showShortcuts')).toBe(true)
  })
})

describe('SHORTCUTS registry integrity', () => {
  it('has no duplicate ids', () => {
    const ids = SHORTCUTS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('every shortcut has at least one combo and a non-empty label/description', () => {
    for (const s of SHORTCUTS) {
      expect(s.combos.length).toBeGreaterThan(0)
      expect(s.label.length).toBeGreaterThan(0)
      expect(s.description.length).toBeGreaterThan(0)
    }
  })

  it('includes one toggle-panel shortcut per registered panel', () => {
    const toggles = SHORTCUTS.filter((s) => s.id.startsWith('toggle-panel-'))
    expect(toggles.length).toBeGreaterThanOrEqual(5)
  })
})
