// "New session" (FXR_V2_SPEC.md section 4, G6; layout after reference R8).
//
// QUICK: name, account balance, assets (MNQ, MES or both: one cursor, one account), a start and an end date with the
// instrument's data range under each, +1D / +1W / +1M to fill the end, and a
// random start. Nothing about contracts or risk -- sizing happens per order.
// ADVANCED adds commissions per instrument, the discipline lock, a strategy
// checklist and a prop firm session (rule builder, restrictions, presets).
//
// All the rules a message quotes live in chart/sessionSetup.ts (tested); the
// server validates again. Same overlay/content-box convention as SettingsPanel.
import { useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { useModalFocus } from './useModalFocus'
import Switch from './Switch'
import { useCreateBtSession, useSessionSetupOptions } from '../api/hooks'
import type { MaxLossType } from '../api/types'
import { useUiStore } from '../state/uiStore'
import { ET_LABEL, fmtIsoDateLong } from '../timeFormat'
import {
  DEFAULT_RANDOM_LENGTH_DAYS,
  DEFAULT_START_TIME,
  SPAN_DAYS,
  assetsLabel,
  buildCreateRequest,
  combinedRange,
  draftFromRules,
  endDateFor,
  groupMoney,
  matchingPreset,
  moneyRaw,
  normalizeClock,
  randomLengthError,
  rangeHint,
  resolveWindow,
  rulesFromDraft,
  typeClock,
  type QuickSpan,
  type RuleDraft,
} from '../chart/sessionSetup'

const ASSETS = ['MNQ', 'MES'] as const
const SPANS: QuickSpan[] = ['1D', '1W', '1M']
const MAX_CHECKLIST_RULES = 30
const LOSS_TYPES: { id: MaxLossType; label: string; hint: string }[] = [
  { id: 'static', label: 'Static', hint: 'The floor stays where it starts.' },
  { id: 'eod_trailing', label: 'EOD trailing', hint: 'The floor follows the end-of-day balance up.' },
  { id: 'intraday_trailing', label: 'Intraday trailing', hint: 'The floor follows the highest equity reached, tick by tick.' },
]

const GHOST_BUTTON =
  'h-7 rounded px-2 text-xs text-text-muted transition-colors hover:bg-surface-2 hover:text-text active:bg-surface-2-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-text-muted'
// The small filled chips (+1D / +1W / +1M, Random start): pressed = one step brighter.
const CHIP = 'h-7 rounded bg-surface-2 px-2 text-xs text-text-muted transition-colors hover:bg-surface-2-hover hover:text-text active:bg-surface-2-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-surface-2 disabled:hover:text-text-muted'
const CHIP_ON = 'bg-surface-2-hover text-text'

function Field({
  label,
  hint,
  error,
  children,
  action,
  id,
  value,
}: {
  label: string
  hint?: string
  error?: string
  children: React.ReactNode
  action?: React.ReactNode
  id?: string
  // The field's value in the standard form ("4 Mar 2024"), beside its label.
  value?: string
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1" data-field={id}>
      <div className={`flex items-center justify-between gap-2 ${action ? 'min-h-7' : ''}`}>
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="micro-label">{label}</span>
          {value && <span className="truncate text-xs tabular-nums text-text-muted">{value}</span>}
        </span>
        {action}
      </div>
      {children}
      {error ? (
        <span className="text-[11px] text-negative-fg" role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className="text-[11px] text-text-muted">{hint}</span>
      ) : null}
    </div>
  )
}

// A dollar amount, written with thousands separators as you type ("3,000", "0.62").
function MoneyInput({
  value,
  onChange,
  label,
  invalid,
  disabled,
  placeholder,
  className = '',
}: {
  value: string
  onChange: (raw: string) => void
  label: string
  invalid?: boolean
  disabled?: boolean
  placeholder?: string
  className?: string
}) {
  return (
    <div className={`relative ${className}`}>
      <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-text-muted">$</span>
      <input
        type="text"
        inputMode="decimal"
        value={groupMoney(value)}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={label}
        aria-invalid={invalid ? true : undefined}
        onChange={(e) => onChange(moneyRaw(e.target.value))}
        className="propbt-input propbt-input--prefix w-full"
      />
    </div>
  )
}

// A 24-hour time of day in ET ("16:00 ET"): a text field, because a native time input
// follows the browser's locale (04:00 PM).
function ClockInput({
  value,
  onChange,
  label,
  invalid,
  className = '',
}: {
  value: string
  onChange: (v: string) => void
  label: string
  invalid?: boolean
  className?: string
}) {
  return (
    <div className={`relative ${className}`}>
      <input
        type="text"
        inputMode="numeric"
        maxLength={5}
        placeholder="HH:MM"
        value={value}
        aria-label={label}
        title={label}
        aria-invalid={invalid ? true : undefined}
        onChange={(e) => onChange(typeClock(e.target.value))}
        onBlur={() => onChange(normalizeClock(value))}
        className="propbt-input w-full pr-8"
      />
      <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-text-muted">{ET_LABEL}</span>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-[14px] font-medium text-text">{title}</h3>
      {children}
    </section>
  )
}

function ToggleRow({ label, hint, checked, onChange, disabled }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="text-[13px] text-text">{label}</div>
        {hint && <div className="text-[11px] text-text-muted">{hint}</div>}
      </div>
      <Switch checked={checked} onChange={onChange} label={label} disabled={disabled} tone="neutral" />
    </div>
  )
}

