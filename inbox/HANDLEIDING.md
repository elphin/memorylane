# MemoryLane Onderweg — Cloudflare instellen, rustig stap voor stap

Deze gids gaat ervan uit dat je Cloudflare nog niet kent. Neem 'm letterlijk;
alles staat erin.

---

## Lees dit eerst: waar doe je wat?

Er zijn maar **twee plekken**, en je springt ertussen:

- 🖥️ **Terminal op je eigen pc** — voor álle `npm`- en `npx wrangler`-commando's.
  Zo open je 'm: in **Cursor** bovenin **Terminal → New Terminal**. Onderin opent een
  venster; dat staat automatisch in de projectmap `K:\cursor\memorylane`. Daar typ je
  de commando's (elke regel, dan Enter). **Dit doe je NOOIT op de Cloudflare-website.**

- 🌐 **Cloudflare-website** (`dash.cloudflare.com`) in je browser — alleen voor een
  paar muisklikken: één API-token maken en je Account-ID kopiëren.

**Test even of je terminal werkt:** typ `node -v` en Enter. Zie je zoiets als
`v20.x` of hoger? Top, ga door. Zie je een foutmelding? Installeer eerst Node.js 20+
van nodejs.org en herstart Cursor.

### Wat maak je eigenlijk (in gewone taal)
- Een **bucket** (R2) = de kluis waar de versleutelde foto's tijdelijk in staan.
- Een **database** (D1) = een klein logboekje: welke memories staan klaar.
- Een **Worker** = het programmaatje in de cloud dat de telefoon + desktop bedient
  én de telefoon-app serveert.
- **Secrets** = wachtwoorden die veilig bij Cloudflare staan (niet in de code).

Verwachte kosten: **€0/maand**. Duur: ~20 minuten, eenmalig.

---

## Stap 1 🖥️ — de telefoon-app bouwen
In de terminal (elke regel apart, met Enter):
```
cd K:\cursor\memorylane\inbox\pwa
npm install
npm run build
```
De eerste keer duurt `npm install` een minuutje. `npm run build` maakt een map
`dist` — die neemt de Worker straks vanzelf mee. Klaar als je "built" ziet.

## Stap 2 🖥️ — naar de Worker-map en inloggen bij Cloudflare
```
cd K:\cursor\memorylane\inbox\worker
npm install
npx wrangler login
```
De laatste regel opent je browser → klik op **Allow**. Daarna ben je ingelogd.
> Lukt de browser-login niet vanuit Cursor? Typ dan in het **Claude-invoerveld**
> (niet de terminal) `! npx wrangler login` — dan opent hij 'm voor je.

## Stap 3 🖥️ — de database aanmaken
```
npx wrangler d1 create memorylane-inbox
```
Je krijgt een blokje tekst terug met o.a. een regel `database_id = "……"`.
**Kopieer die lange id.** Die moet in één bestand:
- Open in Cursor het bestand `inbox/worker/wrangler.jsonc`.
- Zoek de tekst `REPLACE_ME_NA_D1_CREATE` en vervang die (tussen de aanhalings-
  tekens) door jouw database_id. Opslaan.
> Makkelijker: plak de teruggekregen `database_id` gewoon hier in de chat, dan zet
> ik 'm voor je in het bestand.

## Stap 4 🖥️ — de bucket (kluis) aanmaken
```
npx wrangler r2 bucket create memorylane-inbox
```

## Stap 5 🖥️ — de database-tabellen aanmaken
```
npm run migrate:remote
```

## Stap 6 🌐 — R2 API-token maken (de enige website-stap)
Dit levert drie waarden op die de Worker nodig heeft om upload-links te maken.

1. Ga naar **dash.cloudflare.com** → linker-sidebar **Storage & databases** →
   **R2 Object Storage**. Je komt op de **Overview**-pagina.
