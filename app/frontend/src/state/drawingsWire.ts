// G9b: the store's shapes <-> the backend's (app/backend/models.py StoredLayout /
// StyleTemplate). Overlays themselves cross as they are (PersistedOverlay); only the
// names around them differ (the backend is snake_case).
import type { WireLayout, WireStyleTemplate } from '../api/types'
import type { DrawingStyleTemplate, NamedLayout } from './klDrawingStore'

export function toWireLayout(l: NamedLayout): WireLayout {
  return {
    id: l.id,
    name: l.name,
    indicators: {
      session_shading: !!l.indicators.sessionShading,
      fair_value: !!l.indicators.fairValue,
      news_events: !!l.indicators.newsEvents,
      vwap: !!l.indicators.vwap,
      ema20: !!l.indicators.ema20,
      ema50: !!l.indicators.ema50,
      atr14: !!l.indicators.atr14,
      volume: !!l.indicators.volume,
    },
    candle_type: l.candleType,
    timeframe: l.timeframe,
    drawings: l.drawings,
    shared_visible: l.sharedVisible,
  }
}

export function fromWireLayout(w: WireLayout): NamedLayout {
  return {
    id: w.id,
    name: w.name,
    indicators: {
      sessionShading: w.indicators.session_shading,
      fairValue: w.indicators.fair_value,
      newsEvents: w.indicators.news_events,
      vwap: w.indicators.vwap,
      ema20: w.indicators.ema20,
      ema50: w.indicators.ema50,
      atr14: w.indicators.atr14,
      volume: w.indicators.volume,
    },
    candleType: w.candle_type,
    timeframe: w.timeframe,
    drawings: w.drawings,
    sharedVisible: w.shared_visible,
  }
}

export function toWireTemplate(t: DrawingStyleTemplate): WireStyleTemplate {
  return { id: t.id, name: t.name, color: t.style.color, width: t.style.width }
}

export function fromWireTemplate(w: WireStyleTemplate): DrawingStyleTemplate {
  return { id: w.id, name: w.name, style: { color: w.color, width: w.width } }
}
