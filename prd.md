Top. Dan ga ik dit behandelen alsof ik dit **morgen aan een senior dev / klein team moet overdragen**.
Strak. Expliciet. Met bewuste keuzes en onderbouwing.

Hieronder staat een **volledige PRD (Product Requirements Document)** voor jouw app.

---

# PRD — Zoomable Memory Timeline App

**Working title:** *Lifeline* (naam is placeholder)
**Type:** Local-first desktop & mobile app met web sync
**Core principle:** Semantic zoom over tijd + canvas-based events

---

## 1. Productvisie (waarom dit bestaat)

Mensen hebben herinneringen, maar hun tools zijn versnipperd:

* foto’s zonder context
* notities zonder tijd
* video’s zonder verhaal

Dit product biedt:

> **Eén doorlopende tijdslijn van je leven, waarin je vloeiend kunt in- en uitzoomen, en waarin gebeurtenissen bestaan als canvassen waarop betekenis wordt opgebouwd.**

Geen lijstjes.
Geen mappen.
Maar navigeren door tijd en schaal.

---

## 2. Doelgroep (bewust afgebakend)

**Primary user**

* Individuele gebruiker
* Creatief / reflectief
* Hecht waarde aan privébezit van data
* Wil herinneringen *beleven*, niet archiveren

**Niet in scope (MVP)**

* Social sharing
* Familie-accounts
* Samenwerking
* AI tagging / face recognition

---

## 3. Kernconcepten (mentaal model)

### 3.1 Alles is een Event

Er bestaat **één hoofdobjecttype**: `Event`

Een event:

* heeft een tijdspositie
* kan andere events bevatten
* heeft een canvas
* verandert uiterlijk afhankelijk van zoomniveau

**Voorbeelden**

* Jaar = event
* Vakantie = event
* Dag = event
* Memory (foto/tekst/video) = event

➡️ Verschil zit in **schaal en presentatie**, niet in type.

---

## 4. Zoom & Navigatie (belangrijkste UX-principe)

### 4.1 Semantic Zoom Levels

| Level | Naam                         | Wat zie je                      | Interactie           |
| ----- | ---------------------------- | ------------------------------- | -------------------- |
| L0    | Lifeline                     | Jaren / decennia                | Horizontaal scrollen |
| L1    | Year view                    | Highlights + perioden           | Zoom / pan           |
| L2    | Event canvas                 | Vrij canvas met items           | Drag / zoom / select |
| L3    | Item focus                   | Eén item groot                  | Lezen / bewerken     |
| L4    | (Optioneel later) Sub-canvas | Alleen voor “collection events” | Niet in MVP          |

**Regel:**
De gebruiker zoomt **altijd** met dezelfde handeling (pinch / scroll).
De UI verandert automatisch per schaal.

---

### 4.2 Navigatie-interacties

* Scroll / swipe → pan door tijd
* Pinch / ctrl+scroll → zoom
* Dubbelklik / double tap → zoom in op target
* Escape / back → zoom uit
* Focuspunt = cursor / touchpositie

**Geen:**

* Breadcrumb clicks
* Pagina-wissels
* Back buttons per niveau

➡️ Gebruiker voelt nooit een “pagina-overgang”.

---

## 5. Canvas model (binnen events)

### 5.1 Event Canvas

Elke event heeft een **2D canvas**.

Op dit canvas kunnen liggen:

* tekst-items
* foto-items
* video-items
* link-items
* *child events* (visueel herkenbaar)

Items zijn vrij te positioneren.

### 5.2 Canvas Layout (technisch los van content)

Layout-informatie is **per event opgeslagen**, los van de items zelf.

Waarom:

* items kunnen hergebruikt worden
* meerdere weergaven mogelijk
* performance optimalisatie

---

## 6. Content model (datamodel)

### 6.1 Event (core object)

```ts
Event {
  id: UUID
  type: 'year' | 'period' | 'event' | 'item'
  title?: string
  startAt: ISODate
  endAt?: ISODate
  parentId?: UUID
  coverMediaId?: UUID
  createdAt: ISODate
  updatedAt: ISODate
}
```

### 6.2 Item (inhoud)

