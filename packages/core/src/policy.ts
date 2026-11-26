/**
 * The one declarative table that says who may do what.
 *
 * There is deliberately no second list. The desktop IPC registration, the Fastify route registration and this
 * file meet at `describeSurface()`: the surface is *derived* from the code that registers handlers, and every
 * entry it finds must have a row here. A channel or route with no row is **refused**, not allowed, and a test
 * enumerates the surface and fails when a row is missing.
 *
 * Two properties matter more than the contents:
 *
 * 1. **Absence is denial.** The check is `policyFor(...) ?? deny()`. There is no path where an unknown name
 *    reaches a handler because somebody forgot to add it to a deny-list.
 * 2. **The table is the only source.** The server asks this module; it does not also consult a role string in
 *    each handler. A second opinion would drift, and the drift would be invisible.
 *
 * Roles are the four real roles from `roles.ts`. `CASHIER` never appears here because it is not a role — it is a
 * historical value in the database that `resolveRole()` maps to `USER` before any check runs.
 */
import type { Role } from './roles'
import { rolesWith, type Capability } from './capabilities'

/**
 * What kind of thing is being asked for.
 *
 * `action` is an operation with no transport of its own (a service call, a background task). `ipc` is a desktop
 * channel. `http` is a Fastify route. The kind is recorded so that a missing HTTP policy cannot be satisfied by
 * an IPC row that happens to share its name.
 */
export type SurfaceKind = 'action' | 'ipc' | 'http'

/**
 * `anonymous` means the caller need not be signed in at all, and is only used where the route genuinely must be
 * reachable before a session exists — a health probe, or the pairing status a phone polls while it waits for the
 * Admin to approve it. It is never a shortcut for "we did not want to think about the role": each such entry is
 * listed in `ANONYMOUS_JUSTIFICATIONS` with the reason, and the test refuses an anonymous entry without one.
 */
export type PolicyRoles = readonly Role[] | 'anonymous'

export interface PolicyEntry {
  /** Every role permitted. An empty list refuses everyone, which is a useful way to disable a route. */
  readonly roles: readonly Role[]
  /** Routes and channels reachable before sign-in. Only meaningful for `anonymous` entries. */
  readonly anonymous: boolean
  /** Why this entry permits what it permits, for the next reader. Required, not decorative. */
  readonly note: string
}

const ADMIN: readonly Role[] = ['ADMIN']
const ADMIN_SUPERVISOR: readonly Role[] = ['ADMIN', 'SUPERVISOR']
/**
 * The roles that may operate a till: take an order and a payment.
 *
 * Deriving this from capabilities rather than writing `['ADMIN','ACCOUNT','USER']` is the whole point of
 * `capabilities.ts`: the brief says a USER may *generate an order* but a USER may not *take payment*, so there is no
 * single "till" role set any more. `TILL` is retained only for the surfaces both may genuinely reach — reading stock,
 * building an order — and everything money-shaped now names its own capability.
 */
const TILL: readonly Role[] = rolesWith('build_order')
/** Read-only review surfaces: an audit-only supervisor may look, and the Admin may do more elsewhere. */
const REVIEW: readonly Role[] = rolesWith('view_audit')
const EVERYONE: readonly Role[] = ['ADMIN', 'SUPERVISOR', 'ACCOUNT', 'USER']

/** Roles holding a named capability. The single way a route says who may use it. */
const withCapability = (capability: Capability): readonly Role[] => rolesWith(capability)

function entry(roles: readonly Role[], note: string): PolicyEntry {
  return { roles, anonymous: false, note }
}

function anonymous(note: string): PolicyEntry {
  return { roles: [], anonymous: true, note }
}

/**
 * The policy. Keys are the literal channel or route path as the registering code writes it; for `http` entries the
 * key is `METHOD /path`.
 *
 * Grouped by area rather than sorted, because a reader looking for "can a supervisor close the day" should find
 * the answer next to the other reporting rows.
 */
