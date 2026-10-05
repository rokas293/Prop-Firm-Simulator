// Dispatch for the manual-session trading/replay hotkeys (FXR_SPEC.md phase
// F7b). Matching lives in shortcuts.ts (the registry the "?" overlay renders);
// this only decides WHEN a match may act.
import { useEffect, useRef } from 'react'
import { isTypingTarget, sessionHotkeyAction, type SessionHotkeyAction } from './shortcuts'

export type SessionHotkeyHandlers = Partial<Record<SessionHotkeyAction, () => void>>

// An open modal (Settings, "?", New session, the tour) owns the keyboard --
// an order must never be placed behind it.
function modalOpen(): boolean {
  return document.querySelector('[role="dialog"][aria-modal="true"]') !== null
}

// Space on a focused button/link is that control's native activation; acting
// on it too would double-fire (e.g. Play toggled twice).
function nativelyActivates(e: KeyboardEvent): boolean {
  if (e.key !== ' ') return false
  const tag = (e.target as HTMLElement | null)?.tagName
  return tag === 'BUTTON' || tag === 'A'
}

export function useSessionHotkeys(handlers: SessionHotkeyHandlers, enabled = true) {
  // Always the latest closures, without re-subscribing the listener every render.
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers

  useEffect(() => {
    if (!enabled) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing || isTypingTarget(e.target) || modalOpen() || nativelyActivates(e)) return
      const action = sessionHotkeyAction(e)
      if (!action) return
      // Holding a key must not repeat an order (or run the replay away).
      if (e.repeat && action !== 'sessionStep' && action !== 'sessionStepBack') {
        e.preventDefault()
        return
      }
      const handler = handlersRef.current[action]
      if (!handler) return
      e.preventDefault()
      handler()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [enabled])
}
