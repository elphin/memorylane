# Personalisatie-plan — MemoryLane

> Status: fase 1 t/m 5 GEBOUWD (zie de "Fase N personalisatie"-commits van
> 2026-07-19); alleen fase 6 (decoratie & sfeer-extra's) staat nog open als
> aparte beslissing. Doel: gebruikers laten personaliseren hoe hun
> tijdlijn en herinneringen eruitzien — fonts, kleuren, achtergronden, patronen,
> foto-frames — op app-, jaar-, event- en item-niveau, zonder de 60fps-rendering
> of het local-first vault-model te breken.

## 1. Visie

MemoryLane moet voelen als een **persoonlijk fotoalbum**, niet als een app die
foto's toont. Onderzoek naar fotoboek-makers (Mixbook, Shutterfly, Artifact
Uprising), scrapbook-apps (GoodNotes, Zinnia, Project Life), journals (Day One,
Journey) en memory-apps (Apple Photos Memories, Google Photos) levert één
duidelijke winnende formule op:

1. **Gecureerde thema-pakketten** in plaats van losse font-/kleur-dropdowns.
   Eén thema = palet + achtergrond/textuur + font-pairing + frame-stijl, zodat
   het resultaat altijd samenhangt ("één klik → alles klopt").
2. **Een cascade-model** (app → jaar → event → item) waarbij elk niveau alleen
   overschrijft wat de gebruiker aanraakt — zoals CSS. Niet-destructief: thema
   wisselen gooit nooit handmatige keuzes weg, en elke override is per niveau
   terug te zetten naar "geërfd".
3. **Foto-first**: thema's laten foto's stralen; decoratie is spaarzaam en
   verschijnt pas op canvas-niveau (L2/L3), nooit op de drukke tijdlijn-niveaus.

Het unieke MemoryLane-voordeel dat geen enkele onderzochte app heeft: thema's
zijn koppelbaar aan **tijd**. Een jaar of periode kan zijn eigen sfeer hebben
(een 80s-jaar in warme Kodachrome-tinten, een kerstperiode in gedempt
rood/groen), waardoor uitzoomen over de lifeline letterlijk door de sfeer van je
leven scrollt.

### Valkuilen uit het onderzoek (en hoe we ze vermijden)

| Valkuil | Mitigatie |
|---|---|
| Keuze-overload (Canva-effect) | Gecureerde presets als hoofdpad; vrije kleur-/fontkeuze pas in een "geavanceerd"-laag, en pas in een latere fase |
| Lelijke combinaties | Font-*pairings* en paletten als pakket, geen losse dropdowns |
| Design "kapotmaken" | Cascade + "herstel naar geërfd" per niveau; overrides los van het thema opgeslagen |
| Goedkoop skeuomorfisme | Liever 6–10 uitstekende texturen/frames dan 50 middelmatige; decoratie (stickers/washi) pas in een latere, optionele fase |
| Performance-degradatie | Texturen als kleine tiling-assets; LOD-regels (zie §7); in-app fps-meting vóór/na elke render-fase (zie §9) |
| Thema-lock-in | Overrides overleven een themawissel (alleen niet-overschreven tokens veranderen mee) |

## 2. Huidige stand (v2-architectuur)

De live app is de v2: `main.tsx → app/Root.tsx → app/AppShell.tsx` +
`src/render/*` (PixiJS 8). **`src/App.tsx` en `src/timeline/Timeline.tsx` zijn
v1-restanten en blijven buiten scope** — daar wordt niets aan gedaan.

Relevante feiten:

- **Rendering**: `src/render/scenes/lifeline.ts` (L0), `year.ts` (L1),
  `event.ts` (L2), `focus.ts` (L3), aangestuurd door `render/core/engine.ts`
  (met `TextureManager` en LOD in `render/core/lod.ts`). Alle kleuren en fonts
  zijn **hardcoded** in de scenes (bijv. jaartegel-fill `0x1a2030`, app-bg
  `0x0a0a0f`, `fontFamily: 'Segoe UI, sans-serif'`, span- en
  placeholder-paletten in `year.ts`).