export const POLICY = {
  // ── Desktop IPC: the window's own lifecycle and identity ────────────────────────────────────────────────
  'ipc:host:get-bootstrap': entry(EVERYONE, 'The window needs its bootstrap before it knows who is signed in; it returns no data the role gate protects.'),
  'ipc:auth:login': anonymous('Signing in is how a session begins; refusing it to an anonymous caller would refuse everybody.'),
  'ipc:auth:logout': entry(EVERYONE, 'Anyone signed in may end their own session.'),
  'ipc:auth:get-current-user': entry(EVERYONE, 'A caller may always ask who it is.'),
  'ipc:auth:activity': entry(EVERYONE, 'Keeps the caller\'s own session alive.'),
  'ipc:shell:get-navigation': entry(EVERYONE, 'Navigation is filtered per role by the host before it is returned.'),
  'ipc:shell:open-page': entry(EVERYONE, 'Page opening is authorised per page by the host; the channel itself is available to any signed-in caller.'),
  'ipc:shop:get-settings': entry(EVERYONE, 'Every screen needs the shop name and currency to render.'),
  'ipc:setup:complete-first-run': anonymous('First run happens before any account exists. The host refuses it once users are present.'),

  // ── Desktop IPC: licence. The server machine is the licensed machine. ───────────────────────────────────
  'ipc:license:get-status': entry(EVERYONE, 'Every screen needs to know whether the licence is usable.'),
  'ipc:license:import-vendor-policy': entry(ADMIN, 'Installing a vendor policy changes what the shop is entitled to.'),
  'ipc:license:activate-online': entry(ADMIN, 'Activation binds the licence to this server machine.'),
  'ipc:license:import-file': entry(ADMIN, 'Importing a licence file is an activation.'),
  'ipc:license:activate-onsite': entry(ADMIN, 'On-site activation is an activation.'),
  'ipc:license:check-in-now': entry(ADMIN, 'A check-in reports the machine to the vendor cloud.'),

  // ── Desktop IPC: users and permissions ──────────────────────────────────────────────────────────────────
  'ipc:users:list': entry(ADMIN_SUPERVISOR, 'An audit-only supervisor may see who exists; only the Admin may change it.'),
  'ipc:users:create': entry(ADMIN, 'Creating an account is an Admin act.'),
  'ipc:users:update': entry(ADMIN, 'Changing a role or permission is an Admin act.'),
  'ipc:users:deactivate': entry(ADMIN, 'Deactivating an account is an Admin act.'),
  'ipc:users:reset-password': entry(ADMIN, 'Resetting another person\'s password is an Admin act.'),
  'ipc:users:unlock': entry(ADMIN, 'Clearing a lockout is an Admin act.'),
  // Team size and seats. The brief: "only the Admin creates/edits users and passwords". Every row below is Admin-only
  // for that reason, including the ones that only read, because the seat table carries people's names and last-login
  // times and is not a supervisor's business.
  'ipc:team:get-snapshot': entry(ADMIN, 'The Users and Seats screen is an Admin screen.'),
  'ipc:team:set-seats': entry(ADMIN, 'Changing how many accounts a role may have is an Admin act.'),
  'ipc:team:rename-seat': entry(ADMIN, 'Naming a seat identifies a person.'),
  'ipc:team:set-seat-password': entry(ADMIN, 'Setting a password is the Admin\'s alone; there is no self sign-up.'),
  'ipc:team:update-settings': entry(ADMIN, 'The toggles on this screen change how everyone signs in.'),
  'ipc:team:get-role-summary': entry(ADMIN, 'The role summary is part of the Admin\'s own screen.'),
  'ipc:team:set-seat-active': entry(ADMIN, 'Deactivating an account is an Admin act, whichever screen asks.'),
  'ipc:team:set-seat-permissions': entry(ADMIN, 'A discount ceiling or credit limit is the Admin\'s to set.'),

  // ── Desktop IPC: approvals ──────────────────────────────────────────────────────────────────────────────
  'ipc:approvals:list-pending': entry(ADMIN_SUPERVISOR, 'A supervisor reviews pending requests.'),
  'ipc:approvals:list-recent': entry(ADMIN_SUPERVISOR, 'A supervisor reviews what was decided.'),
  'ipc:approvals:pending-count': entry(ADMIN_SUPERVISOR, 'A count of what awaits review.'),
  'ipc:approvals:resolve': entry(ADMIN, 'Resolving an approval authorises a money or stock movement, which a supervisor no longer holds.'),

  // ── Desktop IPC: inventory ──────────────────────────────────────────────────────────────────────────────
  'ipc:inventory:get-overview': entry(withCapability('view_stock'), 'Everyone who works the floor reads stock quantities; cost is withheld from every role but the Admin.'),
  'ipc:inventory:save-product': entry(ADMIN, 'Editing a product changes prices and pack sizes.'),
  'ipc:inventory:import-csv': entry(ADMIN, 'A bulk import can rewrite the catalogue.'),
  'ipc:inventory:import-excel': entry(ADMIN, 'A bulk import can rewrite the catalogue.'),
  'ipc:inventory:export-csv': entry(TILL, 'Exporting the catalogue reads data an operator may already see.'),
  'ipc:inventory:export-excel': entry(TILL, 'Exporting the catalogue reads data an operator may already see.'),
  'ipc:inventory:receive-stock': entry(ADMIN, 'Receiving records supplier costs.'),
  'ipc:inventory:adjust-stock': entry(ADMIN, 'An adjustment moves stock without a sale.'),
  'ipc:inventory:stocktake': entry(ADMIN, 'A stocktake overwrites counted quantities.'),
  'ipc:inventory:stocktake-report': entry(ADMIN, 'The variance report exposes cost and shrinkage.'),
  'ipc:inventory:list-purchase-orders': entry(ADMIN, 'Purchase orders carry supplier costs.'),
  'ipc:inventory:create-purchase-order': entry(ADMIN, 'Creating a purchase order commits the shop to buy.'),
  'ipc:inventory:receive-purchase-order': entry(ADMIN, 'Receiving a purchase order records supplier costs.'),
  'ipc:inventory:sellable-batches': entry(TILL, 'The till needs the sellable batches to quote a price.'),
  'ipc:inventory:consume-fefo': entry(ADMIN, 'Forcing a specific batch consumption overrides FEFO ordering.'),
  'ipc:inventory:weighed-price': entry(TILL, 'Pricing a weighed item is part of taking an order.'),

  // ── Desktop IPC: point of sale ──────────────────────────────────────────────────────────────────────────
  'ipc:pos:list-customers': entry(TILL, 'The till needs the customer list.'),
  'ipc:pos:create-customer': entry(TILL, 'A new customer is created at the counter.'),
  'ipc:pos:quote-sale': entry(withCapability('build_order'), 'Quoting computes prices and stores nothing; a USER needs it to build an order.'),
  // Only ACCOUNT (and Admin) may take payment and finalise. A USER builds an order; an ACCOUNT finalises it.
  'ipc:pos:complete-sale': entry(withCapability('take_payment'), 'Finalising takes money, which a USER may not do. This is the phase\'s sharpest rule.'),
  'ipc:pos:list-sales': entry(TILL, 'The till reviews the sales it made.'),
  'ipc:pos:get-receipt': entry(withCapability('take_payment').concat(['USER'] as const), 'An ACCOUNT re-reads what it printed; a USER reads back its own unpaid order slip. Scoped by the host.'),
  // "ACCOUNT ... the ONLY role (besides Admin) that can PRINT or REPRINT receipts, invoices and credit notes."
  'ipc:pos:print-receipt': entry(withCapability('print_documents'), 'Only ACCOUNT and Admin may print; every copy is recorded in print_log with a copy number.'),
  'ipc:pos:hold-cart': entry(TILL, 'Holding a cart is a till act.'),
  'ipc:pos:list-held-carts': entry(TILL, 'A held cart is visible to the till.'),
  'ipc:pos:recall-held-cart': entry(TILL, 'Recalling a held cart is a till act.'),
  'ipc:pos:discard-held-cart': entry(TILL, 'Discarding a held cart is a till act.'),
  'ipc:pos:can-make-wholesale-sale': entry(TILL, 'Answering whether the caller may sell wholesale. The per-user permission still applies.'),

  // ── Desktop IPC: the order-to-receipt workflow ────────────────────────────────────────────────────────────
  // A USER builds an order; an ACCOUNT finalizes it into a sale. Every row below is derived from the same capability
  // vocabulary as the rest of the table, so the roles here cannot drift from the roles in `capabilities.ts`.
  'ipc:orders:create': entry(withCapability('build_order'), 'A picker generates an order and stock is reserved. Taking payment is a different capability.'),
  'ipc:orders:list-queue': entry(withCapability('take_payment'), 'The queue is the Account\'s work list; a picker sees only their own orders.'),
  'ipc:orders:list-mine': entry(withCapability('see_own_orders'), 'A picker follows their own orders through PENDING, PAID and CANCELLED.'),
  'ipc:orders:get': entry(withCapability('build_order'), 'Reading one order. Ownership is scoped in the service, so a picker cannot read another picker\'s.'),
  'ipc:orders:adjust-line': entry(withCapability('take_payment'), 'Adjusting a quantity at the till is an Account act, and it is logged.'),
  'ipc:orders:cancel': entry(withCapability('build_order'), 'Either side may cancel an unpaid order, as the brief requires; the service scopes who.'),
  'ipc:orders:finalize': entry(withCapability('take_payment'), 'Finalizing deducts stock and takes money. This is the sharpest rule in the phase.'),
  'ipc:print:log': entry(REVIEW.concat(withCapability('print_documents')), 'A Supervisor audits reprints without being able to make one; an Account sees their own.'),

  // ── Desktop IPC: returns ───────────────────────────────────────────────────────────────────────────────
  'ipc:returns:find-sale': entry(TILL, 'A return starts by finding the sale.'),
  'ipc:returns:create': entry(withCapability('process_returns'), 'A USER may not process returns: "CANNOT ... process returns" is explicit in the brief.'),
  'ipc:returns:list': entry(TILL, 'The return list is the till\'s own work.'),
  'ipc:returns:get-document': entry(TILL, 'Reading a credit note the till issued.'),
  'ipc:returns:resolve-approval': entry(ADMIN, 'Approving a return authorises refunding money or restocking goods.'),
  'ipc:returns:print-document': entry(withCapability('print_documents'), 'A credit note is a money document; only ACCOUNT and Admin may print one.'),

  // ── Desktop IPC: reports and cash ──────────────────────────────────────────────────────────────────────
  // Deliberately not ADMIN-only, and this is the policy that most needed reading rather than guessing: the host
  // already opens the reports page to a till user and hands back a PERSONAL report with cost and profit columns
  // blanked out (`adminReports: null`, `cogsMinor: null`). Narrowing the table to Admin here would not add a rule;
  // it would remove a screen a cashier is entitled to and has been since Phase 6.
  // "USER ... CANNOT ... see reports." An ACCOUNT still gets its own personal figures — that is how a cashier
  // reconciles a shift — but a USER is not a till operator and has nothing to reconcile.
  // Realigned this phase: the brief gives a SUPERVISOR "Audit and Stock (view)" and no reports, and gives a USER no
  // reports at all. So the row is derived from `view_reports`, which is ADMIN and ACCOUNT, rather than from the audit
  // capability — the earlier row had granted the supervisor the whole shop's accounts, which contradicted its own menu.
  'ipc:reports:get-accounting': entry(withCapability('view_reports'), 'The Admin sees the whole shop; an ACCOUNT sees a personal report with costs withheld; a SUPERVISOR and a USER see no reports at all.'),
  // Same reasoning as the report itself: the export is scoped by the same host service, so refusing a till user
  // here would refuse the personal report they were just shown.
  'ipc:reports:export-csv': entry(withCapability('view_reports'), 'Exports whatever the same caller was just shown, scoped by the host. A SUPERVISOR and a USER have no report to export.'),
  'ipc:reports:export-excel': entry(REVIEW.concat(['ACCOUNT'] as const), 'Exports whatever the same caller was just shown, scoped by the host. A USER has no report to export.'),
  'ipc:reports:export-pdf': entry(REVIEW.concat(['ACCOUNT'] as const), 'Exports whatever the same caller was just shown, scoped by the host. A USER has no report to export.'),
  'ipc:reports:close-day': entry(withCapability('close_day'), 'Closing the day freezes the business date and the reconciliation; it is the Admin\'s act.'),
  'ipc:reports:open-cashier-shift': entry(withCapability('do_cash_count'), 'A till operator opens their own shift; a USER does not handle cash.'),
  'ipc:reports:close-cashier-shift': entry(withCapability('do_cash_count'), 'A till operator closes their own shift; the host additionally refuses another person\'s shift.'),
  'ipc:reports:drawer-event': entry(withCapability('do_cash_count'), 'Recording a drawer event belongs to the person whose shift it is.'),
  // Taking money off a customer's balance. Its own capability and not `take_payment`, because a picker who may
  // finalise a sale at the till still may not move somebody's debt: this changes what the customer owes, and what the
  // drawer is expected to hold, without a sale being involved at all.
  'ipc:reports:debtor-payment': entry(withCapability('record_debtor_payment'), 'Settling part of a customer balance moves money and the balance together; the service additionally refuses more than is owed.'),

  // ── Desktop IPC: the daily audit ────────────────────────────────────────────────────────────────────────
  // Reading the day back is not the same permission as reading the reports. `REVIEW` is derived from `view_audit`,
  // which is ADMIN and SUPERVISOR and no till operator: the audit is the control that says whether the money came in,
  // and a control the person being controlled can run is not a control. The brief's own wording is the reason a
  // SUPERVISOR sees this screen and not the accounting reports — "Audit and Stock (view)" with no reports.
  'ipc:audit:get-day': entry(REVIEW, 'One day, every till or one Account, recomputed from the ledger. No cost or profit, because the Supervisor is not owed the margin.'),
  'ipc:audit:day-statuses': entry(REVIEW, 'Which days are audited and by whom. The Admin reads it too, to see whether the Supervisor has looked.'),
  'ipc:audit:unaudited-days': entry(REVIEW, 'The list of days nobody has attested to yet; it is the reason this screen exists.'),
  'ipc:audit:summary': entry(REVIEW, 'The short version the phone asks for, and the desktop header. Same capability as the day itself: nothing here is more sensitive.'),
  // Writing. A note or a sign-off is an attestation by somebody with the authority to make one. Both rows are also
  // refused again inside the service, so this list is the first of two doors rather than the only one.
  'ipc:audit:sign-off': entry(withCapability('write_audit_note'), 'Signing a day off is the attestation itself, and it is immutable once written.'),
  'ipc:audit:note-finding': entry(withCapability('write_audit_note'), 'Noting a finding explains a verdict; only a Supervisor or the Admin may.'),
  'ipc:audit:raise-flag': entry(withCapability('write_audit_note'), 'Raising a manual flag is a Supervisor or Admin judgement.'),
  'ipc:audit:flag-note': entry(withCapability('write_audit_note'), 'Appending to a flag keeps the earlier words, and is the same authority as raising one.'),
  'ipc:audit:resolve-flag': entry(withCapability('write_audit_note'), 'Closing a flag says the matter is settled; it does not delete it.'),
  // An export, and never a print. There is no receipt in an audit: the one thing this screen must not be able to do is
  // hand somebody a document. Hence `export_audit` on the export and no `print_documents` anywhere in this section,
  // and the print gate refuses an audit document id whatever a caller claims about it.
  'ipc:audit:export-csv': entry(withCapability('export_audit'), 'Exported as a file for the day, containing exactly the rows the same caller was shown.'),

  // ── Desktop IPC: settings ──────────────────────────────────────────────────────────────────────────────
  'ipc:settings:update-store-details': entry(ADMIN, 'Shop identity appears on every receipt.'),
  'ipc:settings:update-display': entry(ADMIN, 'Display settings are shop-wide.'),
  'ipc:settings:change-currency': entry(ADMIN, 'Changing the currency is guarded by the lock rule and is shop-wide.'),
  'ipc:settings:update-idle-timeout': entry(ADMIN, 'A shop-wide security setting.'),
  'ipc:settings:update-return-window': entry(ADMIN, 'A shop-wide policy the returns logic reads.'),
  'ipc:settings:update-operational': entry(ADMIN, 'VAT, printer, discount ceiling and payment methods are shop-wide.'),

  // ── Desktop IPC: backup and demonstration data ─────────────────────────────────────────────────────────
  'ipc:backup:get-status': entry(ADMIN, 'Backup state names filesystem paths on the server.'),
  'ipc:backup:create-manual': entry(ADMIN, 'A backup writes a copy of the whole database.'),
  'ipc:backup:list-files': entry(ADMIN, 'Listing backups exposes server paths.'),
  'ipc:backup:restore': entry(ADMIN, 'A restore replaces every row in the database.'),
  'ipc:backup:choose-folder': entry(ADMIN, 'Choosing a folder only makes sense to the Admin doing a backup.'),
  'ipc:demo:get-status': entry(ADMIN, 'Whether demonstration data is loaded is an Admin concern.'),
  'ipc:demo:load': entry(ADMIN, 'Loading demonstration data writes stock and sales.'),
  'ipc:demo:remove': entry(ADMIN, 'Removing the demonstration data deletes rows the Admin loaded.'),

  // ── Desktop IPC: mobile / LAN host administration ──────────────────────────────────────────────────────
  'ipc:mobile:assert-feature': entry(EVERYONE, 'Asking whether a licensed feature exists returns a boolean and no data.'),
  'ipc:mobile:assert-admin-phone-capacity': entry(ADMIN, 'Only the Admin may add a phone.'),
  'ipc:mobile:get-access-status': entry(ADMIN, 'The LAN host is an Admin-managed facility.'),
  'ipc:mobile:start-access': entry(ADMIN, 'Starting the LAN listener opens a port.'),
  'ipc:mobile:stop-access': entry(ADMIN, 'Stopping the LAN listener closes it.'),
  'ipc:mobile:set-internet-access': entry(ADMIN, 'Internet access for phones is an Admin decision.'),
  'ipc:mobile:begin-pairing': entry(ADMIN, 'Beginning a pairing mints a device credential.'),
  'ipc:mobile:list-devices': entry(ADMIN, 'Seeing paired devices is an Admin act.'),
  'ipc:mobile:revoke-device': entry(ADMIN, 'Revoking a device cuts off a phone.'),
  'ipc:mobile:get-trust-certificate': entry(ADMIN, 'The certificate is shown to the Admin to compare a fingerprint.'),
  'ipc:mobile:acknowledge-certificate': entry(ADMIN, 'Confirming the certificate was installed on the phone.'),
  'ipc:mobile:regenerate-certificate': entry(ADMIN, 'Regenerating the certificate invalidates every trusted phone.'),
  'ipc:mobile:list-pending-approvals': entry(ADMIN, 'The Admin approves devices.'),
  'ipc:mobile:approve-device': entry(ADMIN, 'Approving a device grants it a session.'),
  'ipc:mobile:reject-device': entry(ADMIN, 'Rejecting a device denies it a session.'),
  'ipc:mobile:rename-device': entry(ADMIN, 'Naming a device is device administration.'),
  'ipc:mobile:revoke-all-devices': entry(ADMIN, 'Revoking every device cuts off every phone.'),
  'ipc:mobile:turn-off-all': entry(ADMIN, 'Turning off mobile access closes the facility.'),
  'ipc:mobile:repair-firewall': entry(ADMIN, 'Changing the firewall rule is a server-machine act.'),
  'ipc:mobile:test-connection': entry(ADMIN, 'Testing the LAN listener is device administration.'),
  'ipc:mobile:start-totp-enrollment': entry(ADMIN, 'The authenticator belongs to the Admin account.'),
  'ipc:mobile:confirm-totp': entry(ADMIN, 'Confirming enrolment completes two-factor setup for the Admin.'),
  'ipc:mobile:get-totp-status': entry(ADMIN, 'Whether two-factor is on is Admin information.'),
  'ipc:mobile:disable-totp': entry(ADMIN, 'Disabling two-factor weakens the Admin account and is an Admin act.'),
  'ipc:mobile:get-keep-running': entry(ADMIN, 'The server\'s run-on behaviour is an Admin setting.'),
  'ipc:mobile:set-keep-running': entry(ADMIN, 'The server\'s run-on behaviour is an Admin setting.'),

  // ── HTTP: the pre-session surface ──────────────────────────────────────────────────────────────────────
  'http:GET /api/v1/health': anonymous('A liveness probe. It reveals only that the server is running.'),
  'http:GET /api/v1/licence': entry(EVERYONE, 'The licence summary is what a client needs before it can offer a sign-in screen.'),
  'http:POST /api/v1/mobile/pair': anonymous('A phone that has no credential yet begins pairing here; the Admin approves it afterwards.'),
  'http:GET /api/v1/mobile/pair/status': anonymous('A phone polls its own pairing request by its request token; it learns only its own status.'),
  'http:POST /api/v1/mobile/session/login': anonymous('Sign-in is how a session begins.'),
  'http:POST /api/v1/mobile/session/refresh': anonymous('A refresh exchange carries its own rotating credential instead of an access token.'),

  // ── HTTP: sessions ─────────────────────────────────────────────────────────────────────────────────────
  'http:POST /api/v1/mobile/session/logout': entry(EVERYONE, 'Anyone with a session may end it.'),

  // ── HTTP: the Admin phone app ──────────────────────────────────────────────────────────────────────────
  'http:GET /api/v1/admin/settings': entry(ADMIN, 'The Admin phone reads shop settings.'),
  'http:GET /api/v1/admin/returns/pending': entry(ADMIN, 'The Admin phone reviews pending returns.'),
  'http:POST /api/v1/admin/returns/:returnId/approval': entry(ADMIN, 'Approving a return from the phone authorises money.'),
  'http:GET /api/v1/admin/reports/summary': entry(ADMIN, 'The Admin phone reads the accounting summary.'),
  'http:GET /api/v1/admin/reports/summary.pdf': entry(ADMIN, 'The Admin phone exports the summary.'),
  'http:GET /api/v1/admin/events': entry(ADMIN, 'The Admin phone streams server events.'),
  'http:GET /api/v1/mobile/admin/dashboard': entry(ADMIN, 'The Admin phone dashboard.'),
  'http:GET /api/v1/mobile/admin/products': entry(ADMIN, 'The Admin phone reads the catalogue.'),
  'http:GET /api/v1/mobile/admin/products/:productId': entry(ADMIN, 'The Admin phone reads one product.'),
  'http:POST /api/v1/mobile/admin/products/:productId': entry(ADMIN, 'The Admin phone edits a product.'),
  'http:POST /api/v1/mobile/admin/products': entry(ADMIN, 'The Admin phone creates a product.'),
  'http:POST /api/v1/mobile/admin/products/:productId/stock': entry(ADMIN, 'The Admin phone adjusts stock.'),
  'http:POST /api/v1/mobile/admin/products/:productId/receive': entry(ADMIN, 'The Admin phone receives stock.'),
  'http:GET /api/v1/mobile/admin/reports': entry(ADMIN, 'The Admin phone reads reports.'),
  'http:GET /api/v1/mobile/admin/reports.pdf': entry(ADMIN, 'The Admin phone exports reports.'),
  'http:GET /api/v1/mobile/admin/sales': entry(ADMIN, 'The Admin phone reads sales.'),
  'http:GET /api/v1/mobile/admin/sales/:saleId': entry(ADMIN, 'The Admin phone reads one sale.'),
  'http:GET /api/v1/mobile/admin/cashiers': entry(ADMIN, 'The Admin phone reads till permissions.'),
  'http:POST /api/v1/mobile/admin/cashiers/:userId/wholesale': entry(ADMIN, 'The Admin phone changes a wholesale permission.'),
  'http:GET /api/v1/mobile/admin/devices': entry(ADMIN, 'The Admin phone lists devices.'),
  'http:POST /api/v1/mobile/admin/devices/:deviceId/revoke': entry(ADMIN, 'The Admin phone revokes a device.'),
  'http:GET /api/v1/mobile/admin/approvals': entry(ADMIN, 'The Admin phone lists approvals.'),
  'http:POST /api/v1/mobile/admin/approvals/:requestId': entry(ADMIN, 'The Admin phone resolves an approval.'),

  // ── HTTP: the served phone app itself (static assets only) ─────────────────────────────────────────────
  'http:GET /': anonymous('The phone app shell is static HTML with no shop data in it.'),
  'http:GET /*': anonymous('Static assets and the client-side router\'s fallback; no shop data is served here.'),
} as const satisfies Record<string, PolicyEntry>

