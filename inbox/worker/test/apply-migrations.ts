// Past de D1-migratie toe vóór elke test (op de basis-storage; isolatedStorage
// stackt de test-writes daarbovenop en rollt ze daarna terug).
import { applyD1Migrations, env } from 'cloudflare:test'

// TEST_MIGRATIONS wordt in vitest.config.ts als binding meegegeven.
await applyD1Migrations(env.DB, (env as unknown as { TEST_MIGRATIONS: unknown[] }).TEST_MIGRATIONS)
