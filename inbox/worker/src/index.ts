// MemoryLane Onderweg — Worker-entry (router + cron).
// Fase 0: alleen een hello-pagina + health-check. De echte endpoints (§5.5)
// komen in fase 1; ze worden hier onder `/api/*` gemonteerd.

import { Hono } from 'hono'
import type { Env } from './config'

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

// Health-check (goedkoop, ongeauthenticeerd) — bevestigt dat de Worker leeft.
app.get('/api/health', (c) => c.json({ ok: true, service: 'memorylane-inbox', version: VERSION }))

// Nette 404 voor onbekende API-routes (echte endpoints volgen in fase 1).
app.all('/api/*', (c) =>
  c.json({ error: { code: 'not_found', message: 'Onbekend endpoint' } }, 404),
)

export default {
  fetch: app.fetch,

  // Dagelijkse opruiming (§5.7) — implementatie volgt in fase 1.
  async scheduled(_event: ScheduledController, _env: Env, _ctx: ExecutionContext): Promise<void> {
    // TODO(fase 1): verlopen uploads/ready/tombstones + rate_limits opruimen.
  },
} satisfies ExportedHandler<Env>
