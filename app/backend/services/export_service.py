"""Static-snapshot HTML export (VIZ_SPEC section 1: "keep a hybrid
static-snapshot export as an optional later feature, not the primary
path"). Deliberately cheap: reuses bundle_reader's existing service
functions for meta/stats/trades (no new data logic) and renders a single
self-contained HTML string -- no charting library, no JS, just a dark-
themed summary + trade table someone can open offline or attach to an
email. NOT a replacement for the interactive app.
"""
from __future__ import annotations

from html import escape

from app.backend.services import bundle_reader


def _fmt_usd(v) -> str:
    if v is None:
        return "-"
    sign = "-" if v < 0 else ""
    return f"{sign}${abs(v):,.2f}"


def _fmt_pct(v) -> str:
    return "-" if v is None else f"{v * 100:.1f}%"


def _fmt_r(v) -> str:
    return "-" if v is None else f"{v:.2f}R"


def render_snapshot_html(run_id: str) -> str:
    meta = bundle_reader.get_run_meta(run_id)  # raises RunNotFound
    stats = bundle_reader.get_stats(run_id, scope="all")
    trades = bundle_reader.list_trades(run_id)

    overall = stats.overall
    result = stats.result

    result_html = ""
    if result:
        status_color = {"passed": "#3fb950", "failed": "#f85149"}.get(result.status, "#c9d1d9")
        result_html = f"""
        <div class="banner">
          <span style="color:{status_color}; font-weight:600">{escape(result.status.upper())}</span>
          {f'<span class="muted">({escape(result.fail_reason)})</span>' if result.fail_reason else ''}
          <span class="muted">target hit: {'yes' if result.target_hit else 'no'}</span>
          <span class="muted">consistency: {'n/a' if result.consistency_passed is None else ('passed' if result.consistency_passed else 'failed')}</span>
          <span class="muted">final balance: {_fmt_usd(result.final_balance)}</span>
        </div>"""

    kpi_rows = [
        ("Net PnL", _fmt_usd(overall.net_pnl_usd)),
        ("Net R", _fmt_r(overall.net_r)),
        ("Win rate", _fmt_pct(overall.win_rate)),
        ("Expectancy", _fmt_usd(overall.expectancy_usd)),
        ("Profit factor", "-" if overall.profit_factor is None else f"{overall.profit_factor:.2f}"),
        ("Max drawdown", _fmt_usd(overall.max_drawdown_usd)),
        ("Trades", str(overall.trades)),
        ("Trading days", str(result.trading_days) if result else "-"),
    ]
    kpi_html = "".join(f'<div class="kpi"><div class="kpi-label">{k}</div><div class="kpi-value">{v}</div></div>' for k, v in kpi_rows)

    trade_rows = "".join(
        f"""<tr>
          <td>{t.trade_id}</td>
          <td class="mono">{t.entry_time}</td>
          <td>{escape(t.leg or '-')}</td>
          <td>{escape(t.session or '-')}</td>
          <td>{escape(t.side)}</td>
          <td>{t.entry_price:.2f}</td>
          <td>{t.exit_price:.2f}</td>
          <td>{escape(t.exit_type)}</td>
          <td class="{'pos' if t.pnl_usd >= 0 else 'neg'}">{_fmt_usd(t.pnl_usd)}</td>
          <td>{_fmt_r(t.r_multiple)}</td>
        </tr>"""
        for t in trades
    )

    return f"""<!doctype html>
<html lang="en" style="color-scheme: dark">
<head>
<meta charset="utf-8">
<title>propbt snapshot -- {escape(run_id)}</title>
<style>
  body {{ background: #0d1117; color: #c9d1d9; font-family: -apple-system, Segoe UI, sans-serif; margin: 0; padding: 24px; }}
  h1 {{ font-size: 16px; font-weight: 600; color: #e6edf3; margin: 0 0 4px; }}
  .muted {{ color: #8b949e; font-size: 12px; }}
  .mono {{ font-family: ui-monospace, monospace; font-size: 11px; }}
  .banner {{ background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 10px 14px; margin: 16px 0; display: flex; gap: 16px; align-items: center; font-size: 13px; }}
  .kpis {{ display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 16px 0; }}
  .kpi {{ background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 8px 12px; }}
  .kpi-label {{ font-size: 10px; text-transform: uppercase; color: #8b949e; letter-spacing: 0.04em; }}
  .kpi-value {{ font-size: 16px; font-weight: 600; color: #e6edf3; margin-top: 2px; }}
  table {{ width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 8px; }}
  th, td {{ text-align: left; padding: 5px 10px; border-bottom: 1px solid #21262d; }}
  th {{ color: #8b949e; font-weight: 500; position: sticky; top: 0; background: #0d1117; }}
  .pos {{ color: #3fb950; }}
  .neg {{ color: #f85149; }}
</style>
</head>
<body>
  <h1>propbt viz -- static snapshot</h1>
  <div class="muted">
    run {escape(run_id)} &middot; {escape(meta.instrument)} &middot; {escape(meta.date_from)} &rarr; {escape(meta.date_to)}
    &middot; config {escape(meta.config_name)} &middot; generated as a read-only offline copy (VIZ_SPEC hybrid export)
  </div>
  {result_html}
  <div class="kpis">{kpi_html}</div>
  <h2 style="font-size:13px;color:#e6edf3;margin-top:24px">Trades ({len(trades)})</h2>
  <table>
    <thead>
      <tr><th>#</th><th>Entry (unix)</th><th>Leg</th><th>Session</th><th>Side</th><th>Entry</th><th>Exit</th><th>Exit type</th><th>PnL</th><th>R</th></tr>
    </thead>
    <tbody>{trade_rows}</tbody>
  </table>
</body>
</html>"""
