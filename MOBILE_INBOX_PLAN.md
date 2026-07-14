# MemoryLane Onderweg — Plan voor de mobiele memory-brievenbus

> **Status:** definitief plan, klaar voor implementatie.
> **Voor wie:** de developer die dit gaat bouwen. Dit document is zelfstandig leesbaar; alle
> relevante codebase-verwijzingen staan erin. Bij twijfel: de verwijzing in de code wint.
> **Taal:** UI-teksten in het Nederlands; code/comments in de stijl van de bestaande codebase
> (Nederlandse comments).

---

## 1. Doel & context

MemoryLane is een local-first desktop-app (Tauri 2 + React/PixiJS) waarin memories als mappen
met markdown + media in een "vault" op schijf staan. Memories toevoegen kan nu alleen achter
de desktop.

**Doel van dit project:** onderweg op je telefoon een memory vastleggen (titel, begindatum,
einddatum, verhaaltje, foto's, korte video's), die tijdelijk versleuteld in een cloud-brievenbus
parkeren, en thuis in de desktop-app met één knop **"Importeer openstaande memories"**
binnenhalen. Eenrichtingsverkeer: telefoon → server → desktop. Na succesvolle import wordt de
memory van de server verwijderd; als vangnet verdwijnt alles na 30 dagen automatisch.

**Harde eisen (besloten door de opdrachtgever):**

1. Primaire gebruiker zit op **iOS (iPhone)**; Android moet óók werken. Geen app-store-app:
   een **installeerbare PWA** is de telefoon-kant.
2. **End-to-end-encryptie vanaf dag 1.** De server ziet uitsluitend ciphertext; alleen telefoon
   en desktop kennen de sleutel.
3. Een geïmporteerde memory landt **direct als event onder het juiste jaar** (datum komt van de
   telefoon). Geen review-tussenstap.
4. Geïmporteerde memories krijgen standaard de nieuwe status **"in aanbouw"** (under
   construction), zodat de gebruiker ziet welke memories nog afgemaakt moeten worden.
5. Hosting op **Cloudflare** (account bestaat al; bucket e.d. worden voor dit project nieuw
   aangemaakt). Verwachte kosten: €0/maand (alles valt ruim binnen de free tiers).
6. De telefoon-UI moet **superieur gebruiksvriendelijk** zijn: één scherm, uitstekende
   formulier-elementen (met name de datumkiezer), mooi vormgegeven (typografie-spec in §6).

---

## 2. Architectuur in één beeld

```
┌─────────────┐   1. pairing (QR: token + sleutel)   ┌──────────────────┐
│  Desktop     │ ────────────────────────────────────▶│  Telefoon (PWA)   │
│  (Tauri)     │                                       │  "ML Onderweg"    │
└──────┬──────┘                                       └────────┬─────────┘
       │                                                        │ 2. metadata (versleuteld)
       │                                                        ▼
       │                                              ┌──────────────────┐
       │ 4. GET pending → download → decrypt          │ Cloudflare Worker │
       │    → vault-import → ACK (delete)             │  API + PWA-assets │
       └─────────────────────────────────────────────▶│        │          │
                                                      │   D1 (metadata)   │
                                                      │        │          │
                                                      └────────┼─────────┘
                                              3. bestanden direct via
                                                 presigned PUT (buiten
                                                 de Worker om)   │
                                                                 ▼
                                                      ┌──────────────────┐
                                                      │  R2 (ciphertext-  │
                                                      │  blobs, lifecycle │
                                                      │  30/35 dagen)     │
                                                      └──────────────────┘
```

Kernkeuzes en waarom:

- **Presigned R2-URLs** voor alle up- en downloads van bestanden. De telefoon PUT direct naar
  het R2 S3-endpoint (`<account>.r2.cloudflarestorage.com`), niet door de Worker heen. Dat
  omzeilt de 100 MB request-bodylimiet van het free zone-plan, kost geen Worker-CPU en geen
  dubbele bandbreedte. R2-egress is gratis, dus ook de desktop-download kost niets.
- **D1** (SQLite) voor de brievenbus-administratie: welke memories staan klaar, welke bestanden
  horen erbij, welke tokens zijn geldig. Gewone SQL-queries, strongly consistent.
- **E2EE**: elke blob (bestanden én metadata-envelope) is AES-256-GCM-ciphertext. De server
  kent alleen: mailbox-id, memory-id, aantal bestanden, groottes en tijdstempels. Geen titels,
  geen bestandsnamen, geen inhoud.
- **De desktop-import hergebruikt de bestaande vault-schrijflaag** (`writer::create_event` →
  `writer::create_text_item` → `import_media`, zie §9.2). Er komt géén tweede schrijfpad
  naar de vault.

---

## 3. Besluitenlog (vastgelegd, niet heropenen zonder overleg)

| # | Besluit | Rationale |
|---|---------|-----------|
| B1 | Cloudflare Workers + R2 + D1, presigned URLs | €0, geen serverbeheer, geen egress-kosten, lifecycle-regels ingebouwd |
| B2 | PWA als telefoon-app, geserveerd door dezelfde Worker (Static Assets) | Eén deploy, één domein, geen app-store |
| B3 | E2EE vanaf dag 1, sleutel via QR-fragment | Persoonlijke herinneringen op andermans cloud |
| B4 | Verwijdering: direct bij ACK ná succesvolle import; R2-lifecycle (35 d) + dagelijkse cron (30 d) als vangnet | "Weg zodra veilig binnen", nooit eeuwig blijven hangen |
| B5 | Geen accountsysteem; mailbox + twee tokens (owner/upload), registratie beveiligd met invite-code | Minimaal aanvalsoppervlak voor een handvol gebruikers |
| B6 | Import direct als event onder het juiste jaar, status "in aanbouw" aan | Wens opdrachtgever |
| B7 | Nieuwe code in dit repo onder `inbox/` (Worker + PWA) en `src-tauri/src/inbox/` (desktop) | Datacontract + crypto-formaat moeten in lockstep versioneren met de app |
| B8 | Rust doet HTTP + decrypt op de desktop (`reqwest`, `aes-gcm`, `hkdf`); de React-laag alleen UI | Bestanden landen op schijf; crypto naast de vault-writer houdt alles in één transactionele flow |

---

## 4. Repo-indeling

```
memorylane/
├── inbox/                        # NIEUW — cloud-kant (eigen package.json's, geen koppeling met de root-Vite-build)
│   ├── worker/                   # Cloudflare Worker (TypeScript, Hono)
│   │   ├── src/
│   │   │   ├── index.ts          # router + entry
│   │   │   ├── auth.ts           # token-hash-verificatie, rate limiting
│   │   │   ├── presign.ts        # aws4fetch presigned URLs
│   │   │   ├── memories.ts       # endpoints
│   │   │   ├── mailboxes.ts      # registratie/rotatie
│   │   │   └── cron.ts           # dagelijkse opruiming
│   │   ├── test/                 # vitest + @cloudflare/vitest-pool-workers
│   │   ├── migrations/           # D1-migraties (0001_init.sql, …)
│   │   └── wrangler.jsonc
│   ├── pwa/                      # Vite + React + TS (build-output → worker assets)
│   │   └── src/
│   │       ├── screens/          # Pair, NewMemory, Outbox, Settings
│   │       ├── components/       # DatePicker, MediaGrid, ProgressRing, …
│   │       ├── crypto/           # WebCrypto: HKDF + AES-GCM + blobformaat
│   │       ├── upload/           # queue, XHR-PUT met voortgang, retry
│   │       └── store/            # IndexedDB: pairing, concepten, outbox
│   └── shared/
│       ├── api-types.ts          # request/response-types (Worker + PWA importeren beide)
│       └── test-vectors/         # crypto-testvectoren (JSON) — zie §12
├── src-tauri/src/inbox/          # NIEUW — desktop-kant (Rust)
│   ├── mod.rs
│   ├── api.rs                    # reqwest-client voor de Worker-API
│   ├── crypto.rs                 # HKDF + AES-GCM decrypt (spiegel van pwa/crypto)
│   └── import.rs                 # download → decrypt → vault-import → ack
└── src/app/SettingsPhone.tsx        # NIEUW — pairing-UI + importknop (v2-frontend, zie §9.0)
```

---

## 5. Component A — Cloudflare Worker API

### 5.1 Stack

