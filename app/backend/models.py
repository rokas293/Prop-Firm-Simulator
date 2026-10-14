"""Pydantic response models -- one per API shape (VIZ_SPEC.md section 6).
All times are UNIX seconds UTC (Lightweight Charts' native format); the
backend converts from the bundle's tz-aware pandas Timestamps here, once,
so nothing downstream has to think about timezones again.
"""
from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, computed_field, field_validator, model_validator


class RunResultModel(BaseModel):
    passed: bool
    fail_reason: Optional[str] = None
    days_to_fail: Optional[int] = None


class RunSummary(BaseModel):
    run_id: str
    created_at: str
    config_name: str
    instrument: str
    base_timeframe: str
    date_from: str
    date_to: str
    is_oos_split_date: Optional[str] = None
    result: RunResultModel
    params_count: int


class RunMetaResponse(RunSummary):
    config_hash: str
    # FXR_SPEC.md phase F6: a manual session (or all of an instrument's
    # sessions) is served through the same /api/runs/{id}/... endpoints as a
    # completed automated run, under a "bt:" id (see manual_analytics.py) --
    # these let the frontend tell them apart without parsing the id. Defaults
    # keep every real run bundle's meta response unchanged.
    source: str = "engine"                      # "engine" | "manual"
    prop_ruleset: Optional[str] = None           # manual runs only: e.g. "topstep_50k"
    session_ids: List[str] = Field(default_factory=list)  # manual runs only
    # G7: the instruments the scope's trades are in (a multi-asset session lists
    # both); the analytics instrument filter offers these. Empty for engine runs.
    instruments: List[str] = Field(default_factory=list)
    # G10: Autopilot (FXR_V2_SPEC.md section 8) traded in this scope. `interrupted`
    # when a run was switched off and back on (its parity with the offline backtest
    # only holds for an uninterrupted run), `autopilot_sessions` how many of the
    # scope's sessions ran it, `autopilot_interruptions` the off->on gaps in total.
    autopilot_sessions: int = 0
    autopilot_interrupted: bool = False
    autopilot_interruptions: int = 0


class TradeRecord(BaseModel):
    trade_id: int
    entry_time: int
    exit_time: int
    instrument: str
    side: str
    leg: Optional[str] = None
    session: Optional[str] = None
    trading_day: Optional[str] = None
    size_contracts: int
    entry_price: float
    exit_price: float
    sl_price: Optional[float] = None
    tp_price: Optional[float] = None
    # G8: the stop the position carried when it FILLED. `sl_price` above is
    # the stop at close, which break-even, a trail or an "Add stop loss" later
    # may have moved; only this one says what was risked at entry (the RR
    # simulator's 1R). None on a trade with no stop at entry, on every engine
    # trade, and on manual trades journaled before G8 (not knowable).
    entry_sl_price: Optional[float] = None
    # The target at the fill (same rules as entry_sl_price; tp_price is the target at close).
    entry_tp_price: Optional[float] = None
    sl_points: Optional[float] = None
    tp_points: Optional[float] = None
    rr_planned: Optional[float] = None
    exit_type: str
    pnl_usd: float
    r_multiple: Optional[float] = None
    commission_usd: float
    mae_points: float
    mfe_points: float
    mae_r: Optional[float] = None
    mfe_r: Optional[float] = None
    bars_held: int
    # FXR_SPEC.md section 2 schema-compat: only populated on manual-run
    # trades (see manual_analytics.py); None/absent on every engine run.
    source: Optional[str] = None            # "manual" | "bot"
    # G10: for a bot trade, which Autopilot on-segment of its session decided it (0 = the
    # first, uninterrupted run; 1+ follow an off -> on). None for manual trades.
    bot_segment: Optional[int] = None
    session_id: Optional[str] = None
    # The journal's own trade id inside session_id. Equals trade_id for a
    # single-session scope; a pooled (all-sessions) scope renumbers trade_id
    # to stay unique across sessions, so this is what links back to the journal.
    session_trade_id: Optional[int] = None
    tags: Optional[List[str]] = None
    setup_name: Optional[str] = None
    grade: Optional[str] = None


class EquityPoint(BaseModel):
    time: int
    balance: float
    open_pnl: float
    equity: float
    # None on a manual run that didn't use a prop ruleset (no floors exist).
    mll_floor: Optional[float] = None
    daily_loss_floor: Optional[float] = None
    target_level: Optional[float] = None
    trading_day: Optional[str] = None
    day_start_balance: float
    breached: bool
    daily_locked: bool
    drawdown_usd: float


class GroupStats(BaseModel):
    trades: int
    net_pnl_usd: float
    net_r: Optional[float] = None
    win_rate: Optional[float] = None
    expectancy_usd: Optional[float] = None
    expectancy_r: Optional[float] = None
    profit_factor: Optional[float] = None
    max_drawdown_usd: float = 0.0


class StatsResult(BaseModel):
    status: str
    fail_reason: Optional[str] = None
    target_hit: bool
    consistency_passed: Optional[bool] = None
    final_balance: float
    trading_days: int
    # Manual runs only (F6): how/when the Combine resolved, so the dashboard
    # can say more than PASSED/FAILED. All None for engine runs and while
    # a manual session is still "incomplete".
    resolved_time: Optional[int] = None
    resolved_trade_id: Optional[int] = None
    trades_to_result: Optional[int] = None
    equity_at_result: Optional[float] = None
    mll_floor_at_result: Optional[float] = None
    daily_loss_lock_days: Optional[int] = None


