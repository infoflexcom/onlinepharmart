import { beforeEach, describe, expect, it } from 'vitest'
import { getCurrency } from '../../src/currency/catalog'
import { defaultDisplayOptions } from '../../src/currency/money'
import type { MobileApprovals, MobileDashboard, MobileProductDetail, MobileSaleDetail, MobileShopHeader } from '../../src/shared/mobile/admin-types'
import {
  renderApprovals, renderDashboard, renderDevices, renderMore, renderNewProduct, renderProduct, renderSaleDetail,
  renderSales, renderStockLanding,
} from './admin-screens'
import { installTestDom, textOf } from './test-dom'

/**
 * These render the real screen builders against a small DOM, so what is asserted is the markup the phone
 * actually paints: the words on the buttons, the currency symbol used, and the promises the brief makes
 * (view-only sales, a reason for every adjustment, a skeleton instead of a blank screen while loading).
 */

const NGN = getCurrency('NGN')!
const UGX = getCurrency('UGX')!

function header(currency = NGN): MobileShopHeader {
  return {
    storeName: 'Harbor Health Pharmacy',
    storeAddress: '14 Marina Road',
    storePhone: '+234 800 111 2222',
    edition: 'BOTH',
    currency,
    display: defaultDisplayOptions(currency),
    generatedAt: '2026-11-17T09:00:00.000Z',
  }
}

const dashboard: MobileDashboard = {
  header: header(),
  today: { date: '2026-11-17', totalSalesMinor: '255000', netSalesMinor: '240000', transactions: 4 },
  month: { label: '2026-11', totalSalesMinor: '8120500', netSalesMinor: '7900000', transactions: 120 },
  counts: { lowStock: 3, nearExpiry: 2, expired: 1, pendingApprovals: 2, connectedDevices: 1 },
  salesByCashierToday: [
    { userId: 'u1', userName: 'Amaka Obi', username: 'amaka', transactions: 3, totalSalesMinor: '200000', netSalesMinor: '190000' },
  ],
  // A day nobody has attested to, one that has not even been counted, and a flag still open: the three states the tile
  // has to tell apart, because "nothing outstanding" and "no audit service here" are different facts.
  audit: {
    unauditedDays: [
      { businessDate: '2026-11-16', accountName: 'Whole store', transactions: 18, salesMinor: '412300', currencyCode: 'NGN', openFlags: 1, dayClosed: true },
      { businessDate: '2026-11-17', accountName: 'Amaka Obi', transactions: 4, salesMinor: '255000', currencyCode: 'NGN', openFlags: 0, dayClosed: false },
    ],
    openFlags: [
      { id: 'f1', businessDate: '2026-11-16', severity: 'SERIOUS', detail: 'The drawer was short by ₦840.00', raisedByName: 'Sam Supervisor', raisedAt: '2026-11-16T19:05:00.000Z' },
    ],
    auditedDays: 12,
  },
}

const product: MobileProductDetail = {
  product: {
    id: 'p1', sku: 'PARA-500', name: 'Paracetamol 500mg', brand: 'Emzor', barcode: '6001234567890',
    category: 'Analgesics', unit: 'pack', quantityMilli: '4000', reorderLevelMilli: '10000',
    retailPriceMinor: '25000', wholesalePriceMinor: '22000', costMinor: '12000',
    rowVersion: 3, stockVersion: 2, isActive: true, prescriptionRequired: false, expiryTracking: true,
  },
  batches: [
    { batchNumber: 'LOT-7781', expiryDate: '2029-03-31', quantityMilli: '4000', unitCostMinor: '12000' },
    { batchNumber: 'LOT-6001', expiryDate: '2026-01-15', quantityMilli: '0', unitCostMinor: '11000' },
  ],
  history: [
    { reference: 'ADJ-1A2B3C4D', movementType: 'ADJUSTMENT', quantityDeltaMilli: '4000', reason: 'Found a full carton', batchNumber: '', actor: 'admin', createdAt: '2026-11-16T10:00:00.000Z' },
  ],
}

