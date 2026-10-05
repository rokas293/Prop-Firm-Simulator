// First-run explainer for the manual-replay loop (FXR phase F7b): start a
// session, trade the replay, journal, analyze. Deliberately quiet
// (DESIGN_LANGUAGE.md sections 1/9): plain text on a surface step, no
// illustration, no accent, no border -- one ghost "Got it" to dismiss.
// Shown inline once on the Sessions list; re-openable as a dialog from the
// "?" shortcuts overlay.
import { useEffect, useRef } from 'react'
import { useModalFocus } from './useModalFocus'
import { useOnboardingStore } from '../state/onboardingStore'

const STEPS: { title: string; body: string }[] = [
  {
    title: 'Start a session',
    body: 'Pick MNQ or MES, a timeframe and a start time, or a random one. Optionally run it under Topstep rules or the discipline lock.',
  },
  {
    title: 'Trade the replay',
    body: 'Step or play forward; the future stays hidden. Buy and Sell at market, or New Trade for entry, stop and target. Shift+B and Shift+S place orders from the keyboard.',
  },
  {
    title: 'Journal',
    body: 'Every closed trade is logged. Add notes, tags, a grade and screenshots, then jump back to any trade to review it.',
  },
  {
    title: 'Analyze',
    body: 'Analytics shows stats, equity, Monte Carlo and, for Topstep sessions, the Combine verdict, across one session or all of them.',
  },
]

function Steps({ wide = true }: { wide?: boolean }) {
  return (
    <ol className={`grid grid-cols-1 gap-4 sm:grid-cols-2 ${wide ? 'lg:grid-cols-4' : ''}`}>
      {STEPS.map((step, i) => (
        <li key={step.title} className="flex flex-col gap-1">
          <span className="micro-label">Step {i + 1}</span>
          <span className="text-sm font-medium text-text">{step.title}</span>
          <span className="text-xs leading-relaxed text-text-muted">{step.body}</span>
        </li>
      ))}
    </ol>
  )
}

// Inline, once, on the Sessions list.
export function FirstRunGuide() {
  const dismissed = useOnboardingStore((s) => s.dismissed)
  const dismiss = useOnboardingStore((s) => s.dismiss)
  if (dismissed) return null
  return (
    <section aria-label="How this works" className="mb-6 rounded bg-surface p-4">
      <div className="mb-3 flex h-7 items-center justify-between">
        <h2 className="text-base font-medium text-text">How this works</h2>
        <button
          onClick={dismiss}
          className="h-7 rounded px-2 text-xs text-text-muted hover:bg-surface-2 hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        >
          Got it
        </button>
      </div>
      <Steps />
      <p className="mt-3 text-xs text-text-muted">Reopen this any time from the ? shortcuts overlay.</p>
    </section>
  )
}

// The re-opened version, mounted once at the app root.
export function OnboardingDialog() {
  const open = useOnboardingStore((s) => s.tourOpen)
  const close = useOnboardingStore((s) => s.closeTour)
  const contentRef = useRef<HTMLDivElement>(null)
  useModalFocus(contentRef, open)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close])

  if (!open) return null
  return (
    <div className="propbt-cmdk-overlay" onClick={close}>
      <div
        ref={contentRef}
        className="propbt-shortcuts-content"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="How this works"
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-base font-medium text-text">How this works</h2>
          <button onClick={close} className="h-7 rounded px-2 text-xs text-text-muted hover:bg-surface-2 hover:text-text">
            Esc to close
          </button>
        </div>
        <div className="p-4">
          <Steps wide={false} />
        </div>
      </div>
    </div>
  )
}
