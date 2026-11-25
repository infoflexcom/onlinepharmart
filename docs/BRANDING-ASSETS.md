# Generated branding assets

The assets below were derived from `public/logo-source.png` using ImageMagick cropping, alpha-keying, resizing, and composition. The source image remains unchanged.

| Asset | Dimensions / format | Use |
| --- | --- | --- |
| `public/branding/logo-transparent.png` | Transparent PNG, trimmed wordmark | Login, setup, and shell branding |
| `public/branding/app-icon.png` | 512×512 PNG | Desktop/app icon source |
| `build/icon.ico` | Windows ICO with multiple sizes | Electron Builder Windows application icon |
| `public/branding/mobile-icon.png` | 192×192 PNG | Mobile icon preview |
| `mobile/assets/icon-192.png` | 192×192 PNG | Mobile launcher icon |
| `mobile/assets/icon-512.png` | 512×512 PNG | High-resolution mobile icon |
| `mobile/public/icons/icon-180.png` | 180×180 PNG | iOS `apple-touch-icon` for the installed Admin PWA |
| `mobile/public/icons/icon-maskable-512.png` | 512×512 PNG, padded safe zone | Android `purpose: maskable` launcher icon |
| `build/installer-banner.png` | 150×57 PNG | NSIS installer header banner |
| `build/installer-sidebar.png` | 164×314 PNG | NSIS installer and uninstaller sidebar |

Electron Builder references the ICO and NSIS artwork in `package.json`. Installer and mobile packaging flows themselves remain outside this phase.

## Server and Client variants

The product ships two installers, and the brief asks for a separate icon set for each. Both are generated from the same
logo and differ only by a badge in the lower right — the brand does not change between the back office and the till, only
the word that says which machine this is.

| Role | Badge | Colour |
| --- | --- | --- |
| Server | `SERVER` | Navy (`#0b2545`), matching the overlay on the login page |
| Client | `TILL` | Gold (`#b8860b`), the accent used on buttons and totals |

`TILL` rather than `CLIENT` on the badge: the person looking at the desktop is standing at a till, and the word they use
for that machine is the one that helps them.

Each set lives under `build/<role>/` and contains `icon.ico` (16, 24, 32, 48, 64, 128 and 256, produced this phase),
`icon-<size>.png` for the sizes the shell and the window ask for, `icon-512.png`, and the NSIS `installer-banner`
(150×57) and `installer-sidebar` (164×314) as both PNG and BMP3.

Regenerate with:

```text
npx tsx scripts/generate-app-icons.ts
```

The script is idempotent and never writes to `public/branding/app-icon.png`; `scripts/generate-app-icons.test.ts`
asserts that, and also asserts that the two sets differ from each other and from the unbadged source, because the first
version of the generator produced a file byte-identical to its input and every "does the file exist" check passed.

The two Electron Builder configurations are `electron-builder.server.json` and `electron-builder.client.json`. They are
copies of the `build` block in `package.json` with only the icon paths, the artifact name and the shortcut name changed;
`installer/src/app-role-configs.test.ts` fails if any other key drifts between them.

### Owed on real Windows

The icon sets have been generated and inspected here, and the ICO directory has been read back programmatically. What
has **not** been done is a Windows build that carries them: no installer has been built on Windows in this repository,
so "Windows Explorer draws the 16 px icon correctly" and "the taskbar shows the right badge" are unproven. They are on
`docs/RELEASE-CHECKLIST.md`.
