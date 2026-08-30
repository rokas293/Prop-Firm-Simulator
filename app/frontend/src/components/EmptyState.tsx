import type { ReactNode } from 'react'

// A consistent empty state (POLISH_ROADMAP Phase P6: "empty states with
// helpful hints") -- replaces the various one-off "No run selected" /
// "No trades match the current filters" / "no drawings yet" bare text
// messages that were scattered across panels with a shared title+hint
// layout. `children` is an optional action (e.g. TradeListPanel's "Clear
// filters" button) rendered below the hint, still in the same consistent
// wrapper, rather than each panel building its own bespoke empty block
// whenever the empty state needs to DO something, not just say something.
export default function EmptyState({ title, hint, children }: { title: string; hint?: string; children?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1.5 p-6 text-center">
      <div className="text-sm text-text-muted">{title}</div>
      {hint && <div className="max-w-xs text-xs text-text-muted">{hint}</div>}
      {children && <div className="mt-1.5">{children}</div>}
    </div>
  )
}
