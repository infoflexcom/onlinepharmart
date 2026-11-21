import { createHash, createPublicKey, randomUUID, X509Certificate } from 'node:crypto'
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { dirname, join } from 'node:path'
import { generate as generateCertificate } from 'selfsigned'
import type Database from 'better-sqlite3'
import type { FastifyInstance } from 'fastify'
import { createHostApi, createMobileReportAdapter, createReturnApprovalAdapter, isLocalNetworkAddress } from '../api/server'
import type { LicenseManager } from '../license/license-manager'
import type { ReturnService } from './return-service'
import type { AccountingReportService } from './accounting-report-service'
import type { ShopService } from './shop-service'
import type { MobileAccessStatus, MobileConnectionTest, MobilePairingInfo, MobileSessionCredentials, PairedMobileDevice } from '../shared/mobile/types'
import type { MobileSafeStorage } from '../main/mobile-safe-storage'
import { MobileDeviceService } from './mobile-device-service'
import type { PendingApproval } from './mobile-device-service'
import { TotpService } from './totp-service'
import type { MobileLoginInput, MobileLoginResult, MobilePushEvent } from '../shared/mobile/types'
import { MOBILE_LOGIN_DENIED } from './mobile-login-policy'
import type { MobileAdminSurface } from '../api/mobile-admin-surface'
import { RelayClient, type RelayStatus } from '../main/relay-client'
import { shopSlug } from '../shared/relay/protocol'
import type { MobileInternetStatus } from '../shared/mobile/types'

const MOBILE_API_PORT = 43_871
const ROOT_LIFETIME_DAYS = 3_650
const SERVER_CERTIFICATE_LIFETIME_DAYS = 730
const LISTENER_HEALTHCHECK_MS = 15_000
const CERTIFICATE_FILE_NAME = 'mobile-api-identity.json'

interface PersistedIdentity {
  schema: 2
  caCertificate: string
  encryptedCaPrivateKey: string
  serverCertificate: string
  encryptedServerPrivateKey: string
  addresses: string[]
  fingerprint: string
  serverFingerprint: string
  createdAt: string
  caExpiresAt: string
  serverExpiresAt: string
  trustAcknowledged: boolean
}

export interface MobileAccessServiceOptions {
  userDataPath: string
  mobileClientDirectory: string
  safeStorage: MobileSafeStorage
  now?: () => number
  port?: number
  getAddresses?: () => string[]
  healthcheckIntervalMs?: number
  /** Friendly mDNS name this PC advertises, e.g. `infoflex-harbor-pharmacy`. */
  friendlyHostName?: string
  /** Windows Firewall inspection; injected so the service is testable away from Windows. */
  firewall?: MobileFirewallProbe
  /** How many Admin phones the licence allows, shown on Mobile Access. */
  phoneLimit?: number
  verifyPassword?: (password: string, hash: string) => Promise<boolean>
  /** Admin preference: ask for the authenticator code on the local network too. Internet always asks. */
  requireTotpOnLan?: boolean
  /**
   * The Admin phone's dashboard, stock, reports, sales, permissions and approvals surface. Built in
   * `main/index.ts` from the same service instances the desktop IPC uses, so both screens share one set of
   * rules; absent in unit tests that only exercise pairing and login.
   */
  adminSurface?: MobileAdminSurface
  audit?: (action: string, actor: string, metadata: Record<string, unknown>) => void
  /**
   * Builds the relay client when the Admin switches internet access on. Injected so the tests can drive a relay
   * over a plain socket, and so the service never depends on the real network in a unit test. The real
   * construction lives in `src/main/index.ts`, where the machine id and app version are known.
   */
  createRelayClient?: (input: { shopId: string; relayUrl: string }) => RelayClient | null
  /** Where the relay is, learned from the licence server's configuration. Null when the vendor runs no relay. */
  relayUrl?: () => string | null
}

/** Detects and repairs the inbound firewall rule for the host port. Implemented in src/main/mobile-firewall.ts. */
export interface MobileFirewallProbe {
  inspect(port: number): Promise<{ blocked: boolean; message: string | null }>
  repair(port: number): Promise<{ blocked: boolean; message: string | null }>
}

