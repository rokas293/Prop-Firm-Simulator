# propbt viz app

Local web app for reviewing backtest runs (VIZ_SPEC.md). The engine
(`propbt`) is the single source of truth -- this app only renders run
bundles (`runs/<run_id>/`), it never recomputes trades, PnL, or prop-rule
state.

## Generate a run to look at

```
python run.py review --config propbt/config/strategy.yaml
```

Writes `runs/<run_id>/` (meta.json, trades.parquet, equity.parquet,
stats.json). Run it again after any strategy config change to get a new
run_id.

## Run the app

```
npm install                      # once, at the project root (installs `concurrently`)
npm --prefix app/frontend install  # once (frontend deps)
npm run dev                       # starts backend (:8000) + frontend (:5173) together
```

Then open **http://localhost:5173** -- the runs list should load and show
every `runs/<run_id>/` bundle you've generated (instrument, date range,
pass/fail).

To run them separately instead of via `npm run dev`:

```
python -m uvicorn app.backend.main:app --reload --port 8000
npm --prefix app/frontend run dev
```

The frontend's Vite dev server proxies `/api/*` to `:8000`, so the
frontend never needs to know the backend's port/host beyond dev config.

## Tests

```
pytest app/backend/tests   # backend: fixture-bundle endpoint tests + a known-value spot check
pytest                     # propbt engine/strategy/sim tests (unaffected by the app)
```

## Layout

See `VIZ_SPEC.md` section 2. Current phase (V0): run bundle emitter,
backend API (`/api/runs`, `/runs/{id}`, `/runs/{id}/trades`,
`/runs/{id}/equity`, `/runs/{id}/stats`, `/api/bars`, `/api/sessions`),
and a one-page frontend (runs list). Chart/trade-list/dashboard/prop-
overlay/indicators/replay views land in later phases (`BUILD_PROMPTS_VIZ.md`).
