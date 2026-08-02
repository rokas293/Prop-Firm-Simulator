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
| 2026-08-02 | **Scouting pass** (in-sample ONLY, n=5 attempts, 45-day cap — deliberately not run against OOS, since none cleared the in-sample bar; see rules of the road). `continuation_sl_points=20.0` | 0.0% (0/5, all incomplete) | not run | Wider continuation stop alone doesn't help; mostly just delays resolution (incomplete, not breach). |
| 2026-08-02 | Scouting: `continuation_observation_window_minutes=1` | 0.0% (0/5, 1 mll_breach) | not run | Faster entry trigger, no better. |
| 2026-08-02 | Scouting: `mean_reversion_direction_mode=join_break` (flips the core fade hypothesis to momentum) | 0.0% (0/5, all incomplete) | not run | Flipping the mean-reversion leg's direction didn't turn it around — weak signal in both directions, not just wrong-signed. |
| 2026-08-02 | Scouting: `mean_reversion_sl_points=15.0` | 0.0% (0/5, all incomplete) | not run | Wider MR stop alone doesn't help either. |
| 2026-08-02 | Scouting: `mean_reversion_compression_threshold_points=15.0` (looser consolidation gate → more BoS trades) | 0.0% (0/5, 2 mll_breach) | not run | More trades through a looser gate made things worse (2 breaches vs 0-1 elsewhere), consistent with the extra trades not carrying real edge. |
| 2026-08-02 | Scouting: continuation-only (mean_reversion + news disabled) | 0.0% (0/5, all incomplete) | not run | Isolating the leg with the best per-leg expectancy from Phase 3-4 reports still didn't clear 0%. |
| 2026-08-02 | Scouting: mean_reversion-only (continuation + news disabled) | 0.0% (0/5, all incomplete) | not run | Same story isolated the other direction. |

**Read after 8 single-parameter scouts:** none moved off 0% in-sample, across stop size (both legs), entry speed, the fade/join direction flip, the consolidation gate, and isolating each leg alone. That spread of misses points away from "wrong RR" or "wrong stop size" and toward the entry logic itself (spike-direction continuation, BoS-fade/join mean-reversion) not having real predictive edge on MES at 1-minute resolution once commissions/slippage are honest — a parameter-nudging problem would show at least one direction working somewhere in that spread. No candidate was promoted to a full OOS confirmation run, since none earned it in-sample (OOS is not a search target — see rules of the road above).
