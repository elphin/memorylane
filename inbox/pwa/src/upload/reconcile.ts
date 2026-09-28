// Lokale outbox-status afstemmen op wat de brievenbus meldt (pure functies,
// zodat de regels los te testen zijn). De server is de bron van waarheid voor
// wat er klaarstaat; alleen wat hij niet (meer) kent leiden we zelf af.

import type { OutboxEntry } from '../store/db'
import type { RemoteOutbox } from '../api/client'

/** Moet gelijk blijven aan READY_RETENTION_DAYS in de Worker (config.ts). Alleen
 * een schatting voor als de server (nog) geen expiresAt heeft gemeld. */
export const READY_RETENTION_DAYS = 30
const DAY = 86400 * 1000

/** Wijziging voor één lokale rij, of `null` als er niets verandert.
 * `active` = er loopt op dit moment een upload voor deze memory in deze app. */
export function reconcile(local: OutboxEntry, remote: RemoteOutbox | undefined, active: boolean): Partial<OutboxEntry> | null {
  if (active) return null // de lopende upload schrijft zelf zijn status
  if (!remote) {
    // Server kent 'm niet (meer). 'ready' was bevestigd → nu weg (verlopen of
    // thuis verwijderd). 'uploading' zonder lopende upload → onderbroken.
    if (local.status === 'ready') return { status: 'gone' }
    if (local.status === 'uploading') return { status: 'failed' }
    return null
  }
  const patch: Partial<OutboxEntry> = {}
  if (remote.status === 'imported') {
    if (local.status !== 'imported') patch.status = 'imported'
  } else if (remote.status === 'ready') {
    if (local.status !== 'ready') patch.status = 'ready'
    if (remote.readyAt && remote.readyAt !== local.readyAt) patch.readyAt = remote.readyAt
    if (remote.expiresAt && remote.expiresAt !== local.expiresAt) patch.expiresAt = remote.expiresAt
  } else if (local.status === 'uploading' || local.status === 'ready' || local.status === 'gone') {
    // Server staat nog op 'uploading' maar hier loopt niets → onderbroken.
    patch.status = 'failed'
  }
  return Object.keys(patch).length > 0 ? patch : null
}

/** Verloopmoment van een klaarstaande memory (server-waarde, anders geschat). */
export function expiryOf(e: OutboxEntry): number {
  if (e.expiresAt) return Date.parse(e.expiresAt)
  return Date.parse(e.readyAt ?? e.createdAt) + READY_RETENTION_DAYS * DAY
}

/** Hele dagen tot het verloop (afgerond naar boven; ≤ 0 = verlopen). */
export function daysLeft(e: OutboxEntry, now = Date.now()): number {
  return Math.ceil((expiryOf(e) - now) / DAY)
}
