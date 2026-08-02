"""Self-contained HTML trade-review report: a candlestick chart with every
trade's entry/exit/SL/TP overlaid, a sortable trade list, and pan/zoom
within each trading day that had a trade. No server, no external JS/CSS
(everything -- data included -- is embedded in one file); open it by
double-clicking.

Only trading days that actually had a trade get their bars embedded (not
the whole backtest range), so file size scales with trade count, not
backtest duration -- a multi-year backtest with 200 trades still produces
a report in the low single-digit MB, not gigabytes.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, List, Optional, Union

import pandas as pd

from propbt.data.sessions import tag_sessions
from propbt.reporting.metrics import BacktestSummary, Trade, TradeStats


def _stat_block(label: str, stats: TradeStats) -> str:
    if stats.n_trades == 0:
        value = "n/a (0 trades)"
    else:
        value = f"{stats.n_trades} trades, {stats.win_rate:.0%} win, ${stats.expectancy_dollars:,.2f} ({stats.expectancy_r:.2f}R)"
    return f'<div class="stat"><div class="label">{label}</div><div class="value">{value}</div></div>'


def _summary_html(summary: Optional[BacktestSummary]) -> str:
    if summary is None:
        return ""
    blocks = [_stat_block("Overall", summary.overall)]
    for name, stats in summary.by_leg.items():
        blocks.append(_stat_block(f"leg: {name}", stats))
    for name, stats in summary.by_session.items():
        blocks.append(_stat_block(f"session: {name}", stats))
    return '<div class="summary">' + "".join(blocks) + "</div>"


def _ms(ts: pd.Timestamp) -> int:
    return int(ts.value // 1_000_000)


def _build_data(price_df: pd.DataFrame, trades: List[Trade], sessions_config) -> dict:
    tagged = tag_sessions(price_df, sessions_config)
    day_col = tagged["trading_day"]

    trade_records = []
    traded_days = set()
    for i, t in enumerate(trades):
        if t.entry_ts not in day_col.index:
            continue  # shouldn't happen if price_df is the same data the backtest ran on
        day = day_col.loc[t.entry_ts]
        if day is None:
            continue
        traded_days.add(day)
        trade_records.append({
            "id": i,
            "day": day.isoformat(),
            "entry_ts": _ms(t.entry_ts),
            "exit_ts": _ms(t.exit_ts),
            "entry_price": t.entry_price,
            "exit_price": t.exit_price,
            "sl_price": t.sl_price,
            "tp_price": t.tp_price,
            "side": t.side.value,
            "leg": t.leg,
            "session": t.session,
            "realized_pnl": round(t.realized_pnl, 2),
            "r_multiple": round(t.r_multiple, 3) if t.r_multiple is not None else None,
            "exit_type": t.exit_type.value,
            "contracts": t.contracts,
        })
    trade_records.sort(key=lambda r: r["entry_ts"])

    days: Dict[str, dict] = {}
    for day in traded_days:
        day_df = tagged.loc[day_col == day]
        bars = [
            [_ms(ts), float(row["open"]), float(row["high"]), float(row["low"]), float(row["close"]), int(row["volume"])]
            for ts, row in day_df.iterrows()
        ]
        days[day.isoformat()] = {"bars": bars}

    return {"trades": trade_records, "days": days}


_HTML_TEMPLATE = r"""<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Trade review -- __SYMBOL__</title>
<style>
  :root { --bg:#0d1117; --panel:#161b22; --border:#30363d; --text:#c9d1d9; --muted:#8b949e;
          --green:#3fb950; --red:#f85149; --blue:#58a6ff; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font-family: -apple-system,"Segoe UI",Roboto,sans-serif; font-size:13px; }
  header { padding:12px 16px; border-bottom:1px solid var(--border); }
  header h1 { margin:0 0 8px; font-size:16px; font-weight:600; }
  .summary { display:flex; gap:24px; flex-wrap:wrap; }
  .summary .label { color:var(--muted); font-size:11px; text-transform:uppercase; }
  .summary .value { font-size:13px; font-weight:600; }
  .layout { display:flex; height:calc(100vh - 96px); }
  .sidebar { width:460px; border-right:1px solid var(--border); overflow-y:auto; flex-shrink:0; }
  table { width:100%; border-collapse:collapse; }
  th, td { padding:6px 8px; text-align:right; border-bottom:1px solid var(--border); white-space:nowrap; }
  th:first-child, td:first-child { text-align:left; }
  th { position:sticky; top:0; background:var(--panel); cursor:pointer; color:var(--muted); font-weight:600; user-select:none; }
  tr.trade-row { cursor:pointer; }
  tr.trade-row:hover { background:#1c2129; }
  tr.trade-row.selected { background:#1f2937; outline:1px solid var(--blue); outline-offset:-1px; }
  .pnl-pos { color:var(--green); }
  .pnl-neg { color:var(--red); }
  .chart-area { flex:1; display:flex; flex-direction:column; min-width:0; }
  .toolbar { padding:8px 16px; border-bottom:1px solid var(--border); display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  button { background:var(--panel); border:1px solid var(--border); color:var(--text); padding:4px 10px; border-radius:4px; cursor:pointer; font-size:12px; }
  button:hover { background:#1c2129; }
  .trade-detail { color:var(--muted); }
  canvas { flex:1; display:block; width:100%; height:100%; cursor:grab; }
  canvas:active { cursor:grabbing; }
  .legend { display:flex; gap:16px; padding:6px 16px; font-size:11px; color:var(--muted); border-top:1px solid var(--border); }
  .legend .swatch { display:inline-block; width:10px; height:2px; margin-right:4px; vertical-align:middle; }
  .empty { padding:40px; color:var(--muted); text-align:center; }
</style>
</head>
<body>
<header>
  <h1>Trade review -- __SYMBOL__ (__START__ &rarr; __END__)</h1>
  __SUMMARY_HTML__
</header>
<div class="layout">
  <div class="sidebar">
    <table id="trade-table">
      <thead><tr>
        <th data-key="entry_ts">Entry</th><th data-key="leg">Leg</th><th data-key="session">Sess</th>
        <th data-key="side">Side</th><th data-key="realized_pnl">PnL</th><th data-key="r_multiple">R</th><th data-key="exit_type">Exit</th>
      </tr></thead>
      <tbody id="trade-tbody"></tbody>
    </table>
  </div>
  <div class="chart-area">
    <div class="toolbar">
      <button id="prev-btn">&larr; Prev</button>
      <button id="next-btn">Next &rarr;</button>
      <button id="fit-btn">Fit trade</button>
      <button id="day-btn">Full day</button>
      <span class="trade-detail" id="trade-detail"></span>
    </div>
    <canvas id="chart"></canvas>
    <div class="legend">
      <span><span class="swatch" style="background:var(--red)"></span>Stop loss</span>
      <span><span class="swatch" style="background:var(--green)"></span>Take profit</span>
      <span><span class="swatch" style="background:var(--blue)"></span>Entry marker</span>
      <span>Scroll to zoom &middot; drag to pan &middot; click a row to jump to that trade</span>
    </div>
  </div>
</div>
<script>
const DATA = __DATA_JSON__;
const canvas = document.getElementById('chart');
const ctx = canvas.getContext('2d');
let currentTrade = 0;
let view = { start: 0, count: 100 };

function dayBars(trade) { return DATA.days[trade.day].bars; }

function fmtTime(ms) {
  const d = new Date(ms);
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
  canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
}

function idxForTs(bars, ts) {
  let idx = bars.findIndex(b => b[0] >= ts);
  if (idx < 0) idx = bars.length - 1;
  return idx;
}

function fitViewToTrade(trade) {
  const bars = dayBars(trade);
  const entryIdx = idxForTs(bars, trade.entry_ts);
  const exitIdx = idxForTs(bars, trade.exit_ts);
  const pad = Math.max(15, Math.floor((exitIdx - entryIdx) * 0.6));
  const start = Math.max(0, entryIdx - pad);
  const end = Math.min(bars.length, exitIdx + pad + 1);
  view = { start, count: Math.max(10, end - start) };
}

function fitViewToDay(trade) {
  view = { start: 0, count: dayBars(trade).length };
}

function selectTrade(idx) {
  currentTrade = Math.max(0, Math.min(DATA.trades.length - 1, idx));
  const trade = DATA.trades[currentTrade];
  fitViewToTrade(trade);
  document.querySelectorAll('#trade-tbody tr').forEach(tr => tr.classList.remove('selected'));
  const row = document.querySelector(`#trade-tbody tr[data-idx="${currentTrade}"]`);
  if (row) { row.classList.add('selected'); row.scrollIntoView({ block: 'nearest' }); }
  const rTxt = trade.r_multiple !== null ? trade.r_multiple.toFixed(2) + 'R' : 'R n/a';
  document.getElementById('trade-detail').textContent =
    `${trade.leg || '-'}  |  ${trade.session || '-'}  |  ${trade.side}  |  ` +
    `entry ${trade.entry_price} -> exit ${trade.exit_price}  |  ` +
    `$${trade.realized_pnl.toFixed(2)} (${rTxt})  |  ${trade.exit_type}`;
  render();
}

function render() {
  if (DATA.trades.length === 0) return;
  resizeCanvas();
  const trade = DATA.trades[currentTrade];
  const bars = dayBars(trade);
  const start = Math.max(0, Math.min(view.start, bars.length - 1));
  const count = Math.max(5, Math.min(view.count, bars.length - start));
  const visible = bars.slice(start, start + count);
  if (visible.length === 0) return;

  const W = canvas.width, H = canvas.height;
  const marginLeft = 8, marginRight = 64, marginTop = 16, marginBottom = 28;
  const plotW = Math.max(1, W - marginLeft - marginRight);
  const plotH = Math.max(1, H - marginTop - marginBottom);

  let lo = Infinity, hi = -Infinity;
  for (const b of visible) { lo = Math.min(lo, b[3]); hi = Math.max(hi, b[2]); }
  for (const lvl of [trade.sl_price, trade.tp_price, trade.entry_price, trade.exit_price]) {
    if (lvl !== null && lvl !== undefined) { lo = Math.min(lo, lvl); hi = Math.max(hi, lvl); }
  }
  const padPrice = (hi - lo) * 0.08 || 1;
  lo -= padPrice; hi += padPrice;

  const xOf = i => marginLeft + (i + 0.5) / count * plotW;
  const yOf = p => marginTop + (1 - (p - lo) / (hi - lo)) * plotH;

  ctx.fillStyle = '#0d1117'; ctx.fillRect(0, 0, W, H);

  const dpr = window.devicePixelRatio || 1;
  ctx.font = `${11 * dpr}px sans-serif`;
  ctx.strokeStyle = '#21262d';
  const priceSteps = 6;
  for (let s = 0; s <= priceSteps; s++) {
    const p = lo + (hi - lo) * s / priceSteps;
    const y = yOf(p);
    ctx.beginPath(); ctx.moveTo(marginLeft, y); ctx.lineTo(W - marginRight, y); ctx.stroke();
    ctx.fillStyle = '#8b949e'; ctx.fillText(p.toFixed(2), W - marginRight + 6, y + 4);
  }

  const barW = Math.max(1, plotW / count * 0.7);
  visible.forEach((b, i) => {
    const [ts, o, h, l, c] = b;
    const x = xOf(i);
    const up = c >= o;
    ctx.strokeStyle = ctx.fillStyle = up ? '#3fb950' : '#f85149';
    ctx.beginPath(); ctx.moveTo(x, yOf(h)); ctx.lineTo(x, yOf(l)); ctx.stroke();
    const yO = yOf(o), yC = yOf(c);
    const top = Math.min(yO, yC), height = Math.max(1, Math.abs(yC - yO));
    ctx.fillRect(x - barW / 2, top, barW, height);
  });

  const entryRelIdx = idxForTs(bars, trade.entry_ts) - start;
  const exitRelIdx = idxForTs(bars, trade.exit_ts) - start;

  if (entryRelIdx < count && exitRelIdx >= 0) {
    const xa = xOf(Math.max(0, entryRelIdx));
    const xb = xOf(Math.min(count - 1, exitRelIdx));
    ctx.fillStyle = 'rgba(88,166,255,0.07)';
    ctx.fillRect(Math.min(xa, xb), marginTop, Math.max(1, Math.abs(xb - xa)), plotH);
  }

  function hline(price, color) {
    if (price === null || price === undefined) return;
    const y = yOf(price);
    ctx.save();
    ctx.strokeStyle = color; ctx.setLineDash([6, 4]);
    ctx.beginPath(); ctx.moveTo(marginLeft, y); ctx.lineTo(W - marginRight, y); ctx.stroke();
    ctx.restore();
    ctx.fillStyle = color; ctx.fillText(price.toFixed(2), 4, y - 4);
  }
  hline(trade.sl_price, '#f85149');
  hline(trade.tp_price, '#3fb950');

  const xEntry = xOf(Math.max(0, Math.min(count - 1, entryRelIdx)));
  const xExit = xOf(Math.max(0, Math.min(count - 1, exitRelIdx)));

  ctx.fillStyle = '#58a6ff';
  const yEntry = yOf(trade.entry_price);
  ctx.beginPath();
  if (trade.side === 'long') { ctx.moveTo(xEntry - 6, yEntry + 9); ctx.lineTo(xEntry + 6, yEntry + 9); ctx.lineTo(xEntry, yEntry - 3); }
  else { ctx.moveTo(xEntry - 6, yEntry - 9); ctx.lineTo(xEntry + 6, yEntry - 9); ctx.lineTo(xEntry, yEntry + 3); }
  ctx.closePath(); ctx.fill();

  ctx.fillStyle = trade.realized_pnl >= 0 ? '#3fb950' : '#f85149';
  ctx.beginPath(); ctx.arc(xExit, yOf(trade.exit_price), 5, 0, Math.PI * 2); ctx.fill();

  ctx.fillStyle = '#8b949e';
  const timeSteps = Math.min(6, count - 1);
  if (timeSteps > 0) {
    for (let s = 0; s <= timeSteps; s++) {
      const idx = Math.min(count - 1, Math.round(s / timeSteps * (count - 1)));
      const x = xOf(idx);
      ctx.fillText(fmtTime(visible[idx][0]).slice(5), Math.max(marginLeft, x - 28), H - marginBottom + 18);
    }
  }
}

let dragging = false, dragStartX = 0, dragStartView = 0;
canvas.addEventListener('mousedown', e => { dragging = true; dragStartX = e.clientX; dragStartView = view.start; });
window.addEventListener('mouseup', () => { dragging = false; });
window.addEventListener('mousemove', e => {
  if (!dragging || DATA.trades.length === 0) return;
  const bars = dayBars(DATA.trades[currentTrade]);
  const dx = e.clientX - dragStartX;
  const barsPerPixel = view.count / Math.max(1, canvas.clientWidth);
  const shift = Math.round(-dx * barsPerPixel);
  view.start = Math.max(0, Math.min(Math.max(0, bars.length - view.count), dragStartView + shift));
  render();
});
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  if (DATA.trades.length === 0) return;
  const bars = dayBars(DATA.trades[currentTrade]);
  const factor = e.deltaY > 0 ? 1.15 : 0.87;
  const newCount = Math.max(10, Math.min(bars.length, Math.round(view.count * factor)));
  const center = view.start + view.count / 2;
  view.start = Math.max(0, Math.min(Math.max(0, bars.length - newCount), Math.round(center - newCount / 2)));
  view.count = newCount;
  render();
}, { passive: false });

document.getElementById('prev-btn').onclick = () => selectTrade(currentTrade - 1);
document.getElementById('next-btn').onclick = () => selectTrade(currentTrade + 1);
document.getElementById('fit-btn').onclick = () => { fitViewToTrade(DATA.trades[currentTrade]); render(); };
document.getElementById('day-btn').onclick = () => { fitViewToDay(DATA.trades[currentTrade]); render(); };
window.addEventListener('resize', render);

const tbody = document.getElementById('trade-tbody');
function buildRows(trades) {
  tbody.innerHTML = '';
  trades.forEach(t => {
    const idx = t.id;
    const tr = document.createElement('tr');
    tr.className = 'trade-row';
    tr.dataset.idx = idx;
    const pnlClass = t.realized_pnl >= 0 ? 'pnl-pos' : 'pnl-neg';
    const rTxt = t.r_multiple !== null ? t.r_multiple.toFixed(2) : '-';
    tr.innerHTML = `<td>${fmtTime(t.entry_ts)}</td><td>${t.leg || '-'}</td><td>${t.session || '-'}</td>` +
      `<td>${t.side}</td><td class="${pnlClass}">$${t.realized_pnl.toFixed(2)}</td>` +
      `<td>${rTxt}</td><td>${t.exit_type}</td>`;
    tr.onclick = () => selectTrade(idx);
    tbody.appendChild(tr);
  });
}
buildRows(DATA.trades);

let sortState = { key: null, asc: true };
document.querySelectorAll('#trade-table th').forEach(th => {
  th.onclick = () => {
    const key = th.dataset.key;
    sortState.asc = (sortState.key === key) ? !sortState.asc : true;
    sortState.key = key;
    const sorted = [...DATA.trades].sort((a, b) => {
      let av = a[key], bv = b[key];
      if (av === null || av === undefined) av = -Infinity;
      if (bv === null || bv === undefined) bv = -Infinity;
      if (typeof av === 'string') return sortState.asc ? av.localeCompare(bv) : bv.localeCompare(av);
      return sortState.asc ? av - bv : bv - av;
    });
    buildRows(sorted);
  };
});

if (DATA.trades.length > 0) { selectTrade(0); }
else { document.querySelector('.chart-area').innerHTML = '<div class="empty">No trades to review.</div>'; }
</script>
</body>
</html>
"""


def export_trade_review(
    price_df: pd.DataFrame,
    trades: List[Trade],
    symbol: str,
    sessions_config,
    output_path: Union[str, Path],
    start: str = "",
    end: str = "",
    summary: Optional[BacktestSummary] = None,
) -> Path:
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    data = _build_data(price_df, trades, sessions_config)
    html = (
        _HTML_TEMPLATE
        .replace("__SYMBOL__", symbol)
        .replace("__START__", start)
        .replace("__END__", end)
        .replace("__SUMMARY_HTML__", _summary_html(summary))
        .replace("__DATA_JSON__", json.dumps(data))
    )
    output_path.write_text(html, encoding="utf-8")
    return output_path
