// Settings modal (POLISH_ROADMAP Phase P6: "manage layouts, themes,
// shortcuts, and data defaults"). A modal rather than a dockable panel --
// unlike Chart/Trade List/etc. this isn't something you'd resize and keep
// open alongside a run's data, it's occasional configuration, so it follows
// CommandPalette/ShortcutsOverlay's overlay convention instead of
// workspace/panelIds.ts's panel registry.
import { useRef, useState, type ReactNode } from 'react'
import {
  useThemeStore,
  useThemeBase,
  THEME_PRESETS,
  matchingPresetId,
  exportTheme,
  importTheme,
  ACCENT_BUTTON_TEXT_COLOR,
  type ThemeMode,
} from '../state/themeStore'
import { MIN_TEXT_CONTRAST, MIN_UI_CONTRAST, contrastRatio, ensureContrast } from '../state/contrast'
import { useWorkspaceApiStore } from '../state/workspaceApiStore'
import { useLayoutStore } from '../state/layoutStore'
import { useUiStore, type Timeframe } from '../state/uiStore'
import { useChartDefaultsStore } from '../state/chartDefaultsStore'
import { PRESETS, applyAnalysisLayout } from '../workspace/presets'
import ShortcutsList from './ShortcutsList'
import { useModalFocus } from './useModalFocus'
import type { BracketDensity } from '../chart/tradeBracket'

const TIMEFRAMES: Timeframe[] = ['1min', '5min', '15min', '1h']
const BRACKET_DENSITIES: BracketDensity[] = ['auto', 'full', 'markers']
const MODES: ThemeMode[] = ['dark', 'light']

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border-b border-border px-4 py-4 last:border-b-0">
      {/* .micro-label, not an ad hoc 12px/600/0.025em set -- was a second,
          slightly-different micro-label convention living next to the
          shared one (DESIGN_AUDIT.md ST4 flagged this as worth checking;
          turned out these needed fixing too, not the class to copy from). */}
      <h3 className="micro-label mb-3">{title}</h3>
      {children}
    </div>
  )
}

// One semantic-token color picker + its live contrast readout (REDESIGN_
// APPROACH.md Part C2: "enforce a minimum text/background contrast ratio
// (warn or auto-adjust)"). `bg` is whichever base surface this token
// actually renders against in practice -- base.surface for accent/positive/
// negative (they render as literal text throughout the app, hence the
// stricter MIN_TEXT_CONTRAST) and base.bg for the candle colors (canvas
// fills against the chart background, hence the more lenient
// MIN_UI_CONTRAST -- WCAG's own threshold for graphical objects, not text).
// Warns rather than blocking the pick outright, plus a one-click "Fix" that
// calls ensureContrast -- both options the source doc explicitly allows
// ("warn or auto-adjust"), not just one.
function TokenPicker({
  label,
  value,
  onChange,
  bg,
  minRatio,
  secondaryCheck,
}: {
  label: string
  value: string
  onChange: (hex: string) => void
  bg: string
  minRatio: number
  // Accent plays a SECOND role beyond "colored text on a surface": it's
  // also the background of every active/selected button app-wide, with
  // fixed white text on top (`bg-accent text-white`, throughout Chart-
  // Panel/SettingsPanel/etc). Found live while testing this exact
  // guardrail: an accent light enough to pass AS TEXT against a light-mode
  // surface makes that white button text unreadable -- the opposite
  // constraint, not something the primary check (accent-as-foreground)
  // catches. No "Fix" button here: in dark mode the two checks can pull
  // accent in OPPOSITE directions (light enough to read on a dark surface,
  // dark enough for white text to read on top of it), so auto-adjusting
  // this one could undo the other's fix -- informational warning only,
  // left for the user to balance.
  secondaryCheck?: { label: string; fg: string }
}) {
  const ratio = contrastRatio(value, bg)
  const passes = ratio >= minRatio
  const secondaryRatio = secondaryCheck ? contrastRatio(secondaryCheck.fg, value) : null
  const secondaryPasses = secondaryRatio === null || secondaryRatio >= MIN_TEXT_CONTRAST
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex w-28 items-center gap-2 text-text-muted">
        {label}
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-7 w-10 cursor-pointer rounded border border-border bg-transparent"
        />
      </label>
      <span className={`font-mono text-[11px] tabular-nums ${passes ? 'text-text-muted' : 'text-warning'}`}>{ratio.toFixed(1)}:1</span>
      {!passes && (
        <>
          <span className="text-[11px] text-warning">low contrast vs {bg}</span>
          <button
            onClick={() => onChange(ensureContrast(value, bg, minRatio))}
            className="text-[11px] text-accent underline hover:text-text"
          >
            Fix
          </button>
        </>
      )}
      {!secondaryPasses && secondaryRatio !== null && (
        <span className="text-[11px] tabular-nums text-warning">
          {secondaryRatio.toFixed(1)}:1 low contrast for {secondaryCheck!.label}
        </span>
      )}
    </div>
  )
}

