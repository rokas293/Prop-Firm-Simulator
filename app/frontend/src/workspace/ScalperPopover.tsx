// FXR_V2_SPEC.md 3.4 (G4, reference R1): the Scalper Mode settings popover,
// opened from the bottom bar's Scalper button. Three blocks, as in the
// reference: Stop loss (value + ticks / % / $), Take profit (value + ticks / % /
// R) and Auto break-even (an R multiple or a distance in ticks). Every field is
// a DISTANCE, never a price. Edits apply and persist immediately (no
// Save/Discard to forget); the Armed switch at the top is what makes Quick
// Buy/Sell and right-click orders carry the brackets, and the only accent here.
//
// All three blocks are always laid out (an off block is dimmed and disabled),
// so toggling one never moves the rest. No trading maths here: chart/scalper.ts
// owns the units and the preview.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import Switch from '../components/Switch'
import { POPOVER_SHELL } from '../components/popoverStyles'
import { fmtUsd } from '../format'
import {
  BE_MODES,
  SL_UNITS,
  TP_UNITS,
  tpNeedsStop,
  type ScalperBeMode,
  type ScalperPreview,
  type ScalperSettings,
  type ScalperSlUnit,
  type ScalperTpUnit,
} from '../chart/scalper'

const LABEL = 'text-xs text-text'
const HELP = 'text-xs text-text-muted'

// A positive number; the text can sit half-typed ("1.") or empty while editing,
// and only a valid value above zero is ever committed. An invalid draft is
// flagged until it is fixed or the field is left (then it snaps back).
function ValueInput({ value, onCommit, label, disabled }: { value: number; onCommit: (n: number) => void; label: string; disabled?: boolean }) {
  const [draft, setDraft] = useState<string | null>(null)
  const invalid = draft !== null && !(draft.trim() !== '' && Number.isFinite(Number(draft)) && Number(draft) > 0)
  return (
    <input
      type="text"
      inputMode="decimal"
      autoComplete="off"
      aria-label={label}
      aria-invalid={invalid || undefined}
      disabled={disabled}
      value={draft ?? String(value)}
      onChange={(e) => {
        setDraft(e.target.value)
        const n = Number(e.target.value)
        if (e.target.value.trim() !== '' && Number.isFinite(n) && n > 0) onCommit(n)
      }}
      onBlur={() => setDraft(null)}
      className="propbt-input propbt-input--well min-w-0 flex-1 text-right tabular-nums"
    />
  )
}

interface SegmentOption<T extends string> {
  value: T
  label: string
  // Tooltip: what the unit means, where the popover has no room to say it.
  title?: string
}

