import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config'
import path from 'node:path'

// Draait de tests in workerd (Miniflare) met echte lokale D1/R2-bindings. De
// D1-migratie wordt vóór elke test toegepast (setupFiles).
export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'))
  return {
    test: {
      setupFiles: ['./test/apply-migrations.ts'],
      poolOptions: {
        workers: {
          wrangler: { configPath: './wrangler.jsonc' },
          miniflare: {
            // Migraties + test-secrets (in productie via `wrangler secret put`).
            bindings: {
              TEST_MIGRATIONS: migrations,
              INVITE_CODE: 'test-invite-code',
              R2_ACCESS_KEY_ID: 'test-access-key',
              R2_SECRET_ACCESS_KEY: 'test-secret-key',
              R2_ACCOUNT_ID: 'testaccount',
            },
          },
        },
      },
    },
  }
})
