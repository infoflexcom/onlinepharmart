import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { parseVendorPolicyFile } from '../src/license/vendor-policy'
import { MAX_CONFIGURABLE_PERIOD_YEARS } from '../src/license/dates'

/**
 * The licence policy page: `policy.html`.
 *
 * This is the page a vendor opens to produce the `.iflpolicy` file a customer's desktop imports under
 * *On-site / offline → Import vendor policy*. It is plain HTML with an inline script, no build step, because it has
 * to work by double-clicking a file in a browser with no toolchain present.
 *
 * That also means nothing type-checks it, and until now nothing tested it — it was referenced from six documents
 * and exercised by hand at most. So this suite runs the real page in a DOM with a real Web Crypto, generates a
 * policy, and **parses the result with the application's own `parseVendorPolicyFile`**, which is the only thing that
 * makes the test worth having: a page that produces a file the app rejects is worse than a page that does not exist,
 * because the vendor finds out at the customer's shop.
 *
 * It is also the regression guard for the phase-14 rewrite: when the Build Studio window replaced this page as
 * `index.html`, this capability was silently lost. It now lives at its own URL and this suite fails if it goes.
 */

const PAGE = 'buildstudio/policy.html'

interface Downloaded { name: string; text: string }

/**
 * Opens the page and returns what the download button would have saved.
 *
 * jsdom implements neither `crypto.subtle` nor `URL.createObjectURL`, and the page needs both. Rather than stub the
 * cryptography — which would test the stub — the page is given Node's real `webcrypto`, and `createObjectURL` is
 * replaced by a reader that captures the blob's bytes. So the hash under test is genuinely derived here.
 */
async function generate(options: {
  password?: string
  confirmation?: string
  years?: string
  url?: string
  keys?: string
} = {}): Promise<{ policy: unknown | null; message: string; downloads: Downloaded[] }> {
  const html = readFileSync(PAGE, 'utf8')
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'file:///policy.html' })
  const { window } = dom
  const downloads: Downloaded[] = []

  Object.defineProperty(window, 'crypto', { value: globalThis.crypto, configurable: true })
  const blobs = new Map<string, Blob>()
  let counter = 0
  Object.defineProperty(window.URL, 'createObjectURL', {
    value: (blob: Blob) => {
      const id = `blob:${counter += 1}`
      blobs.set(id, blob)
      return id
    },
    configurable: true,
  })
  Object.defineProperty(window.URL, 'revokeObjectURL', { value: () => {}, configurable: true })

  // A click on the generated link is captured rather than navigated to.
  const document = window.document
  const originalClick = window.HTMLAnchorElement.prototype.click
  window.HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement): void {
    const blob = blobs.get(this.href)
    if (!blob) return
    void blob.text().then((text) => downloads.push({ name: this.download, text }))
  }

  const set = (id: string, value: string): void => {
    const element = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
    element.value = value
  }
  set('master-password', options.password ?? 'a-long-vendor-password')
  set('confirm-password', options.confirmation ?? options.password ?? 'a-long-vendor-password')
  set('max-years', options.years ?? '')
  set('server-url', options.url ?? '')
  set('public-keys', options.keys ?? '{}')

  document.getElementById('policy-form')?.dispatchEvent(new window.Event('submit', { cancelable: true, bubbles: true }))

  // The derivation is genuinely asynchronous PBKDF2, so the test waits for the status line to settle.
  const status = document.getElementById('status')!
  for (let attempt = 0; attempt < 400 && status.textContent === ''; attempt += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 10) })
  }
  // One more turn for the blob read.
  await new Promise((resolve) => { setTimeout(resolve, 10) })

  window.HTMLAnchorElement.prototype.click = originalClick
  dom.window.close()

  const text = downloads[0]?.text
  return {
    policy: text ? JSON.parse(text) as unknown : null,
    message: status.textContent ?? '',
    downloads,
  }
}

