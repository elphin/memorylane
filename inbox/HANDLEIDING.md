# MemoryLane Onderweg — wat jij moet doen

De complete stap-voor-stap om de mobiele brievenbus live te zetten: de cloud-kant
(Cloudflare Worker + de telefoon-PWA) en daarna het koppelen + importeren op de
desktop. Alles draait op je **eigen Cloudflare-account** (verwachte kosten:
€0/maand). De code + tests zijn klaar; dit zijn de stappen die alleen jij kunt
doen (inloggen is interactief).

De Worker serveert óók de telefoon-app: één URL doet zowel de API (`/api/*`) als
de PWA (de rest). Werk in `inbox/`.

## Voordat je begint
- **Node.js 20+** (`node -v`).
- Een **Cloudflare-account** (gratis, heb je al). Geen creditcard nodig.
- Wat je aan het eind hebt: één URL zoals
  `https://memorylane-inbox.<jouw-account>.workers.dev` die zowel de brievenbus-API
  draait als de telefoon-app serveert. Die URL + een invite-code vul je in de
  desktop-app in bij Instellingen → Telefoon.
- **Tijd:** ~15–20 minuten, eenmalig.

---

## Stap 0 — R2 API-sleutels maken (in het dashboard)
1. **Cloudflare-dashboard → R2 → "Manage R2 API Tokens" → Create API token**.
2. Rechten: **Object Read & Write** (mag beperkt tot bucket `memorylane-inbox`).
3. Noteer: **Access Key ID**, **Secret Access Key**, en je **Account ID**
   (rechtsboven in het R2-overzicht). Die drie heb je bij stap 6 nodig.

## Stap 1 — de telefoon-app (PWA) bouwen
De Worker uploadt deze build mee. Bouwen (eenmalig, en opnieuw na een PWA-wijziging):
```bash
cd inbox/pwa
npm install
npm run build          # maakt inbox/pwa/dist/ (die de Worker serveert)
```

## Stap 2 — Worker: installeren + inloggen
```bash
cd ../worker           # vanuit inbox/pwa; of: cd inbox/worker
npm install
npx wrangler login     # opent je browser; tip: typ  ! npx wrangler login  in Claude
```

## Stap 3 — D1-database aanmaken → id invullen
```bash
npx wrangler d1 create memorylane-inbox
```
→ Kopieer de getoonde **database_id** in `wrangler.jsonc` op de plek
`REPLACE_ME_NA_D1_CREATE`.

## Stap 4 — R2-bucket aanmaken
```bash
npx wrangler r2 bucket create memorylane-inbox
```

## Stap 5 — database-tabellen aanmaken (migratie)
```bash
npm run migrate:remote
```

## Stap 6 — geheimen zetten (nooit in de code)
Verzin zelf één lange willekeurige **invite-code** (bewaar 'm in je
wachtwoordmanager — die beschermt tegen vreemden die een brievenbus claimen).
```bash
npx wrangler secret put INVITE_CODE            # jouw lange random string
npx wrangler secret put R2_ACCESS_KEY_ID       # uit stap 0
npx wrangler secret put R2_SECRET_ACCESS_KEY   # uit stap 0
npx wrangler secret put R2_ACCOUNT_ID          # uit stap 0
```

## Stap 7 — publiceren (Worker + PWA samen)
Zorg dat `inbox/pwa/dist/` bestaat (stap 1), dan:
```bash
npm run deploy
```
→ Noteer je URL, bijv. `https://memorylane-inbox.<jouw-account>.workers.dev`.

## Stap 8 — CORS + opruimregel op de bucket
1. Zet in `cors.json` bij `REPLACE_ME_INBOX_ORIGIN` je URL uit stap 7 (alleen de
   origin, dus `https://memorylane-inbox.<...>.workers.dev`).
2. ```bash
   npx wrangler r2 bucket cors put memorylane-inbox --file cors.json
   npx wrangler r2 bucket lifecycle add memorylane-inbox --prefix mb/ --expire-days 35
   ```
   (Heet `cors put` bij jouw wrangler-versie `cors set`? Check `npx wrangler r2 bucket cors --help`.)

---

## Controleren dat de cloud-kant werkt
- Open je URL in de browser → je ziet de **telefoon-app** (MemoryLane Onderweg,
  het koppel-scherm).
- Open `…/api/health` → `{"ok":true,...}`.
- Tabellen bestaan:
  ```bash
  npx wrangler d1 execute memorylane-inbox --remote --command "SELECT name FROM sqlite_master WHERE type='table'"
  ```

## Stap 9 — telefoon koppelen (op de desktop)
1. Open MemoryLane (desktop) → **Instellingen (⚙) → tab Telefoon**.
2. Vul je **Server-URL** (uit stap 7) en je **Invite-code** (uit stap 6) in →
   **Koppel telefoon**.
3. Er verschijnt een **QR-code**. Scan 'm met de **camera-app** van je telefoon →
   open de melding → de telefoon-app opent en koppelt zichzelf. Zet 'm op je
   beginscherm ("Deel → Zet op beginscherm").

## Stap 10 — gebruiken
- **Telefoon:** maak onderweg een memory (titel, datum, verhaal, foto's) → verstuur.
  Alles wordt end-to-end versleuteld; de server ziet nooit je inhoud.
- **Desktop:** Instellingen → Telefoon → **Importeer openstaande memories**. De
  memories landen als events onder het juiste jaar, gemarkeerd **"in aanbouw"**.
  Na een geslaagde import wist de server zijn kopie.

---

## Later (nieuwe versie uitrollen)
```bash
cd inbox/pwa && npm run build      # als de PWA is gewijzigd
cd ../worker && npm run deploy      # nieuwe Worker + PWA publiceren
npm run migrate:remote             # alleen als er een nieuwe migratie bij is
```

## Config-knop: opslaglimiet
In `wrangler.jsonc` staat `MAILBOX_LIMIT_GIB: "8"` (strikt gratis). Ruimer? Zet 'm
op `"20"` en `npm run deploy`. De 30-dagen-opruiming begrenst de kosten.
