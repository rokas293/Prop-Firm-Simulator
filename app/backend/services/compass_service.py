"""Optional "Summarize this run" AI insight (POLISH_ROADMAP Phase P5). Sends
only already-aggregated stats (the same /stats payload the Dashboard panel
already renders) to Claude -- never raw trades or bars -- and asks for a
short plain-English read of strengths/weaknesses. Entirely optional: gated
on ANTHROPIC_API_KEY being set, so the rest of the app is unaffected when
it's absent (VIZ_SPEC section 0 still applies -- this only *describes*
numbers the engine already computed, it never asks the model to compute
anything).
"""
from __future__ import annotations

import os
from typing import Any, Dict

_MODEL = "claude-opus-5"

_SYSTEM_PROMPT = (
    "You are a trading-strategy analyst reviewing an intraday futures backtest. "
    "You are given ONLY already-computed aggregate statistics for one run -- "
    "never raw trades or price data -- so treat every number as ground truth "
    "from the backtesting engine; do not recompute, second-guess, or invent any "
    "numbers not given to you. Write a short, plain-English read of this run's "
    "strengths and weaknesses in under 200 words, in plain prose (no headers, "
    "no bullet lists). Reference specific numbers from the data. This is a "
    "research backtest, not investment advice -- do not recommend real-money "
    "trading or make forward-looking predictions."
)


class SummarizeError(Exception):
    pass


def is_configured() -> bool:
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return False
    try:
        import anthropic  # noqa: F401
    except ImportError:
        return False
    return True


def _fmt_group(label: str, g: Dict[str, Any]) -> str:
    win_rate = f"{g['win_rate'] * 100:.1f}%" if g.get("win_rate") is not None else "n/a"
    expectancy = f"${g['expectancy_usd']:.2f}" if g.get("expectancy_usd") is not None else "n/a"
    net_r = f"{g['net_r']:.2f}R" if g.get("net_r") is not None else "n/a"
    pf = f"{g['profit_factor']:.2f}" if g.get("profit_factor") is not None else "n/a"
    return (
        f"  {label}: {g['trades']} trades, net PnL ${g['net_pnl_usd']:.2f}, "
        f"win rate {win_rate}, expectancy {expectancy}, net R {net_r}, "
        f"profit factor {pf}, max drawdown ${g['max_drawdown_usd']:.2f}"
    )


def format_stats_for_prompt(stats: Dict[str, Any], scope: str) -> str:
    """Pure formatting, no network call -- kept separate so it's directly
    unit-testable without an API key."""
    overall = stats["overall"]
    lines = [f"Scope: {scope}", "", "Overall:", _fmt_group("overall", overall)]

    result = stats.get("result")
    if result:
        consistency = "n/a" if result["consistency_passed"] is None else ("passed" if result["consistency_passed"] else "failed")
        fail_reason = f" ({result['fail_reason']})" if result.get("fail_reason") else ""
        lines.append("")
        lines.append(
            f"Result: {result['status']}{fail_reason} -- target hit: "
            f"{'yes' if result['target_hit'] else 'no'}, consistency: {consistency}, "
            f"trading days: {result['trading_days']}, final balance: ${result['final_balance']:.2f}"
        )

    by_leg = stats.get("by_leg") or {}
    if by_leg:
        lines.append("")
        lines.append("By leg:")
        for k, g in by_leg.items():
            lines.append(_fmt_group(k, g))

    by_session = stats.get("by_session") or {}
    if by_session:
        lines.append("")
        lines.append("By session:")
        for k, g in by_session.items():
            lines.append(_fmt_group(k, g))

    return "\n".join(lines)


def summarize_stats(stats: Dict[str, Any], scope: str) -> str:
    import anthropic

    client = anthropic.Anthropic()
    prompt = format_stats_for_prompt(stats, scope)

    try:
        response = client.messages.create(
            model=_MODEL,
            max_tokens=1024,
            system=_SYSTEM_PROMPT,
            messages=[{"role": "user", "content": prompt}],
        )
    except anthropic.APIError as e:
        raise SummarizeError(f"Anthropic API request failed: {e}") from e

    if response.stop_reason == "refusal":
        raise SummarizeError("The model declined to summarize this run.")

    text = next((b.text for b in response.content if b.type == "text"), None)
    if not text:
        raise SummarizeError("Empty response from the model.")
    return text