class StatsResponse(BaseModel):
    scope: str
    overall: GroupStats
    by_leg: Dict[str, GroupStats]
    by_session: Dict[str, GroupStats]
    # Manual runs only (F6): breakdowns along the journal's own dimensions.
    by_setup: Dict[str, GroupStats] = Field(default_factory=dict)
    by_tag: Dict[str, GroupStats] = Field(default_factory=dict)
    by_grade: Dict[str, GroupStats] = Field(default_factory=dict)
    # G10: manual vs bot (Autopilot) trades.
    by_source: Dict[str, GroupStats] = Field(default_factory=dict)
    by_backtest_session: Dict[str, GroupStats] = Field(default_factory=dict)
    result: Optional[StatsResult] = None


class MonteCarloResponse(BaseModel):
    method: str
    n_trades: int
    n_sims: int
    seed: int
    drawdown_budget_usd: float
    final_pnl_pct: Dict[str, float]
    max_drawdown_pct: Dict[str, float]
    prob_profit: float
    prob_drawdown_breach: float
    actual_final_pnl: float
    actual_max_drawdown: float
    fan: Dict[str, List[float]]
    actual_path: List[float]


class Bar(BaseModel):
    time: int
    open: float
    high: float
    low: float
    close: float
    volume: int


class DailyRiskPoint(BaseModel):
    trading_day: str
    min_distance_to_mll_usd: float
    min_distance_time: int
    breached: bool
    breach_time: Optional[int] = None
    daily_locked: bool
    daily_lock_time: Optional[int] = None
    trades: int


class IndicatorPoint(BaseModel):
    time: int
    value: float


class AiStatusResponse(BaseModel):
    available: bool


class SummarizeResponse(BaseModel):
    summary: str


class SessionWindow(BaseModel):
    trading_day: str
    session: str
    start: int
    end: int
    fair_value: Optional[float] = None
    fair_value_time: Optional[int] = None


# --- FXR_SPEC.md section 2: manual-backtest sessions (F1 shell). "Session"
# here means a saved manual-replay session (BacktestSession), a completely
# different concept from SessionWindow above (an Asia/London/NY trading-
# session window) -- named `BacktestSession...`/routed under /api/bt-
# sessions specifically to avoid colliding with that pre-existing meaning.

class PropRules(BaseModel):
    """FXR_V2_SPEC.md section 4 (G6): a prop-firm session's rule set. The
    dollar amounts are absolute (off the session's starting balance), the same
    levels propbt's PropRulesTracker enforces -- `bt_session_service` /
    `prop_presets.engine_config` turn this into the tracker's own config, so no
    rule is judged anywhere else. Optional rules are None when not part of the
    account."""
    profit_target: float = Field(gt=0)
    # Where the loss floor sits and how it moves (see propbt.engine.prop_rules).
    max_loss_type: Literal["static", "eod_trailing", "intraday_trailing"] = "eod_trailing"
    max_loss: float = Field(gt=0)
    # A trailing floor stops rising once it reaches the starting balance (Topstep's
    # freeze). Ignored for a static floor.
    max_loss_locks_at_start: bool = True
    daily_loss_limit: Optional[float] = Field(None, gt=0)
    # The best single day may be at most this percent of the total profit.
    consistency_pct: Optional[float] = Field(None, gt=0, le=100)
    max_contracts: Optional[int] = Field(None, ge=1)
    # Restrictions. Overnight/weekend auto-flatten at `close_time` (ET); news
    # trading is stored here and enforced from G7.
    no_overnight: bool = False
    no_weekend: bool = False
    no_news: bool = False
    # G7: with `no_news`, no entry within this many minutes either side of a
    # high-impact scheduled event (news_events.csv).
    news_window_minutes: int = Field(5, ge=1, le=120)
    close_time: str = Field("16:00", pattern=r"^([01]\d|2[0-3]):[0-5]\d$")


class SimAccountModel(BaseModel):
    id: str
    starting_balance: float
    balance: float
    currency: str = "USD"
    # Exactly one of these is set (validated in bt_session_service, not
    # here -- keeps this a plain data shape, no cross-field logic in a
    # response model). risk_per_trade_percent is of the CURRENT balance
    # when actually used to size a trade (F2+); nothing in F1 reads it yet.
    risk_per_trade_percent: Optional[float] = None
    risk_per_trade_usd: Optional[float] = None
    commission_per_contract: float
    # FXR_SPEC.md section 2/B, phase F6: optional prop ruleset ("topstep_50k"
    # = propbt/config/prop_rules.yaml). None = a plain practice account.
    # Optional/defaulted so every session.json written before F6 validates.
    prop_ruleset: Optional[str] = None
    # Max contracts in one position, set from the ruleset's position limit
    # (prop_rules.yaml max_open_contracts) when prop_ruleset is set; None =
    # uncapped practice account.
    max_contracts: Optional[int] = None
    # G6: the concrete rules a prop session is judged by. `prop_ruleset` is only
    # the label ("topstep_50k" when they equal that preset on its balance, else
    # "custom"); a session saved before G6 gets the Topstep preset on load.
    prop_rules: Optional[PropRules] = None
    # G6: commission per contract for each instrument of the session. The
    # single-asset replay prices trades with `commission_per_contract` (the
    # primary asset's value) until multi-asset arrives in G7.
    commissions: Dict[str, float] = Field(default_factory=dict)


