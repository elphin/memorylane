# MemoryLane v2 — Rebuild Plan

*Status: rev. 6 na adversarial review ronde 5. Datum: 2026-07-07.*

## 1. Product (wat we bouwen)

Een local-first "levend plakboek": één doorlopende, inzoombare tijdlijn van je leven.

- **L0 Lifeline** — alle jaren naast elkaar, featured foto's per jaar met verbindingslijnen naar hun gebeurtenis.
- **L1 Jaar** — inzoomen op een jaar: densiteitsbalk, event-clusters, featured foto's boven/onder de lijn.
- **L2 Event-canvas** — foto's "random" verspreid / als automatische collage, tekstblokjes en trefwoorden ertussen; vrij herschikbaar. Het "wow, dat was leuk"-scherm.
- **L3 Focus** — één item groot, met details.

Kern-eisen (van Jim):
- **Soepelheid boven alles**: 60–120fps pan/zoom, knijpen om uit te zoomen, momentum, vloeiende overgangen tussen niveaus, swipen naar volgend event/jaar.
- **Heel makkelijk toevoegen**: event aanmaken, foto's erin slepen, tekst bij een foto, los tekstblokje/trefwoord bij een gebeurtenis.
- **Automatische collages** bij events met veel foto's (random of geordend).
- **Future-proof vault**: de mappenstructuur op schijf is de bron van waarheid. App dood = niets kwijt (Obsidian-model).

## 2. Kernbeslissingen (uit onderzoek juli 2026)

