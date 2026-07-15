import { env, SELF } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { sha256Hex } from '../src/auth'
import { memoryPrefix, objKey } from '../src/util'
import { runCron } from '../src/cron'

const BASE = 'https://inbox.test'
const INVITE = 'test-invite-code'

interface Mailbox {
  mailboxId: string
  ownerToken: string
  uploadToken: string
}

const j = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
const owner = (m: Mailbox) => ({ 'X-Mailbox': m.mailboxId, Authorization: `Bearer ${m.ownerToken}` })
const upload = (m: Mailbox) => ({ 'X-Mailbox': m.mailboxId, Authorization: `Bearer ${m.uploadToken}` })

async function register(): Promise<{ m: Mailbox; res: Response }> {
  const m: Mailbox = {
    mailboxId: crypto.randomUUID(),
    ownerToken: crypto.randomUUID() + crypto.randomUUID(),
    uploadToken: crypto.randomUUID() + crypto.randomUUID(),
  }
  const res = await SELF.fetch(`${BASE}/api/mailboxes`, {
    ...j({
      mailboxId: m.mailboxId,
      ownerTokenHash: await sha256Hex(m.ownerToken),
      uploadTokenHash: await sha256Hex(m.uploadToken),
    }),
    headers: { 'content-type': 'application/json', 'X-Invite-Code': INVITE },
  })
  return { m, res }
}

/** Legt de aangekondigde bestanden rechtstreeks in R2 (simuleert de presigned PUT). */
async function putObjects(m: Mailbox, memoryId: string, files: Record<string, number>): Promise<void> {
  for (const [fileId, bytes] of Object.entries(files)) {
    await env.BUCKET.put(objKey(m.mailboxId, memoryId, fileId), new Uint8Array(bytes))
  }
}

describe('health & registratie', () => {
  it('health', async () => {
    const res = await SELF.fetch(`${BASE}/api/health`)
    expect(res.status).toBe(200)
    expect(await res.json<{ ok: boolean }>()).toMatchObject({ ok: true })
  })

  it('verkeerde invite-code → 403', async () => {
    const res = await SELF.fetch(`${BASE}/api/mailboxes`, {
      ...j({ mailboxId: crypto.randomUUID(), ownerTokenHash: await sha256Hex('a'), uploadTokenHash: await sha256Hex('b') }),
      headers: { 'content-type': 'application/json', 'X-Invite-Code': 'fout' },
    })
    expect(res.status).toBe(403)
  })

  it('registreren + idempotent + conflict', async () => {
    const { m, res } = await register()
    expect(res.status).toBe(201)
    // Zelfde hashes → 200 (retry).
    const again = await SELF.fetch(`${BASE}/api/mailboxes`, {
      ...j({
        mailboxId: m.mailboxId,
        ownerTokenHash: await sha256Hex(m.ownerToken),
        uploadTokenHash: await sha256Hex(m.uploadToken),
      }),
      headers: { 'content-type': 'application/json', 'X-Invite-Code': INVITE },
    })
    expect(again.status).toBe(200)
    // Afwijkende hashes → 409.
    const conflict = await SELF.fetch(`${BASE}/api/mailboxes`, {
      ...j({ mailboxId: m.mailboxId, ownerTokenHash: await sha256Hex('x'), uploadTokenHash: await sha256Hex('y') }),
      headers: { 'content-type': 'application/json', 'X-Invite-Code': INVITE },
    })
    expect(conflict.status).toBe(409)
  })
})

