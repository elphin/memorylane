# MemoryLane Onderweg — wat jij moet doen

Korte checklist om de brievenbus (de cloud-kant) live te zetten. Alles draait op
je **eigen Cloudflare-account** (verwachte kosten: €0/maand). De code + tests zijn
al klaar; dit zijn de stappen die alleen jij kunt doen (inloggen is interactief).

Werk in de map `inbox/worker/`. Commando's gebruiken `npx wrangler` (de meegeleverde
versie); een globaal geïnstalleerde `wrangler` mag ook.

---

## Stap 0 — eerst de R2 API-sleutels maken (in het dashboard)
1. Ga naar **Cloudflare-dashboard → R2 → "Manage R2 API Tokens" → Create API token**.
2. Rechten: **Object Read & Write**, bij voorkeur beperkt tot de bucket
   `memorylane-inbox` (die maak je zo aan — je kunt de token ook later beperken).
3. Noteer: **Access Key ID**, **Secret Access Key**, en je **Account ID**
   (staat rechtsboven in het R2-overzicht). Die drie heb je bij stap 5 nodig.

## Stap 1 — installeren + inloggen
```bash
cd inbox/worker
npm install
npx wrangler login        # opent je browser; tip: typ  ! npx wrangler login  in Claude
```

## Stap 2 — D1-database aanmaken → id invullen
```bash
npx wrangler d1 create memorylane-inbox
```
→ Kopieer de getoonde **database_id** in `wrangler.jsonc` op de plek
`REPLACE_ME_NA_D1_CREATE`.

## Stap 3 — R2-bucket aanmaken
```bash
npx wrangler r2 bucket create memorylane-inbox
```

## Stap 4 — database-tabellen aanmaken (migratie)
```bash
npm run migrate:remote
```

## Stap 5 — geheimen zetten (nooit in de code)
Je verzint zelf één lange willekeurige **invite-code** (bewaar 'm in je
wachtwoordmanager — hij beschermt tegen vreemden die een brievenbus claimen).
```bash
npx wrangler secret put INVITE_CODE            # jouw lange random string
npx wrangler secret put R2_ACCESS_KEY_ID       # uit stap 0
npx wrangler secret put R2_SECRET_ACCESS_KEY   # uit stap 0
npx wrangler secret put R2_ACCOUNT_ID          # uit stap 0
```

## Stap 6 — publiceren
```bash
npm run deploy
```
→ Noteer je URL, bijv. `https://memorylane-inbox.<jouw-account>.workers.dev`.

## Stap 7 — CORS + opruimregel op de bucket
1. Zet in `cors.json` bij `REPLACE_ME_INBOX_ORIGIN` je URL uit stap 6 (alleen de
   origin, dus `https://memorylane-inbox.<...>.workers.dev`).
2. ```bash
   npx wrangler r2 bucket cors put memorylane-inbox --file cors.json
   npx wrangler r2 bucket lifecycle add memorylane-inbox --prefix mb/ --expire-days 35
   ```
   (Heet `cors put` bij jouw wrangler-versie `cors set`? Check `npx wrangler r2 bucket cors --help`.)

---

## Klaar? Zo controleer je het
- Open je URL in de browser → je ziet de **"MemoryLane Onderweg"**-pagina.
- Open `…/api/health` → `{"ok":true,...}`.
- Tabellen bestaan:
  ```bash
  npx wrangler d1 execute memorylane-inbox --remote --command "SELECT name FROM sqlite_master WHERE type='table'"
  ```

## Later (bij een nieuwe versie)
```bash
npm run deploy                 # nieuwe code publiceren
npm run migrate:remote         # alleen als er een nieuwe migratie is bijgekomen
```

## Config-knop: opslaglimiet
In `wrangler.jsonc` staat `MAILBOX_LIMIT_GIB: "8"` (strikt gratis). Wil je ruimer:
zet 'm op `"20"` en `npm run deploy`. Meer is niet nodig.

---

*De telefoon-app (PWA) en de "Importeer"-knop op de desktop komen in de volgende
fases; die hebben deze brievenbus nodig, dus dit is de eerste stap. Je hoeft nu
nog niets met de telefoon te doen.*
