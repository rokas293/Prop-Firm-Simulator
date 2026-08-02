# EXPERIMENT_LOG.md — strategy iteration log

The point of this file: keep your daily tuning honest and reversible. Every time you change the strategy config and run an evaluation, you add one row. Judge on **out-of-sample (OOS)**, always. If you can't explain *why* a change helped, treat the improvement as suspect (likely overfit).

## Rules

- One row per evaluated config. Never overwrite a row — append.
- The number that matters is **OOS pass %**, not in-sample. If IS looks great and OOS doesn't move (or drops), you overfit — revert.
- Change **one thing at a time**. If you change three params at once, the row is noise.
- Record the `run_id` (from the run bundle) so you can reopen the exact result in the viewer.
- Write a one-line **hypothesis before** the run and a one-line **verdict after**. If you can't state a hypothesis, don't run it.
- `git commit` the config with the same note, so config history and this log line up.

## Columns

| Date | run_id | Instrument | Change (one thing) | Hypothesis | Params # | IS pass % | OOS pass % | OOS expectancy (R) | Verdict |
|------|--------|-----------|--------------------|-----------|----------|-----------|------------|--------------------|---------|

- **Params #** = free-parameter count (from meta.json). Watch it climb — more params that only help IS = overfitting.
- **Verdict** = KEEP / REVERT / INCONCLUSIVE, plus a few words why.

## Log

| Date | run_id | Instrument | Change (one thing) | Hypothesis | Params # | IS pass % | OOS pass % | OOS expectancy (R) | Verdict |
|------|--------|-----------|--------------------|-----------|----------|-----------|------------|--------------------|---------|
| 2026-08-02 | _baseline_ | MNQ | Baseline (MES-tuned SL points) | Reference point only | — | — | — | ~+0.00 (London) | BASELINE |
| _(next)_ | | MNQ | Widen SL points to fit MNQ price scale | Stops are clipping noise (high MFE trades exiting at SL per V3 scatter) | | | | | |

## How to fill a row (daily loop)

1. Edit `propbt/config/strategy.yaml` — one change.
2. Run `python run.py evaluate --config propbt/config/strategy.yaml` → note the `run_id`.
3. Open the run in the viewer; read the OOS stats (V3 in-sample/OOS toggle).
4. Append a row here. Commit the config + this file together.
5. If REVERT: `git revert`/restore the config, keep the log row (the failed attempt is data).

## Standing reminders

- Before changing SL points, check the **MAE/MFE scatter** and a few trades in **replay** — confirm the stop is actually clipping winners, don't guess.
- A config that only wins at one exact parameter value is fragile. Prefer settings that stay good across small neighbors.
- Re-verify Topstep rules periodically; if they change, update `CLAUDE.md` + `prop_rules.py`, and note it here.