class CreateSessionRequest(BaseModel):
    # FXR_V2_SPEC.md section 4 (G1): `assets` is the session's instrument
    # list (MNQ/MES); `instrument` stays as the single-asset shorthand and,
    # when both are given, must be one of `assets` (it becomes the primary --
    # the chart's symbol until multi-asset replay lands in G7). At least one
    # of the two is required.
    instrument: Optional[str] = None
    assets: Optional[List[str]] = None
    name: Optional[str] = None
    base_timeframe: str
    # FXR_V2_SPEC.md section 5 (G5): the chart's timeframe and the replay's step
    # size are independent. Both default to base_timeframe (what a v1 client
    # sends), so a session made without them behaves as it always did.
    chart_timeframe: Optional[str] = None
    step_size: Optional[str] = None
    # Exactly one of start_time/random_start is used (random_start=True
    # ignores start_time and picks server-side, so the client never sees --
    # let alone influences -- which historical point it lands on).
    start_time: Optional[int] = None
    random_start: bool = False
    starting_balance: float = 50000.0
    risk_per_trade_percent: Optional[float] = 1.0
    risk_per_trade_usd: Optional[float] = None
    # The Quick Buy/Sell quantity box's starting value (persisted per session
    # and editable from the bottom bar) -- replaces v1's default_contracts.
    quick_quantity: int = 1
    # Unix seconds of the last instant the cursor may reach (None = run to the
    # end of the data). Cannot be combined with random_start.
    end_date: Optional[int] = None
    # G6: with random_start, the session runs this many seconds from the start the
    # server picks (the end date is derived, the start stays hidden from the client).
    random_duration_seconds: Optional[int] = None
    commission_per_contract: float = 1.0
    # G6: per instrument; when given, the primary asset's value is the one trades use.
    commissions: Optional[Dict[str, float]] = None
    # "topstep_50k" (the preset, `prop_rules` optional) or "custom" (`prop_rules`
    # required). The server labels the result by comparing against the preset.
    prop_ruleset: Optional[str] = None
    prop_rules: Optional[PropRules] = None
    # FXR_SPEC.md section F, phase F7b: "no rewind past a placed trade".
    discipline_lock: bool = False
    # FXR_V2_SPEC.md section 3.5/4 (G3): the session's strategy rules, shown as
    # tick-boxes in the Place Order dialog. The editor lands in G6; the field
    # exists now so the dialog has something to render.
    checklist: List[str] = Field(default_factory=list)


# --- FXR_SPEC.md section B/3, phase F4: the sim broker's open position and
# working orders, persisted WITH the session so a mid-trade reload restores
# them instead of silently losing the trade (F2/F3's own flagged gap).
# Deliberately no *_index field -- an index into the currently-loaded bars
# array is meaningless across a reload (a fresh fetch window re-indexes
# everything from 0), same reasoning as cursor_time itself: only the TIME
# survives a reload; the frontend re-resolves it back to an index the same
# way it already does for cursor_time (resyncCursorIndex).

class PersistedPosition(BaseModel):
    # G7: which of the session's assets this position is in (None = the primary,
    # which is every position saved before multi-asset). One position per asset.
    instrument: Optional[str] = None
    side: str
    contracts: int
    entry_price: float
    entry_time: int
    risk_usd: Optional[float] = None
    sl_price: Optional[float] = None
    tp_price: Optional[float] = None
    # G8: the stop at the moment of the fill, never updated afterwards (sl_price
    # moves with break-even / trail / edits). None = it filled with no stop (or
    # a position saved before G8, which cannot say).
    entry_sl_price: Optional[float] = None
    # The target at the fill (same rules as entry_sl_price; tp_price is the target at close).
    entry_tp_price: Optional[float] = None
    # F4 optional toggles -- carried on the position so they survive a
    # reload same as everything else about it.
    auto_breakeven: bool = False
    trailing_points: Optional[float] = None
    # Section 3.4 (G4): where auto break-even triggers -- a multiple of the risk
    # (`breakeven_r`) or a distance in price points (`breakeven_points`, which
    # wins if both are set). Both None = the original +1R rule.
    breakeven_r: Optional[float] = None
    breakeven_points: Optional[float] = None
    # FXR_V2_SPEC.md section 3.6 (G2): the position's journal identity and its
    # size at entry. Every exit of this position (partial or final) is
    # journaled under `trade_key`, so they merge into ONE trade; `contracts`
    # above is only what is still open. Optional so v1 positions still load.
    trade_key: Optional[str] = None
    initial_contracts: Optional[int] = None
    # Section 3.2: ghost SL/TP levels still waiting to be placed (drag to set,
    # or removed) -- persisted so a reload mid-trade restores them as they were.
    ghost_sl: Optional[float] = None
    ghost_tp: Optional[float] = None
    # Section 3.5 (G3): what the Place Order dialog attached to the trade. They
    # ride on the position until its first exit is journaled, then land on the
    # trade (record_trade). `journal_notes` is the open journal entry's draft.
    tags: List[str] = Field(default_factory=list)
    checklist: List[str] = Field(default_factory=list)
    journal_notes: str = ""


class PersistedWorkingOrder(BaseModel):
    id: str
    instrument: Optional[str] = None  # G7: None = the primary asset
    side: str
    order_type: str  # "limit" | "stop"
    price: float
    contracts: int
    sl_price: Optional[float] = None
    tp_price: Optional[float] = None
    risk_usd: Optional[float] = None
    placed_time: int
    # Section 3.5 (G3): the dialog's per-order choices. They must survive a
    # reload while the order is still working, and pass to the position when it
    # fills. `journal_on_fill` is "Save & Journal": open the journal entry then.
    auto_breakeven: bool = False
    trailing_points: Optional[float] = None
    breakeven_r: Optional[float] = None
    breakeven_points: Optional[float] = None
    tags: List[str] = Field(default_factory=list)
    checklist: List[str] = Field(default_factory=list)
    journal_notes: str = ""
    journal_on_fill: bool = False


