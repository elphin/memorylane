# Plan — Liedjes bij een memory (4 aug 2026)

> Reviewronde 1 (17 bevindingen) en 2 (13 bevindingen) verwerkt. Zie "Verwerkte bevindingen"
> onderaan.

## Doel

Een memory kan het liedje dragen dat erbij hoort. "Zomer 2019 = Blinding Lights."
Toevoegen moet in seconden kunnen, en de herinnering moet over 20 jaar nog leesbaar
zijn, ook als de dienst waar de link naartoe wees niet meer bestaat.

## Jims keuzes (vastgelegd, niet heropenen)

1. **Beide bronnen gelijkwaardig**: eigen audiobestand én streaming-link.
2. **Hoorbaar in de app**, maar wanneer dat automatisch gebeurt is een **instelling**.
   Automatisch bij een diavoorstelling en/of bij het openen van een memory is een keuze
   van de gebruiker; **handmatig starten moet altijd kunnen**.
3. **Meerdere liedjes per memory**, als canvas-items (net als foto's en notities).

## Kernidee: identiteit los van afspeelbron

De duurzame kern van "het liedje van die vakantie" is **tekst**: titel + artiest, plus een
lokaal opgeslagen hoesje. Dat rot niet. Het lokale audiobestand en de streaming-link zijn
allebei *optionele afspeelbronnen* daaromheen. Een dode Spotify-link kost je het knopje,
niet de herinnering.

---

## Wat er al ligt (geverifieerd over twee reviewrondes)

- `ItemType::Audio` incl. extensieherkenning `mp3/wav/ogg/m4a/aac/flac` (`model.rs:48`).
- `link`-items bewijzen dat een item met `url` en zonder mediabestand werkt (`scanner.rs:445`).
- `Item` heeft al `url`; de items-tabel heeft `media`/`url`/`caption` (`index.rs:28-33`).
- **Lokale audio serveren is gratis, maar via het asset-protocol**, niet via `media/serve.rs`:
  `backend.ts:589` roept `item_media_path` aan (`commands.rs:697-702`) en doet `convertFileSrc`.
  Het `media://`-scheme uit `lib.rs:115-127` heeft **nul frontend-consumenten** (gegrept).
  `tauri.conf.json` heeft `csp: null` + `assetProtocol.scope: ["**"]` → Range en mime zijn gedekt.
- `FocusVideoLayer.tsx:53-149` is het patroon voor een DOM-medialaag boven het canvas.
- `Screensaver.tsx:39-49` is de bestaande diavoorstelling.
- `update_item_meta` (`writer.rs:601-653`) herschrijft uitsluitend caption/date/place/people/
  tags/updatedAt → **`artist`/`cover`/`url`/`isrc`/`duration` overleven bewerkingen vanzelf**.
- `reqwest` zit er al (blocking, json, rustls), gebruikt door de inbox.

**Gaten die de reviews blootlegden (nu expliciet als werk geteld):**
- Geen serveringspad voor een andere afbeelding dan `media`: `resolve_thumb` (`commands.rs:83-100`)
  en `resolve_media` (`commands.rs:135-141`) halen hun pad uit `item_media_ref`
  (`index.rs:558-560`, `WHERE i.media IS NOT NULL`). Aan de scene-kant staan **twee** gates:
  `event.ts:1510` én `focus.ts:482` (`if (!this.sprite || this.loaded || !item || !item.media) return`).
- De scanner claimt bestanden uitsluitend via `it.media` (`scanner.rs:313-317`) en maakt van elk
  niet-geclaimd bestand een synthetisch item (`scanner.rs:337-365`); `is_media_file`
  (`scanner.rs:728-739`) matcht jpg/jpeg/png/gif/webp/heic/heif/avif + mp4/mov/avi/mkv/webm **én
  alle audio-extensies**. Dat laatste betekent dat de "audio rendert als kapotte fototegel"-wrat die
  2a fixt vandaag al in echte vaults bestaat — 2a heeft dus echte data om op te testen.
- `media_shared` (`index.rs:709-711`) kijkt alleen naar `media = ?2`.
- De FTS-insert staat achter `has_text` (`index.rs:154-158`).
- **Geen opener/shell-plugin** (`capabilities/default.json` kent `core:default`, window-permissies
  en `dialog:default`) → een link openen kan de app nu niet.
- **Geen schema-versie en geen migratiepad**: de index is puur in-memory (`index.rs:55`) en wordt
  bij elke start herbouwd. Kolommen toevoegen is dus gratis — maar `row_to_item`
  (`index.rs:873-896`) werkt op **positionele indices**, dus elke kolom verschuift de rest.
- **Geen drag&drop** (nul treffers op `onDragDrop`/`DragDropEvent`). Importeren gaat via
  `backend.ts:531-547` met filter `['jpg','jpeg','png','heic','heif','gif','webp','mp4','mov']`.
- `event.ts` is **binair** rond `isText` (`:165`, `:168`, `:179-208`, `:280`, `:1341-1352`), net als
  `focus.ts:128` en `AppShell.tsx:2461` (bewerken).

**Geverifieerd dat het GEEN werk vergt** (zodat het niet terugkomt):
- L1-jaarweergave, collage, lifeline-cover en diavoorstellingpool filteren al op
  `item_type IN ('photo','video')` of `= 'photo'` (`index.rs:328-346`, `401-409`, `500`, `608`,
  `637`) → een liedje lekt daar nooit in. Een memory met alléén een liedje krijgt de
  placeholder-kaart (`year.ts:687-696`).
- Zoekresultaten zijn puur tekstueel (`AppShell.tsx:4694-4718`, geen thumbnail).
- `_canvas.json`: een nieuw item staat er simpelweg niet in; `event.ts:220-222` valt terug op de
  auto-grid. Identiek aan geïmporteerde foto's.
- Bestaande vaults: `read_item` (`scanner.rs:417-426`) valt terug type→extensie→Text. Een oudere
  build op een vault met `type: song` degradeert naar `audio` als er media is, en naar `text` (leeg
  notitiekaartje) bij een link-only liedje. Geen crash. Er is bovendien nergens een exhaustieve
  `match ItemType` buiten `model.rs` en geen exhaustieve switch op `itemType` in de actieve
  frontend, dus een nieuwe variant breekt niets.
- Inbox/PWA accepteert `image/*,video/*` (`NewMemory.tsx:266`) en `ext_from_mime`
  (`inbox/import.rs:149-165`) kent geen audio → nul raakvlak.
- `getTimelineDensity`/`getYearPhotos` hebben nul aanroepers in de actieve frontend.

---

## Datamodel

Nieuw itemtype **`song`** naast het bestaande `audio`.

**De doorslaggevende reden**: fase 5 moet weten wat er automatisch mag starten. Een gesproken
memo van oma automatisch laten afspelen zodra je een memory opent is ronduit verkeerd. Het type
is de grens tussen "muziek die bij deze herinnering hoort" en "een geluidsopname die erin zit".

`audio` blijft voor losse geluidsbestanden en krijgt dezelfde geluidskaart zonder artiest/hoesje
— daarmee is de bestaande wrat (audio rendert als kapotte fototegel) weg.

```yaml
---
id: 01J…
type: song
caption: Blinding Lights            # de titel
artist: The Weeknd
media: blinding-lights_ab12cd34.mp3  # optioneel (lokaal bestand)
cover: blinding-lights_ab12cd34.jpg  # optioneel (lokaal hoesje)
url: https://open.spotify.com/track/… # optioneel
isrc: USUG11904206                   # optioneel, puur archief; ALLEEN uit een lokale tag (lofty).
                                     # Spotify-oEmbed noch de iTunes Search API levert een ISRC,
                                     # dus bij de link-route blijft dit veld per definitie leeg.
duration: 201                        # optioneel, seconden, puur archief
happenedAt: 2019-07-14
---
```

- **Alleen `artist` en `cover` gaan de index in.** `isrc` en `duration` blijven archiefvelden in
  de frontmatter: niets leest ze, `lofty` levert de duur al op importmoment en het
  `<audio>`-element rapporteert zijn eigen duur. Ze overleven vanzelf via `update_item_meta`.
  Zo blijft de kolomverschuiving in `row_to_item` beperkt tot twee.
- **Ten minste één van `media` / `url` / `caption` moet gevuld zijn.** Een `song` met alleen
  `caption` (getypt, geen bestand, geen link) is geldig en moet werken.
- Naamgeving van gekopieerde bestanden volgt `import_media_inner`: `{base}_{short8}.{ext}`, waarbij
  `short8` uit een **UUID** komt (niet uit een hash).

---

## Fasering

### Fase 1a — Leespad: model, scanner, index (geen UI, niets kan nog een `song` maken)

- `ItemType::Song`. `from_extension` blijft `Audio` teruggeven; een `song` ontstaat **alleen** via
  een expliciete `type: song` in de md.
- `Item.artist`, `Item.cover` (Rust + `backend.ts` + `scenes/types.ts`). **Geen `duration`** in het
  model.
- Scanner leest `artist`/`cover`.
- `SCHEMA` (`index.rs:28-33`), de INSERT-kolomlijst (`index.rs:119-124`), `row_to_item` en
  `get_event` bijwerken.
- **Artiest doorzoekbaar**: FTS-`caption`-kolom vullen met `"{caption} {artist}"` (`index.rs:160-167`)
  **én de `has_text`-gate (`index.rs:154-158`) uitbreiden met `artist.is_some()`**, anders is een
  liedje met alleen een artiest onvindbaar. De zoeksnippet komt uit `i.caption` van de
  items-tabel (`index.rs:791`, `813-819`) en wordt hierdoor níét vervuild.
- **`item_thumb_ref` naast `item_media_ref`**: `COALESCE(i.cover, i.media)`, en **geef geen rij terug
  als de gekozen bestandsnaam een audio-extensie heeft** (`ItemType::from_extension(ext) ==
  Some(ItemType::Audio)`, ná de query). Bewust een **deny-list, geen allow-list**: de `image`-crate
  in `generate_jpeg` (`thumbs.rs:84-101`) leest óók bmp/tiff/tga/ico/pnm, die noch in
  `from_extension` noch in `is_media_file` staan maar met een handgeschreven `media:` vandaag wél
  een werkende thumbnail geven. Een allow-list zou die stil uitzetten; audio is het enige probleem
  dat we oplossen. Zonder dit filter resolvet een song zonder cover naar zijn mp3 en hasht
  `commands.rs:114-125` het hele bestand voordat `decode::classify("mp3")` (`media/decode.rs:47-51`)
  alsnog `None` geeft — de hash is gememoiseerd op (pad, mtime, size), dus één keer per app-start,
  niet per request, maar over een flac van 60 MB is dat nog steeds nergens voor nodig.
- Tests: roundtrip md→index→md; item zonder media met alleen `url`; zoeken op artiest;
  `item_thumb_ref` geeft niets terug voor een mp3-only item.

**Gate:** `cargo test`, `cargo clippy --all-targets`, `npm run build`.

> **Verschoven naar 1a bij de bouw** (commit-notitie): het claimen van `cover` in de scanner,
> `item_files`/`media_shared`/`delete_item` en de bijbehorende tests staan hieronder nog beschreven
> maar zijn al in 1a gedaan. Reden: zonder de claim zou elk hoesje één fase lang als synthetische
> fototegel in de index staan, en `ItemFiles` moest toch al naar een named struct. **1b is dus nog
> alleen `song_markdown` + `import_song` + `set_song_meta`.**

### Fase 1b — Schrijfpad: writer + bestandsbeheer van het hoesje

- **Nooit een lege string in `cover` schrijven.** `Parsed::get_str` filtert lege waarden weg, dus
  vandaag kán de kolom geen `""` bevatten — en daar hangt de gelijkheid tussen `item_thumb_ref` en
  `thumbRef` aan: bij `cover: ""` geeft Rust een rij terug en TS `null`. Zodra de writer `cover`
  zet, moet leeg dus `None` worden, geen `""`.
- `song_markdown()` + `import_song()` (kopieert audio en/of hoesje de memory-map in). **Eigen
  schrijfpad**, niet `import_media_inner`: die kiest zijn type via `media_type_for_ext` en zou een
  mp3 `type: audio` geven.
- `set_song_meta()` in de writer, met **`set_fm_block` + `yaml_str`, niet `set_fm_field`**. De writer
  documenteert die conventie zelf (`writer.rs:836-838`): een handgeschreven of v1-bestand kan een
  blok-vorm hebben, en alleen de sleutelregel vervangen laat de vervolgregels verweesd achter, waarna
  de parser stopt en álle sleutels erna uit de index vallen. `caption` is precies zo'n veld —
  `update_item_meta` (`writer.rs:636`) schrijft het al via `set_fm_block`, en twee schrijvers mogen
  hetzelfde veld niet verschillend behandelen. `updatedAt` meeschrijven zoals `set_item_frame`
  (`writer.rs:725`). **Alleen de writer-functie**;
  het tauri-command, de registratie en de TS-kant horen bij 2b, waar het formulier komt. Tot dan is
  `set_song_meta` ongebruikt in de niet-test-build → `dead_code`-warning, maar er is geen
  `deny(warnings)` in `Cargo.toml`, dus de gate blijft groen.
- **Hoesje claimen**: `claimed` (`scanner.rs:313-317`) uitbreiden met `it.cover`, anders wordt elk
  hoesje een synthetisch fototegel-item náást het liedje.
- **Hoesje meeverwijderen**: `item_files` (`index.rs:681-694`) uitbreiden met `cover`, én
  `media_shared` (`index.rs:709-711`) wijzigen naar:
  ```sql
  WHERE event_id = ?1 AND (media = ?2 COLLATE NOCASE OR cover = ?2 COLLATE NOCASE) AND id != ?3
  ```
  **`COLLATE` moet binnen de haakjes, per vergelijking.** Het is in SQLite een unaire postfix-operator
  die strakker bindt dan elke binaire operator; buiten de haakjes hangt hij aan het integer-resultaat
  van `(… OR …)` en vallen béide vergelijkingen terug op BINARY. Dat zet het vangnet tegen de
  v1-duplicate-`.md`-bug (`commands.rs:544-552`) stil uit → `delete_item` zou een bestand trashen
  waar een overlevend item nog naar wijst.
- Tests: "song met hoesje levert exact 1 item op"; "song verwijderen laat geen bestanden achter";
  "gedeeld hoesje blijft staan als een ander liedje het nog gebruikt"; **"gedeeld hoesje met andere
  casing blijft staan"** (bewaakt de COLLATE-plaatsing); `import_song` met alleen een hoesje;
  `isrc`/`duration` overleven een metadata-bewerking.

**Mechanisch meewerk (~17 aanraakpunten, niet vergeten bij het inschatten):** `Item`
(`model.rs:170-207`) heeft geen `Default`, dus twee nieuwe velden breken elke struct-literal —
`scanner.rs:158/347/472` plus negen testliterals in `index.rs`. En `pub type ItemFiles`
(`index.rs:679`) is een 4-tuple dat op vijf plekken gedestructureerd wordt (`commands.rs:202, 222,
275, 293, 536`). Bij deze gelegenheid `ItemFiles` vervangen door een kleine named struct, dan is dit
de laatste keer dat een veld erbij vijf call sites raakt.

**Gate:** idem. Tot fase 3 kan er geen `song` ontstaan → geen zichtbare tussentoestand.

### Fase 2a — De kaart op het canvas

Gesplitst van 2b omdat een derde kaartsoort sizing, hittest, drag/rotate/resize, focus-ring,
grid-packing én de LOD-lader raakt.

- Eén gedeelde, **type-bewuste** helper die exact hetzelfde zegt als `item_thumb_ref`:
  ```ts
  const MUSIC = (t: ItemType) => t === 'song' || t === 'audio'
  const thumbRef = (i: Item) => i.cover ?? (MUSIC(i.itemType) ? null : i.media) ?? null
  ```
  Daarmee **beide** gates vervangen: `event.ts:1510` (deze fase) en `focus.ts:482` (fase 2b).
  Zonder de tweede blijft een link-only liedje in L3 eeuwig op `focusLoading` staan.
  **Het naïeve `cover ?? media` is fout** voor het meest voorkomende geval — een song of bestaand
  `audio`-item mét mp3 en zónder hoesje: dan is de ref niet-null, de gate laat 'm door, de backend
  weigert de thumb bewust, en `TextureCache` (`textures.ts:9, 79-85, 123-125`) blijft elke
  `RETRY_FRAMES = 180` eeuwig opnieuw proberen — én de kaart denkt "ik heb artwork" en toont dus
  nooit de muzieknoot-placeholder.
- Derde kaartsoort: vierkant hoesje, daaronder titel + artiest, play/pauze zichtbaar bij hover
  (en altijd zichtbaar zolang dít liedje speelt).
- Geen hoesje → gegenereerde achtergrond in themakleur met een muzieknoot, in lijn met
  `year.ts:688-696`.
- `audio`-items krijgen dezelfde kaart zonder artiest → geen kapotte fototegels meer.
- De kaart respecteert de bestaande randdikte-instelling.
- **MockBackend-seed** met `song`-items in **alle vier de combinaties** (cover+media, alleen cover,
  alleen media, geen van beide), elk met de verwachte kaart erbij genoteerd. Dit is essentieel:
  `MockBackend.thumb()` genereert voor élk item-id een gradient (`backend.ts:1120-1142`), dus zonder
  die vier gevallen laat de visuele gate een item dat in de échte app kapot is er goed uitzien.

**Gate:** idem + visuele controle in de browser-mock.

### Fase 2b — L3-focus, bronknop en bewerken

- `focus.ts:482` via `thumbRef` (zie 2a) **plus een derde tak in `buildContent`** (`focus.ts:117-179`,
  nu binair op `isText` `:128`): groot hoesje, titel, artiest, afspeelbediening. Die derde tak is het
  echte werk voor een **link-only** liedje — daar is `item.media` undefined, dus `focus.ts:482` valt
  vandaag al vroeg uit en de sprite blijft op `focusLoading` (`focus.ts:173`); de gate-swap verandert
  daar niets aan. De gate-swap lost het *andere* geval op: song mét mp3 zonder hoesje, die nu de
  180-frame retry-lus in loopt.
- **`tauri-plugin-opener`** (verplaatst uit fase 1: hij heeft nul relatie met het datamodel en zou
  daar twee fases lang ongebruikt liggen). Cargo + npm + init in `lib.rs` + capability.
  **Let op de vorm:** de platte string `"opener:allow-open-url"` geeft de permissie **zonder** scope;
  scopen vereist de objectvorm `{"identifier": "opener:allow-open-url", "allow": [{"url": "…"}]}`
  met **glob**-syntax.
  **Correctie na de bouw:** eerder stond hier dat `https://*` geen pad met slashes zou matchen.
  Dat klopt niet — de plugin gebruikt `Pattern::matches()` met `MatchOptions::new()`, en daarin is
  `require_literal_separator: false`, dus `*` loopt gewoon over `/` heen. Wat wél telt: glob is
  **hoofdlettergevoelig**, dus `HTTPS://…` wordt geweigerd. Daarom normaliseert `normalizeLink()`
  het scheme (en `http://` → `https://`) vóór zowel opslaan als openen.
- **Bewerken (anders is `set_song_meta` een wees):** `AppShell.tsx:2461` splitst nu binair op
  `isText`; alles wat geen text/link is gaat naar het metadata-paneel dat alleen
  caption/datum/plaats/mensen/tags + `frame` kent. Er komt een derde tak voor `song` → eigen
  formulier (titel/artiest/link) dat `setSongMeta` aanroept. De kader-keuze (polaroid/plain) is
  voor een liedje betekenisloos en wordt verborgen.
  **Hele keten in déze fase, anders eindigt 2b rood of stil kapot** — vijf schakels, sjabloon
  `set_item_frame` (`commands.rs:289-301`):
  1. `VaultService::set_song_meta` in het `impl`-blok van `commands.rs`. **Niet overslaan:** dit is de
     enige weg van `item_id` naar `(folder, slug)` via `index::item_files`, en het bevat twee dingen
     die makkelijk wegvallen — de `slug.ok_or("dit item heeft geen bewerkbaar bestand")`-guard voor
     synthetische items, en de afsluitende **`self.rescan()`**. Zonder die rescan schrijft "titel
     opslaan" wel naar disk maar blijft de index stale tot de volgende herstart: de kaart, de titel
     in L3 en het zoekresultaat veranderen niet. Groene gate, echte gebruikersbug.
  2. `#[tauri::command] set_song_meta` (one-liner die de methode aanroept).
  3. Registratie in de `invoke_handler` van `lib.rs`.
  4. `setSongMeta` op de `Backend`-interface (`backend.ts:245`).
  5. **Beide** implementaties (`TauriBackend` `:367`, `MockBackend` `:648`) — een interface-methode
     zonder beide is een harde `tsc`-fout en de gate is `tsc && vite build`.
- Verwijderen werkt out of the box: `deleteCurrent` (`AppShell.tsx:2427`) is typeloos — mits 1b er is.

**Gate:** idem + handmatige controle dat de link in de **systeembrowser** opent.

### Fase 3 — Toevoegen (één veld, twee routes)

- Dock-knop "Muziek toevoegen" (nieuw icoon: muzieknoot + plus).
- Eén dialoog met één invoerveld dat zelf uitzoekt wat je gaf:
  - **Link geplakt** → Rust haalt metadata op, vult titel/artiest/hoesje voor.
  - **Bestand gekozen** → Rust leest de tags uit het bestand (titel/artiest/albumhoes/duur).
  - **Tekst getypt** → dat wordt de titel; artiest apart invulbaar.
- **Slepen is geschrapt**: bestaat nergens in de app, is een eigen feature, geen bijvangst. De
  bestandskiezer krijgt filter `[{ name: 'Audio', extensions: ['mp3','m4a','flac','ogg','wav','aac'] }]`.
- **Alle voorgevulde velden blijven bewerkbaar.** Een mislukte lookup is nooit blokkerend.
- **MockBackend-stubs** (anders faalt `tsc` en valt de gate): `importSong` voegt een nep-item toe en
  `lookupSongMetadata` geeft vaste data zonder netwerk. (`setSongMeta` is al in 2b geland.)
- **Instelling `musicLookup`** erbij in `Settings` + `DEFAULT_SETTINGS` (`AppShell.tsx:94-183`,
  `SETTINGS_KEY = 'memorylane-settings'`): puur localStorage, geen Rust, geen migratie.
  **Én de bediening**, anders staat de instelling wel in localStorage maar is hij nergens aan/uit te
  zetten — terwijl dat juist de privacy-belofte van deze fase is. Die leeft in `SettingsPanel`
  (`AppShell.tsx:3071`) met een getypte tab-union op `:3092-3093`. Keuze: **nieuwe tab `'muziek'`**
  (union uitbreiden + `navBtn`, sjabloon `:3236`) — dat is waar in fase 5 `musicAuto` en
  `musicVolume` naast komen te staan, en muziek verdient een eigen plek naast 'dia'. Toggle-sjabloon:
  `showTitle` op `:3308`.
- **`VaultService::import_song`** volgt hetzelfde vijfschakel-patroon als in 2b (sjabloon
  `import_photos`, `commands.rs:385`), inclusief de afsluitende `self.rescan()` — anders verschijnt
  een net toegevoegd liedje pas na een herstart.

**Metadata uit een bestand:** crate `lofty` (pure Rust, MIT, geen C-toolchain; mp3/m4a/flac/ogg
inclusief ingebedde albumhoes en duur). Geen netwerk.

**Metadata uit een link**, in **Rust**:
- Spotify: `open.spotify.com/oembed?url=…` → titel + `thumbnail_url`, **meestal zonder los
  artiestveld** → de iTunes-lookup is het standaardpad voor Spotify-links, niet de uitzondering.
- YouTube: `youtube.com/oembed?url=…&format=json` → titel + `author_name` + thumbnail.
- Aanvullen: `itunes.apple.com/search?term=…&entity=song&limit=1`.
- **Aanroepvorm:** `#[tauri::command] pub async fn` + `tauri::async_runtime::spawn_blocking`, zoals
  `inbox/mod.rs:113-115`. `reqwest::blocking` direct vanuit een sync command paniekt binnen de
  tokio-runtime. Eigen `Client` met `.timeout(5s)`.
- **URL-encoding:** zoekterm percent-encoden (crate `percent-encoding`).
- Hoesje wordt **één keer** opgehaald en lokaal opgeslagen; daarna nooit meer netwerk.
- **Grote bestanden:** boven ~50 MB waarschuwen (niet blokkeren) en de duur uit `lofty` tonen.
  `import_media_inner` (`writer.rs:1104-1144`) is een kale synchrone `fs::copy`.

**Privacy:** eerste uitgaande verbinding bij een gebruikersactie in de desktop-app. De dialoog
benoemt dat, en er komt een instelling **"Gegevens van liedjes online opzoeken"** (standaard aan).

**Gate:** idem. Netwerkcode achter een functiegrens zodat tests niet het net op gaan.

### Fase 4 — Afspelen

- Eén app-brede speler (`MusicLayer`, DOM `<audio>`, patroon van `FocusVideoLayer`).
  **Nooit twee liedjes tegelijk**; wisselen met een fade van ±400ms.
- Bron: `mediaUrl(itemId)`. **Nooit aanroepen als `item.media` ontbreekt** — `resolve_media` gaat via
  `item_media_ref` (`WHERE i.media IS NOT NULL`) en **werpt** dan (`"geen media voor item …"`), het
  geeft geen lege string terug. Link-only liedjes tonen de bronknop en starten geen audio.
- Handmatig: play/pauze op de kaart en in L3.
- **Spatie NIET window-breed**: `FocusVideoLayer.tsx:79-89` claimt spatie al zodra er een video
  gefocust is. De muziek-spatie werkt alleen als L3 open is én het gefocuste item een `song`/`audio`
  is. Start een video, dan pauzeert de muziek en hervat na afloop.
- "Nu speelt"-balkje (titel + artiest + pauze) zolang er muziek speelt. **In kijkmodus (toets E,
  `AppShell.tsx:651`) en chromeless (F11) faadt het weg en keert het terug bij muisbeweging of
  toetsaanslag** — anders verdwijnt de enige manier om de muziek te stoppen. Escape stopt altijd.
- MockBackend: `mediaUrl()` geeft `''` (`backend.ts:1143-1146`) → de speler no-opt op een lege src.

**Gate:** idem + handmatige controle in de app.

### Fase 5 — Wanneer speelt het automatisch (de instelling)

- **`musicAuto`**: `'nooit'` | `'diavoorstelling'` | `'diavoorstelling-en-memory'`.
  **Standaard: `'diavoorstelling'`** — bij het openen van een memory begint er dus standaard géén
  geluid. Eén oplopende keuzelijst: "wel bij het openen maar niet in de diavoorstelling" is geen
  zinnig scenario.
- **`musicVolume`**: 0–100, standaard 60. (`musicLookup` is al in fase 3 geland.)
- **`musicSlideshow`**: `'per-memory'` | `'afspeellijst'` | `'alleen-memory'`, standaard
  `'per-memory'` — zie hieronder.
- **Memory openen**: speelt het eerste liedje van die memory zachtjes; bij verlaten fade-out.

**Diavoorstelling — kan niet zoals oorspronkelijk bedacht.** `Screensaver.tsx:40` schudt álle
foto's, `list_screensaver_photos` (`index.rs:627-676`) geeft alleen item-ids **zonder `event_id`**,
en vanaf de lifeline is de scope alle jaren door elkaar (`AppShell.tsx:2214-2231`). Bij
`diaSpeed` = 7s zou de muziek gemiddeld elke 7 seconden wisselen. Twee opties:

**Jims besluit: dit wordt zélf een instelling**, geen vaste keuze. Nieuwe instelling
**`musicSlideshow`** met drie standen, standaard `'per-memory'`:

- **`'per-memory'`** — `list_screensaver_photos` levert `(item_id, event_id)`, de Screensaver schudt
  de *memories* en houdt de foto's binnen een memory bij elkaar. Dan volgt de muziek echt de memory,
  en de diavoorstelling wordt zelf samenhangender. Verandert het retourtype van
  `getScreensaverPhotos` → dus ook de MockBackend.
- **`'afspeellijst'`** — de liedjes binnen de scope spelen achter elkaar, losgekoppeld van welke foto
  er staat. De bestaande foto-shuffle blijft exact zoals hij is; de koppeling foto↔liedje is weg.
- **`'alleen-memory'`** — muziek klinkt alleen bij de diavoorstelling van één specifieke memory
  (daar klopt de koppeling vanzelf). Vanaf een jaar of vanaf alles blijft het stil, en de shuffle
  blijft ongewijzigd.

**Belangrijk voor het gedrag:** het hergroeperen van de foto's gebeurt ALLEEN als `musicSlideshow`
op `'per-memory'` staat **én** er daadwerkelijk muziek mag klinken (`musicAuto !== 'nooit'`). Staat
de muziek uit, dan is de bestaande diavoorstelling bewijsbaar onaangeroerd — de gedragswijziging
hangt aan een keuze die de gebruiker zelf maakt, niet aan het installeren van deze feature.

Fase 1–4 hangen hier niet van af.

**Gate:** idem + handmatige controle van alle drie de standen.

---

## Bewuste beperkingen (vooraf benoemd)

- **Een Spotify-link wordt nooit een lokaal bestand.** In-app afspelen van Spotify vergt de SDK,
  inloggen én Premium en levert gratis 30 seconden. Dat bouwen we niet.
- **We bewaren de geplakte https-link, nooit een `spotify:`-deeplink.** Een https-only
  opener-scope blokkeert app-deeplinks — dat is een bewuste keuze, geen bug om later te "repareren".
- **Audiobestanden worden de memory-map in gekopieerd**, net als foto's. Hetzelfde nummer in vijf
  memories is vijf kopieën. Bewust: een memory-map moet op zichzelf compleet zijn.
- Geen downloaden van audio uit streamingdiensten.
- **De artiest komt bij Spotify-links vrijwel altijd uit de iTunes-lookup en kan dus fout zijn.**
  Daarom is bewerkbaarheid noodzaak, geen luxe.
- **De iTunes Search API is key-loos maar rate-limited** (~20 req/min per IP), zonder SLA. Een
  mislukte lookup mag nooit blokkeren.
- **Hoesjes zijn auteursrechtelijk materiaal van derden**, lokaal opgeslagen voor persoonlijk
  gebruik. Precies daarom moet `musicLookup` uitzetbaar zijn.
- Een net toegevoegd liedje landt bij een bestaand `_canvas.json` op een rasterpositie die kan
  overlappen — bestaand gedrag, identiek aan geïmporteerde foto's, geen regressie.
- Een liedje met wél `artist` en géén `caption` matcht in FTS, maar de snippet komt uit `i.caption`
  (`index.rs:791, 813-819`) en valt dan door naar body/place/tags → een zoekresultaat met alleen de
  eventtitel. Zeldzaam (de titel is altijd gevuld) en bewust geaccepteerd.

---

## Verwerkte bevindingen

**Ronde 1** (5 CRITICAL, 9 WARNING, 3 OK) — alle 17 gefixt: cover-serveringspad, cover-claim en
-verwijdering, opener-plugin, onjuiste schema-versie-alinea, fase 5 herontworpen, slepen geschrapt,
`spawn_blocking` + URL-encoding, artiest in FTS, fase 2 gesplitst, mock-seed verplaatst,
spatie-scoping, kijkmodus-balkje, endpoint- en bestandsgrootterisico's, motivering `song` vs `audio`.

**Ronde 2** (1 CRITICAL, 11 WARNING, 1 OK) — alle gefixt:

| # | Ernst | Afhandeling |
|---|---|---|
| 1 | CRITICAL | `focus.ts:482` was gemist; nu één gedeelde `thumbRef()` voor beide gates (2a + 2b) |
| 2 | WARNING | `item_thumb_ref` filtert nu op beeld-/video-extensie; voorkomt ook `hash_file` over een grote flac |
| 3 | WARNING | `media_shared` concreet gemaakt (`media = ?2 OR cover = ?2`) + derde regressietest |
| 4 | WARNING | `has_text`-gate uitgebreid met `artist.is_some()` |
| 5 | WARNING | Bewijs verlegd van `media/serve.rs` naar het asset-protocol; `mediaUrl` **werpt** bij link-only → vastgelegd in fase 4 |
| 6 | WARNING | Regelnummers gecorrigeerd (`index.rs:119-124`) |
| 7 | WARNING | `set_song_meta` was een wees; bewerk-tak voor `song` toegevoegd aan 2b |
| 8 | WARNING | MockBackend-stubs per fase benoemd (2a seed, 3 importSong/lookup/setSongMeta, 4 lege src, 5 retourtype) |
| 9 | WARNING | Opener-capability: objectvorm, glob-valkuil, `http://`-normalisatie, `spotify:` als bewuste beperking |
| 10 | WARNING | Fase 1 gesplitst in 1a (lezen) en 1b (schrijven); opener verplaatst naar 2b |
| 11 | WARNING | `duration` uit index/model/TS-types; blijft archiefveld in de frontmatter |
| 12 | WARNING | "hash-suffix" gecorrigeerd naar `{base}_{short8}` met UUID |
| 13 | OK | Niet-werk expliciet vastgelegd (collage/L1/zoeken/`_canvas.json`/oude vaults/inbox/density) |

**Ronde 3** (2 CRITICAL, 3 WARNING, 3 OK) — alle gefixt:

| # | Ernst | Afhandeling |
|---|---|---|
| F1 | CRITICAL | `COLLATE NOCASE` moet **binnen** de haakjes per vergelijking; buiten de haakjes viel de case-insensitieve match stil weg en zou `delete_item` een nog-gebruikt bestand trashen. Extra casing-test toegevoegd |
| F2 | CRITICAL | `thumbRef` type-bewust gemaakt; `cover ?? media` liet een song-met-mp3-zonder-hoesje in een eeuwige 180-frame retry-lus lopen én verborg de placeholder. Mockseed nu alle vier de combinaties |
| F3 | WARNING | `setSongMeta` (command + registratie + interface + beide TS-implementaties) verplaatst naar 2b; 2b haalde zijn eigen `tsc`-gate niet |
| F4 | WARNING | Allow-list vervangen door deny-list op audio; een allow-list zou bmp/tiff/tga/ico/pnm stil uitzetten |
| F5 | WARNING | ~17 mechanische aanraakpunten benoemd (`Item` heeft geen `Default`, `ItemFiles` is een 4-tuple op 5 call sites) + `ItemFiles` wordt een named struct |
| F6 | OK | Waar instellingen leven vastgelegd (`AppShell.tsx:94-183`, localStorage); `musicLookup` toegewezen aan fase 3 |
| F7 | OK | `deleteCurrent` is 2427; link-only degradeert naar `text` niet `audio`; hash is gememoiseerd (één keer per app-start) |
| F8 | OK | `isrc` alleen uit een lokale tag — geen van beide link-API's levert er een |

**Ronde 4** — eindoordeel **bouwrijp: ja**, geen CRITICAL. De drie ronde-3-fixes onafhankelijk
bevestigd (F2 compleet: er zijn aantoonbaar precies twee `.media`-gates in de actieve frontend; de
derde treffer `event.ts:703` is een sorteersleutel). Drie WARNINGs alsnog verwerkt:

| # | Ernst | Afhandeling |
|---|---|---|
| W1 | WARNING | De `VaultService`-schakel ontbrak in de keten; nu vijf genummerde schakels incl. de `slug.ok_or`-guard en **`self.rescan()`** — zonder die rescan blijft de index stale bij een groene gate. Ook voor `import_song` in fase 3 |
| W2 | WARNING | `set_fm_field` → **`set_fm_block`**; de writer documenteert die conventie zelf (`writer.rs:836-838`) en `update_item_meta` schrijft `caption` al zo |
| W3 | WARNING | Plek van de instellingen-UI vastgelegd: `SettingsPanel` (`AppShell.tsx:3071`), nieuwe tab `'muziek'` (union `:3092-3093` + `navBtn` `:3236`) |
| O1 | OK | Motivering bij `focus.ts` gecorrigeerd: de gate-swap fixt song-met-mp3-zonder-hoesje; het link-only geval vergt de **derde tak in `buildContent`** (`focus.ts:117-179`) — dat is echt werk, nu expliciet in 2b |
| O2 | OK | `is_media_file` matcht óók alle audio-extensies → de audio-wrat bestaat al in echte vaults |
