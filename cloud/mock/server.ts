import { generateKeyPairSync, randomUUID, sign as signSignature, type KeyObject } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify, { type FastifyInstance } from 'fastify'
import type { Edition } from '../../src/editions'
import type { LicenseClaims, LicenseSource } from '../../src/shared/license/types'
import { addYearsToDateInput, dateInputToUtc, todayDateInput } from '../../src/license/dates'
import { canonicalLicenseClaims } from '../../src/license/crypto'

const DAY_MS = 24 * 60 * 60 * 1000

interface MockLicenseRecord {
  claims: LicenseClaims
  reportedAt: string | null
  reportCount: number
  lastDevice: { machineId: string; appVersion: string; platform: string; checkedAt: string } | null
  revision: number
  deliveredRevision: number
}

export interface MockServerOptions {
  now?: () => Date
  host?: string
  port?: number
  onListen?: (url: string) => void
}

const MOCK_PLANS: Readonly<Record<string, { edition: Edition; years: number; days?: number }>> = {
  'MOCK-PHARMACY-1Y': { edition: 'PHARMACY', years: 1 },
  'MOCK-PHARMACY-3Y': { edition: 'PHARMACY', years: 3 },
  'MOCK-PHARMACY-5Y': { edition: 'PHARMACY', years: 5 },
  'MOCK-SUPERMARKET-1Y': { edition: 'SUPERMARKET', years: 1 },
  'MOCK-BOTH-1Y': { edition: 'BOTH', years: 1 },
  'MOCK-PHARMACY-1D': { edition: 'PHARMACY', years: 0, days: 1 },
}

