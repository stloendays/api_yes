import { randomBytes } from 'node:crypto'
import type { Provider } from '@shared/types/common'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/** A cryptographically-random base62 string of length `n`. */
function rand(n: number): string {
  const bytes = randomBytes(n)
  let s = ''
  for (let i = 0; i < n; i++) s += ALPHABET[bytes[i] % ALPHABET.length]
  return s
}

/**
 * Generate a LOCAL proxy key styled to match the provider. These keys authenticate only to the
 * API-YES localhost gateway; upstream OAuth/API secrets are never exposed to clients.
 *   openai       → sk-proj-<48>
 *   anthropic    → sk-ant-api03-<86>AA
 *   antigravity  → agy-proxy-<48>
 */
export function generateProxyKey(provider: Provider): string {
  if (provider === 'anthropic') return `sk-ant-api03-${rand(86)}AA`
  if (provider === 'antigravity') return `agy-proxy-${rand(48)}`
  return `sk-proj-${rand(48)}`
}