/** Starts an explicitly enabled LAN-only HTTPS host and keeps the private TLS key in OS-protected storage. */
export class MobileAccessService {
  private readonly devices: MobileDeviceService
  readonly totp: TotpService
  private readonly eventListeners = new Set<(event: MobilePushEvent) => void>()
  private firewallState: { blocked: boolean; message: string | null } = { blocked: false, message: null }
  private readonly phoneLimitValue: number
  private readonly now: () => number
  private readonly port: number
  private readonly getAddresses: () => string[]
  private readonly healthcheckIntervalMs: number
  private server: FastifyInstance | null = null
  private relay: RelayClient | null = null
  private relayStatus: RelayStatus | null = null
  private identity: PersistedIdentity | null = null
  private servingAddresses: string[] = []
  private listenPort: number | null = null
  private healthcheck: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly database: Database.Database,
    private readonly shop: ShopService,
    private readonly license: LicenseManager,
    private readonly reports: AccountingReportService,
    private readonly returns: ReturnService,
    private readonly options: MobileAccessServiceOptions,
  ) {
    this.now = options.now ?? Date.now
    this.port = options.port ?? MOBILE_API_PORT
    this.getAddresses = options.getAddresses ?? getPrivateIpv4Addresses
    this.healthcheckIntervalMs = options.healthcheckIntervalMs ?? LISTENER_HEALTHCHECK_MS
    this.devices = new MobileDeviceService(database, license, this.now)
    this.totp = new TotpService(database, options.safeStorage, this.now)
    this.phoneLimitValue = options.phoneLimit ?? 1
  }

  async start(adminUserId: string): Promise<MobileAccessStatus> {
    this.requireAdmin(adminUserId)
    this.assertLicensed()
    if (this.server) {
      const currentAddresses = this.normalizedAddresses()
      if (sameAddresses(currentAddresses, this.servingAddresses)) return this.status(adminUserId)
      await this.stopListener()
    }

    const addresses = this.normalizedAddresses()
    if (addresses.length === 0) throw new Error('No private IPv4 network address was found. Connect this computer and the Admin phone to the same local network.')
    try {
      await access(join(this.options.mobileClientDirectory, 'index.html'))
    } catch {
      throw new Error('The mobile web app has not been built. Reinstall or rebuild Infoflex before enabling mobile access.')
    }
    const identity = await this.ensureIdentity(addresses)
    this.identity = identity
    this.servingAddresses = [...addresses]

    const server = await createHostApi({
      service: this.shop,
      license: { getSnapshot: () => this.license.getSnapshot() },
      authenticate: async (request) => this.devices.authenticateBearer(request.headers.authorization, request.ip || null),
      returnApprovals: createReturnApprovalAdapter(this.returns),
      mobileReports: createMobileReportAdapter(this.reports, () => {
        const current = this.license.getSnapshot()
        return current.canUse ? current.edition : null
      }),
      mobileSessions: {
        startPairRequest: (input, metadata) => this.devices.startPairRequest(input, metadata.ipAddress),
        pairStatus: (requestToken) => this.devices.pairStatus(requestToken),
        login: (credentials, metadata) => this.login(credentials, metadata),
        refreshSession: (refreshToken, ipAddress) => this.devices.refreshSession(refreshToken, ipAddress),
        logout: (authorization) => this.devices.logoutBearer(authorization),
        isLocalNetwork: (address) => address === null || address === '' || isLocalNetworkAddress(address),
      },
      mobileEvents: { subscribe: (listener) => this.onEvent(listener) },
      ...(this.options.adminSurface ? { mobileAdmin: { service: this.options.adminSurface.service } } : {}),
      mobileClientDirectory: this.options.mobileClientDirectory,
      localNetworkOnly: true,
      // The relay dials this listener from loopback; the marker is that client's only claim, and it is honoured
      // from a loopback peer alone. Without this, a phone on mobile data would look like the shop's own Wi-Fi.
      allowRelayArrival: true,
      tls: { key: this.decrypt(identity.encryptedServerPrivateKey), cert: identity.serverCertificate, minVersion: 'TLSv1.2' },
      now: this.now,
    })
    try {
      await server.listen({ port: this.port, host: '0.0.0.0' })
      this.server = server
      const boundAddress = server.server.address()
      this.listenPort = boundAddress && typeof boundAddress !== 'string' ? boundAddress.port : this.port
      this.startHealthcheck()
    } catch (error) {
      await server.close().catch(() => undefined)
      this.server = null
      this.listenPort = null
      this.servingAddresses = []
      if (isAddressInUse(error)) throw new Error(`Mobile reports could not start because port ${this.port} is already in use. Close the other application and try again.`)
      throw new Error('Mobile reports could not start. Check the local network, certificate trust, and try again.')
    }
    // The relay rides on the listener that is now up: a phone with a relay link is answered by this very server.
    await this.startRelayIfEnabled(adminUserId)
    return this.status(adminUserId)
  }

  async stop(adminUserId: string): Promise<MobileAccessStatus> {
    this.requireAdmin(adminUserId)
    this.stopRelay()
    await this.stopListener()
    return this.status(adminUserId)
  }

  async status(adminUserId: string): Promise<MobileAccessStatus> {
    this.requireAdmin(adminUserId)
    let identity = this.identity
    let identityInvalid = false
    if (!identity) {
      try {
        identity = await this.readIdentity()
      } catch {
        identityInvalid = true
      }
    }
    if (identity) this.identity = identity
    const port = this.server ? this.listenPort : null
    const urls = this.server && port !== null
      ? this.servingAddresses.map((address) => `https://${address}:${port}/`)
      : []
    const friendlyName = this.options.friendlyHostName
    const friendlyUrls = this.server && port !== null && friendlyName
      ? [`https://${friendlyName}.local:${port}/`]
      : []
    return {
      running: this.server !== null,
      urls,
      friendlyUrls,
      port,
      certificateFingerprint: identity?.fingerprint ?? null,
      certificateNeedsInstall: identityInvalid || Boolean(identity && !identity.trustAcknowledged),
      pairedDeviceCount: this.devices.listForAdmin(adminUserId).length,
      connectedDeviceCount: this.devices.countConnected(adminUserId),
      phoneLimit: this.phoneLimitValue,
      firewallBlocked: this.firewallState.blocked,
      firewallMessage: this.firewallState.message,
      message: identityInvalid
        ? 'The saved mobile certificate is invalid. Regenerate it before enabling the listener.'
        : this.server ? 'Secure local-network mobile access is running.' : 'Mobile access is stopped.',
      internet: this.internetStatus(),
    }
  }

  beginPairing(adminUserId: string): MobilePairingInfo {
    this.requireAdmin(adminUserId)
    if (!this.server || this.listenPort === null || this.servingAddresses.length === 0) {
      throw new Error('Enable secure mobile reports before pairing an Admin phone.')
    }
    this.assertLicensed()
    const pending = this.devices.beginPairing(adminUserId)
    return {
      ...pending,
      pairingUrl: `https://${this.servingAddresses[0]}:${this.listenPort}/`,
      addresses: this.servingAddresses.map((address) => `${address}:${this.listenPort}`),
    }
  }

  listDevices(adminUserId: string): PairedMobileDevice[] {
    this.requireAdmin(adminUserId)
    return this.devices.listForAdmin(adminUserId)
  }

  revokeDevice(adminUserId: string, deviceId: string): PairedMobileDevice[] {
    this.requireAdmin(adminUserId)
    this.devices.revokeForAdmin(adminUserId, deviceId)
    return this.devices.listForAdmin(adminUserId)
  }

  revokeSessionsForUser(userId: string, actor: string): void {
    this.devices.revokeSessionsForUser(userId, actor)
  }

  /**
   * The phone's credential exchange. Admin-only by construction: `MobileDeviceService.login` refuses every
   * other role with the same message and no hint about which part failed.
   */
  async login(
    credentials: MobileLoginInput,
    metadata: { ipAddress: string | null; deviceToken: string; userAgent: string; deviceName: string; relayed?: boolean },
  ): Promise<MobileLoginResult> {
    // A relayed request arrives from loopback but is not on the shop's network: it must count as the internet,
    // so `mobileInternet` is required and the authenticator code cannot be skipped.
    const isLocalNetwork = metadata.relayed !== true
      && (metadata.ipAddress === null || metadata.ipAddress === '' || isLocalNetworkAddress(metadata.ipAddress))
    const snapshot = this.license.getSnapshot()
    if (!snapshot.canUse) throw new Error(MOBILE_LOGIN_DENIED)
    return this.devices.login({
      credentials,
      deviceToken: metadata.deviceToken,
      deviceName: metadata.deviceName || 'Admin phone',
      ipAddress: metadata.ipAddress,
      userAgent: metadata.userAgent,
      verifyPassword: this.options.verifyPassword ?? (async () => false),
      totp: { isEnrolled: (userId) => this.totp.isEnrolled(userId), verify: (userId, code) => this.totp.verify(userId, code) },
      requireTotpOnLan: this.options.requireTotpOnLan ?? false,
      isLocalNetwork,
      audit: (action, actor, detail) => this.auditMobile(action, actor, detail),
    })
  }

  listPendingApprovals(adminUserId: string): PendingApproval[] {
    this.requireAdmin(adminUserId)
    return this.devices.listPendingApprovals()
  }

  onApprovalNeeded(listener: (pending: PendingApproval[]) => void): () => void {
    return this.devices.onApprovalNeeded(listener)
  }

  approveDevice(adminUserId: string, requestId: string): PendingApproval[] {
    this.requireAdmin(adminUserId)
    const approved = this.devices.approveDevice(adminUserId, requestId)
    this.emitEvent({ type: 'device.paired', at: new Date(this.now()).toISOString(), payload: approved })
    return this.devices.listPendingApprovals()
  }

  rejectDevice(adminUserId: string, requestId: string): PendingApproval[] {
    this.requireAdmin(adminUserId)
    this.devices.rejectDevice(adminUserId, requestId)
    return this.devices.listPendingApprovals()
  }

  isRunning(): boolean {
    return this.server !== null
  }

  connectedDeviceCount(): number {
    return this.devices.countConnected()
  }

  /** Used by the tray to refresh its label after any device event; failures are not worth surfacing there. */
  async statusForEvents(): Promise<void> {
    await this.refreshFirewallState()
  }

  onEvent(listener: (event: MobilePushEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => { this.eventListeners.delete(listener) }
  }

  broadcast(event: Omit<MobilePushEvent, 'at'> & { at?: string }): void {
    this.emitEvent({ ...event, at: event.at ?? new Date(this.now()).toISOString() })
  }

  renameDevice(adminUserId: string, deviceId: string, name: string): PairedMobileDevice[] {
    this.requireAdmin(adminUserId)
    return this.devices.renameDevice(adminUserId, deviceId, name)
  }

  revokeAllDevices(adminUserId: string): PairedMobileDevice[] {
    this.requireAdmin(adminUserId)
    const revoked = this.devices.revokeAllForAdmin(adminUserId, 'Revoked all from Mobile Access')
    this.emitEvent({ type: 'device.revoked', at: new Date(this.now()).toISOString(), payload: { revoked } })
    return this.devices.listForAdmin(adminUserId)
  }

  /** "Turn off all mobile access": stop listening and revoke every phone in one Admin action. */
  async shutDownEverything(adminUserId: string): Promise<MobileAccessStatus> {
    this.requireAdmin(adminUserId)
    this.devices.revokeAllForAdmin(adminUserId, 'Mobile access switched off')
    await this.stopListener()
    this.emitEvent({ type: 'device.revoked', at: new Date(this.now()).toISOString(), payload: { all: true } })
    return this.status(adminUserId)
  }

  /**
   * "Test connection" answers the question a shop owner actually asks: can the phone reach me right now?
   * It checks the pieces in order and reports each one in plain words, so a failure points at one fix.
   */
  private currentUrls(): string[] {
    return this.server && this.listenPort !== null
      ? this.servingAddresses.map((address) => `https://${address}:${this.listenPort}/`)
      : []
  }

  async testConnection(adminUserId: string): Promise<MobileConnectionTest> {
    this.requireAdmin(adminUserId)
    const checkedAt = new Date(this.now()).toISOString()
    const steps: MobileConnectionTest['steps'] = []
    const snapshot = this.license.getSnapshot()
    steps.push({
      label: 'Licence allows mobile access',
      ok: Boolean(snapshot.canUse && snapshot.features.mobileLan),
      detail: snapshot.canUse && snapshot.features.mobileLan
        ? 'The shop licence includes local-network mobile access.'
        : 'The shop licence does not include mobile access, or it has expired.',
    })
    const identity = this.identity
    steps.push({
      label: 'Secure certificate is ready',
      ok: Boolean(identity),
      detail: identity
        ? `Certificate ${identity.fingerprint.slice(0, 23)}… is installed on this computer.`
        : 'No certificate yet. Press Regenerate certificate, then install the new one on the phone.',
    })
    steps.push({
      label: 'Host is switched on',
      ok: this.server !== null,
      detail: this.server ? `Listening on port ${this.listenPort}.` : 'Mobile access is switched off. Turn it on first.',
    })
    await this.refreshFirewallState()
    steps.push({
      label: 'Windows Firewall allows the port',
      ok: !this.firewallState.blocked,
      detail: this.firewallState.blocked ? (this.firewallState.message ?? 'Windows is blocking the mobile port.') : 'Windows allows the mobile port on private networks.',
    })
    steps.push({
      label: 'A phone has been approved',
      ok: this.devices.listForAdmin(adminUserId).length > 0,
      detail: this.devices.listForAdmin(adminUserId).length > 0
        ? `${this.devices.listForAdmin(adminUserId).length} approved phone(s).`
        : 'No phone approved yet. Press Pair a phone, then approve it here.',
    })
    return {
      ok: steps.every((step) => step.ok),
      checkedAt,
      port: this.listenPort,
      urls: this.currentUrls(),
      certificateFingerprint: identity?.fingerprint ?? null,
      firewallBlocked: this.firewallState.blocked,
      steps,
    }
  }

  async repairFirewall(adminUserId: string): Promise<MobileAccessStatus> {
    this.requireAdmin(adminUserId)
    if (!this.options.firewall) throw new Error('Firewall repair is only available in the installed Windows app.')
    this.firewallState = await this.options.firewall.repair(this.listenPort ?? this.port)
    return this.status(adminUserId)
  }

  async refreshFirewallState(): Promise<void> {
    if (!this.options.firewall || !this.server) return
    try {
      this.firewallState = await this.options.firewall.inspect(this.listenPort ?? this.port)
    } catch (error) {
      this.firewallState = { blocked: false, message: error instanceof Error ? error.message : null }
    }
  }

  private emitEvent(event: MobilePushEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event)
      } catch {
        // A failing UI listener must never break the host.
      }
    }
  }

  private auditMobile(action: string, actor: string, metadata: Record<string, unknown>): void {
    this.options.audit?.(action, actor, metadata)
  }

  refreshSession(refreshToken: string, ipAddress: string | null): MobileSessionCredentials | null {
    return this.devices.refreshSession(refreshToken, ipAddress)
  }

  logout(authorization: string | undefined): void {
    this.devices.logoutBearer(authorization)
  }

  async exportCertificate(adminUserId: string): Promise<string> {
    this.requireAdmin(adminUserId)
    if (!this.server) throw new Error('Enable secure mobile reports before exporting their trust certificate.')
    const identity = this.identity ?? await this.readIdentity()
    if (!identity) throw new Error('The mobile trust certificate is unavailable. Regenerate it from Mobile Access settings.')
    this.identity = identity
    return identity.caCertificate
  }

  async acknowledgeCertificateInstalled(adminUserId: string): Promise<MobileAccessStatus> {
    this.requireAdmin(adminUserId)
    if (!this.server) throw new Error('Enable secure mobile reports before confirming certificate installation.')
    const identity = this.identity ?? await this.readIdentity()
    if (!identity) throw new Error('The mobile trust certificate is unavailable. Regenerate it from Mobile Access settings.')
    identity.trustAcknowledged = true
    await this.persistIdentity(identity)
    this.identity = identity
    return this.status(adminUserId)
  }

  async regenerateCertificate(adminUserId: string): Promise<MobileAccessStatus> {
    this.requireAdmin(adminUserId)
    await this.stopListener()
    const addresses = this.normalizedAddresses()
    if (addresses.length === 0) throw new Error('No private IPv4 network address was found. Connect this computer to the local network and try again.')
    const identity = await this.createIdentity(addresses)
    await this.persistIdentity(identity)
    this.identity = identity
    return this.status(adminUserId)
  }

  async close(): Promise<void> {
    await this.stopListener()
  }

  private requireAdmin(adminUserId: string): void {
    if (typeof adminUserId !== 'string' || !adminUserId.trim()) throw new Error('A signed-in Admin account is required for mobile access.')
    const row = this.devicesUser(adminUserId)
    if (!row || row.role !== 'ADMIN' || row.is_active !== 1 || row.locked_at !== null) {
      throw new Error('A current, unlocked Admin account is required for mobile access.')
    }
  }

  private devicesUser(adminUserId: string): { role: string; is_active: number; locked_at: string | null } | undefined {
    // Query is kept on the same SQLite-backed license/host connection through the mobile device service.
    return this.devices.readAdminStatus(adminUserId)
  }

  private assertLicensed(): void {
    const snapshot = this.license.getSnapshot()
    if (!snapshot.canUse) throw new Error('Activate a valid Infoflex license before enabling mobile reports.')
    if (!snapshot.features.mobileLan) throw new Error('This license does not include local-network mobile access.')
    this.license.assertFeature('mobileLan')
  }

  private normalizedAddresses(): string[] {
    return [...new Set(this.getAddresses().filter(isPrivateIpv4))].sort()
  }

  private async ensureIdentity(addresses: string[]): Promise<PersistedIdentity> {
    const previous = this.identity ?? await this.readIdentity()
    if (previous && Date.parse(previous.caExpiresAt) > this.now()) {
      const leafStillCoversAddresses = addresses.every((address) => previous.addresses.includes(address))
      if (leafStillCoversAddresses && Date.parse(previous.serverExpiresAt) > this.now()) return previous
      const renewed = await this.createServerCertificate(previous, addresses)
      await this.persistIdentity(renewed)
      return renewed
    }
    const created = await this.createIdentity(addresses)
    await this.persistIdentity(created)
    return created
  }

  private async createIdentity(addresses: string[]): Promise<PersistedIdentity> {
    this.assertSafeStorage()
    const now = this.now()
    const caExpiresAt = new Date(now + ROOT_LIFETIME_DAYS * 86_400_000)
    const caPems = await generateCertificate([{ name: 'commonName', value: 'Infoflex Mobile Access Root' }], {
      keyType: 'rsa',
      keySize: 2048,
      algorithm: 'sha256',
      notBeforeDate: new Date(now - 5 * 60_000),
      notAfterDate: caExpiresAt,
      extensions: [
        { name: 'basicConstraints', cA: true, pathLenConstraint: 0, critical: true },
        { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
      ],
    })
    const identity: PersistedIdentity = {
      schema: 2,
      caCertificate: caPems.cert,
      encryptedCaPrivateKey: this.encrypt(caPems.private),
      serverCertificate: '',
      encryptedServerPrivateKey: '',
      addresses: [],
      fingerprint: fingerprintOf(caPems.cert),
      serverFingerprint: '',
      createdAt: new Date(now).toISOString(),
      caExpiresAt: caExpiresAt.toISOString(),
      serverExpiresAt: '',
      trustAcknowledged: false,
    }
    return this.createServerCertificate(identity, addresses)
  }

  private async createServerCertificate(identity: PersistedIdentity, addresses: string[]): Promise<PersistedIdentity> {
    this.assertSafeStorage()
    const now = this.now()
    const serverExpiresAt = new Date(now + SERVER_CERTIFICATE_LIFETIME_DAYS * 86_400_000)
    const caPrivateKey = this.decrypt(identity.encryptedCaPrivateKey)
    const pems = await generateCertificate([{ name: 'commonName', value: 'Infoflex Mobile Reports' }], {
      keyType: 'rsa',
      keySize: 2048,
      algorithm: 'sha256',
      notBeforeDate: new Date(now - 5 * 60_000),
      notAfterDate: serverExpiresAt,
      ca: { key: caPrivateKey, cert: identity.caCertificate },
      extensions: [
        { name: 'basicConstraints', cA: false, critical: true },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
        { name: 'extKeyUsage', serverAuth: true, critical: true },
        { name: 'subjectAltName', altNames: [
          { type: 2, value: 'localhost' },
          { type: 7, ip: '127.0.0.1' },
          ...addresses.map((ip) => ({ type: 7 as const, ip })),
        ] },
      ],
    })
    return {
      ...identity,
      serverCertificate: pems.cert,
      encryptedServerPrivateKey: this.encrypt(pems.private),
      addresses: [...addresses],
      serverFingerprint: fingerprintOf(pems.cert),
      serverExpiresAt: serverExpiresAt.toISOString(),
    }
  }

  private async readIdentity(): Promise<PersistedIdentity | null> {
    const path = join(this.options.userDataPath, CERTIFICATE_FILE_NAME)
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
    } catch (error) {
      if (isFileNotFound(error)) return null
      throw new Error('The saved mobile TLS identity could not be read. Regenerate the trust certificate from Mobile Access settings.')
    }
    if (!isIdentity(parsed)) return null
    try {
      this.assertSafeStorage()
      const ca = new X509Certificate(parsed.caCertificate)
      const server = new X509Certificate(parsed.serverCertificate)
      const caPrivateKey = this.decrypt(parsed.encryptedCaPrivateKey)
      const serverPrivateKey = this.decrypt(parsed.encryptedServerPrivateKey)
      if (!ca.ca || server.ca || !ca.verify(ca.publicKey) || !server.verify(ca.publicKey)
        || fingerprintOf(parsed.caCertificate) !== parsed.fingerprint
        || fingerprintOf(parsed.serverCertificate) !== parsed.serverFingerprint
        || !matchesPublicKey(ca.publicKey, caPrivateKey)
        || !matchesPublicKey(server.publicKey, serverPrivateKey)
        || !parsed.addresses.every((address) => Boolean(server.checkIP(address)))) {
        throw new Error('certificate validation failed')
      }
      if (Date.parse(ca.validTo) <= this.now()) return null
      return {
        ...parsed,
        caExpiresAt: new Date(ca.validTo).toISOString(),
        serverExpiresAt: new Date(server.validTo).toISOString(),
      }
    } catch {
      throw new Error('The saved mobile TLS identity is invalid or cannot be opened. Regenerate the trust certificate from Mobile Access settings.')
    }
  }

  private assertSafeStorage(): void {
    const backend = this.options.safeStorage.getSelectedStorageBackend?.()
    if (!this.options.safeStorage.isEncryptionAvailable() || backend === 'basic_text') {
      throw new Error('Secure operating-system storage is unavailable. Mobile reports cannot store a private TLS key safely.')
    }
  }

  private encrypt(value: string): string {
    return this.options.safeStorage.encryptString(value).toString('base64')
  }

  private decrypt(value: string): string {
    this.assertSafeStorage()
    try {
      return this.options.safeStorage.decryptString(Buffer.from(value, 'base64'))
    } catch {
      throw new Error('The secure mobile certificate key could not be opened.')
    }
  }

  private async persistIdentity(identity: PersistedIdentity): Promise<void> {
    const path = join(this.options.userDataPath, CERTIFICATE_FILE_NAME)
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(identity), { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, path)
  }

  private startHealthcheck(): void {
    this.stopHealthcheck()
    this.healthcheck = setInterval(() => {
      try {
        const snapshot = this.license.getSnapshot()
        if (!snapshot.canUse || !snapshot.features.mobileLan) {
          void this.stopListener()
          return
        }
        if (!sameAddresses(this.normalizedAddresses(), this.servingAddresses)) {
          void this.stopListener()
          return
        }
        this.devices.expireExpiredSessions()
      } catch {
        void this.stopListener()
      }
    }, this.healthcheckIntervalMs)
    this.healthcheck.unref?.()
  }

  private stopHealthcheck(): void {
    if (this.healthcheck) clearInterval(this.healthcheck)
    this.healthcheck = null
  }

  // ---------------------------------------------------------------- internet relay

  /**
   * The Admin's own switch for internet access. Licence-gated like everything else: it refuses when the licence
   * carries no `mobileInternet` entitlement, and the entitlement is signed by the vendor, so no screen here can
   * grant it.
   *
   * It is meaningful only with the local listener running, because every relayed request is answered by that
   * listener — which still enforces Admin-only, device approval and the authenticator code.
   */
  async setInternetAccess(adminUserId: string, enabled: boolean): Promise<MobileAccessStatus> {
    this.requireAdmin(adminUserId)
    const snapshot = this.license.getSnapshot()
    if (enabled) {
      if (!snapshot.canUse) throw new Error('A valid Infoflex licence is required for mobile access over the internet.')
      if (!snapshot.features.mobileInternet) {
        throw new Error('This shop licence does not include mobile access over the internet. Ask the vendor to add it.')
      }
      if (!this.server) throw new Error('Switch on local mobile access first: internet access is delivered through it.')
      if (!this.options.relayUrl?.()) {
        throw new Error('No Infoflex relay is configured for this licence. Check the internet connection, then try again.')
      }
    }
    this.database.prepare('UPDATE settings SET mobile_internet_enabled = ? WHERE id = 1').run(enabled ? 1 : 0)
    if (enabled) await this.startRelay(adminUserId)
    else this.stopRelay()
    this.auditMobile(enabled ? 'mobile.internet.enabled' : 'mobile.internet.disabled', adminUserId, {})
    this.emitEvent({
      type: enabled ? 'connected' : 'disconnected',
      at: new Date(this.now()).toISOString(),
      payload: { internet: enabled },
    })
    return this.status(adminUserId)
  }

  /** True when the Admin has switched internet access on in settings (independent of the licence). */
  private internetEnabled(): boolean {
    const row = this.database.prepare('SELECT mobile_internet_enabled FROM settings WHERE id = 1')
      .get() as { mobile_internet_enabled: number } | undefined
    return row?.mobile_internet_enabled === 1
  }

  private async startRelayIfEnabled(adminUserId: string): Promise<void> {
    if (!this.internetEnabled()) return
    await this.startRelay(adminUserId)
  }

  private async startRelay(adminUserId: string): Promise<void> {
    if (this.relay) return
    const snapshot = this.license.getSnapshot()
    const relayUrl = this.options.relayUrl?.() ?? null
    if (!snapshot.canUse || !snapshot.features.mobileInternet || !relayUrl || !snapshot.licenseId) return
    if (!this.server || this.listenPort === null) return
    const shopId = shopSlug(snapshot.licenseId)
    const client = this.options.createRelayClient?.({ shopId, relayUrl }) ?? null
    if (!client) return
    this.relay = client
    this.relayStatus = client.currentStatus
    client.start()
    this.auditMobile('mobile.internet.connecting', adminUserId, { shopId })
  }

  private stopRelay(): void {
    const relay = this.relay
    this.relay = null
    this.relayStatus = null
    if (relay) relay.stop()
  }

  /**
   * Called when the licence changes: a suspension, an expiry or a withdrawn entitlement must drop an open tunnel
   * at once rather than waiting for the phone's next request to be refused.
   */
  applyLicenseChange(): void {
    const snapshot = this.license.getSnapshot()
    if (this.relay && (!snapshot.canUse || !snapshot.features.mobileInternet)) {
      this.relay.disconnect('This shop licence no longer allows internet access.')
      this.relay = null
      this.relayStatus = null
      return
    }
    if (!this.relay?.currentStatus.reason && this.internetEnabled() && this.server && snapshot.canUse
      && snapshot.features.mobileInternet && !this.relay) {
      void this.startRelay('*license-change*')
    }
  }

  /**
   * The internet half of the Mobile access screen. The link is minted fresh on every read, so a screenshot of an
   * old QR code stops working within minutes.
   */
  internetStatus(): MobileInternetStatus {
    const snapshot = this.license.getSnapshot()
    const relayUrl = this.options.relayUrl?.() ?? null
    const enabled = this.internetEnabled()
    const entitled = Boolean(snapshot.canUse && snapshot.features.mobileInternet)
    const privacyNote = 'The Infoflex relay forwards your phone’s requests to this computer and stores none of them. '
      + 'Like any secure web server it can read them in transit. Your Admin login, this phone’s approval and your '
      + 'authenticator code are still required.'
    let relayHost: string | null = null
    if (relayUrl) {
      try {
        relayHost = new URL(relayUrl).host
      } catch {
        relayHost = null
      }
    }
    if (!entitled || !relayUrl) {
      return {
        state: 'unavailable', entitled, enabled, publicUrl: null, relayHost, link: null, privacyNote,
        message: !entitled
          ? 'This shop licence does not include mobile access over the internet.'
          : 'This licence server does not offer internet access, so the phone works on the shop network only.',
      }
    }
    if (!enabled) {
      return {
        state: 'off', entitled, enabled, publicUrl: null, relayHost, link: null, privacyNote,
        message: 'Mobile access over the internet is switched off on this computer. The phone still works on the shop network.',
      }
    }
    const status = this.relay?.currentStatus ?? this.relayStatus
    return {
      state: status?.state === 'stopped' ? 'off' : (status?.state ?? 'connecting'),
      entitled,
      enabled,
      publicUrl: this.relay?.publicUrl ?? null,
      relayHost,
      link: this.relay?.createLink() ?? null,
      message: status?.message ?? 'Connecting to the Infoflex relay…',
      privacyNote,
    }
  }

  /**
   * Where a relayed request must be delivered locally. Loopback only, on the listener this service owns, with the
   * local certificate authority as the only trust root — so the shop PC verifies the listener it is talking to
   * rather than trusting whatever answers on that port.
   */
  relayTarget(): { host: string; port: number; secure: boolean; ca?: string } | null {
    if (!this.server || this.listenPort === null || !this.identity) return null
    return { host: '127.0.0.1', port: this.listenPort, secure: true, ca: this.identity.caCertificate }
  }

  private async stopListener(): Promise<void> {
    this.stopHealthcheck()
    // The relay depends on this listener; a listener that stops leaves the tunnel pointing at nothing.
    const relay = this.relay
    this.relay = null
    this.relayStatus = null
    relay?.stop()
    const server = this.server
    this.server = null
    this.listenPort = null
    this.servingAddresses = []
    if (server) await server.close()
  }
}