const sale: MobileSaleDetail = {
  header: header(),
  id: 12,
  receiptNumber: 'INV-0000000012',
  saleType: 'WHOLESALE',
  createdAt: '2026-11-17T08:30:00.000Z',
  cashier: 'Amaka Obi',
  workstation: 'SHOP-PC',
  customer: { name: 'Bright Schools Ltd', phone: '+234 803 000 1111', address: '3 Adeola Street' },
  lines: [{ sku: 'PARA-500', description: 'Paracetamol 500mg', quantityMilli: '20000', unit: 'pack', unitPriceMinor: '22000', lineTotalMinor: '440000' }],
  subtotalMinor: '440000', discountMinor: '0', taxMinor: '0', totalMinor: '440000', paidMinor: '440000', creditMinor: '0',
  payments: [{ method: 'TRANSFER', amountMinor: '440000', reference: 'TRX-9' }],
  currency: NGN,
}

beforeEach(() => {
  installTestDom()
})

describe('the dashboard screen', () => {
  it('shows today, the month, the counts and sales by cashier in the shop currency', () => {
    const text = textOf(renderDashboard(dashboard, { onOpenStock: () => {}, onOpenApprovals: () => {}, onOpenReports: () => {}, onOpenSales: () => {}, onOpenDevices: () => {} }))
    expect(text).toContain('₦2,550.00')
    expect(text).toContain('₦81,205.00')
    expect(text).toContain('Low stock')
    expect(text).toContain('Waiting for approval')
    expect(text).toContain('Amaka Obi')
    expect(text).toContain('2') // pending approvals count
  })

  // --- the daily audit block. Three states, and the phone must not collapse any two of them. ---

  const handlers = {
    onOpenStock: () => {}, onOpenApprovals: () => {}, onOpenReports: () => {}, onOpenSales: () => {},
    onOpenDevices: () => {},
  }

  it('lists the days nobody has attested to, with what happened on them, in the shop currency', () => {
    const text = textOf(renderDashboard(dashboard, handlers))
    expect(text).toContain('Daily audit')
    expect(text).toContain('Days to audit')
    expect(text).toContain('2')
    expect(text).toContain('Whole store')
    expect(text).toContain('cash counted')
    // The second day has not been counted yet, and the phone says so rather than showing a figure that implies it has.
    expect(text).toContain('not counted yet')
    expect(text).toContain('1 open flag')
    expect(text).toContain('₦4,123.00')
    expect(text).toContain('₦2,550.00')
    expect(text).toContain('12') // days already audited
  })

  it('shows an open flag with its severity as a word, because the Admin has to repeat it to somebody else', () => {
    const text = textOf(renderDashboard(dashboard, handlers))
    expect(text).toContain('Flags still open')
    expect(text).toContain('Serious')
    expect(text).toContain('The drawer was short by ₦840.00')
    expect(text).toContain('Sam Supervisor')
  })

  it('says where a day actually gets signed off, instead of offering a verdict from a summary', () => {
    const text = textOf(renderDashboard(dashboard, handlers))
    expect(text).toContain('Signing a day off is done on the Server')
  })

  it('tells "every day audited" apart from "this Server has no audit service"', () => {
    const clean = textOf(renderDashboard({
      ...dashboard,
      audit: { unauditedDays: [], openFlags: [], auditedDays: 30 },
    }, handlers))
    expect(clean).toContain('Every day has been audited')
    expect(clean).not.toContain('no audit service')

    // Same row count, opposite meaning. A phone paired to a shop that has never been audited must not read as a shop
    // with nothing outstanding, so the absence is stated rather than inferred from an empty list.
    const absent = textOf(renderDashboard({ ...dashboard, audit: null }, handlers))
    expect(absent).toContain('This Server has no audit service')
    expect(absent).not.toContain('Every day has been audited')
    expect(absent).not.toContain('Days to audit')
  })

  it('says "No sales yet today" instead of showing an empty table with a header', () => {
    const quiet = { ...dashboard, salesByCashierToday: [] }
    const text = textOf(renderDashboard(quiet, { onOpenStock: () => {}, onOpenApprovals: () => {}, onOpenReports: () => {}, onOpenSales: () => {}, onOpenDevices: () => {} }))
    expect(text).toContain('No sales yet today')
  })

  it('uses a 0-decimal currency with no decimals when the shop uses one', () => {
    const uganda: MobileDashboard = {
      ...dashboard,
      header: header(UGX),
      today: { ...dashboard.today, totalSalesMinor: '255000' },
    }
    const text = textOf(renderDashboard(uganda, { onOpenStock: () => {}, onOpenApprovals: () => {}, onOpenReports: () => {}, onOpenSales: () => {}, onOpenDevices: () => {} }))
    expect(text).toContain('USh 255,000')
    expect(text).not.toContain('USh 255,000.00')
  })
})

