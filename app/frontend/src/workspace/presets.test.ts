import { describe, expect, it } from 'vitest'
import type { AddPanelOptions, DockviewApi } from 'dockview-react'
import {
  CHART_PANEL_ID,
  DASHBOARD_PANEL_ID,
  EQUITY_PANEL_ID,
  PROP_RISK_PANEL_ID,
  TRADE_LIST_PANEL_ID,
} from './panelIds'
import { applyAnalysisLayout, applyChartFocusedLayout, applyStatsLayout, PRESETS } from './presets'

// A minimal fake DockviewApi that just records what each preset does to it,
// so tests can assert on the actual panel graph produced rather than merely
// that the functions run without throwing.
function createFakeApi() {
  const cleared = { count: 0 }
  const added: AddPanelOptions[] = []
  const activated: string[] = []

  const api = {
    clear: () => {
      cleared.count += 1
    },
    addPanel: (options: AddPanelOptions) => {
      added.push(options)
    },
    getPanel: (id: string) => ({
      api: {
        setActive: () => {
          activated.push(id)
        },
      },
    }),
  } as unknown as DockviewApi

  return { api, cleared, added, activated }
}

function panel(added: AddPanelOptions[], id: string): AddPanelOptions | undefined {
  return added.find((p) => p.id === id)
}

describe('applyAnalysisLayout', () => {
  it('clears the layout before adding panels', () => {
    const { api, cleared } = createFakeApi()
    applyAnalysisLayout(api)
    expect(cleared.count).toBe(1)
  })

  it('adds all five panels, with Chart as the standalone hero (no position)', () => {
    const { api, added } = createFakeApi()
    applyAnalysisLayout(api)
    expect(added.map((p) => p.id).sort()).toEqual(
      [CHART_PANEL_ID, TRADE_LIST_PANEL_ID, DASHBOARD_PANEL_ID, PROP_RISK_PANEL_ID, EQUITY_PANEL_ID].sort(),
    )
    expect(panel(added, CHART_PANEL_ID)?.position).toBeUndefined()
  })

  it('places Trade List to the right of Chart', () => {
    const { api, added } = createFakeApi()
    applyAnalysisLayout(api)
    const tradeList = panel(added, TRADE_LIST_PANEL_ID)
    expect(tradeList?.position).toEqual({ direction: 'right', referencePanel: CHART_PANEL_ID })
    expect(tradeList?.initialWidth).toBe(420)
  })

  it('places Dashboard below Chart, capped with a maximumHeight so Chart stays the hero', () => {
    const { api, added } = createFakeApi()
    applyAnalysisLayout(api)
    const dashboard = panel(added, DASHBOARD_PANEL_ID)
    expect(dashboard?.position).toEqual({ direction: 'below', referencePanel: CHART_PANEL_ID })
    expect(dashboard?.initialHeight).toBe(260)
    expect(dashboard?.maximumHeight).toBe(340)
  })

  it('tabs Prop Risk and Equity within the Dashboard group', () => {
    const { api, added } = createFakeApi()
    applyAnalysisLayout(api)
    expect(panel(added, PROP_RISK_PANEL_ID)?.position).toEqual({
      direction: 'within',
      referencePanel: DASHBOARD_PANEL_ID,
    })
    expect(panel(added, EQUITY_PANEL_ID)?.position).toEqual({
      direction: 'within',
      referencePanel: DASHBOARD_PANEL_ID,
    })
  })

  it('activates the Chart panel', () => {
    const { api, activated } = createFakeApi()
    applyAnalysisLayout(api)
    expect(activated).toEqual([CHART_PANEL_ID])
  })
})

describe('applyChartFocusedLayout', () => {
  it('clears the layout and adds only Chart and Trade List', () => {
    const { api, cleared, added } = createFakeApi()
    applyChartFocusedLayout(api)
    expect(cleared.count).toBe(1)
    expect(added.map((p) => p.id).sort()).toEqual([CHART_PANEL_ID, TRADE_LIST_PANEL_ID].sort())
  })

  it('does not add Dashboard, Prop Risk, or Equity', () => {
    const { api, added } = createFakeApi()
    applyChartFocusedLayout(api)
    for (const id of [DASHBOARD_PANEL_ID, PROP_RISK_PANEL_ID, EQUITY_PANEL_ID]) {
      expect(panel(added, id)).toBeUndefined()
    }
  })

  it('places Trade List to the right of Chart with a narrower width than the Analysis preset', () => {
    const { api, added } = createFakeApi()
    applyChartFocusedLayout(api)
    const tradeList = panel(added, TRADE_LIST_PANEL_ID)
    expect(tradeList?.position).toEqual({ direction: 'right', referencePanel: CHART_PANEL_ID })
    expect(tradeList?.initialWidth).toBe(340)
  })

  it('activates the Chart panel', () => {
    const { api, activated } = createFakeApi()
    applyChartFocusedLayout(api)
    expect(activated).toEqual([CHART_PANEL_ID])
  })
})

describe('applyStatsLayout', () => {
  it('clears the layout before adding panels', () => {
    const { api, cleared } = createFakeApi()
    applyStatsLayout(api)
    expect(cleared.count).toBe(1)
  })

  it('gives Dashboard the standalone hero slot (no position) with Prop Risk to its right', () => {
    const { api, added } = createFakeApi()
    applyStatsLayout(api)
    expect(panel(added, DASHBOARD_PANEL_ID)?.position).toBeUndefined()
    expect(panel(added, PROP_RISK_PANEL_ID)?.position).toEqual({
      direction: 'right',
      referencePanel: DASHBOARD_PANEL_ID,
    })
  })

  it('tabs Equity within Prop Risk', () => {
    const { api, added } = createFakeApi()
    applyStatsLayout(api)
    expect(panel(added, EQUITY_PANEL_ID)?.position).toEqual({
      direction: 'within',
      referencePanel: PROP_RISK_PANEL_ID,
    })
  })

  it('demotes Chart to a smaller strip below Dashboard, with Trade List tabbed into it', () => {
    const { api, added } = createFakeApi()
    applyStatsLayout(api)
    const chart = panel(added, CHART_PANEL_ID)
    expect(chart?.position).toEqual({ direction: 'below', referencePanel: DASHBOARD_PANEL_ID })
    expect(chart?.initialHeight).toBe(280)
    expect(panel(added, TRADE_LIST_PANEL_ID)?.position).toEqual({
      direction: 'within',
      referencePanel: CHART_PANEL_ID,
    })
  })

  it('activates the Dashboard panel, not Chart', () => {
    const { api, activated } = createFakeApi()
    applyStatsLayout(api)
    expect(activated).toEqual([DASHBOARD_PANEL_ID])
  })
})

describe('PRESETS', () => {
  it('lists exactly the three presets, in Analysis / Chart-focused / Stats order', () => {
    expect(PRESETS.map((p) => p.name)).toEqual(['Analysis', 'Chart-focused', 'Stats'])
  })

  it('wires each preset name to its matching apply function', () => {
    expect(PRESETS.find((p) => p.name === 'Analysis')?.apply).toBe(applyAnalysisLayout)
    expect(PRESETS.find((p) => p.name === 'Chart-focused')?.apply).toBe(applyChartFocusedLayout)
    expect(PRESETS.find((p) => p.name === 'Stats')?.apply).toBe(applyStatsLayout)
  })
})
