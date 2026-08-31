import { beforeEach, describe, expect, it } from 'vitest'
import { useWorkspaceApiStore } from './workspaceApiStore'

beforeEach(() => {
  useWorkspaceApiStore.setState({ api: null })
})

describe('useWorkspaceApiStore', () => {
  it('starts with no live DockviewApi handle', () => {
    expect(useWorkspaceApiStore.getState().api).toBeNull()
  })

  it('setApi stores whatever handle it is given and setApi(null) clears it', () => {
    const fakeApi = { id: 'fake-dockview-api' } as never
    useWorkspaceApiStore.getState().setApi(fakeApi)
    expect(useWorkspaceApiStore.getState().api).toBe(fakeApi)
    useWorkspaceApiStore.getState().setApi(null)
    expect(useWorkspaceApiStore.getState().api).toBeNull()
  })
})
