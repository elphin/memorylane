// Memory-endpoints (§5.5): aankondigen (presign PUT), complete (list-verificatie),
// lijst/count/urls (owner), ack + delete. Autorisatie-invariant: elk `:id`-endpoint
// checkt dat de memory bij de geauthenticeerde mailbox hoort.

import { Hono } from 'hono'
import type { Env } from './config'
import { LIMITS, mailboxLimitBytes } from './config'
import { authMailbox, underRateLimit } from './auth'
import { fail } from './http'
import { isUuid, memoryPrefix, nowIso, objKey } from './util'
import { presignGet, presignPut } from './presign'
import { deletePrefix, listSizes } from './r2'
import type { CreateMemoryBody } from './api-types'

export const memories = new Hono<{ Bindings: Env }>()

type Status = 'uploading' | 'ready' | 'imported'

const intOk = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n)

// POST /api/memories — memory aankondigen. Idempotent (resume). Presign PUT-URLs.
memories.post('/', async (c) => {
  const mailboxId = await authMailbox(c, 'upload')
  const now = Date.now()
  if (!(await underRateLimit(c.env, `create:${mailboxId}`, 86400, 100, now))) {
    fail(429, 'rate_limited', 'Te veel memories vandaag.')
  }
  const body = await c.req.json<CreateMemoryBody>().catch(() => null)
  if (!body || !isUuid(body.memoryId) || !Array.isArray(body.files) || !intOk(body.envelopeBytes)) {
    fail(400, 'bad_request', 'Ongeldige memory-aankondiging.')
  }
  const { memoryId, files, envelopeBytes } = body

  // ---- Limieten (§5.6). Een memory MAG 0 media hebben (alleen titel+datum+note);
  // dan is er enkel de envelope. ----
  if (files.length > LIMITS.maxFilesPerMemory) fail(413, 'too_many_files', `Max ${LIMITS.maxFilesPerMemory} bestanden per memory.`)
  const seen = new Set<string>()
  for (const f of files) {
    if (!f || !isUuid(f.fileId) || !intOk(f.bytes) || f.bytes <= 0 || f.bytes > LIMITS.maxBytesPerFile) {
      fail(413, 'bad_file', 'Een bestand is te groot of ongeldig.')
    }
    if (seen.has(f.fileId)) fail(400, 'dup_file', 'Dubbele fileId.')
    seen.add(f.fileId)
  }
  if (envelopeBytes <= 0 || envelopeBytes > LIMITS.maxEnvelopeBytes) fail(413, 'bad_envelope', 'Envelope te groot.')
  const total = envelopeBytes + files.reduce((s, f) => s + f.bytes, 0)
  if (total > LIMITS.maxBytesPerMemory) fail(413, 'memory_too_big', 'Deze memory is te groot voor de brievenbus.')

  const existing = await c.env.DB.prepare(
    'SELECT status FROM memories WHERE mailbox_id = ?1 AND id = ?2',
  )
    .bind(mailboxId, memoryId)
    .first<{ status: Status }>()

  if (existing) {
    // Idempotent: nog uploading → verse URLs voor de resterende bestanden; anders 409.
    if (existing.status !== 'uploading') {
      fail(409, 'already_finalized', 'Deze memory is al afgerond.')
    }
  } else {
    // Mailbox-quotum (openstaand = uploading+ready).
    const agg = await c.env.DB.prepare(
      "SELECT COALESCE(SUM(total_bytes), 0) AS s FROM memories WHERE mailbox_id = ?1 AND status IN ('uploading','ready')",
    )
      .bind(mailboxId)
      .first<{ s: number }>()
    if ((agg?.s ?? 0) + total > mailboxLimitBytes(c.env)) {
      fail(413, 'mailbox_full', 'De brievenbus zit vol — importeer eerst thuis.')
    }
    // Memory + file-rijen (envelope + media) atomair aanmaken.
    const rows = [{ fileId: 'envelope', bytes: envelopeBytes }, ...files]
    const stmts = [
      c.env.DB.prepare(
        'INSERT INTO memories (id, mailbox_id, status, file_count, total_bytes, created_at) VALUES (?1,?2,?3,?4,?5,?6)',
      ).bind(memoryId, mailboxId, 'uploading', files.length, total, nowIso(now)),
      ...rows.map((r) =>
        c.env.DB.prepare(
          'INSERT INTO files (memory_id, mailbox_id, id, r2_key, declared_bytes, uploaded) VALUES (?1,?2,?3,?4,?5,0)',
        ).bind(memoryId, mailboxId, r.fileId, objKey(mailboxId, memoryId, r.fileId), r.bytes),
      ),
    ]
    await c.env.DB.batch(stmts)
  }

  // Presign PUT voor de nog-niet-geüploade bestanden (resume slaat de rest over).
  const pending = await c.env.DB.prepare(
    'SELECT id, r2_key FROM files WHERE mailbox_id = ?1 AND memory_id = ?2 AND uploaded = 0',
  )
    .bind(mailboxId, memoryId)
    .all<{ id: string; r2_key: string }>()
  const uploadUrls: Record<string, string> = {}
  for (const r of pending.results) uploadUrls[r.id] = await presignPut(c.env, r.r2_key)
  return c.json({ uploadUrls })
})