- **Runtime:** Cloudflare Workers (free plan volstaat; Paid $5/mnd is optioneel comfort).
- **Framework:** [Hono](https://hono.dev) (klein, TS-first, uitstekende Workers-support).
- **Presigning:** [`aws4fetch`](https://github.com/mhart/aws4fetch) met R2 S3-credentials
  (R2 API-token, als Worker-secrets). Let op: het native R2-*binding* kan géén presigned
  URLs maken; presignen gebeurt via het S3-protocol met `aws4fetch`, de bucket-binding wordt
  alleen gebruikt voor LIST/DELETE vanuit de Worker zelf (géén per-object HEAD — zie de
  subrequest-waarschuwing bij `complete` in §5.5).
- **Static assets:** de PWA-build wordt via de `assets`-configuratie van hetzelfde
  Worker-project geserveerd (routes onder `/api/*` gaan naar de Worker, de rest naar assets).

### 5.2 D1-schema (`migrations/0001_init.sql`)

```sql
CREATE TABLE mailboxes (
  id                TEXT PRIMARY KEY,             -- uuid, door desktop gegenereerd
  owner_token_hash  TEXT NOT NULL,                -- hex(SHA-256(token))
  upload_token_hash TEXT NOT NULL,
  created_at        TEXT NOT NULL,                -- ISO-8601 UTC
  last_seen_at      TEXT
);

CREATE TABLE memories (
  id           TEXT NOT NULL,                     -- uuid, door telefoon gegenereerd
  mailbox_id   TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  status       TEXT NOT NULL CHECK (status IN ('uploading','ready','imported')),
  file_count   INTEGER NOT NULL,
  total_bytes  INTEGER NOT NULL,                  -- som van declared_bytes (ciphertext)
  created_at   TEXT NOT NULL,
  ready_at     TEXT,
  imported_at  TEXT,
  PRIMARY KEY (mailbox_id, id)
);

CREATE TABLE files (
  memory_id      TEXT NOT NULL,
  mailbox_id     TEXT NOT NULL,
  id             TEXT NOT NULL,                   -- fileId (uuid) of het woord 'envelope'
  r2_key         TEXT NOT NULL,
  declared_bytes INTEGER NOT NULL,                -- ciphertext-grootte die de client aankondigt
  uploaded       INTEGER NOT NULL DEFAULT 0,      -- 1 zodra bevestigd via de list-verificatie bij complete
  PRIMARY KEY (mailbox_id, memory_id, id),
  FOREIGN KEY (mailbox_id, memory_id) REFERENCES memories(mailbox_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_memories_status ON memories(mailbox_id, status);
```

Alle queries via prepared statements (D1 `bind()`), nooit string-interpolatie.

### 5.3 R2-indeling

- Bucket: `memorylane-inbox` (nieuw aan te maken).
- Object-keys: `mb/{mailboxId}/{memoryId}/{fileId}.bin` en
  `mb/{mailboxId}/{memoryId}/envelope.bin`. Keys bevatten uitsluitend server-side gegenereerde
  of gevalideerde UUID's — nooit bestandsnamen van de gebruiker (die staan alléén versleuteld
  in de envelope). Daarmee is key-injectie uitgesloten.
- **Lifecycle-regels** (dashboard of `wrangler r2 bucket lifecycle`):
  1. prefix `mb/` → delete objects **35 dagen** na aanmaak (vangnet achter de cron);
  2. abort onvoltooide multipart-uploads na 7 dagen (hygiëne, ook al gebruiken we in v1 geen
     multipart).
- **CORS-configuratie op de bucket** (vereist voor browser-PUT/GET met presigned URLs):

```json
[
  {
    "AllowedOrigins": ["https://<inbox-domein>"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["content-type"],
    "MaxAgeSeconds": 3600
  }
]
```

De desktop (reqwest, geen browser) heeft geen CORS nodig; de PWA-origin wel.

### 5.4 Authenticatie & autorisatie

- Twee bearer-tokens per mailbox, beide 32 random bytes (CSPRNG), base64url-gecodeerd
  (43 tekens):
  - **owner-token** — desktop. Mag: pending listen, downloads presignen, ack'en, upload-token
    roteren, mailbox verwijderen.
  - **upload-token** — telefoon. Mag: memories aanmaken, uploads presignen, complete melden,
    eigen nog-niet-geïmporteerde memory verwijderen, eigen outbox-status opvragen.
- Headers: `X-Mailbox: <mailboxId>` + `Authorization: Bearer <token>`.
- De server bewaart **alleen `SHA-256(token)`** (hex). Verificatie: hash het aangeboden token
  en vergelijk **constant-time** (`crypto.subtle.timingSafeEqual` op de byte-arrays van beide
  hashes). Een gelekte D1-database geeft dus geen toegang.
- **Mailbox-registratie** is afgeschermd met een invite-code: Worker-secret `INVITE_CODE`
  (lange random string, door de beheerder gezet met `wrangler secret put`). Zo kan een
  willekeurige internetgebruiker geen opslag claimen.
- **Rate limiting** (simpel, in D1 of in-memory per isolate is onvoldoende → D1):
  - registratie: max 10/dag totaal;
  - mislukte auth: per IP max 20/uur → daarna 429;
  - memory-creatie: max 100/dag per mailbox.
  Implementatie: een klein `rate_limits`-tabelletje (key, window_start, count) met UPSERT.

### 5.5 Endpoints

Alle bodies JSON; alle responses JSON met nette foutobjecten
`{ "error": { "code": "…", "message": "…" } }`. Limieten worden server-side gevalideerd
(zie §5.6). Types staan in `inbox/shared/api-types.ts`.

| Methode & pad | Auth | Doel |
|---|---|---|
| `POST /api/mailboxes` | `X-Invite-Code` | Mailbox registreren. Body: `{ mailboxId, ownerTokenHash, uploadTokenHash }` (desktop genereert de tokens en stuurt alléén de hashes — tokens verlaten de desktop nooit richting server behalve als bearer bij later gebruik). **Idempotent:** bestaat het id al mét identieke hashes → 200 (retry na netwerkfout); bestaat het met afwijkende hashes → 409. De invite-code wordt net als tokens **timing-safe** vergeleken. |
| `POST /api/mailboxes/rotate-upload-token` | owner | Body: `{ uploadTokenHash }`. Oude telefoon-koppeling is per direct ongeldig. |
| `DELETE /api/mailboxes` | owner | Mailbox + alle memories + alle R2-objecten verwijderen (unpair alles). R2-objecten via `bucket.list` + batch-`delete` (max 1000 keys/call) i.v.m. de subrequest-limiet. |
| `POST /api/memories` | upload | Memory aankondigen. Body: `{ memoryId, files: [{ fileId, bytes }], envelopeBytes }`. Response: `{ uploadUrls: { envelope: url, [fileId]: url } }` (presigned PUT, 15 min geldig). **Idempotent:** bestaat `memoryId` al met status `uploading` voor deze mailbox, geef dan verse URLs voor de nog niet geüploade bestanden terug (hervatten na onderbreking); bestaat hij met status `ready`/`imported` → 409. |
| `POST /api/memories/:id/complete` | upload | Server verifieert de objecten met **één** `bucket.list({ prefix: "mb/{mb}/{memoryId}/" })` (geeft key + size per object in één call) en vergelijkt tegen `files.declared_bytes`. Alles aanwezig en exact de juiste grootte → status `ready`. Ontbreekt iets of wijkt een grootte af → 409 met de lijst afwijkende fileIds (client kan opnieuw presignen via `POST /api/memories`); voor de wél correct aanwezige bestanden zet complete op dit 409-pad `files.uploaded = 1`, zodat de idempotente create daarna alleen de ontbrekende bestanden opnieuw presignt. ⚠️ **Bewust geen per-object HEAD:** het Workers free plan staat max 50 subrequests per request toe (bindings tellen mee); met 50 bestanden + envelope + D1-queries knalt een HEAD-lus daar doorheen — in Miniflare werkt het dan wél en in productie niet. |
| `GET /api/memories?status=ready` | owner | Lijst klaarstaande memories, **zonder URLs**: `[{ memoryId, fileCount, totalBytes, createdAt }]`. |
| `GET /api/memories/:id/urls` | owner | Verse presigned GET-URLs voor precies één memory: `{ envelope: url, [fileId]: url }` (15 min). De desktop haalt deze **per memory, vlak vóór de download** op — zo verlopen URLs van latere memories niet terwijl eerdere grote video's nog binnenkomen. |
| `GET /api/memories/count?status=ready` | owner | Alleen `{ count }` — voor de desktop-badge, goedkoop pollen. |
| `POST /api/memories/:id/ack` | owner | Import gelukt: verwijder alle R2-objecten in één batch-call (`bucket.delete([keys])`, tot 1000 keys per call, DeleteObject is gratis), zet D1-rij op `imported` + `imported_at` (tombstone, zodat de telefoon-outbox "✓ geïmporteerd" kan tonen). Idempotent: nogmaals ack'en van een al-geïmporteerde memory → 200. |
| `DELETE /api/memories/:id` | upload of owner | Memory intrekken vóór import (telefoon: "verwijder uit outbox"). Verwijdert R2-objecten (batch-delete) + D1-rij. Op een `imported`-tombstone: verwijdert alleen de tombstone-rij → 200. |
| `GET /api/outbox` | upload | Voor de telefoon: `[{ memoryId, status, createdAt }]` — zodat de outbox "staat klaar" vs. "✓ geïmporteerd" kan tonen. |

**Autorisatie-invariant:** élk endpoint met `:id` verifieert dat de memory bij de
geauthenticeerde mailbox hoort (PK is `(mailbox_id, id)`); presigned URLs worden uitsluitend
uitgegeven voor keys onder `mb/{eigenMailboxId}/…`.

### 5.6 Limieten (server-side afgedwongen bij `POST /api/memories`)

| Limiet | Waarde | Reden |
|---|---|---|
| Max bestanden per memory | 50 | ruim boven realistisch gebruik |
| Max grootte per bestand | 2 GiB | één presigned PUT kan tot ~4,995 GiB; marge |
| Max totaal per memory | 4 GiB | |
| Max envelope | 1 MiB | metadata-JSON is klein |
| Max openstaande (`uploading`+`ready`) bytes per mailbox | 20 GiB | misbruik-rem; R2 free tier is 10 GB — zie §14 kostennoot |

Overschrijding → 413 met duidelijke foutcode; de PWA toont dit begrijpelijk.

### 5.7 Cron (dagelijks, Worker Cron Trigger)

1. `memories` met status `uploading` ouder dan 7 dagen → R2-objecten verwijderen, rij weg.
2. `memories` met status `ready` ouder dan **30 dagen** → R2-objecten verwijderen, rij weg
   (de afgesproken bewaartermijn; R2-lifecycle op 35 d is het vangnet als de cron faalt).
3. Tombstones (`imported`) ouder dan 30 dagen → rij weg.
4. `rate_limits`-vensters opruimen.

---

## 6. Component B — de PWA "MemoryLane Onderweg"

### 6.1 Uitgangspunten

- **Eén hoofdscherm.** Het nieuwe-memory-formulier ís de app. Geen navigatiedoolhof.
- **Nooit iets kwijtraken.** Elk veld wordt continu als concept opgeslagen in IndexedDB
  (debounced, ~300 ms). App weggeswiped in de trein? Alles staat er nog bij heropenen —
  inclusief de geselecteerde media (als File-referenties dat niet toelaten na herstart:
  bewaar de bytes van de gekozen bestanden in IndexedDB zodra ze gekozen zijn; zie 6.5).
- **iOS-realiteit:** Safari heeft geen Background Sync; de pagina moet open blijven tijdens
  de upload. De UI zegt dat eerlijk ("Houd de app open, nog ±40 s") en maakt het draaglijk met
  duidelijke voortgang. Web Share Target werkt **niet** op iOS (WebKit ondersteunt het anno
  juli 2026 nog steeds niet) — de ingang op iOS is het beginscherm-icoon; op Android komt er
  in fase 6 wél een `share_target`.
- **Installatie:** manifest met `display: standalone`, icoontjes, thema-kleur. Op de
  pairing-succespagina staat een korte geïllustreerde instructie "Zet op je beginscherm"
  (iOS: deelknop → 'Zet op beginscherm'; Android: install-prompt).
- **Service worker (verplicht):** app-shell-precache via `vite-plugin-pwa`, zodat de app
  óók zonder bereik opent — anders is de belofte "concept staat er nog bij heropenen"
  niets waard zodra je in de trein geen dekking hebt. Expliciet **géén** caching van
  `/api/*` of presigned R2-URLs (network-only). S2 krijgt een offline-state: banner
  "Geen verbinding — je concept wordt lokaal bewaard; versturen kan zodra je online bent"
  (verstuurknop disabled, al het invullen werkt gewoon).

### 6.2 Visueel ontwerp

Sfeer: een warm, papierachtig "memoir"-gevoel — dit is een app voor herinneringen, geen
CRUD-formulier. Rustig, veel witruimte, één accentkleur.

**Typografie**
- **Fraunces** (variable, Google Fonts, `opsz`-as aan) voor de app-titel, schermkoppen en het
  titel-invoerveld (de titel die je typt oogt meteen als de kop van je herinnering — klein
  detail, groot plezier).
- **Inter** voor alle overige UI (labels, knoppen, datums, meta).
- Basisgrootte **17 px** (nooit < 16 px in inputs — voorkomt iOS-autozoom), regelafstand 1,5.

**Kleuren**

| Token | Licht | Donker | Gebruik |
|---|---|---|---|
| `--bg` | `#FAF6F0` (warm papier) | `#171412` | achtergrond |
| `--surface` | `#FFFFFF` | `#211D1A` | kaarten, sheets |
| `--ink` | `#1F1B16` | `#F2ECE4` | tekst |
| `--ink-2` | `#6B6358` | `#A89C8E` | secundaire tekst |
| `--accent` | `#B4552D` (terracotta) | `#E08A5A` | knoppen, focus, selectie |
| `--accent-soft` | `#F3E3D3` | `#3A2E26` | geselecteerde datums, chips |
| `--success` | `#3E7C4F` | `#7FBF8E` | upload klaar |
| `--danger` | `#B3403A` | `#E07B76` | fouten, verwijderen |

Donkere modus volgt `prefers-color-scheme`, met handmatige override in Instellingen.

**Vorm & beweging:** 4 px-grid; aanraakdoelen ≥ 48×48 px; kaarten/sheets 16 px radius;
overgangen 150–200 ms ease-out; upload-voortgang als ring rond elke thumbnail. Geen confetti.

### 6.3 Schermen

**S1 — Pairing (eerste start / na ontkoppelen).**
De QR-scan op de desktop opent `https://<host>/pair#v=1&mb=…&t=…&k=…` — de PWA leest het
fragment (dat nooit naar de server gaat), valideert met een test-call (`GET /api/outbox`),
slaat pairing op in IndexedDB en wist het fragment uit de adresbalk
(`history.replaceState`). Daarna: succes-scherm + beginscherm-instructie. Is de app al
gekoppeld en opent iemand een nieuwe pair-link → expliciete keuze "Vervang koppeling?".
S1 heeft ook een **"koppeling vervallen"-variant**: krijgt de PWA ergens een 401 (na
token-rotatie op de desktop), dan wist ze de lokale pairing niet stilletjes, maar toont ze
dit scherm met uitleg ("De koppeling is op de computer vernieuwd — scan de nieuwe code")
en blijven concepten/outbox lokaal bewaard.

**S2 — Nieuwe memory (hoofdscherm).** Verticale opbouw:

```
┌──────────────────────────────────────┐
│  MemoryLane Onderweg          ⚙  📤2 │   ← settings, outbox met teller
│                                      │
│  Titel                               │
│  ┌────────────────────────────────┐  │
│  │ Weekend in de Ardennen…        │  │   ← Fraunces, 24px, autoFocus uit
│  └────────────────────────────────┘  │
│                                      │
│  Wanneer                             │
│  ┌───────────────┐  ┌─────────────┐  │
│  │ 📅 vr 11 jul  │→ │ + einddatum │  │   ← chips; tik = kalender-sheet
│  └───────────────┘  └─────────────┘  │
│                                      │
│  Verhaal                             │
│  ┌────────────────────────────────┐  │
│  │ Schrijf je verhaal… (groeit    │  │
│  │ mee met de tekst)              │  │
│  └────────────────────────────────┘  │
│                                      │
│  Foto's & video's                    │
│  ┌──────┐ ┌──────┐ ┌──────┐          │
│  │ [+]  │ │ ▦    │ │ ▦ ▶  │          │   ← 3-koloms grid, video's met ▶
│  └──────┘ └──────┘ └──────┘          │      en duur-badge; X per tegel
│                                      │
│ ┌──────────────────────────────────┐ │
│ │  Bewaar in MemoryLane            │ │   ← sticky onderaan; subtekst:
│ │  4 foto's · 1 video · 87 MB      │ │      inhoudssamenvatting
│ └──────────────────────────────────┘ │
└──────────────────────────────────────┘
```

Regels:
- **Titel** verplicht (de vault gebruikt 'm als mapnaam). Leeg → knop disabled met hint.
- **Begindatum** verplicht, standaard vandaag. **Einddatum** standaard afwezig (= eendags);
  de "+ einddatum"-chip toont de range-modus.
- **Verhaal** optioneel; wordt een tekst-item (notitie) in de memory.
- **Media** optioneel; `<input type="file" accept="image/*,video/*" multiple>`. Volgorde
  aanpasbaar met drag (of ▲▼-knoppen als fallback — drag op mobiel is genoeg met een
  long-press handle). iOS levert soms HEIC: gewoon doorsturen. **Randvoorwaarde desktop:**
  HEIC-decoding en video-thumbnails leunen op een extern `ffmpeg`-binary op PATH
  (`src-tauri/src/media/decode.rs:55-82`); zonder ffmpeg slaagt de import wel (bestanden
  worden gekopieerd) maar tonen precies de iPhone-formaten (HEIC/MOV) geen thumbnail. Neem
  dit op in de E2E-checklist en gebruikersdocumentatie; ffmpeg meebundelen staat op de
  backlog (§16).
- Versturen kán met alleen titel + datum (memory zonder media is geldig).

**S3 — Datumkiezer (bottom-sheet).** Dit moet de fijnste datumkiezer zijn die de gebruiker
ooit op een telefoon zag; custom component, geen native `<input type="date">` (die kan geen
range en geen "einddatum = begindatum"-default):

- Bottom-sheet met maandkalender; horizontaal swipen tussen maanden; ma–zo als kolomkoppen;
  vandaag gemarkeerd met een rondje.
- Bovenin snelkoppelings-chips: **Vandaag · Gisteren · Eergisteren · Afgelopen weekend**
  (za+zo van het laatste weekend, als range).
- Jaartal: tik op de maand/jaar-kop → jaar-grid (belangrijk: herinneringen kunnen ouder zijn;
  in twee tikken naar 2019 kunnen is een eis, niet een nice-to-have).
- **Range-gedrag:** geopend via de begindatum-chip selecteert één tik de begindatum
  (einddatum schuift automatisch mee als die vóór de begindatum zou vallen). Geopend via
  "+ einddatum": eerste tik = einddatum; de range wordt visueel ingekleurd (`--accent-soft`)
  met begin/eind in `--accent`. Onderin live de samenvatting: "vr 11 – zo 13 juli · 3 dagen"
  + knop **Klaar**.
- Einddatum weer weghalen: "Geen einddatum"-knop in de sheet (terug naar eendags).
- Toegankelijk: elke dag een echte button met `aria-label` ("vrijdag 11 juli 2026"),
  focus-volgorde logisch, sheet sluit met swipe-down én een sluitknop.
- Geen tijdstip-invoer: MemoryLane werkt met datums (`YYYY-MM-DD`), geen tijden. Dat houdt
  ook alle tijdzone-ellende buiten de deur: de string die de gebruiker kiest is de waarheid,
  er wordt nergens via `Date`-UTC-conversie een dag verschoven (implementatienoot: gebruik
  string-gebaseerde datumlogica of alleen lokale datumcomponenten, nooit `toISOString()` op
  een lokale datum).

**S4 — Upload-voortgang.** Na "Bewaar in MemoryLane": het formulier klapt om naar een
voortgangskaart: per bestand een thumbnail met voortgangsring; bovenaan de totaalbalk;
tekst "Houd de app open tot de upload klaar is". Klaar → grote ✓ "Staat klaar voor je
thuis-import" + knop "Nog een memory". Mislukt onderweg → kaart blijft staan met
**Opnieuw proberen** (hervat alleen de ontbrekende bestanden; zie §5.5 idempotentie) en
**Bewaar als concept**.

**S5 — Outbox.** Lijst van verstuurde memories (lokaal bewaard: memoryId, titel, datum,
mediateller — de server kent de titel immers niet): status per stuk
("⏳ wacht op thuis-import" / "✓ geïmporteerd" via `GET /api/outbox`, opgehaald bij openen),
plus concepten ("nog niet verstuurd"). Swipe/knop om een nog-niet-geïmporteerde memory van de
server te verwijderen (`DELETE /api/memories/:id`) of een concept te hervatten/verwijderen.
Tombstones ouder dan 30 dagen verdwijnen server-side; de lokale lijst ruimt dan mee op.
Lege staat: "Nog niets onderweg — je verstuurde memories verschijnen hier" met een knop
naar S2.

**S6 — Instellingen.** Gekoppelde mailbox (korte id + datum), knop "Ontkoppelen" (wist lokale
pairing; wijst erop dat de desktop het upload-token kan roteren), thema (systeem/licht/donker),
versienummer.

### 6.4 Formulier-microdetails (de "gebruiksvriendelijkheids-eisen")

- Elke input ≥ 16 px fontgrootte; `enterkeyhint="next"`; labels áltijd zichtbaar boven het
  veld (geen placeholder-als-label).
- Textarea groeit automatisch mee (geen inner-scroll), max ~40% viewport daarna wel scroll.
- De media-picker toont direct thumbnails (object-URLs), met per video een duur-badge
  (`loadedmetadata`) en per item de grootte; totaalteller onder het grid.
- Fouten inline en in mensentaal ("Deze video is groter dan 500 MB — dat past niet in de
  brievenbus"), nooit alleen een rood randje.
- Haptics waar beschikbaar (`navigator.vibrate` op Android) bij verstuurd/klaar.
- Alles werkt met één duim: sticky verstuurknop onderaan, sheets vanaf de onderkant.

### 6.5 Upload-flow (technisch)

1. Gebruiker kiest bestanden → bytes worden (chunked) naar IndexedDB gekopieerd zodat het
   concept een app-herstart overleeft (File-handles zijn op iOS niet persistent). De PWA
   hanteert een **praktische limiet van 500 MB per bestand** (los van de 2 GiB-serverlimiet,
   die er is voor toekomstige clients): daarboven wordt Safari's IndexedDB/geheugen op iOS
   onbetrouwbaar. Grotere bestanden worden bij het kiezen geweigerd met een nette melding.
2. "Bewaar" → PWA genereert `memoryId` (uuid v4) + per bestand een `fileId` (uuid v4),
   bouwt de envelope-JSON (§8.2) en versleutelt envelope + elk bestand **chunk-gewijs
   streamend**: per 8 MiB-chunk lezen uit IndexedDB → encrypt → ciphertext-chunk terug naar
   IndexedDB. Direct na het versleutelen van een bestand worden de **plaintext-bytes van dat
   bestand uit IndexedDB verwijderd** — de duplicatie (plain + cipher tegelijk) is dus
   beperkt tot één bestand; de IndexedDB-piek is ≈ totale selectie + het grootste bestand.
   Ciphertext-groottes worden hierbij gemeten.
3. `POST /api/memories` → presigned PUT-URLs.
4. Uploads sequentieel of max 2 parallel, via **XMLHttpRequest** (fetch heeft geen
   upload-voortgang), body streaming uit de IndexedDB-chunks (Blob-samenstelling), met
   `Content-Type: application/octet-stream`. **Signing-afspraak (valkuil):** de Worker
   presignt **zonder** `content-type` in de SignedHeaders; de client mag 'm dan meesturen
   met precies deze vaste waarde. Zo kan een header-mismatch nooit een 403 veroorzaken.
5. Na alle PUTs: `POST /api/memories/:id/complete`. Bij 409 (ontbrekende bestanden):
   opnieuw presignen en alleen die bestanden uploaden.
6. Succes → outbox-entry, concept + alle IndexedDB-bytes (plain én cipher) opruimen.
7. Onderbroken (app gesloten, netwerk weg): het concept + de al-versleutelde staat blijven
   lokaal; "Opnieuw proberen" begint bij stap 3 met dezelfde `memoryId` (idempotent) en slaat
   reeds geüploade bestanden over.

---

## 7. Component C — pairing & sleutelbeheer

### 7.1 Pairing-flow

1. **Desktop** (Settings → "Telefoon", §9.1) genereert lokaal: `mailboxId` (uuid v4),
   `ownerToken` (32 B), `uploadToken` (32 B), `masterKey` (32 B) — allemaal via OS-CSPRNG in
   Rust (`rand::rngs::OsRng`).
2. Desktop → `POST /api/mailboxes` met invite-code en **alleen de SHA-256-hashes** van beide
   tokens.
3. Desktop bewaart `serverUrl`, `mailboxId`, `ownerToken`, `masterKey` in de
   **Windows Credential Manager** via de `keyring`-crate (service `memorylane-inbox`).
   Niet in `localStorage`, niet in een frontend-database, niet in de vault (die kan op een
   NAS/gedeelde schijf staan). Niet-geheime status voor de UI (gekoppeld ja/nee, server-URL,
   korte mailbox-id, koppeldatum) komt uitsluitend via het `inbox_status()`-command (§9.2).
4. Desktop toont een **QR-code** met payload
   `https://<host>/pair#v=1&mb=<mailboxId>&t=<uploadToken_b64url>&k=<masterKey_b64url>`.
   Het fragment (`#…`) wordt door browsers **niet** meegestuurd naar de server. QR-weergave
   in de React-settings met het `qrcode`-npm-pakket; de payload komt uit één Tauri-command
   en wordt nergens gelogd.
5. **Telefoon** scant met de camera-app → Safari/Chrome opent de pair-pagina → PWA slaat
   `{serverUrl, mailboxId, uploadToken, masterKey}` op in IndexedDB en wist het fragment.
6. De QR-dialog op de desktop heeft "Klaar"-knop; opnieuw openen genereert **geen** nieuwe
   tokens (toont een waarschuwing + optie "Nieuwe koppelcode (oude telefoon vervalt)" →
   rotate-flow).

**Rotate-semantiek (besloten):** "Nieuwe koppelcode" roteert **zowel het upload-token als de
masterKey** (een afgekeken QR is anders alleen half onschadelijk gemaakt: de masterKey blijft
bruikbaar voor het ontsleutelen van toekomstig verkeer als alleen het token wisselt). Omdat
nog-pending memories onder de óúde sleutel versleuteld zijn, dwingt de flow eerst een lege
brievenbus af: de rotate-knop checkt `GET /api/memories/count` en eist dat de gebruiker eerst
importeert (of expliciet kiest voor "pending memories weggooien" → het
`inbox_discard_pending`-command, §9.2). Daarna: nieuwe masterKey + upload-token genereren,
`POST /api/mailboxes/rotate-upload-token`, keyring bijwerken, nieuwe QR tonen. Het
owner-token wijzigt niet mee (dat heeft de telefoon nooit gezien).

### 7.2 Sleutelhiërarchie

```
masterKey (32 B, alleen telefoon + desktop)
 ├─ envelopeKey = HKDF-SHA256(ikm=masterKey, salt="ml-inbox:"+memoryId, info="ml-inbox:v1:envelope")
 └─ fileKey     = HKDF-SHA256(ikm=masterKey, salt="ml-inbox:"+memoryId, info="ml-inbox:v1:file:"+fileId)
```

- Server ziet: mailboxId, memoryId, fileIds, ciphertext-groottes, tijdstempels. Meer niet.
- Meerdere telefoons? v1: dezelfde QR op een tweede telefoon scannen werkt (zelfde
  upload-token + masterKey). Per-device tokens staan op de backlog (§16).

### 7.3 Dreigingsmodel (kort)

| Dreiging | Mitigatie |
|---|---|
| Server/D1/R2-lek | E2EE: alles blobs; tokens alleen als hash |
| QR afgekeken (foto van scherm) | rotate-knop; QR alleen op verzoek getoond, dialog sluit na pairing |
| Telefoon gestolen | desktop roteert upload-token → telefoon is dood; masterKey op de telefoon geeft alleen toegang tot *nieuwe* eigen uploads, niet tot de vault |
| Brute-force op tokens | 256 bits entropie; rate-limit op auth-fouten |
| Kwaadwillende maakt mailboxen aan | invite-code + registratie-rate-limit |
| Path/key-injectie | R2-keys uitsluitend uuid's; bestandsnamen alleen ín de envelope; desktop sanitiseert namen bij uitpakken (§9.2) |
| MITM | HTTPS overal (Cloudflare); HSTS op de zone |

---

## 8. Component D — het versleutelde blobformaat (exacte specificatie)

Beide kanten implementeren dit byte-voor-byte identiek; §12 legt vast hoe we dat bewijzen
met gedeelde testvectoren.

### 8.1 Container (elk R2-object: bestanden én envelope)

```
offset  lengte  inhoud
0       4       magic  = ASCII "MLI1"
4       1       version = 0x01
5       3       reserved = 0x00 0x00 0x00
8       8       plaintextSize, u64 little-endian
16      …       chunks, aaneengesloten
```

- **Chunkgrootte (plaintext):** vast 8 MiB (8 388 608 B); laatste chunk korter.
  `chunkCount = max(1, ceil(plaintextSize / 8MiB))` (een leeg bestand is verboden;
  de PWA weigert 0-byte-bestanden).
- **Chunk-layout:** `nonce (12 B, CSPRNG) || AES-256-GCM-ciphertext (chunkPlainLen + 16 B tag)`.
- **AAD per chunk:** UTF-8 van `"ml1|" + memoryId + "|" + fileId + "|" + chunkIndex + "|" + chunkCount`
  (chunkIndex 0-based, decimaal). `fileId` is `"envelope"` voor de envelope. De AAD bindt
  chunk-volgorde én -aantal: herordenen, weglaten of truncaten van chunks faalt bij decrypt.
- **Sleutel:** zie §7.2 — per bestand uniek, dus random 12-byte nonces zijn ruimschoots veilig
  (serverlimiet 2 GiB / 8 MiB = max 256 chunks per bestand; de PWA hanteert in de praktijk
  500 MB ≈ 63 chunks, zie §6.5).
- Decrypt-kant valideert: magic, version, `plaintextSize` consistent met de som van de
  chunk-plaintextlengtes, en elke GCM-tag. Elke afwijking → bestand geweigerd, import van
  déze memory afgebroken (andere memories gaan door), fout in de UI met memoryId.

### 8.2 Envelope-JSON (plaintext vóór versleuteling)

```json
{
  "v": 1,
  "memoryId": "0d9f…",
  "title": "Weekend in de Ardennen",
  "startAt": "2026-07-11",
  "endAt": "2026-07-13",
  "note": "Vrijdagavond aangekomen bij…",
  "createdAt": "2026-07-13T21:42:11Z",
  "files": [
    { "fileId": "a1b2…", "name": "IMG_4021.HEIC", "mime": "image/heic",
      "plainBytes": 3400123, "order": 0 },
    { "fileId": "c3d4…", "name": "IMG_4022.MOV",  "mime": "video/quicktime",
      "plainBytes": 48210000, "order": 1 }
  ]
}
```

- `endAt` weglaten (of `null`) bij een eendags-memory — spiegelt het optionele `endAt` in
  `event_markdown` (`src-tauri/src/vault/writer.rs:130-157`).
- `note` lege string toegestaan (dan wordt géén tekst-item aangemaakt).
- `order` bepaalt de importvolgorde van media.
- Datums zijn kale `YYYY-MM-DD`-strings, exact zoals de desktop-vault ze verwacht
  (`year_of()` leest de eerste vier tekens — `writer.rs:182`).

---

## 9. Component E — desktop-integratie (dit repo)

### 9.0 ⚠️ Eerst dit: er zijn twee frontends, bouw alléén in de actieve (v2)

De actieve app is de **v2-frontend**: `src/main.tsx` → `src/app/Root.tsx` →
`src/app/AppShell.tsx`, die met de Rust-backend praat via de typed wrapper
`src/lib/backend.ts` (Tauri-`invoke` op desktop; mock-implementatie in browser-dev).
**`src/App.tsx` en alles wat alleen dáárdoor gebruikt wordt is de niet-gemounte v1-app**
— o.a. `SettingsModal`, `SettingsStorage`, `QuickAdd`, `EditMemoryDialog` en de hele
sql.js-laag `src/db/*` (database.ts, syncService.ts, meta-tabel). Die bestanden bestaan
nog wél, dus het is verraderlijk makkelijk om daar te bouwen en niets in de app te zien.
(De projectstructuur-sectie in CLAUDE.md beschrijft nog de v1-indeling.) Alle UI-werk in
dit plan gebeurt in `src/app/` + `src/lib/backend.ts` + (voor canvas-visuals)
`src/render/`.

### 9.1 Settings-UI: nieuw onderdeel "Telefoon" in de v2-SettingsPanel

Toevoegen als nieuwe sectie in de bestaande `SettingsPanel` (`src/app/AppShell.tsx:1695`),
implementatie als los bestand `src/app/SettingsPhone.tsx` dat de panel importeert:

- **Niet gekoppeld:** veld "Server-URL" (default de vaste inbox-URL, aanpasbaar voor
  zelf-hosters), veld "Invite-code", knop **"Koppel telefoon"** → Tauri-command
  `inbox_pair(serverUrl, inviteCode)` → dialoog met QR + korte uitleg ("Scan met de camera
  van je telefoon"). Invite-code wordt na registratie **niet** bewaard.
- **Gekoppeld:** status ("Gekoppeld · mailbox a1b2… · sinds 14 jul 2026"), badge met
  openstaande memories, knoppen: **"Importeer openstaande memories"**, "Nieuwe koppelcode"
  (rotate-flow §7.1: eerst lege brievenbus afdwingen), "Ontkoppelen" (met bevestiging;
  `DELETE /api/mailboxes` + keyring leegmaken). **Staan er nog `ready`-memories, dan
  waarschuwt de ontkoppel-dialoog expliciet:** "Er staan nog N memories klaar die je nog
  niet hebt geïmporteerd — die gaan definitief verloren. Eerst importeren?"
- **Badge elders:** bij app-start en window-focus (met een throttle van ≥ 15 min) roept de
  frontend `inbox_pending_count()` aan; is de teller > 0, toon dan een kleine, niet-opdringerige
  indicator bij de settings-knop ("2 memories onderweg"). Fouten (offline, server weg) zijn
  stil — de teller verschijnt dan gewoon niet.

### 9.2 Rust-kant (`src-tauri/src/inbox/`)

**Nieuwe dependencies (Cargo.toml):** `reqwest` (rustls-tls, geen openssl), `aes-gcm`,
`hkdf`, `sha2`, `keyring`, `serde_json` (al aanwezig), `base64`.

**Nieuwe Tauri-commands** (registreren in `src-tauri/src/lib.rs:96-123` naast de bestaande):

| Command | Doet |
|---|---|
| `inbox_pair(server_url, invite_code) -> PairResult { qr_payload, mailbox_short_id }` | genereert ids/tokens/sleutel, registreert, slaat op in keyring, geeft QR-payload éénmalig terug |
| `inbox_status() -> { configured, server_url, mailbox_short_id, paired_at }` | leest keyring/meta |
| `inbox_pending_count() -> u32` | `GET /api/memories/count` |
| `inbox_rotate_upload_token() -> { qr_payload }` | rotate-flow §7.1: weigert met een duidelijke fout zolang er nog `ready`-memories staan; genereert daarna nieuw upload-token + nieuwe masterKey + nieuwe QR |
| `inbox_discard_pending() -> u32` | gooit alle nog-pending memories op de server weg (per stuk `DELETE /api/memories/:id`); gebruikt door de rotate-flow ("pending weggooien") en de ontkoppel-dialoog; geeft het aantal verwijderde memories terug |
| `inbox_unpair()` | `DELETE /api/mailboxes` + keyring wissen |
| `inbox_import(window) -> ImportReport` | de hoofdflow, zie hieronder; stuurt voortgang via Tauri-events (`inbox://progress`, payload: `{ memoryId, memoryIndex, memoryCount, step: "download" \| "decrypt" \| "write" \| "ack", fileIndex, fileCount, bytesDone, bytesTotal }`) |

**Het import-ledger (idempotentie over crashes heen).** ⚠️ Sla dit **niet** op in de
Rust-index-SQLite: die is in-memory en wordt bij elke rescan geleegd
(`index::open_in_memory()` via `commands.rs:27-28`, tabellen gewist in `index::load`) — een
ledger daar overleeft niets. De meta-tabel in de frontend-DB (`getMeta`/`setMeta`,
`src/db/database.ts:1383-1407`) is óók ongeschikt: de import draait volledig in Rust.
**Keuze:** een eigen bestand `inbox-ledger.json` in de **app-data-dir**
(`app.path().app_data_dir()` — zelfde map als de bestaande `config.json`, zie
`commands.rs:510-512`), atomair geschreven via het bestaande `write_atomic`-patroon.
Inhoud: map van `memoryId` → `{ state: "importing" | "imported", eventId, folderPath, at }`.

**Importflow (`import.rs`) — per memory, sequentieel.** De import gebruikt de
**writer-laag rechtstreeks** (`src-tauri/src/vault/writer.rs`), niet de Tauri-command-laag:
elk command doet nu een volledige vault-rescan (`self.rescan()`), wat bij 4+ calls per memory
en een grote vault onnodig traag is — en `writer::create_event` geeft het `folder_path`
direct terug (`writer.rs:733-753`), dus de index is tussentijds niet nodig. Eén rescan aan
het eind volstaat.

1. `GET /api/memories?status=ready` → lijst (zonder URLs).
2. **Ledger-check per memory:**
   - staat er `imported` → alleen `POST /api/memories/:id/ack` sturen (eerdere run crashte
     ná import, vóór/tijdens ack) en door naar de volgende;
   - staat er `importing` → een eerdere run crashte middenin de vault-schrijfstap: verwijder
     eerst het halve event via het **nieuwe** `writer::delete_event(folder_path)` (eventmap →
     OS-prullenbak, naar analogie van `trash_file`, `writer.rs:812` — bestaat nog niet, hoort
     bij deze fase) en importeer daarna opnieuw vanaf stap 3.
3. `GET /api/memories/:id/urls` → verse presigned URLs voor déze memory. Download envelope →
   decrypt → parse + valideer (`v`, `title` niet leeg na trim, `startAt` matcht
   `^\d{4}-\d{2}-\d{2}$`, idem `endAt` indien aanwezig en `endAt ≥ startAt`, `files[].name`
   gesanitiseerd: alleen basename, path-separators/controltekens gestript, lege naam →
   `bestand.<ext-uit-mime>`).
4. **De envelope is de autoriteit over de bestandslijst, niet de server.** Itereer
   `envelope.files`; ontbreekt er voor een fileId een downloadUrl of faalt een
   download/decrypt → hele memory overslaan (temp opruimen, fout in rapport, **géén ack**) —
   anders kan een kapotte of kwaadaardige server stilletjes bestanden laten wegvallen en
   wordt er incompleet geïmporteerd terwijl de ack de bron verwijdert. Extra fileIds die de
   server noemt maar de envelope niet, worden genegeerd. Download elk bestand naar
   `%TEMP%/memorylane-inbox/<memoryId>/<order>_<gesanitiseerde-naam>` (het `order`-prefix
   voorkomt stille overschrijving bij dubbele namen zoals twee keer `IMG_0001.jpg`),
   streaming decrypt (chunk voor chunk — geen hele video in RAM).
5. Vault-import (writer-laag), in deze volgorde:
   a. ledger-entry `importing` schrijven **vóór** de eerste schrijfactie (met het
      folder-pad zodra bekend);
   b. `writer::create_event(vault_root, jaar, title, startAt, endAt, None)`
      (`writer.rs:733-740`; de laatste parameter is `size: Option<i64>` — hier `None`) —
      plaatst het event onder de jaarmap van `startAt` (maakt die zo nodig aan) en geeft
      `(event_id, folder_path)` terug. De command-variant `create_event_at_date`
      (`commands.rs:349`) wordt bewust níét gebruikt — zie de rescan-rationale hierboven;
   c. frontmatter-vlag `underConstruction: true` zetten via het `set_fm_field`-patroon
      (§10);
   d. bij niet-lege `note`: `writer::create_text_item(vault_root, folder_path, None, note)`
      (`writer.rs:307` — caption expliciet `None`). De notitie krijgt géén `happenedAt` en
      sorteert dus op event-start, vóór alle media (die op 12:00:xx staan) — dat is de
      bedoeling: het verhaal eerst;
   e. per mediabestand, in `order`-volgorde: importeren via een **uitgebreide**
      writer-functie `import_media(vault_root, folder_path, source, meta)` met
      `meta = { happened_at: Some("<startAt>T12:<mm>:<ss>Z"), caption: None }`, waarbij
      `mm = 0 + order div 60` en `ss = order mod 60`, beide 2-cijferig.
      ⚠️ **De `Z`-suffix is verplicht:** `to_millis` parset strings met een `T` via
      `DateTime::parse_from_rfc3339` (`scanner.rs:697-711`), en RFC 3339 eist een
      tijdzone-offset — `"…T12:00:05"` zonder `Z` faalt stil en de volgorde degradeert
      naar de (random) slug-tie-break. Voeg in fase 5 een unit-test toe die asserteert dat
      `to_millis` het gekozen formaat accepteert én monotoon oplopende waarden geeft.
      Waarom dit hele mechanisme: de bestaande `import_photo` (`writer.rs:768`) schrijft
      geen `happenedAt` en zet de bestandsnaam-stem als caption. Zonder `happenedAt`
      sorteert de app items op `timestamp_ms` (allemaal gelijk aan event-start) met de slug
      als tie-break (`index.rs:402`) — de zorgvuldig gekozen volgorde van de telefoon zou
      dus verloren gaan, en elke foto zou "IMG_4021" als bijschrift krijgen. `import_media`
      krijgt de sidecar-schrijflogica van `import_photo`; `import_photo` blijft bestaan en
      delegeert (met stem-caption, geen happenedAt) zodat de bestaande import-flow van de
      app (AppShell → `backend.importPhotos`, `src/lib/backend.ts:208` → het
      `import_photos`-command) onveranderd werkt.
6. Ledger-entry op `imported` zetten → dán `POST /api/memories/:id/ack`. Mislukt de ack
   (netwerk), dan repareert stap 2 dat bij de volgende run.
7. Temp-map verwijderen. Na álle memories: één `rescan()` zodat de Rust-index de nieuwe
   events kent, en één samenvattend rapport naar de frontend ("3 memories geïmporteerd ·
   1 overgeslagen (fout: …)"). De frontend ververst daarna via de bestaande
   backend-calls — hetzelfde patroon als na andere mutaties: `loadYears`
   (`src/app/AppShell.tsx:714`, zie de her-aanroep op `AppShell.tsx:970`) en, als er een
   jaar/event open staat, de bijbehorende detail-refresh. **Niet** via het legacy
   `syncOnFocus`-pad (dat is v1, zie §9.0).

**Randvoorwaarden vóór de import:** er is een vault geconfigureerd
(`VaultService::current_vault()` slaagt); zo niet → nette fout in de UI ("Kies eerst een
vault-map in Instellingen → Opslag").

**Zichtbaarheids-noot voor de inbox-module:** `current_vault` (`commands.rs:121`) én
`rescan` (`commands.rs:130`) zijn nu privaat — maak beide `pub(crate)`. Ook `write_atomic`
(`writer.rs:296`) en `set_fm_field` (`writer.rs:161`) zijn private `fn`'s; maak ze
`pub(crate)` (of geef de inbox-module eigen equivalenten) — het plan verwijst ernaar als
patroon, niet als kant-en-klaar aanroepbare API.

**Ledger-hygiëne:** het ledger wordt **nooit** opgeschoond. De eeuwige `imported`-entries
zíjn de replay-bescherming: een kapotte of kwaadaardige server die een al-ge-ack'te memory
opnieuw als `ready` presenteert, wordt uitsluitend hierdoor gestopt (stap 2 stuurt dan
alleen nogmaals een ack). De groei is verwaarloosbaar (één JSON-regel per ooit geïmporteerde
memory). Een latere "ruim het ledger op"-refactor zou deze bescherming stilletjes slopen.

### 9.3 Kleine noodzakelijke fix in de bestaande code

`import_photo` schrijft voor élk mediabestand een sidecar met hardcoded `type: photo`
(`photo_item_markdown`, `src-tauri/src/vault/writer.rs:117-127`), terwijl de scanner
frontmatter-`type` laat winnen van de extensie (`src-tauri/src/vault/scanner.rs:403-412`).
Een geïmporteerde `.mp4` zou dus als foto geïndexeerd worden. **Fix (klein, los te committen):**
laat `import_photo` het type afleiden via `ItemType::from_extension`
(`src-tauri/src/model.rs:42`) en schrijf `type: video` voor video-extensies. Regressietest
erbij (unit-test naast de bestaande writer-tests). Dit repareert meteen ook de bestaande
drag&drop-import van video's.

---

## 10. Component F — "In aanbouw"-status (under construction)

Nieuw event-veld, end-to-end. Geïmporteerde memories krijgen 'm standaard **aan**; daarnaast
handmatig te togglen per memory. (De uitgebreide "werklijst"-UI — filteren/overzicht van alle
in-aanbouw-memories — is een latere, losse feature; dit plan legt het datamodel + basis-UI.)

| Laag | Wijziging |
|---|---|
| Frontmatter | optioneel veld `underConstruction: true` in `_event.md`; afwezig = false. Schrijven via het bestaande `set_fm_field`-patroon (`writer.rs:161`) |
| Rust-model | `Event.under_construction: bool` in `src-tauri/src/model.rs`; scanner parset het veld (string `"true"`) in het event-parse-pad (`scanner.rs`, naast titel/startAt, rond regel 207) |
| Rust-command | nieuw `set_event_under_construction(event_id: String, flag: bool)` naar analogie van bestaande setters (bijv. `set_event_size`); update frontmatter + herindexeer het event |
| Rust-index → frontend | het veld gaat mee door de bestaande keten: kolom in de (in-memory) index (`src-tauri/src/index.rs`, incl. de SELECTs), veld `underConstruction?: boolean` op `EventSummary` én `EventInfo` in `src/lib/backend.ts` (`backend.ts:25`, `:96`), en mee in de **mock-backend** in datzelfde bestand (anders wijkt browser-dev af). ⚠️ Niet in de legacy `src/db/database.ts`/`src/models/types.ts` bouwen — zie §9.0 |
| UI (basis) | 1) badge op de event-kaart in de jaarview en in de event-view — dit is **PixiJS-tekenwerk** in `src/render/scenes/` (o.a. `year.ts`), geen DOM-badge; klein stipje/hamertje in de accentkleur met de bestaande hover/tooltip-conventie van die scenes; 2) toggle "Deze memory is nog in aanbouw" in het event-bewerkpaneel van de v2-app (de `EventForm`-state, `AppShell.tsx:20`, + de `EventDialog`-component, `AppShell.tsx:2215`, gevoed via `openEditEvent`/`submitEventForm`) |
| Import | `inbox_import` zet de vlag aan direct na `writer::create_event` (stap 5b–c in §9.2) |

Bestaande vaults: veld afwezig ⇒ false; geen migratie nodig (scanner is al tolerant voor
onbekende/afwezige velden).

---

## 11. Robuustheid & randgevallen (checklist voor de bouwer)

**Telefoon**
- App gesloten tijdens invullen → concept (incl. mediabytes) in IndexedDB, herstelt volledig.
- App gesloten tijdens upload → outbox-entry "onvoltooid", hervatten met dezelfde `memoryId`;
  server geeft alleen ontbrekende bestanden terug (idempotente create, §5.5).
- Netwerk valt weg → XHR-fout → automatische retry (3×, exponential backoff), daarna
  handmatige "Opnieuw proberen".
- Presigned URL verlopen (upload > 15 min) → PUT faalt met 403 → client presignt opnieuw via
  `POST /api/memories` en gaat door waar hij was.
- Safari-eviction van IndexedDB (~7 dagen inactiviteit, geldt praktisch niet voor
  beginscherm-PWA's) → pairing kwijt = opnieuw QR scannen; concepten kwijt is dan
  acceptabel verlies, maar meld het eerlijk ("Opslag is door iOS gewist").
- Opslagdruk: mediabytes van *verstuurde* memories worden direct opgeruimd; concepten tonen
  hun grootte in de outbox.
- Klok van de telefoon is irrelevant: datums zijn user-gekozen strings.

**Server**
- Dubbele `complete` → idempotent (status al `ready` → 200).
- List-verificatie bij complete (§5.5) voorkomt "ready" memories met ontbrekende blobs.
- Kwijtgeraakte uploads (create zonder complete) → cron ruimt na 7 dagen.
- D1 en R2 kunnen niet transactioneel samen: doe bij ack/delete **eerst de R2-deletes, dan
  de D1-mutatie** (bij ack is dat de tombstone-update naar `imported`, bij delete het
  verwijderen van de rij); blijft er door een crash een R2-object achter, dan ruimt de
  lifecycle-regel (35 d) het op.

**Desktop**
- Crash ná vault-import, vóór ack → ledger-status `imported` (stap 6) → volgende run stuurt
  alleen de ack; geen dubbele events.
- Crash middenin de vault-schrijfstap (ná `writer::create_event`, vóór de laatste
  `import_media`) → ledger-status `importing` met het folder-pad; volgende run verwijdert
  eerst het halve event via het nieuwe `writer::delete_event` (eventmap → OS-prullenbak) en
  importeert opnieuw (§9.2 stap 2). Zonder dit zou er een tweede, dubbel event ontstaan.
- Decrypt-fout (verkeerde sleutel na her-pairing, corrupt object) → memory overslaan, duidelijk
  in het rapport; nooit half importeren.
- Schijf vol → `import_media` faalt per bestand met nette fout (gedrag geërfd van
  `import_photo`, `writer.rs:790-798`); memory niet ack'en.
- Twee keer tegelijk op "Importeer" klikken → command-guard (mutex in Rust; tweede aanroep
  krijgt "import loopt al").
- Grote video's: streaming decrypt naar schijf, geheugengebruik O(chunk) = 8 MiB.

**Beide clients**
- Server-fouten altijd met foutcode tonen; nooit stil falen.
- Alle HTTP met timeouts (connect 10 s; read 60 s voor API-calls; geen totale timeout op
  blob-transfers zelf, wel per-chunk voortgangsbewaking).

---

## 12. Testplan

**Cruciaal: cross-language crypto-testvectoren.** WebCrypto (TS, encrypt) en RustCrypto
(Rust, decrypt) moeten byte-identiek zijn. In `inbox/shared/test-vectors/` komen JSON-fixtures
met vaste masterKey, memoryId, fileId, vaste nonces (voor de vectoren injecteerbaar gemaakt),
plaintext en verwachte ciphertext-container:

- `vector-01`: klein tekstbestand (1 chunk);
- `vector-02`: 20 MiB (3 chunks, laatste partieel);
- `vector-03`: envelope-JSON;
- `vector-04..06`: corrupties (bitflip in tag, chunk verwisseld, `plaintextSize` gelogen) —
  **moeten** falen.

De TS-tests (vitest, in `inbox/pwa`) bewijzen encrypt→vector; de Rust-tests
(`cargo test`, in `src-tauri/src/inbox/crypto.rs`) bewijzen vector→decrypt én de
corruptie-weigering. Beide draaien in de bestaande checks (`npm run build` blijft de
TS-check van de hoofdapp; voeg `inbox`-tests toe aan de eigen package-scripts en aan
`cargo test`).

**Worker:** vitest + `@cloudflare/vitest-pool-workers` (draait in workerd met echte
D1/R2-bindings lokaal): auth (goede/foute/ontbrekende tokens, timing-safe pad), registratie
(invite-code, dubbele id), create/complete/ack-lus incl. idempotentie en 409-paden, limieten
(§5.6), autorisatie-isolatie (mailbox A kan niets van mailbox B zien/presignen), cron-logica
met gemanipuleerde timestamps.

**Desktop (Rust):** unit-tests voor envelope-validatie/sanitisatie (path traversal-pogingen
in `files[].name`!), ledger-idempotentie, en een integratietest die met een gemockte API
(lokale hyper-stub of trait-injectie) de hele importflow tegen een temp-vault draait —
inclusief het crash-op-elk-punt-scenario (ledger-states `importing`/`imported`).

**Handmatige E2E-checklist (release-gate):**
1. iPhone Safari: pairen via QR, memory met 5 HEIC-foto's + 1 MOV-video (±100 MB), verhaal
   met emoji/nieuwe regels, range-datum over een jaargrens (bijv. 30 dec – 2 jan → event
   landt in het jaar van de begindatum) → import op desktop (**met ffmpeg op PATH**, §6.3)
   → alles zichtbaar, video speelt, volgorde exact zoals op de telefoon gezet (via
   `happenedAt`, §9.2 stap 5e), vlag "in aanbouw" aan, memory weg van server (R2 leeg),
   outbox toont ✓.
2. Android Chrome: zelfde flow.
3. Vliegtuigstand halverwege upload → hervatten.
4. Import zonder netwerk → nette fout.
5. Token-rotatie → oude telefoon krijgt 401 met nette uitleg in de PWA.
6. Verkeerde invite-code, verlopen presigned URL, 0-byte-bestand, 2,5 GB-video (geweigerd
   met nette melding).

---

## 13. Fasering (bouwvolgorde met acceptatiecriteria)

Elke fase eindigt groen (typecheck + tests + lint), wordt onafhankelijk gereviewd en apart
gecommit — conform het review-loop-protocol van dit project.

| Fase | Inhoud | Acceptatie |
|---|---|---|
| **0. Fundament** | `inbox/worker`-project, wrangler.jsonc, D1-migratie, R2-bucket + CORS + lifecycle, secrets (`INVITE_CODE`, R2-S3-keys), deploy "hello world" op het gekozen (sub)domein | `wrangler deploy` werkt; lifecycle & CORS zichtbaar in dashboard; runbook §15 gevolgd |
| **1. Worker-API** | alle endpoints §5.5, auth, limieten, rate limiting, cron | alle Worker-tests groen; handmatige curl-lus create→PUT→complete→list→ack werkt tegen productie |
| **2. Cryptolaag + vectoren** | TS-encrypt (PWA) en Rust-decrypt (desktop) + gedeelde testvectoren | vectoren wederzijds groen in CI/`cargo test`/vitest |
| **3. PWA** | schermen S1–S6 (incl. offline-, lege- en koppeling-vervallen-states), conceptopslag, uploadqueue, service worker (§6.1), manifest/installable, NL-teksten, design §6.2 | E2E-checklist punten 1–3 (t/m upload-kant); Lighthouse PWA-installable check; app opent en toont concepten in vliegtuigstand |
| **4. Desktop-pairing** | `inbox_pair`/`inbox_status`/rotate/unpair, keyring, Settings-paneel + QR | pairen mét echte telefoon werkt; tokens aantoonbaar alleen in Credential Manager |
| **5. Desktop-import + in-aanbouw** | `inbox_import` + persistent ledger + voortgangs-events, nieuwe writer-functies `import_media` en `delete_event` (§9.2), `set_event_under_construction` end-to-end (§10), video-type-fix (§9.3), badge/teller | volledige E2E-checklist §12 groen |
| **6. Extra's** | Android `share_target`, outbox-verfijning, per-device-tokens (backlog-keuze), iOS Shortcut-recept in de docs | share vanaf Android-galerij → voorgevuld formulier |

Fase 0–2 raken de bestaande app niet; fase 3 is een losstaand subproject. Pas fase 4–5 wijzigen
de desktop-app — de hoofdapp blijft dus continu releasebaar.

---

## 14. Kosten & schaalnoot

Bij het beoogde gebruik (een handvol gebruikers, enkele memories per week, media dagen tot
weken op de server): Workers free (100k req/dag — we zitten er ordes onder), R2 free
(10 GB opslag; een brievenbus is vrijwel altijd bijna leeg), D1 free. **€0/maand.**
De 20 GiB-mailboxlimiet (§5.6) kán boven de R2-free-tier uitkomen als iemand de brievenbus
maandenlang niet leegt; dan rekent Cloudflare $0,015/GB-maand over het meerdere — centenwerk,
en de 30-dagen-opruiming begrenst het hard. Wil je het strikt gratis houden: zet de
mailboxlimiet op 8 GiB.

---

## 15. Deploy & beheer (runbook)

```bash
# eenmalig
wrangler d1 create memorylane-inbox
wrangler r2 bucket create memorylane-inbox
wrangler r2 bucket cors set memorylane-inbox --file cors.json   # subcommand-naam kan per wrangler-versie verschillen (set/put) — check `wrangler r2 bucket cors --help`
wrangler r2 bucket lifecycle add memorylane-inbox --prefix mb/ --expire-days 35
wrangler secret put INVITE_CODE          # lange random string, bewaar in wachtwoordmanager
wrangler secret put R2_ACCESS_KEY_ID     # R2 API-token (Object Read & Write, alleen deze bucket)
wrangler secret put R2_SECRET_ACCESS_KEY
wrangler secret put R2_ACCOUNT_ID
# per release
cd inbox/pwa && npm run build            # → dist/, door wrangler.jsonc als assets geserveerd
cd ../worker && npx wrangler deploy
# migraties
npx wrangler d1 migrations apply memorylane-inbox --remote
```

- Domein: `inbox.<eigen-domein>` als custom domain op de Worker (of tijdelijk
  `*.workers.dev`). HTTPS/HSTS via Cloudflare-zone-instellingen.
- Monitoring: Workers-logs (`wrangler tail`) + de gratis Workers-metrics; bij fouten ziet de
  gebruiker het toch al in de client-UI. Geen aparte alerting nodig op deze schaal.
- Backup: niet nodig — de server is per definitie doorgeefluik; de bron van waarheid is de
  vault (en diens bestaande backup-advies).

---

## 16. Backlog (bewust buiten scope van v1)

- **Per-foto bijschriften** op de telefoon (envelope heeft er al ruimte voor: `files[].caption`).
- **Locatie/plaats-veld** (vault-items hebben `place_*`-kolommen; event-frontmatter nog niet).
- **Tags/categorie** op de telefoon (bestaan al op items in de vault).
- **Audio-memo's** (item-type `audio` bestaat al in de app).
- **Per-device upload-tokens** (meerdere telefoons individueel intrekbaar).
- **iOS Shortcut** "Deel naar MemoryLane" (share-sheet → POST) als snellere ingang naast de PWA.
- **Werklijst-UI** voor alle in-aanbouw-memories (filter/overzicht) — het datamodel ligt er al (§10).
- **EXIF-datumhint**: als gekozen foto's een EXIF-datum hebben die afwijkt van de ingevulde
  datum → suggestie "Foto's zijn van 12 juli — datum overnemen?" (EXIF-parsing client-side).
- Multipart-uploads voor bestanden > 2 GiB (en verhogen van de praktische PWA-limiet van 500 MB).
- **ffmpeg meebundelen met de desktop-app** zodat HEIC/video-thumbnails geen externe
  PATH-installatie vereisen (§6.3).

---

## 17. Open punten voor de opdrachtgever (blokkeren de start niet)

1. Definitief (sub)domein voor de inbox-Worker.
2. Naam van de PWA op het beginscherm ("MemoryLane" / "ML Onderweg" / anders?).
3. Mailbox-limiet 20 GiB (kan centen kosten) of 8 GiB (strikt gratis) — §14.
