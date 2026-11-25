import { createHash } from 'node:crypto'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, powerSaveBlocker, safeStorage, Tray } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { machineIdSync } from 'node-machine-id'
import { openShopDatabase } from '../db'
import { BackupService } from '../services/backup-service'
import { SQLiteShopRepository } from '../db/sqlite-shop-repository'
import { SQLiteUserRepository } from '../db/sqlite-user-repository'
import { AuthService } from '../services/auth-service'
import { ShopService } from '../services/shop-service'
import { TeamService } from '../services/team-service'
import { SetupService } from '../services/setup-service'
import { readBuildProfile, resolveResourcesPath } from './install-config-reader'
import { UserService } from '../services/user-service'
import { ProductInventoryService } from '../services/product-inventory-service'
import { PointOfSaleService } from '../services/point-of-sale-service'
import { ReturnService } from '../services/return-service'
import { AccountingReportService } from '../services/accounting-report-service'
import { ApprovalQueueService } from '../services/approval-queue-service'
import { MobileAccessService } from '../services/mobile-access-service'
import { RelayClient } from './relay-client'
import { createMobileAdminSurface } from '../api/mobile-admin-surface'
import { LicenseManager } from '../license/license-manager'
import { ElectronLicenseSecretStore } from '../license/secret-store'
import { DemoDataService } from '../services/demo-data-service'
import { DesktopHostController } from './desktop-host-controller'
import { registerDesktopIpc } from './ipc'
import { createWindowsFirewallProbe } from './mobile-firewall'
import { KeepRunningController } from './keep-running'
import { verifyPassword } from './password-verifier'
import { friendlyHostName } from '../shared/mobile/host-name'
import { readAppRole, resolveInstallerCurrency } from './install-config-reader'

const DEFAULT_APP_NAME = 'Infoflex'
app.setName(DEFAULT_APP_NAME)
app.setAppUserModelId('com.infoflex.pharmart')

let repository: SQLiteShopRepository | undefined
let hostController: DesktopHostController | undefined
let shopService: ShopService | undefined
let licenseManager: LicenseManager | undefined
let mobileAccessService: MobileAccessService | undefined
let backupService: BackupService | undefined
let approvalQueue: ApprovalQueueService | undefined
let demoDataService: DemoDataService | undefined
let databasePath = ''
let shutdownInProgress = false
let backupTimer: NodeJS.Timeout | undefined
let keepRunning: KeepRunningController | undefined
let tray: Tray | undefined
/** Set when the owner chooses Quit, so hiding to the tray never fights an explicit shutdown. */
let isQuitting = false
const setupProductName = DEFAULT_APP_NAME

/**
 * A restore replaces the database file under every open connection, so older service instances in this
 * process would be reading a deleted file. The app therefore restarts itself afterwards and every
 * service comes up against the restored data; the customer only pressed a button.
 */
function restartAfterRestore(): void {
  setTimeout(() => {
    app.relaunch()
    app.exit(0)
  }, 1500)
}

/** Called by the restore path: drop the dead connection and reopen the restored file once. */
function reopenShopRepository(): SQLiteShopRepository {
  repository?.close()
  repository = new SQLiteShopRepository(openShopDatabase(databasePath), false)
  return repository
}

async function chooseBackupFolder(): Promise<string | null> {
  const window = BrowserWindow.getAllWindows()[0]
  const result = await (window ? dialog.showOpenDialog(window, {
    title: 'Choose a folder for the backup',
    buttonLabel: 'Use this folder',
    properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
  }) : dialog.showOpenDialog({
    title: 'Choose a folder for the backup',
    buttonLabel: 'Use this folder',
    properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
  }))
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
}

/**
 * One automatic backup at start-up and then every six hours; the service itself makes at most one per
 * calendar day, so a shop that leaves the app open still gets a fresh copy each morning.
 */
function startAutomaticBackups(): void {
  const run = (): void => {
    try {
      backupService?.runAutomaticBackup()
    } catch (error) {
      console.error('Automatic backup failed:', error instanceof Error ? error.message : error)
    }
  }
  run()
  backupTimer = setInterval(run, 6 * 60 * 60 * 1000)
  backupTimer.unref?.()
}