export function createMockLicenseServer(options: MockServerOptions = {}): {
  app: FastifyInstance
  listLicenses: () => MockLicenseRecord[]
  close: () => Promise<void>
} {
  const now = options.now ?? (() => new Date())
  // This private key exists only in the mock server's process memory and is regenerated on each start.
  const keyPair = generateKeyPairSync('ed25519')
  const keyId = `local-mock-${randomUUID()}`
  const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const licenses = new Map<string, MockLicenseRecord>()
  const app = Fastify({ logger: false, bodyLimit: 64_000 })

  app.get('/', async (_request, reply) => reply.type('text/html').send(mockConsoleHtml()))
  app.get('/api/license/config', async () => ({ mode: 'infoflex-mock', keyId, publicKey }))

  app.post('/api/license/activate', async (request, reply) => {
    const body = objectBody(request.body)
    const activationKey = stringField(body.activationKey, 120)
    const machineId = stringField(body.machineId, 128)
    const appVersion = stringField(body.appVersion, 64)
    const platform = cleanLabel(body.platform, 80)
    const plan = MOCK_PLANS[activationKey]
    if (!plan) return reply.code(401).send({ error: 'activation_rejected' })

    const startOn = todayDateInput(now())
    const endOn = plan.days
      ? new Date(Date.parse(`${startOn}T00:00:00.000Z`) + plan.days * DAY_MS).toISOString().slice(0, 10)
      : addYearsToDateInput(startOn, plan.years)
    const claims: LicenseClaims = {
      licenseId: randomUUID(),
      machineId,
      edition: plan.edition,
      startsAt: dateInputToUtc(startOn),
      endsAt: dateInputToUtc(endOn),
      issuedAt: now().toISOString(),
      status: 'active',
      source: 'online',
      defaultCurrencyCode: 'NGN',
      lockCurrency: false,
      features: { mobileLan: true, mobileInternet: false },
      adminPhoneLimit: 1,
      graceDays: 0,
    }
    const record: MockLicenseRecord = {
      claims,
      reportedAt: null,
      reportCount: 0,
      lastDevice: { machineId, appVersion, platform, checkedAt: now().toISOString() },
      revision: 1,
      deliveredRevision: 1,
    }
    licenses.set(claims.licenseId, record)
    return { token: signMockToken(claims, keyPair.privateKey, keyId), serverNow: now().toISOString() }
  })

  app.post('/api/license/check-in', async (request, reply) => {
    const body = objectBody(request.body)
    if (hasBusinessPayload(body)) return reply.code(400).send({ error: 'business_data_not_permitted' })
    const licenseId = stringField(body.licenseId, 160)
    const machineId = stringField(body.machineId, 128)
    const appVersion = stringField(body.appVersion, 64)
    const platform = cleanLabel(body.platform, 80)
    const checkedAt = stringField(body.checkedAt, 64)
    const source = sourceField(body.source)
    let record = licenses.get(licenseId)

    if (source === 'onsite') {
      const details = objectBody(body.onsiteLicense)
      if (details.licenseId !== licenseId || details.machineId !== machineId || details.source !== 'onsite') {
        return reply.code(400).send({ error: 'onsite_report_invalid' })
      }
      const incoming = parseOnsiteDetails(details, licenseId, machineId)
      if (record && record.claims.machineId !== machineId) return reply.code(409).send({ error: 'machine_binding_conflict' })
      if (!record) {
        record = { claims: incoming, reportedAt: null, reportCount: 0, lastDevice: null, revision: 1, deliveredRevision: 0 }
        licenses.set(licenseId, record)
      } else if (record.revision <= record.deliveredRevision && !sameEntitlement(record.claims, incoming)) {
        return reply.code(409).send({ error: 'onsite_license_conflict' })
      }
    }

    if (!record) return { updated: false, reported: false, token: null, serverNow: now().toISOString() }
    if (record.claims.machineId !== machineId) return reply.code(409).send({ error: 'machine_binding_conflict' })
    record.reportCount += 1
    record.reportedAt ??= now().toISOString()
    record.lastDevice = { machineId, appVersion, platform, checkedAt }

    if (record.revision > record.deliveredRevision) {
      // The response is a vendor Ed25519 assertion. An offline-only on-site license cannot
      // be remotely controlled until its first report creates this server-side record.
      const signed = signMockToken(record.claims, keyPair.privateKey, keyId)
      record.deliveredRevision = record.revision
      return { updated: true, reported: true, token: signed, serverNow: now().toISOString() }
    }
    return { updated: false, reported: true, token: null, serverNow: now().toISOString() }
  })

  app.get('/api/mock/licenses', async () => ({
    licenses: [...licenses.values()].map(({ claims, reportedAt, reportCount, lastDevice }) => ({
      licenseId: claims.licenseId,
      machineId: claims.machineId,
      source: claims.source,
      edition: claims.edition,
      status: claims.status,
      startsAt: claims.startsAt,
      endsAt: claims.endsAt,
      defaultCurrencyCode: claims.defaultCurrencyCode,
      lockCurrency: claims.lockCurrency,
      features: claims.features,
      adminPhoneLimit: claims.adminPhoneLimit,
      reportedAt,
      reportCount,
      lastDevice,
    })),
  }))

  app.post<{ Params: { licenseId: string }; Body: { years?: number } }>('/api/mock/licenses/:licenseId/extend', async (request, reply) => {
    const record = licenses.get(request.params.licenseId)
    if (!record) return reply.code(404).send({ error: 'license_not_found' })
    if (!Number.isInteger(request.body?.years) || (request.body.years as number) < 1 || (request.body.years as number) > 5) {
      return reply.code(400).send({ error: 'extension_term_invalid' })
    }
    const endOn = record.claims.endsAt.slice(0, 10)
    const currentOn = todayDateInput(now())
    const base = endOn < currentOn ? currentOn : endOn
    record.claims = { ...record.claims, endsAt: dateInputToUtc(addYearsToDateInput(base, request.body.years as number)), status: 'active' }
    record.revision += 1
    return { licenseId: record.claims.licenseId, endsAt: record.claims.endsAt, status: record.claims.status }
  })

  app.post<{ Params: { licenseId: string }; Body: { status?: string } }>('/api/mock/licenses/:licenseId/status', async (request, reply) => {
    const record = licenses.get(request.params.licenseId)
    if (!record) return reply.code(404).send({ error: 'license_not_found' })
    if (request.body?.status !== 'active' && request.body?.status !== 'suspended' && request.body?.status !== 'revoked') {
      return reply.code(400).send({ error: 'license_status_invalid' })
    }
    record.claims = { ...record.claims, status: request.body.status }
    record.revision += 1
    return { licenseId: record.claims.licenseId, status: record.claims.status }
  })

  return {
    app,
    listLicenses: () => [...licenses.values()],
    close: async () => { await app.close() },
  }
}

