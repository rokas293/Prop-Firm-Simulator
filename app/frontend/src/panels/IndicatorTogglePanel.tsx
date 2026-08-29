import { useIndicatorStore, type IndicatorPrefs } from '../state/indicatorStore'

const TOGGLES: { key: keyof IndicatorPrefs; label: string }[] = [
  { key: 'sessionShading', label: 'Sessions' },
  { key: 'fairValue', label: 'Fair value' },
  { key: 'vwap', label: 'VWAP' },
  { key: 'ema20', label: 'EMA 20' },
  { key: 'ema50', label: 'EMA 50' },
  { key: 'atr14', label: 'ATR(14)' },
]

// Choices persist to localStorage via the store's own zustand `persist`
// middleware (VIZ_SPEC Phase V5: "remember choices in localStorage").
export default function IndicatorTogglePanel() {
  const prefs = useIndicatorStore()
  const toggle = useIndicatorStore((s) => s.toggle)

  return (
    <div className="flex flex-wrap items-center gap-3 text-xs text-text-muted">
      {TOGGLES.map((t) => (
        <label key={t.key} className="flex cursor-pointer items-center gap-1.5 hover:text-text">
          {/* No explicit accent-color class -- inherits the theme's live
              accent-color from :root (themeStore.ts's applyThemeToDocument),
              POLISH_ROADMAP Phase P6: "native controls... follow the theme." */}
          <input type="checkbox" checked={prefs[t.key]} onChange={() => toggle(t.key)} />
          {t.label}
        </label>
      ))}
    </div>
  )
}
