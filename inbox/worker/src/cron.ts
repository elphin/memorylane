// Dagelijkse opruiming (§5.7). Bij lage volumes ruim binnen de subrequest-limiet;
// per verlopen memory eerst R2, dan de D1-rijen (§11).

import type { Env } from './config'
import { deletePrefix } from './r2'
import { memoryPrefix } from './util'

export async function runCron(env: Env, now = Date.now()): Promise<void> {
  const day = 86400 * 1000
  const cutUploading = new Date(now - 7 * day).toISOString() // verlopen uploads
  const cutReady = new Date(now - 30 * day).toISOString() // bewaartermijn ready + tombstones

  // 1+2) uploading > 7 dagen én ready > 30 dagen: R2-objecten + rijen weg.
  const stale = await env.DB.prepare(
    `SELECT mailbox_id, id FROM memories
       WHERE (status = 'uploading' AND created_at < ?1)
          OR (status = 'ready' AND ready_at < ?2)`,
  )
    .bind(cutUploading, cutReady)
    .all<{ mailbox_id: string; id: string }>()
  for (const m of stale.results) {
    await deletePrefix(env, memoryPrefix(m.mailbox_id, m.id))
    await env.DB.batch([
      env.DB.prepare('DELETE FROM files WHERE mailbox_id = ?1 AND memory_id = ?2').bind(m.mailbox_id, m.id),
      env.DB.prepare('DELETE FROM memories WHERE mailbox_id = ?1 AND id = ?2').bind(m.mailbox_id, m.id),
    ])
  }

  // 3) tombstones (imported) ouder dan 30 dagen → rij weg (R2 was al leeg).
  await env.DB.prepare("DELETE FROM memories WHERE status = 'imported' AND imported_at < ?1")
    .bind(cutReady)
    .run()

  // 4) oude rate-limit-vensters (> 2 dagen) opruimen.
  await env.DB.prepare('DELETE FROM rate_limits WHERE window_start < ?1')
    .bind(new Date(now - 2 * day).toISOString())
    .run()
}
