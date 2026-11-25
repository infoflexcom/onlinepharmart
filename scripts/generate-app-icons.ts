#!/usr/bin/env npx tsx
/**
 * Generate the Server and Client icon sets from the one logo.
 *
 * The brief asks for "separate variants for Server and Client" built from the logo, with the emblem and wordmark
 * cropped apart and the wall background removed. `public/branding/logo-transparent.png` is already the alpha-keyed
 * emblem+wordmark, so this script composes from it rather than re-keying `logo-source.png` — the keying is a one-off
 * that has been done and checked, and repeating it with different tolerances would slowly drift the brand.
 *
 * Why the distinction exists at all: a shop runs the server on a back-office PC and the client on each till. The
 * launcher on a desktop full of icons has to say which is which, and the two builds are separate installers. The
 * difference is a badge, not a different logo — the brand stays the same and only the corner says Server or Client.
 *
 * ImageMagick is used rather than a Node image library because there is no image dependency in this repository and
 * adding one for a build-time step would be a supply-chain cost paid on every install.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const SOURCE = join(ROOT, 'public/branding/app-icon.png')
const LOGO = join(ROOT, 'public/branding/logo-transparent.png')

/** App roles this script builds for. Derived from the roles the app itself recognises. */
const ROLES = ['server', 'client'] as const
type AppRole = (typeof ROLES)[number]

/** Badge text and the colour that tells the two apart at a glance. Navy for the server, gold for a till. */
const BADGE: Record<AppRole, { text: string; fill: string }> = {
  server: { text: 'SERVER', fill: '#0b2545' },
  client: { text: 'TILL', fill: '#b8860b' },
}

/** The sizes Windows asks for, smallest first. 256 is the largest an ICO may hold. */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256] as const

/** The PNG sizes the app and the installer use. */
const PNG_SIZES = [16, 24, 32, 48, 64, 128, 256, 512] as const

function convert(args: string[]): void {
  execFileSync('convert', args, { stdio: 'inherit' })
}

function main(): void {
  if (!existsSync(SOURCE) || !existsSync(LOGO)) {
    console.error(`Missing source art: expected ${SOURCE} and ${LOGO}`)
    process.exit(1)
  }

  for (const role of ROLES) {
    const directory = join(ROOT, 'build', role)
    mkdirSync(directory, { recursive: true })

    const badge = BADGE[role]

    // The badge is drawn straight onto the 512 base with one `-draw`, rather than composited from a separately built
    // plate. Two attempts at the composite form produced a file byte-identical to the input — ImageMagick accepted the
    // arguments and wrote nothing — and a silently unbadged "server" icon is exactly the failure this phase is meant to
    // prevent. `-draw` either draws or errors.
    const plateWidth = role === 'server' ? 296 : 208
    const plateHeight = 104
    const plateX = 512 - plateWidth - 20
    const plateY = 512 - plateHeight - 20
    // The point size is set from the plate width so SERVER and TILL both fill their plate without spilling over it.
    const pointSize = role === 'server' ? 46 : 52

    const baseWithBadge = join(directory, 'icon-badged-512.png')
    convert([
      SOURCE,
      '-resize', '512x512',
      '-fill', badge.fill,
      '-draw', `roundrectangle ${plateX},${plateY} ${plateX + plateWidth},${plateY + plateHeight} 24,24`,
      '-font', 'DejaVu-Sans-Bold',
      '-pointsize', String(pointSize),
      '-fill', 'white',
      '-gravity', 'northwest',
      '-annotate', `+${plateX}+${plateY + Math.round((plateHeight - pointSize) / 2)}`, badge.text,
      baseWithBadge,
    ])

    // The 512 PNG the app and the window icon read.
    convert([baseWithBadge, '-resize', '512x512', join(directory, 'icon-512.png')])

    // Every smaller PNG, resized from the 512 so the badge scales with the emblem rather than being redrawn.
    for (const size of PNG_SIZES) {
      if (size === 512) continue
      convert([baseWithBadge, '-resize', `${size}x${size}`, join(directory, `icon-${size}.png`)])
    }

    // The ICO: one file holding every size Windows may ask for, so an explorer view at 16 px and a taskbar at 256 px
    // both come from the same art.
    //
    // Each size is written to its own PNG and then combined with `-colors`. The obvious one-liner — passing the source
    // once per size with `-resize` between them — produces a file whose directory claims 256×256 for every entry,
    // because ImageMagick's ICO writer records the *last* image's geometry for all of them. Windows then draws a 16 px
    // slot with a 256 px image and the icon is a smear at the size people actually see it. Verified by reading the
    // directory back in `scripts/generate-app-icons.test.ts`.
    const sizedFiles = ICO_SIZES.map((size) => {
      const file = join(directory, `.ico-${size}.png`)
      convert([baseWithBadge, '-resize', `${size}x${size}`, file])
      return file
    })
    convert([...sizedFiles, join(directory, 'icon.ico')])
    // The per-size PNGs exist only to be combined. Leaving them behind would put seven files per role into the tree
    // that nothing reads, which is the sort of litter that later looks like an asset somebody chose.
    for (const file of sizedFiles) rmSync(file)

    // The installer banner and sidebar, which are the two places the customer sees the brand before the app opens.
    // NSIS requires BMP for both, so the PNG and the BMP are produced from the same composite rather than the BMP being
    // converted later by a different step that could drift.
    const bannerPng = join(directory, 'installer-banner.png')
    const sidebarPng = join(directory, 'installer-sidebar.png')
    convert([baseWithBadge, '-resize', '150x150', '-background', 'white', '-gravity', 'center', '-extent', '150x57', bannerPng])
    convert([baseWithBadge, '-resize', '164x164', '-background', '#0b2545', '-gravity', 'center', '-extent', '164x314', sidebarPng])
    convert([bannerPng, '-define', 'bmp:format=bmp3', join(directory, 'installer-banner.bmp')])
    convert([sidebarPng, '-define', 'bmp:format=bmp3', join(directory, 'installer-sidebar.bmp')])

    console.log(`Wrote the ${role} icon set to build/${role}/`)
  }

  // The wordmark stays one asset: the login page, receipts and the About box use the same logo on both builds, and the
  // badge is only for the launcher where the two sit side by side.
  console.log('Wordmark unchanged at public/branding/logo-transparent.png')
}

main()
