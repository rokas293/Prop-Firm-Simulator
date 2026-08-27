import { create } from 'zustand'
import type { DockviewApi } from 'dockview-react'

// The live DockviewApi instance, exposed outside the Workspace component so
// sibling UI (the command palette) can drive the workspace -- add/reveal
// panels, switch layouts -- without Workspace needing to know the palette
// exists. Never persisted; it's a live object handle, not data.
interface WorkspaceApiState {
  api: DockviewApi | null
  setApi: (api: DockviewApi | null) => void
}

export const useWorkspaceApiStore = create<WorkspaceApiState>((set) => ({
  api: null,
  setApi: (api) => set({ api }),
}))
