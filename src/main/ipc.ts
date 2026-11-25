import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import type { AppPage, CreateUserInput, LoginInput, UpdateUserInput } from '../shared/auth/types'
import type { FirstRunInput, OperationalSettings, RestoreBackupInput, ShopProfile } from '../shared/shop/types'
import type { CurrencyDefinition } from '../currency/catalog'
import type { MoneyDisplayOptions } from '../currency/money'
import type { LicenseFeatures, OnsiteActivationInput, OnlineActivationInput } from '../shared/license/types'
import type { CompletePosSaleInput, HeldPosCartData, PosCustomerDraft, PosQuoteInput, ReceiptLayout } from '../shared/pos/types'
import type { RequestReturnInput, ReturnApprovalDecision, ReturnDocumentLayout } from '../shared/returns/types'
import type {
  CashDrawerEventInput,
  CloseCashierShiftInput,
  CloseDayInput,
  OpenCashierShiftInput,
  ReportExportInput,
  ReportPeriodInput,
} from '../shared/reports/types'
import type {
  ConsumeStockInput,
  ProductDraft,
  PurchaseOrderDraft,
  PurchaseOrderReceiptInput,
  ReceiveStockInput,
  StockAdjustmentInput,
  StocktakeInput,
} from '../shared/inventory/types'
import { DesktopHostController } from './desktop-host-controller'
import { authorize, ipcKey, resolveRole } from '../../packages/core/src/index'

export interface DesktopIpcOptions {
  /**
   * Native folder picker. Supplied by the main process because only it owns the application window;
   * the renderer never sees a filesystem path it chose itself.
   */
  chooseFolder?: () => Promise<string | null>
  /**
   * Called after a restore has replaced the database. Every other service in this process is holding a
   * connection to the replaced file, so the main process restarts the app instead of pretending they
   * can keep running.
   */
  onRestored?: () => void
  /** Tray / start-with-Windows / sleep behaviour, owned by the main process. */
  keepRunning?: {
    getSettings(): { keepRunning: boolean; startWithWindows: boolean; preventSleep: boolean }
    apply(settings: { keepRunning: boolean; startWithWindows: boolean; preventSleep: boolean }):
      { keepRunning: boolean; startWithWindows: boolean; preventSleep: boolean }
  }
}