| Beslissing | Keuze | Waarom |
|---|---|---|
| Platform | **Tauri 2.x only** (v2.11.x); browser-build vervalt als product | File System Access API is een dead end (geen Firefox/Safari, ooit); Tauri actief onderhouden, mobiel later mogelijk |
| Index-database | **rusqlite 0.40 + FTS5, WAL** in de Rust-backend; DB in `app_data_dir`, nooit in de vault | Index = weggooibare cache (Obsidian-model). sql.js/plugin-sql/webview-SQLite vervallen. Typed Tauri-commands, geen raw SQL over IPC |
| Bron van waarheid | **Vault-formaat backward-compatibel uitgebreid** (zie §3) zodat de vault écht alles bevat | v1 bewaart featured photos, categorieën, custom uploads en settings alleen in DB — dat moet de vault in |
| Indexer-gedrag | **Indexer is strikt read-only op de vault.** Losse media zonder `.md` worden direct als item geïndexeerd (synthetisch, in-DB, **stabiel ID = hash van vault-relatief pad**); normaliseren naar bestanden alleen via expliciete gebruikersactie of het schrijfpad | v1's indexer muteert de vault tijdens indexeren (`indexer.ts:388-609`) → feedbackloops met de watcher. Stabiel ID voorkomt brekende referenties per index-run |
| File-sync | **notify 8.2 + notify-debouncer-full 0.7** (~500ms) + reconcile-scan bij start (mtime+size; content-hash alleen bij twijfel). **Echo-suppressie** voor eigen writes (pad+generatie-token) | Incrementeel i.p.v. full-rebuild-bij-focus; geen zelf-getriggerde re-index |
| Frontmatter/markdown (Rust) | handmatige `---`-split + **serde-saphyr**, met **lenient fallback-parser = volledige port van v1's parser-semantiek** (`parser.ts`: scalars, arrays, geneste objecten, arrays-van-objecten) wanneer strikte parse faalt; body via **pulldown-cmark** → FTS | v1's YAML-generator produceert output die een strikte parser kan weigeren; een key-string-only fallback zou juist arrays/objecten (`people`, `place`, `featuredPhotos`) verminken |
| Parse-fouten | Nooit stil: indexer logt per bestand, UI toont een **fouten-paneel** met pad + reden | Console-only loggen is onvindbaar dataverlies |
| Thumbnails | **image 0.25 + fast_image_resize 6**; tiers **64/256/1024 + 2048** (2048 on-demand voor L3/4K); **EXIF-orientatie toegepast bij generatie**; cache-key = **content-hash** (eenmalig per bestand, gememoized op mtime+size) in `app_cache_dir` | Pad+mtime-key geeft regeneratie-storm bij map-hernoemen; 1024px is zichtbaar zacht in L3 op 4K |
| HEIC | **libheif-rs 2.7** met `embedded-libheif` (static). L3 toont voor HEIC een on-demand 2048px JPEG via `thumb://` (WebView2 rendert HEIC-originelen niet) | `image` kan geen HEIC; OS-codecs onbetrouwbaar |
| HEVC-video (iPhone `.mov`) | Detectie bij import; playback hangt af van Windows HEVC-codec → **bij import optioneel transcode naar H.264 via ffmpeg** (originelen blijven bewaard), anders duidelijke melding | WebView2 speelt HEVC niet gegarandeerd af |
| Video-thumbs | **ffmpeg-sidecar 2.5**; **ffmpeg gebundeld met de installer** (LGPL-build) — geen runtime-download | Netwerk-afhankelijkheid bij eerste gebruik is onacceptabel local-first |
| EXIF/metadata | **nom-exif 3.6** (JPEG + HEIC + MP4/MOV in één crate) | "wanneer/waar genomen" voor foto én video |
| Media-serving | **Scoped asset protocol** voor bestaande thumbs; **`register_asynchronous_uri_scheme_protocol`** `thumb://` voor generate-on-miss (incl. 2048-tier); Range-support voor video; snelle 404/placeholder | Nooit bytes door IPC; WebView2-valkuil #2509 |
| Renderer | **PixiJS 8.19, WebGL** (geen WebGPU-first) | Pixi's eigen advies; WKWebView/WebKitGTK shippen WebGPU niet betrouwbaar |
| Camera/gestures | **Eigen camera** (`{x,y,zoom}`, zoom-naar-cursor, exponentiële frictie ~0.92–0.95) + **@use-gesture/react**; trackpad-pinch via `wheel`+`ctrlKey` | pixi-viewport 19 mnd stale; semantic zoom vraagt eigen camera-gedrag |
| LOD / semantic zoom | Discrete render-modes per zoomband (L0–L3); thumbnail-ladder als deep-zoom-piramide; **hysteresis** (op bij 1.2×, af bij 0.6×) + korte alpha-crossfade; twee banden alleen tijdens transitie renderen | OpenSeadragon/tldraw-patroon |
| Textures | `createImageBitmap` in **Web Worker**; **max 2 GPU-uploads/frame**; mipmaps aan voor foto-textures; 64px volledig resident (~20MB), LRU ~250× 256px, 1024/2048px alleen L2/L3 + expliciete destroy bij verlaten L3; Pixi TextureGC als vangnet | VRAM-budget iGPU ~256–512MB |
| Tekst op canvas | **BitmapText** voor labels/veel-voorkomende tekst; Pixi `Text` alleen voor unieke, weinig-veranderende elementen | `Text`-rasterisatie is een frametime-killer |
| React | React 19 alleen voor overlays/dialogen; Pixi buiten React-state (ticker-driven, render-on-demand) | Geen re-render-jank; batterij |
| Destructieve acties | **Alles via OS-prullenbak** (`trash`-crate), nooit hard delete; **tekst-snapshot van de vault vóór de eerste v2-write** (zie fase 0) | App vol onvervangbare herinneringen |
| WebView2 | Testen op Jims echte hardware (fase 0-inventarisatie) + 4K-simulatie; renderer-resolutie/backbuffer configureerbaar | Open regressie runtime 142 (#5426); iGPU-default (#5072) |

## 3. Vault-formaat v2 (backward-compatibele extensie)

v1's formaat blijft leesbaar; v2 breidt uit zodat de vault volledig is:

- **`_year.md`** krijgt `featuredPhotos:` in frontmatter — lijst van `{event, item?, x, y, scale, width, height}` (nu alleen in DB-tabel `year_featured_photos`).
- **Custom featured-foto's** (nu base64 in DB): als bestand `_featured.<ext>` in de event-map (**extensie afgeleid uit de MIME van de data-URL**; jpg/png). Referentie via nieuw frontmatter-veld `featuredFile:` — **heeft voorrang op** het bestaande `featuredPhoto:`-slugveld, zodat er geen ambiguïteit is.
- **Item-frontmatter** krijgt `category:` (v1's generator schrijft dit veld nooit — bug: `generator.ts:105-118`).
- **`.memorylane/settings.json`** in de vault-root: custom categorieën + kleuren, timeline-filters, appearance.
- **Vault-pad & first-run**: het vault-pad zelf staat app-lokaal (configbestand in `app_data_dir`). First-run-flow: geen pad geconfigureerd → picker-dialoog (map kiezen of nieuwe map aanmaken); lege vault → lege-staat met "eerste jaar/event toevoegen". Nodig vanaf fase 1 (dev) en fase 5 (UI).
- **Ignore-lijst** scanner: `.memorylane/`, verborgen mappen, `index.db` (v1-artefact in vault-root — migratie ruimt op). **Harde regel: bestanden met `_`-prefix zijn specials en worden nooit als (synthetisch) item geïndexeerd** — anders verschijnt `_featured.<ext>` als extra foto op het canvas en breekt de migratie-invariant. Fixture-geval verplicht.
- **`_canvas.json`-eigenaardigheden** (voor de Rust-reader): `itemSlug` kan een UUID zijn; slug-matching case-insensitive (Windows); `viewport`/`updatedAt` optioneel; dangling slugs tolereren.

**One-time migratie v1→v2** (fase 2), input = uitsluitend v1's `index.db` (standaard SQLite; rusqlite opent het direct):
- Schrijft naar de vault: featured photos incl. posities (→ `_year.md`), custom uploads (→ `_featured.<ext>`), item-categorieën (→ item-frontmatter), custom categorie-definities uit DB-meta (→ `settings.json`).
- **localStorage doet níet mee**: v1 draait in de browser (ander origin dan de Tauri-webview), dus die data is voor v2 onbereikbaar én onbelangrijk — alleen timeline-filters, dark mode en slideshow-instellingen; die stelt Jim in 2 minuten opnieuw in. Bewuste keuze: verlies geaccepteerd.
- **Migratie-input: een kopie van `index.db`, nooit het live bestand.** Kritiek: v1 mag vóór de eerste kopie NIET meer geopend worden — v1's focus-sync doet bij elke file-drift een full rebuild die `items.category`, `featured_photo_data` en `meta.custom_categories` wist (`syncService.ts:73-84` → `indexer.ts:86-87`; alleen `year_featured_photos` overleeft). Kopieën zijn **getimestamped en append-only**; de fase 0-kopie in de snapshot is onveranderlijk. **Input-keuzeregel** (v1 blijft immers in gebruik tot pariteit): de nieuwste kopie die (a) de versheids-check haalt (entity-counts in de kopie vs. actuele bestandsscan) én (b) waarvan de probe-curatiecounts ≥ die van de fase 0-kopie zijn. De harde stop-bij-afwijking geldt alleen voor déze primaire kandidaten. **Fallback**: de fase 0-kopie zelf — versheids-gecheckt tegen het fase 0-snapshot-manifest (slaagt per constructie); het verschil met de live vault wordt gerapporteerd en vergt expliciete bevestiging van Jim vóór de migratie doorgaat; sindsdien verdwenen doelen vallen onder de dangling-skip hieronder.
- **Dangling curatierijen**: rijen in de kopie waarvan het doel-event/-item niet (meer) in de bestandsscan voorkomt worden gelogd + geskipt en **expliciet uitgesloten van de 1:1-migratie-invariant** (analoog aan de dangling-slug-tolerantie voor `_canvas.json`) — anders faalt de verificatie spurieus op v1-restjes.
- Daarna: YAML-normalisatiepass (lenient inlezen → strikt herschrijven), `index.db` uit de vault verwijderen (pas ná geslaagde verificatie).

## 4. Hergebruik uit v1

- **Vault-formaat & markdown-schema** — basis blijft; uitgebreid per §3.
- **UI-componenten geport & opgeschoond**: PhotoViewer, AudioViewer, LinkViewer, TextViewer, QuickAdd-flow, EventPropertiesDialog, SearchModal, Settings-structuur, ConfirmDialog, TagInput, CategorySelect.
- **Domeinlogica/lessen**: collage-maten, categoriekleuren, item-type-kleuren, EXIF→datum-gedrag, featured-photo-model, filterinstellingen.
- **Vervalt**: sql.js, File System Access API, IndexedDB-caches, localStorage-persistence, heic2any, JS-exif, full-rebuild-on-focus, vault-muterende indexer, de 5.300-regel `Timeline.tsx`.

## 5. Fases (Review-Loop: per fase groen → adversarial review → commit op master)

**Fase 0 — Veiligstellen & skelet**
- Ongecommit v1-werk committen.
- **Eerst, vóór v1 nog één keer te openen: `index.db` uit de vault-root kopiëren naar de snapshot-locatie.** (v1 openen kan via de focus-sync een rebuild triggeren die curatiedata uit de DB stript — de kopie is de migratie-input.)
- **Read-only probe op die kopie** (rusqlite/sqlite3): counts van items met `category`, events met `featured_photo_data`, aanwezigheid `meta.custom_categories`, count `year_featured_photos`. Dit is meteen de inventaris van wat er te migreren valt — én verwachtingsmanagement: eerdere v1-rebuilds kunnen een deel al historisch gewist hebben; dat weten we dan vóór fase 2, niet erna. (Geen force-save: die heeft geen herstelwaarde — v1 laadt bij start toch uit `index.db` — en riskeert juist de strip.)
- **Vault-snapshot**: de `index.db`-kopie + alle `.md`/`.json`-bestanden + **hash-manifest van media** (geen volledige media-kopie — v2 wijzigt geen bestaande media; alleen tekstbestanden worden herschreven en `_featured.<ext>` toegevoegd). Vrije-schijfruimte-check.
- **Hardware-inventarisatie**: GPU (i/dGPU), monitor-resolutie(s), refresh rate — bepaalt de fase 4-gate.
- Nieuwe mappenstructuur; Rust-dependencies; groen-definitie: `tsc`, `cargo clippy`, `cargo test`, `vite build`.

**Fase 1 — Rust index-core (read-only)**
- Vault-scanner (incl. `_year.md`, `_canvas.json`, ignore-lijst) → SQLite; reconcile (nieuw/gewijzigd/verwijderd/hernoemd — identiteit via `id` in frontmatter).
- **Leest vault-v2-velden vanaf dag één** (`featuredPhotos` in `_year.md`, `featuredFile`, `category`, `settings.json`) — vereist voor de fase 2-verificatie.
- Frontmatter: strikt (serde-saphyr) + lenient fallback (volledige v1-parser-semantiek); fouten-rapport als data-structuur.
- Losse media → synthetische items (stabiel ID = pad-hash; geen vault-writes).
- Vault-pad-config + picker-command (first-run-flow, §3).
- Unit-tests met **volledig synthetische fixture-vault** (structuur van de echte vault nagebootst met dummy-afbeeldingen van enkele KB; incl. rot-gevallen: backslash+quote in captions, `[`-prefix titels, ontbrekende frontmatter, UUID-slugs in `_canvas.json`, dangling slugs, HEIC, `_featured.jpg` zonder eigen `.md`). **Jims echte vault alleen als lokale, niet-gecommitte smoke-test.**
- Typed commands: `list_years`, `get_year`, `get_event`, `get_timeline_density`, `get_index_errors`.

**Fase 2 — Vault-formaat v2 + one-time migratie**
- Formaat-extensies uit §3 (writer-kant minimaal: wat migratie nodig heeft).
- Migratie per §3 (incl. versheids-sanity-check).
- **Verificatie, twee invarianten:**
  1. *Normalisatie-invariant*: geparste domeindata vóór en ná de YAML-normalisatiepass is identiek (byte-verschillen in YAML toegestaan, semantiek niet).
  2. *Migratie-invariant*: index-rebuild-ná = index-rebuild-vóór **plus exact de niet-dangling curatiedata uit de `index.db`-kopie** (counts én inhoud van featured photos, custom uploads, categorieën, settings matchen 1:1; gelogde/geskipte dangling rijen per §3 uitgezonderd).
- `index.db` opruimen pas ná geslaagde verificatie.

**Fase 3 — Media-pipeline**
- Thumbnail-generatie (4 tiers, content-hash cache-key, EXIF-orientatie), `thumb://` protocol, asset-scope.
- EXIF/HEIC/video-thumbs; achtergrond-queue met voortgang-events. ffmpeg gebundeld.
- Vroeg risico afdekken: libheif static build op Windows testen; HEVC-detectie + transcode-optie.

**Fase 4 — Render-core (bewijslast: soepelheid)**
- Camera + gestures + ticker + texture-pipeline + LOD-manager.
- **Gate:** gemeten op **Jims echte hardware (fase 0-inventarisatie)**, met 4K-belasting gesimuleerd via geforceerde renderer-resolutie/DPR als er geen 4K-scherm is: (a) 5.000 sprites pan/zoom, (b) decode→upload-storm tijdens snelle pan over foto-dense content, (c) LOD-crossfade met twee banden tegelijk. Criterium: **1%-low frametimes ≤ 16.6ms**. Fps/frametime-overlay in dev.

**Fase 5 — L0 + L1 op echte data**
- Lifeline met featured foto's (uit `_year.md`) + verbindingslijnen; jaar-view met densiteit, clusters, random-fill collage; jaar-navigatie. First-run/lege-vault-flow in de UI.

**Fase 6 — L2 event-canvas**
- Automatische collage (eerst: grid + jitter), drag met physics, tekstblokjes/trefwoorden, knijp-uit, swipe naar volgend event.
- **Canvas-layout write-through in déze fase** (`_canvas.json` persisteren).

**Fase 7 — L3 focus + viewers**
- Focus-view (2048-tier / on-demand JPEG voor HEIC) + sibling-navigatie; geporte viewers (Photo/Audio/Link/Text) integreren.

**Fase 8 — Toevoegen & bewerken (write-through naar vault)**
- QuickAdd, event-properties, featured-foto-keuze, edit; delete → **prullenbak**.
- Schrijfpad: eerst bestand, dan index (volgorde van v1; semantiek níet): **unieke slugs verplicht** (v1 had collision-overschrijving, `writer.ts:345`), rename behoudt ID-suffix in medianamen.

**Fase 9 — Live sync, search, settings**
- notify-watcher + echo-suppressie + events naar frontend; FTS5-search + SearchModal; settings-UI (leest/schrijft `.memorylane/settings.json`); indexfouten-paneel.

**Fase 10 — Polish**
- Overgangen finetunen, keyboard-nav, onboarding-verfijning, performance-tuning, installer (incl. ffmpeg-bundel + licenties).

## 6. Risico's & mitigatie

| Risico | Mitigatie |
|---|---|
| Curatie-dataverlies bij migratie | Twee expliciete verificatie-invarianten (fase 2); versheids-sanity-check; snapshot (fase 0); `index.db` pas opruimen ná verificatie |
| Strikte YAML-parser weigert v1-bestanden | Lenient fallback (volledige v1-semantiek) + normalisatiepass + fouten-paneel; rot-gevallen in fixtures |
| WebView2-regressies (4K, iGPU) | Fase 4-gate op 1%-lows op echte hardware + 4K-simulatie; renderer-resolutie configureerbaar |
| libheif static linking op Windows | Fase 3 direct testen; fallback: HEIC bij import naar JPEG converteren (v1-gedrag) |
| Watcher-feedbackloop | Indexer read-only + echo-suppressie (generatie-token) |
| v1-focus-sync stript curatiedata vóór migratie | Getimestampte append-only kopieën; fase 0-kopie onveranderlijk in snapshot; input-keuzeregel §3; read-only probe inventariseert wat er is |
| Verouderde `index.db` als migratie-input | Counts-vergelijking kopie vs. bestandsscan; stop bij afwijking geldt voor primaire kandidaten; fallback op fase 0-kopie met gerapporteerd verschil + expliciete bevestiging (§3) |
| Scope-creep collage/features | Collage v1 = grid + jitter; slimme layouts pas in fase 10 |
| Rebuild duurt te lang / motivatieverlies | Elke fase zichtbaar resultaat + commit; v1 blijft werkend tot pariteit |

## 7. Open punten

- Vault-locatie op Jims machine: bij fase 0 verifiëren (nodig voor snapshot, counts-check en smoke-test).
- Mobiel (Tauri iOS/Android) buiten scope voor v2.0; architectuur blokkeert het niet.
- Cloud-sync buiten scope; vault + Syncthing/Dropbox dekt de behoefte.
