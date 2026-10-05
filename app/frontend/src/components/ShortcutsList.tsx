// Renders keyboard/shortcuts.ts's SHORTCUTS grouped by category -- shared
// by ShortcutsOverlay (the "?" modal) and SettingsPanel's Shortcuts section
// (POLISH_ROADMAP Phase P6) so there's exactly one place that turns the
// registry into rows, not two that could drift in presentation.
import { SHORTCUTS, type ShortcutDef } from '../keyboard/shortcuts'

const CATEGORY_ORDER: ShortcutDef['category'][] = ['Global', 'Session', 'Chart', 'Drawing', 'Panels']

function groupByCategory(defs: ShortcutDef[]): [ShortcutDef['category'], ShortcutDef[]][] {
  return CATEGORY_ORDER.map((cat): [ShortcutDef['category'], ShortcutDef[]] => [cat, defs.filter((d) => d.category === cat)]).filter(
    ([, list]) => list.length > 0,
  )
}

export default function ShortcutsList() {
  const groups = groupByCategory(SHORTCUTS)
  return (
    <>
      {groups.map(([category, defs]) => (
        <div key={category} className="mb-4 last:mb-0">
          {/* .micro-label, not a near-duplicate ad hoc declaration (this one
              was already close -- 11px/500/uppercase -- but tracking-wide is
              Tailwind's 0.025em, not the shared 0.04em). */}
          <div className="micro-label mb-2">{category}</div>
          <div className="space-y-1">
            {defs.map((d) => (
              <div key={d.id} className="flex items-center justify-between gap-4 rounded px-2 py-1 text-sm hover:bg-surface">
                <span className="text-text">{d.description}</span>
                <kbd className="whitespace-nowrap rounded border border-border bg-bg px-1 py-1 font-mono leading-4 text-[11px] text-text-muted">
                  {d.label}
                </kbd>
              </div>
            ))}
          </div>
        </div>
      ))}
    </>
  )
}