function createMainWindow(productName: string): void {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 920,
    minHeight: 680,
    show: false,
    title: productName,
    icon: join(__dirname, '../renderer/branding/app-icon.png'),
    backgroundColor: '#f7f7f4',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault())

  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  const rendererFile = join(__dirname, '../renderer/index.html')
  const rendererOrigin = rendererUrl ? new URL(rendererUrl).origin : undefined
  const rendererFileUrl = pathToFileURL(rendererFile).href
  mainWindow.webContents.on('will-navigate', (event, destination) => {
    try {
      const allowed = rendererOrigin
        ? new URL(destination).origin === rendererOrigin
        : destination === rendererFileUrl
      if (!allowed) event.preventDefault()
    } catch {
      event.preventDefault()
    }
  })

  if (rendererUrl) void mainWindow.loadURL(rendererUrl)
  else void mainWindow.loadFile(rendererFile)
}

app.whenReady().then(async () => {
  databasePath = join(app.getPath('userData'), 'infoflex.sqlite')
  const database = openShopDatabase(databasePath)
  repository = new SQLiteShopRepository(database, false)
  // The installer's Region and Currency page wrote its answer to ProgramData; this is where the app picks it up
  // so the setup screen arrives with the customer's own currency already selected. An explicit environment
  // variable still wins, for vendor testing and for a support call that has to pin a currency.
  const programDataPath = process.env.ProgramData ?? process.env.PROGRAMDATA ?? null
  const installerChoice = resolveInstallerCurrency({
    environmentOverride: process.env.INFOFLEX_INSTALLER_CURRENCY ?? null,
    programData: programDataPath,
  })
  // Whether this installation is the Server or a Client. The installer wrote it into the same file as the currency,
  // and it decides two things the brief is explicit about: only the Server opens the database, and each login page
  // accepts only its own roles. Read once at startup, before the database or any window exists.
  const appRole = readAppRole({ programData: programDataPath })
  if (installerChoice.problem) console.warn(installerChoice.problem)
  if (installerChoice.code) {
    try {
      repository.setInstallerCurrencyCode(installerChoice.code, installerChoice.customCurrency)
    } catch {
      console.warn(`Ignoring unsupported installer currency preselecton "${installerChoice.code}".`)
    }
  }
  const userRepository = new SQLiteUserRepository(database)
  const auditContext = { deviceName: hostname(), ipAddress: null }
  shopService = new ShopService(repository, auditContext)
  licenseManager = new LicenseManager(database, {
    machineId: stableMachineId(),
    appVersion: app.getVersion(),
    platform: process.platform,
    secretStore: new ElectronLicenseSecretStore(join(app.getPath('userData'), 'license-authenticator.dpapi'), safeStorage),
    allowLocalMockTrust: !app.isPackaged,
  })
  // The vendor's build settings, embedded by Build Studio beside the packaged app. Absent for a `npm run` build
  // and for any build made before Build Studio existed, which must keep behaving exactly as it always has.
  const buildProfile = readBuildProfile({
    resourcesPath: resolveResourcesPath({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      projectRoot: app.getAppPath(),
    }),
  })
  if (buildProfile) {
    console.info(`Build profile: currency ${buildProfile.defaultCurrencyCode}${buildProfile.lockCurrency ? ' (locked)' : ''}, version ${buildProfile.appVersion}`)
  }
  // Seat administration for team size, and the bootstrap that lets first-run setup create the seats it promised.
  const teamService = new TeamService(database)
  const setupService = new SetupService(
    repository, userRepository, repository, licenseManager, undefined, undefined, buildProfile,
    {
      readCaps: () => {
        const caps = teamService.readCounts()
        const read = (role: 'ACCOUNT' | 'USER' | 'SUPERVISOR') => caps.find((entry) => entry.role === role)?.licenceCap ?? null
        return { account: read('ACCOUNT'), user: read('USER'), supervisor: read('SUPERVISOR') }
      },
      createSeats: (input, actor) => {
        // Seat counts are set first so the rows the seats live in exist, then the seats are created by the same
        // service the Users and Seats screen uses — one implementation of the cap and floor rules, not two.
        teamService.setSeatCount({ role: 'ACCOUNT', seats: input.account }, actor)
        teamService.setSeatCount({ role: 'USER', seats: input.user }, actor)
        teamService.setSeatCount({ role: 'SUPERVISOR', seats: input.supervisor }, actor)
      },
    },
  )
  const teamServiceRef = teamService
  const authService = new AuthService(userRepository, repository, auditContext, undefined, undefined, {
    app: appRole,
    // Read on every attempt rather than captured, so switching this on takes effect without restarting the app.
    allowAdminOnClients: () => teamServiceRef.getSnapshot().allowAdminOnClients,
  })
  const userService = new UserService(userRepository, repository)
  const inventoryService = new ProductInventoryService(database, repository, { deviceName: hostname() })
  const pointOfSaleService = new PointOfSaleService(database, repository, { workstation: hostname() })
  const returnService = new ReturnService(database, repository, { workstation: hostname() })
  const accountingReportService = new AccountingReportService(database, repository)
  approvalQueue = new ApprovalQueueService(database)
  // The optional demonstration catalogue. Its edition comes from the live licence, never from a setting, so a
  // Pharmacy shop can never load supermarket products.
  const licenceForDemo = licenseManager
  demoDataService = new DemoDataService(database, repository, userRepository, inventoryService, {
    edition: () => {
      const snapshot = licenceForDemo?.getSnapshot()
      return snapshot?.canUse ? snapshot.edition : null
    },
  })
  backupService = new BackupService(repository, {
    databasePath,
    automaticFolder: join(app.getPath('userData'), 'backups'),
    appVersion: app.getVersion(),
    productName: setupProductName,
    reopen: reopenShopRepository,
  })
  keepRunning = new KeepRunningController(app, powerSaveBlocker)
  // The phone's Admin surface is built from these very service objects, never from a second copy.
  const mobileAdminSurface = createMobileAdminSurface({
    database,
    shop: shopService,
    license: licenseManager,
    inventory: inventoryService,
    pointOfSale: pointOfSaleService,
    users: userService,
    reports: accountingReportService,
    approvals: approvalQueue,
    returns: returnService,
    countConnectedDevices: () => mobileAccessService?.connectedDeviceCount() ?? 0,
    // Read lazily: the mobile service is constructed *after* this surface, so the registry is not here yet.
    listPairedDevices: (adminUserId) => mobileAccessService?.listDevices(adminUserId) ?? [],
    revokePairedDevice: (adminUserId, deviceId) => mobileAccessService?.revokeDevice(adminUserId, deviceId),
  })
  mobileAccessService = new MobileAccessService(database, shopService, licenseManager, accountingReportService, returnService, {
    userDataPath: app.getPath('userData'),
    mobileClientDirectory: join(__dirname, '../mobile'),
    safeStorage,
    firewall: createWindowsFirewallProbe(),
    friendlyHostName: friendlyHostName(hostname()),
    verifyPassword: (password, hash) => verifyPassword(password, hash),
    phoneLimit: licenseManager.getSnapshot().features.mobileLan ? 1 : 0,
    adminSurface: mobileAdminSurface,
    // Where the relay is, from the licence server only: there is no field for a shop to mistype.
    relayUrl: () => licenseManager?.getRelayUrl() ?? null,
    /**
     * The shop's half of the internet relay. It dials out to the vendor and sends a phone's request only to this
     * computer's own listener, which is where the Admin-only rule, device approval and the authenticator live.
     */
    createRelayClient: ({ shopId, relayUrl }) => new RelayClient({
      relayUrl,
      shopId,
      machineId: stableMachineId(),
      appVersion: app.getVersion(),
      licenseToken: () => licenseManager?.getSignedToken() ?? null,
      // Fixed by this closure, never by a frame: the relay cannot make this computer call another address.
      localTarget: () => {
        const status = mobileAccessService?.relayTarget() ?? null
        return status ? { host: status.host, port: status.port, secure: status.secure, ...(status.ca ? { ca: status.ca } : {}) } : null
      },
      log: (message) => console.log(message),
    }),
  })
  // Every approval decision, and every device event, is pushed to the phone's live connection.
  approvalQueue.subscribe((event) => {
    mobileAccessService?.broadcast({
      type: event.type,
      payload: {
        id: event.request.id, kind: event.request.kind, label: event.request.label,
        status: event.request.status, requester: event.request.requester,
        amountMinor: event.request.amountMinor, currencyCode: event.request.currencyCode,
      },
    })
  })
  // Keep the machine awake only while a phone is actually connected, and release it straight away.
  mobileAccessService.onEvent((event) => {
    if (event.type === 'device.paired' || event.type === 'device.revoked') {
      void mobileAccessService?.statusForEvents?.()
    }
    const connected = mobileAccessService?.connectedDeviceCount() ?? 0
    if (event.type === 'device.paired' || event.type === 'device.revoked' || event.type === 'disconnected') {
      keepRunning?.holdSleep(event.type === 'device.revoked' ? 0 : connected)
    }
  })
  hostController = new DesktopHostController(
    repository,
    userRepository,
    setupService,
    authService,
    userService,
    shopService,
    Date.now,
    app.getVersion(),
    licenseManager,
    inventoryService,
    pointOfSaleService,
    returnService,
    accountingReportService,
    mobileAccessService,
    backupService,
    approvalQueue,
    demoDataService,
    teamService,
    appRole,
  )
  await hostController.initialize()
  licenseManager.startBackgroundCheckIns()
  startAutomaticBackups()
  const setupContext = await setupService.getSetupContext()
  app.setName(setupContext.productName)
  registerDesktopIpc(ipcMain, hostController, {
    chooseFolder: chooseBackupFolder,
    onRestored: restartAfterRestore,
    keepRunning,
  })
  installTray(setupContext.productName)
  keepRunning.apply({
    keepRunning: true,
    startWithWindows: true,
    preventSleep: true,
  })
  createMainWindow(setupContext.productName)



  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow(setupContext.productName)
  })
}).catch((error: unknown) => {
  console.error('Infoflex failed to start:', error)
  app.quit()
})

