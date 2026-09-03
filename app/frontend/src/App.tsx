import { useEffect, useState } from 'react'
import { useBtSession, useRun } from './api/hooks'
import ComparePage from './pages/ComparePage'
import RunsListPage from './pages/RunsListPage'
import SessionsListPage from './pages/SessionsListPage'
import Workspace from './workspace/Workspace'
import SessionWorkspace from './workspace/SessionWorkspace'
import CommandPalette from './workspace/CommandPalette'
import KeyboardShortcuts from './workspace/KeyboardShortcuts'
import PerfHud from './components/PerfHud'
import ShortcutsOverlay from './components/ShortcutsOverlay'
import SettingsPanel from './components/SettingsPanel'
import LiveRegion from './components/LiveRegion'
import { useUiStore } from './state/uiStore'
import { usePerfStore } from './state/perfStore'
import { applyThemeToDocument, useThemeBase, useThemeStore } from './state/themeStore'
import { isShortcut } from './keyboard/shortcuts'

export default function App() {
  const selectedRunId = useUiStore((s) => s.selectedRunId)
  const selectRun = useUiStore((s) => s.selectRun)
  const selectedSessionId = useUiStore((s) => s.selectedSessionId)
  const selectSession = useUiStore((s) => s.selectSession)
  const landingTab = useUiStore((s) => s.landingTab)
  const setLandingTab = useUiStore((s) => s.setLandingTab)
  const compareRunIds = useUiStore((s) => s.compareRunIds)
  const distractionFree = useUiStore((s) => s.distractionFree)
  const { data: run } = useRun(selectedRunId)
  const { data: btSession } = useBtSession(selectedSessionId)
  const perfEnabled = usePerfStore((s) => s.enabled)
  const togglePerf = usePerfStore((s) => s.toggle)

  // Applies the persisted (or just-changed) theme to :root -- see
  // themeStore.ts's comment for why this is a CSS-custom-property push
  // rather than a Tailwind class swap (POLISH_ROADMAP Phase P6).
  const themeColors = useThemeStore((s) => s.colors)
  const themeMode = useThemeStore((s) => s.mode)
  const themeBase = useThemeBase()
  useEffect(() => {
    applyThemeToDocument(themeColors, themeMode, themeBase)
  }, [themeColors, themeMode, themeBase])

  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  // The "?" shortcuts overlay is reachable from anywhere, same as the
  // command palette's own global Ctrl/Cmd-K listener (CommandPalette.tsx) --
  // both live at this top level rather than inside any one panel.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || target?.isContentEditable) return

      if (isShortcut(e, 'showShortcuts')) {
        e.preventDefault()
        setShortcutsOpen((o) => !o)
      } else if (isShortcut(e, 'closeOverlay')) {
        setShortcutsOpen(false)
        setSettingsOpen(false)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  return (
    <div className="min-h-screen bg-bg text-text">
      {/* REPLICA_ROADMAP.md Batch 5: distraction-free chart mode hides this
          whole header (Workspace.tsx switches its own height calc to match,
          and drops its "Layout:" preset row the same way) -- ChartPanel.tsx
          owns the actual toggle/shortcut/button, this just reacts to it. */}
      {!distractionFree && (
        <header className="flex items-center gap-3 border-b border-border px-6 py-3">
          <h1 className="text-sm font-semibold tracking-wide text-text">propbt viz</h1>
          {!compareRunIds && selectedRunId && (
            <>
              <div className="h-4 w-px bg-surface-2" />
              <button
                onClick={() => selectRun(null)}
                className="rounded bg-surface-2 px-2 py-1 text-xs text-text hover:bg-surface-2-hover"
              >
                &larr; Runs
              </button>
              <span className="font-mono text-xs text-text-muted">{selectedRunId}</span>
              {run && <span className="text-xs text-text-muted">{run.instrument}</span>}
            </>
          )}
          {!compareRunIds && selectedSessionId && (
            <>
              <div className="h-4 w-px bg-surface-2" />
              <button
                onClick={() => selectSession(null)}
                className="rounded bg-surface-2 px-2 py-1 text-xs text-text hover:bg-surface-2-hover"
              >
                &larr; Sessions
              </button>
              <span className="font-mono text-xs text-text-muted">{selectedSessionId}</span>
              {btSession && <span className="text-xs text-text-muted">{btSession.instrument}</span>}
            </>
          )}
          <button
            onClick={togglePerf}
            title="Toggle the perf HUD (render/fetch timings)"
            className={`ml-auto h-7 rounded px-2 text-xs transition-colors ${
              perfEnabled ? 'bg-accent text-white' : 'bg-surface-2 text-text-muted hover:bg-surface-2-hover'
            }`}
          >
            Perf
          </button>
          <button
            onClick={() => setSettingsOpen(true)}
            title="Settings: themes, layouts, shortcuts, data defaults"
            className="h-7 rounded bg-surface-2 px-2 text-xs text-text transition-colors hover:bg-surface-2-hover"
          >
            Settings
          </button>
          <span className="text-xs text-text-muted">
            {/* Same kbd treatment as ShortcutsList's keycaps (px-1 py-1, not
                this surface's own px-1.5 py-0.5) -- this was a third,
                independent keycap styling, flagged in the Settings/palette
                pass as out of scope there (global-sweep territory). */}
            <kbd className="rounded border border-border px-1 py-1">Ctrl/Cmd K</kbd> commands &middot;{' '}
            <button onClick={() => setShortcutsOpen(true)} className="rounded border border-border px-1 py-1 hover:border-border-hover hover:text-text">
              ?
            </button>{' '}
            shortcuts
          </span>
        </header>
      )}
      {compareRunIds && (
        <div key="compare" className="propbt-fade-in">
          <ComparePage />
        </div>
      )}
      {!compareRunIds && !selectedRunId && !selectedSessionId && (
        <div key="landing" className="propbt-fade-in">
          {/* FXR_SPEC.md phase F1: a tab switcher between completed
              automated-backtest runs and manual-replay sessions -- the two
              are unrelated data models (see uiStore.ts's own comment), so
              this just decides which list page is mounted. */}
          <div className="flex gap-2 border-b border-border px-6 pt-4">
            <button
              onClick={() => setLandingTab('runs')}
              className={`rounded-t px-3 py-1.5 text-xs ${
                landingTab === 'runs' ? 'bg-surface text-text' : 'text-text-muted hover:text-text'
              }`}
            >
              Runs
            </button>
            <button
              onClick={() => setLandingTab('sessions')}
              className={`rounded-t px-3 py-1.5 text-xs ${
                landingTab === 'sessions' ? 'bg-surface text-text' : 'text-text-muted hover:text-text'
              }`}
            >
              Sessions
            </button>
          </div>
          {landingTab === 'runs' ? <RunsListPage /> : <SessionsListPage />}
        </div>
      )}
      {!compareRunIds && selectedRunId && (
        // No key on selectedRunId here: Workspace must stay mounted across
        // a run switch (see its own comment -- the run-change reset effect
        // relies on exactly that), so this only fades in on the
        // runs-list -> workspace mount transition, not on every run switch.
        <div className="propbt-fade-in">
          <Workspace />
        </div>
      )}
      {!compareRunIds && selectedSessionId && (
        <div key={selectedSessionId} className="propbt-fade-in h-[calc(100vh-49px)]">
          <SessionWorkspace sessionId={selectedSessionId} />
        </div>
      )}
      <CommandPalette />
      <KeyboardShortcuts />
      <PerfHud />
      <LiveRegion />
      <ShortcutsOverlay open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  )
}
