import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/setup.ts', 'src/cli.ts'],
  format: ['cjs'],
  minify: true,
  clean: true,
  external: ['better-sqlite3'],
  banner: { js: '#!/usr/bin/env node' },
})