function signMockToken(claims: LicenseClaims, privateKey: KeyObject, keyId: string): string {
  const payload = canonicalLicenseClaims(claims)
  return JSON.stringify({
    format: 'infoflex-license',
    version: 1,
    algorithm: 'Ed25519',
    keyId,
    payload: payload.toString('base64url'),
    signature: signSignature(null, payload, privateKey).toString('base64url'),
  })
}

function objectBody(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Request body must be an object.')
  return value as Record<string, any>
}

function stringField(value: unknown, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) throw new Error('A required request field is missing.')
  return value.trim()
}

function cleanLabel(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.replace(/[\p{C}]+/gu, '').trim().slice(0, maxLength) : 'unknown'
}

function sourceField(value: unknown): LicenseSource {
  if (value === 'online' || value === 'file' || value === 'onsite') return value
  throw new Error('The license source is invalid.')
}

function parseOnsiteDetails(details: Record<string, unknown>, licenseId: string, machineId: string): LicenseClaims {
  const features = objectBody(details.features)
  const edition = details.edition
  const status = details.status
  const source = details.source
  const defaultCurrencyCode = details.defaultCurrencyCode
  const startsAt = stringField(details.startsAt, 64)
  const endsAt = stringField(details.endsAt, 64)
  const issuedAt = stringField(details.issuedAt, 64)
  if ((edition !== 'PHARMACY' && edition !== 'SUPERMARKET' && edition !== 'BOTH')
    || (status !== 'active' && status !== 'suspended' && status !== 'revoked')
    || source !== 'onsite'
    || (defaultCurrencyCode !== null && typeof defaultCurrencyCode !== 'string')
    || typeof details.lockCurrency !== 'boolean'
    || typeof features.mobileLan !== 'boolean' || typeof features.mobileInternet !== 'boolean'
    || !Number.isInteger(details.adminPhoneLimit) || !Number.isInteger(details.graceDays)) {
    throw new Error('On-site license metadata is invalid.')
  }
  return {
    licenseId,
    machineId,
    edition,
    startsAt,
    endsAt,
    issuedAt,
    status,
    source,
    defaultCurrencyCode,
    lockCurrency: details.lockCurrency,
    features: { mobileLan: features.mobileLan, mobileInternet: features.mobileInternet },
    adminPhoneLimit: details.adminPhoneLimit as number,
    graceDays: details.graceDays as number,
  }
}

function sameEntitlement(left: LicenseClaims, right: LicenseClaims): boolean {
  return canonicalLicenseClaims(left).equals(canonicalLicenseClaims(right))
}

function hasBusinessPayload(value: Record<string, unknown>): boolean {
  const forbidden = new Set(['sales', 'stock', 'inventory', 'customers', 'users', 'payments', 'transactions', 'currencyAmounts'])
  return Object.keys(value).some((key) => forbidden.has(key))
}

