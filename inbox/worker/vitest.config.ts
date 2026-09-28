import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'
import path from 'node:path'

// Draait de tests in workerd (Miniflare) met echte lokale D1/R2-bindings. De
// D1-migratie wordt vóór elke test toegepast (setupFiles).
export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'))
  return {
    plugins: [
      cloudflareTest({
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
      }),
    ],
    test: {
      setupFiles: ['./test/apply-migrations.ts'],
    },
  }
})