export type PolicyKey = keyof typeof POLICY

/**
 * Keys that are anonymous on purpose, with the reason they must be. The test asserts every anonymous entry appears
 * here, so an anonymous route cannot slip in without somebody writing down why.
 */
export const ANONYMOUS_JUSTIFICATIONS: Readonly<Record<string, string>> = {
  'ipc:auth:login': 'A session has to start somewhere.',
  'ipc:setup:complete-first-run': 'First run precedes the first account.',
  'http:GET /api/v1/health': 'A liveness probe carries no data.',
  'http:POST /api/v1/mobile/pair': 'Pairing precedes the credential.',
  'http:GET /api/v1/mobile/pair/status': 'A phone polls its own request.',
  'http:POST /api/v1/mobile/session/login': 'Sign-in precedes the session.',
  'http:POST /api/v1/mobile/session/refresh': 'A refresh exchange carries its own credential.',
  'http:GET /': 'The phone app shell is static.',
  'http:GET /*': 'Static assets and the client-side router fallback.',
}

export type PolicyOutcome =
  | { allowed: true; entry: PolicyEntry }
  | { allowed: false; reason: 'no-policy' | 'anonymous-only' | 'role-not-permitted' | 'unknown-role' }

/** Build the key a route registration maps to. One function, so a caller cannot invent a different spelling. */
export function httpKey(method: string, path: string): string {
  return `http:${method.toUpperCase()} ${path}`
}