- **Data**: de vault (markdown + frontmatter) is de bron van waarheid. De Rust
  backend (`src-tauri/src/model.rs`, `vault/*`, `index.rs`, `commands.rs`)
  parset en schrijft frontmatter; de frontend praat via `src/lib/backend.ts`
  (Tauri-invoke + mock voor browser-dev).
- **Bestaand patroon voor per-entiteit-instellingen**: `set_year_cover`,
  `set_year_size_factor`, `set_event_size`, `set_event_under_construction` —
  elk als Rust-command dat **file-first** de frontmatter bijwerkt
  (`vault/writer.rs`) en daarna een **volledige rescan** doet
  (`commands.rs` → `rescan()` = `vault::scan` + `index::load`). Dat pad is
  bewezen snel genoeg (elke caption-edit doet dit al). Theming volgt exact
  dit patroon — geen apart in-memory-mutatiepad.
- **App-voorkeuren** (geen vault-data) staan in `localStorage` via het
  `Settings`-object in `AppShell.tsx`, met een instellingen-overlay in de DOM.
- **Geen theming-infrastructuur**: geen design-tokens-module, geen
  fontloading (systeemfontstack), geen thema-state richting Pixi.

## 3. Ontwerpprincipes

1. **Presets eerst, knoppen later.** V1 van deze feature levert gecureerde
   thema's; een vrije kleur-/fontkiezer is een expliciete latere fase.
2. **Cascade, niet-destructief.** `app-default → jaar → event → item`. Een
   niveau slaat alleen op wat expliciet gekozen is; al het andere erft.
   "Herstel naar geërfd" wist alleen de keuze op dát niveau.
3. **Sfeer boven, vorm onder.** Hoge niveaus (app/jaar/event) bepalen sfeer
   (palet, achtergrond, typografie); item-niveau bepaalt alleen vorm
   (frame-stijl, hoeken). Zo blijft de matrix van combinaties beheersbaar.
