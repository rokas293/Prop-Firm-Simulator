// G10: a trade (or position) the Autopilot bot took -- a muted micro-label, never a colour.
// After an off -> on the run is flagged interrupted, which the label and title say.
export default function BotChip({ interrupted = false }: { interrupted?: boolean }) {
  return (
    <span
      className="micro-label ml-2 align-middle"
      title={interrupted ? 'Autopilot trade, taken after the run was switched off and on again' : 'Autopilot trade'}
    >
      Bot{interrupted ? ' · resumed' : ''}
    </span>
  )
}
