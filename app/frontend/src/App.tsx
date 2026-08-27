import { useEffect, useState } from 'react'
import { useRun } from './api/hooks'
import ComparePage from './pages/ComparePage'
import RunsListPage from './pages/RunsListPage'
import Workspace from './workspace/Workspace'
import CommandPalette from './workspace/CommandPalette'
import KeyboardShortcuts from './workspace/KeyboardShortcuts'
import PerfHud from './components/PerfHud'
import ShortcutsOverlay from './components/ShortcutsOverlay'
import SettingsPanel from './components/SettingsPanel'
import { useUiStore } from './state/uiStore'
import { usePerfStore } from './state/perfStore'
import { applyThemeToDocument, useThemeStore } from './state/themeStore'
import { isShortcut } from './keyboard/shortcuts'

export default function App() {
  const selectedRunId = useUiStore((s) => s.selectedRunId)
  const selectRun = useUiStore((s) => s.selectRun)
  const compareRunIds = useUiStore((s) => s.compareRunIds)
  const { data: run } = useRun(selectedRunId)
  const perfEnabled = usePerfStore((s) => s.enabled)
  const togglePerf = usePerfStore((s) => s.toggle)

  // Applies the persisted (or just-changed) theme to :root -- see
  // themeStore.ts's comment for why this is a CSS-custom-property push
  // rather than a Tailwind class swap (POLISH_ROADMAP Phase P6).
  const themeColors = useThemeStore((s) => s.colors)
  useEffect(() => {
    applyThemeToDocument(themeColors)
  }, [themeColors])

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
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      <header className="flex items-center gap-3 border-b border-neutral-800 px-6 py-3">
        <h1 className="text-sm font-semibold tracking-wide text-neutral-300">propbt viz</h1>
        {!compareRunIds && selectedRunId && (
          <>
            <div className="h-4 w-px bg-neutral-800" />
            <button
              onClick={() => selectRun(null)}
              className="rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-700"
            >
              &larr; Runs
            </button>
            <span className="font-mono text-xs text-neutral-500">{selectedRunId}</span>
            {run && <span className="text-xs text-neutral-400">{run.instrument}</span>}
          </>
        )}
        <button
          onClick={togglePerf}
          title="Toggle the perf HUD (render/fetch timings)"
          className={`ml-auto rounded px-2 py-1 text-xs transition-colors ${
            perfEnabled ? 'bg-accent-blue text-white' : 'bg-neutral-800 text-neutral-400 hover:bg-neutral-700'
          }`}
        >
          Perf
        </button>
        <button
          onClick={() => setSettingsOpen(true)}
          title="Settings: themes, layouts, shortcuts, data defaults"
          className="rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-300 transition-colors hover:bg-neutral-700"
        >
          Settings
        </button>
        <span className="text-xs text-neutral-600">
          <kbd className="rounded border border-neutral-700 px-1.5 py-0.5">Ctrl/Cmd K</kbd> commands &middot;{' '}
          <button onClick={() => setShortcutsOpen(true)} className="rounded border border-neutral-700 px-1.5 py-0.5 hover:border-neutral-500 hover:text-neutral-300">
            ?
          </button>{' '}
          shortcuts
        </span>
      </header>
      {compareRunIds && (
        <div key="compare" className="propbt-fade-in">
          <ComparePage />
        </div>
      )}
      {!compareRunIds && !selectedRunId && (
        <div key="runs" className="propbt-fade-in">
          <RunsListPage />
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
      <CommandPalette />
      <KeyboardShortcuts />
      <PerfHud />
      <ShortcutsOverlay open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  )
}