class PropStatus(BaseModel):
    """Where a Topstep session's Combine stands (propbt's PropRulesTracker,
    via manual_analytics.prop_status): passed | failed | incomplete."""
    status: str
    fail_reason: Optional[str] = None
    resolved_trade_id: Optional[int] = None
    trades_to_result: Optional[int] = None


class ScalperConfig(BaseModel):
    """FXR_V2_SPEC.md section 3.4 (G4): Scalper Mode's preset brackets and
    whether it is armed, persisted PER SESSION. Every value is a DISTANCE, never
    a price. The same rules the frontend applies (chart/scalper.ts): values are
    positive; break-even moves the stop, so it is off without one."""
    armed: bool = False
    sl_on: bool = True
    sl_value: float = Field(40, gt=0)
    sl_unit: Literal["ticks", "percent", "usd"] = "ticks"
    tp_on: bool = True
    tp_value: float = Field(2, gt=0)
    # "r" is a multiple of the stop distance; with no stop it places no target.
    tp_unit: Literal["ticks", "percent", "r"] = "r"
    be_on: bool = False
    be_mode: Literal["r", "ticks"] = "r"
    be_value: float = Field(1, gt=0)

    @model_validator(mode="after")
    def _break_even_needs_a_stop(self) -> "ScalperConfig":
        if self.be_on and not self.sl_on:
            self.be_on = False
        return self


# --- FXR_V2_SPEC.md section 8 (G10): Autopilot. The propbt strategy trades the replay on
# the SAME account, stepped by the real engine on the server (propbt.engine.stepper);
# the browser only renders what is stored here and in the journal.

class AutopilotConfigInfo(BaseModel):
    """A strategy config Autopilot could run (propbt/config/*.yaml with `legs`)."""
    id: str
    label: str
    symbol: str
    legs: List[str]                          # the leg(s) the config enables, e.g. ["continuation", "mean_reversion"]
    summary: List[str] = Field(default_factory=list)   # one human line per enabled leg
    supported: bool
    reason: Optional[str] = None             # why it cannot start, when supported is False


class AutopilotSegment(BaseModel):
    """One stretch with the bot deciding, in cursor time (unix seconds)."""
    on_time: int
    off_time: Optional[int] = None


class AutopilotPosition(BaseModel):
    instrument: str
    side: str
    contracts: int
    entry_price: float
    entry_time: int
    sl_price: Optional[float] = None
    tp_price: Optional[float] = None
    leg: Optional[str] = None
    unrealized_usd: float = 0.0              # at the cursor bar's close, the engine's own mark


class AutopilotPending(BaseModel):
    """A decision that fills at the NEXT bar's open (the engine's t -> t+1 convention)."""
    instrument: str
    side: str
    contracts: int
    decided_time: int
    reason: str = ""
    sl_points: Optional[float] = None
    tp_points: Optional[float] = None


class AutopilotState(BaseModel):
    enabled: bool
    config_id: str
    config_label: str
    config_hash: str
    symbol: str
    legs: List[str] = Field(default_factory=list)
    # running | off | failed | passed | error. `failed`/`passed`: the engine's own tracker
    # resolved the account (the run ends there); `error`: the stored run could not be
    # rebuilt to exactly what was journaled, so it stopped rather than diverge.
    status: str = "running"
    status_detail: Optional[str] = None
    daily_locked: bool = False
    # Off -> on again leaves the engine's strategy state (what it has already traded this
    # session open, ...) fresh while the account carries on, so the run no longer equals
    # an offline backtest: flagged here, in the journal and in analytics.
    interrupted: bool = False
    segments: List[AutopilotSegment] = Field(default_factory=list)
    trading_start: int                      # first bar the bot could decide on (the activation cursor)
    processed_to: int                       # last bar the engine has consumed (<= the session cursor)
    bot_balance: float                      # the engine portfolio's own balance (bot trades only)
    position: Optional[AutopilotPosition] = None
    pending: List[AutopilotPending] = Field(default_factory=list)
    trades: int = 0
    rejections: int = 0
    slippage_ticks: int = 1
    commission_per_contract: float = 0.0


class SetAutopilotRequest(BaseModel):
    enabled: bool
    # Required to turn it on (the first time, or to start a fresh snapshot after a stop).
    config_id: Optional[str] = None


class SessionProgress(BaseModel):
    """How far a session's replay has come (home page cards). Trading days are
    the instrument's own trading days in the data (CME boundary), so holidays
    and gaps are not counted."""
    # 0..1 of the way from start to end_date; None for a session with no end.
    fraction: Optional[float] = None
    trading_days_total: Optional[int] = None
    trading_days_remaining: Optional[int] = None
    complete: bool = False
    trades: int = 0
    net_pnl_usd: float = 0.0
    win_rate: Optional[float] = None


