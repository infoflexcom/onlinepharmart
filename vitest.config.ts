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
    ],
    clearMocks: true,
    // Host integration suites hash bcrypt passwords and run real SQLite/TLS work; several take 4-6s
    // on slower machines, which is too close to the 5s default and made parallel runs flake.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
