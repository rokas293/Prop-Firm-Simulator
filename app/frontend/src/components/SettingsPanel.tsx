// Settings modal (POLISH_ROADMAP Phase P6: "manage layouts, themes,
// shortcuts, and data defaults"). A modal rather than a dockable panel --
// unlike Chart/Trade List/etc. this isn't something you'd resize and keep
// open alongside a run's data, it's occasional configuration, so it follows
// CommandPalette/ShortcutsOverlay's overlay convention instead of
// workspace/panelIds.ts's panel registry.
import type { ReactNode } from 'react'
import { useThemeStore, THEME_PRESETS, matchingPresetId } from '../state/themeStore'
import { useWorkspaceApiStore } from '../state/workspaceApiStore'
import { useLayoutStore } from '../state/layoutStore'
import { useUiStore, type Timeframe } from '../state/uiStore'
import { useChartDefaultsStore } from '../state/chartDefaultsStore'
import { PRESETS, applyAnalysisLayout } from '../workspace/presets'
import ShortcutsList from './ShortcutsList'
import type { BracketDensity } from '../chart/tradeBracket'

const TIMEFRAMES: Timeframe[] = ['1min', '5min', '15min', '1h']
const BRACKET_DENSITIES: BracketDensity[] = ['auto', 'full', 'markers']

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border-b border-neutral-800 px-4 py-4 last:border-b-0">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">{title}</h3>
      {children}
    </div>
  )
}

export default function SettingsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const colors = useThemeStore((s) => s.colors)
  const applyPreset = useThemeStore((s) => s.applyPreset)
  const setAccent = useThemeStore((s) => s.setAccent)
  const setUp = useThemeStore((s) => s.setUp)
  const setDown = useThemeStore((s) => s.setDown)
  const resetTheme = useThemeStore((s) => s.reset)

  const workspaceApi = useWorkspaceApiStore((s) => s.api)
  const clearLastLayout = useLayoutStore((s) => s.clearLastLayout)

  const defaultTimeframe = useUiStore((s) => s.timeframe)
  const setDefaultTimeframe = useUiStore((s) => s.setTimeframe)
  const bracketDensity = useChartDefaultsStore((s) => s.bracketDensity)
  const setBracketDensity = useChartDefaultsStore((s) => s.setBracketDensity)

  if (!open) return null

  const activePresetId = matchingPresetId(colors)

  const resetLayout = () => {
    if (!workspaceApi) return
    clearLastLayout()
    applyAnalysisLayout(workspaceApi)
  }

  return (
    <div className="propbt-cmdk-overlay" onClick={onClose}>
      <div className="propbt-settings-content" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Settings">
        <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
          <h2 className="text-sm font-semibold text-neutral-100">Settings</h2>
          <button onClick={onClose} className="rounded px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300">
            Esc to close
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto">
          <Section title="Theme">
            <div className="mb-3 flex flex-wrap gap-2">
              {THEME_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  onClick={() => applyPreset(preset.id)}
                  title={preset.name}
                  className={`flex items-center gap-2 rounded border px-2.5 py-1.5 text-xs transition-colors ${
                    activePresetId === preset.id
                      ? 'border-accent-blue bg-neutral-800 text-neutral-100'
                      : 'border-neutral-800 bg-neutral-900 text-neutral-400 hover:border-neutral-700'
                  }`}
                >
                  <span className="flex gap-0.5">
                    <span className="h-3 w-3 rounded-full" style={{ background: preset.colors.accent }} />
                    <span className="h-3 w-3 rounded-full" style={{ background: preset.colors.up }} />
                    <span className="h-3 w-3 rounded-full" style={{ background: preset.colors.down }} />
                  </span>
                  {preset.name}
                </button>
              ))}
              {activePresetId === 'custom' && (
                <span className="flex items-center rounded border border-dashed border-neutral-700 px-2.5 py-1.5 text-xs text-neutral-500">
                  Custom
                </span>
              )}
            </div>

            <div className="flex flex-wrap gap-4 text-xs text-neutral-400">
              <label className="flex items-center gap-2">
                Accent
                <input type="color" value={colors.accent} onChange={(e) => setAccent(e.target.value)} className="h-7 w-10 cursor-pointer rounded border border-neutral-700 bg-transparent" />
              </label>
              <label className="flex items-center gap-2">
                Candle up
                <input type="color" value={colors.up} onChange={(e) => setUp(e.target.value)} className="h-7 w-10 cursor-pointer rounded border border-neutral-700 bg-transparent" />
              </label>
              <label className="flex items-center gap-2">
                Candle down
                <input type="color" value={colors.down} onChange={(e) => setDown(e.target.value)} className="h-7 w-10 cursor-pointer rounded border border-neutral-700 bg-transparent" />
              </label>
              <button onClick={resetTheme} className="rounded bg-neutral-800 px-2 py-1 text-neutral-300 hover:bg-neutral-700">
                Reset to default
              </button>
            </div>
          </Section>

          <Section title="Layout">
            {!workspaceApi ? (
              <p className="text-xs text-neutral-600">Open a run to manage its workspace layout.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {PRESETS.map((p) => (
                  <button
                    key={p.name}
                    onClick={() => p.apply(workspaceApi)}
                    className="rounded bg-neutral-800 px-2.5 py-1.5 text-xs text-neutral-300 hover:bg-neutral-700"
                  >
                    {p.name}
                  </button>
                ))}
                <button onClick={resetLayout} className="rounded bg-neutral-800 px-2.5 py-1.5 text-xs text-neutral-300 hover:bg-neutral-700">
                  Reset layout
                </button>
              </div>
            )}
          </Section>

          <Section title="Data defaults">
            <div className="flex flex-wrap gap-6 text-xs text-neutral-400">
              <div>
                <div className="mb-1.5 text-neutral-500">Default chart timeframe</div>
                <div className="flex gap-1">
                  {TIMEFRAMES.map((tf) => (
                    <button
                      key={tf}
                      onClick={() => setDefaultTimeframe(tf)}
                      className={`rounded px-2 py-1 ${
                        defaultTimeframe === tf ? 'bg-accent-blue text-white' : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700'
                      }`}
                    >
                      {tf}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div className="mb-1.5 text-neutral-500">Default trade bracket density</div>
                <div className="flex gap-1">
                  {BRACKET_DENSITIES.map((d) => (
                    <button
                      key={d}
                      onClick={() => setBracketDensity(d)}
                      className={`rounded px-2 py-1 capitalize ${
                        bracketDensity === d ? 'bg-accent-blue text-white' : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700'
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
