// Past de D1-migratie toe (idempotent) en zet vóór elke test de rate-limit-tellers
// op nul. Sinds vitest-pool-workers 0.9 is de opslag niet meer per test
// geïsoleerd; zonder dit lopen de tellers over tests heen op en krijgen latere
// tests een 429/401 die niets met hun eigen gedrag te maken heeft.
import { applyD1Migrations, env } from 'cloudflare:test'
import { beforeEach } from 'vitest'

// TEST_MIGRATIONS wordt in vitest.config.ts als binding meegegeven.
await applyD1Migrations(env.DB, (env as unknown as { TEST_MIGRATIONS: unknown[] }).TEST_MIGRATIONS)

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM rate_limits').run()
})