// A rule whose value can be switched off (daily loss, consistency, position cap).
function OptionalRule({
  id,
  label,
  on,
  onToggle,
  value,
  onValue,
  unit,
  error,
}: {
  id: string
  label: string
  on: boolean
  onToggle: (v: boolean) => void
  value: string
  onValue: (v: string) => void
  unit: '$' | '%' | 'contracts'
  error?: string
}) {
  return (
    <Field id={id} label={label} error={error} action={<Switch checked={on} onChange={onToggle} label={`${label} on`} tone="neutral" />}>
      {unit === '$' ? (
        <MoneyInput value={on ? value : ''} onChange={onValue} label={label} invalid={!!error} disabled={!on} placeholder={on ? undefined : 'Off'} />
      ) : (
        <div className="relative">
          <input
            type="number"
            min={0}
            value={on ? value : ''}
            disabled={!on}
            placeholder={on ? undefined : 'Off'}
            aria-label={label}
            aria-invalid={error ? true : undefined}
            onChange={(e) => onValue(e.target.value)}
            className="propbt-input w-full"
          />
          {on && <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-text-muted">{unit}</span>}
        </div>
      )}
    </Field>
  )
}

export default function NewSessionDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const contentRef = useRef<HTMLDivElement>(null)
  useModalFocus(contentRef, open)
  const selectSession = useUiStore((s) => s.selectSession)
  const createSession = useCreateBtSession()
  const { data: options } = useSessionSetupOptions(open)

  const [advanced, setAdvanced] = useState(false)
  const [name, setName] = useState('')
  const [balanceText, setBalanceText] = useState('50000')
  // Multi-select (G7): MNQ, MES or both. The first picked is the session's primary
  // (the chart's first symbol); at least one stays selected.
  const [assets, setAssets] = useState<string[]>(['MNQ'])
  const [startDate, setStartDate] = useState('')
  const [startTime, setStartTime] = useState(DEFAULT_START_TIME)
  const [endDate, setEndDate] = useState('')
  const [randomStart, setRandomStart] = useState(false)
  const [randomDays, setRandomDays] = useState(String(DEFAULT_RANDOM_LENGTH_DAYS))
  // advanced
  const [commissionText, setCommissionText] = useState<Record<string, string>>({})
  const [disciplineLock, setDisciplineLock] = useState(false)
  const [checklist, setChecklist] = useState<string[]>([''])
  const [propOn, setPropOn] = useState(false)
  const [draft, setDraft] = useState<RuleDraft | null>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const balance = Number(balanceText.replace(/[^0-9.]/g, '')) || 0
  // The assets share one cursor, so the window must lie in the data they all have.
  const range = combinedRange(options?.ranges, assets)
  const multi = assets.length > 1
  const presets = options?.presets ?? []

  const windowResult = useMemo(
    () =>
      resolveWindow({
        startDate,
        startTime,
        endDate,
        range,
        asset: assetsLabel(assets),
        dataOf: assets.length > 1 ? `the shared ${assetsLabel(assets)}` : undefined,
      }),
    [startDate, startTime, endDate, range, assets],
  )
  const lengthDays = Number(randomDays)
  const lengthError = randomStart ? randomLengthError(lengthDays) : undefined
  const startMissing = !randomStart && !startDate

  const ruleResult = useMemo(() => (advanced && propOn && draft ? rulesFromDraft(draft, balance) : null), [advanced, propOn, draft, balance])
  const rules = ruleResult?.rules ?? null
  const matched = rules ? matchingPreset(rules, balance, presets) : null

  const commissionFor = (sym: string) => commissionText[sym] ?? (options?.default_commissions[sym] ?? 1.3).toFixed(2)
  const commissionValues: Record<string, number> = Object.fromEntries(
    assets.map((sym) => [sym, advanced ? Number(commissionFor(sym)) : (options?.default_commissions[sym] ?? 1.3)]),
  )
  const commissionError = advanced && assets.some((sym) => !(Number(commissionFor(sym)) >= 0 && commissionFor(sym).trim() !== '')) ? 'Enter a commission of $0 or more.' : undefined
  const toggleAsset = (sym: string) =>
    setAssets((cur) => (cur.includes(sym) ? (cur.length > 1 ? cur.filter((a) => a !== sym) : cur) : [...cur, sym]))

  // Everything that keeps Create disabled, in the order the fields appear. The footer
  // always states the first one -- even when its field is scrolled out of view -- and
  // clicking it scrolls to that field.
  const blockers: { message: string; field: string | null }[] = []
  if (!options) blockers.push({ message: 'Loading the data range…', field: null })
  if (balance <= 0) blockers.push({ message: 'Enter an account balance above $0.', field: 'balance' })
  if (randomStart) {
    if (lengthError) blockers.push({ message: lengthError, field: 'end' })
  } else {
    if (startMissing) blockers.push({ message: 'Choose a start date.', field: 'start' })
    if (windowResult.errors.start) blockers.push({ message: windowResult.errors.start, field: 'start' })
    if (windowResult.errors.end) blockers.push({ message: windowResult.errors.end, field: 'end' })
  }
  if (commissionError) blockers.push({ message: commissionError, field: 'commission' })
  if (advanced && propOn && ruleResult) {
    const order = ['profitTarget', 'maxLoss', 'dailyLoss', 'consistency', 'cap', 'newsWindow', 'closeTime'] as const
    for (const key of order) {
      const message = ruleResult.errors[key]
      if (message) blockers.push({ message, field: key })
    }
  }
  const blocker = blockers[0] ?? null
  const canSubmit = blocker === null && !createSession.isPending

  const scrollToField = (field: string) => {
    const el = contentRef.current?.querySelector<HTMLElement>(`[data-field="${field}"]`)
    if (!el) return
    el.scrollIntoView({ block: 'center' })
    el.querySelector<HTMLElement>('input, select')?.focus()
  }

  if (!open) return null

  const togglePropOn = (on: boolean) => {
    setPropOn(on)
    if (on && !draft && presets[0]) {
      setDraft(draftFromRules(presets[0].rules))
      setBalanceText(String(presets[0].starting_balance))
    }
  }

  const pickPreset = (id: string) => {
    const preset = presets.find((p) => p.id === id)
    if (!preset) return
    setDraft(draftFromRules(preset.rules))
    setBalanceText(String(preset.starting_balance))
  }

  const patch = (p: Partial<RuleDraft>) => setDraft((d) => (d ? { ...d, ...p } : d))

  const applySpan = (span: QuickSpan) => {
    if (randomStart) setRandomDays(String(SPAN_DAYS[span]))
    else setEndDate(endDateFor(startDate, span))
  }

  const handleCreate = () => {
    if (!canSubmit) return
    const body = buildCreateRequest({
      name,
      balance,
      assets,
      window: randomStart ? null : windowResult.window,
      random: randomStart ? { days: lengthDays } : null,
      commissions: commissionValues,
      disciplineLock: advanced && disciplineLock,
      checklist: advanced ? checklist : [],
      prop: advanced && propOn && rules ? { rules, preset: matched } : null,
    })
    createSession.mutate(body, {
      onSuccess: (session) => {
        selectSession(session.id)
        onClose()
      },
    })
  }

  const errors = ruleResult?.errors ?? {}

  return (
    <div className="propbt-cmdk-overlay" onClick={onClose}>
      <div
        ref={contentRef}
        className="propbt-settings-content flex max-h-[80vh] flex-col"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={advanced ? 'Create an advanced session' : 'Create a quick session'}
      >
        <div className="flex flex-none items-center justify-between gap-3 border-b border-border px-4 py-3">
          <h2 className="text-base font-medium text-text">{advanced ? 'Create an advanced session' : 'Create a quick session'}</h2>
          <div className="flex items-center gap-1">
            <button type="button" onClick={() => setAdvanced((v) => !v)} aria-pressed={advanced} className={`${GHOST_BUTTON} ${advanced ? 'bg-surface-2 text-text' : ''}`}>
              Advanced session
            </button>
            <button type="button" onClick={onClose} aria-label="Close" className={`${GHOST_BUTTON} flex w-7 items-center justify-center px-0`}>
              <X size={16} aria-hidden />
            </button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 py-4">
          <Field label="Name">
            <input type="text" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Name your session" aria-label="Name" className="propbt-input w-full" />
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field id="balance" label="Account balance">
              <MoneyInput value={balanceText} onChange={(raw) => setBalanceText(raw.split('.')[0])} label="Account balance" />
            </Field>
            <Field label="Assets" hint={multi ? 'One cursor and one account; the position cap counts both.' : undefined}>
              <div role="group" aria-label="Assets" className="flex items-center gap-2">
                {ASSETS.map((sym) => {
                  const on = assets.includes(sym)
                  return (
                    <button
                      key={sym}
                      type="button"
                      role="checkbox"
                      aria-checked={on}
                      aria-label={sym}
                      title={on && assets.length === 1 ? 'A session needs at least one asset' : undefined}
                      onClick={() => toggleAsset(sym)}
                      className={`${CHIP} ${on ? CHIP_ON : ''}`}
                    >
                      {sym}
                    </button>
                  )
                })}
              </div>
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Field
              id="start"
              label="Start date"
              value={randomStart ? undefined : fmtIsoDateLong(startDate)}
              hint={randomStart ? 'Picked at random inside the data when you create the session, and not shown.' : rangeHint(range)}
              error={randomStart ? undefined : windowResult.errors.start}
              action={
                <button type="button" onClick={() => setRandomStart((v) => !v)} aria-pressed={randomStart} className={`${CHIP} ${randomStart ? CHIP_ON : ''}`}>
                  Random start
                </button>
              }
            >
              {randomStart ? (
                <div className="propbt-input flex items-center text-text-muted" aria-label="Start date (random)">
                  Random
                </div>
              ) : (
                <div className="flex gap-2">
                  <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} aria-label="Start date" aria-invalid={windowResult.errors.start ? true : undefined} className="propbt-input min-w-0 flex-1" />
                  <ClockInput value={startTime} onChange={setStartTime} label={`Start time (${ET_LABEL})`} invalid={!!windowResult.errors.start && !windowResult.window} className="w-28 flex-none" />
                </div>
              )}
            </Field>

            <Field
              id="end"
              label={randomStart ? 'Length' : 'End date'}
              value={randomStart ? undefined : fmtIsoDateLong(endDate)}
              hint={randomStart ? 'In days. +1D / +1W / +1M set it to 1, 7 or 30.' : endDate ? rangeHint(range) : `${rangeHint(range)} · leave empty to replay without an end`}
              error={randomStart ? lengthError : windowResult.errors.end}
              action={
                <div className="flex items-center gap-1">
                  {SPANS.map((span) => (
                    <button
                      key={span}
                      type="button"
                      onClick={() => applySpan(span)}
                      disabled={!randomStart && !startDate}
                      title={!randomStart && !startDate ? 'Choose a start date first' : undefined}
                      className={CHIP}
                    >
                      +{span}
                    </button>
                  ))}
                </div>
              }
            >
              {randomStart ? (
                <input type="number" min={1} max={366} value={randomDays} onChange={(e) => setRandomDays(e.target.value)} aria-label="Length in days" aria-invalid={lengthError ? true : undefined} className="propbt-input w-full" />
              ) : (
                <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} aria-label="End date" aria-invalid={windowResult.errors.end ? true : undefined} className="propbt-input w-full" />
              )}
            </Field>
          </div>

          {advanced && (
            <>
              <Section title="Commissions">
                {assets.map((sym, i) => (
                  <Field key={sym} id={i === 0 ? 'commission' : `commission-${sym}`} label={`${sym} · per contract, round turn`} error={i === 0 ? commissionError : undefined}>
                    <MoneyInput
                      value={commissionFor(sym)}
                      onChange={(raw) => setCommissionText((c) => ({ ...c, [sym]: raw }))}
                      label={`${sym} commission per contract`}
                      invalid={!!commissionError}
                      className="max-w-48"
                    />
                  </Field>
                ))}
              </Section>

              <Section title="Discipline">
                <ToggleRow
                  label="Discipline lock"
                  hint="Once you place a trade the replay cannot step back, scrub or reset its start to before it."
                  checked={disciplineLock}
                  onChange={setDisciplineLock}
                />
              </Section>

              <Section title="Strategy checklist">
                <p className="-mt-1 text-[11px] text-text-muted">Rules that become tick-boxes in the order dialog.</p>
                <div className="flex flex-col gap-2">
                  {checklist.map((rule, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <input
                        type="text"
                        value={rule}
                        maxLength={200}
                        placeholder="e.g. Wait for the liquidity sweep"
                        aria-label={`Checklist rule ${i + 1}`}
                        onChange={(e) => setChecklist((c) => c.map((r, j) => (j === i ? e.target.value : r)))}
                        className="propbt-input min-w-0 flex-1"
                      />
                      <button
                        type="button"
                        onClick={() => setChecklist((c) => (c.length === 1 ? [''] : c.filter((_, j) => j !== i)))}
                        aria-label={`Remove checklist rule ${i + 1}`}
                        className={`${GHOST_BUTTON} flex w-7 flex-none items-center justify-center px-0`}
                      >
                        <X size={16} aria-hidden />
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() => setChecklist((c) => [...c, ''])}
                    disabled={checklist.length >= MAX_CHECKLIST_RULES}
                    className={`${GHOST_BUTTON} -ml-2 self-start`}
                  >
                    Add a rule
                  </button>
                </div>
              </Section>

              <Section title="Prop firm">
                <ToggleRow
                  label="Run as a prop firm session"
                  hint="Judged by the rules below: pass at the target, fail at the loss floor. The replay cannot be rewound."
                  checked={propOn}
                  onChange={togglePropOn}
                  disabled={presets.length === 0}
                />
                {propOn && draft && (
                  <div className="flex flex-col gap-6">
                    <Field label="Preset">
                      <select value={matched?.id ?? 'custom'} onChange={(e) => pickPreset(e.target.value)} aria-label="Preset" className="propbt-input w-full">
                        {presets.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.label}
                          </option>
                        ))}
                        <option value="custom" disabled={!!matched}>
                          Custom
                        </option>
                      </select>
                    </Field>

                    <div className="grid grid-cols-2 gap-4">
                      <Field id="profitTarget" label="Profit target" error={errors.profitTarget}>
                        <MoneyInput value={draft.profitTarget} onChange={(raw) => patch({ profitTarget: raw })} label="Profit target" invalid={!!errors.profitTarget} />
                      </Field>
                      <Field id="maxLoss" label="Max loss" error={errors.maxLoss}>
                        <MoneyInput value={draft.maxLoss} onChange={(raw) => patch({ maxLoss: raw })} label="Max loss" invalid={!!errors.maxLoss} />
                      </Field>
                    </div>

                    <Field label="Max loss type" hint={LOSS_TYPES.find((t) => t.id === draft.maxLossType)?.hint}>
                      <div
                        role="radiogroup"
                        aria-label="Max loss type"
                        className="flex gap-1 rounded bg-bg p-1"
                        onKeyDown={(e) => {
                          if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
                          e.preventDefault()
                          const i = LOSS_TYPES.findIndex((t) => t.id === draft.maxLossType)
                          const next = LOSS_TYPES[(i + (e.key === 'ArrowRight' ? 1 : LOSS_TYPES.length - 1)) % LOSS_TYPES.length]
                          patch({ maxLossType: next.id })
                          ;(e.currentTarget.querySelector(`[data-loss="${next.id}"]`) as HTMLElement | null)?.focus()
                        }}
                      >
                        {LOSS_TYPES.map((t) => (
                          <button
                            key={t.id}
                            type="button"
                            role="radio"
                            data-loss={t.id}
                            aria-checked={draft.maxLossType === t.id}
                            tabIndex={draft.maxLossType === t.id ? 0 : -1}
                            onClick={() => patch({ maxLossType: t.id })}
                            className={`h-7 flex-1 rounded px-2 text-xs transition-colors hover:text-text active:bg-surface-2-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
                              draft.maxLossType === t.id ? 'bg-surface-2 text-text' : 'text-text-muted'
                            }`}
                          >
                            {t.label}
                          </button>
                        ))}
                      </div>
                    </Field>
                    {draft.maxLossType !== 'static' && (
                      <ToggleRow
                        label="Floor stops at the starting balance"
                        hint="A trailing floor never rises above where the account started."
                        checked={draft.locksAtStart}
                        onChange={(v) => patch({ locksAtStart: v })}
                      />
                    )}

                    <div className="grid grid-cols-3 gap-4">
                      <OptionalRule id="dailyLoss" label="Max daily loss" on={draft.dailyLossOn} onToggle={(v) => patch({ dailyLossOn: v })} value={draft.dailyLoss} onValue={(v) => patch({ dailyLoss: v })} unit="$" error={errors.dailyLoss} />
                      <OptionalRule id="consistency" label="Consistency" on={draft.consistencyOn} onToggle={(v) => patch({ consistencyOn: v })} value={draft.consistency} onValue={(v) => patch({ consistency: v })} unit="%" error={errors.consistency} />
                      <OptionalRule id="cap" label="Position cap" on={draft.capOn} onToggle={(v) => patch({ capOn: v })} value={draft.cap} onValue={(v) => patch({ cap: v })} unit="contracts" error={errors.cap} />
                    </div>

                    <div className="flex flex-col gap-3">
                      <span className="micro-label">Restrictions</span>
                      <ToggleRow
                        label="No overnight holding"
                        hint="Open positions are flattened at the close, and no orders are accepted until the market reopens."
                        checked={draft.noOvernight}
                        onChange={(v) => patch({ noOvernight: v })}
                      />
                      <ToggleRow
                        label="No weekend holding"
                        hint="The same, on Fridays."
                        checked={draft.noWeekend}
                        onChange={(v) => patch({ noWeekend: v })}
                      />
                      {(draft.noOvernight || draft.noWeekend) && (
                        <Field id="closeTime" label={`Close at (${ET_LABEL})`} error={errors.closeTime}>
                          <ClockInput value={draft.closeTime} onChange={(v) => patch({ closeTime: v })} label={`Close time (${ET_LABEL})`} invalid={!!errors.closeTime} className="w-32" />
                        </Field>
                      )}
                      <ToggleRow
                        label="No news trading"
                        hint="No entries within a window either side of a high-impact economic event."
                        checked={draft.noNews}
                        onChange={(v) => patch({ noNews: v })}
                      />
                      {draft.noNews && (
                        <Field id="newsWindow" label="News window (minutes either side)" error={errors.newsWindow}>
                          <input
                            type="number"
                            min={1}
                            max={120}
                            step={1}
                            value={draft.newsWindow}
                            onChange={(e) => patch({ newsWindow: e.target.value })}
                            aria-label="News window in minutes"
                            aria-invalid={errors.newsWindow ? true : undefined}
                            className="propbt-input w-32"
                          />
                        </Field>
                      )}
                    </div>
                  </div>
                )}
              </Section>
            </>
          )}

          {createSession.isError && (
            <div className="text-xs text-negative-fg" role="alert">
              {(createSession.error as Error).message}
            </div>
          )}
        </div>

        <div className="flex flex-none items-center justify-end gap-3 border-t border-border px-4 py-3">
          {blocker && !createSession.isPending && (
            <span className="mr-auto min-w-0 flex-1 truncate text-[11px] text-text-muted" role="status" title={blocker.message}>
              {blocker.field ? (
                <button
                  type="button"
                  onClick={() => scrollToField(blocker.field as string)}
                  title={`${blocker.message} (go to the field)`}
                  className="-my-1 max-w-full truncate rounded py-1 text-left underline decoration-text-muted/40 underline-offset-2 transition-colors hover:text-text hover:decoration-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                >
                  {blocker.message}
                </button>
              ) : (
                blocker.message
              )}
            </span>
          )}
          <button type="button" onClick={onClose} className={`${GHOST_BUTTON} text-text`}>
            Cancel
          </button>
          <button
            type="button"
            onClick={handleCreate}
            disabled={!canSubmit}
            className="h-7 rounded bg-accent px-3 text-xs text-on-accent transition-opacity hover:opacity-90 active:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40"
          >
            {createSession.isPending ? 'Creating…' : 'Create session'}
          </button>
        </div>
      </div>
    </div>
  )
}
