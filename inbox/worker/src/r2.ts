// R2-helpers via de bucket-binding (LIST/DELETE vanuit de Worker zelf). Up/down
// van bestanden gaat NIET hierlangs maar via presigned URLs (zie presign.ts).

import type { Env } from './config'

/** Verwijder alle objecten onder `prefix` in batches (DeleteObject is gratis,
 * max 1000 keys per call — binnen de subrequest-limiet). */
export async function deletePrefix(env: Env, prefix: string): Promise<void> {
  let cursor: string | undefined
  do {
    const listed = await env.BUCKET.list({ prefix, cursor, limit: 1000 })
    const keys = listed.objects.map((o) => o.key)
    if (keys.length > 0) await env.BUCKET.delete(keys)
    cursor = listed.truncated ? listed.cursor : undefined
  } while (cursor)
}

/** Alle objecten onder `prefix` als map key→size (één `list`-call reeks). Voor de
 * complete-verificatie (§5.5): vergelijk key + grootte tegen `declared_bytes`. */
export async function listSizes(env: Env, prefix: string): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  let cursor: string | undefined
  do {
    const listed = await env.BUCKET.list({ prefix, cursor, limit: 1000 })
    for (const o of listed.objects) out.set(o.key, o.size)
    cursor = listed.truncated ? listed.cursor : undefined
  } while (cursor)
  return out
}
