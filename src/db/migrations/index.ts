import type Database from 'better-sqlite3'
import { migrateCore } from './001_core'
import { migrateEditionModules } from './002_edition_modules'
import { migrateLegacyShopSettings } from './004_legacy_import'
import { migrateIndexesAndGuards } from './003_indexes_and_guards'
import { migrateSyncMetadata } from './005_sync_metadata'
import { migrateAuthentication } from './006_authentication'
import { migrateLicenseSystem } from './007_license_system'
import { migrateProductInventory } from './008_product_inventory'
import { migratePointOfSale } from './009_point_of_sale'
import { migrateReturnsWorkflow } from './010_returns_workflow'
import { migrateAccountingReports } from './011_accounting_reports'
import { migrateMobileSessions } from './012_mobile_sessions'
import { migrateOperationalSettings } from './013_operational_settings'
import { migrateMobileLogin } from './014_mobile_login'
import { migrateDemoDataRemoval } from './015_demo_data_removal'
import { migrateClientServerFoundation, migrateClientServerAuditAndSales } from './016_client_server_foundation'
import { migrateSeatsAndPasswords } from './017_seats_and_passwords'

export interface Migration {
  version: number
  name: string
  up(database: Database.Database): void
  /**
   * Declares that this migration rebuilds a table and therefore needs foreign-key enforcement paused for its
   * duration. The runner pauses it *outside* the transaction, because the pragma is a no-op inside one.
   *
   * Only a migration that genuinely rebuilds a table may set this. Everything else runs with enforcement on.
   */
  setsForeignKeysOff?: boolean
}

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'core-tables-and-currency-catalog', up: migrateCore },
  { version: 2, name: 'pharmacy-and-supermarket-tables', up: migrateEditionModules },
  { version: 3, name: 'indexes-and-currency-guards', up: migrateIndexesAndGuards },
  { version: 4, name: 'legacy-shop-settings-import', up: migrateLegacyShopSettings },
  { version: 5, name: 'sync-state-and-operation-metadata', up: migrateSyncMetadata },
  { version: 6, name: 'authentication-and-first-run-fields', up: migrateAuthentication },
  { version: 7, name: 'host-owned-license-activation-and-history', up: migrateLicenseSystem },
  { version: 8, name: 'product-inventory-master-and-stock-workflows', up: migrateProductInventory },
  { version: 9, name: 'desktop-point-of-sale-and-receipt-snapshots', up: migratePointOfSale },
  { version: 10, name: 'desktop-returns-approvals-and-credit-notes', up: migrateReturnsWorkflow },
  { version: 11, name: 'accounting-reports-and-cash-settlement', up: migrateAccountingReports },
  { version: 12, name: 'mobile-device-session-expiry-and-refresh-rotation', up: migrateMobileSessions },
  { version: 13, name: 'operational-settings-and-backup-log', up: migrateOperationalSettings },
  { version: 14, name: 'mobile-two-factor-login-and-device-approval', up: migrateMobileLogin },
  { version: 15, name: 'removable-demonstration-stock-seed', up: migrateDemoDataRemoval },
  {
    version: 16,
    name: 'client-server-orders-devices-and-audit',
    // `users` is rebuilt to widen its role CHECK; devices, refresh_tokens and user_permissions all reference it.
    setsForeignKeysOff: true,
    up: (database) => {
      migrateClientServerFoundation(database)
      migrateClientServerAuditAndSales(database)
    },
  },
  {
    version: 17,
    name: 'team-seats-password-state-and-screen-settings',
    up: migrateSeatsAndPasswords,
  },
]
