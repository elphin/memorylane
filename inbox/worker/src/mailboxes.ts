// Mailbox-endpoints (§5.5): registreren, upload-token roteren, mailbox verwijderen.

import { Hono } from 'hono'
import type { Env } from './config'
import { authMailbox, timingSafeEqualStr, underRateLimit } from './auth'
import { fail } from './http'
import { isHex64, isUuid, nowIso } from './util'
import { deletePrefix } from './r2'
import type { RegisterMailboxBody, RotateUploadTokenBody } from './api-types'

export const mailboxes = new Hono<{ Bindings: Env }>()

// POST /api/mailboxes — registreren met invite-code. Idempotent.
mailboxes.post('/', async (c) => {
  const now = Date.now()
  const invite = c.req.header('X-Invite-Code') ?? ''
  // Timing-safe én rate-limited (registratie: max 10/dag totaal).
  if (!timingSafeEqualStr(invite, c.env.INVITE_CODE)) {
    fail(403, 'bad_invite', 'Ongeldige invite-code.')
  }
  if (!(await underRateLimit(c.env, 'register', 86400, 10, now))) {
    fail(429, 'rate_limited', 'Te veel registraties vandaag.')
  }
  const body = await c.req.json<RegisterMailboxBody>().catch(() => null)
  if (!body || !isUuid(body.mailboxId) || !isHex64(body.ownerTokenHash) || !isHex64(body.uploadTokenHash)) {
    fail(400, 'bad_request', 'Ongeldige mailbox-gegevens.')
  }
  const { mailboxId, ownerTokenHash, uploadTokenHash } = body

  const existing = await c.env.DB.prepare(
    'SELECT owner_token_hash, upload_token_hash FROM mailboxes WHERE id = ?1',
  )
    .bind(mailboxId)
    .first<{ owner_token_hash: string; upload_token_hash: string }>()
  if (existing) {
    // Idempotent: identieke hashes → 200 (retry); afwijkend → 409.
    if (
      timingSafeEqualStr(existing.owner_token_hash, ownerTokenHash) &&
      timingSafeEqualStr(existing.upload_token_hash, uploadTokenHash)
    ) {
      return c.json({ ok: true }, 200)
    }
    fail(409, 'mailbox_exists', 'Deze mailbox bestaat al met andere tokens.')
  }

  await c.env.DB.prepare(
    'INSERT INTO mailboxes (id, owner_token_hash, upload_token_hash, created_at) VALUES (?1, ?2, ?3, ?4)',
  )
    .bind(mailboxId, ownerTokenHash, uploadTokenHash, nowIso(now))
    .run()
  return c.json({ ok: true }, 201)
})

// POST /api/mailboxes/rotate-upload-token — owner. Oude telefoon vervalt.
mailboxes.post('/rotate-upload-token', async (c) => {
  const mailboxId = await authMailbox(c, 'owner')
  const body = await c.req.json<RotateUploadTokenBody>().catch(() => null)
  if (!body || !isHex64(body.uploadTokenHash)) fail(400, 'bad_request', 'Ongeldige token-hash.')
  await c.env.DB.prepare('UPDATE mailboxes SET upload_token_hash = ?1 WHERE id = ?2')
    .bind(body.uploadTokenHash, mailboxId)
    .run()
  return c.json({ ok: true })
})

// DELETE /api/mailboxes — owner. Mailbox + alle memories + alle R2-objecten weg.
mailboxes.delete('/', async (c) => {
  const mailboxId = await authMailbox(c, 'owner')
  // Eerst R2 (kan niet transactioneel met D1); daarna D1. NIET op CASCADE leunen:
  // D1 dwingt foreign keys niet standaard af, dus expliciet files → memories →
  // mailbox verwijderen (zoals overal elders).
  await deletePrefix(c.env, `mb/${mailboxId}/`)
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM files WHERE mailbox_id = ?1').bind(mailboxId),
    c.env.DB.prepare('DELETE FROM memories WHERE mailbox_id = ?1').bind(mailboxId),
    c.env.DB.prepare('DELETE FROM mailboxes WHERE id = ?1').bind(mailboxId),
  ])
  return c.json({ ok: true })
})