describe('the licence policy page', () => {
  it('produces a policy file the application itself accepts', async () => {
    const { downloads, message } = await generate({ years: '3', url: 'https://licences.example.com' })
    expect(message).toMatch(/Policy generated/iu)
    expect(downloads).toHaveLength(1)
    // The name matters: the customer's import dialog filters on `.iflpolicy`.
    expect(downloads[0]!.name).toBe('infoflex-vendor-policy.iflpolicy')

    // The real parser, not a shape check of my own.
    const policy = parseVendorPolicyFile(downloads[0]!.text)
    expect(policy.format).toBe('infoflex-vendor-license-policy')
    expect(policy.masterPasswordHash.algorithm).toBe('PBKDF2-SHA256')
    expect(policy.masterPasswordHash.iterations).toBe(310_000)
    expect(policy.maximumOnsitePeriodYears).toBe(3)
    expect(policy.licenseServerUrl).toBe('https://licences.example.com')
    expect(policy.trustedEd25519Keys).toEqual({})
  })

  it('never puts the password in the file, only a salted hash of it', async () => {
    const password = 'CorrectHorseBatteryStaple'
    const { downloads } = await generate({ password })
    const text = downloads[0]!.text
    expect(text).not.toContain(password)
    const policy = parseVendorPolicyFile(text)
    // A fresh salt each time: the same password produces a different hash, so two shops sharing a password do not
    // share a hash either.
    const second = await generate({ password })
    expect(parseVendorPolicyFile(second.downloads[0]!.text).masterPasswordHash.salt)
      .not.toBe(policy.masterPasswordHash.salt)
  })

  it('treats a blank term as no cap rather than as zero', async () => {
    const { downloads } = await generate({ years: '' })
    expect(parseVendorPolicyFile(downloads[0]!.text).maximumOnsitePeriodYears).toBeNull()
  })

  it('offers exactly the range the application will enforce', async () => {
    const html = readFileSync(PAGE, 'utf8')
    // The list is populated by the page's own script, so it has to run for this to mean anything.
    const dom = new JSDOM(html, { runScripts: 'dangerously' })
    const options = [...dom.window.document.querySelectorAll<HTMLOptionElement>('#max-years option')]
    // One blank "no configured maximum" option, then one per permitted year.
    expect(options[0]?.value).toBe('')
    const years = options.slice(1).map((option) => Number(option.value))
    expect(years[0]).toBe(1)
    expect(years.at(-1)).toBe(MAX_CONFIGURABLE_PERIOD_YEARS)
    expect(years).toHaveLength(MAX_CONFIGURABLE_PERIOD_YEARS)
    // Nothing in between is missing: a gap would be a cap the vendor cannot express.
    expect(years).toEqual(Array.from({ length: MAX_CONFIGURABLE_PERIOD_YEARS }, (_, index) => index + 1))
  })

  it('refuses a short password, a mismatch, and a plain-http address away from the local mock', async () => {
    expect((await generate({ password: 'short' })).message).toMatch(/at least 12 characters/iu)
    expect((await generate({ password: 'a-long-password-here', confirmation: 'a-different-password' })).message)
      .toMatch(/do not match/iu)
    expect((await generate({ url: 'http://licences.example.com' })).message).toMatch(/HTTPS/iu)
    // The local development mock is the documented exception.
    const local = await generate({ url: 'http://localhost:4310' })
    expect(local.message).toMatch(/Policy generated/iu)
  })

  it('refuses an address carrying credentials, a query or a fragment', async () => {
    for (const url of [
      'https://user:pass@licences.example.com',
      'https://licences.example.com/?a=1',
      'https://licences.example.com/#x',
    ]) {
      expect((await generate({ url })).message, url).toMatch(/credentials, query, or fragment/iu)
    }
  })

  it('refuses public keys that are not a JSON object', async () => {
    expect((await generate({ keys: '["not","an","object"]' })).message).toMatch(/JSON object/iu)
    expect((await generate({ keys: 'not json' })).message).toBeTruthy()
  })

  it('carries a real trusted Ed25519 key through unchanged, and only the public half', async () => {
    // A real key pair, because the app validates what it is given: a made-up PEM is refused, which is the correct
    // behaviour and was how this test first failed.
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const { downloads } = await generate({ keys: JSON.stringify({ 'vendor-key-2026': pem }) })
    const policy = parseVendorPolicyFile(downloads[0]!.text)
    expect(policy.trustedEd25519Keys['vendor-key-2026']).toBe(pem)
    // The private half must never be in the file, whatever was on screen.
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    expect(downloads[0]!.text).not.toContain(privatePem)
    expect(downloads[0]!.text).not.toContain('BEGIN PRIVATE KEY')
  })

  it('refuses a key that is not a usable Ed25519 public key', async () => {
    // The page accepts any JSON object of strings; the app is what refuses rubbish. This pins that division, so a
    // vendor cannot produce a file their own desktop will not open.
    const { downloads } = await generate({ keys: JSON.stringify({ bad: 'not a key' }) })
    expect(downloads[0]!.text).toContain('not a key')
    expect(() => parseVendorPolicyFile(downloads[0]!.text)).toThrow(/could not be read/iu)
  })

  it('makes no network call and uses no browser storage', async () => {
    // The page's whole promise to a vendor. Asserted on the source, because a stray `fetch` or `localStorage` would
    // be invisible until it mattered.
    const html = readFileSync(PAGE, 'utf8')
    expect(html).not.toMatch(/\bfetch\s*\(/u)
    expect(html).not.toMatch(/XMLHttpRequest/u)
    // Matched as calls rather than words: the page's own reassurances ("does not use localStorage...") contain them.
    expect(html).not.toMatch(/\b(?:localStorage|sessionStorage|indexedDB)\s*[.[]/u)
    expect(html).not.toMatch(/\bwindow\.(?:localStorage|sessionStorage|indexedDB)\b/u)
    expect(html).not.toMatch(/document\.cookie/u)
    // And no external resource of any kind: it must work with the network unplugged.
    expect(html).not.toMatch(/<(?:script|link)[^>]+(?:src|href)="(?:https?:)?\/\//u)
  })

  it('clears both password fields after it succeeds or fails', async () => {
    const dom = new JSDOM(readFileSync(PAGE, 'utf8'), { runScripts: 'dangerously', url: 'file:///policy.html' })
    const { window } = dom
    Object.defineProperty(window, 'crypto', { value: globalThis.crypto, configurable: true })
    Object.defineProperty(window.URL, 'createObjectURL', { value: () => 'blob:1', configurable: true })
    Object.defineProperty(window.URL, 'revokeObjectURL', { value: () => {}, configurable: true })
    window.HTMLAnchorElement.prototype.click = () => {}

    const password = window.document.getElementById('master-password') as HTMLInputElement
    const confirmation = window.document.getElementById('confirm-password') as HTMLInputElement
    password.value = 'a-long-vendor-password'
    confirmation.value = 'a-long-vendor-password'
    window.document.getElementById('policy-form')?.dispatchEvent(new window.Event('submit', { cancelable: true }))

    const status = window.document.getElementById('status')!
    for (let attempt = 0; attempt < 400 && status.textContent === ''; attempt += 1) {
      await new Promise((resolve) => { setTimeout(resolve, 10) })
    }
    expect(password.value).toBe('')
    expect(confirmation.value).toBe('')
    dom.window.close()
  })
})