// "ticks | % | $": one of a few units, as in the reference's unit toggle.
function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  disabled,
  disabledValues,
}: {
  options: ReadonlyArray<SegmentOption<T>>
  value: T
  onChange: (v: T) => void
  label: string
  disabled?: boolean
  disabledValues?: ReadonlyArray<T>
}) {
  return (
    <div role="group" aria-label={label} aria-disabled={disabled || undefined} className="flex h-7 w-28 flex-none rounded bg-bg p-1">
      {options.map((o) => {
        const off = disabled || (disabledValues?.includes(o.value) ?? false)
        const active = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={active}
            disabled={off}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={`flex-1 rounded text-xs transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 ${
              active ? 'bg-surface-2 text-text' : 'text-text-muted enabled:hover:bg-surface enabled:hover:text-text enabled:active:bg-surface-2'
            }`}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

function Block({
  title,
  on,
  onToggle,
  disabled,
  note,
  children,
}: {
  title: string
  on: boolean
  onToggle: (v: boolean) => void
  disabled?: boolean
  // Muted, beside the title: why the block is unavailable.
  note?: string
  children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-2" aria-label={title}>
      <div className="flex items-center justify-between gap-2">
        <span className={LABEL}>
          {title}
          {note && <span className="ml-2 text-text-muted">{note}</span>}
        </span>
        <Switch checked={on} onChange={onToggle} label={title} disabled={disabled} tone="neutral" />
      </div>
      <div className={`flex flex-col gap-2 transition-opacity duration-150 ${on ? '' : 'opacity-40'}`}>{children}</div>
    </section>
  )
}

const ticksText = (n: number) => `${n} tick${n === 1 ? '' : 's'}`

export interface ScalperPopoverProps {
  armed: boolean
  onArmedChange: (armed: boolean) => void
  settings: ScalperSettings
  onChange: (patch: Partial<ScalperSettings>) => void
  // What the settings amount to at the current price and Quick quantity; null
  // while there is no price yet.
  preview: ScalperPreview | null
  quantity: number
  instrument: string
  onClose: () => void
}

const SL_OPTIONS: ReadonlyArray<SegmentOption<ScalperSlUnit>> = SL_UNITS.map((u) =>
  u.value === 'usd' ? { ...u, title: 'Dollars lost on the whole position: more contracts, a tighter stop' } : u,
)
const TP_OPTIONS: ReadonlyArray<SegmentOption<ScalperTpUnit>> = TP_UNITS.map((u) =>
  u.value === 'r' ? { ...u, title: 'A multiple of the stop distance (needs a stop loss)' } : u,
)
const BE_OPTIONS: ReadonlyArray<SegmentOption<ScalperBeMode>> = BE_MODES.map((u) =>
  u.value === 'r' ? { ...u, title: 'Once the trade is up this many times its risk' } : { ...u, title: 'Once the trade is this many ticks in profit' },
)

export default function ScalperPopover({ armed, onArmedChange, settings: s, onChange, preview, quantity, instrument, onClose }: ScalperPopoverProps) {
  const ref = useRef<HTMLDivElement>(null)
  const id = useId()

  // Click outside or Escape closes, like the session menu. The Scalper button is
  // inside the wrapper the parent owns, so toggling it is its own click. Focus
  // is NOT handed back to that button on close: a focused button owns Space, which
  // would then reopen this instead of playing / pausing the replay.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const host = ref.current?.parentElement
      if (host && !host.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  // Focus moves in on open (to the one switch that matters).
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="switch"]')?.focus()
  }, [])

  const noStop = !s.slOn
  const showPreview = preview !== null && (preview.slTicks !== null || preview.tpTicks !== null)

  return (
    <div
      ref={ref}
      role="dialog"
      aria-labelledby={`${id}-title`}
      data-scalper-popover
      className={`${POPOVER_SHELL} absolute bottom-9 left-0 z-30 flex w-80 flex-col gap-4 p-4`}
    >
      <div className="flex items-center justify-between gap-2">
        <h2 id={`${id}-title`} className="text-sm text-text">
          Scalper mode
        </h2>
        <label className="flex items-center gap-2 text-xs text-text-muted">
          {armed ? 'Armed' : 'Off'}
          <Switch checked={armed} onChange={onArmedChange} label="Armed" />
        </label>
      </div>

      <Block title="Stop loss" on={s.slOn} onToggle={(v) => onChange({ slOn: v })}>
        <div className="flex items-center gap-2">
          <ValueInput value={s.slValue} onCommit={(n) => onChange({ slValue: n })} label="Stop loss value" disabled={!s.slOn} />
          <Segmented<ScalperSlUnit> options={SL_OPTIONS} value={s.slUnit} onChange={(v) => onChange({ slUnit: v })} label="Stop loss unit" disabled={!s.slOn} />
        </div>
      </Block>

      <Block title="Take profit" on={s.tpOn} onToggle={(v) => onChange({ tpOn: v })}>
        <div className="flex items-center gap-2">
          <ValueInput value={s.tpValue} onCommit={(n) => onChange({ tpValue: n })} label="Take profit value" disabled={!s.tpOn} />
          <Segmented<ScalperTpUnit>
            options={TP_OPTIONS}
            value={s.tpUnit}
            onChange={(v) => onChange({ tpUnit: v })}
            label="Take profit unit"
            disabled={!s.tpOn}
            disabledValues={noStop ? ['r'] : undefined}
          />
        </div>
        {tpNeedsStop(s) && <p className={HELP}>R needs a stop loss. No target is set until it is on, or pick ticks or %.</p>}
      </Block>

      <Block title="Auto break-even" on={s.beOn} onToggle={(v) => onChange({ beOn: v })} disabled={noStop} note={noStop ? 'needs a stop' : undefined}>
        <div className="flex items-center gap-2">
          <ValueInput value={s.beValue} onCommit={(n) => onChange({ beValue: n })} label="Break-even trigger value" disabled={!s.beOn} />
          <Segmented<ScalperBeMode> options={BE_OPTIONS} value={s.beMode} onChange={(v) => onChange({ beMode: v })} label="Break-even trigger" disabled={!s.beOn} />
        </div>
      </Block>

      <div className="flex flex-col gap-1" aria-live="polite" data-scalper-preview>
        <span className="micro-label">
          At {quantity} {instrument}
        </span>
        {showPreview ? (
          <dl className="grid grid-cols-[auto_1fr_auto] gap-x-3 gap-y-1 text-xs tabular-nums">
            {preview.slTicks !== null && preview.slUsd !== null && (
              <>
                <dt className="text-text-muted">Stop</dt>
                <dd className="text-right text-text">{ticksText(preview.slTicks)}</dd>
                <dd className="min-w-16 text-right text-negative-fg">-{fmtUsd(preview.slUsd)}</dd>
              </>
            )}
            {preview.tpTicks !== null && preview.tpUsd !== null && (
              <>
                <dt className="text-text-muted">Target</dt>
                <dd className="text-right text-text">{ticksText(preview.tpTicks)}</dd>
                <dd className="min-w-16 text-right text-positive-fg">+{fmtUsd(preview.tpUsd)}</dd>
              </>
            )}
            {preview.rewardRisk !== null && (
              <>
                <dt className="text-text-muted">Reward : risk</dt>
                <dd />
                <dd className="text-right text-text-muted">{preview.rewardRisk.toFixed(2)}R</dd>
              </>
            )}
          </dl>
        ) : (
          <span className={HELP}>Nothing would be placed: armed entries carry no stop or target.</span>
        )}
        {preview?.breakevenPastTarget && <span className={HELP}>Break-even triggers at or beyond the target, so it never fires first.</span>}
      </div>
    </div>
  )
}