```ts
Item {
  id: UUID
  eventId: UUID
  itemType: 'text' | 'photo' | 'video' | 'link'
  content: string | MediaRef
  caption?: string
  people?: PersonRef[]
  place?: {
    lat: number
    lng: number
    label?: string
  }
  happenedAt?: ISODate
}
```

### 6.3 Canvas Layout

```ts
CanvasItem {
  eventId: UUID
  itemId: UUID
  x: number
  y: number
  scale: number
  rotation: number
  zIndex: number
}
```

---

## 7. Opslagstrategie (local-first)

### 7.1 Local datastore (leidend)

* **SQLite**
* Alles werkt volledig offline
* UI praat altijd eerst met local DB

### 7.2 Sync-laag (asynchroon)

* Event-based sync
* Conflict resolution: *last-write-wins* (MVP)
* Media upload in background

### 7.3 Cloud (sync-only)

* User auth
* Event metadata
* Media blobs

**Geen cloud-afhankelijkheid voor core UX.**

---

## 8. Media handling

### 8.1 Media pipeline

* Origineel bestand lokaal opgeslagen
* Automatisch thumbnails genereren:

  * small (64px)
  * medium (256px)
  * large (1024px)

### 8.2 Lazy loading

* Afhankelijk van zoomniveau
* Nooit full-res tenzij item focus

---

## 9. Rendering & Performance (cruciaal)

### 9.1 Rendering engine

**Keuze:** Canvas/WebGL (geen DOM)

Aanbevolen:

* PixiJS of vergelijkbaar
* DOM alleen voor overlays (edit panels)

### 9.2 Performance-eisen

* 60fps bij pan/zoom
* Max 16ms per frame
* Viewport virtualisatie
* Level-of-detail rendering

**LOD-regels**

* L0/L1: alleen blokken + labels
* L2: thumbnails
* L3: full content

---

## 10. UX-regels (anti-chaos)

1. **Niet elk event is leeg**

   * Default layout templates per type
2. **Item ≠ container (MVP)**

   * Geen nesting van items
3. **Altijd oriëntatie**

   * Mini time-indicator (jaar / periode)
4. **Max 1 primary interaction per view**

   * Geen multitool-chaos

---

## 11. Toevoegen van content (capture flow)

### 11.1 Quick add

* Eén knop
* Direct:

  * foto / video / tekst
* Automatisch:

  * datum
  * plaats (indien toegestaan)
* Titel optioneel

### 11.2 Later verrijken

* Canvas herschikken
* Caption toevoegen
* Mensen koppelen
* Event verplaatsen

---

## 12. Platformstrategie

### 12.1 MVP-platform

**Desktop-first**

* macOS
* Windows

Technisch:

* Electron / Tauri + Web stack
  *(Tauri voorkeur i.v.m. performance en footprint)*

### 12.2 Mobile (fase 2)

* iOS / Android
* Zelfde data-model
* Minder canvas editing, meer consumptie

---

## 13. Niet in MVP (bewust uitgesloten)

* AI tagging
* Face recognition
* Samenwerking
* Delen
* Public timelines
* Version history per item

➡️ Alles wat UX kan vertroebelen of scope explodeert.

---

## 14. Succescriteria

* Gebruiker kan in <5 seconden:

  * van “levensoverzicht” naar specifieke herinnering
* Geen zichtbare laadtijden bij zoom
* App voelt als *navigeren*, niet als *openen*

---

## 15. Belangrijkste ontwerpkeuzes (toelichting)

### Waarom alles een Event is

* Eén mentaal model
* Geen uitzonderingen
* Schaal bepaalt gedrag

### Waarom local-first

* Directe feedback
* Emotionele apps mogen nooit “wachten”
* Vertrouwen & privacy

### Waarom canvas

* Herinneringen zijn geen lijsten
* Mensen denken ruimtelijk
* Betekenis ontstaat door relatie, niet volgorde

---

## 16. Volgende stap (aanrader)

Als je dit serieus wil laten bouwen:

1. UX wireframes per zoom-level
2. Performance prototype (alleen pan/zoom)
3. Datamodel implementeren zonder UI
4. Pas daarna featurebouw

---

Als je wilt, kan ik:

* dit omzetten naar **developer tickets**
* een **MVP-scope reduceren tot 6 weken**
* of een **UX interaction spec** uitschrijven (gesture-by-gesture)

Zeg maar hoe diep je nu wilt gaan.
