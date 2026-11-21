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
