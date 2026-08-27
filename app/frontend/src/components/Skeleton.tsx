// A pulsing placeholder block (POLISH_ROADMAP Phase P6: "consistent loading
// skeletons"), replacing bare "Loading…" text with something that at least
// hints at the eventual layout. See index.css's .propbt-skeleton.
export default function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`propbt-skeleton ${className}`} />
}

// A row of skeleton tiles mimicking a KPI strip (DashboardPanel/CompassPanel
// both open with one), so the loading state roughly outlines what's coming.
export function KpiRowSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} className="h-14" />
      ))}
    </div>
  )
}