class BacktestSessionSummary(BaseModel):
    id: str
    # Optional display name; the UI falls back to "<assets> · <start date>".
    name: Optional[str] = None
    # Primary instrument (== assets[0]); kept because the chart/bars/trades
    # all key on a single symbol until multi-asset replay (G7).
    instrument: str
    assets: List[str] = Field(default_factory=list)
    base_timeframe: str
    # G5: the chart's timeframe and how far one replay step advances, each any
    # allowed timeframe at or above 1m. A session saved before G5 carries
    # neither; they load as base_timeframe (see bt_session_service._migrate).
    chart_timeframe: Optional[str] = None
    step_size: Optional[str] = None
    start_time: int
    # The cursor stops at this time (inclusive of the last bar at or before
    # it). None = no end (v1 sessions).
    end_date: Optional[int] = None
    # Whole contracts the Quick Buy/Sell uses; persisted per session.
    quick_quantity: int = 1
    # The session's strategy checklist (G3: rendered in the Place Order dialog;
    # the editor is G6). Empty for v1 sessions.
    checklist: List[str] = Field(default_factory=list)
    # G4: Scalper Mode's settings and armed state. None = never configured (the
    # defaults apply); a pre-G4 session.json validates unchanged.
    scalper: Optional[ScalperConfig] = None
    created_at: str
    updated_at: str
    # The open time of the last 1-minute bar revealed (G5: the cursor always
    # counts in 1m bars, whatever the chart timeframe or step size).
    cursor_time: int
    status: str  # "active" | "archived"
    account: SimAccountModel
    # G7: at most one open position per asset (the sim broker's single-position
    # rule, kept per instrument); they share the one cursor and the one account.
    positions: List[PersistedPosition] = Field(default_factory=list)
    working_orders: List[PersistedWorkingOrder] = Field(default_factory=list)
    # FXR_SPEC.md section C, phase F5: session-level journal notes (separate
    # from any one trade's own notes below). Optional/defaulted so every
    # session.json written before F5 still validates unchanged.
    notes: Optional[str] = None
    # FXR_SPEC.md section F, phase F7b: the optional discipline lock. Once a
    # trade (a position or a working order) has been placed, `lock_floor_time`
    # is the cursor time it was placed at, and the cursor can never be saved
    # before it. Optional/defaulted so every earlier session.json validates.
    discipline_lock: bool = False
    lock_floor_time: Optional[int] = None
    # Filled only by GET /bt-sessions (the list), for prop sessions.
    prop_status: Optional[PropStatus] = None
    # Filled only by GET /bt-sessions (the list): the home page's progress bar.
    progress: Optional["SessionProgress"] = None
    # G10: the Autopilot run on this session (None = never switched on).
    autopilot: Optional[AutopilotState] = None


    @computed_field  # type: ignore[prop-decorator]
    @property
    def position(self) -> Optional[PersistedPosition]:
        """The first open position (the only one in a single-asset session) --
        kept for clients written before multi-asset; new code reads `positions`."""
        return self.positions[0] if self.positions else None


class BacktestSessionDetail(BacktestSessionSummary):
    pass


class UpdateSessionNotesRequest(BaseModel):
    notes: str


class UpdateSessionSettingsRequest(BaseModel):
    # Only the fields actually sent are applied (exclude_unset).
    name: Optional[str] = None
    quick_quantity: Optional[int] = None
    checklist: Optional[List[str]] = None
    scalper: Optional[ScalperConfig] = None
    # G5: the chart's timeframe / the step size; each any allowed timeframe.
    chart_timeframe: Optional[str] = None
    step_size: Optional[str] = None


class UpdateCursorRequest(BaseModel):
    cursor_time: int
    # F4: every cursor update also carries the FULL current broker state
    # (never a partial/optional patch) -- unambiguously distinguishes
    # "flat" (position=None) from "unchanged" without a separate sentinel,
    # since the frontend always knows its own current state at the moment
    # of any step. Also used standalone (cursor_time left at whatever it
    # already is) by every OTHER position-changing action (Buy/Sell/
    # Confirm/Close/partial-close/cancel-order/drag-modify) so a reload
    # never has to wait for the next replay step to see the latest trade.
    position: Optional[PersistedPosition] = None
    # G7: every open position (one per asset). Wins over the single `position`
    # above, which stays for clients written before multi-asset.
    positions: List[PersistedPosition] = Field(default_factory=list)
    working_orders: List[PersistedWorkingOrder] = Field(default_factory=list)

    @model_validator(mode="after")
    def _fold_legacy_position(self) -> "UpdateCursorRequest":
        if self.position is not None and not self.positions:
            self.positions = [self.position]
        return self


# --- FXR_SPEC.md section 2/6, phase F2: manual trades journaled from the
# sim broker. Deliberately reuses TradeRecord's exact field set (not a
# fresh shape) -- "keep manual trades schema-compatible with the existing
# trade-record model" is section 2's explicit instruction, so Dashboard/
# Compass/Monte-Carlo/MAE-MFE repoint in F6 with minimal change.

