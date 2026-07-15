// MemoryLane Onderweg — Worker-entry: router + cron.
// De echte brievenbus-API (§5.5) leeft onder /api/*. Static assets (PWA) worden
// in fase 3 toegevoegd.

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

// Landingspagina (wordt in fase 3 vervangen door de PWA via static assets).
app.get('/', (c) =>
  c.html(
    `<!doctype html><html lang="nl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MemoryLane Onderweg</title>
<style>body{font-family:system-ui,sans-serif;background:#171412;color:#f2ece4;
display:grid;place-items:center;height:100vh;margin:0}main{text-align:center}
h1{font-weight:600}small{color:#a89c8e}</style></head>
<body><main><h1>MemoryLane&nbsp;Onderweg</h1>
<small>Brievenbus actief · v${VERSION}</small></main></body></html>`,
  ),
)

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
