import { describe, expect, it } from 'vitest'
import { DRAWING_SHORTCUTS, SHORTCUTS, isShortcut, matchesCombo } from './shortcuts'

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

  it('REPLICA_ROADMAP.md Batch 5: "d" toggles distraction-free, "s" arms click-to-set-replay-start', () => {
    expect(isShortcut(keyEvent({ key: 'd' }), 'toggleFullscreen')).toBe(true)
    expect(isShortcut(keyEvent({ key: 's' }), 'setReplayStart')).toBe(true)
    expect(isShortcut(keyEvent({ key: 'd' }), 'setReplayStart')).toBe(false)
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

  // POLISH_ROADMAP Phase P6 audit: the drawing toolbar's own key->tool
  // mapping (DRAWING_SHORTCUTS, dispatched by ChartPanel.tsx) must be
  // fully represented in the discoverable registry -- a shortcut that
  // works but never shows up in the "?" overlay defeats the point of a
  // *discoverable* shortcuts list.
  it('has one Drawing-category entry per DRAWING_SHORTCUTS key, and each fires via isShortcut', () => {
    const drawingDefs = SHORTCUTS.filter((s) => s.category === 'Drawing')
    expect(drawingDefs.length).toBe(Object.keys(DRAWING_SHORTCUTS).length)
    for (const [key] of Object.entries(DRAWING_SHORTCUTS)) {
      const def = drawingDefs.find((d) => d.combos.some((c) => c.key === key))
      expect(def, `no Drawing shortcut registered for key "${key}"`).toBeDefined()
      expect(isShortcut(new KeyboardEvent('keydown', { key }), def!.id)).toBe(true)
    }
  })
})


// --- FXR_SPEC.md phase F7b: session trading / replay hotkeys ---------------

import { SESSION_SHORTCUT_IDS, isTypingTarget, sessionHotkeyAction, type Combo } from './shortcuts'

function eventFor(combo: Combo): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    key: combo.key ?? combo.code ?? '',
    code: combo.code ?? '',
    shiftKey: combo.shift ?? false,
    ctrlKey: combo.ctrlOrMeta ?? false,
    altKey: combo.alt ?? false,
  })
}

