# CLAUDE.md — FX Replay-style manual backtesting/replay platform (MNQ/MES)

An FX Replay-style manual backtesting/replay/journaling platform for MNQ/MES (`FXR_SPEC.md`), built on top of the `propbt` automated backtest engine that validates a strategy against the Topstep $50k Combine (full framing: `docs/RESEARCH_METHODOLOGY.md`). This file is the lean contract — detail lives in `docs/` and the top-level spec files; read those on demand, not every turn.

## Commands
- Dev (both servers): `npm run dev`
- Frontend typecheck + build: `npm --prefix app/frontend run build`
- Frontend tests: `npm --prefix app/frontend test`
- Backend (viz API) tests: `python -m pytest app/backend/tests`
- Engine (propbt) tests: `python -m pytest`

## Non-negotiable invariants
- **No look-ahead, ever.** Two distinct conventions, don't conflate: `propbt` decides on bar `t`, executes at `t+1` (`docs/DATA_AND_RULES.md`); the FXR sim broker fills at the cursor bar's own close/intrabar cross (`FXR_SPEC.md` §3).
- **Engine-truth.** The frontend renders; it never recomputes trades, PnL, or prop-rule state — `propbt` and the sim broker are the sole sources of truth (`app/README.md`, `VIZ_SPEC.md`).
- **KLineCharts is the price engine** (`app/frontend/src/chart/kl/`). **lightweight-charts is only `RiskChart.tsx`** (Prop Risk panel) — never reintroduce it for price/candles.
- **Every phase ends green via the `verifier` subagent** — don't dump raw tsc/vitest/pytest/build output into the main session.
- **UI obeys `DESIGN_LANGUAGE.md`** — check new surfaces with the `design-auditor` subagent.

## Where things live
- Data, instruments, Topstep rules: `docs/DATA_AND_RULES.md`
- Strategy under test: `docs/STRATEGY.md`
- Engine architecture + conventions: `docs/ARCHITECTURE.md`
- Research methodology (the metric, anti-overfitting): `docs/RESEARCH_METHODOLOGY.md`
- Viz/replay data contract: `VIZ_SPEC.md` · manual-replay platform: `FXR_SPEC.md` · visual bar: `DESIGN_LANGUAGE.md`
- Phased build plans: `BUILD_PROMPTS.md`, `BUILD_PROMPTS_VIZ.md`, `FXR_BUILD_PROMPTS.md`
- Code: engine `propbt/`, backend API `app/backend/`, frontend `app/frontend/src/`
