// FXR_SPEC.md section C, phase F5: journaling on top of the auto-logged
// manual trades (F2-F4). A right-side drawer inside SessionWorkspace (not a
// dockable panel like TradeListPanel -- this is a per-session, chart-
// adjacent surface, not a sibling of a multi-panel workspace), reusing that
// panel's table/filter/EmptyState conventions at a narrower width.
//
// Two stacked sections: a compact trade list (top, filterable by tag/
// setup/session/grade/hour -- the SAME shared filter set (state/tradeStore)
// the analytics workspace's trade list, chart and Dashboard cross-filter
// use, so a filter set there narrows this list too, FXR_SPEC.md phase F6) and the selected trade's editor (bottom: notes, tags,
// setup name, grade, screenshots). Session-level notes sit above both.
// This panel holds no journal data of its own beyond in-progress drafts, so
// a reload always reflects exactly what the backend has.
//
// Tags draft LOCALLY (not read straight off the `trades` prop) because
// onUpdateTradeJournal PATCHes the FULL tags array -- two of those fired
// back-to-back (e.g. typing two tags quickly) would otherwise both compute
// their "next array" from the same stale server-confirmed `selected.tags`,
// and whichever PATCH's response lands last on the backend's read-modify-
// write would silently clobber the other. Basing each edit off the local
// draft instead of the server-echoed trade closes that race, confirmed
// live while testing this phase (a second rapid-fire tag add was
// overwriting the first). Screenshots do NOT need this: each add/remove is
// its own endpoint that reads the CURRENT file list server-side and
// returns the resulting trade directly (see onAddScreenshot/
// onDeleteScreenshot's own comment on SessionWorkspace.tsx), so there's no
// client-computed array to race over -- rendered straight off `selected`.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AddScreenshotRequest, ManualTrade, UpdateTradeJournalRequest } from '../api/types'
import { filterManualTrades, nyHourOfDay } from '../compass/breakdowns'
import { useTradeStore } from '../state/tradeStore'
import { fmtPrice, fmtR, fmtUsd } from '../format'
import { fmtEtShort } from '../timeFormat'
import EmptyState from '../components/EmptyState'
import CsvExportMenu from '../components/CsvExportMenu'
import { OPEN_ENTRY_ID, type OpenJournalEntry } from './journalEntry'
import { FILTER_SELECT, FilterChips, FilterField, FiltersPopover } from '../components/FilterBar'
import { activeFilterChips } from '../compass/filterChips'

const GRADES = ['A', 'B', 'C'] as const
type Grade = (typeof GRADES)[number]
type CaptureMoment = 'entry' | 'exit' | 'custom'
const MOMENTS: CaptureMoment[] = ['entry', 'exit', 'custom']


interface JournalPanelProps {
  trades: ManualTrade[]
  // The open trade's entry, until its first exit creates the journaled trade.
  openEntry?: OpenJournalEntry | null
  // A multi-asset session: rows and headers name the instrument.
  showInstrument?: boolean
  onUpdateOpenEntry?: (patch: { notes?: string; tags?: string[] }) => void
  // The session's strategy rules (for showing which were ticked).
  checklistRules?: string[]
  sessionNotes: string | null
  onUpdateSessionNotes: (notes: string) => void
  onJumpToTrade: (trade: ManualTrade) => void
  captureScreenshot: () => string | null
  onUpdateTradeJournal: (tradeId: number, body: UpdateTradeJournalRequest) => void
  onAddScreenshot: (tradeId: number, body: AddScreenshotRequest) => void
  onDeleteScreenshot: (tradeId: number, screenshotId: string) => void
  onClose: () => void
  // The session the journal is of (the CSV export's "this session").
  sessionId?: string | null
  // Opens with this trade selected (handed over from the analytics
  // workspace's "Open in journal") -- applied once, on mount/when it changes.
  initialSelectedId?: number | null
}