4. **Local-first.** Fonts en texturen worden **gebundeld als app-assets**
   (woff2 + kleine tiling-WebP's). Geen CDN, geen netwerk. Thema-keuzes staan
   in de vault-frontmatter en reizen dus mee met de data (sync/backup gratis).
5. **Forward-compatible.** Onbekende thema-id's of tokens in frontmatter
   worden genegeerd met fallback naar default (oudere app-versie ↔ nieuwere
   vault mag nooit crashen of data weggooien).
6. **60fps is een harde eis.** Elke fase eindigt met een check in de
   perf-harness; LOD-regels bepalen wat op welk zoomniveau gerenderd wordt.

## 4. Kernconcept: thema's en tokens

### 4.1 ThemeSpec (gecureerd, in code)

Thema's zijn **code-gecureerde pakketten** in een frontend-registry
(`src/theme/registry.ts`). De vault verwijst alleen naar een `id` (+ eventuele
overrides); de definitie zelf leeft in de app. Nieuwe thema's toevoegen = een
app-update, wat curatie-kwaliteit garandeert.

```ts
interface ThemeSpec {
  id: string            // 'classic-dark' | 'warm-linen' | 'kodachrome' | ...
  name: string          // getoonde naam
  colors: {
    appBg: number       // canvas-achtergrond (Pixi hex)
    surface: number     // donkere vlakken: L0-jaartegels (nu 0x1a2030)
    surfaceStroke: number
    paper: number       // tekstkaart-"papier" (nu crème 0xfffdf5)
    paperStroke: number // tekstkaart-rand (nu 0xe0dccb)
    paperInk: number    // tekstkaart-inkt (nu 0x2b2b2b)
    text: number        // primaire tekst
    textMuted: number   // sublabels, maandlabels, leaders
    accent: number      // spans, hoogtepunten
    frame: number       // fotorand-kleur (nu 0xf5f5f0)
    spanPalette: number[]        // meerdaagse events (L1)
    placeholderPalette: number[] // kaarten zonder foto (L1)
  }
  fonts: {
    title: FontRef      // jaartitels, eventtitels
    body: FontRef       // teksten, tellers
    caption: FontRef    // captions (bijv. handschrift)
  }
  background: {
    kind: 'solid' | 'texture'
    textureId?: string  // verwijst naar gebundelde tiling-asset
    tint?: number       // tint over de textuur
  }
  frameStyle: 'plain' | 'polaroid' | 'rounded' | 'none'  // default frame per foto
  uiMode: 'dark' | 'light' // stuurt de DOM-overlay-styling (panelen, knoppen)
}

interface FontRef {
  family: string
  files?: { weight: number; file: string }[] // gebundelde woff2-cuts
}
// Titels renderen op weight 600/700 (zoals nu in de scenes). Voor gebundelde
// thema-fonts wordt daarom óók een bold-cut meegebundeld (of een cut met
// voldoende eigen gewicht die op 400 als titel dient) — nooit vertrouwen op
// browser-gesynthetiseerde faux-bold op het Pixi-canvas.
```

**V1-registry: 8 thema's**, gerangschikt van ingetogen naar sfeervol:

| id | Sfeer | Kern |
|---|---|---|
| `classic-dark` | huidige look (default) | donker navy, Segoe UI, witte frames — pixel-identiek aan nu |
| `classic-light` | licht, clean | ivoor/wit, donkere tekst |
| `warm-linen` | linnen album | linnen-textuur, serif-titels, crème |
| `kraft` | scrapbook | kraft-papier, typewriter-titels, handschrift-captions |
| `kodachrome` | jaren '70–'90 | warme film-tinten, gedempt palet |
| `ocean` | fris | koel blauw/groen palet |
| `dusty-rose` | zacht | roze/sage pastels, serif |
| `noir` | minimaal | zwart/wit/grijs, strak sans |

Elk thema definieert álle tokens (geen gedeeltelijke thema's), zodat de
resolver simpel blijft. Let op de dubbelrol die er níét is: L0-jaartegels
(donker) en tekstkaarten (crème papier) zijn bewust **aparte** tokengroepen
(`surface` vs `paper*`) — één gedeeld token zou fase 1 al op de
pixel-identiek-eis laten falen.

**Bewust niet themable** (status-markers, geen decor — blijven vast over alle
thema's): de gouden featured-ring (`0xffc24b`), de blauwe jaar-cover-ring
(`0x4b9bff`), de amber "in aanbouw"-badge (`0xe8a54a`), de play-badge en de
witte keyboard-focus-ringen. Die betekenis moet in elk thema herkenbaar
blijven.

### 4.2 Overrides en cascade

Naast een thema-id kan elk niveau een klein aantal **override-tokens** zetten
(v1 bewust beperkt):

```ts
// Eén canonieke vorm over alle lagen: frontmatter = Rust-wire = TS.
// (Rust: struct met dezelfde veldnamen, serde rename_all = "camelCase".)
interface ThemeChoice {
  id?: string         // kies een ander thema vanaf dit niveau
  accent?: string     // '#rrggbb' — accentkleur-override
  background?: string // andere textuur/solid uit de gecureerde lijst
  titleFont?: string  // andere titel-font uit de gecureerde lijst
}
```

De veldnamen in de frontmatter (`theme: {id, accent, background, titleFont}`),
de Rust-struct en de TS-interface zijn identiek — zelfde afspraak als bij
bestaande velden (`sizeFactor` ↔ `size_factor` ↔ `sizeFactor`).

Resolutie (`resolveTheme`): begin met het app-default-thema, pas daarna per
niveau (jaar → event) eerst `id` toe (= volledige tokenset van dat thema)
en dan de losse overrides van dat niveau. Item-niveau kent alleen
`frameStyle`. Resultaat is een platte `ResolvedTheme` (alle tokens concreet),
gecachet per event/jaar en geïnvalideerd bij wijziging.

## 5. Datamodel & persistentie

### 5.1 Vault-frontmatter (bron van waarheid)

`_year.md` en `_event.md` krijgen een optioneel `theme:`-veld. **Geschreven**
wordt het als één regel (inline flow-map), omdat de bestaande writer-mechaniek
(`set_fm_block` in `vault/writer.rs`) een genest blok kan vervangen door één
regel maar geen meerregelige blokken schrijft:

```yaml
theme: {id: warm-linen, accent: "#c47b4f", background: kraft, titleFont: typewriter}
```

**Gelezen** worden beide vormen (de Rust-frontmatter-parser ondersteunt zowel
geneste blokken als inline flow-maps), zodat handbewerkte vaults ook werken.

Item-sidecars (`<slug>.md`) krijgen optioneel `frame: polaroid` (scalar, via
de bestaande `set_fm_field`-mechaniek).

- Afwezig veld = erven van bovenliggend niveau (de overgrote meerderheid).
- Rust behandelt de theme-waarden als **opake strings** (de thema-registry
  leeft in de frontend; Rust valideert id's niet — dat zou de id-lijst op
  twee plekken dupliceren). Validatie + stille fallback naar default gebeurt
  in de frontend-resolver. `IndexError`s blijven voorbehouden aan structureel
  kapotte YAML (bestaand gedrag).
- Synthetische events/items (zonder eigen `.md`) kunnen geen eigen thema
  hebben — zij erven altijd. De UI verbergt de kiezer daar (zelfde regel als
  bestaande curatie: "Curatie is er niet mogelijk").

### 5.2 Rust-backend

Volgt het `set_event_size`-patroon één-op-één:

- `model.rs`: `Year.theme: Option<ThemeChoice>`, `Event.theme:
  Option<ThemeChoice>`, `Item.frame: Option<String>` (serde, camelCase,
  `skip_serializing_if`; alle subvelden opake `Option<String>`s).
- `vault/scanner.rs` (waar `cover`/`size`/`under_construction` e.d. nu
  daadwerkelijk uit de frontmatter gelezen worden): `theme:`-map en `frame:`
  lezen; onbekende subvelden tolerant negeren.
- `index.rs`: kolommen in het SQLite-`SCHEMA`, vullen in `load()`, en
  meegeven in de query's + DTO's (`list_years` → `YearSummary`, `get_year` →
  `YearDetail`/`EventSummary`, `get_event` → `EventInfo`/items). Geen
  migratiezorg: de index is in-memory en wordt per start herbouwd.
- `vault/writer.rs`: `set_year_theme`, `set_event_theme` (flow-map schrijven
  of veld verwijderen bij `None`, via `set_fm_block`) en `set_item_frame`
  (scalar via `set_fm_field`) — regel-gebaseerd, rest van het bestand blijft
  intact, atomair via temp+rename (bestaande mechaniek).
- `commands.rs`: bijbehorende commands volgens het bestaande patroon:
  frontmatter schrijven → `rescan()`.
- Rust-tests naast de bestaande writer-/parser-tests: roundtrip (schrijven →
  parsen → zelfde waarde), verwijderen, onbekende velden tolereren.

### 5.3 Frontend-API

`lib/backend.ts` (`Backend`-interface, Tauri + mock):

```ts
setYearTheme(yearId: string, theme: ThemeChoice | null): Promise<void>
setEventTheme(eventId: string, theme: ThemeChoice | null): Promise<void>
setItemFrame(itemId: string, frame: string | null): Promise<void>
```

`YearSummary`, `YearDetail`, `EventSummary` (draagt het per-event-accent op de
L1-kaarten en -spans), `EventInfo`/`EventDetail` en `Item` krijgen de
bijbehorende optionele leesvelden, zodat de scenes bij het laden meteen de
juiste tokens kunnen resolven. `EventDetail` krijgt daarnaast een
`yearTheme?: ThemeChoice` mee, zodat `getEvent` zelfvoorzienend is voor de
L2/L3-cascade (app → jaar → event) zonder te leunen op een mogelijk verouderde
jaren-cache in de frontend — zelfde precedent als het bestaande
`EventDetail.yearCover`-veld. De mock-backend ondersteunt dezelfde velden
in-memory (browser-dev blijft volledig werken).

### 5.4 App-default

Het app-brede default-thema is een UI-voorkeur, geen vault-data → veld
`themeId` in het bestaande `Settings`-object (localStorage) in `AppShell.tsx`.
Default: `classic-dark` (huidige look).

## 6. Fonts & texturen (assets)

- **Fonts**: per thema maximaal 2 nieuwe families; families worden gedeeld
  tussen thema's (3 thema's draaien op de systeemstack), dus totaal ~4–5
  families × 1–2 cuts (regular + bold voor titel-families) ≈ **≤ ~10
  woff2-bestanden** (subset Latin incl. NL-diacritics). Kandidaten met open
  licentie (OFL):
  bijv. Lora/Source Serif (serif), Special Elite/Courier Prime (typewriter),
  Caveat (handschrift), Inter (sans). **Alle gebundelde cuts worden eager
  geladen bij app-start** via de `FontFace`-API (≤ ~10 lokale
  woff2-subsets, verwaarloosbare kosten) — bewust niet lazy, want vanaf
  fase 3 rendert één lifeline-scene fonts uit meerdere jaar-thema's tegelijk
  en zou een lazy geladen font geen herteken-trigger hebben. Pixi `Text`
  gebruikt daarna gewoon `fontFamily`. Fallback: zolang een font niet geladen is,
  rendert de systeemstack; de eerste scene-opbouw wacht op
  `document.fonts.ready` (of hertekent eenmalig zodra de eager load klaar
  is), met `fonts.load()` mét weight-descriptor per cut.
- **Texturen**: kleine naadloze tiles (~256–512px, WebP, elk ≤ ~50 KB):
  linnen, kraft, aquarel-papier, subtiel korrel. Gerenderd als
  `TilingSprite` op de achtergrondlaag van de engine (achter `world`), getint
  met de thema-tint, en meebewegend/schalend met de camera op L2 (op L0/L1
  statisch of uit — zie LOD). Thema-tiles gaan **niet** door de
  `TextureManager` (dat is een LRU met eviction voor item-thumbnails; een
  geëvicte achtergrondtexture zou zwarte flitsen geven) maar worden apart
  geladen via Pixi Assets en blijven in bezit van de theme-laag.
- Beide assetgroepen zitten in het Vite-bundle/Tauri-package; geen runtime
  downloads.

## 7. Rendering-integratie

### 7.1 Token-refactor (fundament)

Nieuwe module `src/theme/`:

- `tokens.ts` — `ResolvedTheme`-type + `CLASSIC_DARK` met exact de huidige
  hardcoded waarden.
- `registry.ts` — de 8 `ThemeSpec`s.
- `resolve.ts` — cascade-resolver + cache (`Map<scopeId, ResolvedTheme>`),
  invalidatie-API.

De vier scenes + engine vervangen hun hardcoded kleuren/fonts door lezen uit
een `ResolvedTheme` die per scene-node wordt aangeleverd (lifeline: per
jaartegel het jaar-thema; year-scene: het jaar-thema + per event-kaart/-span
het event-thema-accent; event/focus-scene: het event-thema). Ook **afgeleide
kleuren worden geparameteriseerd**: `opaqueSpan` in `year.ts` blendt de
span-kleuren nu tegen hardcoded `0x0a0a0f` en de dot-stroke is een afgeleide
van de surface-kleur — die blends moeten tegen de thema-tokens rekenen,
anders is een licht thema in fase 2 stilletjes kapot. Stap één is een pure
refactor met alléén `CLASSIC_DARK` — bewijsbaar geen visueel verschil.

### 7.2 Thema-wissel op runtime

Bij een thema-wijziging worden de betrokken scenes opnieuw opgebouwd — geen
per-frame kosten, alleen een eenmalige rebuild bij wijzigen. Het wissel-pad
zet daarnaast ook de Pixi-Application-achtergrondkleur
(`engine.app.renderer.background.color = appBg`) — die wordt nu éénmalig
gezet bij `app.init` en is geen onderdeel van een scene, dus een rebuild
alleen raakt hem niet. Belangrijk: de
bestaande `rebuildLifeline` in `AppShell.tsx` destroyt de scene en **reset
naar L0** — die is dus alleen bruikbaar als de gebruiker op L0 staat. De
regel is: **herbouw alleen de scene van het huidige niveau en behoud niveau +
camerapositie.**

- App-themawissel vanuit instellingen: herbouw de actieve scene op zijn
  plaats (L0: lifeline herbouwen zonder reset; L1/L2/L3: het bestaande
  her-enter-pad — zoals settings-patches al `enterYear` opnieuw draaien en
  het event-formulier na `setEventSize` `enterEvent` — met expliciet herstel
  van camera/zoomstand).
- Jaar-/event-themawissel: alleen de betreffende scene verversen via
  datzelfde her-enter-pad; de kiezer-overlay blijft open (live preview).
  Belangrijk: het bestaande her-enter-pad speelt altijd een
  exit/reveal-crossfade met zoom-animatie — voor het preview-pad komt er een
  **animatieloze variant** (exit zonder animatie + reveal-snap, analoog aan
  de bestaande `snap`-parameter van `applyLayout`), anders voelt elke
  themaklik als een herlaad-effect.

DOM-overlays (instellingen, panels) lezen de tokens via een kleine
React-hook (`useTheme`). **Scope-keuze:** `uiMode` (dark/light van de
overlay-chrome) volgt uitsluitend het **app-default-thema** — niet het thema
van het jaar/event waar je toevallig bent, anders flipt de instellingen-
overlay van donker naar licht tijdens het navigeren. Kanttekening bij de
omvang: `AppShell.tsx` bevat ruim 100 hardcoded hex-kleuren in inline styles,
waarvan ~19 als `React.CSSProperties`-constanten op module-scope; die kunnen
geen hook lezen en moeten worden omgezet naar factory-functies die een
theme-object aannemen. Dit is een substantiële maar mechanische refactor en
staat als expliciete substap (2b) in de fasering.

### 7.3 LOD-regels voor theming

| Niveau | Wat themable zichtbaar is |
|---|---|
| L0 lifeline | per-jaar: tegelkleur/stroke, titel-font, accent. Achtergrond = app-/default-thema (solid; textuur alleen als statische, niet-meeschalende laag) |
| L1 jaar | jaar-palet (as, leaders, span-/placeholderpalet), fonts; event-kaarten tonen hun accent; een **period of event met eigen thema kleurt zijn span-balk met zijn accent-token** (i.p.v. de chronologische index-rotatie over het spanpalet) — zo is "een kerstperiode in rood/groen" daadwerkelijk zichtbaar op de tijdlijn; géén per-event texturen |
| L2 canvas | volledige event-thema: achtergrond-textuur (TilingSprite), frames, fonts, kleuren |
| L3 focus | idem L2, plus caption-styling volledig |

Zo blijft het aantal gelijktijdige texturen ≤ 1 per zichtbare scene en blijven
L0/L1 (veel objecten) puur vector + tekst, net als nu.

## 8. UI

1. **Instellingen → nieuw tab/sectie "Uiterlijk"**: thema-grid met previews
   (mini-tegel met palet + fontnaam in eigen font). Kiezen = direct toepassen.
2. **Jaar-thema**: er bestaat nog géén jaar-bewerk-UI (de jaar-cover wordt
   via een klik-gesture gezet, de size-factor heeft nu geen UI) — er komt dus
   een **nieuw, klein jaar-paneel** (bereikbaar vanaf L1, zelfde
   overlay-stijl als de bestaande panelen) met vooralsnog één sectie:
   "Thema: [geërfd ▾]" → thema-grid + "Herstel naar geërfd". Dit nieuwe
   oppervlak is expliciet meegerekend in de omvang van fase 3.
3. **Event-thema**: in het event-bewerk-paneel (waar titel/datum/belang
   zitten): thema + accent + achtergrond + titel-font, elk met
   geërfd-als-default.
4. **Item-frame**: in het foto-bewerk-paneel (caption/datum/mensen/tags): een
   frame-keuze (geërfd / geen / kader / polaroid / afgerond).
5. Overal geldt: de kiezer toont wat er nú geërfd wordt ("Geërfd: Warm linnen
   (van 1987)"), en een wijziging is per direct zichtbaar op de tijdlijn
   erachter (live preview, gewoon door de wijziging toe te passen — annuleren
   = terugzetten).

Bediening consistent met de bestaande overlays (zelfde stijl als
instellingen-/bewerk-panelen in `AppShell.tsx`, Escape sluit, registratie als
open overlay).

## 9. Fasering

Elke fase is afzonderlijk shipbaar, eindigt objectief groen (`npm run build`
= tsc + vite; `cargo test`/`cargo check` voor Rust-fases) en gaat door de
review-loop + commit. **Perf-acceptatie**: de bestaande harness (`?perf`)
rendert een synthetische scene en meet themawijzigingen dus niet — perf wordt
daarom **in de echte app** gemeten (op een echt jaar met veel events en een
canvas met honderden items), vóór en na de fase. Zo'n in-app fps-overlay
bestaat nog niet; die komt er als klein debug-item in fase 1 (togglebaar,
zelfde teller-aanpak als in de harness).

**Fase 1 — Token-fundament (refactor, geen gedragswijziging)**
`src/theme/tokens.ts` met `CLASSIC_DARK`; alle hardcoded kleuren/fonts in
engine + 4 scenes vervangen door token-reads (let op exacte waarden, bijv.
frame-kleur `0xf5f5f0`, niet zuiver wit), inclusief het parameteriseren
van afgeleide kleuren (§7.1); plus de togglebare in-app fps-overlay.
Acceptatie: build groen, visueel pixel-identiek (screenshot-vergelijk
vóór/na), in-app fps gelijk.

**Fase 2 — Thema-registry + app-default**
2a: registry met 8 thema's; font- en textuur-assets gebundeld;
FontFace-loading; `resolveTheme` (nog zonder jaar/event-overrides);
`Settings.themeId` + thema-grid in instellingen; scene-herbouw bij wissel
met behoud van niveau + camera (§7.2).
2b: DOM-overlay-refactor — module-scope style-consts in `AppShell.tsx`
omzetten naar theme-factories; `uiMode` (app-thema) stuurt de
overlay-chrome via `useTheme`. Ook `SettingsPhone.tsx` (de Telefoon-tab in
dezelfde overlay) hoort hierbij: die heeft een eigen hardcoded donker
`C`-palet dat anders bij een licht thema donker blijft — dat palet is al
een mini-token-object, dus een kleine refactor. De diavoorstelling
(`Screensaver`) en de video-layer (`FocusVideoLayer`) blijven bewust
theme-onafhankelijk zwart (correct voor foto-/videoweergave) en vallen
buiten de consistentie-eis.
Let op: de textuur-laag komt pas in fase 4 — thema's met
`background.kind: 'texture'` (warm-linen, kraft) vallen tot die tijd terug
op hun solid `tint`-kleur, en de thema-previews in het grid tonen die
fallback eerlijk (geen textuur-preview beloven die nog niet rendert).
Acceptatie: hele app oogt per thema consistent binnen de fase-2-scope
(solid backgrounds, L0–L3 + overlays), wissel zonder herstart en zonder
terugvallen naar L0, in-app 60fps behouden.

**Fase 3 — Per-jaar en per-event thema (cascade + persistentie)**
Rust over de volle keten: `model.rs` + `vault/scanner.rs` (frontmatter
lezen) + `index.rs` (SCHEMA-kolommen, `load()`, query's/DTO's incl.
`EventSummary`) + `vault/writer.rs` + `commands.rs` (`set_year_theme`,
`set_event_theme`, file-first + rescan) incl. tests; `backend.ts` + mock;
resolver-cascade met cache/invalidations; UI-kiezers: het **nieuwe
jaar-paneel** (§8.2 — eerste jaar-bewerk-UI, meegerekend in deze fase) en
een kiezer in het bestaande event-bewerk-paneel, beide met "herstel naar
geërfd"; period-/event-spans op L1 kleuren met hun
accent-token; tolerante parsing van onbekende waarden (frontend-fallback).
Acceptatie: thema per jaar/event overleeft herstart + reindex, frontmatter
blijft schoon (veld weg bij "geërfd"), bestaande vaults zonder theme-veld
werken ongewijzigd.

**Fase 4 — Canvas-achtergronden (texturen op L2/L3)**
TilingSprite-achtergrondlaag in de engine (los van de TextureManager, §6),
thema-getint, camera-gekoppeld op L2/L3; `backgroundId`-override op
event-niveau in de UI. Acceptatie: in-app 60fps op een canvas met honderden
items; texture-geheugen begrensd (1 actieve achtergrondtexture per scene).

**Fase 5 — Foto-frames + caption-styling (per item)**
Frame-varianten in de event-/focus-scene: `plain` (huidige witte rand),
`polaroid` (brede onderrand + caption in caption-font), `rounded`, `none`;
subtiele slagschaduw als onderdeel van het frame; `set_item_frame` (Rust +
backend + mock) en frame-keuze in het foto-bewerk-paneel; thema bepaalt de
default frame-stijl. Acceptatie: frames renderen correct in L2 én L3, mengen
met bestaande rotatie/schaal, geen fps-regressie.

**Fase 6 — (optioneel, aparte beslissing later) Decoratie & sfeer-extra's**
Kandidaten, elk als eigen mini-plan wanneer we eraan toekomen: gecureerde
sticker-/washi-sets op het canvas; "looks" (kleurgrade over alle foto's van
een event); seizoens-/era-defaults (suggestie o.b.v. datum); vrije
kleur-/fontkiezer ("geavanceerd"); audio-narratie per foto. **Niet in dit
plan gebouwd** — genoemd zodat de architectuur er rekening mee houdt (het
cascade-/token-model kan dit dragen zonder herontwerp).

## 10. Risico's

| Risico | Impact | Mitigatie |
|---|---|---|
| Pixi `Text` met custom fonts vóór FontFace-load → verkeerde metrics | Titels springen | Eager load bij app-start; eerste scene-opbouw wacht op `document.fonts.ready` (of hertekent eenmalig daarna); fallback-stack per FontRef |
| Rebuild-bij-themawissel te traag bij grote vaults | Haperende wissel | Wissel is een expliciete gebruikersactie; herbouw gebeurt via het bestaande her-enter-pad per scene (§7.2), met behoud van niveau + camera. Meten in fase 2 |
| Frontmatter-vervuiling / merge-conflicten in synced vaults | Data-frictie | Alleen schrijven bij expliciete keuze; blok volledig verwijderen bij "geërfd"; writer raakt de rest van het bestand niet aan |
| Token-refactor introduceert subtiele visuele regressies | Vertrouwen | Fase 1 is puur mechanisch met `CLASSIC_DARK` = exact de huidige waarden; screenshot-vergelijk vóór/na |
| Scope-kruip richting sticker-editor | Nooit af | Fase 6 expliciet buiten dit plan; elke fase afzonderlijk shipbaar |

## 11. Buiten scope

- v1-code (`src/App.tsx`, `src/timeline/Timeline.tsx`, `src/components/*`,
  `src/db/*` voor zover alleen door v1 gebruikt) — blijft onaangeraakt.
- Sticker-/washi-editor, kleurgrades, AI-thema's, marktplaats/packs,
  seizoensdrops (fase 6-kandidaten).
- Mobiel/inbox-flow: de telefoon-upload krijgt geen thema-UI; geïmporteerde
  memories erven gewoon.
- Delen/exporteren van thema's tussen gebruikers.
