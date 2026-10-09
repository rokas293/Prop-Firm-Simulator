"""Prop-firm rule sets for manual sessions (FXR_V2_SPEC.md section 4, G6).

A session stores a `PropRules` (the user-facing rule builder's shape). This
module is the only place that turns it into propbt's own `PropRulesConfig`, so
the one rule engine (`propbt.engine.prop_rules.PropRulesTracker`) judges every
session, preset or custom. The "Topstep 50k" preset is *derived from*
`propbt/config/prop_rules.yaml`, never copied, so it cannot drift from the
automated backtest's Topstep rules; tests/test_prop_presets.py replays real and
synthetic Topstep sessions to prove the verdicts are identical to the pre-G6
ones.
"""
from __future__ import annotations

from typing import Dict, List, Optional

from app.backend import models
from propbt.config import PropRulesConfig, load_prop_rules

TOPSTEP_50K = "topstep_50k"
CUSTOM = "custom"
PRESET_LABELS = {TOPSTEP_50K: "Topstep 50k"}


class UnknownPreset(ValueError):
    pass


def topstep_50k() -> models.PropPreset:
    cfg = load_prop_rules()
    # The preset's "locks at start" flag stands for the yaml's freeze rule; check
    # they mean the same thing rather than assume.
    locks = (
        cfg.mll_freeze_trigger_balance == cfg.start_balance + cfg.mll_initial_offset
        and cfg.mll_freeze_floor == cfg.start_balance
    )
    if not locks:
        raise RuntimeError("prop_rules.yaml's freeze rule no longer fits the preset model (freeze at the start balance)")
    return models.PropPreset(
        id=TOPSTEP_50K,
        label=PRESET_LABELS[TOPSTEP_50K],
        starting_balance=cfg.start_balance,
        rules=models.PropRules(
            profit_target=cfg.profit_target,
            max_loss_type="eod_trailing",
            max_loss=cfg.mll_initial_offset,
            max_loss_locks_at_start=True,
            daily_loss_limit=cfg.daily_loss_limit,
            consistency_pct=None if cfg.consistency_max_pct is None else cfg.consistency_max_pct * 100,
            max_contracts=cfg.max_open_contracts,
        ),
    )


def list_presets() -> List[models.PropPreset]:
    return [topstep_50k()]


def get_preset(preset_id: str) -> models.PropPreset:
    for p in list_presets():
        if p.id == preset_id:
            return p
    raise UnknownPreset(f"prop_ruleset must be one of {[p.id for p in list_presets()] + [CUSTOM]}, got {preset_id!r}")


def label_for(rules: models.PropRules, starting_balance: float) -> str:
    """The preset id when these rules are exactly that preset's on its own
    balance, else "custom" -- so the stored label can never misdescribe the rules."""
    for p in list_presets():
        if rules == p.rules and starting_balance == p.starting_balance:
            return p.id
    return CUSTOM


def engine_config(
    rules: models.PropRules, starting_balance: float, commissions: Optional[Dict[str, float]] = None
) -> PropRulesConfig:
    """propbt's tracker config for these rules. A trailing floor that "locks at
    start" freezes at the starting balance once it would reach it (Topstep:
    +2000 -> 52000 trigger, 50000 floor)."""
    trailing = rules.max_loss_type != "static"
    locks = trailing and rules.max_loss_locks_at_start
    return PropRulesConfig(
        start_balance=starting_balance,
        profit_target=rules.profit_target,
        mll_initial_offset=rules.max_loss,
        mll_freeze_trigger_balance=starting_balance + rules.max_loss if locks else None,
        mll_freeze_floor=starting_balance if locks else None,
        daily_loss_limit=rules.daily_loss_limit,
        consistency_max_pct=None if rules.consistency_pct is None else rules.consistency_pct / 100,
        max_open_contracts=rules.max_contracts,
        commissions=dict(commissions or {}),
        mll_type=rules.max_loss_type,
    )


def rules_for_saved_account(account: dict) -> Optional[models.PropRules]:
    """The rules of a saved account dict (after _migrate), None for a practice account."""
    raw = account.get("prop_rules")
    return models.PropRules.model_validate(raw) if raw else None


def legacy_rules(prop_ruleset: str) -> models.PropRules:
    """What a session saved before G6 (prop_ruleset only) was judged by."""
    if prop_ruleset == TOPSTEP_50K:
        return topstep_50k().rules
    raise UnknownPreset(f"cannot resolve rules for saved prop_ruleset {prop_ruleset!r}")