// POST /api/memories/:id/complete — verifieer via één list; alles correct → ready.
memories.post('/:id/complete', async (c) => {
  const mailboxId = await authMailbox(c, 'upload')
  const memoryId = c.req.param('id')
  if (!isUuid(memoryId)) fail(400, 'bad_request', 'Ongeldige memoryId.')
  const mem = await c.env.DB.prepare('SELECT status FROM memories WHERE mailbox_id = ?1 AND id = ?2')
    .bind(mailboxId, memoryId)
    .first<{ status: Status }>()
  if (!mem) fail(404, 'not_found', 'Onbekende memory.')
  if (mem.status === 'ready') return c.json({ status: 'ready' }) // idempotent
  if (mem.status === 'imported') fail(409, 'already_imported', 'Al geïmporteerd.')

  const fileRows = await c.env.DB.prepare(
    'SELECT id, r2_key, declared_bytes FROM files WHERE mailbox_id = ?1 AND memory_id = ?2',
  )
    .bind(mailboxId, memoryId)
    .all<{ id: string; r2_key: string; declared_bytes: number }>()

  const sizes = await listSizes(c.env, memoryPrefix(mailboxId, memoryId))
  const missing: string[] = []
  const present: string[] = []
  for (const f of fileRows.results) {
    if (sizes.get(f.r2_key) === f.declared_bytes) present.push(f.id)
    else missing.push(f.id)
  }

  if (missing.length === 0) {
    await c.env.DB.batch([
      c.env.DB.prepare(
        "UPDATE memories SET status = 'ready', ready_at = ?3 WHERE mailbox_id = ?1 AND id = ?2",
      ).bind(mailboxId, memoryId, nowIso()),
      c.env.DB.prepare('UPDATE files SET uploaded = 1 WHERE mailbox_id = ?1 AND memory_id = ?2').bind(
        mailboxId,
        memoryId,
      ),
    ])
    return c.json({ status: 'ready' })
  }

  // Markeer de wél-correcte bestanden als geüpload, zodat de idempotente create
  // alleen de ontbrekende opnieuw presignt.
  if (present.length > 0) {
    const placeholders = present.map((_, i) => `?${i + 3}`).join(',')
    await c.env.DB.prepare(
      `UPDATE files SET uploaded = 1 WHERE mailbox_id = ?1 AND memory_id = ?2 AND id IN (${placeholders})`,
    )
      .bind(mailboxId, memoryId, ...present)
      .run()
  }
  return c.json({ error: { code: 'incomplete', message: 'Nog niet alle bestanden staan correct in R2.' }, missing }, 409)
})

// GET /api/memories?status=ready — owner. Lijst klaarstaande memories (zonder URLs).
memories.get('/', async (c) => {
  const mailboxId = await authMailbox(c, 'owner')
  requireReadyStatus(c.req.query('status'))
  const rows = await c.env.DB.prepare(
    "SELECT id, file_count, total_bytes, created_at FROM memories WHERE mailbox_id = ?1 AND status = 'ready' ORDER BY created_at",
  )
    .bind(mailboxId)
    .all<{ id: string; file_count: number; total_bytes: number; created_at: string }>()
  return c.json(
    rows.results.map((r) => ({
      memoryId: r.id,
      fileCount: r.file_count,
      totalBytes: r.total_bytes,
      createdAt: r.created_at,
    })),
  )
})