describe('the stock screens', () => {
  it('shows a skeleton, not a blank page, before results arrive', () => {
    const node = renderStockLanding('', null, { search: () => {}, scan: () => {}, open: () => {}, back: () => {}, scanToAdd: () => {} })
    expect(node.querySelectorAll('.skeleton').length).toBeGreaterThan(0)
  })

  it('tells the Admin nothing matched, and offers the scanned term in the message', () => {
    const text = textOf(renderStockLanding('999', { header: header(), products: [], exactMatchProductId: null }, {
      search: () => {}, scan: () => {}, open: () => {}, back: () => {}, scanToAdd: () => {},
    }))
    expect(text).toContain('Nothing matched')
    expect(text).toContain('999')
  })

  it('shows stock, retail and wholesale prices, batches and history for a product', () => {
    const text = textOf(renderProduct(product, header(), {
      back: () => {}, savePrice: () => {}, adjust: () => {}, receive: () => {},
    }))
    expect(text).toContain('Paracetamol 500mg')
    expect(text).toContain('₦250.00')
    expect(text).toContain('LOT-7781')
    expect(text).toContain('Expires 2029-03-31')
    expect(text).toContain('Found a full carton')
    expect(text).toContain('Edit details and prices')
    expect(text).toContain('Adjust stock')
    expect(text).toContain('Receive stock from a supplier')
  })

  it('asks for the Admin password in the price form and requires a reason for stock', () => {
    const node = renderProduct(product, header(), { back: () => {}, savePrice: () => {}, adjust: () => {}, receive: () => {} })
    const password = node.querySelector<HTMLInputElement>('#edit-password')
    expect(password?.type).toBe('password')
    const reason = node.querySelector<HTMLSelectElement>('#adjust-reason')
    expect(reason).not.toBeNull()
    const options = [...(reason?.querySelectorAll('option') ?? [])].map((option) => option.textContent)
    expect(options).toContain('Damaged or broken')
    expect(options).toContain('Other')
  })

  it('prefills price boxes in the shop currency, with that currency’s own decimal places', () => {
    const naira = renderProduct(product, header(), { back: () => {}, savePrice: () => {}, adjust: () => {}, receive: () => {} })
    expect(naira.querySelector<HTMLInputElement>('#edit-retail')?.value).toBe('250')
    const text = textOf(naira)
    expect(text).toContain('Retail price (NGN)')

    // A 0-decimal shop must not offer a fraction it cannot charge, and a comma-decimal shop types a comma.
    const uganda = renderProduct(product, header(UGX), { back: () => {}, savePrice: () => {}, adjust: () => {}, receive: () => {} })
    expect(textOf(uganda)).toContain('Retail price (UGX)')
    // A 0-decimal shop never prefills a fraction the shop cannot charge.
    expect(uganda.querySelector<HTMLInputElement>('#edit-retail')?.value).not.toContain('.')

    // A comma-decimal shop types and reads a comma; whole amounts never gain trailing zeros.
    const euroProduct: MobileProductDetail = { ...product, product: { ...product.product, retailPriceMinor: '25050' } }
    const euro = renderProduct(euroProduct, header(getCurrency('EUR')!), { back: () => {}, savePrice: () => {}, adjust: () => {}, receive: () => {} })
    expect(euro.querySelector<HTMLInputElement>('#edit-retail')?.value).toBe('250,5')
  })

  it('refuses a price with more decimals than the shop currency allows, before anything is sent', () => {
    let submitted: Record<string, string> | null = null
    const node = renderProduct(product, header(UGX), {
      back: () => {}, adjust: () => {}, receive: () => {},
      savePrice: (form) => { submitted = form },
    })
    const retail = node.querySelector<HTMLInputElement>('#edit-retail')!
    retail.value = '2500.50'
    const password = node.querySelector<HTMLInputElement>('#edit-password')!
    password.value = 'correct-horse-battery'
    const save = [...node.querySelectorAll('button')].find((button) => button.textContent === 'Save changes')!
    save.click()
    expect(submitted).toBeNull()
    expect(textOf(node)).toContain('no decimal places')

    // A whole amount in the same 0-decimal shop goes through, with the password.
    retail.value = '2500'
    save.click()
    expect(submitted).not.toBeNull()
    expect(submitted!.retailPrice).toBe('2500')
  })

  it('starts the quantity field empty so a stale number can never be submitted by accident', () => {
    const node = renderProduct(product, header(), { back: () => {}, savePrice: () => {}, adjust: () => {}, receive: () => {} })
    expect(node.querySelector<HTMLInputElement>('#adjust-quantity')?.value).toBe('')
  })
})

