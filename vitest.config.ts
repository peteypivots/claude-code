import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'url'
import { resolve } from 'path'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 30000,
  },
  resolve: {
    alias: [
      // The source uses baseUrl:"." in tsconfig so bare "src/..." imports resolve from root
      { find: /^src\//, replacement: resolve(__dirname, 'src') + '/' },
      // bun:bundle is a Bun bundler virtual module; redirect to the dev shim
      { find: 'bun:bundle', replacement: resolve(__dirname, 'src/shims/bun-bundle.ts') },
    ],
  },
})
