import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

// In CJS (tsup build), __dirname is a global. In ESM (tsx), it is undefined.
const dir = typeof __dirname === 'string' ? __dirname : '.'

export function getVersion(): string {
  // 1. env var (dev mode, set by dev.sh)
  if (process.env.CHRONICLE_VERSION) return process.env.CHRONICLE_VERSION
  // 2. VERSION_BUILD file next to dist/ (production build)
  try {
    const p = join(dir, '..', 'VERSION_BUILD')
    if (existsSync(p)) return readFileSync(p, 'utf-8').trim()
  } catch {}
  // 3. fallback
  return 'v0.0.0-dev'
}