describe('the sales screens', () => {
  it('labels a wholesale invoice and shows the amount with the shop currency', () => {
    const text = textOf(renderSales({
      header: header(),
      sales: [{
        id: 12, receiptNumber: 'INV-0000000012', saleType: 'WHOLESALE', createdAt: '2026-11-17T08:30:00.000Z',
        customerName: 'Bright Schools Ltd', cashier: 'Amaka Obi', totalMinor: '440000', currencyCode: 'NGN',
      }],
    }, '', { search: () => {}, open: () => {} }))
    expect(text).toContain('INV-0000000012')
    expect(text).toContain('Wholesale invoice')
    expect(text).toContain('₦4,400.00')
  })

  it('renders a sale as view-only: no way to edit, and a plain statement that it cannot be changed', () => {
    const text = textOf(renderSaleDetail(sale, { back: () => {}, sharePdf: () => {}, shareImage: () => {}, print: () => {} }))
    expect(text).toContain('INV-0000000012')
    expect(text).toContain('Bright Schools Ltd')
    expect(text).toContain('Paracetamol 500mg')
    expect(text).toContain('Share as PDF')
    expect(text).toContain('Share as image')
    expect(text).toContain('Print at the counter')
    expect(text).toContain('A completed sale can never be edited')
    expect(text).not.toMatch(/edit sale|delete sale|refund now/iu)
  })

  it('uses the sale own currency even when the shop header has changed', () => {
    // 440000 minor units in a 0-decimal currency is 440,000 — read with UGX's own symbol and spacing.
    const historical: MobileSaleDetail = { ...sale, currency: UGX, header: header(UGX), totalMinor: '440000' }
    const text = textOf(renderSaleDetail(historical, { back: () => {}, sharePdf: () => {}, shareImage: () => {}, print: () => {} }))
    expect(text).toContain('USh 440,000')
    expect(text).not.toContain('₦')
  })
})

describe('the approvals screen', () => {
  const approvals: MobileApprovals = {
    header: header(),
    pending: [{
      id: 'a1', kind: 'DISCOUNT', label: 'Discount above the shop limit', status: 'PENDING',
      requester: 'Amaka Obi', requestedBy: 'u1', resolvedBy: null, amountMinor: '150000', currencyCode: 'NGN',
      createdAt: '2026-11-17T09:10:00.000Z', resolvedAt: null, payload: {},
    }],
    recent: [{
      id: 'a0', kind: 'CREDIT', label: 'Sale on credit', status: 'APPROVED',
      requester: 'Amaka Obi', requestedBy: 'u1', resolvedBy: 'Tunde Bakare', amountMinor: '50000', currencyCode: 'NGN',
      createdAt: '2026-11-17T08:00:00.000Z', resolvedAt: '2026-11-17T08:05:00.000Z', payload: {},
    }],
    pendingCount: 1,
  }

  it('offers Approve and Reject for a waiting request, with the amount in the shop currency', () => {
    const text = textOf(renderApprovals(approvals, { decide: () => {} }))
    expect(text).toContain('Discount above the shop limit')
    expect(text).toContain('₦1,500.00')
    expect(text).toContain('Approve')
    expect(text).toContain('Reject')
    expect(text).toContain('Waiting')
  })

  it('says nothing is waiting rather than showing an empty list', () => {
    const text = textOf(renderApprovals({ ...approvals, pending: [], pendingCount: 0 }, { decide: () => {} }))
    expect(text).toContain('Nothing is waiting for approval')
  })

  it('shows decided requests without buttons, so they cannot be decided twice from the same screen', () => {
    const node = renderApprovals({ ...approvals, pending: [] }, { decide: () => {} })
    const text = textOf(node)
    expect(text).toContain('Recently decided')
    expect(text).toContain('Approved')
    // No action buttons at all on a decided row: the only way to decide is the pending list above.
    expect(node.querySelectorAll('.approval__actions')).toHaveLength(0)
  })
})