describe('session hotkeys', () => {
  it('every registered combo fires exactly its own shortcut -- no conflicts anywhere in the registry', () => {
    for (const def of SHORTCUTS) {
      if (def.id === 'measureDrag') continue // display-only mouse gesture
      for (const combo of def.combos) {
        const hits = SHORTCUTS.filter((s) => s.id !== 'measureDrag' && s.combos.some((c) => matchesCombo(eventFor(combo), c)))
        expect(hits.map((h) => h.id), `${def.id} (${def.label})`).toEqual([def.id])
      }
    }
  })

  it('Shift+B / Shift+S / Shift+C place or close; plain b / s / c never do', () => {
    expect(sessionHotkeyAction(keyEvent({ key: 'B', shiftKey: true }))).toBe('sessionBuy')
    expect(sessionHotkeyAction(keyEvent({ key: 'S', shiftKey: true }))).toBe('sessionSell')
    expect(sessionHotkeyAction(keyEvent({ key: 'C', shiftKey: true }))).toBe('sessionClose')
    for (const key of ['b', 's', 'c', 'h', 'n']) expect(sessionHotkeyAction(keyEvent({ key }))).toBeNull()
  })

  it('a trading key with Ctrl/Meta/Alt is never an order (Ctrl+Shift+C is the browser inspector)', () => {
    for (const mod of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      for (const key of ['B', 'S', 'C', 'H', 'N']) {
        expect(sessionHotkeyAction(keyEvent({ key, shiftKey: true, ...mod }))).toBeNull()
      }
    }
  })

  it('existing plain shortcuts no longer fire on their Shift variants (drawing keys vs trading keys)', () => {
    expect(isShortcut(keyEvent({ key: 'b' }), 'draw-brush')).toBe(true)
    expect(isShortcut(keyEvent({ key: 'B', shiftKey: true }), 'draw-brush')).toBe(false)
    expect(isShortcut(keyEvent({ key: 'S', shiftKey: true }), 'setReplayStart')).toBe(false)
    expect(isShortcut(keyEvent({ key: 'N', shiftKey: true }), 'nextTrade')).toBe(false)
    expect(isShortcut(keyEvent({ key: 'H', shiftKey: true }), 'draw-horizontalStraightLine')).toBe(false)
  })

  it('replay-flow keys map to their actions', () => {
    expect(sessionHotkeyAction(keyEvent({ key: ' ' }))).toBe('sessionPlayPause')
    expect(sessionHotkeyAction(keyEvent({ key: '.' }))).toBe('sessionStep')
    expect(sessionHotkeyAction(keyEvent({ key: ',' }))).toBe('sessionStepBack')
    expect(sessionHotkeyAction(keyEvent({ key: ']', code: 'BracketRight' }))).toBe('sessionSpeedUp')
    expect(sessionHotkeyAction(keyEvent({ key: '[', code: 'BracketLeft' }))).toBe('sessionSpeedDown')
  })

  it('every session hotkey is in the registry (so it reaches the "?" overlay)', () => {
    for (const id of SESSION_SHORTCUT_IDS) {
      const def = SHORTCUTS.find((s) => s.id === id)
      expect(def, id).toBeDefined()
      expect(def?.category).toBe('Session')
    }
  })

  it('isTypingTarget flags form controls and contenteditable, not buttons or the page', () => {
    for (const tag of ['input', 'select', 'textarea']) expect(isTypingTarget(document.createElement(tag))).toBe(true)
    const div = document.createElement('div')
    Object.defineProperty(div, 'isContentEditable', { value: true })
    expect(isTypingTarget(div)).toBe(true)
    expect(isTypingTarget(document.createElement('button'))).toBe(false)
    expect(isTypingTarget(document.body)).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
  })
})


// --- G4: the full replay + order hotkey set --------------------------------

