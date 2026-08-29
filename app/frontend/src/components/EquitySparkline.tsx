import { Line, LineChart, ResponsiveContainer } from 'recharts'
import { useEquity } from '../api/hooks'
import { useThemeStore } from '../state/themeStore'
import { fmtUsd } from '../format'

// A compact, non-interactive equity shape for glanceability
// (REDESIGN_APPROACH.md Phase B2 decision: "do not duplicate the equity
// curve" -- the full MLL-annotated, breach-marked, interactive version
// stays the Prop Risk panel's job; this is only "is the line generally
// going up or down," the same kind of decoration as a stat tile's trend
// sparkline, not a primary chart -- so it deliberately has no axes, grid,
// or tooltip. A small max_points keeps the fetch itself lightweight too.
const SPARKLINE_MAX_POINTS = 200

export default function EquitySparkline({ runId, onViewFull }: { runId: string | null; onViewFull?: () => void }) {
  const { data: equity } = useEquity(runId, SPARKLINE_MAX_POINTS)
  const colors = useThemeStore((s) => s.colors)

  const last = equity && equity.length > 0 ? equity[equity.length - 1] : null

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs text-text-muted">Equity (full run)</span>
        {onViewFull && (
          <button onClick={onViewFull} className="text-xs text-accent hover:text-text">
            View full chart &rarr;
          </button>
        )}
      </div>
      {!equity || equity.length === 0 ? (
        <div className="flex h-20 items-center justify-center text-xs text-text-muted">No equity data</div>
      ) : (
        <>
          <ResponsiveContainer width="100%" height={80}>
            <LineChart data={equity}>
              <Line
                type="monotone"
                dataKey="equity"
                stroke={colors.accent}
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
          {last && <div className="mt-1 text-right text-xs text-text-muted">{fmtUsd(last.equity)}</div>}
        </>
      )}
    </div>
  )
}
