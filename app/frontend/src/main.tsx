import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App'
import './index.css'

// POLISH_ROADMAP Phase P4 perf pass: react-query's own default staleTime is
// 0, meaning every component MOUNT (not just an explicit user action)
// triggers a background refetch of already-cached data -- confirmed live
// that this fires from something as unrelated as dragging a dockview panel
// divider (which re-renders, and apparently sometimes remounts, sibling
// panels). A run's own data (bars/trades/stats/equity/daily_risk/sessions/
// indicators) is a fixed, already-computed backtest artifact -- VIZ_SPEC's
// "frontend renders bundle data" -- re-running the strategy produces a new,
// differently-timestamped run_id (confirmed from the id format), so the
// SAME run_id's data can never change underneath the app in a session.
// staleTime: Infinity is therefore not just a perf tweak but the actually-
// correct policy for this data, and it's what makes prefetchRun's hover-
// warmed cache (api/hooks.ts) actually stick instead of being immediately
// re-fetched the moment the real panel mounts. Per-query overrides (e.g.
// useAiStatus's own 5-minute staleTime, for an external service's
// periodically-changing availability) still take precedence over this
// default.
const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
)