// GET /api/memories/count?status=ready — owner. Goedkoop pollen voor de badge.
memories.get('/count', async (c) => {
  const mailboxId = await authMailbox(c, 'owner')
  requireReadyStatus(c.req.query('status'))
  const row = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM memories WHERE mailbox_id = ?1 AND status = 'ready'",
  )
    .bind(mailboxId)
    .first<{ n: number }>()
  return c.json({ count: row?.n ?? 0 })
})

// GET /api/memories/:id/urls — owner. Verse presigned GET-URLs voor één memory.
memories.get('/:id/urls', async (c) => {
  const mailboxId = await authMailbox(c, 'owner')
  const memoryId = c.req.param('id')
  if (!isUuid(memoryId)) fail(400, 'bad_request', 'Ongeldige memoryId.')
  const mem = await c.env.DB.prepare('SELECT status FROM memories WHERE mailbox_id = ?1 AND id = ?2')
    .bind(mailboxId, memoryId)
    .first<{ status: Status }>()
  if (!mem || mem.status !== 'ready') fail(404, 'not_ready', 'Memory niet klaar voor download.')
  const fileRows = await c.env.DB.prepare(
    'SELECT id, r2_key FROM files WHERE mailbox_id = ?1 AND memory_id = ?2',
  )
    .bind(mailboxId, memoryId)
    .all<{ id: string; r2_key: string }>()
  const urls: Record<string, string> = {}
  for (const f of fileRows.results) urls[f.id] = await presignGet(c.env, f.r2_key)
  return c.json(urls)
})

// POST /api/memories/:id/ack — owner. Import gelukt: R2 weg, D1-rij → imported (tombstone).
memories.post('/:id/ack', async (c) => {
  const mailboxId = await authMailbox(c, 'owner')
  const memoryId = c.req.param('id')
  if (!isUuid(memoryId)) fail(400, 'bad_request', 'Ongeldige memoryId.')
  const mem = await c.env.DB.prepare('SELECT status FROM memories WHERE mailbox_id = ?1 AND id = ?2')
    .bind(mailboxId, memoryId)
    .first<{ status: Status }>()
  if (!mem) fail(404, 'not_found', 'Onbekende memory.')
  if (mem.status === 'imported') return c.json({ ok: true }) // idempotent

  // Eerst R2 (gratis DeleteObject), dan D1 (§11): files weg, memory → tombstone.
  await deletePrefix(c.env, memoryPrefix(mailboxId, memoryId))
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM files WHERE mailbox_id = ?1 AND memory_id = ?2').bind(mailboxId, memoryId),
    c.env.DB.prepare(
      "UPDATE memories SET status = 'imported', imported_at = ?3 WHERE mailbox_id = ?1 AND id = ?2",
    ).bind(mailboxId, memoryId, nowIso()),
  ])
  return c.json({ ok: true })
})

// DELETE /api/memories/:id — upload of owner. Intrekken vóór import.
memories.delete('/:id', async (c) => {
  const mailboxId = await authMailbox(c, 'any')
  const memoryId = c.req.param('id')
  if (!isUuid(memoryId)) fail(400, 'bad_request', 'Ongeldige memoryId.')
  const mem = await c.env.DB.prepare('SELECT status FROM memories WHERE mailbox_id = ?1 AND id = ?2')
    .bind(mailboxId, memoryId)
    .first<{ status: Status }>()
  if (!mem) return c.json({ ok: true }) // niets te doen
  if (mem.status === 'imported') {
    // Tombstone: alleen de rij weg (R2 is al leeg).
    await c.env.DB.prepare('DELETE FROM memories WHERE mailbox_id = ?1 AND id = ?2').bind(mailboxId, memoryId).run()
    return c.json({ ok: true })
  }
  await deletePrefix(c.env, memoryPrefix(mailboxId, memoryId))
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM files WHERE mailbox_id = ?1 AND memory_id = ?2').bind(mailboxId, memoryId),
    c.env.DB.prepare('DELETE FROM memories WHERE mailbox_id = ?1 AND id = ?2').bind(mailboxId, memoryId),
  ])
  return c.json({ ok: true })
})

function requireReadyStatus(status: string | undefined): void {
  if (status !== undefined && status !== 'ready') fail(400, 'bad_status', 'Alleen status=ready wordt ondersteund.')
}
