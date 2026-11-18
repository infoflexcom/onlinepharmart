import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const publicDirectory = resolve(process.cwd(), 'mobile/public')
const shell = readFileSync(resolve(process.cwd(), 'mobile/index.html'), 'utf8')
const manifest = JSON.parse(readFileSync(resolve(publicDirectory, 'manifest.webmanifest'), 'utf8')) as {
  name: string
  short_name: string
  start_url: string
  scope: string
  display: string
  background_color: string
  theme_color: string
  icons: Array<{ src: string; sizes: string; type: string; purpose: string }>
}

function pngSize(path: string): { width: number; height: number } {
  const header = readFileSync(path).subarray(0, 24)
  expect(header.subarray(1, 4).toString('ascii')).toBe('PNG')
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) }
}

describe('installed PWA shell contract', () => {
  it('declares a standalone manifest whose icons exist at the advertised sizes', () => {
    expect(manifest).toMatchObject({
      name: 'Infoflex Admin Mobile', short_name: 'Infoflex Admin',
      start_url: '/', scope: '/', display: 'standalone',
      background_color: '#17345f', theme_color: '#17345f',
    })
    expect(manifest.icons.length).toBeGreaterThanOrEqual(3)
    for (const icon of manifest.icons) {
      const path = resolve(publicDirectory, `.${icon.src}`)
      expect(existsSync(path), `${icon.src} must be bundled with the mobile app`).toBe(true)
      expect(icon.type).toBe('image/png')
      const [width, height] = icon.sizes.split('x').map(Number) as [number, number]
      expect(pngSize(path)).toEqual({ width, height })
    }
    // Android reserves a 40% safe zone for maskable icons; a plain "any" icon letterboxes on launchers.
    expect(manifest.icons.some((icon) => icon.purpose === 'maskable')).toBe(true)
    expect(manifest.icons.some((icon) => icon.purpose === 'any')).toBe(true)
  })

  it('carries the iOS home-screen metadata that the web manifest cannot supply', () => {
    // iOS ignores the manifest for icons and standalone display, so these tags decide whether the
    // phone opens the PWA in Safari chrome with a screenshot icon or as an installed Admin app.
    expect(shell).toContain('<link rel="manifest" href="/manifest.webmanifest" />')
    expect(shell).toMatch(/<link rel="apple-touch-icon" sizes="180x180" href="\/icons\/icon-180\.png" \/>/u)
    expect(shell).toContain('<meta name="apple-mobile-web-app-capable" content="yes" />')
    expect(shell).toContain('<meta name="mobile-web-app-capable" content="yes" />')
    expect(shell).toContain('<meta name="apple-mobile-web-app-title" content="Infoflex Admin" />')
    expect(shell).toContain('viewport-fit=cover')
    expect(pngSize(resolve(publicDirectory, 'icons/icon-180.png'))).toEqual({ width: 180, height: 180 })
  })
})
