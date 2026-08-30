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
      <div className="micro-label">{label}</div>
      {/* 20px = DESIGN_LANGUAGE.md section 3's "section KPI" scale step,
          medium weight -- deliberately one tier below the Score tab's 28px/
          semibold hero number (DashboardPanel's ScoreCard) rather than
          competing with it for "biggest number on screen" (DESIGN_AUDIT.md
          D1/S1: the app previously had two different, off-scale hero
          treatments -- 18px here and 36px/bold there). */}
      <div
        className={`text-[20px] font-medium tabular-nums ${
          accent === undefined ? 'text-text' : accent ? 'text-positive' : 'text-negative'
        }`}
      >
        {value}
      </div>
      {sub && <div className="text-[11px] text-text-muted">{sub}</div>}
    </div>
  )
}