app.on('window-all-closed', () => {
  // With mobile access on, the host keeps serving the Admin's phone from the tray.
  const running = mobileAccessService?.isRunning() ?? false
  if (!isQuitting && keepRunning?.shouldHideToTray(running)) return
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  isQuitting = true
  if (shutdownInProgress) {
    event.preventDefault()
    return
  }
  if (backupTimer) clearInterval(backupTimer)
  keepRunning?.dispose()
  tray?.destroy()
  tray = undefined
  licenseManager?.stopBackgroundCheckIns()
  if (!mobileAccessService) {
    repository?.close()
    return
  }
  event.preventDefault()
  shutdownInProgress = true
  void mobileAccessService.close().catch((error: unknown) => {
    console.error('Infoflex mobile listener failed to close cleanly:', error)
  }).finally(() => {
    repository?.close()
    app.exit(0)
  })
})

/**
 * The tray icon keeps the host reachable when the main window is closed. It offers the three actions an
 * owner needs at that point — reopen, see the phone connection, or quit properly.
 */
function installTray(productName: string): void {
  const icon = nativeImage.createFromPath(join(__dirname, '../renderer/branding/app-icon.png'))
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 16, height: 16 }))
  tray.setToolTip(`${productName} — mobile access runs in the background`)
  const refreshMenu = (): void => {
    const running = mobileAccessService?.isRunning() ?? false
    const connected = mobileAccessService?.connectedDeviceCount() ?? 0
    const template: MenuItemConstructorOptions[] = [
      { label: running ? 'Mobile access: ON' : 'Mobile access: OFF', enabled: false },
      { label: connected === 0 ? 'No phone connected' : `${connected} phone${connected === 1 ? '' : 's'} connected`, enabled: false },
      { type: 'separator' },
      { label: 'Open Infoflex', click: () => {
        const window = BrowserWindow.getAllWindows()[0]
        if (window) { window.show(); window.focus() } else { createMainWindow(productName) }
      } },
      { label: 'Quit Infoflex', click: () => { isQuitting = true; app.quit() } },
    ]
    tray?.setContextMenu(Menu.buildFromTemplate(template))
  }
  refreshMenu()
  tray.on('click', () => {
    const window = BrowserWindow.getAllWindows()[0]
    if (window) { window.show(); window.focus() } else { createMainWindow(productName) }
  })
  // The phone count changes without any window open, so the tooltip and menu refresh on a light timer.
  const timer = setInterval(refreshMenu, 20_000)
  timer.unref?.()
  tray.on('closed' as never, () => { clearInterval(timer) })
}

function stableMachineId(): string {
  const operatingSystemId = machineIdSync()
  if (!operatingSystemId || typeof operatingSystemId !== 'string') throw new Error('A stable machine ID is unavailable.')
  return createHash('sha256').update(`com.infoflex.pharmart\0${operatingSystemId}`).digest('hex')
}
