// MemoryLane Onderweg — Worker-entry: router + cron.
// De brievenbus-API (§5.5) leeft onder /api/*; al het overige serveert de PWA
// via de ASSETS-binding (static assets + SPA-fallback), zodat /pair de app opent.

import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { Env } from './config'
import { ApiError } from './http'
import { authMailbox } from './auth'
import { mailboxes } from './mailboxes'
import { memories } from './memories'
import { runCron } from './cron'

const VERSION = '0.1.0'

const app = new Hono<{ Bindings: Env }>()

app.get('/api/health', (c) => c.json({ ok: true, service: 'memorylane-inbox', version: VERSION }))

app.route('/api/mailboxes', mailboxes)
app.route('/api/memories', memories)

// GET /api/outbox — upload. Voor de telefoon: staat-klaar vs. ✓-geïmporteerd.
app.get('/api/outbox', async (c) => {
  const mailboxId = await authMailbox(c, 'upload')
  const rows = await c.env.DB.prepare(
    'SELECT id, status, created_at FROM memories WHERE mailbox_id = ?1 ORDER BY created_at',
  )
    .bind(mailboxId)
    .all<{ id: string; status: string; created_at: string }>()
  return c.json(rows.results.map((r) => ({ memoryId: r.id, status: r.status, createdAt: r.created_at })))
})

// Nette 404 voor onbekende API-routes.
app.all('/api/*', (c) => c.json({ error: { code: 'not_found', message: 'Onbekend endpoint' } }, 404))

// Al het overige (een pad zonder eigen asset) → de PWA. Bestaande assets (/, JS,
// CSS, icon, manifest, sw) serveert Cloudflare zelf; hier serveren we index.html
// zodat een onbekend pad de app opent i.p.v. een 404 (SPA-fallback).
app.all('*', (c) => c.env.ASSETS.fetch(new URL('/', c.req.url).toString()))

// Uniforme foutvorm: ApiError → { error: { code, message } }; onbekend → 500.
app.onError((err, c) => {
  if (err instanceof ApiError) {
    return c.json({ error: { code: err.code, message: err.message } }, err.status as ContentfulStatusCode)
  }
  console.error('Onverwachte fout:', err)
  return c.json({ error: { code: 'internal', message: 'Interne serverfout.' } }, 500)
})

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCron(env))
  },
} satisfies ExportedHandler<Env>
