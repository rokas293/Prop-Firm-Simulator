// Renders keyboard/shortcuts.ts's SHORTCUTS grouped by category -- shared
// by ShortcutsOverlay (the "?" modal) and SettingsPanel's Shortcuts section
// (POLISH_ROADMAP Phase P6) so there's exactly one place that turns the
// registry into rows, not two that could drift in presentation.
import { SHORTCUTS, type ShortcutDef } from '../keyboard/shortcuts'

const CATEGORY_ORDER: ShortcutDef['category'][] = ['Global', 'Chart', 'Panels']

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
          <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-neutral-500">{category}</div>
          <div className="space-y-1">
            {defs.map((d) => (
              <div key={d.id} className="flex items-center justify-between gap-4 rounded px-2 py-1 text-sm hover:bg-neutral-900">
                <span className="text-neutral-300">{d.description}</span>
                <kbd className="whitespace-nowrap rounded border border-neutral-700 bg-neutral-950 px-1.5 py-0.5 font-mono text-[11px] text-neutral-400">
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
