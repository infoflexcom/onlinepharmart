// @vitest-environment jsdom
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InfoflexBridge } from '@shared/bridge'
import type { DemoDatasetState } from '@shared/demo/types'
import { DemoDataPanel } from './SettingsPanels'

/**
 * This is the first renderer test in the project that mounts a component into a real DOM (jsdom) rather than
 * rendering to a string, because the panel's whole job is interactive: load, confirm, remove. It exists to prove
 * the two promises that matter to an Admin — the demo is not their data, and removal asks first — in the markup
 * and behaviour a person actually meets.
 */

const EMPTY: DemoDatasetState = {
  loaded: false, products: 0, users: 0, demoUsers: [], inUse: false, inUseReason: null, currency: 'NGN',
}
const LOADED: DemoDatasetState = {
  loaded: true, products: 30, users: 2, currency: 'NGN', inUse: false, inUseReason: null,
  demoUsers: [
    { username: 'demo.cashier.on', fullName: 'Demo Cashier (wholesale on)', role: 'CASHIER' },
    { username: 'demo.cashier.off', fullName: 'Demo Cashier (wholesale off)', role: 'CASHIER' },
  ],
}
const IN_USE: DemoDatasetState = {
  ...LOADED, inUse: true,
  inUseReason: 'A sale already includes demonstration products. Remove the demonstration data only before real use, or keep it — completed sales cannot be deleted.',
}

let container: HTMLDivElement
const roots: Array<{ unmount: () => void }> = []

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  // Stop the "not implemented" noise jsdom prints for confirm, and make it answer predictably per test.
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

function bridge(state: DemoDatasetState, overrides: Partial<InfoflexBridge> = {}): InfoflexBridge {
  return {
    getDemoDataStatus: async () => state,
    loadDemoData: async () => ({ products: 30, users: 2, promotions: 2, currencyCode: 'NGN', samplePrice: '₦850.00' }),
    removeDemoData: async () => ({ products: 30, users: 2, promotions: 2 }),
    ...overrides,
  } as unknown as InfoflexBridge
}

async function mount(element: React.ReactElement): Promise<void> {
  const root = createRoot(container)
  roots.push(root)
  await act(async () => { root.render(element) })
}

const button = (label: RegExp): HTMLButtonElement | undefined =>
  [...container.querySelectorAll('button')].find((candidate) => label.test(candidate.textContent ?? '')) as HTMLButtonElement | undefined

describe('the demonstration data panel', () => {
  it('offers to load when nothing is loaded, and promises the currency stays unlocked', async () => {
    await mount(<DemoDataPanel bridge={bridge(EMPTY)} edition="PHARMACY" />)
    expect(container.textContent).toContain('No demonstration data is loaded')
    const load = button(/Load demonstration data/u)
    expect(load).toBeDefined()
    expect(button(/Remove demonstration data/u)).toBeUndefined()

    await act(async () => { load!.click() })
    // The confirmation is the point: nobody loads demo stock by accident.
    expect(window.confirm).toHaveBeenCalledTimes(1)
    expect(String((window.confirm as unknown as { mock: { calls: string[][] } }).mock.calls[0])).toMatch(/currency stays unlocked/u)
    expect(container.textContent).toContain('Loaded 30 products and 2 sample accounts')
    expect(container.textContent).toContain('₦850.00')
  })

  it('names every sample login and says which password they use', async () => {
    await mount(<DemoDataPanel bridge={bridge(LOADED)} edition="PHARMACY" />)
    expect(container.textContent).toContain('demo.cashier.on')
    expect(container.textContent).toContain('demo.cashier.off')
    expect(container.textContent).toContain('Demo-Pass!2026')
    expect(container.textContent).toContain('30 demonstration products')
  })

  it('disables removal and shows the reason when real work depends on the demo', async () => {
    await mount(<DemoDataPanel bridge={bridge(IN_USE)} edition="PHARMACY" />)
    const remove = button(/Remove demonstration data/u)
    expect(remove).toBeDefined()
    expect(remove!.disabled).toBe(true)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('completed sales cannot be deleted')
  })

  it('says so in plain words when the host refuses, instead of failing silently', async () => {
    await mount(<DemoDataPanel
      bridge={bridge(LOADED, { removeDemoData: async () => { throw new Error('Real stock movements exist for demonstration products.') } })}
      edition="PHARMACY"
    />)
    await act(async () => { button(/Remove demonstration data/u)!.click() })
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Real stock movements exist')
  })
})
