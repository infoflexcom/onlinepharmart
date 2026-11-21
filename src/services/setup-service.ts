import { randomUUID } from 'node:crypto'
import { hash as bcryptHash } from 'bcryptjs'
import { DEFAULT_CURRENCY_CODE, createCustomCurrency, getCurrency, type CurrencyDefinition } from '../currency/catalog'
import type { FirstRunInput, ShopSettings, SetupContext } from '../shared/shop/types'
import type { PublicUser } from '../shared/auth/types'
import { defaultPermissions } from '../shared/auth/policy'
import type { LicensePolicyProvider, VerifiedLicensePolicy } from '../license/setup-policy'
import type { ShopRepository } from './contracts/shop-repository'
import type { SetupPreferencesRepository } from './contracts/setup-repository'
import type { UserRepository } from './contracts/user-repository'
import { normalizeShopProfile, validateMoneyDisplay } from './shop-service'
import type { BuildProfile } from '../../installer/src/build-profile'

const BCRYPT_ROUNDS = 12
const ADMIN_PERMISSIONS = defaultPermissions('ADMIN')

export interface FirstRunResult {
  settings: ShopSettings
  admin: PublicUser
}

export class SetupService {
  constructor(
    private readonly shopRepository: ShopRepository,
    private readonly userRepository: UserRepository,
    private readonly setupPreferences: SetupPreferencesRepository,
    private readonly licensePolicy: LicensePolicyProvider,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID,
    /**
     * The vendor's build settings, when this build carries them.
     *
     * A build locked to one country must stay locked on this screen too. The installer already refuses to let the
     * customer change the currency, but a shop that reinstalls the app, or that was handed the app without the
     * installer, would otherwise get a free choice here — which would make the vendor's lock meaningless.
     */
    private readonly buildProfile: BuildProfile | null = null,
  ) {}

  async getSetupContext(): Promise<SetupContext> {
    const policy = await this.licensePolicy.getVerifiedPolicy()
    const settings = this.shopRepository.readSettings()
    const installerCurrencyCode = this.setupPreferences.getInstallerCurrencyCode()
    const currentCurrencyIsLocked = settings.currencyLocked
    const buildCurrencyLocked = this.buildProfile?.lockCurrency === true
    const vendorCurrencyLocked = Boolean(policy?.lockCurrency || buildCurrencyLocked || this.setupPreferences.isCurrencyLockedByVendor())
    const lockByVendor = vendorCurrencyLocked
    // Precedence, most specific first: what this shop already has, what its licence was sold with, what the
    // customer chose in the installer on this machine, what the build was made for, and finally the default.
    //
    // The installer ranks above the build on purpose. A locked build names its currency, so the two agree; an
    // *unlocked* build's currency is only the vendor's suggestion for shops that have no opinion, and a customer
    // who explicitly chose something in the installer has one.
    const suggestedCode = currentCurrencyIsLocked
      ? settings.currency.code
      : policy?.defaultCurrencyCode
        ?? installerCurrencyCode
        ?? this.buildProfile?.defaultCurrencyCode
        ?? (settings.setupComplete ? settings.currency.code : DEFAULT_CURRENCY_CODE)

    const initialCurrency = this.setupPreferences.getCurrencyDefinition(suggestedCode)
      ?? getCurrency(suggestedCode)
    if (!initialCurrency) {
      throw new Error('The configured setup currency is unavailable. Choose a valid currency or contact your vendor.')
    }
    // A build lock always names its currency, so the "lock with nothing to lock to" failure can only come from a
    // licence. Checking it against the right source keeps the message honest.
    if (lockByVendor && !policy?.defaultCurrencyCode && !buildCurrencyLocked) {
      throw new Error('The vendor currency lock has no configured default currency.')
    }

    const edition = policy?.edition ?? null
    return {
      licenseActivated: policy !== null,
      edition,
      installerCurrencyCode,
      licenseDefaultCurrencyCode: policy?.defaultCurrencyCode ?? null,
      currencyLocked: currentCurrencyIsLocked || lockByVendor,
      vendorCurrencyLocked,
      initialCurrency,
      productName: productNameForEdition(edition),
    }
  }