describe('auth', () => {
  let m: Mailbox
  beforeEach(async () => {
    m = (await register()).m
  })

  it('ontbrekend/fout token → 401', async () => {
    expect((await SELF.fetch(`${BASE}/api/outbox`)).status).toBe(401)
    const bad = await SELF.fetch(`${BASE}/api/outbox`, {
      headers: { 'X-Mailbox': m.mailboxId, Authorization: 'Bearer wrong' },
    })
    expect(bad.status).toBe(401)
  })

  it('owner-endpoint met upload-token → 401', async () => {
    const res = await SELF.fetch(`${BASE}/api/memories?status=ready`, { headers: upload(m) })
    expect(res.status).toBe(401)
  })

  it('upload-token op outbox → 200', async () => {
    const res = await SELF.fetch(`${BASE}/api/outbox`, { headers: upload(m) })
    expect(res.status).toBe(200)
  })
})

describe('create → complete → list → urls → ack', () => {
  let m: Mailbox
  beforeEach(async () => {
    m = (await register()).m
  })

  it('volledige gelukkige lus', async () => {
    const memoryId = crypto.randomUUID()
    const fileId = crypto.randomUUID()
    const create = await SELF.fetch(`${BASE}/api/memories`, {
      ...j({ memoryId, files: [{ fileId, bytes: 200 }], envelopeBytes: 100 }),
      headers: { 'content-type': 'application/json', ...upload(m) },
    })
    expect(create.status).toBe(200)
    const { uploadUrls } = await create.json<{ uploadUrls: Record<string, string> }>()
    expect(Object.keys(uploadUrls).sort()).toEqual([fileId, 'envelope'].sort())
    expect(uploadUrls.envelope).toContain('X-Amz-Signature')

    await putObjects(m, memoryId, { envelope: 100, [fileId]: 200 })

    const complete = await SELF.fetch(`${BASE}/api/memories/${memoryId}/complete`, {
      method: 'POST',
      headers: upload(m),
    })
    expect(complete.status).toBe(200)
    expect(await complete.json<{ status: string }>()).toEqual({ status: 'ready' })

    const list = await SELF.fetch(`${BASE}/api/memories?status=ready`, { headers: owner(m) })
    const items = await list.json<{ memoryId: string; fileCount: number; totalBytes: number }[]>()
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ memoryId, fileCount: 1, totalBytes: 300 })

    const count = await SELF.fetch(`${BASE}/api/memories/count?status=ready`, { headers: owner(m) })
    expect(await count.json<{ count: number }>()).toEqual({ count: 1 })

    const urls = await SELF.fetch(`${BASE}/api/memories/${memoryId}/urls`, { headers: owner(m) })
    const urlMap = await urls.json<Record<string, string>>()
    expect(Object.keys(urlMap).sort()).toEqual([fileId, 'envelope'].sort())

    const ack = await SELF.fetch(`${BASE}/api/memories/${memoryId}/ack`, { method: 'POST', headers: owner(m) })
    expect(ack.status).toBe(200)
    // R2 leeg + count 0 + outbox toont imported.
    expect((await env.BUCKET.list({ prefix: memoryPrefix(m.mailboxId, memoryId) })).objects).toHaveLength(0)
    const count2 = await SELF.fetch(`${BASE}/api/memories/count?status=ready`, { headers: owner(m) })
    expect(await count2.json<{ count: number }>()).toEqual({ count: 0 })
    const outbox = await SELF.fetch(`${BASE}/api/outbox`, { headers: upload(m) })
    expect(await outbox.json<{ status: string }[]>()).toEqual([{ memoryId, status: 'imported', createdAt: expect.any(String) }])

    // Ack nogmaals → idempotent 200.
    const ack2 = await SELF.fetch(`${BASE}/api/memories/${memoryId}/ack`, { method: 'POST', headers: owner(m) })
    expect(ack2.status).toBe(200)
  })

  it('complete met ontbrekend bestand → 409, dan resume', async () => {
    const memoryId = crypto.randomUUID()
    const fA = crypto.randomUUID()
    const fB = crypto.randomUUID()
    await SELF.fetch(`${BASE}/api/memories`, {
      ...j({ memoryId, files: [{ fileId: fA, bytes: 50 }, { fileId: fB, bytes: 60 }], envelopeBytes: 40 }),
      headers: { 'content-type': 'application/json', ...upload(m) },
    })
    // Alleen envelope + fA plaatsen (fB ontbreekt).
    await putObjects(m, memoryId, { envelope: 40, [fA]: 50 })
    const c1 = await SELF.fetch(`${BASE}/api/memories/${memoryId}/complete`, { method: 'POST', headers: upload(m) })
    expect(c1.status).toBe(409)
    const body = await c1.json<{ missing: string[] }>()
    expect(body.missing).toEqual([fB])

    // Idempotente create → presignt alleen het ontbrekende bestand.
    const recreate = await SELF.fetch(`${BASE}/api/memories`, {
      ...j({ memoryId, files: [{ fileId: fA, bytes: 50 }, { fileId: fB, bytes: 60 }], envelopeBytes: 40 }),
      headers: { 'content-type': 'application/json', ...upload(m) },
    })
    const { uploadUrls } = await recreate.json<{ uploadUrls: Record<string, string> }>()
    expect(Object.keys(uploadUrls)).toEqual([fB])

    await putObjects(m, memoryId, { [fB]: 60 })
    const c2 = await SELF.fetch(`${BASE}/api/memories/${memoryId}/complete`, { method: 'POST', headers: upload(m) })
    expect(c2.status).toBe(200)
  })

  it('afwijkende grootte → 409', async () => {
    const memoryId = crypto.randomUUID()
    const fileId = crypto.randomUUID()
    await SELF.fetch(`${BASE}/api/memories`, {
      ...j({ memoryId, files: [{ fileId, bytes: 200 }], envelopeBytes: 100 }),
      headers: { 'content-type': 'application/json', ...upload(m) },
    })
    await putObjects(m, memoryId, { envelope: 100, [fileId]: 199 }) // 1 byte te weinig
    const res = await SELF.fetch(`${BASE}/api/memories/${memoryId}/complete`, { method: 'POST', headers: upload(m) })
    expect(res.status).toBe(409)
    expect((await res.json<{ missing: string[] }>()).missing).toEqual([fileId])
  })

  it('memory zonder media (alleen envelope) mag', async () => {
    const memoryId = crypto.randomUUID()
    const create = await SELF.fetch(`${BASE}/api/memories`, {
      ...j({ memoryId, files: [], envelopeBytes: 80 }),
      headers: { 'content-type': 'application/json', ...upload(m) },
    })
    expect(create.status).toBe(200)
    await putObjects(m, memoryId, { envelope: 80 })
    const complete = await SELF.fetch(`${BASE}/api/memories/${memoryId}/complete`, { method: 'POST', headers: upload(m) })
    expect(complete.status).toBe(200)
  })
})

