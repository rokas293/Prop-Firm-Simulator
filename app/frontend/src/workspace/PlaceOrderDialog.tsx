// FXR_V2_SPEC.md phase G3, section 3.5 (references R2 and R3): the Place Order
// dialog. Opened from the position tool (pre-filled from it) or empty from the
// top bar. Structure follows the references: an Estimated loss / profit header,
// the balance basis, risk chips and the linked Risk % / Risk $ fields, the size
// and entry, the stop loss and take profit blocks (price and ticks linked), auto
// break-even, tags, side and type, the session checklist, and Discard / Save /
// Save & Journal at the foot.
//
// All the rules (sizing, linking, validation, the Topstep cap) live in
// chart/orderTicket.ts; this file only renders the form it returns and calls the
// edit functions. It holds no trading maths of its own.
import { useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'
import Switch from '../components/Switch'
import { useModalFocus } from '../components/useModalFocus'
import { fmtUsd } from '../format'
import {
  RISK_CHIPS,
  actualRiskNote,
  buildOrder,
  initialForm,
  parseNumber,
  setAutoBreakeven,
  setBasis,
  setContracts,
  setEntry,
  setLevelPrice,
  setLevelTicks,
  setRiskPct,
  setRiskUsd,
  setSide,
  setType,
  summarize,
  toggleLevel,
  validate,
  type BalanceBasis,
  type IssueField,
  type LevelKind,
  type OrderContext,
  type OrderForm,
  type OrderKind,
  type OrderRequest,
  type PositionToolLevels,
} from '../chart/orderTicket'
import type { Side } from '../chart/simBroker'

const FIELD_LABEL = 'text-xs text-text-muted'
const HELP = 'text-xs text-text-muted'
const ERROR = 'text-xs text-negative-fg'
const SECTION = 'rounded bg-surface-2 px-3 py-2'
const GHOST_BUTTON =
  'h-8 rounded px-3 text-xs text-text-muted transition-colors hover:bg-surface-2 hover:text-text active:bg-surface-2-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40'

const SHORT_REASON: Record<IssueField, string> = {
  entry: 'Enter an entry price',
  type: 'The type does not fit the price',
  sl: 'Check the stop loss',
  tp: 'Check the take profit',
  risk: 'Enter a risk amount',
  contracts: 'Check the position size',
  breakeven: 'Break-even needs a stop loss',
}

export interface PlaceOrderDialogProps {
  ctx: OrderContext
  // The position tool the dialog was opened from; null = opened empty.
  tool: PositionToolLevels | null
  initial: { riskPct: number; basis: BalanceBasis; autoBreakeven: boolean; type?: OrderKind }
  // Tags already used in this session's journal, offered alongside new ones.
  existingTags: string[]
  // The session's strategy rules (tick-boxes); empty = no checklist section.
  checklistRules: string[]
  // "Topstep" etc. for the position-limit hint on a capped session.
  capLabel: string | null
  onBasisChange: (basis: BalanceBasis) => void
  onSave: (order: OrderRequest, journal: boolean) => void
  // Discard drops the order AND the tool; close (x / Esc / click outside) keeps
  // the tool on the chart so it can be adjusted.
  onDiscard: () => void
  onClose: () => void
}

function Field({ label, htmlFor, error, help, children }: { label: string; htmlFor: string; error?: string | null; help?: string | null; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={htmlFor} className={FIELD_LABEL}>
        {label}
      </label>
      {children}
      {error ? (
        <p className={ERROR} role="alert">
          {error}
        </p>
      ) : help ? (
        <p className={HELP}>{help}</p>
      ) : null}
    </div>
  )
}

// A text input with a unit sitting inside it ($ before, % / ticks after).
function UnitInput({
  id,
  value,
  onChange,
  prefix,
  suffix,
  disabled,
  invalid,
  readOnly,
  onBlur,
}: {
  id: string
  value: string
  onChange: (v: string) => void
  prefix?: string
  suffix?: string
  disabled?: boolean
  invalid?: boolean
  readOnly?: boolean
  onBlur?: () => void
}) {
  return (
    <div className="relative">
      {prefix && <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-text-muted">{prefix}</span>}
      <input
        id={id}
        inputMode="decimal"
        autoComplete="off"
        value={value}
        disabled={disabled}
        readOnly={readOnly}
        aria-invalid={invalid || undefined}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        className={`propbt-input w-full ${prefix ? 'propbt-input--prefix' : ''} ${suffix ? 'propbt-input--suffix' : ''} ${invalid ? '!border-negative' : ''}`}
      />
      {suffix && <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-text-muted">{suffix}</span>}
    </div>
  )
}

function TagPicker({ selected, existing, onChange }: { selected: string[]; existing: string[]; onChange: (tags: string[]) => void }) {
  const [draft, setDraft] = useState('')
  const inputId = useId()
  const add = (raw: string) => {
    const tag = raw.trim()
    setDraft('')
    if (tag && !selected.includes(tag)) onChange([...selected, tag])
  }
  const suggestions = existing.filter((t) => !selected.includes(t) && t.toLowerCase().includes(draft.trim().toLowerCase()))
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={inputId} className={FIELD_LABEL}>
        Tags
      </label>
      {selected.length > 0 && (
        <ul className="flex flex-wrap gap-1" aria-label="Selected tags">
          {selected.map((tag) => (
            <li key={tag} className="flex h-6 items-center gap-1 rounded bg-surface-2 pl-2 pr-1 text-xs text-text">
              {tag}
              <button
                type="button"
                onClick={() => onChange(selected.filter((t) => t !== tag))}
                aria-label={`Remove tag ${tag}`}
                className="flex h-4 w-4 items-center justify-center rounded text-text-muted hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              >
                <X size={12} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      <input
        id={inputId}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            add(draft)
          }
        }}
        placeholder="Select a tag or type a new one, then Enter"
        autoComplete="off"
        className="propbt-input w-full"
      />
      {suggestions.length > 0 && (
        <ul className="flex flex-wrap gap-1" aria-label="Existing tags">
          {suggestions.map((tag) => (
            <li key={tag}>
              <button
                type="button"
                onClick={() => add(tag)}
                className="h-6 rounded px-2 text-xs text-text-muted transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              >
                {tag}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default function PlaceOrderDialog({
  ctx,
  tool,
  initial,
  existingTags,
  checklistRules,
  capLabel,
  onBasisChange,
  onSave,
  onDiscard,
  onClose,
}: PlaceOrderDialogProps) {
  const contentRef = useRef<HTMLDivElement>(null)
  useModalFocus(contentRef, true)
  const uid = useId()
  const id = (name: string) => `${uid}-${name}`

  const [form, setForm] = useState<OrderForm>(() => initialForm(ctx, { tool, ...initial }))
  const edit = (fn: (f: OrderForm) => OrderForm) => setForm((f) => fn(f))

  const summary = useMemo(() => summarize(form, ctx), [form, ctx])
  const issues = useMemo(() => validate(form, ctx), [form, ctx])
  const issueFor = (field: IssueField) => issues.find((i) => i.field === field)?.message ?? null
  const note = actualRiskNote(form, summary, ctx)
  const contractsIssue = issueFor('contracts')
  const sizeMessage: { text: string; refusal: boolean } | null = contractsIssue
    ? { text: contractsIssue, refusal: true }
    : note
      ? { text: note, refusal: false }
      : ctx.cap !== null
        ? { text: `Up to ${ctx.cap} contracts${capLabel ? ` (${capLabel} limit)` : ''}.`, refusal: false }
        : null
  const canSave = issues.length === 0

  const save = (journal: boolean) => {
    const built = buildOrder(form, ctx)
    if (built.ok) onSave(built.order, journal)
  }

  const slLoss = summary.estimatedLoss
  const tpGain = summary.estimatedProfit
  const marketLocked = form.type === 'market' && !form.typeAuto

  const levelBlock = (kind: LevelKind) => {
    const on = kind === 'sl' ? form.slOn : form.tpOn
    const name = kind === 'sl' ? 'Stop loss' : 'Take profit'
    return (
      <div className="flex flex-col gap-2">
        <div className={`${SECTION} flex items-center justify-between`}>
          <span className="text-xs text-text">{name}</span>
          <Switch checked={on} onChange={(v) => edit((f) => toggleLevel(f, ctx, kind, v))} label={name} />
        </div>
        {on && (
          <div className="grid grid-cols-2 gap-3">
            <Field label={name} htmlFor={id(`${kind}-price`)} error={issueFor(kind)}>
              <UnitInput
                id={id(`${kind}-price`)}
                value={kind === 'sl' ? form.slPrice : form.tpPrice}
                onChange={(v) => edit((f) => setLevelPrice(f, ctx, kind, v))}
                invalid={issueFor(kind) !== null}
              />
            </Field>
            <Field label={`${name} in ticks`} htmlFor={id(`${kind}-ticks`)}>
              <UnitInput
                id={id(`${kind}-ticks`)}
                value={kind === 'sl' ? form.slTicks : form.tpTicks}
                onChange={(v) => edit((f) => setLevelTicks(f, ctx, kind, v))}
                suffix="ticks"
              />
            </Field>
          </div>
        )}
      </div>
    )
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-start pl-16 pt-14"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={contentRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id('title')}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            onClose()
          }
        }}
        className="propbt-fade-in flex max-h-[calc(100vh-96px)] w-[420px] max-w-[calc(100vw-96px)] flex-col rounded border border-border bg-surface shadow-lg"
      >
        <div className="flex items-center justify-between px-4 pt-4">
          <h2 id={id('title')} className="text-base font-medium text-text">
            Place order
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-7 w-7 items-center justify-center rounded text-text-muted transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          >
            <X size={16} aria-hidden />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
          <div className={`${SECTION} flex items-center justify-between text-xs text-text-muted`} aria-label="Estimate">
            <span>
              Estimated loss{' '}
              <span className="tabular-nums text-negative-fg" data-testid="est-loss">
                {slLoss !== null ? `-${fmtUsd(slLoss)}` : '–'}
              </span>
            </span>
            <span>
              Estimated profit{' '}
              <span className="tabular-nums text-positive-fg" data-testid="est-profit">
                {tpGain !== null ? fmtUsd(tpGain) : '–'}
              </span>
            </span>
          </div>

          <fieldset className="flex items-center gap-4">
            <legend className="sr-only">Balance used for risk</legend>
            {(['initial', 'current'] as const).map((basis) => (
              <label key={basis} className="flex items-center gap-2 text-xs text-text">
                <input
                  type="radio"
                  name={id('basis')}
                  checked={form.basis === basis}
                  onChange={() => {
                    edit((f) => setBasis(f, ctx, basis))
                    onBasisChange(basis)
                  }}
                  className="accent-accent"
                />
                {basis === 'initial' ? 'Initial balance' : 'Current balance'}
              </label>
            ))}
          </fieldset>

          <div className="flex flex-col gap-2">
            <span className={FIELD_LABEL} id={id('chips')}>
              Set risk percentage
            </span>
            <div className="flex gap-1" role="group" aria-labelledby={id('chips')}>
              {RISK_CHIPS.map((pct) => {
                const active = parseNumber(form.riskPct) === pct
                return (
                  <button
                    key={pct}
                    type="button"
                    aria-pressed={active}
                    onClick={() => edit((f) => setRiskPct(f, ctx, String(pct)))}
                    className={`h-7 flex-1 rounded text-xs tabular-nums transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
                      active ? 'bg-selection text-accent-fg ring-1 ring-inset ring-accent/40' : 'bg-surface-2 text-text-muted hover:bg-surface-2-hover hover:text-text active:bg-surface-2-hover'
                    }`}
                  >
                    {pct}%
                  </button>
                )
              })}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Risk percent" htmlFor={id('risk-pct')}>
              <UnitInput id={id('risk-pct')} value={form.riskPct} onChange={(v) => edit((f) => setRiskPct(f, ctx, v))} suffix="%" />
            </Field>
            <Field label="Risk amount" htmlFor={id('risk-usd')} error={issueFor('risk')}>
              <UnitInput id={id('risk-usd')} value={form.riskUsd} onChange={(v) => edit((f) => setRiskUsd(f, ctx, v))} prefix="$" invalid={issueFor('risk') !== null} />
            </Field>
            <Field label="Position size (contracts)" htmlFor={id('contracts')}>
              <UnitInput id={id('contracts')} value={form.contracts} onChange={(v) => edit((f) => setContracts(f, v))} invalid={issueFor('contracts') !== null} />
            </Field>
            <Field label="Entry price" htmlFor={id('entry')} error={issueFor('entry')} help={marketLocked ? 'Fills at the current price.' : null}>
              <UnitInput id={id('entry')} value={form.entry} onChange={(v) => edit((f) => setEntry(f, ctx, v))} readOnly={marketLocked} invalid={issueFor('entry') !== null} />
            </Field>
            {/* The size's own message spans both columns: why the risk differs, the
                position limit, or the reason a size is refused. */}
            {sizeMessage && (
              <p className={`col-span-2 -mt-1 ${sizeMessage.refusal ? ERROR : HELP}`} role={sizeMessage.refusal ? 'alert' : undefined} data-testid="size-note">
                {sizeMessage.text}
              </p>
            )}
          </div>

          {levelBlock('sl')}
          {levelBlock('tp')}

          <div className="flex flex-col gap-1">
            <div className={`${SECTION} flex items-center justify-between`}>
              <span className="text-xs text-text">Auto break-even</span>
              <Switch
                checked={form.autoBreakeven}
                onChange={(v) => edit((f) => setAutoBreakeven(f, v))}
                label="Auto break-even"
                disabled={!form.slOn}
              />
            </div>
            <p className={issueFor('breakeven') ? ERROR : HELP}>
              {issueFor('breakeven') ?? (form.slOn ? 'Moves the stop to the entry once the trade is up 1R.' : 'Needs a stop loss.')}
            </p>
          </div>

          <TagPicker selected={form.tags} existing={existingTags} onChange={(tags) => edit((f) => ({ ...f, tags }))} />

          <div className="grid grid-cols-2 gap-3">
            <Field label="Side" htmlFor={id('side')}>
              <select
                id={id('side')}
                value={form.side}
                onChange={(e) => edit((f) => setSide(f, ctx, e.target.value as Side))}
                className="propbt-input w-full"
              >
                <option value="long">Buy</option>
                <option value="short">Sell</option>
              </select>
            </Field>
            <Field label="Type" htmlFor={id('type')} error={issueFor('type')}>
              <select
                id={id('type')}
                value={form.type}
                onChange={(e) => edit((f) => setType(f, ctx, e.target.value as OrderKind))}
                aria-invalid={issueFor('type') !== null || undefined}
                className={`propbt-input w-full ${issueFor('type') ? '!border-negative' : ''}`}
              >
                <option value="market">Market</option>
                <option value="limit">Limit</option>
                <option value="stop">Stop</option>
              </select>
            </Field>
          </div>

          {checklistRules.length > 0 && (
            <fieldset className="flex flex-col gap-2">
              <legend className={`${FIELD_LABEL} mb-1`}>Checklist</legend>
              {checklistRules.map((rule) => (
                <label key={rule} className="flex items-start gap-2 text-xs text-text">
                  <input
                    type="checkbox"
                    checked={form.checklist.includes(rule)}
                    onChange={(e) =>
                      edit((f) => ({ ...f, checklist: e.target.checked ? [...f.checklist, rule] : f.checklist.filter((r) => r !== rule) }))
                    }
                    className="mt-0.5 accent-accent"
                  />
                  <span>{rule}</span>
                </label>
              ))}
            </fieldset>
          )}
        </div>

        <div className="flex items-center gap-2 px-4 py-3">
          {/* The full reason is inline at its field (and in the buttons' title); this
              is only the pointer for when that field is scrolled out of view. */}
          <p className={`min-w-0 flex-1 truncate text-xs ${canSave ? 'text-text-muted' : 'text-negative-fg'}`} data-testid="refusal">
            {canSave ? '' : SHORT_REASON[issues[0].field]}
          </p>
          <button type="button" onClick={onDiscard} className={GHOST_BUTTON}>
            Discard
          </button>
          <button
            type="button"
            onClick={() => save(false)}
            disabled={!canSave}
            title={canSave ? undefined : issues[0].message}
            className="h-8 rounded bg-surface-2 px-3 text-xs text-text transition-colors hover:bg-surface-2-hover active:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-surface-2"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => save(true)}
            disabled={!canSave}
            title={canSave ? undefined : issues[0].message}
            className="h-8 rounded bg-accent px-3 text-xs text-on-accent transition-opacity hover:opacity-90 active:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40"
          >
            Save &amp; Journal
          </button>
        </div>
      </div>
    </div>
  )
}