export function ipcKey(channel: string): string {
  return `ipc:${channel}`
}

export function actionKey(action: string): string {
  return `action:${action}`
}

/**
 * Decide whether a caller with this role may use this key.
 *
 * The order is deliberate: find the entry, then test anonymity, then test the role. A caller with an unknown role
 * is refused before the table is consulted at all, because "unknown" must never be treated as "not listed, so
 * maybe fine".
 */
export function authorize(key: string, role: Role | null, signedIn: boolean): PolicyOutcome {
  if (!signedIn) {
    const entryForAnonymous = (POLICY as Record<string, PolicyEntry>)[key]
    if (!entryForAnonymous) return { allowed: false, reason: 'no-policy' }
    if (entryForAnonymous.anonymous) return { allowed: true, entry: entryForAnonymous }
    return { allowed: false, reason: 'anonymous-only' }
  }
  if (!role) return { allowed: false, reason: 'unknown-role' }
  const found = (POLICY as Record<string, PolicyEntry>)[key]
  if (!found) return { allowed: false, reason: 'no-policy' }
  if (found.anonymous) return { allowed: true, entry: found }
  if (!found.roles.includes(role)) return { allowed: false, reason: 'role-not-permitted' }
  return { allowed: true, entry: found }
}

/** True when a policy row exists for this key, whatever it permits. */
export function hasPolicy(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(POLICY, key)
}

/** Every key in the table, for the coverage test to compare against the registered surface. */
export function policyKeys(): string[] {
  return Object.keys(POLICY)
}