class CreateManualTradeRequest(BaseModel):
    entry_time: int
    exit_time: int
    instrument: str
    side: str
    leg: Optional[str] = None
    session: Optional[str] = None
    trading_day: Optional[str] = None
    size_contracts: int
    entry_price: float
    exit_price: float
    sl_price: Optional[float] = None
    tp_price: Optional[float] = None
    # G8: the stop the position carried at its fill (see TradeRecord.entry_sl_price).
    entry_sl_price: Optional[float] = None
    # The target at the fill (same rules as entry_sl_price; tp_price is the target at close).
    entry_tp_price: Optional[float] = None
    sl_points: Optional[float] = None
    tp_points: Optional[float] = None
    rr_planned: Optional[float] = None
    exit_type: str
    pnl_usd: float
    r_multiple: Optional[float] = None
    commission_usd: float
    mae_points: float
    mfe_points: float
    mae_r: Optional[float] = None
    mfe_r: Optional[float] = None
    bars_held: int
    # FXR_V2_SPEC.md section 3.6 (G2): partial exits. Every field above
    # describes THIS exit's slice. `trade_key` identifies the position the
    # slice belongs to: a request whose key matches an already-journaled trade
    # is merged into it as one more exit (record_trade), not stored as a second
    # trade. `initial_contracts` is the position's size at entry (the merged
    # trade's size_contracts) and `risk_usd` this slice's share of the risk
    # frozen at entry (so the merged R = total P&L / total risk).
    trade_key: Optional[str] = None
    initial_contracts: Optional[int] = None
    risk_usd: Optional[float] = None
    # Section 3.5 (G3): the Place Order dialog's tags / ticked checklist rules /
    # journal draft, applied when this request CREATES the trade (a later exit
    # merging into it leaves them alone).
    tags: List[str] = Field(default_factory=list)
    checklist: List[str] = Field(default_factory=list)
    notes: str = ""


# --- FXR_SPEC.md section C, phase F5: journaling on top of the auto-logged
# trade. A screenshot's BYTES live in their own file under the session's
# directory (bt_session_service._screenshots_dir), served back through a
# dedicated endpoint -- trades.json (and, via the account-balance write in
# record_trade, session.json) get rewritten on nearly every journal edit, so
# embedding a screenshot's data URL directly in either would mean re-writing
# every OTHER trade's screenshots, in full, on every single journal edit in
# the session. Only this lightweight reference is persisted in trades.json.

class Screenshot(BaseModel):
    id: str
    caption: Optional[str] = None
    # Which moment of the trade this captures -- "entry"/"exit" per
    # FXR_SPEC's own wording, or "custom" for any other capture the user
    # takes while reviewing. Display-only categorization, not enforced
    # against the trade's actual entry_time/exit_time.
    moment: str = "custom"
    # Where the frontend fetches the actual image bytes from (GET, served
    # by bt_sessions.get_screenshot) -- never the image data itself.
    url: str
    created_at: str


class TradeExit(BaseModel):
    """One exit of a (possibly partially closed) trade -- FXR_V2_SPEC.md 3.6."""
    time: int
    price: float
    contracts: int
    pnl_usd: float  # net of this exit's commission
    commission_usd: float
    exit_type: str
    risk_usd: Optional[float] = None
    # This exit's own max adverse excursion (points, entry..this exit): the
    # prop replay uses it as the low-equity point at THIS exit's time.
    mae_points: Optional[float] = None


class ManualTrade(TradeRecord):
    session_id: str
    # "manual" (the browser's sim broker) or "bot" (Autopilot, written only by the
    # server: CreateManualTradeRequest has no source, so a client cannot forge it).
    source: str = "manual"
    # Partial exits (3.6): one trade, several exits. The trade-level pnl_usd /
    # commission_usd / exit_price (contract-weighted) / exit_time (latest) /
    # r_multiple are aggregates over `exits`; size_contracts is the size at
    # entry, so a trade is still partly open while sum(exit contracts) <
    # size_contracts. Empty for trades journaled before G2 (one implicit exit).
    trade_key: Optional[str] = None
    exits: List[TradeExit] = Field(default_factory=list)
    # Journal fields (F5): absent from CreateManualTradeRequest below --
    # the sim broker journals a bare trade record the moment it closes
    # (F2), and these are filled in afterward via update_trade_journal (or,
    # for screenshots, add_trade_screenshot -- see that function's own
    # comment for why it's a separate endpoint from the rest). Tag taxonomy
    # is user-editable (FXR_SPEC section C) -- a flat freeform list, not a
    # fixed enum -- while grade/setup_name get their own dedicated fields
    # since the UI treats them as single-value pickers, not tags.
    notes: str = ""
    tags: List[str] = Field(default_factory=list)
    # The strategy-checklist rules that were ticked in the Place Order dialog.
    checklist: List[str] = Field(default_factory=list)
    setup_name: Optional[str] = None
    grade: Optional[str] = None  # "A" | "B" | "C" | None, validated in the service layer
    screenshots: List[Screenshot] = Field(default_factory=list)


class UpdateTradeJournalRequest(BaseModel):
    # Every field optional and merged via exclude_unset (not exclude_none):
    # a PATCH that only wants to set the grade must never accidentally null
    # out notes/tags it didn't mean to touch. Screenshots are deliberately
    # NOT here -- see add_trade_screenshot/delete_trade_screenshot below.
    notes: Optional[str] = None
    tags: Optional[List[str]] = None
    setup_name: Optional[str] = None
    grade: Optional[str] = None


class AddScreenshotRequest(BaseModel):
    # A data URL (what klinecharts' getConvertPictureUrl returns client-
    # side) -- decoded and written to its own file server-side; never
    # stored as-is (see Screenshot's own comment).
    data_url: str
    moment: str = "custom"
    caption: Optional[str] = None


class RecordTradeResponse(BaseModel):
    trade: ManualTrade
    session: BacktestSessionDetail


# --- FXR_V2_SPEC.md section 4 (G6): the home page and the setup form. ---

class InstrumentRange(BaseModel):
    """First and last 1-minute bar of an instrument's data (unix seconds)."""
    min: int
    max: int


class PropPreset(BaseModel):
    id: str
    label: str
    starting_balance: float
    rules: PropRules