function isIdentity(value: unknown): value is PersistedIdentity {
  if (!value || typeof value !== 'object') return false
  const identity = value as Partial<PersistedIdentity>
  return identity.schema === 2
    && typeof identity.caCertificate === 'string'
    && typeof identity.encryptedCaPrivateKey === 'string'
    && typeof identity.serverCertificate === 'string'
    && typeof identity.encryptedServerPrivateKey === 'string'
    && Array.isArray(identity.addresses)
    && identity.addresses.length > 0
    && identity.addresses.every((address) => typeof address === 'string' && isPrivateIpv4(address))
    && typeof identity.fingerprint === 'string'
    && typeof identity.serverFingerprint === 'string'
    && typeof identity.createdAt === 'string'
    && typeof identity.caExpiresAt === 'string'
    && typeof identity.serverExpiresAt === 'string'
    && typeof identity.trustAcknowledged === 'boolean'
}

function fingerprintOf(pem: string): string {
  const certificate = new X509Certificate(pem)
  return createHash('sha256').update(certificate.raw).digest('hex').toUpperCase().match(/.{2}/gu)!.join(':')
}

function matchesPublicKey(publicKey: ReturnType<typeof createPublicKey>, privateKeyPem: string): boolean {
  const fromCertificate = publicKey.export({ type: 'spki', format: 'der' })
  const fromPrivateKey = createPublicKey(privateKeyPem).export({ type: 'spki', format: 'der' })
  return Buffer.from(fromCertificate).equals(Buffer.from(fromPrivateKey))
}

function getPrivateIpv4Addresses(): string[] {
  const addresses = new Set<string>()
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== 'IPv4' || !isPrivateIpv4(entry.address)) continue
      addresses.add(entry.address)
    }
  }
  return [...addresses].sort()
}

function sameAddresses(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((address, index) => address === right[index])
}

function isPrivateIpv4(value: string): boolean {
  const parts = value.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [first, second] = parts as [number, number, number, number]
  return first === 10 || first === 192 && second === 168 || first === 172 && second >= 16 && second <= 31
}

function isAddressInUse(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'EADDRINUSE')
}

function isFileNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT')
}
