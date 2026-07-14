// Worker-omgeving (bindings + secrets + vars) en de server-side limieten.

export interface Env {
  // Bindings (wrangler.jsonc)
  DB: D1Database
  BUCKET: R2Bucket
  // Config-var (wrangler.jsonc → vars)
  MAILBOX_LIMIT_GIB?: string
  // Secrets (wrangler secret put)
  INVITE_CODE: string
  R2_ACCESS_KEY_ID: string
  R2_SECRET_ACCESS_KEY: string
  R2_ACCOUNT_ID: string
}

const GiB = 1024 * 1024 * 1024
const MiB = 1024 * 1024

// Server-side afgedwongen limieten bij POST /api/memories (§5.6).
export const LIMITS = {
  maxFilesPerMemory: 50,
  maxBytesPerFile: 2 * GiB,
  maxBytesPerMemory: 4 * GiB,
  maxEnvelopeBytes: 1 * MiB,
} as const

// Max openstaande (uploading+ready) opslag per brievenbus. Standaard 8 GiB
// (strikt gratis); via de var `MAILBOX_LIMIT_GIB` in wrangler.jsonc om te zetten
// (bv. "20"). Zie §14 van het plan.
const DEFAULT_MAILBOX_LIMIT_GIB = 8

export function mailboxLimitBytes(env: Env): number {
  const n = Number(env.MAILBOX_LIMIT_GIB)
  const gib = Number.isFinite(n) && n > 0 ? n : DEFAULT_MAILBOX_LIMIT_GIB
  return gib * GiB
}
