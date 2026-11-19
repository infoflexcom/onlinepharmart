import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { build } from 'esbuild'

/**
 * Builds the Build Studio window into `buildstudio/out`.
 *
 * Three outputs, all plain JavaScript, because the tool has to start on a vendor's Windows machine without a
 * toolchain of its own:
 *
 *   - `main.js`    — Electron's main process, bundled so `../installer/...` imports resolve.
 *   - `preload.js` — the bridge, bundled for the same reason and kept tiny.
 *   - `ui.js`      — the window's script, bundled from TypeScript so the DOM work is type-checked.
 *
 * `index.html` and `logo.png` are copied beside them. `nodeIntegration` is off and the window loads these files
 * from disk, so nothing here is ever fetched from a network.
 */

const out = join('buildstudio', 'out')

async function main(): Promise<void> {
  mkdirSync(out, { recursive: true })

  await build({
    entryPoints: { main: 'buildstudio/main.ts', preload: 'buildstudio/preload.ts', ui: 'buildstudio/ui.ts' },
    outdir: out,
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    sourcemap: false,
    // Electron and Node's own modules are provided by the runtime; everything else is bundled in.
    external: ['electron'],
    logLevel: 'warning',
  })

  copyFileSync(join('buildstudio', 'index.html'), join(out, 'index.html'))
  // The licence policy page is part of the tool but is opened in a browser, so it stays a plain standalone file.
  copyFileSync(join('buildstudio', 'policy.html'), join(out, 'policy.html'))
  // The brand logo already lives with the other brand assets; copying it here is what puts it beside the window.
  copyFileSync(join('public', 'branding', 'logo-transparent.png'), join(out, 'logo.png'))

  // A marker the packaging config and support calls can read to tell which build of the tool is installed.
  writeFileSync(join(out, 'build-studio.json'), `${JSON.stringify({ format: 'infoflex-build-studio-bundle', version: 1 }, null, 2)}\n`, 'utf8')

  console.log(`Build Studio written to ${out}.`)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