export default function SettingsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const colors = useThemeStore((s) => s.colors)
  const mode = useThemeStore((s) => s.mode)
  const baseOverride = useThemeStore((s) => s.baseOverride)
  const applyPreset = useThemeStore((s) => s.applyPreset)
  const setAccent = useThemeStore((s) => s.setAccent)
  const setPositive = useThemeStore((s) => s.setPositive)
  const setNegative = useThemeStore((s) => s.setNegative)
  const setUpCandle = useThemeStore((s) => s.setUpCandle)
  const setDownCandle = useThemeStore((s) => s.setDownCandle)
  const setBgOverride = useThemeStore((s) => s.setBgOverride)
  const setSurfaceOverride = useThemeStore((s) => s.setSurfaceOverride)
  const setMode = useThemeStore((s) => s.setMode)
  const resetTheme = useThemeStore((s) => s.reset)
  const base = useThemeBase()

  const workspaceApi = useWorkspaceApiStore((s) => s.api)
  const clearLastLayout = useLayoutStore((s) => s.clearLastLayout)

  const defaultTimeframe = useUiStore((s) => s.timeframe)
  const setDefaultTimeframe = useUiStore((s) => s.setTimeframe)
  const bracketDensity = useChartDefaultsStore((s) => s.bracketDensity)
  const setBracketDensity = useChartDefaultsStore((s) => s.setBracketDensity)

  const [importError, setImportError] = useState<string | null>(null)
  const importInputRef = useRef<HTMLInputElement>(null)
  // Accessibility audit: confirmed live that opening this dialog left focus
  // on the trigger button behind it, and Tab walked straight through into
  // the workspace behind the overlay -- see useModalFocus's own comment.
  // Called unconditionally (rules of hooks); it no-ops internally while
  // `open` is false.
  const contentRef = useRef<HTMLDivElement>(null)
  useModalFocus(contentRef, open)

  if (!open) return null

  const activePresetId = matchingPresetId(colors, mode, baseOverride)

  const resetLayout = () => {
    if (!workspaceApi) return
    clearLastLayout()
    applyAnalysisLayout(workspaceApi)
  }

  // Export/import (REDESIGN_APPROACH.md Part C2: "import/export a theme as
  // JSON"). A real file download/picker -- this is a normal browser app,
  // not a sandboxed artifact viewer, so <a download> and <input type=file>
  // both work exactly as they would on any site.
  const handleExport = () => {
    const blob = new Blob([exportTheme(colors, mode, baseOverride)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `propbt-theme-${activePresetId}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleImportFile = (file: File) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = importTheme(String(reader.result ?? ''))
      if (typeof result === 'string') {
        setImportError(result)
      } else {
        setImportError(null)
        useThemeStore.setState({ colors: result.colors, mode: result.mode, baseOverride: result.baseOverride })
      }
    }
    reader.onerror = () => setImportError('Could not read that file.')
    reader.readAsText(file)
  }

  return (
    <div className="propbt-cmdk-overlay" onClick={onClose}>
      <div
        ref={contentRef}
        className="propbt-settings-content"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          {/* 16px/medium -- the same "panel title" scale step as Card
              (DESIGN_LANGUAGE.md section 3), not a bespoke 14px/semibold. */}
          <h2 className="text-base font-medium text-text">Settings</h2>
          <button onClick={onClose} className="rounded px-2 py-1 text-xs text-text-muted hover:bg-surface-2 hover:text-text">
            Esc to close
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto">
          <Section title="Theme">
            <div className="mb-3 flex items-center gap-2 text-xs">
              <span className="text-text-muted">Mode</span>
              <div className="flex gap-1">
                {MODES.map((m) => (
                  <button
                    key={m}
                    onClick={() => setMode(m)}
                    aria-pressed={mode === m}
                    className={`rounded px-2 py-1 capitalize ${
                      mode === m ? 'bg-accent text-white' : 'bg-surface-2 text-text hover:bg-surface-2-hover'
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>

            <div className="mb-3 flex flex-wrap gap-2">
              {THEME_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  onClick={() => applyPreset(preset.id)}
                  title={`${preset.name} (${preset.mode})`}
                  aria-pressed={activePresetId === preset.id}
                  className={`flex items-center gap-2 rounded border px-3 py-1 text-xs transition-colors ${
                    activePresetId === preset.id
                      ? 'border-accent bg-surface-2 text-text'
                      : 'border-border bg-surface text-text-muted hover:border-border-hover'
                  }`}
                >
                  <span className="flex gap-1">
                    <span className="h-3 w-3 rounded-full" style={{ background: preset.colors.accent }} />
                    <span className="h-3 w-3 rounded-full" style={{ background: preset.colors.positive }} />
                    <span className="h-3 w-3 rounded-full" style={{ background: preset.colors.negative }} />
                  </span>
                  {preset.name}
                </button>
              ))}
              {activePresetId === 'custom' && (
                <span className="flex items-center rounded border border-dashed border-border px-3 py-1 text-xs text-text-muted">
                  Custom
                </span>
              )}
            </div>

            <div className="flex flex-col gap-2 text-xs">
              <TokenPicker
                label="Accent"
                value={colors.accent}
                onChange={setAccent}
                bg={base.surface}
                minRatio={MIN_TEXT_CONTRAST}
                secondaryCheck={{ label: 'white button text', fg: ACCENT_BUTTON_TEXT_COLOR }}
              />
              <TokenPicker label="Positive" value={colors.positive} onChange={setPositive} bg={base.surface} minRatio={MIN_TEXT_CONTRAST} />
              <TokenPicker label="Negative" value={colors.negative} onChange={setNegative} bg={base.surface} minRatio={MIN_TEXT_CONTRAST} />
              <TokenPicker label="Up candle" value={colors.upCandle} onChange={setUpCandle} bg={base.bg} minRatio={MIN_UI_CONTRAST} />
              <TokenPicker label="Down candle" value={colors.downCandle} onChange={setDownCandle} bg={base.bg} minRatio={MIN_UI_CONTRAST} />
            </div>

            {/* Background/Surface overrides sit on top of mode/presets, not
                instead of them (themeStore.ts's own comment) -- checked
                against `base.text` since that's what actually renders on
                top of them everywhere (panel body copy, chart axis/crosshair
                text), the same "check it against what it really renders
                with" rule the picks above already follow. `base` already
                reflects any active override (useThemeBase()), so the swatch
                shown here, and the Up/Down candle checks above (bg=base.bg),
                both stay live against a custom background automatically. */}
            <div className="mt-3 flex flex-col gap-2 border-t border-border pt-3 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <TokenPicker label="Background" value={base.bg} onChange={setBgOverride} bg={base.text} minRatio={MIN_TEXT_CONTRAST} />
                {baseOverride.bg !== null && (
                  <button onClick={() => setBgOverride(null)} className="text-[11px] text-accent underline hover:text-text">
                    Use {mode} default
                  </button>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <TokenPicker label="Surface" value={base.surface} onChange={setSurfaceOverride} bg={base.text} minRatio={MIN_TEXT_CONTRAST} />
                {baseOverride.surface !== null && (
                  <button onClick={() => setSurfaceOverride(null)} className="text-[11px] text-accent underline hover:text-text">
                    Use {mode} default
                  </button>
                )}
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
              <button onClick={resetTheme} className="rounded bg-surface-2 px-2 py-1 text-text hover:bg-surface-2-hover">
                Reset to default
              </button>
              <button onClick={handleExport} className="rounded bg-surface-2 px-2 py-1 text-text hover:bg-surface-2-hover">
                Export theme
              </button>
              <button
                onClick={() => importInputRef.current?.click()}
                className="rounded bg-surface-2 px-2 py-1 text-text hover:bg-surface-2-hover"
              >
                Import theme
              </button>
              <input
                ref={importInputRef}
                type="file"
                accept="application/json"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) handleImportFile(file)
                  e.target.value = ''
                }}
              />
            </div>
            {importError && <p className="mt-2 text-xs text-negative">{importError}</p>}
          </Section>

          <Section title="Layout">
            {!workspaceApi ? (
              <p className="text-xs text-text-muted">Open a run to manage its workspace layout.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {PRESETS.map((p) => (
                  <button
                    key={p.name}
                    onClick={() => p.apply(workspaceApi)}
                    className="rounded bg-surface-2 px-3 py-1 text-xs text-text hover:bg-surface-2-hover"
                  >
                    {p.name}
                  </button>
                ))}
                <button onClick={resetLayout} className="rounded bg-surface-2 px-3 py-1 text-xs text-text hover:bg-surface-2-hover">
                  Reset layout
                </button>
              </div>
            )}
          </Section>

          <Section title="Data defaults">
            <div className="flex flex-wrap gap-6 text-xs text-text-muted">
              <div>
                <div className="mb-1 text-text-muted">Default chart timeframe</div>
                <div className="flex gap-1">
                  {TIMEFRAMES.map((tf) => (
                    <button
                      key={tf}
                      onClick={() => setDefaultTimeframe(tf)}
                      aria-pressed={defaultTimeframe === tf}
                      className={`rounded px-2 py-1 ${
                        defaultTimeframe === tf ? 'bg-accent text-white' : 'bg-surface-2 text-text hover:bg-surface-2-hover'
                      }`}
                    >
                      {tf}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div className="mb-1 text-text-muted">Default trade bracket density</div>
                <div className="flex gap-1">
                  {BRACKET_DENSITIES.map((d) => (
                    <button
                      key={d}
                      onClick={() => setBracketDensity(d)}
                      aria-pressed={bracketDensity === d}
                      className={`rounded px-2 py-1 capitalize ${
                        bracketDensity === d ? 'bg-accent text-white' : 'bg-surface-2 text-text hover:bg-surface-2-hover'
                      }`}
                    >
                      {d === 'markers' ? 'Off' : d}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </Section>

          <Section title="Shortcuts">
            <ShortcutsList />
          </Section>
        </div>
      </div>
    </div>
  )
}