class SessionSetupOptions(BaseModel):
    """What the New session form needs from the server: each asset's data
    range, the prop presets, and the default commission per contract."""
    ranges: Dict[str, InstrumentRange]
    presets: List[PropPreset]
    default_commissions: Dict[str, float]


class HomeKpis(BaseModel):
    trades: int = 0
    buys: int = 0
    sells: int = 0
    wins: int = 0
    win_rate: Optional[float] = None
    avg_time_in_trade_seconds: Optional[float] = None


class WeekdayWinRate(BaseModel):
    weekday: int  # 0 = Monday ... 6 = Sunday, the ET day the trade was entered
    label: str
    trades: int = 0
    wins: int = 0
    win_rate: Optional[float] = None


class HomeOverview(BaseModel):
    kpis: HomeKpis
    weekday: List[WeekdayWinRate]


# --- FXR_V2_SPEC.md section 6 (G7): the economic calendar. Only what is known
# in advance: when an event is scheduled, its name and its impact. News_events.csv
# carries no actual/forecast/previous values, and none is ever added: a scheduled
# event ahead of the cursor is fine to show, its outcome is not.

class NewsEvent(BaseModel):
    time: int  # unix seconds, the scheduled release
    event: str
    impact: str  # "high" (the only grade the calendar file lists)


# --- FXR_V2_SPEC.md section 6 (G8): the Analytics page and the prop-rules modal. ---

class RrRow(BaseModel):
    """One line of the RR simulator: every qualifying trade replayed with a
    target at `n` x its entry risk (n is None on the "as taken" line)."""
    n: Optional[int] = None
    trades: int
    wins: int
    win_rate: Optional[float] = None
    net_pnl_usd: float
    # None when there is no losing trade (an infinite factor).
    profit_factor: Optional[float] = None
    # Mean worst open loss before the trade ended, per trade.
    avg_drawdown_usd: Optional[float] = None
    avg_drawdown_r: Optional[float] = None


class RrSimulatorResponse(BaseModel):
    scope: str
    instrument: Optional[str] = None
    total_trades: int
    qualified: int
    # reason -> trades left out (no_stop_at_entry, still_open, ...)
    excluded: Dict[str, int] = Field(default_factory=dict)
    min_trades: int
    enough: bool
    rows: List[RrRow] = Field(default_factory=list)
    actual: Optional[RrRow] = None


class PeriodAverage(BaseModel):
    value: Optional[float] = None
    periods: int = 0


class AnalyticsStats(BaseModel):
    trades: int = 0
    wins: int = 0
    losses: int = 0
    win_rate: Optional[float] = None
    net_pnl_usd: float = 0.0
    gross_profit_usd: float = 0.0
    gross_loss_usd: float = 0.0
    profit_factor: Optional[float] = None
    avg_win_usd: Optional[float] = None
    avg_loss_usd: Optional[float] = None
    # Mean realized R per trade, over the trades that have one (a stop defined 1R).
    avg_r: Optional[float] = None
    r_trades: int = 0
    # Mean planned R:R at entry: target distance / stop distance, over the trades
    # that recorded both an entry stop and an entry target.
    avg_planned_rr: Optional[float] = None
    planned_rr_trades: int = 0
    avg_gain_month: PeriodAverage = Field(default_factory=PeriodAverage)
    avg_gain_week: PeriodAverage = Field(default_factory=PeriodAverage)
    avg_gain_day: PeriodAverage = Field(default_factory=PeriodAverage)


class EquityStep(BaseModel):
    time: int
    pnl_usd: float  # cumulative net P&L after this exit


class PeriodBucket(BaseModel):
    key: str        # "2025-04" for a month, "0".."4" (Mon..Fri) for a weekday
    label: str
    trades: int
    wins: int
    net_pnl_usd: float
    win_rate: Optional[float] = None


class HeatOnWinners(BaseModel):
    """How far winning trades went against the entry before they won, in R
    (mae_r from the sim broker)."""
    sample: int = 0
    avg_r: Optional[float] = None
    max_r: Optional[float] = None
    min_r: Optional[float] = None


class AnalyticsSession(BaseModel):
    id: str
    name: str
    assets: List[str]


class AnalyticsSummary(BaseModel):
    run_id: str
    instrument: Optional[str] = None
    instruments: List[str] = Field(default_factory=list)
    sessions: List[AnalyticsSession] = Field(default_factory=list)
    starting_balance: Optional[float] = None
    stats: AnalyticsStats
    equity: List[EquityStep] = Field(default_factory=list)
    monthly: List[PeriodBucket] = Field(default_factory=list)
    weekday: List[PeriodBucket] = Field(default_factory=list)
    heat: HeatOnWinners = Field(default_factory=HeatOnWinners)


class PropRuleRow(BaseModel):
    key: str
    label: str
    value: str


class PropRestriction(BaseModel):
    key: str
    label: str
    detail: str
    on: bool


class PropProgress(BaseModel):
    """One progress card: `used` of `limit`, `left` to go. All dollars."""
    limit: Optional[float] = None
    used: float = 0.0
    left: Optional[float] = None
    fraction: float = 0.0   # used / limit, 0..1


