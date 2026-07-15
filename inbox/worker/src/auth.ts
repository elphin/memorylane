// Authenticatie (§5.4): twee bearer-tokens per mailbox (owner/upload). De server
// bewaart alleen SHA-256(token) (hex) en vergelijkt CONSTANT-TIME. Plus simpele
// rate limiting in D1.

import type { Context } from 'hono'
import type { Env } from './config'
import { fail } from './http'

const enc = new TextEncoder()

/** hex(SHA-256(text)). */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Constant-time vergelijking van twee (gelijk-lange) strings. */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = enc.encode(a)
  const bb = enc.encode(b)
  if (ab.byteLength !== bb.byteLength) return false
  return crypto.subtle.timingSafeEqual(ab, bb)
}

/** Verhoog de teller voor `key` in het huidige venster en geef terug of we NOG
 * binnen `max` zitten. Vensters zijn vaste blokken van `windowSec` (UTC). */
export async function underRateLimit(
  env: Env,
  key: string,
  windowSec: number,
  max: number,
  now: number,
): Promise<boolean> {
  const windowStart = new Date(Math.floor(now / (windowSec * 1000)) * windowSec * 1000).toISOString()
  await env.DB.prepare(
    `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
     ON CONFLICT(key, window_start) DO UPDATE SET count = count + 1`,
  )
    .bind(key, windowStart)
    .run()
  const row = await env.DB.prepare(
    'SELECT count FROM rate_limits WHERE key = ?1 AND window_start = ?2',
  )
    .bind(key, windowStart)
    .first<{ count: number }>()
  return (row?.count ?? 0) <= max
}

const ipOf = (c: Context): string => c.req.header('CF-Connecting-IP') ?? 'unknown'

/** Verifieer de mailbox + het bearer-token voor de gevraagde rol. Geeft de
 * mailboxId terug of gooit 401. Mislukte pogingen tellen mee voor de auth-
 * rate-limit (per IP, 20/uur → 429). */
export async function authMailbox(
  c: Context<{ Bindings: Env }>,
  kind: 'owner' | 'upload' | 'any',
): Promise<string> {
  const env = c.env
  const now = Date.now()
  const mailboxId = c.req.header('X-Mailbox')
  const authz = c.req.header('Authorization')
  const bail = async (): Promise<never> => {
    // Mislukte auth rate-limiten (per IP). Overschrijding → 429.
    const ok = await underRateLimit(env, `auth:${ipOf(c)}`, 3600, 20, now)
    if (!ok) fail(429, 'rate_limited', 'Te veel mislukte pogingen — probeer het later opnieuw.')
    return fail(401, 'unauthorized', 'Ongeldige mailbox of token.')
  }
  if (!mailboxId || !authz || !authz.startsWith('Bearer ')) return bail()
  const token = authz.slice('Bearer '.length)

  const presented = await sha256Hex(token)
  const row = await env.DB.prepare(
    'SELECT owner_token_hash, upload_token_hash FROM mailboxes WHERE id = ?1',
  )
    .bind(mailboxId)
    .first<{ owner_token_hash: string; upload_token_hash: string }>()

  // Altijd hashen + BEIDE rollen constant-time vergelijken (ook zonder rij, tegen
  // een dummy-hash) → geen timing-lek over bestaan van de mailbox of over de rol.
  const DUMMY = '0'.repeat(64)
  const okOwner = timingSafeEqualStr(presented, row?.owner_token_hash ?? DUMMY)
  const okUpload = timingSafeEqualStr(presented, row?.upload_token_hash ?? DUMMY)
  const matched = kind === 'owner' ? okOwner : kind === 'upload' ? okUpload : okOwner || okUpload
  if (!row || !matched) return bail()

  // Laatst-gezien bijwerken (best-effort).
  await env.DB.prepare('UPDATE mailboxes SET last_seen_at = ?1 WHERE id = ?2')
    .bind(new Date(now).toISOString(), mailboxId)
    .run()
  return mailboxId
}
