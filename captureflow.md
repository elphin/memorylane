Top. Dan schrijf ik dit uit alsof een developer + UX’er dit **één-op-één kunnen bouwen**, inclusief states, beslismomenten en microcopy.
Dit is de **default flow**. Alles hierna is uitbreiding.

---

# Memory toevoegen — volledige flow (MVP)

## Doel van de flow

> De gebruiker moet **zonder nadenken** een herinnering kunnen vastleggen,
> en pas **achteraf** betekenis toevoegen.

Geen formulieren.
Geen verplichtingen.
Altijd een uitweg.

---

## Overzicht van de flow (mentaal)

1. Initiatie — *“Ik wil iets vastleggen”*
2. Capture — *“Wat is het?”*
3. Bevestiging — *“Opslaan, klaar”*
4. Verrijken (optioneel) — *“Wil ik hier meer mee?”*

---

## 1. Initiatie

### Trigger

* Floating `+` knop (altijd zichtbaar)
* Shortcut (desktop): `Cmd + N`
* Long-press op canvas (mobile)

### Resultaat

→ **Quick Add Sheet** opent (bottom sheet / modal)

---

## 2. Quick Add Sheet — keuze van type

**UI**

* Full-width sheet
* Donkere achtergrond (focus)
* Grote, duidelijke opties

**Opties**

* 📷 Foto / Video
* ✍️ Tekst
* 🎙️ Audio
* 🔗 Link

**Microcopy (bovenaan)**

> “Leg vast wat nu belangrijk is.”

**UX-regels**

* Geen tekstvelden zichtbaar
* Geen metadata
* Geen afleiding

---

## 3. Capture — per type

---

### 3A. Foto / Video

**Actie**

* Camera openen
  of
* Media kiezen uit galerij

**Na selectie**
→ Direct naar **Preview State**

---

### 3B. Tekst

**UI**

* Eén groot tekstveld
* Cursor actief
* Placeholder:

> “Wat wil je onthouden?”

**UX**

* Geen titelveld
* Geen toolbar behalve:

  * Done
  * Cancel

---

### 3C. Audio

**UI**

* Grote record-knop
* Timer zichtbaar
* Waveform animatie

**Microcopy**

> “Spreek vrijuit. Je kunt dit later bewerken.”

---

### 3D. Link

**UI**

* URL input
* Auto-preview (title + thumbnail indien mogelijk)

**Fallback**

* Als preview faalt → alleen URL opslaan

---

## 4. Preview & Save (kritische stap)

Na capture komt de gebruiker **altijd** in deze staat.

### Wat zie je

* De content groot in beeld
* Minimale overlay

**Standaard automatisch ingevuld**

* 📅 Happened at: *nu*
* 📍 Locatie: *auto (indien toegestaan)*
* 🕒 Created at: *nu*
* 📌 Event-context: *huidige zoom/event*

---

### Primaire actie

**Button (prominent):**

> **Opslaan**

➡️ *Tap = memory wordt opgeslagen en toegevoegd aan timeline.*

---

### Secundaire acties (discreet)

* ✏️ “Voeg context toe”
* ❌ Annuleren

**UX-regel**

* Opslaan moet altijd mogelijk zijn
* Geen enkele extra stap is verplicht

---

## 5. Na opslaan — directe feedback

### Animatie

* Memory “vliegt” naar juiste plek in timeline / canvas
* Zachte zoom-out of fade-in

### Toast / microfeedback

> “Herinnering opgeslagen”

**Duur**

* 1,5 sec
* Niet blokkerend

---

## 6. Verrijken (optioneel, maar belangrijk)

Als gebruiker op **“Voeg context toe”** tikt
(of later het item selecteert):

---

### Context Panel (side drawer / bottom sheet)

**Secties (in deze volgorde!)**

---

### 6.1 Titel (optioneel)

* Klein tekstveld
* Placeholder:

> “Geef dit een naam (optioneel)”

---

### 6.2 Personen

* Chips / avatars
* Autocomplete
* * “Voeg persoon toe”

**Microcopy**

> “Wie waren erbij?”

---

### 6.3 Plaats

* Voorgevuld
* Bewerken mogelijk
* Kaart mini-preview (optioneel)

---

### 6.4 Tags

* Vrije invoer
* Autocomplete

**Microcopy**

> “Waar gaat dit over?”

---

### 6.5 Highlight

* Toggle: ⭐ Highlight
* Uitleg:

> “Gebruik highlights voor momenten die eruit springen.”

---

### 6.6 Datum aanpassen (advanced)

* HappenedAt aanpassen
* Alleen zichtbaar na tap op datum

---

### Acties

* **Klaar**
* **Sluiten zonder opslaan** (wijzigingen vervallen)

---

## 7. Edge cases (belangrijk voor dev)

### Offline

* Alles lokaal opslaan
* Sync-status: “Wacht op sync”
* Geen UX-verschil voor gebruiker

---

### Locatie geweigerd

* Geen prompt opnieuw
* Alleen: “Locatie onbekend”

---

### App sluiten tijdens capture

* Draft automatisch opslaan
* Bij heropenen:

> “Je had nog een herinnering openstaan”

---

## 8. Wat deze flow bewust níét doet

* ❌ Geen verplicht titelveld
* ❌ Geen categorie-mandaat
* ❌ Geen emotie-meting bij capture
* ❌ Geen “event kiezen” stap
* ❌ Geen AI-interventie

Alles wat frictie toevoegt → later.

---

## 9. Succescriteria voor deze flow

* < 3 seconden van openen → opslaan
* Geen denkstappen nodig
* Gebruiker voelt: *“ik kan dit altijd doen”*

---

## 10. Waarom deze flow werkt (ontwerpkeuze)

* **Capture ≠ structureren**
* Betekenis ontstaat later
* Tijdslijn blijft leidend
* Canvas blijft rustig

---

Als je wilt, kan ik hierna:

* deze flow **vertalen naar wireframe-screens**
* of **per type (foto/tekst/audio) micro-interacties uitwerken**
* of **dezelfde flow doen voor “event/period toevoegen”**

Zeg maar wat de volgende logische stap is.
