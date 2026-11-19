import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@main': resolve('src/main'),
      '@renderer': resolve('src/renderer/src'),
    },
  },
  test: {
    environment: 'node',
    include: [
      'src/**/*.test.ts', 'src/**/*.test.tsx', 'mobile/src/**/*.test.ts',
      // The installer's rules are pure functions precisely so they can be tested without Windows.
      'installer/src/**/*.test.ts', 'cloud/tests/**/*.test.ts',
      // Build Studio's steps, prerequisite table and key handling are pure functions for the same reason.
      'buildstudio/src/**/*.test.ts',
      // The window itself: the HTML is loaded into a real DOM and driven through the preload bridge's stub.
      'buildstudio/*.test.ts',
      // The documents are checked against the tree: paths, npm scripts and the migration table.
      'docs/*.test.ts',
    ],
    clearMocks: true,
    // Host integration suites hash bcrypt passwords and run real SQLite/TLS work; several take 4-6s
    // on slower machines, which is too close to the 5s default and made parallel runs flake.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
