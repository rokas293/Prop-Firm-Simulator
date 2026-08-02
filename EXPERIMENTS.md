# Experiment log

The daily loop (CLAUDE.md section 6, BUILD_PROMPTS.md Phase 6): edit one
thing in `propbt/config/strategy.yaml`, run

```
python run.py evaluate --config propbt/config/evaluate.yaml
```

and log the result below before touching anything else.

## Rules of the road

- **Judge everything on OOS, not in-sample.** If OOS pass % collapses vs
  in-sample, that's overfitting, not bad luck — simplify, don't re-tune.
- **Change one thing at a time.** If two knobs move together you won't
  know which one mattered.
- **Prefer parameter regions that are robust to small changes** over a
  single sharp peak (`evaluate`'s grid-search step already scores for this
  when a config is swept as a `param_grid`, but the same principle applies
  to any manual edit-and-compare).
- **Commissions and slippage stay on, always.** They're already
  structural (not a toggle), but don't go looking for a way around that —
  it's the difference between a backtest edge and a real one.
- **Re-verify Topstep's rules periodically.** If they change, update
  `propbt/engine/prop_rules.py` and `CLAUDE.md` section 3 together, same
  commit.

## Log

Columns: what changed (vs. the previous row's config, one thing at a
time), in-sample pass %, out-of-sample pass % (the number that matters),
and a one-line read on it.

| Date | Config change | In-sample pass % | OOS pass % | Notes |
|------|----------------|-------------------|-------------|-------|
| 2026-08-02 | Baseline: continuation + mean_reversion + news, all default params (`propbt/config/strategy.yaml` as committed in Phase 3/4). Grid-searched `continuation.rr` in {1.0, 1.5, 2.0} in-sample; all three tied at 0%, so rr=1.0 selected by default (first tie). | 0.0% (3/3 attempts, all `mll_breach`) | 0.0% (5/5 attempts, all `incomplete` — ran the full 90-day cap without resolving either way) | Expected: nothing's been tuned yet. Worth noting OOS didn't fail the *same way* in-sample did (breach vs. never-resolved) — different regime, not just "still losing." Small sample (demo-scale attempt counts) — don't over-read the exact numbers, just the direction. |