  async completeFirstRun(input: FirstRunInput): Promise<FirstRunResult> {
    assertFirstRunInput(input)
    const policy = await this.licensePolicy.getVerifiedPolicy()
    if (!policy) throw new Error('Activate a valid Infoflex licence before first-run setup.')
    if (this.userRepository.countUsers() > 0) throw new Error('First-run setup has already been completed.')

    const settingsBefore = this.shopRepository.readSettings()
    const context = await this.getSetupContext()
    if (!context.licenseActivated || !context.edition) throw new Error('Activate a valid Infoflex licence before first-run setup.')

    const profile = normalizeShopProfile(input.profile)
    const adminFullName = normalizeHumanName(input.admin.fullName, 'Admin full name')
    const username = normalizeUsername(input.admin.username)
    validatePasswordPair(input.admin.password, input.admin.confirmPassword)
    if (!input.currencyConfirmed) throw new Error('Confirm the shop currency before completing setup.')
    const currency = canonicalCurrency(input.currency)
    if (context.currencyLocked && currency.code !== context.initialCurrency.code) {
      throw new Error('Your vendor or an existing transaction has locked this currency.')
    }
    validateMoneyDisplay(input.display)
    const passwordHash = await bcryptHash(input.admin.password, BCRYPT_ROUNDS)
    const userId = this.newId()
    const now = this.now().toISOString()

    const nextSettings: ShopSettings = {
      ...settingsBefore,
      profile,
      currency,
      display: { ...input.display },
      setupComplete: true,
      currencyConfirmed: true,
      currencyLocked: context.currencyLocked,
      idleTimeoutMinutes: settingsBefore.idleTimeoutMinutes ?? 15,
    }
    const admin: PublicUser = {
      id: userId,
      fullName: adminFullName,
      username,
      role: 'ADMIN',
      isActive: true,
      isLocked: false,
      permissions: ADMIN_PERMISSIONS,
    }

    this.shopRepository.withTransaction(() => {
      // Recheck under the write transaction so two simultaneous setup submissions cannot create two first users.
      if (this.userRepository.countUsers() > 0) throw new Error('First-run setup has already been completed.')
      this.shopRepository.saveSettings(nextSettings)
      if (policy.lockCurrency) this.setupPreferences.setVendorCurrencyLock()
      this.userRepository.createUser({
        ...admin,
        passwordHash,
      })
      this.shopRepository.appendAudit({
        actor: username,
        action: 'first_run.setup.completed',
        metadata: {
          adminUserId: userId,
          storeName: profile.name,
          edition: policy.edition,
          currencyCode: currency.code,
        },
        deviceName: 'LOCAL_SETUP',
        ipAddress: null,
        createdAt: now,
      })
      this.shopRepository.appendAudit({
        actor: username,
        action: 'currency.selected',
        metadata: { currencyCode: currency.code, source: 'first_run', vendorLocked: policy.lockCurrency },
        deviceName: 'LOCAL_SETUP',
        ipAddress: null,
        createdAt: now,
      })
    })

    return { settings: nextSettings, admin }
  }
}

function assertFirstRunInput(input: FirstRunInput): void {
  if (!input || typeof input !== 'object') throw new Error('Enter the required first-run details.')
  if (!input.admin || typeof input.admin !== 'object'
    || typeof input.admin.fullName !== 'string'
    || typeof input.admin.username !== 'string'
    || typeof input.admin.password !== 'string'
    || typeof input.admin.confirmPassword !== 'string') {
    throw new Error('Enter the required Admin account details.')
  }
  if (!input.currency || typeof input.currency !== 'object') throw new Error('Choose a valid shop currency.')
  if (!input.display || typeof input.display !== 'object') throw new Error('Choose valid amount display options.')
  if (typeof input.currencyConfirmed !== 'boolean') throw new Error('Confirm the shop currency before continuing.')
}

function canonicalCurrency(input: CurrencyDefinition): CurrencyDefinition {
  if (!input || typeof input !== 'object' || typeof input.code !== 'string') throw new Error('Choose a supported currency.')
  if (input.kind === 'iso') {
    const currency = getCurrency(input.code)
    if (!currency) throw new Error('Choose a supported ISO currency.')
    return currency
  }
  return createCustomCurrency(input)
}

function normalizeHumanName(value: string, label: string): string {
  const name = value.trim().replace(/\s+/gu, ' ')
  if (!name) throw new Error(`Enter ${label.toLowerCase()}.`)
  if (name.length > 120) throw new Error(`${label} must be 120 characters or fewer.`)
  return name
}

export function normalizeUsername(value: string): string {
  if (typeof value !== 'string') throw new Error('Enter a username.')
  const username = value.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) {
    throw new Error('Username must be 3–32 characters using letters, numbers, dot, underscore, or hyphen.')
  }
  return username
}

export function validatePasswordPair(password: string, confirmPassword: string): void {
  if (typeof password !== 'string' || typeof confirmPassword !== 'string') throw new Error('Enter and confirm a password.')
  const bytes = new TextEncoder().encode(password).length
  if (password.length < 10) throw new Error('Use at least 10 characters for the password.')
  if (bytes > 72) throw new Error('Password must be 72 UTF-8 bytes or fewer.')
  const variety = [/[a-z]/.test(password), /[A-Z]/.test(password), /\d/.test(password), /[^A-Za-z0-9]/.test(password)]
    .filter(Boolean).length
  if (variety < 3) throw new Error('Use a mix of upper-case, lower-case, numbers, and symbols.')
  if (password !== confirmPassword) throw new Error('Passwords do not match.')
}

export function productNameForEdition(edition: VerifiedLicensePolicy['edition'] | null): string {
  if (edition === 'PHARMACY') return 'Infoflex Pharm'
  if (edition === 'SUPERMARKET') return 'Infoflex Mart'
  if (edition === 'BOTH') return 'Infoflex Pharm & Mart'
  return 'Infoflex'
}
