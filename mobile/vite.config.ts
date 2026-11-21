import { resolve } from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  root: resolve('mobile'),
  publicDir: resolve('mobile/public'),
  base: '/',
  server: {
    host: '0.0.0.0',
    port: 5174,
    strictPort: true,
    allowedHosts: true,
  },
  build: {
    target: 'es2022',
    outDir: resolve('out/mobile'),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve('mobile/index.html'),
    },
  },
})