export default function JournalPanel({
  trades,
  openEntry = null,
  showInstrument = false,
  onUpdateOpenEntry,
  checklistRules = [],
  sessionNotes,
  onUpdateSessionNotes,
  onJumpToTrade,
  captureScreenshot,
  onUpdateTradeJournal,
  onAddScreenshot,
  onDeleteScreenshot,
  onClose,
  sessionId = null,
  initialSelectedId = null,
}: JournalPanelProps) {
  const filters = useTradeStore((s) => s.filters)
  const setFilter = useTradeStore((s) => s.setFilter)
  const [selectedId, setSelectedId] = useState<number | null>(initialSelectedId)
  const [lightbox, setLightbox] = useState<string | null>(null)
  const [captureMoment, setCaptureMoment] = useState<CaptureMoment>('entry')

  const tagOptions = useMemo(() => [...new Set(trades.flatMap((t) => t.tags))].sort(), [trades])
  const sessionOptions = useMemo(
    () => [...new Set(trades.map((t) => t.session).filter((v): v is string => v !== null))].sort(),
    [trades],
  )
  const setupOptions = useMemo(
    () => [...new Set(trades.map((t) => t.setup_name).filter((v): v is string => !!v))].sort(),
    [trades],
  )
  const hourOptions = useMemo(() => [...new Set(trades.map((t) => nyHourOfDay(t.entry_time)))].sort((a, b) => a - b), [trades])

  const filtered = useMemo(
    () => [...filterManualTrades(trades, filters)].sort((a, b) => b.entry_time - a.entry_time),
    [trades, filters],
  )

  const hasFilters = Object.values(filters).some((v) => v !== null)

  const selected = trades.find((t) => t.trade_id === selectedId) ?? null
  const openSelected = selectedId === OPEN_ENTRY_ID ? openEntry : null

  // The open trade's first exit creates its journaled trade: follow the entry
  // there. (Until that trade is in the list there is nothing to select yet.)
  const openKeyRef = useRef<string | null>(null)
  useEffect(() => {
    if (openEntry) {
      openKeyRef.current = openEntry.tradeKey
      return
    }
    if (selectedId !== OPEN_ENTRY_ID) return
    const created = trades.find((t) => t.trade_key === openKeyRef.current)
    if (created) setSelectedId(created.trade_id)
  }, [openEntry, trades, selectedId])

  // Drafts re-seeded only on trade switch (not on every `trades` update),
  // so a save to one field while another is mid-edit can't clobber it.
  // Tags draft locally (not read straight off `selected`) for the race-
  // avoidance reason in this file's top comment -- every add/remove
  // mutates the draft immediately AND uses it (not `selected`) as the base
  // for the very next add/remove, so two rapid edits compose correctly
  // even before the first one's PATCH has round-tripped.
  const [draftNotes, setDraftNotes] = useState('')
  const [draftSetup, setDraftSetup] = useState('')
  const [draftTags, setDraftTags] = useState<string[]>([])
  const [tagInput, setTagInput] = useState('')
  const seededForRef = useRef<number | null>(null)
  useEffect(() => {
    if (seededForRef.current === selectedId) return
    if (selectedId === OPEN_ENTRY_ID) {
      if (!openEntry) return
      seededForRef.current = selectedId
      setDraftNotes(openEntry.notes)
      setDraftSetup('')
      setDraftTags(openEntry.tags)
      setTagInput('')
      return
    }
    // A trade preselected from outside (initialSelectedId) can arrive before
    // `trades` has loaded -- seeding then would stamp empty drafts and, since
    // this effect never re-seeds for the same id, hide the trade's real
    // notes/tags/setup. Wait until it's actually found.
    if (selectedId !== null && !selected) return
    seededForRef.current = selectedId
    setDraftNotes(selected?.notes ?? '')
    setDraftSetup(selected?.setup_name ?? '')
    setDraftTags(selected?.tags ?? [])
    setTagInput('')
  }, [selectedId, selected, openEntry])

  const saveNotes = () => {
    if (openSelected) {
      if (draftNotes !== openSelected.notes) onUpdateOpenEntry?.({ notes: draftNotes })
      return
    }
    if (selected && draftNotes !== selected.notes) onUpdateTradeJournal(selected.trade_id, { notes: draftNotes })
  }
  const saveSetup = () => {
    if (selected && draftSetup !== (selected.setup_name ?? '')) {
      onUpdateTradeJournal(selected.trade_id, { setup_name: draftSetup.trim() || null })
    }
  }
  const toggleGrade = (g: Grade) => {
    if (!selected) return
    onUpdateTradeJournal(selected.trade_id, { grade: selected.grade === g ? null : g })
  }
  const saveTags = (next: string[]) => {
    if (openSelected) onUpdateOpenEntry?.({ tags: next })
    else if (selected) onUpdateTradeJournal(selected.trade_id, { tags: next })
  }
  const addTag = () => {
    if (!selected && !openSelected) return
    const tag = tagInput.trim()
    if (!tag || draftTags.includes(tag)) {
      setTagInput('')
      return
    }
    const next = [...draftTags, tag]
    setDraftTags(next)
    saveTags(next)
    setTagInput('')
  }
  const removeTag = (tag: string) => {
    if (!selected && !openSelected) return
    const next = draftTags.filter((t) => t !== tag)
    setDraftTags(next)
    saveTags(next)
  }
  const capture = () => {
    if (!selected) return
    const dataUrl = captureScreenshot()
    if (!dataUrl) return
    onAddScreenshot(selected.trade_id, { data_url: dataUrl, moment: captureMoment, caption: null })
  }
  const removeScreenshot = (id: string) => {
    if (!selected) return
    onDeleteScreenshot(selected.trade_id, id)
  }

  const tagsEditor = (
    <div>
      <div className="micro-label mb-2">Tags</div>
      <div className="mb-2 flex flex-wrap gap-2">
        {draftTags.map((tag) => (
          <span key={tag} className="flex items-center gap-1 rounded bg-surface-2 px-2 py-1 text-text">
            {tag}
            <button onClick={() => removeTag(tag)} aria-label={`Remove tag ${tag}`} className="text-text-muted hover:text-text">
              &times;
            </button>
          </span>
        ))}
      </div>
      <input
        value={tagInput}
        onChange={(e) => setTagInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            addTag()
          }
        }}
        onBlur={addTag}
        placeholder="Add a tag, press Enter"
        className="propbt-input w-full"
      />
    </div>
  )
  const notesEditor = (placeholder: string) => (
    <label className="flex flex-col gap-1">
      <span className="micro-label">Notes</span>
      <textarea
        rows={4}
        value={draftNotes}
        onChange={(e) => setDraftNotes(e.target.value)}
        onBlur={saveNotes}
        placeholder={placeholder}
        className="propbt-input w-full resize-none"
      />
    </label>
  )
  // The rules ticked in the Place Order dialog, read-only, against the session's
  // full list so an unticked rule reads as skipped.
  const checklistSummary = (ticked: string[]) => {
    if (ticked.length === 0 && checklistRules.length === 0) return null
    const rules = [...checklistRules, ...ticked.filter((r) => !checklistRules.includes(r))]
    return (
      <div>
        <div className="micro-label mb-2">Checklist</div>
        <ul className="flex flex-col gap-1">
          {rules.map((rule) => (
            <li key={rule} className={`flex items-start gap-2 ${ticked.includes(rule) ? 'text-text' : 'text-text-muted'}`}>
              <span aria-hidden className="w-3 flex-none text-center">
                {ticked.includes(rule) ? '✓' : '·'}
              </span>
              <span>
                {rule}
                <span className="sr-only">{ticked.includes(rule) ? ' (ticked)' : ' (not ticked)'}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    )
  }

  return (
    <div className="flex h-full w-[360px] flex-none flex-col border-l border-border bg-bg">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-[13px] font-medium text-text">Journal</span>
        <span className="ml-auto mr-1">
          <CsvExportMenu sessionId={sessionId} />
        </span>
        <button
          onClick={onClose}
          aria-label="Close journal"
          className="h-7 rounded px-2 text-xs text-text-muted hover:bg-surface-2 hover:text-text"
        >
          Close
        </button>
      </div>

      <div className="border-b border-border p-3">
        <div className="micro-label mb-2">Session notes</div>
        <textarea
          rows={2}
          defaultValue={sessionNotes ?? ''}
          onBlur={(e) => onUpdateSessionNotes(e.target.value)}
          placeholder="How did this session go?"
          className="w-full resize-none rounded border border-transparent bg-surface-2 px-2 py-2 text-xs text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
        />
      </div>

      {/* Same Filters popover + chips as the analytics Trade List, because it
          IS the same filter (state/tradeStore): a filter set there narrows
          this list, so the chips are what keeps that from being silent. The
          count sits in the row, not at the end of a wrapped line. */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs">
        <FiltersPopover count={activeFilterChips(filters).length}>
        <FilterField label="Tag">
  <select
            value={filters.tag ?? ''}
            onChange={(e) => setFilter('tag', e.target.value || null)}
            aria-label="Filter by tag"
            className={FILTER_SELECT}
          >
            <option value="">All</option>
            {tagOptions.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
</FilterField>
        <FilterField label="Setup">
          <select
            value={filters.setup ?? ''}
            onChange={(e) => setFilter('setup', e.target.value || null)}
            aria-label="Filter by setup"
            className={FILTER_SELECT}
          >
            <option value="">All</option>
            {setupOptions.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField label="Session">
          <select
            value={filters.session ?? ''}
            onChange={(e) => setFilter('session', e.target.value || null)}
            aria-label="Filter by session"
            className={FILTER_SELECT}
          >
            <option value="">All</option>
            {sessionOptions.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField label="Hour">
          <select
            value={filters.entryHourNy === null ? '' : String(filters.entryHourNy)}
            onChange={(e) => setFilter('entryHourNy', e.target.value === '' ? null : Number(e.target.value))}
            aria-label="Filter by entry hour (ET)"
            className={FILTER_SELECT}
          >
            <option value="">All</option>
            {hourOptions.map((h) => (
              <option key={h} value={h}>
                {String(h).padStart(2, '0')}:00 ET
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField label="Grade">
          <select
            value={filters.grade ?? ''}
            onChange={(e) => setFilter('grade', e.target.value || null)}
            aria-label="Filter by grade"
            className={FILTER_SELECT}
          >
            <option value="">All</option>
            {GRADES.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        </FilterField>
        </FiltersPopover>
        <FilterChips />
        <span className="ml-auto flex-none whitespace-nowrap tabular-nums text-text-muted">
          {hasFilters ? `${filtered.length} of ${trades.length}` : `${trades.length} trades`}
          {openEntry ? ' · 1 open' : ''}
        </span>
      </div>

      {/* Sized to its rows (capped at 40% of the drawer) so a few trades do
          not leave dead space above the detail; the detail takes the rest. */}
      <div className={`min-h-0 flex-none overflow-auto ${filtered.length === 0 && !openEntry ? 'h-24' : 'max-h-[40%]'}`}>
        {openEntry && (
          <div
            onClick={() => setSelectedId(OPEN_ENTRY_ID)}
            tabIndex={0}
            role="button"
            aria-selected={selectedId === OPEN_ENTRY_ID}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                setSelectedId(OPEN_ENTRY_ID)
              }
            }}
            className={`flex cursor-pointer items-center gap-2 px-3 py-2 text-xs hover:bg-surface ${selectedId === OPEN_ENTRY_ID ? 'bg-surface-2' : ''}`}
          >
            <span className="whitespace-nowrap tabular-nums text-text-muted">{fmtEtShort(openEntry.entryTime)}</span>
            <span className="text-text-muted">{showInstrument ? `${openEntry.instrument} ` : ''}{openEntry.side}</span>
            <span className="num ml-auto text-text-muted">
              {openEntry.contracts} @ {fmtPrice(openEntry.entryPrice, openEntry.instrument)}
            </span>
            <span className="w-12 text-right text-text-muted">Open</span>
          </div>
        )}
        {filtered.length === 0 && !openEntry ? (
          <EmptyState title="No trades yet" hint={hasFilters ? 'No trades match these filters.' : 'Closed trades auto-journal here.'} />
        ) : (
          filtered.map((t) => {
            const isSelected = t.trade_id === selectedId
            return (
              <div
                key={t.trade_id}
                onClick={() => {
                  setSelectedId(t.trade_id)
                  onJumpToTrade(t)
                }}
                tabIndex={0}
                role="button"
                aria-selected={isSelected}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    setSelectedId(t.trade_id)
                    onJumpToTrade(t)
                  }
                }}
                className={`flex cursor-pointer items-center gap-2 px-3 py-2 text-xs hover:bg-surface ${
                  isSelected ? 'bg-surface-2' : ''
                }`}
              >
                <span className="whitespace-nowrap tabular-nums text-text-muted">{fmtEtShort(t.entry_time)}</span>
                <span className="text-text-muted">{showInstrument ? `${t.instrument} ` : ''}{t.side}</span>
                <span className={`num ml-auto ${t.pnl_usd >= 0 ? 'text-positive-fg' : 'text-negative-fg'}`}>{fmtUsd(t.pnl_usd)}</span>
                <span className="num w-12 text-text-muted">{fmtR(t.r_multiple)}</span>
                <span className="w-4 text-center text-text-muted">{t.grade ?? ''}</span>
              </div>
            )
          })
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto border-t border-border">
        {openSelected ? (
          <div className="flex flex-col gap-3 p-3 text-xs" aria-label="Open trade entry">
            <div className="text-text-muted">
              {showInstrument ? `${openSelected.instrument} ` : ''}{openSelected.side} {openSelected.contracts} @ <span className="tabular-nums text-text">{fmtPrice(openSelected.entryPrice, openSelected.instrument)}</span>
              {openSelected.slPrice !== null && (
                <>
                  {' · SL '}
                  <span className="tabular-nums text-text">{fmtPrice(openSelected.slPrice, openSelected.instrument)}</span>
                </>
              )}
              {openSelected.tpPrice !== null && (
                <>
                  {' · TP '}
                  <span className="tabular-nums text-text">{fmtPrice(openSelected.tpPrice, openSelected.instrument)}</span>
                </>
              )}
            </div>
            <p className="text-text-muted">Open trade. Saved with it when it closes; grade and screenshots unlock then.</p>
            {tagsEditor}
            {checklistSummary(openSelected.checklist)}
            {notesEditor('Why this trade, what you are watching for…')}
          </div>
        ) : !selected ? (
          <EmptyState title="No trade selected" hint="Click a trade above to journal it." />
        ) : (
          <div className="flex flex-col gap-3 p-3 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-text-muted">
                {showInstrument ? `${selected.instrument} ` : ''}{selected.side} {selected.size_contracts} @ <span className="tabular-nums text-text">{selected.entry_price.toFixed(2)}</span>
                {' → '}
                <span className="tabular-nums text-text">{selected.exit_price.toFixed(2)}</span>
              </span>
              <button
                onClick={() => onJumpToTrade(selected)}
                className="rounded bg-surface-2 px-2 py-1 text-text hover:bg-surface-2-hover"
              >
                Jump to bar
              </button>
            </div>

            {/* FXR_V2_SPEC.md 3.6: a trade closed in several pieces is ONE trade; its exits are listed here. */}
            {selected.exits && selected.exits.length > 1 && (
              <div>
                <div className="micro-label mb-2">Exits ({selected.exits.length})</div>
                <table className="w-full border-collapse">
                  <tbody>
                    {selected.exits.map((e, i) => (
                      <tr key={i}>
                        <td className="h-7 text-text-muted">{fmtEtShort(e.time)}</td>
                        <td className="num h-7 text-text">{e.contracts}</td>
                        <td className="num h-7 text-text">{fmtPrice(e.price, selected.instrument)}</td>
                        <td className={`num h-7 ${e.pnl_usd > 0 ? 'text-positive-fg' : e.pnl_usd < 0 ? 'text-negative-fg' : 'text-text'}`}>{fmtUsd(e.pnl_usd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <label className="flex flex-col gap-1">
              <span className="micro-label">Setup name</span>
              <input
                value={draftSetup}
                onChange={(e) => setDraftSetup(e.target.value)}
                onBlur={saveSetup}
                placeholder="e.g. Break & Retest"
                className="propbt-input"
              />
            </label>

            <div>
              <div className="micro-label mb-2">Grade</div>
              <div className="flex gap-2">
                {GRADES.map((g) => (
                  <button
                    key={g}
                    onClick={() => toggleGrade(g)}
                    aria-pressed={selected.grade === g}
                    className={`h-7 w-7 rounded text-xs ${
                      selected.grade === g ? 'bg-accent text-on-accent' : 'bg-surface-2 text-text hover:bg-surface-2-hover'
                    }`}
                  >
                    {g}
                  </button>
                ))}
              </div>
            </div>

            {tagsEditor}

            {checklistSummary(selected.checklist ?? [])}

            {notesEditor("What happened, what you saw, what you'd do differently…")}

            <div>
              <div className="mb-2 flex items-center justify-between">
                <span className="micro-label">Screenshots</span>
                <div className="flex items-center gap-2">
                  <select
                    value={captureMoment}
                    onChange={(e) => setCaptureMoment(e.target.value as CaptureMoment)}
                    aria-label="Screenshot moment"
                    className="propbt-input"
                  >
                    {MOMENTS.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                  <button onClick={capture} className="h-7 rounded bg-surface-2 px-2 text-text hover:bg-surface-2-hover">
                    Capture
                  </button>
                </div>
              </div>
              {selected.screenshots.length === 0 ? (
                <div className="text-text-muted">No screenshots yet.</div>
              ) : (
                <div className="grid grid-cols-3 gap-2">
                  {selected.screenshots.map((s) => (
                    <div key={s.id} className="group relative">
                      <img
                        src={s.url}
                        alt={`${s.moment} screenshot`}
                        onClick={() => setLightbox(s.url)}
                        className="h-16 w-full cursor-pointer rounded object-cover"
                      />
                      <span className="pointer-events-none absolute bottom-1 left-1 rounded bg-bg/80 px-1 text-[11px] text-text-muted">
                        {s.moment}
                      </span>
                      <button
                        onClick={() => removeScreenshot(s.id)}
                        aria-label="Remove screenshot"
                        className="absolute right-1 top-1 rounded bg-bg/80 px-1 text-[11px] text-text-muted opacity-0 hover:text-text group-hover:opacity-100"
                      >
                        &times;
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {lightbox && (
        <div className="propbt-cmdk-overlay" onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="Trade screenshot" className="max-h-[85vh] max-w-[85vw] rounded" />
        </div>
      )}
    </div>
  )
}
