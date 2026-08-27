// Shared stat tile -- extracted from DashboardPanel (POLISH_ROADMAP Phase
// P5) so CompassPanel's score card uses the exact same visual language
// instead of a near-duplicate.
export default function KpiTile({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded border border-neutral-800 bg-neutral-900 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-neutral-500">{label}</div>
      <div
        className={`text-lg font-semibold ${
          accent === undefined ? 'text-neutral-100' : accent ? 'text-accent-green' : 'text-accent-red'
        }`}
      >
        {value}
      </div>
    </div>
  )
}
