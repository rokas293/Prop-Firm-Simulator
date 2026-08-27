// Shared stat tile. `sub` is an optional subunit line (REDESIGN_APPROACH.md
// Phase B2 hero row: Net P&L in $ with its R figure as a subunit, Max
// Drawdown in $ with its share of the MLL budget as a subunit) -- kept on
// this one component rather than a second tile variant.
export default function KpiTile({
  label,
  value,
  sub,
  accent,
}: {
  label: string
  value: string
  sub?: string
  accent?: boolean
}) {
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
      {sub && <div className="text-[11px] text-neutral-500">{sub}</div>}
    </div>
  )
}
