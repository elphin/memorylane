# MemoryLane Onderweg — Worker (fase 0–1)

Cloudflare Worker die de brievenbus-API (§5.5) serveert (en straks in fase 3 ook de
PWA via static assets). Losstaand van de root-app (eigen `package.json`, geen
koppeling met de Vite-build).

## Wat zit erin
- `wrangler.jsonc` — Worker-config: D1-binding `DB`, R2-binding `BUCKET`, dagelijkse
  cron, `nodejs_compat`, en de config-var `MAILBOX_LIMIT_GIB` (zie *Config-knoppen*).
- `migrations/0001_init.sql` — D1-schema (mailboxes, memories, files, rate_limits).
- `src/` — Hono-app + alle endpoints (§5.5): `index.ts` (router + cron + hello/health),
  `mailboxes.ts`, `memories.ts`, `auth.ts` (timing-safe token-hash + rate-limit),
  `presign.ts` (aws4fetch presigned R2-URLs), `r2.ts`, `cron.ts`, `config.ts`
  (`Env` + limieten §5.6), `util.ts`, `http.ts`, `api-types.ts`.
- `test/api.test.ts` — 15 integratietests (Miniflare + echte lokale D1/R2): auth,
  registratie-idempotentie, de create→complete→ack-lus, het 409-resume-pad,
  limieten, autorisatie-isolatie en cron. `npm run test`.
- `cors.json` — R2-bucket CORS (nodig voor browser-PUT/GET vanuit de PWA).

> **Toolchain-noot:** de dev-deps zijn gepind op **wrangler 3.114 + vitest-pool-workers
> 0.5** (die combinatie heeft een werkende test-integratie; wrangler 4 + de nieuwe
> vitest-pool-workers waren tijdelijk incompatibel). De `wrangler.jsonc` en de deploy
> werken óók met een globaal geïnstalleerde wrangler 4 als je dat liever gebruikt.

## Config-knoppen
- **Mailbox-opslaglimiet:** `vars.MAILBOX_LIMIT_GIB` in `wrangler.jsonc`. Standaard
  `"8"` (strikt binnen de R2-free-tier → €0). Zet op `"20"` voor ruimer (kán een
  paar cent/maand kosten; de 30-dagen-opruiming begrenst het). Eén regel wijzigen
  + `npm run deploy`.

## Eenmalige setup (jij, met je eigen Cloudflare-account)
`wrangler login` opent een browser — draai 'm zelf (bijv. via `! wrangler login`).

```bash
cd inbox/worker
npm install
wrangler login

# 1) D1-database aanmaken → kopieer de database_id naar wrangler.jsonc (REPLACE_ME_NA_D1_CREATE)
wrangler d1 create memorylane-inbox

# 2) R2-bucket aanmaken
wrangler r2 bucket create memorylane-inbox

# 3) Migratie toepassen (remote)
npm run migrate:remote

# 4) Secrets zetten (worden nooit in de repo bewaard)
wrangler secret put INVITE_CODE            # lange random string; bewaar in je wachtwoordmanager
wrangler secret put R2_ACCESS_KEY_ID       # R2 API-token (Object Read & Write, alleen deze bucket)
wrangler secret put R2_SECRET_ACCESS_KEY
wrangler secret put R2_ACCOUNT_ID          # je Cloudflare account-id

# 5) Deployen (hello world) → noteer de URL: https://memorylane-inbox.<account>.workers.dev
npm run deploy

# 6) CORS op de bucket: zet in cors.json de AllowedOrigins op je Worker-URL
#    (REPLACE_ME_INBOX_ORIGIN), dan:
wrangler r2 bucket cors put memorylane-inbox --file cors.json
#    (subcommand kan per wrangler-versie set/put heten — check `wrangler r2 bucket cors --help`)

# 7) Lifecycle-regel: R2-objecten onder prefix mb/ na 35 dagen verwijderen (vangnet)
wrangler r2 bucket lifecycle add memorylane-inbox --prefix mb/ --expire-days 35
```

## Acceptatie fase 0
- `https://memorylane-inbox.<account>.workers.dev/` toont de hello-pagina.
- `…/api/health` geeft `{"ok":true,...}`.
- D1-tabellen bestaan (`wrangler d1 execute memorylane-inbox --remote --command "SELECT name FROM sqlite_master WHERE type='table'"`).
- CORS + lifecycle zichtbaar in het Cloudflare-dashboard.

## Lokaal ontwikkelen / verifiëren (geen account nodig)
```bash
npm run typecheck   # tsc (src)
npm run test        # 15 integratietests in Miniflare (lokale D1/R2)
npm run check       # wrangler deploy --dry-run (bouwt de bundle, deployt niet)
npm run dev         # lokale Worker + Miniflare (D1/R2 lokaal)
```