2. Rechts staat een blok **Account Details**. Daarin:
   - **kopieer je Account ID** (klik het kopieer-icoontje) — bewaar 'm even.
   - klik op **{ } Manage** naast **API Tokens** (soms heet het "Manage R2 API
     Tokens").
3. Klik op **Create API token** (of "Create Account API token").
4. Instellen:
   - **Naam**: bijv. `memorylane`.
   - **Permissions**: kies **Object Read & Write**.
   - **Buckets**: mag "All buckets" of specifiek `memorylane-inbox`.
5. Klik onderaan op **Create … API token**.
6. Nu toont Cloudflare **Access Key ID** en **Secret Access Key**.
   **Kopieer ze allebei meteen** — de Secret zie je maar één keer. Samen met het
   Account-ID uit punt 2 heb je nu drie waarden.

## Stap 7 🖥️ — de geheimen instellen
Verzin eerst zelf één lange willekeurige **invite-code** (bijv. via je wachtwoord-
manager, 20+ tekens; die houdt vreemden buiten je brievenbus). Bewaar 'm.

Voer daarna deze vier regels uit. Bij elke regel vraagt wrangler om de waarde te
plakken en Enter:
```
npx wrangler secret put INVITE_CODE
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
npx wrangler secret put R2_ACCOUNT_ID
```
- `INVITE_CODE` = jouw verzonnen code.
- `R2_ACCESS_KEY_ID` en `R2_SECRET_ACCESS_KEY` = uit stap 6.
- `R2_ACCOUNT_ID` = het Account-ID uit stap 6.

## Stap 8 🖥️ — publiceren (Worker + telefoon-app in één keer)
```
npm run deploy
```
Onderaan zie je je URL, bijvoorbeeld
`https://memorylane-inbox.<jouw-account>.workers.dev`. **Noteer die.**

## Stap 9 🖥️ — de kluis afstellen (CORS + auto-opruimen)
1. Open in Cursor `inbox/worker/cors.json` en vervang `REPLACE_ME_INBOX_ORIGIN`
   door je URL uit stap 8 (alleen `https://…workers.dev`, zonder pad erachter).
   Opslaan.
2. In de terminal:
   ```
   npx wrangler r2 bucket cors put memorylane-inbox --file cors.json
   npx wrangler r2 bucket lifecycle add memorylane-inbox --prefix mb/ --expire-days 35
   ```
   > Klaagt hij dat `cors put` niet bestaat? Probeer dan `cors set` i.p.v. `cors put`.

---

## Werkt het? Zo controleer je
- Open je URL (stap 8) in de browser → je ziet de **telefoon-app** (het koppel-scherm).
- Open je URL met `/api/health` erachter → je ziet `{"ok":true,...}`.

## Stap 10 — telefoon koppelen (in de desktop-app)
1. Open MemoryLane op de desktop → **Instellingen (⚙) → tab Telefoon**.
2. Vul je **Server-URL** (stap 8) en je **Invite-code** (stap 7) in →
   **Koppel telefoon**.
3. Er verschijnt een **QR-code**. Richt de **camera-app** van je telefoon erop →
   tik op de melding → de telefoon-app opent en koppelt zichzelf. Zet 'm op je
   beginscherm ("Deel → Zet op beginscherm").

## Stap 11 — gebruiken
- **Telefoon:** maak onderweg een memory (titel, datum, verhaal, foto's) → versturen.
  Alles is end-to-end versleuteld; de server ziet je inhoud nooit.
- **Desktop:** Instellingen → Telefoon → **Importeer openstaande memories**. Ze landen
  als events onder het juiste jaar, gemarkeerd **"in aanbouw"**. Na een geslaagde
  import wist de server zijn kopie.

---

## Later — een nieuwe versie uitrollen
```
cd K:\cursor\memorylane\inbox\pwa
npm run build
cd K:\cursor\memorylane\inbox\worker
npm run deploy
```
Alleen als er een nieuwe database-migratie bij is gekomen, ook: `npm run migrate:remote`.

## Knop: opslaglimiet
In `inbox/worker/wrangler.jsonc` staat `MAILBOX_LIMIT_GIB: "8"` (strikt gratis).
Ruimer? Zet 'm op `"20"` en `npm run deploy`. De 30-dagen-opruiming begrenst de kosten.