function mockConsoleHtml(): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Infoflex Mock License Console</title>
<style>body{font:15px system-ui;margin:0;background:#f3f5f8;color:#172235}header{background:#18365f;color:white;padding:26px max(24px,5vw)}main{max-width:1050px;margin:28px auto;padding:0 20px}.card{background:white;border:1px solid #dfe5ed;border-radius:12px;padding:22px;margin-bottom:16px}h1{margin:0 0 8px}p,small{color:#647187}table{border-collapse:collapse;width:100%;font-size:13px}td,th{text-align:left;padding:10px;border-bottom:1px solid #e6eaf0}.actions{display:flex;gap:8px;flex-wrap:wrap}button{border:0;border-radius:6px;padding:8px 11px;background:#1f3f73;color:white;cursor:pointer}button.secondary{background:#e9edf4;color:#203b63}.key{font-family:ui-monospace,monospace;background:#eef2f6;padding:3px 6px;border-radius:4px}.muted{font-size:12px;color:#788499}.status{font-weight:700}</style>
<header><h1>Mock License Console</h1><div>Local test service · generated signing key is ephemeral and is not a production key</div></header><main>
<section class="card"><h2>Test activation keys</h2><p>Use one of these keys in the desktop activation screen. Unknown keys are rejected.</p><p><span class="key">MOCK-PHARMACY-1Y</span> · <span class="key">MOCK-PHARMACY-3Y</span> · <span class="key">MOCK-PHARMACY-5Y</span> · <span class="key">MOCK-SUPERMARKET-1Y</span> · <span class="key">MOCK-BOTH-1Y</span> · <span class="key">MOCK-PHARMACY-1D</span></p><p class="muted">The 1-day key is for expiry/polling tests. The local server stores license/device metadata only.</p></section>
<section class="card"><h2>Reported licenses</h2><div id="status" class="muted">Loading…</div><div style="overflow:auto"><table><thead><tr><th>License</th><th>Edition</th><th>Status</th><th>Ends</th><th>Source</th><th>Reports</th><th>Actions</th></tr></thead><tbody id="rows"></tbody></table></div></section>
<section class="card"><h2>Local mock endpoint</h2><p>Configure the desktop's Online activation tab with this origin:</p><p id="origin" class="key"></p><p class="muted">The app accepts this server's public key only for an explicitly local mock endpoint in an unpackaged development build. The private key exists only in this server process.</p></section></main>
<script>document.getElementById('origin').textContent=location.origin;async function refresh(){const response=await fetch('/api/mock/licenses');const data=await response.json();document.getElementById('rows').innerHTML=(data.licenses||[]).map(item=>'<tr><td>'+escapeHtml(item.licenseId)+'</td><td>'+escapeHtml(item.edition)+'</td><td class="status">'+escapeHtml(item.status)+'</td><td>'+escapeHtml(item.endsAt.slice(0,10))+'</td><td>'+escapeHtml(item.source)+'</td><td>'+item.reportCount+(item.reportedAt?' · first '+escapeHtml(item.reportedAt):'')+'</td><td><div class="actions"><button onclick="extendLicense(\''+encodeURIComponent(item.licenseId)+'\')">Extend 1 year</button><button class="secondary" onclick="setStatus(\''+encodeURIComponent(item.licenseId)+'\',\'suspended\')">Suspend</button><button class="secondary" onclick="setStatus(\''+encodeURIComponent(item.licenseId)+'\',\'active\')">Resume</button></div></td></tr>').join('')||'<tr><td colspan="7">No licenses have checked in yet.</td></tr>';document.getElementById('status').textContent='Only license/device/version/online metadata is reported; no shop business data.'}function escapeHtml(v){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}async function extendLicense(id){await fetch('/api/mock/licenses/'+id+'/extend',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({years:1})});refresh()}async function setStatus(id,status){await fetch('/api/mock/licenses/'+id+'/status',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({status})});refresh()}setInterval(refresh,3000);refresh()</script></html>`
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const host = process.env.INFOFLEX_MOCK_HOST ?? '127.0.0.1'
  const port = Number(process.env.INFOFLEX_MOCK_PORT ?? 8732)
  const { app, close } = createMockLicenseServer({ host, port })
  app.listen({ host, port })
    .then((address) => {
      process.stdout.write(`Mock license server listening on ${address}\n`)
    })
    .catch((error: unknown) => {
      process.stderr.write(`Mock license server failed to start: ${error instanceof Error ? error.message : 'unknown error'}\n`)
      process.exitCode = 1
    })
  process.on('SIGINT', () => { void close().finally(() => process.exit(0)) })
}
