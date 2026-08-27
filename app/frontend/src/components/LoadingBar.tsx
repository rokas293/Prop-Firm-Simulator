// A subtle top-edge shimmer sweep instead of the content just sitting
// frozen while it fetches (POLISH_ROADMAP Phase P4). Deliberately tiny and
// non-blocking -- it never covers content, so it doesn't fight for
// attention the way a full overlay/spinner would for something that's
// often over within a couple hundred ms.
export default function LoadingBar({ active }: { active: boolean }) {
  if (!active) return null
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-30 h-0.5 overflow-hidden">
      <div className="propbt-loading-bar h-full w-full" />
    </div>
  )
}
