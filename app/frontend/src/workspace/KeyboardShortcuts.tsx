// Global "toggle panel N" shortcuts (Shift+1..Shift+N, POLISH_ROADMAP Phase
// P6) -- the one category of shortcut that belongs at this top level rather
// than inside a specific panel, since it needs the live DockviewApi
// (workspaceApiStore), not any one panel's own local state. Mounted
// alongside CommandPalette/ShortcutsOverlay in App.tsx; a no-op whenever no
// run is open (workspaceApi is null until Workspace mounts), same as
// CommandPalette already tolerates.
import { useEffect } from 'react'
import { useWorkspaceApiStore } from '../state/workspaceApiStore'
import { isShortcut } from '../keyboard/shortcuts'
import { PANEL_DEFS } from './panelIds'

export default function KeyboardShortcuts() {
  const workspaceApi = useWorkspaceApiStore((s) => s.api)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || target?.isContentEditable) return
      if (!workspaceApi) return

      for (const def of PANEL_DEFS) {
        if (!isShortcut(e, `toggle-panel-${def.id}`)) continue
        e.preventDefault()
        const existing = workspaceApi.getPanel(def.id)
        if (existing) existing.api.close()
        else workspaceApi.addPanel({ id: def.id, component: def.component, title: def.title })
        return
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [workspaceApi])

  return null
}