export function registerDesktopIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  host: DesktopHostController,
  options: DesktopIpcOptions = {},
): void {
  /**
   * Every channel is registered through here, and every channel is checked against the one declarative permission
   * table in `/packages/core` before its handler runs.
   *
   * The order is deliberate:
   *
   * 1. **The frame check.** A nested frame must not reach a handler at all. This runs first because it costs
   *    nothing and refuses a whole class of message before any identity is resolved.
   * 2. **The policy check.** A channel with no entry in the table is refused — `authorize()` returns `no-policy` and
   *    the handler is never called. The coverage test fails the build over the same hole, but this is the check
   *    that protects an installation whose build somebody short-circuited.
   *
   * The role comes from the host's own session for this sender, not from anything the renderer sent. A renderer that
   * lies about its role changes nothing here, which is the whole point: roles are enforced on the server side of the
   * bridge, never only in the interface.
   */
  const handle = (channel: string, action: (event: IpcMainInvokeEvent, ...args: any[]) => unknown): void => {
    ipcMain.handle(channel, (event, ...args) => {
      if (event.senderFrame && event.senderFrame !== event.sender.mainFrame) {
        throw new Error('This action is only available to the main application window.')
      }
      const currentUser = host.getCurrentUser(event.sender.id)
      const outcome = authorize(ipcKey(channel), currentUser ? resolveRole(currentUser.role) : null, currentUser !== null)
      if (!outcome.allowed) {
        // A signed-out caller is told its session ended, because that is true and it is the only thing it can act
        // on. A signed-in caller whose role is wrong is told the same flat sentence for every channel, so it cannot
        // learn which role it would have to become to reach one. Collapsing the two into a single message was the
        // first thing this gate did wrong: the host already had a better sentence for an expired session, and
        // replacing it made every timeout look like a permissions problem.
        if (currentUser === null) throw new Error('Your session has expired. Sign in again.')
        throw new Error('This action is restricted to the Admin.')
      }
      return action(event, ...args)
    })
  }
  const sender = (event: IpcMainInvokeEvent) => event.sender.id

  handle('host:get-bootstrap', (event) => host.getBootstrap(sender(event)))
  handle('license:get-status', () => host.getLicenseStatus())
  handle('license:import-vendor-policy', (_event, contents) => host.importVendorPolicyFile(contents as string))
  handle('license:activate-online', (_event, input) => host.activateOnline(input as OnlineActivationInput))
  handle('license:import-file', (_event, contents) => host.importLicenseFile(contents as string))
  handle('license:activate-onsite', (_event, input) => host.activateOnsite(input as OnsiteActivationInput))
  handle('license:check-in-now', () => host.checkInLicense())
  handle('shop:get-settings', (event) => host.getShopSettings(sender(event)))
  handle('setup:complete-first-run', (_event, input) => host.completeFirstRun(input as FirstRunInput))
  handle('auth:login', (event, input) => host.login(sender(event), input as LoginInput))
  handle('auth:logout', (event) => host.logout(sender(event)))
  handle('auth:get-current-user', (event) => host.getCurrentUser(sender(event)))
  handle('auth:activity', (event) => host.touchSession(sender(event)))

  handle('shell:get-navigation', (event) => host.getNavigation(sender(event)))
  handle('shell:open-page', (event, page) => host.openPage(sender(event), page as AppPage))
  handle('pos:can-make-wholesale-sale', (event) => host.canMakeWholesaleSale(sender(event)))
  handle('mobile:assert-feature', (event, feature) => host.assertMobileFeature(sender(event), feature as keyof LicenseFeatures))
  handle('mobile:assert-admin-phone-capacity', (event) => host.assertAdminPhoneCapacity(sender(event)))
  handle('mobile:get-access-status', (event) => host.getMobileAccessStatus(sender(event)))
  handle('mobile:start-access', (event) => host.startMobileAccess(sender(event)))
  handle('mobile:stop-access', (event) => host.stopMobileAccess(sender(event)))
  handle('mobile:set-internet-access', (event, enabled) => host.setMobileInternetAccess(sender(event), enabled === true))
  handle('mobile:begin-pairing', (event) => host.beginMobilePairing(sender(event)))
  handle('mobile:list-devices', (event) => host.listMobileDevices(sender(event)))
  handle('mobile:revoke-device', (event, id) => host.revokeMobileDevice(sender(event), id as string))
  handle('mobile:get-trust-certificate', (event) => host.getMobileTrustCertificate(sender(event)))
  handle('mobile:acknowledge-certificate', (event) => host.acknowledgeMobileCertificateInstalled(sender(event)))
  handle('mobile:regenerate-certificate', (event) => host.regenerateMobileCertificate(sender(event)))
  handle('mobile:list-pending-approvals', (event) => host.listPendingMobileApprovals(sender(event)))
  handle('mobile:approve-device', (event, requestId) => host.approveMobileDevice(sender(event), requireText(requestId, 'Pairing request')))
  handle('mobile:reject-device', (event, requestId) => host.rejectMobileDevice(sender(event), requireText(requestId, 'Pairing request')))
  handle('mobile:rename-device', (event, deviceId, name) => host.renameMobileDevice(sender(event), requireText(deviceId, 'Paired device'), requireText(name, 'Phone name')))
  handle('mobile:revoke-all-devices', (event) => host.revokeAllMobileDevices(sender(event)))
  handle('mobile:turn-off-all', (event) => host.turnOffAllMobileAccess(sender(event)))
  handle('mobile:repair-firewall', (event) => host.repairMobileFirewall(sender(event)))
  handle('mobile:test-connection', (event) => host.testMobileConnection(sender(event)))
  handle('mobile:start-totp-enrollment', (event) => host.startMobileTotpEnrollment(sender(event)))
  handle('mobile:confirm-totp', (event, code) => host.confirmMobileTotp(sender(event), requireText(code, 'Authenticator code')))
  handle('mobile:get-totp-status', (event) => host.getMobileTotpStatus(sender(event)))
  handle('mobile:disable-totp', (event) => host.disableMobileTotp(sender(event)))
  handle('mobile:get-keep-running', () => {
    if (!options.keepRunning) throw new Error('Keep running is only available in the installed desktop app.')
    return options.keepRunning.getSettings()
  })
  handle('mobile:set-keep-running', (event, settings) => {
    sender(event)
    if (!options.keepRunning) throw new Error('Keep running is only available in the installed desktop app.')
    const value = settings as { keepRunning?: unknown; startWithWindows?: unknown; preventSleep?: unknown } | null
    if (!value || typeof value !== 'object') throw new Error('Choose the keep-running options again.')
    return options.keepRunning.apply({
      keepRunning: Boolean(value.keepRunning),
      startWithWindows: Boolean(value.startWithWindows),
      preventSleep: Boolean(value.preventSleep),
    })
  })

  handle('approvals:list-pending', (event) => host.listPendingApprovals(sender(event)))
  handle('approvals:list-recent', (event) => host.listRecentApprovals(sender(event)))
  handle('approvals:pending-count', (event) => host.pendingApprovalCount(sender(event)))
  handle('approvals:resolve', (event, requestId, decision) => {
    if (decision !== 'APPROVE' && decision !== 'REJECT') throw new Error('Choose approve or reject for this request.')
    return host.resolveApproval(sender(event), requireText(requestId, 'Approval request'), decision)
  })

  handle('users:list', (event) => host.listUsers(sender(event)))
  // Team size and seats. Admin-only in the policy table; the host re-checks with `requireAdmin`, so the row is not the
  // only guard.
  handle('team:get-snapshot', (event) => host.getTeamSnapshot(sender(event)))
  handle('team:set-seats', (event, change) => host.setSeatCount(sender(event), change as never))
  handle('team:rename-seat', (event, userId, fullName) => host.renameSeat(sender(event), userId as string, fullName as string))
  handle('team:set-seat-password', (event, userId, password, confirmPassword) => (
    host.setSeatPassword(sender(event), userId as string, password as string, confirmPassword as string)
  ))
  handle('team:update-settings', (event, input) => host.updateTeamSettings(sender(event), input as never))
  handle('team:get-role-summary', (event) => host.getRoleSummary(sender(event)))
  handle('users:create', (event, input) => host.createUser(sender(event), input as CreateUserInput))
  handle('users:update', (event, id, input) => host.updateUser(sender(event), id as string, input as UpdateUserInput))
  handle('users:deactivate', (event, id) => host.deactivateUser(sender(event), id as string))
  handle('users:reset-password', (event, id, password, confirmPassword) =>
    host.resetPassword(sender(event), id as string, password as string, confirmPassword as string))
  handle('users:unlock', (event, id) => host.unlockUser(sender(event), id as string))

  handle('inventory:get-overview', (event, search) => host.getInventoryOverview(sender(event), search as string | undefined))
  handle('inventory:save-product', (event, draft) => host.saveProduct(sender(event), draft as ProductDraft))
  handle('inventory:import-csv', (event, contents) => host.importProductsCsv(sender(event), contents as string))
  handle('inventory:import-excel', (event, contents) => host.importProductsExcel(sender(event), contents as Uint8Array))
  handle('inventory:export-csv', (event) => host.exportProductsCsv(sender(event)))
  handle('inventory:export-excel', (event) => host.exportProductsExcel(sender(event)))
  handle('inventory:receive-stock', (event, input) => host.receiveStock(sender(event), input as ReceiveStockInput))
  handle('inventory:adjust-stock', (event, input) => host.adjustStock(sender(event), input as StockAdjustmentInput))
  handle('inventory:stocktake', (event, input) => host.recordStocktake(sender(event), input as StocktakeInput))
  handle('inventory:stocktake-report', (event) => host.getStocktakeVarianceReport(sender(event)))
  handle('inventory:list-purchase-orders', (event) => host.listPurchaseOrders(sender(event)))
  handle('inventory:create-purchase-order', (event, draft) => host.createPurchaseOrder(sender(event), draft as PurchaseOrderDraft))
  handle('inventory:receive-purchase-order', (event, input) => host.receivePurchaseOrder(sender(event), input as PurchaseOrderReceiptInput))
  handle('inventory:sellable-batches', (event, productId) => host.getSellableBatches(sender(event), productId as string))
  handle('inventory:consume-fefo', (event, input) => host.consumeStockFEFO(sender(event), input as ConsumeStockInput))
  handle('inventory:weighed-price', (event, productId, weight) => host.getWeighedPrice(sender(event), productId as string, weight as string))

  handle('pos:list-customers', (event) => host.listPosCustomers(sender(event)))
  handle('pos:create-customer', (event, input) => host.createPosCustomer(sender(event), input as PosCustomerDraft))
  handle('pos:quote-sale', (event, input) => host.quotePosSale(sender(event), input as PosQuoteInput))
  handle('pos:complete-sale', (event, input) => host.completePosSale(sender(event), input as CompletePosSaleInput))
  handle('pos:list-sales', (event) => host.listRecentPosSales(sender(event)))
  handle('pos:get-receipt', (event, saleId) => host.getPosReceipt(sender(event), saleId as string | number))
  handle('pos:print-receipt', (event, saleId, layout) => host.recordPosReceiptPrint(sender(event), saleId as string | number, layout as ReceiptLayout))
  handle('pos:hold-cart', (event, data) => host.holdPosCart(sender(event), data as HeldPosCartData))
  handle('pos:list-held-carts', (event) => host.listHeldPosCarts(sender(event)))
  handle('pos:recall-held-cart', (event, id) => host.recallHeldPosCart(sender(event), id as string))
  handle('pos:discard-held-cart', (event, id) => host.discardHeldPosCart(sender(event), id as string))

  handle('returns:find-sale', (event, receiptNumber) => host.findSaleForReturn(sender(event), receiptNumber as string))
  handle('returns:create', (event, input) => host.createReturn(sender(event), input as RequestReturnInput))
  handle('returns:list', (event) => host.listReturns(sender(event)))
  handle('returns:get-document', (event, returnId) => host.getReturnDocument(sender(event), returnId as string | number))
  handle('returns:resolve-approval', (event, returnId, decision) => host.resolveReturnApproval(sender(event), returnId as string | number, decision as ReturnApprovalDecision))
  handle('returns:print-document', (event, returnId, layout) => host.recordReturnPrint(sender(event), returnId as string | number, layout as ReturnDocumentLayout))

  handle('reports:get-accounting', (event, input) => host.getAccountingReport(sender(event), input as ReportPeriodInput))
  handle('reports:export-csv', (event, input) => host.exportReportCsv(sender(event), input as ReportExportInput))
  handle('reports:export-excel', (event, input) => host.exportReportExcel(sender(event), input as ReportExportInput))
  handle('reports:export-pdf', (event, input) => host.exportReportPdf(sender(event), input as ReportExportInput))
  handle('reports:close-day', (event, input) => host.closeReportingDay(sender(event), input as CloseDayInput))
  handle('reports:open-cashier-shift', (event, input) => host.openCashierShift(sender(event), input as OpenCashierShiftInput))
  handle('reports:close-cashier-shift', (event, input) => host.closeCashierShift(sender(event), input as CloseCashierShiftInput))
  handle('reports:drawer-event', (event, input) => host.recordCashDrawerEvent(sender(event), input as CashDrawerEventInput))

  handle('settings:update-store-details', (event, profile) => host.updateStoreDetails(sender(event), profile as ShopProfile))
  handle('settings:update-display', (event, display) => host.updateDisplaySettings(sender(event), display as MoneyDisplayOptions))
  handle('settings:change-currency', (event, currency, confirmed) => host.changeCurrency(sender(event), currency as CurrencyDefinition, confirmed === true))
  handle('settings:update-idle-timeout', (event, minutes) => host.updateIdleTimeout(sender(event), minutes as number))
  handle('settings:update-return-window', (event, days) => host.updateReturnWindowDays(sender(event), days as number))
  handle('settings:update-operational', (event, input) => host.updateOperationalSettings(sender(event), input as OperationalSettings))

  handle('backup:get-status', (event) => host.getBackupStatus(sender(event)))
  handle('backup:create-manual', (event, folder) => host.createManualBackup(sender(event), folder as string))
  handle('backup:list-files', (event, folder) => host.listBackupFiles(sender(event), folder as string))
  handle('backup:restore', (event, input) => {
    const result = host.restoreBackup(sender(event), input as RestoreBackupInput)
    options.onRestored?.()
    return result
  })
  handle('backup:choose-folder', () => options.chooseFolder?.() ?? null)

  handle('demo:get-status', (event) => host.getDemoDataStatus(sender(event)))
  handle('demo:load', (event) => host.loadDemoData(sender(event)))
  handle('demo:remove', (event) => host.removeDemoData(sender(event)))
}

/** The renderer only ever sends short identifiers and names; anything else is rejected here, not in a service. */
function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Enter a ${label.toLowerCase()}.`)
  const clean = value.trim()
  if (clean.length > 200) throw new Error(`${label} is too long.`)
  return clean
}