// Real keydowns carry both key and code; the registry's letter combos match on key.
describe('G4 hotkeys: the whole registry', () => {
  const sessionDefs = () => SHORTCUTS.filter((s) => s.category === 'Session')

  function realEvent(combo: Combo, extra: KeyboardEventInit = {}): KeyboardEvent {
    return new KeyboardEvent('keydown', {
      key: combo.key ?? combo.code ?? '',
      code: combo.code ?? '',
      shiftKey: combo.shift ?? false,
      ...extra,
    })
  }

  it('every session combo resolves to exactly its own action through the dispatcher the workspace uses', () => {
    expect(sessionDefs().map((d) => d.id).sort()).toEqual([...SESSION_SHORTCUT_IDS].sort())
    for (const def of sessionDefs()) {
      for (const combo of def.combos) {
        expect(sessionHotkeyAction(realEvent(combo)), `${def.id} (${def.label})`).toBe(def.id)
      }
    }
  })

  it('no session combo fires with Ctrl, Alt or Meta added (a browser/OS chord is never an order or a step)', () => {
    for (const def of sessionDefs()) {
      for (const combo of def.combos) {
        for (const mod of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }]) {
          expect(sessionHotkeyAction(realEvent(combo, mod)), `${def.id} + ${Object.keys(mod)[0]}`).toBeNull()
        }
      }
    }
  })

  it('every non-session shortcut is invisible to the session dispatcher (no key fires two actions)', () => {
    for (const def of SHORTCUTS.filter((s) => s.category !== 'Session' && s.id !== 'measureDrag')) {
      for (const combo of def.combos) {
        const e = realEvent(combo, { ctrlKey: combo.ctrlOrMeta ?? false })
        expect(sessionHotkeyAction(e), `${def.id} (${def.label})`).toBeNull()
      }
    }
  })

  it('next step: Shift+Space and "." step; Ctrl+Space (the Windows input-language toggle) is deliberately unbound', () => {
    expect(sessionHotkeyAction(keyEvent({ key: ' ', shiftKey: true }))).toBe('sessionStep')
    expect(sessionHotkeyAction(keyEvent({ key: '.' }))).toBe('sessionStep')
    expect(sessionHotkeyAction(keyEvent({ key: ' ', ctrlKey: true }))).toBeNull()
    expect(sessionHotkeyAction(keyEvent({ key: ' ', ctrlKey: true, shiftKey: true }))).toBeNull()
    // Plain Space is still play/pause, not a step.
    expect(sessionHotkeyAction(keyEvent({ key: ' ' }))).toBe('sessionPlayPause')
  })

  it('play/pause and speed keep their plain keys; Alt+digit (which would also hit the timeframe keys) is unbound', () => {
    expect(sessionHotkeyAction(keyEvent({ key: ']', code: 'BracketRight' }))).toBe('sessionSpeedUp')
    expect(sessionHotkeyAction(keyEvent({ key: '[', code: 'BracketLeft' }))).toBe('sessionSpeedDown')
    for (const n of ['1', '2', '3', '4', '5']) {
      expect(sessionHotkeyAction(keyEvent({ key: n, code: `Digit${n}`, altKey: true }))).toBeNull()
    }
  })

  it('step size -/+ is Shift+[ and Shift+], matched on the physical key so any layout works', () => {
    expect(sessionHotkeyAction(keyEvent({ key: '{', code: 'BracketLeft', shiftKey: true }))).toBe('sessionGranularityDown')
    expect(sessionHotkeyAction(keyEvent({ key: '}', code: 'BracketRight', shiftKey: true }))).toBe('sessionGranularityUp')
    // Unshifted they stay speed.
    expect(sessionHotkeyAction(keyEvent({ key: '[', code: 'BracketLeft' }))).toBe('sessionSpeedDown')
    expect(sessionHotkeyAction(keyEvent({ key: ']', code: 'BracketRight' }))).toBe('sessionSpeedUp')
  })

  it('new market / limit / stop are Shift+M / Shift+L / Shift+T; plain m / l / t never open an order form', () => {
    expect(sessionHotkeyAction(keyEvent({ key: 'M', shiftKey: true }))).toBe('sessionNewMarket')
    expect(sessionHotkeyAction(keyEvent({ key: 'L', shiftKey: true }))).toBe('sessionNewLimit')
    expect(sessionHotkeyAction(keyEvent({ key: 'T', shiftKey: true }))).toBe('sessionNewStop')
    for (const key of ['m', 'l', 't']) expect(sessionHotkeyAction(keyEvent({ key }))).toBeNull()
    // FX Replay's Alt+M / Alt+B / Alt+N are not bound here.
    for (const key of ['m', 'b', 'n']) expect(sessionHotkeyAction(keyEvent({ key, altKey: true }))).toBeNull()
    // Shift+N still opens the unpreset dialog; Shift+B / Shift+S still buy and sell.
    expect(sessionHotkeyAction(keyEvent({ key: 'N', shiftKey: true }))).toBe('sessionNewTrade')
    expect(sessionHotkeyAction(keyEvent({ key: 'B', shiftKey: true }))).toBe('sessionBuy')
    expect(sessionHotkeyAction(keyEvent({ key: 'S', shiftKey: true }))).toBe('sessionSell')
  })

  it('the existing plain drawing keys are untouched by the new Shift keys', () => {
    expect(isShortcut(keyEvent({ key: 'm' }), 'draw-klMeasure')).toBe(true)
    expect(isShortcut(keyEvent({ key: 'M', shiftKey: true }), 'draw-klMeasure')).toBe(false)
    expect(isShortcut(keyEvent({ key: 't' }), 'draw-segment')).toBe(true)
    expect(isShortcut(keyEvent({ key: 'T', shiftKey: true }), 'draw-segment')).toBe(false)
  })
})
