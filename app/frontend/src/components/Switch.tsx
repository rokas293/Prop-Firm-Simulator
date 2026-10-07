// The on/off switch shared by the Place Order dialog and the Scalper popover,
// all five states. `accent` (default) is for the one switch that matters in a
// context; `neutral` is for the ordinary options around it, so accent still
// means exactly one thing (DESIGN_LANGUAGE.md section 2).
export default function Switch({
  checked,
  onChange,
  label,
  disabled,
  tone = 'accent',
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  disabled?: boolean
  tone?: 'accent' | 'neutral'
}) {
  const on = tone === 'accent' ? 'bg-accent enabled:hover:opacity-90 enabled:active:opacity-80' : 'bg-text/60 enabled:hover:bg-text/70 enabled:active:bg-text/80'
  const knobOn = tone === 'accent' ? 'translate-x-4 bg-on-accent' : 'translate-x-4 bg-bg'
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 flex-none rounded-full transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 ${
        checked ? on : 'bg-text-muted/40 enabled:hover:bg-text-muted/60 enabled:active:bg-text-muted/70'
      }`}
    >
      <span
        className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full transition-transform duration-150 ${checked ? knobOn : 'translate-x-0 bg-text'}`}
        aria-hidden
      />
    </button>
  )
}