describe('the more screen', () => {
  it('lists cashiers with their wholesale state and asks for the password before flipping it', () => {
    const text = textOf(renderMore({
      cashiers: [{
        id: 'u1', fullName: 'Amaka Obi', username: 'amaka', role: 'CASHIER', isActive: true,
        allowWholesale: true, maxDiscountBasisPoints: 1000, allowCreditSales: false,
      }],
    }, { toggleWholesale: () => {}, reloadCashiers: () => {}, signOut: () => {}, openDevices: () => {} }))
    expect(text).toContain('Amaka Obi')
    expect(text).toContain('Wholesale on')
    expect(text).toContain('Turn wholesale off')
    expect(text).toContain('Discount limit 10%')
    expect(text).toContain('Install this app on your phone')
    // Installing is described for both platforms the brief names, and iPhone states Safari is required.
    expect(text).toContain('Add to Home screen')
    expect(text).toContain('iPhone (Safari)')
    expect(text).toContain('You must use Safari')
  })
})

describe('adding a product and managing phones', () => {
  it('scans for a product the shop has never stocked, and prices it in the shop currency', () => {
    const text = textOf(renderNewProduct(header(UGX), '6009876543210', {
      scan: () => {}, cancel: () => {}, save: () => {},
    }))
    expect(text).toContain('New product')
    expect(text).toContain('UGX')
    expect(text).toContain('Retail price')
    expect(text).toContain('Wholesale price')
    expect(text).toContain('Track expiry dates')
    expect(text).not.toContain('₦')
  })

  it('offers the add-product scan from the stock screen', () => {
    const text = textOf(renderStockLanding('', null, {
      search: () => {}, scan: () => {}, open: () => {}, back: () => {}, scanToAdd: () => {},
    }))
    expect(text).toContain('Add a new product')
    expect(text).toContain('Scan barcode')
  })

  it('lists a paired phone with a password-protected revoke, and never invites revoking by accident', () => {
    const text = textOf(renderDevices({
      header: header(),
      devices: [
        { id: 'dev-1', name: 'Ada\u2019s iPhone', platform: 'iPhone (Safari)', lastSeen: '2026-11-17T09:00:00.000Z', lastIp: '192.168.1.24', createdAt: '2026-11-01T08:00:00.000Z', connected: true },
        { id: 'dev-2', name: 'Counter tablet', platform: 'Android (Chrome)', lastSeen: null, lastIp: null, createdAt: '2026-10-02T08:00:00.000Z', connected: false },
      ],
    }, { back: () => {}, reload: () => {}, revoke: () => {} }))
    expect(text).toContain('Ada\u2019s iPhone')
    expect(text).toContain('Signed in now')
    expect(text).toContain('Signed out')
    expect(text).toContain('Your Admin password')
    expect(text.match(/Revoke this phone/gu)?.length).toBe(2)
  })

  it('shows a skeleton before the phone list arrives, and an empty state when there are none', () => {
    const loading = renderDevices(null, { back: () => {}, reload: () => {}, revoke: () => {} })
    expect(loading.querySelectorAll('.skeleton').length).toBeGreaterThan(0)
    const empty = textOf(renderDevices({ header: header(), devices: [] }, { back: () => {}, reload: () => {}, revoke: () => {} }))
    expect(empty).toContain('No phones paired')
  })
})
