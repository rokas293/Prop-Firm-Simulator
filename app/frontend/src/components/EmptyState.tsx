// A consistent empty state (POLISH_ROADMAP Phase P6: "empty states with
// helpful hints") -- replaces the various one-off "No run selected" /
// "No trades match the current filters" bare text messages that were
// scattered across panels with a shared title+hint layout.
export default function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1.5 p-6 text-center">
      <div className="text-sm text-neutral-400">{title}</div>
      {hint && <div className="max-w-xs text-xs text-neutral-600">{hint}</div>}
    </div>
  )
}
