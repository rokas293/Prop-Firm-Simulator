// Discoverable "?" shortcuts overlay (POLISH_ROADMAP Phase P6). Body is
// ShortcutsList, which renders directly from keyboard/shortcuts.ts's
// SHORTCUTS array -- the same data every real key handler matches against
// via isShortcut() -- so this can never drift from what actually works.
// App.tsx's global '?'/Escape listener owns `open`; real dispatch for each
// shortcut lives in ChartPanel, CommandPalette, and KeyboardShortcuts.tsx.
import { useRef } from 'react'
import ShortcutsList from './ShortcutsList'
import { useModalFocus } from './useModalFocus'
import { useOnboardingStore } from '../state/onboardingStore'

export default function ShortcutsOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  // Same fix as SettingsPanel (accessibility audit): this hand-rolled
  // dialog had no focus management at all, confirmed live to leak Tab
  // through to the workspace behind it. Called unconditionally (rules of
  // hooks); no-ops internally while `open` is false.
  const contentRef = useRef<HTMLDivElement>(null)
  useModalFocus(contentRef, open)
  const openTour = useOnboardingStore((s) => s.openTour)

  if (!open) return null

  return (
    <div className="propbt-cmdk-overlay" onClick={onClose}>
      <div
        ref={contentRef}
        className="propbt-shortcuts-content"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          {/* Same 16px/medium as SettingsPanel's title -- was 14px/600
              here, the exact "same thing, second convention" gap the
              global sweep is for (Settings' matching title was already
              fixed in that surface's own pass). */}
          <h2 className="text-base font-medium text-text">Keyboard shortcuts</h2>
          <button onClick={onClose} className="h-7 rounded px-2 text-xs text-text-muted hover:bg-surface-2 hover:text-text">
            Esc to close
          </button>
        </div>
        <div className="max-h-[calc(80vh-102px)] overflow-y-auto p-4">
          <ShortcutsList />
        </div>
        <div className="flex h-12 items-center px-4">
          <button
            onClick={() => {
              onClose()
              openTour()
            }}
            className="h-7 rounded px-2 text-xs text-text-muted hover:bg-surface-2 hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          >
            Show the quick tour
          </button>
        </div>
      </div>
    </div>
  )
}