describe('limieten', () => {
  let m: Mailbox
  beforeEach(async () => {
    m = (await register()).m
  })
  const create = (files: unknown, envelopeBytes = 100) =>
    SELF.fetch(`${BASE}/api/memories`, {
      ...j({ memoryId: crypto.randomUUID(), files, envelopeBytes }),
      headers: { 'content-type': 'application/json', ...upload(m) },
    })

  it('te veel bestanden → 413', async () => {
    const files = Array.from({ length: 51 }, () => ({ fileId: crypto.randomUUID(), bytes: 10 }))
    expect((await create(files)).status).toBe(413)
  })
  it('bestand te groot → 413', async () => {
    expect((await create([{ fileId: crypto.randomUUID(), bytes: 3 * 1024 * 1024 * 1024 }])).status).toBe(413)
  })
  it('envelope te groot → 413', async () => {
    expect((await create([{ fileId: crypto.randomUUID(), bytes: 10 }], 2 * 1024 * 1024)).status).toBe(413)
  })
})

describe('autorisatie-isolatie', () => {
  it('mailbox B kan niets van mailbox A zien/acken', async () => {
    const a = (await register()).m
    const b = (await register()).m
    const memoryId = crypto.randomUUID()
    const fileId = crypto.randomUUID()
    await SELF.fetch(`${BASE}/api/memories`, {
      ...j({ memoryId, files: [{ fileId, bytes: 20 }], envelopeBytes: 30 }),
      headers: { 'content-type': 'application/json', ...upload(a) },
    })
    await putObjects(a, memoryId, { envelope: 30, [fileId]: 20 })
    await SELF.fetch(`${BASE}/api/memories/${memoryId}/complete`, { method: 'POST', headers: upload(a) })

    // B (ander mailbox) ziet 'm niet en kan niet acken.
    expect((await SELF.fetch(`${BASE}/api/memories/${memoryId}/urls`, { headers: owner(b) })).status).toBe(404)
    expect((await SELF.fetch(`${BASE}/api/memories/${memoryId}/ack`, { method: 'POST', headers: owner(b) })).status).toBe(404)
    const countB = await SELF.fetch(`${BASE}/api/memories/count?status=ready`, { headers: owner(b) })
    expect(await countB.json<{ count: number }>()).toEqual({ count: 0 })
    // A ziet 'm nog wel.
    const countA = await SELF.fetch(`${BASE}/api/memories/count?status=ready`, { headers: owner(a) })
    expect(await countA.json<{ count: number }>()).toEqual({ count: 1 })
  })
})

