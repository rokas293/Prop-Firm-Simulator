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
    <div className="rounded border border-border bg-surface px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-text-muted">{label}</div>
      <div
        className={`text-lg font-semibold ${
          accent === undefined ? 'text-text' : accent ? 'text-positive' : 'text-negative'
        }`}
      >
        {value}
      </div>
      {sub && <div className="text-[11px] text-text-muted">{sub}</div>}
    </div>
  )
}
