export interface PairedMobileDevice {
  id: string
  name: string
  platform: string
  createdAt: string
  lastSeen: string | null
  lastIp: string | null
  /** Admin who paired the phone; only an Admin can own a device. */
  ownerUsername: string
  approvedAt: string | null
  /** 'PENDING' until the Admin approves on the PC, then 'APPROVED'; 'REVOKED' never lists. */
  approvalStatus: 'PENDING' | 'APPROVED'
  /** True when the phone has an unexpired session, i.e. it can open the app right now. */
  connected: boolean
}

export interface MobileAccessStatus {
  running: boolean
  urls: string[]
  /** Friendly mDNS-style name shown next to the numeric address. */
  friendlyUrls: string[]
  port: number | null
  certificateFingerprint: string | null
  certificateNeedsInstall: boolean
  pairedDeviceCount: number
  /** Devices with a live session right now, for the desktop's live indicator. */
  connectedDeviceCount: number
  /** Licence entitlement: how many Admin phones this licence allows. */
  phoneLimit: number
  /** True when the Windows Firewall rule for the port is missing or blocking private networks. */
  firewallBlocked: boolean
  firewallMessage: string | null
  message: string
  /**
   * The internet relay, as this computer sees it. Present always; `state: 'off'` is the normal case, because
   * mobile access over the internet is off by default and only exists when the licence grants it.
   */
  internet: MobileInternetStatus
}

/**
 * What the Admin sees about the relay. Deliberately the same words the user-facing docs use: the vendor's relay
 * forwards traffic and stores none of it, and that is stated on the screen rather than buried in a manual.
 */
export interface MobileInternetStatus {
  /** `off` — the Admin switch is off. `unavailable` — the licence does not include it, or no relay is configured. */
  state: 'off' | 'unavailable' | 'connecting' | 'connected' | 'waiting' | 'refused'
  /** True when the licence's `mobileInternet` entitlement is granted (the host still requires the switch). */
  entitled: boolean
  /** The Admin's own switch, persisted in `settings.mobile_internet_enabled`. */
  enabled: boolean
  /** `https://<shop>.<relay-domain>` once connected; null before the relay has introduced itself. */
  publicUrl: string | null
  message: string
  /** Where the relay is, for the screen to name it. Null when the vendor runs no relay. */
  relayHost: string | null
  /** A fresh link for the phone; re-minted on every read, so an old screenshot stops working. */
  link: { url: string; expiresAt: string } | null
  /** Stated on the screen, not only in the docs. */
  privacyNote: string
}

export interface MobilePairingInfo {
  code: string
  expiresAt: string
  pairingUrl: string
  /** Same address as a short, typeable form for phones whose camera cannot scan. */
  addresses: string[]
}

export interface MobileSessionCredentials {
  deviceId: string
  accessToken: string
  refreshToken: string
  accessTokenExpiresAt: string
  refreshTokenExpiresAt: string
  /** True once the login was completed and the phone may call the API; pairing alone is not enough. */
  loginRequired: boolean
}

export interface MobilePairInput {
  code: string
  deviceName: string
  platform: string
}

export interface MobileLoginInput {
  username: string
  password: string
  /** Required when the connection is over the Internet or the phone has not been trusted locally. */
  totpCode?: string
}

export interface MobileLoginResult {
  deviceId: string
  accessToken: string
  refreshToken: string
  accessTokenExpiresAt: string
  refreshTokenExpiresAt: string
  user: { id: string; username: string; fullName: string; role: 'ADMIN' }
  requiresTotp: boolean
}

export interface MobileLoginChallenge {
  /** True when this connection (or this device) needs an authenticator code before a session is issued. */
  totpRequired: boolean
  /** True when the Admin has not yet enrolled an authenticator for this account. */
  totpEnrolled: boolean
  /** Short hint so the phone can explain itself without leaking account existence. */
  message: string
}

export interface MobileTotpEnrollment {
  secret: string
  uri: string
  accountName: string
  issuer: string
  /** Base32 secret in 4-character groups for people who must type it. */
  formattedSecret: string
}

export interface MobileConnectionTest {
  ok: boolean
  checkedAt: string
  port: number | null
  urls: string[]
  certificateFingerprint: string | null
  firewallBlocked: boolean
  steps: Array<{ label: string; ok: boolean; detail: string }>
}

export interface MobileKeepRunningSettings {
  keepRunning: boolean
  startWithWindows: boolean
  preventSleep: boolean
}

export interface MobilePushEvent {
  type: 'connected' | 'disconnected' | 'stock.changed' | 'approval.created' | 'approval.resolved' | 'device.paired' | 'device.revoked' | 'session.totp'
  at: string
  payload?: Record<string, unknown>
}

/** A device waiting on the PC for approval; the code is the one the phone shows. */
export interface PendingMobileApproval {
  requestId: string
  deviceName: string
  platform: string
  code: string
  ipAddress: string | null
  requestedAt: string
  expiresAt: string
}

export interface TotpStatus {
  enrolled: boolean
  confirmedAt: string | null
}