describe('mailbox verwijderen', () => {
  it('DELETE ruimt R2 + memories + files (geen orphans) en maakt het token dood', async () => {
    const m = (await register()).m
    const memoryId = crypto.randomUUID()
    const fileId = crypto.randomUUID()
    await SELF.fetch(`${BASE}/api/memories`, {
      ...j({ memoryId, files: [{ fileId, bytes: 20 }], envelopeBytes: 30 }),
      headers: { 'content-type': 'application/json', ...upload(m) },
    })
    await putObjects(m, memoryId, { envelope: 30, [fileId]: 20 })
    await SELF.fetch(`${BASE}/api/memories/${memoryId}/complete`, { method: 'POST', headers: upload(m) })

    const del = await SELF.fetch(`${BASE}/api/mailboxes`, { method: 'DELETE', headers: owner(m) })
    expect(del.status).toBe(200)

    const count = async (sql: string) =>
      (await env.DB.prepare(sql).bind(m.mailboxId).first<{ n: number }>())?.n
    expect(await count('SELECT COUNT(*) AS n FROM memories WHERE mailbox_id = ?1')).toBe(0)
    expect(await count('SELECT COUNT(*) AS n FROM files WHERE mailbox_id = ?1')).toBe(0)
    expect(await count('SELECT COUNT(*) AS n FROM mailboxes WHERE id = ?1')).toBe(0)
    expect((await env.BUCKET.list({ prefix: `mb/${m.mailboxId}/` })).objects).toHaveLength(0)
    expect((await SELF.fetch(`${BASE}/api/outbox`, { headers: upload(m) })).status).toBe(401)
  })
})

describe('cron-opruiming', () => {
  it('verlopen upload (>7d) wordt opgeruimd', async () => {
    const m = (await register()).m
    const memoryId = crypto.randomUUID()
    const fileId = crypto.randomUUID()
    await SELF.fetch(`${BASE}/api/memories`, {
      ...j({ memoryId, files: [{ fileId, bytes: 20 }], envelopeBytes: 30 }),
      headers: { 'content-type': 'application/json', ...upload(m) },
    })
    await putObjects(m, memoryId, { envelope: 30, [fileId]: 20 })

    // Cron 8 dagen in de toekomst → de nog-uploading memory is "verlopen".
    await runCron(env, Date.now() + 8 * 86400 * 1000)

    const outbox = await SELF.fetch(`${BASE}/api/outbox`, { headers: upload(m) })
    expect(await outbox.json<unknown[]>()).toEqual([])
    expect((await env.BUCKET.list({ prefix: memoryPrefix(m.mailboxId, memoryId) })).objects).toHaveLength(0)
  })
})
