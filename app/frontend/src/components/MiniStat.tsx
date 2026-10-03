// A borderless label+value pair for secondary stats that sit INSIDE an
// already-bordered Card (DESIGN_AUDIT.md: flatten nesting -- a stat next to
// three siblings inside a card that's already framed doesn't need its own
// KpiTile border on top of that, per DESIGN_LANGUAGE.md section 5: "a KPI
// doesn't need a bordered card if whitespace + a muted label already
// separate it"). Distinct from KpiTile, which is reserved for the
// hero/section-KPI rows that stand on their own. Extracted from
// DashboardPanel so the Monte Carlo and prop-result cards share the one copy.
export default function MiniStat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <div className="micro-label">{label}</div>
      <div className={`tabular-nums text-sm font-medium ${accent === undefined ? 'text-text' : accent ? 'text-positive-fg' : 'text-negative-fg'}`}>
        {value}
      </div>
    </div>
  )
}