class PropRulesStatus(BaseModel):
    """Where a prop session stands against its rules RIGHT NOW. Every number is
    read from propbt's PropRulesTracker after replaying the journaled trades (and
    the open position's float, passed in as `open_pnl`); the frontend renders it."""
    status: str                       # passed | failed | incomplete
    fail_reason: Optional[str] = None
    label: str
    starting_balance: float
    balance: float                    # realized
    open_pnl: float
    equity: float                     # realized + open
    profit: PropProgress              # target: used = realized profit
    max_loss: PropProgress            # used = how much of the loss budget is gone
    max_loss_floor: float
    max_loss_type: str
    max_loss_frozen: bool
    daily_loss: PropProgress
    daily_locked: bool
    day_start_balance: float
    target_hit: bool
    consistency_pct: Optional[float] = None
    consistency_passed: Optional[bool] = None
    best_day_pnl: Optional[float] = None
    # best_day_pnl / realized profit, the ratio the consistency rule limits (None until in profit).
    best_day_share: Optional[float] = None
    trading_days: int = 0
    rules: List[PropRuleRow] = Field(default_factory=list)
    restrictions: List[PropRestriction] = Field(default_factory=list)


# --- G9b: drawings, named layouts and style templates persisted with the session ----
# Drawings are the user's own visual notes, never a source of trades or P&L, so the
# backend stores them verbatim and validates only their envelope (id/name/points);
# every other field the chart wrote (styles, lock, visible, extendDataText) passes through.

class StoredOverlay(BaseModel):
    model_config = ConfigDict(extra="allow")
    id: str = Field(min_length=1, max_length=200)
    name: str = Field(min_length=1, max_length=100)
    points: List[Dict[str, Any]] = Field(default_factory=list)


class IndicatorToggles(BaseModel):
    session_shading: bool = False
    fair_value: bool = False
    news_events: bool = False
    vwap: bool = False
    ema20: bool = False
    ema50: bool = False
    atr14: bool = False
    volume: bool = False


class StoredLayout(BaseModel):
    """A named chart layout: a snapshot of the chart's view (FXR_V2_SPEC.md section 7)."""
    id: str = Field(min_length=1, max_length=200)
    name: str = Field(min_length=1, max_length=80)
    indicators: IndicatorToggles = Field(default_factory=IndicatorToggles)
    candle_type: str = Field(default="candles", max_length=40)
    timeframe: str = Field(default="5min", max_length=20)
    # The session's own drawings per instrument at the time the layout was saved.
    drawings: Dict[str, List[StoredOverlay]] = Field(default_factory=dict)
    shared_visible: bool = False

    @field_validator("name")
    @classmethod
    def _strip_name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("name must not be blank")
        return v


class StyleTemplate(BaseModel):
    """A drawing style (colour + line width) the user can reapply."""
    id: str = Field(min_length=1, max_length=200)
    name: str = Field(min_length=1, max_length=80)
    color: str = Field(min_length=1, max_length=40)
    width: float = Field(gt=0, le=20)

    @field_validator("name")
    @classmethod
    def _strip_name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("name must not be blank")
        return v


class SessionDrawings(BaseModel):
    """What one session keeps beside session.json (drawings.json)."""
    # The session's OWN drawings, per instrument. Never the shared layer.
    drawings: Dict[str, List[StoredOverlay]] = Field(default_factory=dict)
    layouts: List[StoredLayout] = Field(default_factory=list)
    # Whether the session's chart shows the shared layer (off until switched on).
    shared_visible: bool = False
    # Set once this session's data left browser storage for the server (the one-off
    # migration); a second import is then a no-op, so nothing is ever duplicated.
    imported_from_browser: bool = False


class UpdateSessionDrawingsRequest(BaseModel):
    """Only the fields sent change. `drawings` replaces the listed instruments' sets
    (an empty list clears one); instruments not listed are left alone."""
    drawings: Optional[Dict[str, List[StoredOverlay]]] = None
    layouts: Optional[List[StoredLayout]] = None
    shared_visible: Optional[bool] = None


class WorkspaceDrawings(BaseModel):
    """Drawing state that belongs to no single session: the shared layer (per
    instrument; also what the automated-run review chart draws on) and the style
    templates."""
    shared: Dict[str, List[StoredOverlay]] = Field(default_factory=dict)
    style_templates: List[StyleTemplate] = Field(default_factory=list)
    # The template new drawings are created with (None = the default style).
    new_drawing_template_id: Optional[str] = None
    imported_from_browser: bool = False


class UpdateWorkspaceDrawingsRequest(BaseModel):
    shared: Optional[Dict[str, List[StoredOverlay]]] = None
    style_templates: Optional[List[StyleTemplate]] = None
    new_drawing_template_id: Optional[str] = None


class SessionDrawingsImport(BaseModel):
    drawings: Dict[str, List[StoredOverlay]] = Field(default_factory=dict)
    layouts: List[StoredLayout] = Field(default_factory=list)
    shared_visible: bool = False


class BrowserDrawingsImport(BaseModel):
    """Everything the first G9 kept in browser storage, sent once."""
    shared: Dict[str, List[StoredOverlay]] = Field(default_factory=dict)
    style_templates: List[StyleTemplate] = Field(default_factory=list)
    new_drawing_template_id: Optional[str] = None
    sessions: Dict[str, SessionDrawingsImport] = Field(default_factory=dict)


class BrowserDrawingsImportResult(BaseModel):
    # Sessions whose data the server now holds (imported now, or already imported
    # earlier) -- the browser may drop its copy of exactly these.
    sessions_imported: List[str] = Field(default_factory=list)
    # Sessions this server has no directory for: nothing was written, and the
    # browser must keep its copy.
    sessions_missing: List[str] = Field(default_factory=list)
    # True once the shared layer and templates are on the server.
    workspace_imported: bool = False
