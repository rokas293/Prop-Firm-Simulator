// Single source of truth for every keyboard shortcut in the app
// (POLISH_ROADMAP Phase P6). Real key handlers (ChartPanel, CommandPalette,
// KeyboardShortcuts.tsx) and the "?" ShortcutsOverlay both read from this
// same SHORTCUTS array via isShortcut() -- so the overlay can never drift
// from what actually fires, which is the whole point of a *discoverable*
// shortcuts list. Pure and framework-free, same pattern as
// chart/tradeBracket.ts's density thresholds or chart/animateRange.ts's
// easing math: the logic is here, tested here, and every call site just
// asks "does this event match shortcut X."
import { PANEL_DEFS } from '../workspace/panelIds'

export interface Combo {
  key?: string // matched case-insensitively against KeyboardEvent.key
  code?: string // matched against KeyboardEvent.code (layout-independent -- used for digit shortcuts)
  shift?: boolean
  ctrlOrMeta?: boolean
}

export interface ShortcutDef {
  id: string
  combos: Combo[]
  label: string
  description: string
  category: 'Chart' | 'Panels' | 'Global'
}

export function matchesCombo(e: KeyboardEvent, combo: Combo): boolean {
  if (combo.shift !== undefined && e.shiftKey !== combo.shift) return false
  if (combo.ctrlOrMeta !== undefined && (e.ctrlKey || e.metaKey) !== combo.ctrlOrMeta) return false
  if (combo.code) return e.code === combo.code
  if (combo.key) return e.key.toLowerCase() === combo.key.toLowerCase()
  return false
}

// Digit shortcuts (timeframe, panel-toggle) match on KeyboardEvent.code
// (e.g. "Digit1") rather than .key, since .key reports the *shifted*
// character ("!" for Shift+1 on a US layout) which varies by keyboard
// layout -- .code is the physical key regardless of layout or modifiers.
const TIMEFRAME_SHORTCUTS: ShortcutDef[] = ['1min', '5min', '15min', '1h'].map((tf, i) => ({
  id: `timeframe-${tf}`,
  combos: [{ code: `Digit${i + 1}`, shift: false }],
  label: `${i + 1}`,
  description: `Switch chart timeframe to ${tf}`,
  category: 'Chart' as const,
}))

// One toggle-panel shortcut per entry in PANEL_DEFS, generated rather than
// hardcoded so adding/removing a panel (as Compass was added in Phase P5)
// keeps the registry honest without a separate edit here.
const PANEL_TOGGLE_SHORTCUTS: ShortcutDef[] = PANEL_DEFS.map((def, i) => ({
  id: `toggle-panel-${def.id}`,
  combos: [{ code: `Digit${i + 1}`, shift: true }],
  label: `Shift+${i + 1}`,
  description: `Toggle the ${def.title} panel`,
  category: 'Panels' as const,
}))

export const SHORTCUTS: ShortcutDef[] = [
  {
    id: 'nextTrade',
    combos: [{ key: 'ArrowRight' }, { key: 'n' }],
    label: '→ / N',
    description: 'Select the next trade',
    category: 'Chart',
  },
  {
    id: 'prevTrade',
    combos: [{ key: 'ArrowLeft' }, { key: 'p' }],
    label: '← / P',
    description: 'Select the previous trade',
    category: 'Chart',
  },
  {
    id: 'toggleReplay',
    combos: [{ key: 'r' }],
    label: 'R',
    description: 'Toggle replay mode',
    category: 'Chart',
  },
  {
    id: 'fitTrade',
    combos: [{ key: 'f' }],
    label: 'F',
    description: 'Ease the chart viewport to the selected trade',
    category: 'Chart',
  },
  ...TIMEFRAME_SHORTCUTS,
  ...PANEL_TOGGLE_SHORTCUTS,
  {
    id: 'openPalette',
    combos: [{ key: 'k', ctrlOrMeta: true }],
    label: 'Ctrl/Cmd+K',
    description: 'Open the command palette',
    category: 'Global',
  },
  {
    id: 'showShortcuts',
    combos: [{ key: '?' }],
    label: '?',
    description: 'Show this shortcuts overlay',
    category: 'Global',
  },
  {
    id: 'closeOverlay',
    combos: [{ key: 'Escape' }],
    label: 'Esc',
    description: 'Close the command palette, shortcuts overlay, or settings panel',
    category: 'Global',
  },
]

export function isShortcut(e: KeyboardEvent, id: string): boolean {
  const def = SHORTCUTS.find((s) => s.id === id)
  return !!def && def.combos.some((c) => matchesCombo(e, c))
}
