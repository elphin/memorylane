// L1 — Jaar: een horizontale maand-tijdlijn (Jan–Dec). De as ligt verticaal
// gecentreerd; INZOOMEN rekt de TIJD-AS uit (maanden worden breder) i.p.v. de
// kaarten te vergroten — kaarten houden een VASTE schermgrootte (per zwaarte).
// De belangrijkste memories vullen de lanes rond de as (overzicht is dus gevuld);
// wie niet past is een stip op de as en "bloeit" op tot kaart zodra er ruimte
// komt. Klik op een event → L2-canvas.
//
// Renderschema (de kern): de wereld-container wordt door de camera geschaald met
// `z`. Een kaart staat op wereld-x = ankerdatum (dus hij schuift mee als de as
// uitrekt), en krijgt `scale = baseScreenScale / z` en `y = laneScreenY / z`
// (met camera.y=0) → constante schermgrootte + constante scherm-lane-offset. De
// reveal-transitie (root.scale 0.12→1) componeert daar bovenop, want we delen
// door `camera.zoom`, niet door de reveal-schaal.

import { Container, Graphics, Sprite, Text, Texture } from 'pixi.js'
import type { Backend, EventSummary, YearDetail } from '../../lib/backend'
import { resolveTheme } from '../../theme/resolve'
import type { ResolvedTheme } from '../../theme/tokens'
import type { FrameContext, RenderEngine } from '../core/engine'
import type { DragHandle } from '../core/gestures'
import type { Scene } from './scene'

const AXIS_W = 2400 // wereldbreedte van de jaar-as (Jan..Dec) bij zoom=1
const THUMB_W = 168
const THUMB_H = 126
const BORDER = 8
// Zichtbare witte rand-dikte in scherm-px (constant over alle tegels, los van hun
// grootte). BORDER blijft de layout-marge (hit-box, titel-offset); de getekende
// rand is dunner en gelijk voor elke tegel.
const BORDER_PX = 6
const CARD_ASPECT = THUMB_W / THUMB_H

// Kaart-schermhoogtes (px) naar zwaarte. Vast op het scherm, ongeacht de zoom.
const CARD_H_BASE = 96 // schermhoogte bij effectiveSize 50
const CARD_H_MIN = 66
const CARD_H_MAX = 132

// Lanes (schermruimte, boven/onder de as).
const AXIS_CLEAR_PX = 96 // scherm tussen as en de eerste lane (ruim, zodat de
// leader-lijn een mooie verticale S maakt i.p.v. schuin te lopen)
const LANE_GAP_PX = 40 // ruimte tussen lanes (incl. plek voor de titel ertussen)
// Rechte (strikt verticale) leaders hebben de S-bocht-ruimte niet nodig: lanes mogen
// dichter op de as en dichter op elkaar. Dat verlaagt de drempel voor een tweede lane
// per kant van ~1076 naar ~988 px vensterhoogte mét jaartitel (standaard aan), en van
// ~984 naar ~896 px zonder titel. Niet lager kiezen: bij AXIS_CLEAR 56 valt het kader
// op de maandlabels (die tot ~38 scherm-px reiken) zodra laneJitter er 14px afhaalt.
const AXIS_CLEAR_STRAIGHT = 64
const LANE_GAP_STRAIGHT = 28
const CARD_GAP_PX = 16 // min. horizontale scherm-ruimte tussen kaarten in een lane
const EDGE_PAD = 34 // min. scherm-px tussen een kaart en de linker-/rechterrand (overzicht)
// Kaarten van een memory die de jaargrens kruist ankeren op het uiteinde van de as en
// hebben daar minder lucht; een krappere rand-marge houdt ze een kaart i.p.v. een stip.
const EDGE_PAD_AXIS_END = 10
// Krimp-om-te-passen: past een kaart nergens op ware grootte, dan proberen we deze
// stappen vóór hij een stip wordt. Gekwantiseerd (niet continu) zodat het frame-kader
// niet elk frame opnieuw getekend hoeft te worden en een kaart niet zichtbaar "pompt".
const FIT_STEPS = [1, 0.85, 0.72, 0.6] as const

// Leader-lijntjes (as → kaart): een simpele lijn met constante schermdikte,
// scherp getekend op schermresolutie (de leader-laag wordt met 1/zoom
// counter-scaled en in scherm-coördinaten getekend).
const LEADER_WIDTH = 1 // schermdikte (px)
const LEADER_ALPHA = 0.85
// Horizontale offset (scherm-px) van een kaart t.o.v. zijn datummarkering, zodat
// de leader een mooie S-bezier kan maken (recht omhoog → opzij → recht de tegel in).
// Ruim + sterk gevarieerd → speelse, wat-verder-van-de-datum spreiding.
const CARD_OFFSET_PX = 78

// Marge (scherm-px) waarmee de as-rand binnen de schermrand blijft bij de rust-
// scroll-grens, zodat rand-kaarten (met hun offset) net zichtbaar blijven.
const EDGE_MARGIN = 130
// Rauwe overscroll (scherm-px) waarbij de buurjaar-naam volledig wit is → commit
// naar dat jaar. Daaronder groeit/vervaagt de preview mee. Gedeeld met AppShell
// (die de commit detecteert).
export const YEAR_COMMIT_PX = 240

const DOT_R = 7 // stip-straal (scherm-px)
const DOT_HIT = 22 // royale klik-halfmaat van een stip (scherm-px)
const MARKER_HIT_MIN = 20

// Datum-highlight bij hover (subtiel; HOVER_INTENSITY is de hoofdknop — omhoog
// draaien maakt alles feller). Eén vonk langs de leader (kaart→stip), bij aankomst
// één "ping"-ring op de stip (of een gloed op de balk bij een periode), en zolang je
// hovert een kalme gloed + het exacte datumlabel.
const HOVER_INTENSITY = 1.0 // globale schaal op alle gloed-/vonk-alfa's
const HOVER_SPARK_MS = 440 // duur van de vonk-reis kaart→stip
const HOVER_PING_MS = 560 // duur van de ring-ping bij aankomst
const HOVER_SPARK_R = 3.2 // straal van de vonk (scherm-px)
const HOVER_SPARK_ALPHA = 0.95 // kern-alfa van de vonk
const HOVER_GLOW_ALPHA = 0.5 // gloed om de stip terwijl je hovert
const HOVER_PING_ALPHA = 0.55 // begin-alfa van de ping-ring
const HOVER_PING_GROW = 15 // hoeveel de ping-ring uitdijt (scherm-px)
const HOVER_SPAN_GLOW_ALPHA = 0.32 // extra oplichten van een periode-balk bij hover
const LABEL_SCREEN_Y = 20 // maandlabel-offset onder de as (scherm-px)

// Semantische maatverdeling op de as: maand-streepjes staan er altijd; week- en
// dag-streepjes faden in bij inzoomen. Gegradueerd in hoogte (maand hoogst → dag
// laagst) én opaciteit (dag het zachtst) → een fijne, rustige liniaal.
const MONTH_TICK_H = 12 // half-hoogte streepje (scherm-px, ±)
const WEEK_TICK_H = 9
const DAY_TICK_H = 5.5
const MONTH_TICK_ALPHA = 0.95
const WEEK_TICK_ALPHA = 0.8
const DAY_TICK_ALPHA = 0.6
// Zoom-drempels: breedte van één maand op het scherm (px) waarbinnen de tier infadet.
const WEEK_FADE_LO = 115
const WEEK_FADE_HI = 205
const DAY_FADE_LO = 300
const DAY_FADE_HI = 560
const TITLE_MAX = 24 // max. tekens van een memory-titel

/** Effectieve zwaarte: rating-`size` leidend, met een bescheiden log-nudge voor
 * rijkere memories (max +12 < de 20-stap tussen de buckets → tiers blijven). */
function effectiveSize(size: number | undefined, itemCount: number): number {
  const base = size == null ? 50 : size
  const nudge = Math.max(0, Math.min(12, Math.round(4 * (Math.log2(1 + Math.max(0, itemCount)) - 1))))
  return Math.max(1, Math.min(100, base + nudge))
}

/** Belang-tier uit de RAUWE rating: 2 = uitzonderlijk, 1 = bijzonder, 0 = gewoon.
 * Bewust NIET uit `eff`: de itemCount-nudge (max +12) mag een gewone memory niet naar
 * een hogere tier tillen. Grenzen gelijk aan de stip-tiers en de drie keuze-buckets
 * (30/50/70) in de memory-dialoog. */
function sizeTier(size: number): number {
  return size >= 60 ? 2 : size >= 40 ? 1 : 0
}

/** Toelatingsvolgorde voor de packing: eerst álle uitzonderlijke memories, dan de
 * bijzondere, dan de gewone; binnen een tier de zwaarste eerst en daarna de hash
 * (deterministisch). Gedeeld door de constructor-sort en de re-sort na een live
 * grootte-wijziging, zodat die twee nooit uit de pas lopen. */
function admissionOrder(a: Node, b: Node): number {
  return sizeTier(b.size) - sizeTier(a.size) || b.eff - a.eff || a.hash - b.hash
}

/** Zijwaartse drift (scherm-px) van een kaart t.o.v. zijn datum — de speelse
 * spreiding. ENIGE bron, en alleen `repack` roept hem aan; `fitCamera` reserveert de
 * drift bewust NIET (die dwingt de overzicht-stand af, en de rand-eis in repack is de
 * garantie dat niets over de rand valt). Voorheen hadden die twee elk hun eigen
 * formule met dezelfde hash-bits, waardoor repack structureel 27–66 px verder dreef
 * dan de fit-camera had gereserveerd → kaarten liepen rechts uit beeld. */
function driftFor(hash: number): number {
  const dir = (hash >>> 8) & 1 ? 1 : -1
  return dir * CARD_OFFSET_PX * (0.5 + 1.0 * (((hash >>> 9) % 100) / 100))
}

/** Deterministische ±8% grootte-variatie (organischer); alleen visueel. */
function jitterScale(id: string): number {
  const r = ((hashId(id) >>> 13) % 1000) / 1000
  return 1 + (r - 0.5) * 0.16
}

/** Schermhoogte (px) van een kaart o.b.v. zwaarte + jitter. Klemt ná de jitter,
 * zodat de werkelijke hoogte nooit boven CARD_H_MAX komt (die het lane-budget
 * reserveert → geen verticale clipping in de buitenste lane). */
function cardScreenH(eff: number, id: string): number {
  const h = CARD_H_BASE * (eff / 50) * jitterScale(id)
  return Math.max(CARD_H_MIN, Math.min(CARD_H_MAX, h))
}

const MONTHS = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec']

/** Zachte 0→1 overgang tussen a en b (voor het infaden van de tick-tiers). */
function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** Van der Corput (bit-reversal) in [0,1): een low-discrepancy-reeks. Opeenvolgende
 * indices liggen ver uit elkaar → evenwichtige, niet-monotone verdeling (voor de
 * hoogte-slots van de kaarten). */
function vanDerCorput(n: number): number {
  let r = 0
  let b = 0.5
  while (n > 0) {
    r += (n & 1) * b
    n >>>= 1
    b *= 0.5
  }
  return r
}

interface Lane {
  side: number // -1 = boven de as (neg. y), 1 = onder
  level: number // 0 = dichtst bij de as
}

/** Eén bezette plek in een lane (scherm-px), met de datum erbij zodat de lijst op
 * datumvolgorde blijft — dát is wat kruisende leaders binnen een lane uitsluit. */
interface LaneSlot {
  anchorX: number
  left: number
  right: number
  node: Node
}

interface Node {
  eventId: string
  synthetic: boolean // synthetische "Losse foto's"-bundel → geen grootte-curatie
  /** Memory die de jaargrens kruist en dus in twee jaren staat: ankert op het uiteinde
   * van de as en krijgt daar een krappere rand-marge (fase 7 vult dit). */
  spansYears: boolean
  anchorX: number // wereld-x (de datum)
  hasCover: boolean
  isSpan: boolean
  spanStartX: number // wereld-x begin/eind van de periode-balk (0 als geen span)
  spanEndX: number
  dateText: string // geformatteerde datum/reeks voor het hover-datumlabel
  coverItemId?: string
  eff: number // effectiveSize (belang) — bepaalt grootte + packing-prioriteit
  size: number // rauwe rating 1–100 (bron van eff; leeft mee met Shift-resize)
  itemCount: number // aantal items (voor effectiveSize bij live resize)
  hash: number
  prefSide: number // voorkeurskant voor lane-balancering
  offX: number // horizontale scherm-offset van de kaart t.o.v. zijn datum (± doel)
  curOffX: number // idem, geanimeerd (glijdt naar offX; geen sprong bij lane-wissel)
  vSlot: number // verticale slot 0..1 (bij één lane: verdeelt kaarten over de hoogte)
  // Schermgroottes (px) — de INTRINSIEKE maat (belang + jitter). De packer verkleint
  // deze nooit; die gebruikt `fitScale` (zie hieronder).
  cardW: number
  cardH: number
  baseScreenScale: number // cardH / THUMB_H (kaart in THUMB-eenheden getekend)
  // Packing-toestand (leeft mee over frames voor stabiliteit).
  lane: Lane | null // null = stip/overflow
  /** Efemere krimpfactor (0..1] uit de packing: past een kaart alleen kleiner, dan
   * krijgt hij die maat i.p.v. een stip te worden. Gekwantiseerd (FIT_STEPS) en bewust
   * GEEN mutatie van cardH/cardW: dat zou het kader elk frame laten hertekenen en met
   * de Shift-resize vechten. De kaart-inhoud (incl. titel) schaalt wél mee — een
   * kleinere tegel hoort een kleiner bijschrift te hebben. */
  fitScale: number
  /** Geanimeerde versie van `fitScale` (lerpt ernaartoe), zodat een kaart die krimpt
   * of terugveert niet in één frame van formaat springt. Het KADER wordt op de
   * gekwantiseerde `fitScale` getekend, zodat dat zeldzaam blijft. */
  curFitScale: number
  // Animatie-toestand (fase B): appear 0=stip, 1=kaart; curY = huidige scherm-y.
  appear: number
  curY: number
  // Pixi-objecten.
  card: Container | null // cover-events
  frame: Graphics | null // de witte rand (dient als toetsenbord-focus-indicator)
  badge: Container | null // "in aanbouw"-ezelsoor (herplaatsen bij resize)
  borderAlpha: number // huidige rand-alpha (animeert weg voor niet-gefocuste tegels)
  frameDrawnScale: number // baseScreenScale × fitScale waarvoor de frame laatst getekend is (-1 = nog niet)
  title: Text | null
  titleSide: number // laatst toegepaste titel-kant (om niet elke frame te herzetten)
  dot: Container | null // stip-marker (non-cover, of cover-overflow bij een niet-span)
  sprite: Sprite | null
  sprite2: Sprite | null
  key: string
  loaded: boolean
  hover: number // hover-schaal-animatie
  // Hit-box (wereldruimte, per frame gezet).
  hitCx: number
  hitCy: number
  hitHalfW: number
  hitHalfH: number
  wasVisible: boolean
  /** Index in de datumvolgorde van ALLE kaarten (constructor, onveranderlijk) — basis
   * voor het stabiele hoogte-slot. */
  dateRank: number
  // Slideshow-roulatie.
  photoIds: string[]
  photoIdx: number
  pendingIdx: number
  curKey: string
  pendingKey: string
  nextAt: number
  fade: number
}

// Meerdaagse-blokjes: de felle basiskleuren uit het thema, geblend tegen de
// thema-achtergrond (zodat de balkjes "opaak op de as" ogen). Het geblende
// palet wordt per scene-instantie berekend (constructor) zodat een
// themawissel + scene-herbouw de nieuwe kleuren oppakt — niet op module-scope
// cachen (dan blijft het oude thema hangen).
function opaqueSpan(color: number, bg: number): number {
  const mix = (c: number, b: number): number => Math.round(c * 0.45 + b * 0.55)
  const r = mix((color >> 16) & 255, (bg >> 16) & 255)
  const g = mix((color >> 8) & 255, (bg >> 8) & 255)
  const b = mix(color & 255, bg & 255)
  return (r << 16) | (g << 8) | b
}

/** Stabiele hash (FNV-1a) van een id. */
function hashId(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function truncateTitle(s: string, n: number): string {
  const t = s.trim()
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t
}

// Gedempte kleuren voor de placeholder-tegel van een memory zónder foto (per
// memory deterministisch → ze variëren; contrasterend met de titeltekst-token).
// Leest het thema op aanroep-moment (scene-bouwtijd), zodat een themawissel
// via scene-herbouw de nieuwe kleuren oppakt.
function placeholderColor(id: string, palette: number[]): number {
  return palette[hashId(id) % palette.length]!
}

function fitCover(sprite: Sprite, tex: Texture): void {
  const s = Math.max(THUMB_W / tex.width, THUMB_H / tex.height)
  sprite.setSize(tex.width * s, tex.height * s)
}

/** Parse een `YYYY-MM-DD`-datum LOKAAL (niet als UTC). */
function parseLocalDate(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y || 1970, (m || 1) - 1, d || 1).getTime()
}

export class YearScene implements Scene {
  readonly root = new Container()
  // Geresolvede tokens van dit jaar (app-thema → jaar-keuze), gezet in de
  // constructor — een themawissel herbouwt de scene en resolvet opnieuw.
  private T: ResolvedTheme
  // De rauwe jaar-keuze, voor per-event accenten (app → jaar → event).
  private yearChoice: YearDetail['year']['theme']
  private leaders = new Graphics()
  private spans: Graphics | null = null // periode-balken; hoogte counter-scaled zodat die bij inzoomen constant blijft
  private cardsLayer = new Container()
  private dotsLayer = new Container()
  private nodes: Node[] = []
  private cardNodes: Node[] = [] // alle memory-tegels, op belang gesorteerd (packing-volgorde)
  private monthLabels: { text: Text; midX: number }[] = []
  private hoveredId: string | null = null
  // Toetsenbord-focus (spatial nav): id van de gefocuste memory. Bij actieve nav
  // houdt alleen de gefocuste tegel z'n witte rand; de rest faadt weg.
  private kbFocusId: string | null = null
  private primed = false // eerste frame snapt naar de packing-toestand; daarna animeren
  // Herpak-conditie: `repack` draait niet elk frame maar alleen als de layout-input
  // wijzigde (camera/viewport/titelruimte/belang/filter). Scheelt werk én maakt de
  // behoud-pass zinvol: bij een stilstaande camera is de layout per definitie stabiel.
  private layoutDirty = true
  private lastCamX = NaN
  private lastZoom = NaN
  private lastVpW = NaN
  private lastVpH = NaN
  // Overzicht-stand met dode zone: de rand-eis (geen kaart over de schermrand) geldt
  // alleen als de as helemaal past. Zonder hysterese zou wielzoomen precies over de
  // drempel een groep kaarten om-en-om in stippen laten veranderen.
  private atFitSticky = true
  // Event dat op dit moment met Shift gesleept wordt (belang bijstellen): die kaart
  // mag de packer niet stil verkleinen, anders wordt hij kleiner terwijl je 'm groter
  // sleept. Past hij écht niet, dan wordt hij een stip — dat is eerlijke feedback.
  private resizingId: string | null = null
  private yearStart = 0
  private span = 1
  private year = 0 // kalenderjaar (voor maand-/week-/dag-streepjes)
  private lanesN = 1 // aantal lanes per kant deze frame (voor de hoogte-jitter)
  // Verticale spreiding bij één lane: kaart-afstand tot de as verdeelt zich tussen
  // vMin en vMaxTop/vMaxBottom (per frame uit de vensterhoogte + titelruimte).
  private vMin = 120
  private vMaxTop = 200
  private vMaxBottom = 200
  private ticksLayer = new Graphics() // maand/week/dag-liniaal (schermresolutie)
  private fineTicks = true // week/dag-streepjes tonen bij inzoomen?
  private monthTickX: number[] = [] // wereld-x van de 11 maandgrenzen (constant)
  private dayPicker = false
  private hoverWX: number | null = null
  private dayLine = new Graphics()
  private dayLabel: Text
  // Scherm-px bovenaan gereserveerd voor de titel ("2024"): staat die aan, dan
  // begint de dag-gids eronder i.p.v. erlangs. 0 = geen titel.
  private titleInset = 0
  // Datum-highlight bij hover: een schermresolutie-laag (vonk/ping/gloed) + een
  // datumlabel, en de animatie-toestand van het huidige effect.
  private hoverPulse = true
  private hoverLayer = new Graphics()
  private dateLabel: Text
  private fxId: string | null = null // node waarvoor het effect nu loopt
  private fxSpark = 0 // voortgang vonk kaart→stip (0..1)
  private fxSparkActive = false // reist de vonk nog?
  private fxPing = 0 // voortgang ring-ping bij aankomst (0..1; 0 = geen)
  private fxGlow = 0 // gloed/label-alfa terwijl je hovert (geëased 0..1)
  private rangeBand = new Graphics()
  private slideEnabled: boolean
  private slideMs: number
  private showTitles: boolean
  private curvedLeaders: boolean
  private neighbors: { prev?: string; next?: string }
  private prevLabel: Text | null = null // buurjaar-naam links (eerder jaar)
  private nextLabel: Text | null = null // buurjaar-naam rechts (later jaar)

  constructor(
    private engine: RenderEngine,
    private backend: Backend,
    detail: YearDetail,
    opts: {
      enabled: boolean
      speedMs: number
      showTitles?: boolean
      curvedLeaders?: boolean
      neighbors?: { prev?: string; next?: string }
    } = {
      enabled: false,
      speedMs: 5000,
    },
  ) {
    this.T = resolveTheme(detail.year.theme)
    this.yearChoice = detail.year.theme
    this.slideEnabled = opts.enabled
    this.slideMs = Math.max(800, opts.speedMs)
    this.showTitles = opts.showTitles ?? false
    this.curvedLeaders = opts.curvedLeaders ?? true
    this.neighbors = opts.neighbors ?? {}
    const year = detail.year.year
    const yearStart = new Date(year, 0, 1).getTime()
    const yearEnd = new Date(year, 11, 31, 23, 59, 59).getTime()
    const span = Math.max(1, yearEnd - yearStart)
    this.yearStart = yearStart
    this.span = span
    this.year = year
    const dateToX = (ms: number): number => {
      const p = Math.min(1, Math.max(0, (ms - yearStart) / span))
      return -AXIS_W / 2 + p * AXIS_W
    }

    // ---- As-lijn (wereldruimte, stretcht met de zoom) ----
    // De maand-/week-/dag-streepjes staan NIET hier maar in ticksLayer: op scherm-
    // resolutie (constante hoogte) en per frame hertekend, zodat week/dag pas bij
    // inzoomen infaden (zie drawTicks).
    const axis = new Graphics()
    axis
      .moveTo(-AXIS_W / 2, 0)
      .lineTo(AXIS_W / 2, 0)
      .stroke({ width: 1, color: this.T.colors.axis, pixelLine: true })
    this.root.addChild(axis)
    for (let m = 1; m < 12; m++) this.monthTickX.push(dateToX(new Date(year, m, 1).getTime()))
    this.ticksLayer.eventMode = 'none'
    this.root.addChild(this.ticksLayer)
    this.root.addChild(this.rangeBand)

    // Maandlabels: constante schermgrootte, op het midden van elke maand (schuiven
    // mee als de as uitrekt). Positie/schaal per frame (counter-scale).
    for (let m = 0; m < 12; m++) {
      const midX = (dateToX(new Date(year, m, 1).getTime()) + dateToX(new Date(year, m + 1, 1).getTime())) / 2
      const label = new Text({
        text: MONTHS[m],
        style: { fill: this.T.colors.textMuted, fontSize: 15, fontFamily: this.T.fonts.body },
      })
      label.resolution = 2
      label.anchor.set(0.5, 0)
      this.root.addChild(label)
      this.monthLabels.push({ text: label, midX })
    }

    // ---- Meerdaagse (span) balken op de as (de balk is hun marker) -----------
    // NB: `spans` wordt hieronder (bij de lagen) BOVEN de leaders gehangen, zodat
    // een leader-lijn achter het blok verdwijnt i.p.v. er dwars doorheen te lopen.
    const spans = new Graphics()
    this.spans = spans
    const isSpan = (e: EventSummary): boolean =>
      !!e.endAt && dateToX(parseLocalDate(e.endAt)) - dateToX(parseLocalDate(e.startAt)) > 4
    const spanPalette = this.T.colors.spanPalette.map((c) => opaqueSpan(c, this.T.colors.appBg))
    const spanColor = new Map<string, number>()
    detail.events
      .filter(isSpan)
      .sort((a, b) => parseLocalDate(a.startAt) - parseLocalDate(b.startAt))
      .forEach((e, k) => spanColor.set(e.id, spanPalette[k % spanPalette.length]!))
    // Period/event met een eigen KLEUR-keuze (thema-id of accent) kleurt zijn
    // span-balk met zijn accent-token (zelfde blend als de andere balkjes) —
    // zo is bijv. "een kerstperiode in rood" daadwerkelijk zichtbaar op de
    // tijdlijn. Een puur typografische keuze (alleen titleFont) herkleurt niet.
    for (const e of detail.events) {
      if (!e.theme?.id && !e.theme?.accent) continue
      const accent = resolveTheme(detail.year.theme, e.theme).colors.accent
      spanColor.set(e.id, opaqueSpan(accent, this.T.colors.appBg))
    }
    for (const e of detail.events) {
      if (!isSpan(e)) continue
      const sX = dateToX(parseLocalDate(e.startAt))
      const eX = dateToX(parseLocalDate(e.endAt!))
      spans.rect(sX, -9, eX - sX, 18).fill(spanColor.get(e.id) ?? spanPalette[0]!)
    }
    const anchorXOf = (ev: EventSummary): number => {
      const startX = dateToX(parseLocalDate(ev.startAt))
      if (isSpan(ev)) return (startX + dateToX(parseLocalDate(ev.endAt!))) / 2
      return startX
    }

    // ---- Lagen (achter→voor: leaders < spans < stippen < kaarten) -----------
    // Leaders onderaan, dan de span-blokken (zodat een leader áchter zijn blok
    // verdwijnt), dan de stippen, dan de kaarten bovenop.
    this.root.addChild(this.leaders)
    this.root.addChild(spans)
    this.root.addChild(this.dotsLayer)
    this.root.addChild(this.cardsLayer)

    // ---- Nodes bouwen -------------------------------------------------------
    const fmtDate = (ms: number): string => {
      const d = new Date(ms)
      return `${d.getDate()} ${MONTHS[d.getMonth()]}`
    }
    for (const ev of detail.events) {
      const node = this.buildNode(ev, anchorXOf(ev), isSpan(ev))
      if (isSpan(ev)) {
        node.spanStartX = dateToX(parseLocalDate(ev.startAt))
        node.spanEndX = dateToX(parseLocalDate(ev.endAt!))
        node.dateText = `${fmtDate(parseLocalDate(ev.startAt))} – ${fmtDate(parseLocalDate(ev.endAt!))}`
      } else {
        node.dateText = fmtDate(parseLocalDate(ev.startAt))
      }
      this.nodes.push(node)
      this.cardNodes.push(node)
    }
    // Hoogte-slot (bij één lane): een van-der-Corput-waarde op de DATUMVOLGORDE van
    // alle kaarten — naburige datums krijgen sterk contrasterende hoogtes. De rang en
    // de normalisatie staan bewust hier (constructor, vaste verzameling) en niet per
    // frame over de "nu geplaatste" kaarten: anders verspringt de hoogte van élke
    // kaart zodra er ergens één van kaart naar stip gaat.
    const byDate = [...this.cardNodes].sort((a, b) => a.anchorX - b.anchorX || a.hash - b.hash)
    byDate.forEach((n, i) => (n.dateRank = i))
    if (byDate.length === 1) {
      byDate[0]!.vSlot = 0.5 // één kaart hoort in het midden, niet tegen de as
    } else {
      const vdc = byDate.map((n) => vanDerCorput(n.dateRank + 1))
      const vMinRaw = Math.min(...vdc)
      const vSpan = Math.max(...vdc) - vMinRaw || 1
      byDate.forEach((n, i) => (n.vSlot = (vdc[i]! - vMinRaw) / vSpan))
    }
    // Voorkeurskant afwisselend op DATUMvolgorde: exact 50/50 verdeeld én echt
    // gecorreleerd met de datum, zodat een cluster memories rond dezelfde datum zich
    // over beide kanten verdeelt i.p.v. scheef aan één kant te landen. (Een hash-bit
    // of de belang-index zou net zo ongecorreleerd zijn als de oude `i % 2`.)
    byDate.forEach((n, i) => (n.prefSide = i % 2 === 0 ? -1 : 1))
    // Packing-volgorde: belang-tier eerst (zie admissionOrder).
    this.cardNodes.sort(admissionOrder)

    if (detail.events.length === 0) {
      const hint = new Text({
        text: 'Geen memories in dit jaar',
        style: { fill: this.T.colors.textFaint, fontSize: 20, fontFamily: this.T.fonts.body },
      })
      hint.resolution = 2
      hint.anchor.set(0.5)
      hint.position.set(0, -60)
      this.root.addChild(hint)
    }

    // Dag-indicator (Ctrl).
    this.dayLine.visible = false
    this.root.addChild(this.dayLine)
    this.dayLabel = new Text({
      text: '',
      style: { fill: this.T.colors.textBright, fontSize: 15, fontWeight: '600', fontFamily: this.T.fonts.body },
    })
    this.dayLabel.resolution = 2
    this.dayLabel.anchor.set(0.5, 0)
    this.dayLabel.visible = false
    this.root.addChild(this.dayLabel)

    // Datum-highlight bij hover: gloed/vonk/ping bovenop alles, plus een datumlabel.
    this.hoverLayer.eventMode = 'none'
    this.root.addChild(this.hoverLayer)
    this.dateLabel = new Text({
      text: '',
      style: { fill: this.T.colors.textBright, fontSize: 14, fontWeight: '600', fontFamily: this.T.fonts.body },
    })
    this.dateLabel.resolution = 2
    this.dateLabel.anchor.set(0.5, 1)
    this.dateLabel.visible = false
    this.root.addChild(this.dateLabel)

    // Buurjaar-naam-previews (verschijnen bij overscroll voorbij de grens).
    if (this.neighbors.prev) this.prevLabel = this.buildYearLabel(this.neighbors.prev)
    if (this.neighbors.next) this.nextLabel = this.buildYearLabel(this.neighbors.next)

    this.engine.world.addChild(this.root)
    this.fitCamera()
  }

  /** Grote jaar-naam voor de overscroll-preview (in de root; per frame op de as
   * gepositioneerd + geschaald/gefade o.b.v. de overscroll). */
  private buildYearLabel(text: string): Text {
    const t = new Text({
      text,
      style: { fill: this.T.colors.text, fontSize: 64, fontWeight: '700', fontFamily: this.T.fonts.display },
    })
    t.resolution = 2
    t.anchor.set(0.5)
    t.alpha = 0
    t.visible = false
    this.root.addChild(t)
    return t
  }

  /** Toon de buurjaar-naam aan de kant waar je voorbij de grens trekt: klein +
   * transparant bij weinig overscroll, groter + wit richting de commit-drempel. */
  private renderYearPreview(vp: { width: number; height: number }, z: number, camX: number): void {
    const over = this.engine.camera.overscrollPx // signed rauwe scherm-px
    const active = over > 0 ? this.nextLabel : over < 0 ? this.prevLabel : null
    if (this.prevLabel && this.prevLabel !== active) this.prevLabel.visible = false
    if (this.nextLabel && this.nextLabel !== active) this.nextLabel.visible = false
    if (!active) return
    const t = Math.min(1, Math.abs(over) / YEAR_COMMIT_PX)
    if (t <= 0.001) {
      active.visible = false
      return
    }
    active.visible = true
    active.alpha = 0.25 + 0.75 * t
    active.scale.set((0.5 + 0.65 * t) / z)
    const side = over > 0 ? 1 : -1
    const sx = vp.width / 2 + side * (vp.width / 2 - 150) // ~150px binnen de rand
    active.position.set(camX + (sx - vp.width / 2) / z, 0)
  }

  private buildNode(ev: EventSummary, anchorX: number, isSpan: boolean): Node {
    const eff = effectiveSize(ev.size, ev.itemCount)
    const cardH = cardScreenH(eff, ev.id)
    const cardW = cardH * CARD_ASPECT
    const hasCover = !!ev.coverItemId

    // Elke memory krijgt een tegel. Met cover = foto; zónder cover = een gedempte
    // placeholder-tegel met de titel erin, zodat ook foto-loze memories een
    // volwaardige tegel zijn (en gewoon meedoen in de packing).
    let title: Text | null = null
    let sprite: Sprite | null = null
    let sprite2: Sprite | null = null
    const card = new Container()
    const frame = new Graphics()
    frame
      .rect(-THUMB_W / 2 - BORDER, -THUMB_H / 2 - BORDER, THUMB_W + BORDER * 2, THUMB_H + BORDER * 2)
      .fill(this.T.colors.frame)
    card.addChild(frame)
    if (hasCover) {
      const photoLayer = new Container()
      sprite = new Sprite(Texture.WHITE)
      sprite.anchor.set(0.5)
      sprite.setSize(THUMB_W, THUMB_H)
      sprite.tint = this.T.colors.thumbLoading
      sprite2 = new Sprite(Texture.WHITE)
      sprite2.anchor.set(0.5)
      sprite2.setSize(THUMB_W, THUMB_H)
      sprite2.alpha = 0
      const mask = new Graphics()
      mask.rect(-THUMB_W / 2, -THUMB_H / 2, THUMB_W, THUMB_H).fill(0xffffff)
      photoLayer.addChild(sprite)
      photoLayer.addChild(sprite2)
      photoLayer.addChild(mask)
      photoLayer.mask = mask
      card.addChild(photoLayer)
      if (this.showTitles && ev.title) {
        title = new Text({
          text: truncateTitle(ev.title, TITLE_MAX),
          style: {
            fill: this.T.colors.cardTitle,
            fontSize: 18,
            fontWeight: '600',
            fontFamily: this.T.fonts.title,
            align: 'center',
            wordWrap: true,
            wordWrapWidth: THUMB_W + BORDER * 2,
          },
        })
        title.resolution = 2
        title.anchor.set(0.5, 1)
        title.position.set(0, -(THUMB_H / 2 + BORDER + 6))
        card.addChild(title)
      }
    } else {
      // Placeholder: gedempte kleurvulling + de titel gecentreerd in de tegel.
      const bg = new Graphics()
      bg.rect(-THUMB_W / 2, -THUMB_H / 2, THUMB_W, THUMB_H)
        .fill(placeholderColor(ev.id, this.T.colors.placeholderPalette))
      card.addChild(bg)
      const inner = new Text({
        text: truncateTitle(ev.title ?? 'Memory', 40),
        style: {
          fill: this.T.colors.placeholderText,
          fontSize: 15,
          fontWeight: '600',
          fontFamily: this.T.fonts.title,
          align: 'center',
          wordWrap: true,
          wordWrapWidth: THUMB_W - 20,
        },
      })
      inner.resolution = 2
      inner.anchor.set(0.5)
      inner.position.set(0, 0)
      card.addChild(inner)
    }
    // "In aanbouw"-badge (ezelsoor + klok) exact op de rechterbovenhoek van het
    // frame. Het frame krijgt een constante schérm-randdikte (BORDER_PX /
    // baseScreenScale) — dus de hoek zit in kaart-coördinaten op ±(THUMB/2 + bpx),
    // niet op de vaste BORDER. Zo blijft de badge kloppen bij vergrote tegels.
    let badge: Container | null = null
    if (ev.underConstruction) {
      badge = this.buildUnderConstructionBadge()
      const bpx = BORDER_PX / (cardH / THUMB_H)
      badge.position.set(THUMB_W / 2 + bpx, -(THUMB_H / 2 + bpx))
      card.addChild(badge)
    }
    card.visible = false
    this.cardsLayer.addChild(card)

    // Stip-marker (overflow): niet-span events; een span gebruikt de balk als marker.
    let dot: Container | null = null
    if (!isSpan) {
      dot = new Container()
      const g = new Graphics()
      // Concentrische ring-stip. Belang (size) bepaalt grootte + vorm:
      // gewoon = klein & massief, bijzonder = ring, uitzonderlijk = grotere ring.
      // Kleur: een eigen accent-keuze wint altijd (dus ook een "gewone" memory
      // toont zijn gekozen accent); anders is gewoon grijs en belangrijk het
      // jaar-accent.
      const size = ev.size ?? 50
      const tier = sizeTier(size)
      const customAccent =
        ev.theme?.id || ev.theme?.accent ? resolveTheme(this.yearChoice, ev.theme).colors.accent : null
      const dotColor = customAccent ?? (tier === 0 ? this.T.colors.textMuted : this.T.colors.accent)
      if (tier === 0) {
        // Gewoon: compacte massieve stip (géén ring) — blijft rustig als er veel
        // memories dicht op elkaar staan. Alleen belangrijke memories krijgen een
        // opvallende ring-stip.
        g.circle(0, 0, 3.2).fill(dotColor)
      } else {
        // Bijzonder/uitzonderlijk: concentrische ring-stip. Geen achtergrond-
        // schijfje → overlappende ringen mogen door elkaar heen vallen i.p.v.
        // elkaar hard weg te knippen.
        const outerR = tier === 2 ? DOT_R + 1 : DOT_R - 1
        const ringW = tier === 2 ? 2.1 : 1.8
        g.circle(0, 0, outerR).stroke({ width: ringW, color: dotColor })
        g.circle(0, 0, outerR * 0.4).fill(dotColor)
      }
      dot.addChild(g)
      dot.visible = false
      this.dotsLayer.addChild(dot)
    }

    return {
      eventId: ev.id,
      synthetic: ev.synthetic ?? false,
      spansYears: ev.spansYears ?? false,
      anchorX,
      hasCover,
      isSpan,
      spanStartX: 0,
      spanEndX: 0,
      dateText: '',
      coverItemId: ev.coverItemId,
      eff,
      size: ev.size ?? 50,
      itemCount: ev.itemCount,
      hash: hashId(ev.id),
      // Wordt in de constructor op datumvolgorde afwisselend gezet (zie boven).
      prefSide: -1,
      // repack zet de echte offX vóór het eerste gebruik (de priming van curOffX
      // gebeurt ná repack), dus 0 is hier de juiste startwaarde.
      offX: 0,
      curOffX: 0,
      vSlot: 0.5,
      dateRank: 0,
      cardW,
      cardH,
      baseScreenScale: cardH / THUMB_H,
      lane: null,
      fitScale: 1,
      curFitScale: 1,
      appear: 0,
      curY: 0,
      card,
      frame,
      badge,
      borderAlpha: 1,
      frameDrawnScale: -1,
      title,
      titleSide: 0,
      dot,
      sprite,
      sprite2,
      key: `cover-${ev.coverItemId}`,
      loaded: false,
      hover: 1,
      hitCx: anchorX,
      hitCy: 0,
      hitHalfW: 0,
      hitHalfH: 0,
      wasVisible: false,
      photoIds: ev.photoIds ?? [],
      photoIdx: Math.max(0, (ev.photoIds ?? []).indexOf(ev.coverItemId ?? '')),
      pendingIdx: 0,
      curKey: `cover-${ev.coverItemId}`,
      pendingKey: '',
      nextAt: 0,
      fade: 0,
    }
  }

  /** Ruimte tussen de as en de eerste lane; bij strikt verticale leaders is de
   * S-bocht-ruimte niet nodig, dus mag de eerste lane dichter op de as. */
  private axisClear(): number {
    return this.curvedLeaders ? AXIS_CLEAR_PX : AXIS_CLEAR_STRAIGHT
  }

  /** Afstand tussen twee lanes (kaarthoogte + tussenruimte). */
  private lanePitch(): number {
    return CARD_H_MAX + (this.curvedLeaders ? LANE_GAP_PX : LANE_GAP_STRAIGHT)
  }

  /** Aantal lanes per kant dat in de viewporthoogte past (minimaal 1). Reserveert
   * de volle kaarthoogte + titelruimte in de buitenste lane, zodat een grote
   * kaart met titel niet boven/onder buiten beeld valt. */
  private lanesPerSide(vpH: number): number {
    // Ruimte die de buitenste lane vrijhoudt aan de schermrand. Zonder jaar-titel is
    // ~92px genoeg voor het memory-titellabel dat bóven een top-kaart hangt. Staat de
    // titel ("2024") wél aan, dan is meer nodig zodat een top-kaart of z'n (evt.
    // tweeregelige) label NOOIT door die titel heen loopt — ~138px met marge.
    const titleClear = this.titleInset > 0 ? 138 : 92
    return Math.max(
      1,
      Math.floor((vpH / 2 - this.axisClear() - CARD_H_MAX - titleClear) / this.lanePitch()) + 1,
    )
  }

  /** Scherm-y (px, t.o.v. de as) van het midden van een lane. */
  private laneCenterY(lane: Lane): number {
    return lane.side * (this.axisClear() + CARD_H_MAX / 2 + lane.level * this.lanePitch())
  }

  /** "In aanbouw"-badge: een omgevouwen hoek ("ezelsoor") met een klokje,
   * rechtsboven op een memory-kaart. Herkenbaar als "nog niet af / werk in
   * uitvoering". */
  private buildUnderConstructionBadge(): Container {
    const b = new Container()
    const S = 34 // beenlengte van de vouw-driehoek
    // Rechte hoek in de LOKALE oorsprong (0,0); de aanroeper plaatst de hele
    // badge op de exacte frame-hoek. De vouw loopt naar links en omlaag = de
    // kaart in.
    const shade = new Graphics()
    shade.poly([-S, 0, 0, S, -S + 4, 4]).fill({ color: 0x000000, alpha: 0.16 })
    const fold = new Graphics()
    fold.poly([-S, 0, 0, 0, 0, S]).fill(0xf0872e)
    fold.poly([-S, 0, 0, S]).stroke({ width: 1, color: 0xffffff, alpha: 0.35 })
    // Klokje (wit) in het midden van de vouw.
    const clock = new Graphics()
    const ccx = -S * 0.4
    const ccy = S * 0.4
    const rr = 5.4
    clock.circle(ccx, ccy, rr).stroke({ width: 1.5, color: 0xffffff })
    clock
      .moveTo(ccx, ccy)
      .lineTo(ccx, ccy - rr * 0.62)
      .moveTo(ccx, ccy)
      .lineTo(ccx + rr * 0.5, ccy + rr * 0.12)
      .stroke({ width: 1.5, color: 0xffffff })
    b.addChild(shade, fold, clock)
    return b
  }

  /** Teken een leader-lijntje (as → kaart) in `this.leaders`, dat op 1/zoom is
   * gecounter-scaled → we tekenen in scherm-coördinaten (wereld × z), zodat de
   * lijn SCHERP blijft (geen kartels bij inzoomen) en een constante dikte houdt.
   * Gebogen: een cubic bezier die RECHT omhoog van de as vertrekt, opzij curvet en
   * RECHT de tegel in gaat. Recht: een kaarsrechte lijn. `dateX`/`cardX` = wereld-x
   * (as-datum resp. kaart), `yEnd` = wereld-y van de kaart-onderrand. */
  private drawLeader(dateX: number, cardX: number, yEnd: number, z: number, appear: number): void {
    const x0 = dateX * z
    const x3 = cardX * z
    const y3 = yEnd * z
    this.leaders.moveTo(x0, 0)
    if (this.curvedLeaders && x3 !== x0) {
      // Controlepunten delen de x met hun eindpunt → verticale uiteinden.
      this.leaders.bezierCurveTo(x0, y3 * 0.4, x3, y3 * 0.6, x3, y3)
    } else {
      this.leaders.lineTo(x3, y3)
    }
    this.leaders.stroke({ width: LEADER_WIDTH, color: this.T.colors.leader, alpha: LEADER_ALPHA * appear })
  }

  /** Breedte-dominante fit: het hele jaar past in de breedte; kaarten (constante
   * schermgrootte) vullen de lanes rond de gecentreerde as. */
  private fitCamera(): void {
    const vp = this.engine.viewport()
    // Iets 'krapper' passen: ruimere marge links/rechts van de as (jan/dec staan
    // niet tegen de rand) — 120 scherm-px per kant.
    let zoom = Math.max(this.engine.camera.minZoom, Math.min(vp.width / (AXIS_W + 240), 1))
    // De rand-eis in `repack` garandeert dat geen kaart over de schermrand valt — maar
    // die eis geldt alléén in de overzicht-stand. Dwing daarom af dat de fit-camera
    // ook echt op die stand uitkomt (restMax === 0, zie update()); anders zou de
    // basis-fitzoom er net boven blijven en zou de klem nooit draaien.
    // FIT_SLACK geeft daar speling bij: precies op de drempel zou ~40px vensterkrimp
    // (een geopend paneel, een smallere window) de rand-eis stil uitschakelen, en de
    // jaar-scene herfit niet bij een resize.
    const FIT_SLACK = 40
    zoom = Math.min(zoom, (vp.width / 2 - EDGE_MARGIN - FIT_SLACK) / (AXIS_W / 2))
    // Daarnaast de kaartbreedte zelf reserveren, zodat een rand-kaart (jan/dec) niet
    // half buiten beeld begint. De DRIFT wordt hier bewust NIET gereserveerd: die
    // hoort bij de klem in repack, en dubbel reserveren zou het jaar onnodig uitzoomen.
    const sideMargin = 60 // scherm-px speling per kant
    for (const n of this.cardNodes) {
      const halfExtent = n.cardW / 2 // scherm-px (schaalt niet met zoom)
      const anchorAbs = Math.abs(n.anchorX)
      if (anchorAbs < 1) continue
      const maxZoom = (vp.width / 2 - halfExtent - sideMargin) / anchorAbs
      if (maxZoom < zoom) zoom = maxZoom
    }
    zoom = Math.max(this.engine.camera.minZoom, zoom)
    this.engine.jumpCamera(0, 0, zoom)
  }

  /** Speelse hoogte-variatie per kaart (scherm-px, bij de lane-y opgeteld). Altijd
   * NAAR DE AS toe (dus nooit richting titel/rand, en nooit een botsing met een lane
   * erboven): deterministisch uit de hash. Ruim bij één lane (dan geeft alleen dit
   * hoogte-verschil), beperkt bij meer lanes (die leveren zelf al hoogte-variatie —
   * meer jitter zou naburige lanes kunnen laten botsen). */
  private laneJitter(n: Node): number {
    const side = n.lane ? n.lane.side : 1
    const frac = ((n.hash >>> 16) % 1000) / 1000 // 0..1
    return -side * frac * 14 // beperkte jitter naar de as (alleen bij >1 lane)
  }

  /** Scherm-y (t.o.v. de as) waar een kaart naartoe animeert. Bij MEER lanes: de
   * lane-y + een kleine jitter. Bij ÉÉN lane: de kaart-afstand tot de as volgens z'n
   * verdeelde slot (vMin..vMax) — zo vullen de kaarten de hoogte i.p.v. één lijn. */
  private cardTargetY(n: Node): number {
    const lane = n.lane!
    if (this.lanesN > 1) return this.laneCenterY(lane) + this.laneJitter(n)
    const max = lane.side < 0 ? this.vMaxTop : this.vMaxBottom
    return lane.side * (this.vMin + n.vSlot * (max - this.vMin))
  }

  /** Kaart-layout: lane + horizontale offset per kaart.
   *
   * TOELATING op belang (zie `admissionOrder`): eerst álle uitzonderlijke memories,
   * dan de bijzondere, dan de gewone. Vroeger liep dit op datumvolgorde — wie eerst
   * kwam kreeg de plek, waardoor een uitzonderlijke memory in november een stip werd
   * terwijl een gewone in maart een kaart was.
   *
   * PLAATSING per lane in een op datum gesorteerde lijst bezette intervallen: een
   * kaart komt tussen zijn datum-buren te staan, dus binnen een lane is de x-volgorde
   * altijd gelijk aan de datumvolgorde ⇒ leaders in dezelfde lane kruisen niet, ook
   * al is de invoegvolgorde nu op belang. Is er tussen die buren geen ruimte, dan valt
   * de lane af (we klemmen niet in een leeg venster — dat zou beide buren overlappen).
   *
   * BEHOUD-PASS: een kaart die vorig frame een plek had, probeert die eerst opnieuw
   * (met marge) zodat pannen/zoomen geen kaarten laat verspringen. Daarna pas de rest.
   *
   * Draait niet elk frame, maar alleen bij een gewijzigde camera/zoom/viewport of een
   * expliciete `layoutDirty` (titelruimte, belang, filter) — zie `update()`. */
  private repack(vpW: number, vpH: number): void {
    const z = this.engine.camera.zoom
    const camX = this.engine.camera.x
    const halfW = vpW / 2
    const N = this.lanesPerSide(vpH)
    this.lanesN = N
    const curved = this.curvedLeaders
    // Verticale spreiding (bij één lane): verdeel de kaarten over de VOLLE beschikbare
    // hoogte i.p.v. een smalle band bij de as.
    const V_EDGE = CARD_H_MAX / 2 + 42 + 12 // kaart-half + label + marge
    this.vMin = 118
    this.vMaxTop = Math.max(this.vMin + 70, vpH / 2 - this.titleInset - V_EDGE)
    this.vMaxBottom = Math.max(this.vMin + 70, vpH / 2 - V_EDGE)
    // Hoe ver een kaart max van z'n datum mag afwijken (scherm-px). Bij rechte leaders
    // 0: die staan strikt verticaal onder/boven hun datum.
    const MAX_OFFSET = curved ? Math.min(vpW * 0.38, 440) : 0

    // Overzicht-stand met dode zone (in SCHERM-px; restMax is een wereldmaat). Alleen
    // hier geldt de rand-eis: op fit kán er niet gepand worden, dus is de klem
    // pan-veilig. Ingezoomd zou een camera-afhankelijke klem kaarten zijwaarts laten
    // kruipen t.o.v. hun eigen datum.
    const restMax = Math.max(0, AXIS_W / 2 - (halfW - EDGE_MARGIN) / z)
    if (restMax * z <= 0.5) this.atFitSticky = true
    else if (restMax * z > 20) this.atFitSticky = false
    const clampEdges = this.atFitSticky

    // Strikt verticale leaders: offX is per definitie 0 — óók voor kaarten die stip
    // worden of die pass 1 niet halen. De render/hit-box/culling gaten `curOffX` al op
    // `curvedLeaders`, maar die invariant is dragend genoeg om hem hier hard te zetten
    // in plaats van te vertrouwen op vijf losse gates.
    if (!curved) for (const n of this.cardNodes) n.offX = 0

    // Lege lanes: [kant][level] → op datum gesorteerde intervallen.
    const lanes: LaneSlot[][][] = [[], []]
    for (const s of [0, 1]) for (let l = 0; l < N; l++) lanes[s]![l] = []
    const sideIdx = (side: number): number => (side < 0 ? 0 : 1)

    /** Probeer `n` in (side, level) te plaatsen op `fit` van zijn grootte. `want` is de
     * gewenste scherm-x; `slack` verruimt de toetsen in de behoud-pass. Geeft de
     * definitieve x terug, of null als het niet past. */
    const tryPlace = (
      n: Node,
      side: number,
      level: number,
      fit: number,
      want: number,
      slack: number,
    ): number | null => {
      const list = lanes[sideIdx(side)]![level]!
      const half = (n.cardW * fit) / 2
      const desired = (n.anchorX - camX) * z + halfW
      // Invoegpositie op DATUM → venster tussen de datum-buren.
      let i = 0
      while (i < list.length && list[i]!.anchorX <= n.anchorX) i++
      let lo = i > 0 ? list[i - 1]!.right + CARD_GAP_PX + half - slack : -Infinity
      let hi = i < list.length ? list[i]!.left - CARD_GAP_PX - half + slack : Infinity
      if (clampEdges) {
        // Een cross-jaar-memory ankert dicht bij het uiteinde van de as en heeft daar
        // minder lucht; die krijgt een krappere marge zodat hij een kaart blijft.
        // De slack geldt hier BEWUST niet: dit is de harde "niets over de schermrand"-
        // eis, en met slack zou een krappe marge er precies door opgeheven worden.
        const pad = n.spansYears ? EDGE_PAD_AXIS_END : EDGE_PAD
        lo = Math.max(lo, pad + half)
        hi = Math.min(hi, vpW - pad - half)
      }
      if (lo > hi) return null // leeg venster → deze lane valt af
      let x: number
      if (curved) {
        x = Math.min(hi, Math.max(lo, want))
        if (Math.abs(x - desired) > MAX_OFFSET + slack) return null
      } else {
        // Strikt verticaal: geen offset, dus de datum-x moet zélf vrij zijn.
        x = desired
        if (x < lo || x > hi) return null
      }
      return x
    }

    const commit = (n: Node, side: number, level: number, fit: number, x: number): void => {
      const list = lanes[sideIdx(side)]![level]!
      const half = (n.cardW * fit) / 2
      let i = 0
      while (i < list.length && list[i]!.anchorX <= n.anchorX) i++
      list.splice(i, 0, { anchorX: n.anchorX, left: x - half, right: x + half, node: n })
      n.lane = { side, level }
      n.fitScale = fit
      n.offX = curved ? x - ((n.anchorX - camX) * z + halfW) : 0
    }

    /** Lane-volgorde voor een kaart: voorkeurskant eerst, dan de andere; binnen een
     * kant vanaf een hash-lane (hoogte-variatie) rondlopend. */
    const candidates = (n: Node): { side: number; level: number }[] => {
      const out: { side: number; level: number }[] = []
      const start = N > 1 ? (n.hash >>> 12) % N : 0
      for (const side of [n.prefSide, -n.prefSide]) {
        for (let k = 0; k < N; k++) out.push({ side, level: (start + k) % N })
      }
      return out
    }

    // --- Pass 1: behoud. In toelatingsvolgorde, zodat een hogere tier zijn plek
    // claimt vóór een lagere die 'm zou kunnen innemen. De claim loopt door dezelfde
    // datum-geordende venstertoets als een nieuwe kaart: bij uitzoomen kan de
    // onderlinge x-volgorde omdraaien, en dan hoort de claim te vervallen i.p.v.
    // kruisende leaders op te leveren.
    const KEEP_SLACK = 10
    const placed = new Set<string>()
    for (const n of this.cardNodes) {
      if (!n.lane || !this.primed) continue
      const { side, level } = n.lane
      if (level >= N) continue // minder lanes dan vorig frame (venster verkleind)
      const desired = (n.anchorX - camX) * z + halfW
      // Eerst één krimp-stap terugklimmen: krimpen is een noodgreep, dus zodra er
      // ruimte vrijkomt hoort de kaart weer te groeien. Zonder deze stap zou de
      // behoud-claim de gekrompen maat elk frame opnieuw bevestigen en bleef een
      // kaart permanent klein.
      // De GROEI-claim krijgt bewust géén slack: met slack zou een kaart die net
      // gekrompen is meteen weer op ware grootte passen, en dan zakt de onderlinge
      // tussenruimte structureel onder CARD_GAP_PX. Slack hoort alleen bij het
      // behouden van de huidige maat (dat is de anti-flikker-marge).
      const si = FIT_STEPS.indexOf(n.fitScale as (typeof FIT_STEPS)[number])
      const bigger = si > 0 ? FIT_STEPS[si - 1]! : n.fitScale
      let fit = bigger
      let x = tryPlace(n, side, level, fit, desired + n.offX, bigger === n.fitScale ? KEEP_SLACK : 0)
      if (x === null && bigger !== n.fitScale) {
        fit = n.fitScale
        x = tryPlace(n, side, level, fit, desired + n.offX, KEEP_SLACK)
      }
      if (x === null) continue
      commit(n, side, level, fit, x)
      placed.add(n.eventId)
    }

    // --- Pass 2: de rest, in toelatingsvolgorde. Eerst alle lanes op ware grootte,
    // daarna pas krimpen — kleiner worden is een laatste redmiddel vóór een stip.
    const pending = this.cardNodes.filter((n) => !placed.has(n.eventId))
    let displaced = 0
    const maxDisplace = this.cardNodes.length // harde bovengrens (termineert altijd)
    for (let q = 0; q < pending.length; q++) {
      const n = pending[q]!
      if (placed.has(n.eventId)) continue
      const desired = (n.anchorX - camX) * z + halfW
      const want = desired + driftFor(n.hash)
      const cands = candidates(n)
      // Krimp-stappen die onder de minimum-kaarthoogte zouden duiken overslaan: een
      // tegel van 40px hoog is geen tegel meer (en zou een naar verhouding dikke rand
      // krijgen). Liever een stip dan onleesbaar klein.
      const steps =
        n.eventId === this.resizingId
          ? ([1] as readonly number[]) // gesleepte kaart nooit stil laten krimpen
          : FIT_STEPS.filter((f) => f === 1 || n.cardH * f >= CARD_H_MIN)
      let done = false
      for (const fit of steps) {
        for (const c of cands) {
          const x = tryPlace(n, c.side, c.level, fit, want, 0)
          if (x === null) continue
          commit(n, c.side, c.level, fit, x)
          placed.add(n.eventId)
          done = true
          break
        }
        if (done) break
      }
      if (done) continue
      // Verdringing: een belangrijkere memory mag een al geplaatste, STRIKT minder
      // belangrijke uit zijn plek zetten — anders houdt een 'gewone' kaart die vorig
      // frame toevallig eerder klaar was, een 'uitzonderlijke' voorgoed buiten beeld.
      // Alleen neerwaarts in tier ⇒ twee kaarten kunnen elkaar niet om beurten
      // verdringen; de teller is een harde bovengrens tegen een lange keten.
      if (displaced >= maxDisplace) {
        n.lane = null
        n.fitScale = 1
        continue
      }
      const tier = sizeTier(n.size)
      // Bereik van `n`: het scherm-x-venster waarin hij zou kunnen landen (incl. de
      // verplichte tussenruimte, anders valt een slot dat hem net wél blokkeert erbuiten).
      const reachLo = desired - MAX_OFFSET - n.cardW / 2 - CARD_GAP_PX
      const reachHi = desired + MAX_OFFSET + n.cardW / 2 + CARD_GAP_PX
      let victim: { slot: LaneSlot; side: number; level: number; tier: number } | null = null
      for (const c of cands) {
        for (const slot of lanes[sideIdx(c.side)]![c.level]!) {
          if (slot.right < reachLo || slot.left > reachHi) continue
          const vt = sizeTier(slot.node.size)
          if (vt >= tier) continue
          if (!victim || vt < victim.tier || (vt === victim.tier && slot.node.eff < victim.slot.node.eff)) {
            victim = { slot, side: c.side, level: c.level, tier: vt }
          }
        }
      }
      if (!victim) {
        n.lane = null // nergens plek → stip (overflow)
        n.fitScale = 1
        continue
      }
      // Het slachtoffer wordt gekozen op belang binnen bereik, niet op "blokkeert
      // aantoonbaar". Zet hem daarom voorwaardelijk uit: past `n` daarna alsnog niet,
      // dan draaien we het volledig terug. Zonder die terugdraai zou een mislukte
      // verdringing elk frame een kaart nodeloos wegzetten (en bij pannen zichtbaar
      // laten knipperen).
      const vNode = victim.slot.node
      const vLane = { side: victim.side, level: victim.level }
      const vFit = vNode.fitScale
      const vOffX = vNode.offX
      const list = lanes[sideIdx(victim.side)]![victim.level]!
      const vIdx = list.indexOf(victim.slot)
      list.splice(vIdx, 1)
      placed.delete(vNode.eventId)
      vNode.lane = null
      displaced++
      // Opnieuw proberen, nu de plek vrij is — in álle lanes, want de vrijgekomen
      // ruimte kan ook een andere lane bruikbaar maken.
      for (const fit of steps) {
        for (const c of cands) {
          const x = tryPlace(n, c.side, c.level, fit, want, 0)
          if (x === null) continue
          commit(n, c.side, c.level, fit, x)
          placed.add(n.eventId)
          done = true
          break
        }
        if (done) break
      }
      if (done) {
        pending.push(vNode) // krijgt verderop een nieuwe kans (of wordt stip)
      } else {
        // Terugdraaien: het slachtoffer exact terug op zijn plek, `n` wordt een stip.
        list.splice(vIdx, 0, victim.slot)
        placed.add(vNode.eventId)
        vNode.lane = vLane
        vNode.fitScale = vFit
        vNode.offX = vOffX
        displaced--
        n.lane = null
        n.fitScale = 1
      }
    }
  }

  dateAt(worldX: number): string {
    const p = Math.min(1, Math.max(0, (worldX + AXIS_W / 2) / AXIS_W))
    const d = new Date(this.yearStart + p * this.span)
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    return `${d.getFullYear()}-${mm}-${dd}`
  }

  setDayPicker(active: boolean): void {
    this.dayPicker = active
    this.renderDay()
  }

  /** Reserveer bovenaan ruimte voor de titel, zodat de dag-gids eronder begint.
   * `px` = scherm-pixels (0 als er geen titel staat). */
  setTitleInset(px: number): void {
    if (this.titleInset === Math.max(0, px)) return
    this.titleInset = Math.max(0, px)
    // Stuurt lanesPerSide + de verticale spreiding, en kan zonder camerabeweging
    // wisselen (T-toets) → expliciet herpakken.
    this.layoutDirty = true
    if (this.dayPicker && this.hoverWX !== null) {
      this.drawDayIndicator(this.engine.viewport(), 1 / this.engine.camera.zoom)
    }
  }

  /** Datum-highlight bij hover aan/uit. Uit → laag + label meteen leeg. */
  setHoverPulse(on: boolean): void {
    this.hoverPulse = on
    if (!on) {
      this.hoverLayer.clear()
      this.dateLabel.visible = false
      this.fxId = null
      this.fxGlow = 0
      this.fxSparkActive = false
      this.fxPing = 0
    }
  }

  /** Week/dag-streepjes tonen bij inzoomen aan/uit (maand blijft altijd). */
  setFineTicks(on: boolean): void {
    this.fineTicks = on
  }

  /** Maatverdeling op de as: maand-streepjes altijd; week- en dag-streepjes faden in
   * bij inzoomen (gegradueerd in hoogte + opaciteit). Op schermresolutie (constante
   * hoogte, scherp), per frame hertekend; alleen de zichtbare streepjes. */
  private drawTicks(z: number, invZ: number, camX: number, halfW: number): void {
    const g = this.ticksLayer
    g.clear()
    g.scale.set(invZ)
    const col = this.T.colors.axisTick
    // Maand-separators (altijd): 11 streepjes op de 1e van elke maand (voorberekend).
    for (const wx of this.monthTickX) {
      g.moveTo(wx * z, -MONTH_TICK_H).lineTo(wx * z, MONTH_TICK_H).stroke({ width: 1, color: col, alpha: MONTH_TICK_ALPHA })
    }
    if (!this.fineTicks) return
    const monthPx = (AXIS_W / 12) * z // breedte van één maand op het scherm
    const weekA = smoothstep(WEEK_FADE_LO, WEEK_FADE_HI, monthPx) * WEEK_TICK_ALPHA
    const dayA = smoothstep(DAY_FADE_LO, DAY_FADE_HI, monthPx) * DAY_TICK_ALPHA
    if (weekA <= 0.02 && dayA <= 0.02) return
    // Alleen de zichtbare dagen aflopen (kalendercorrect i.v.m. zomertijd).
    const msAt = (wx: number): number => this.yearStart + ((wx + AXIS_W / 2) / AXIS_W) * this.span
    const yearEnd = new Date(this.year, 11, 31, 23, 59, 59).getTime()
    const lo = Math.max(this.yearStart, msAt(camX - halfW / z))
    const hi = Math.min(yearEnd, msAt(camX + halfW / z))
    const d = new Date(lo)
    d.setHours(0, 0, 0, 0)
    while (d.getTime() <= hi) {
      const t = d.getTime()
      // Maand-eerste is al een maand-streepje; sla 'm over (geen dubbele/opgetelde alfa).
      if (d.getDate() !== 1) {
        const x = (-AXIS_W / 2 + ((t - this.yearStart) / this.span) * AXIS_W) * z
        if (d.getDay() === 1 && weekA > 0.02) {
          g.moveTo(x, -WEEK_TICK_H).lineTo(x, WEEK_TICK_H).stroke({ width: 1, color: col, alpha: weekA })
        } else if (dayA > 0.02) {
          g.moveTo(x, -DAY_TICK_H).lineTo(x, DAY_TICK_H).stroke({ width: 1, color: col, alpha: dayA })
        }
      }
      d.setDate(d.getDate() + 1)
    }
  }

  /** Datum-highlight: één vonk kaart→stip, bij aankomst een ping op de stip (of gloed
   * op de balk bij een periode), en zolang je hovert een kalme gloed + datumlabel.
   * Alles op schermresolutie (de laag is met 1/zoom counter-scaled). */
  private drawHoverFx(z: number, invZ: number, dt: number): void {
    this.hoverLayer.clear()
    this.hoverLayer.scale.set(invZ)
    if (!this.hoverPulse) {
      this.dateLabel.visible = false
      return
    }
    // Idle: niets te doen én niets meer af te bouwen → sla de node-scan over.
    if (
      this.hoveredId === null &&
      this.fxId === null &&
      this.fxGlow <= 0.02 &&
      !this.fxSparkActive &&
      this.fxPing <= 0
    ) {
      this.dateLabel.visible = false
      return
    }
    // Actieve node = de gehoverde, zichtbare kaart (geen stip/overflow).
    const hov = this.nodes.find((n) => n.eventId === this.hoveredId && n.appear > 0.5)
    const hovId = hov?.eventId ?? null
    if (hovId !== this.fxId) {
      // Hover-wissel → (her)start de vonk vanaf de kaart; de stip/balk begint DONKER
      // en licht pas op als de vonk de as raakt.
      this.fxId = hovId
      this.fxSpark = 0
      this.fxSparkActive = hovId !== null
      this.fxPing = 0
      this.fxGlow = 0
    }
    // Gloed (stip/balk + datumlabel) pas als de vonk is aangekomen (fxSparkActive uit).
    const lit = hov && !this.fxSparkActive
    this.fxGlow += ((lit ? 1 : 0) - this.fxGlow) * 0.22
    if (this.fxSparkActive) {
      this.fxSpark += dt / HOVER_SPARK_MS
      if (this.fxSpark >= 1) {
        this.fxSpark = 1
        this.fxSparkActive = false
        this.fxPing = 0.0001 // start de aankomst-ping
      }
    }
    if (this.fxPing > 0 && this.fxPing < 1) {
      this.fxPing = Math.min(1, this.fxPing + dt / HOVER_PING_MS)
    }

    const n = this.fxId ? this.nodes.find((x) => x.eventId === this.fxId) : undefined
    if (!n) {
      this.dateLabel.visible = false
      return
    }
    // NB: de vonk (verderop) tekent tijdens de reis; de gloed/ping/label hangen op
    // fxGlow (alpha) en zijn dus vanzelf onzichtbaar zolang de vonk nog onderweg is.

    const I = HOVER_INTENSITY
    const acc = this.T.colors.accent
    const dotX = n.anchorX * z
    // Zelfde gating als de rest van de renderlus: bij rechte leaders staat de kaart
    // strikt boven zijn datum, dus geen offset in het vonk-pad.
    const cardXl = n.anchorX * z + (this.curvedLeaders ? n.curOffX : 0)
    const grow = 0.5 + 0.5 * n.appear
    const side = n.lane ? n.lane.side : n.curY < 0 ? -1 : 1
    // leader-eind (kaart-onderrand), scherm-y
    const cardYl = n.curY - side * ((n.cardH * n.curFitScale) / 2) * grow

    // Gloed terwijl je hovert: stip → zachte cirkel; periode → de balk licht op.
    if (n.isSpan) {
      const sX = n.spanStartX * z
      const eX = n.spanEndX * z
      this.hoverLayer.rect(sX, -9, eX - sX, 18).fill({ color: acc, alpha: HOVER_SPAN_GLOW_ALPHA * this.fxGlow * I })
    } else {
      this.hoverLayer.circle(dotX, 0, DOT_R + 4).fill({ color: acc, alpha: HOVER_GLOW_ALPHA * this.fxGlow * I })
      if (this.fxPing > 0 && this.fxPing < 1) {
        const r = DOT_R + this.fxPing * HOVER_PING_GROW
        this.hoverLayer
          .circle(dotX, 0, r)
          .stroke({ width: 1.5, color: acc, alpha: (1 - this.fxPing) * HOVER_PING_ALPHA * I })
      }
    }

    // Vonk langs de leader (kaart→stip). p: 0=kaart, 1=stip ⇒ bezier-param u = 1-p.
    if (this.fxSparkActive) {
      const bez = (a: number, b: number, c: number, d: number, u: number): number => {
        const t = 1 - u
        return t * t * t * a + 3 * t * t * u * b + 3 * t * u * u * c + u * u * u * d
      }
      const at = (u: number): [number, number] => [
        bez(dotX, dotX, cardXl, cardXl, u),
        bez(0, cardYl * 0.4, cardYl * 0.6, cardYl, u),
      ]
      const p = this.fxSpark
      const [gx, gy] = at(1 - p)
      // Zachte accent-halo om de kern.
      this.hoverLayer.circle(gx, gy, HOVER_SPARK_R * 2.4).fill({ color: acc, alpha: 0.22 * I })
      // Kern + korte staart (staart iets richting de kaart = grotere u).
      for (let k = 0; k < 4; k++) {
        const [sx, sy] = at(Math.min(1, 1 - p + k * 0.05))
        const a = (k === 0 ? HOVER_SPARK_ALPHA : HOVER_SPARK_ALPHA * (1 - k / 4) * 0.5) * I
        this.hoverLayer.circle(sx, sy, HOVER_SPARK_R * (k === 0 ? 1 : 0.7)).fill({ color: 0xffffff, alpha: a })
      }
    }

    // Datumlabel net boven de as, bij de stip; faadt met de gloed.
    this.dateLabel.text = n.dateText
    this.dateLabel.scale.set(invZ)
    this.dateLabel.position.set(n.anchorX, -14 * invZ)
    this.dateLabel.alpha = this.fxGlow
    this.dateLabel.visible = this.fxGlow > 0.02 // pas zichtbaar als de vonk is aangekomen
  }

  private bandHalfH(): number {
    const b = this.engine.camera.worldBounds(this.engine.viewport())
    return (b.maxY - b.minY) / 2 + 20
  }

  setRange(startWorldX: number | null, endWorldX: number | null): void {
    this.rangeBand.clear()
    if (startWorldX === null || endWorldX === null) {
      this.hoverWX = null
      this.renderDay()
      return
    }
    const a = Math.min(startWorldX, endWorldX)
    const b = Math.max(startWorldX, endWorldX)
    const h = this.bandHalfH()
    this.rangeBand.rect(a, -h, b - a, 2 * h).fill({ color: this.T.colors.accent, alpha: 0.14 })
    this.hoverWX = endWorldX
    this.renderDay()
  }

  // Zichtbaarheid + directe verberging. De eigenlijke geometrie/label-plaatsing
  // gebeurt in drawDayIndicator: op schermresolutie, dus zoom-onafhankelijk.
  private renderDay(): void {
    const show = this.dayPicker && this.hoverWX !== null
    this.dayLine.visible = show
    this.dayLabel.visible = show
    if (!show) {
      this.dayLine.clear()
      return
    }
    // Meteen bijwerken (responsief op muisbeweging); de frame-lus doet het daarna
    // per frame opnieuw zodat de lijn ook tijdens zoomen op zijn plek blijft.
    this.drawDayIndicator(this.engine.viewport(), 1 / this.engine.camera.zoom)
  }

  /** Verticale dag-gids (Ctrl): op schermresolutie getekend (scale = 1/zoom), zodat
   * hij ALTIJD 1px breed is en exact het beeld vult — onafhankelijk van in-/uitzoomen
   * — en niet buiten beeld doorloopt. De X volgt de hover-wereld-X; het datumlabel
   * staat bovenaan, binnen beeld. */
  private drawDayIndicator(vp: { width: number; height: number }, invZ: number): void {
    if (!this.dayPicker || this.hoverWX === null) return
    const halfH = vp.height / 2
    // Staat de titel aan, dan begint alles eronder (titleInset); anders een klein
    // gaatje vanaf de bovenrand.
    const topPad = Math.max(12, this.titleInset) // label-top t.o.v. de bovenrand
    const botPad = 12 // afstand van de lijn tot de onderrand
    const labelGap = 22 // ruimte tussen label en lijn-top (geen overlap)
    // camera.y = 0 ⇒ lokale y = 0 valt op het verticale midden; met scale = invZ
    // zijn de lokale eenheden gelijk aan scherm-pixels.
    this.dayLine.scale.set(invZ)
    this.dayLine.position.set(this.hoverWX, 0)
    this.dayLine.clear()
    this.dayLine
      .moveTo(0, -halfH + topPad + labelGap)
      .lineTo(0, halfH - botPad)
      .stroke({ width: 1, color: this.T.colors.accent, alpha: 0.9 })
    const p = Math.min(1, Math.max(0, (this.hoverWX + AXIS_W / 2) / AXIS_W))
    const d = new Date(this.yearStart + p * this.span)
    this.dayLabel.text = `${d.getDate()} ${MONTHS[d.getMonth()]}`
    this.dayLabel.scale.set(invZ)
    this.dayLabel.position.set(this.hoverWX, (-halfH + topPad) * invZ)
  }

  onHover(worldX: number | null, worldY: number): void {
    this.hoveredId = worldX === null ? null : this.hitTest(worldX, worldY)
    this.hoverWX = worldX
    if (this.dayPicker) this.renderDay()
  }

  update(ctx: FrameContext): void {
    const { engine, frame, dtMS } = ctx
    const now = performance.now()
    const dt = Math.min(dtMS, 100)
    // De verticale uitlijning hangt op camera.y=0 (lockY dwingt dat af, maar we
    // forceren het defensief zodat een restwaarde de counter-scale niet breekt).
    engine.camera.y = 0
    const z = engine.camera.zoom
    const invZ = 1 / z
    const camX = engine.camera.x
    const vp = engine.viewport()
    const halfW = vp.width / 2
    const marginPx = 120

    // Elastische horizontale scroll-grens: bij het overzicht (as past in beeld)
    // geen scroll; ingezoomd kun je tot de rand scrollen (rand-kaarten net binnen
    // beeld), daarna rubber-band + terugveren (afgehandeld in de gesture-laag).
    const restMax = Math.max(0, AXIS_W / 2 - (halfW - EDGE_MARGIN) / z)
    engine.camera.boundsX = { min: -restMax, max: restMax }

    // Buurjaar-naam-preview bij overscroll voorbij de grens.
    this.renderYearPreview(vp, z, camX)

    // Maandlabels: constante schermgrootte, meebewegend met de uitrekkende as.
    for (const ml of this.monthLabels) {
      ml.text.scale.set(invZ)
      ml.text.position.set(ml.midX, LABEL_SCREEN_Y * invZ)
    }

    // Maand/week/dag-liniaal (week/dag faden in bij inzoomen).
    this.drawTicks(z, invZ, camX, halfW)

    // Dag-gids (Ctrl): per frame op schermresolutie hertekenen zodat hij bij zoomen
    // op zijn plek blijft, 1px breed blijft en niet buiten beeld doorloopt.
    if (this.dayPicker && this.hoverWX !== null) this.drawDayIndicator(vp, invZ)

    // Lane-toewijzing (kaart vs. stip) opnieuw bepalen — alleen als de layout-input
    // wijzigde. De camera-drempel staat in SCHERM-px (camera.x is een wereldmaat die
    // repack zelf met z omrekent); zonder drempel zou de elastische terugveer een
    // eindeloze stroom sub-pixel-deltas geven en werd de check nooit "clean".
    if (
      this.layoutDirty ||
      !(Math.abs(camX - this.lastCamX) * z < 0.5) ||
      !(Math.abs(z - this.lastZoom) / z < 1e-4) ||
      vp.width !== this.lastVpW ||
      vp.height !== this.lastVpH
    ) {
      this.lastCamX = camX
      this.lastZoom = z
      this.lastVpW = vp.width
      this.lastVpH = vp.height
      this.layoutDirty = false
      this.repack(vp.width, vp.height)
    }

    // Leader-laag op schermresolutie tekenen (scherp): counter-scale met 1/zoom en
    // teken in wereld×z-coördinaten (zie drawLeader).
    this.leaders.clear()
    this.leaders.scale.set(invZ)

    // Periode-balken: alleen de HOOGTE counter-scalen (1/zoom) zodat de balk bij
    // inzoomen zijn oorspronkelijke schermhoogte houdt; de breedte blijft
    // meeschalen met de as (die vertegenwoordigt immers de tijdsduur).
    if (this.spans) this.spans.scale.set(1, invZ)

    for (const n of this.nodes) {
      const screenX = (n.anchorX - camX) * z + halfW
      // Culling dekt zowel de stip (op de as, screenX) als de kaart (met offset).
      // `fitScale` is de krimpfactor uit de packing (1 = ware grootte).
      const cardOff = this.curvedLeaders ? n.curOffX : 0
      const halfCardW = (n.cardW * n.curFitScale) / 2
      const loX = screenX + Math.min(0, cardOff) - halfCardW
      const hiX = screenX + Math.max(0, cardOff) + halfCardW
      const inView = hiX > -marginPx && loX < vp.width + marginPx
      const wasVisible = n.wasVisible
      n.wasVisible = inView

      // Animatie-doel: heeft dit event een lane → kaart (appear→1) op laneY;
      // anders stip/overflow (appear→0) op de as. Eerste frame snapt (primed).
      const hasLane = !!n.lane
      const targetAppear = hasLane ? 1 : 0
      const targetY = hasLane ? this.cardTargetY(n) : 0
      if (!this.primed) {
        n.appear = targetAppear
        n.curY = targetY
        n.curOffX = n.offX
        n.curFitScale = n.fitScale
      } else {
        n.appear += (targetAppear - n.appear) * 0.16
        n.curY += (targetY - n.curY) * 0.16
        // Krimpen/terugveren glijdt mee i.p.v. in één frame om te klappen.
        n.curFitScale += (n.fitScale - n.curFitScale) * 0.16
        // offX glijdt naar z'n doel: een lane-/spreiding-wissel bij zoomen schuift
        // de kaart zacht opzij i.p.v. een sprong.
        n.curOffX += (n.offX - n.curOffX) * 0.16
      }
      const off = (((n.hash >>> 3) % 5) - 2) * 6 // scherm-offset bij same-date stippen

      // --- Kaart (cover-event, terwijl appear>0): stijgt op uit de as ---
      if (n.card) {
        const showCard = inView && n.appear > 0.01
        n.card.visible = showCard
        if (showCard) {
          // Witte rand op CONSTANTE schermdikte (BORDER_PX) houden: de kaart wordt met
          // baseScreenScale × fitScale geschaald, dus teken de rand-breedte omgekeerd
          // mee → grote/belangrijke tegels krijgen geen dikkere rand. Alleen
          // hertekenen als die effectieve schaal wijzigt (resize of krimp-stap; de
          // krimp is gekwantiseerd, dus dat blijft zeldzaam).
          const drawScale = n.baseScreenScale * n.fitScale
          if (n.frame && n.frameDrawnScale !== drawScale) {
            n.frameDrawnScale = drawScale
            const b = BORDER_PX / drawScale
            n.frame.clear()
            n.frame
              .rect(-THUMB_W / 2 - b, -THUMB_H / 2 - b, THUMB_W + b * 2, THUMB_H + b * 2)
              .fill(this.T.colors.frame)
            // Badge volgt de (nu mogelijk andere) frame-hoek na een resize.
            if (n.badge) n.badge.position.set(THUMB_W / 2 + b, -(THUMB_H / 2 + b))
          }
          const targetHover = n.eventId === this.hoveredId ? 1.05 : 1
          n.hover += (targetHover - n.hover) * 0.2
          const grow = 0.5 + 0.5 * n.appear // van ~half (bij de as) naar vol
          // Kant volgt de doel-lane (niet het curY-teken) zodat een zeldzame
          // lane-flip niet één frame door de as "duikt" met omklappende titel/leader.
          const side = n.lane ? n.lane.side : n.curY < 0 ? -1 : 1
          const cardX = n.anchorX + (this.curvedLeaders ? n.curOffX : 0) * invZ
          n.card.position.set(cardX, n.curY * invZ)
          n.card.scale.set(n.baseScreenScale * n.curFitScale * n.hover * grow * invZ)
          n.card.alpha = n.appear

          // Titel-kant volgt de (huidige) lane.
          if (n.title && n.titleSide !== side) {
            n.titleSide = side
            n.title.anchor.set(0.5, side < 0 ? 1 : 0)
            n.title.position.set(0, side * (THUMB_H / 2 + BORDER + 6))
          }

          // Leader: van de datum op de as naar de onderrand van de (verschoven)
          // kaart; faadt met appear.
          const innerY = (n.curY - side * ((n.cardH * n.curFitScale) / 2) * grow) * invZ
          this.drawLeader(n.anchorX, cardX, innerY, z, n.appear)

          // Texture (alleen zichtbare kaarten laden/warmen een texture).
          if (n.sprite && !n.loaded && n.coverItemId) {
            const tex = engine.textures.get(n.key, frame)
            if (tex) {
              n.sprite.texture = tex
              n.sprite.tint = 0xffffff
              fitCover(n.sprite, tex)
              n.loaded = true
              n.curKey = n.key
              if (n.nextAt === 0) n.nextAt = now + this.slideMs * (0.3 + Math.random())
            } else {
              const src = this.backend.thumb(n.coverItemId, 256)
              engine.textures.request({ key: n.key, url: src.url, hue: src.hue, size: 256 })
            }
          }
          if (n.loaded) {
            if (n.curKey) engine.textures.get(n.curKey, frame)
            if (n.fade > 0 && n.pendingKey) engine.textures.get(n.pendingKey, frame)
          }
          if (!wasVisible && n.loaded) {
            if (n.fade > 0 && n.sprite2) {
              n.sprite2.alpha = 0
              n.fade = 0
              n.pendingKey = ''
            }
            n.nextAt = now + this.slideMs * (0.3 + Math.random())
          }
          // Slideshow alleen op een (vrijwel) volledig opgestegen kaart.
          if (this.slideEnabled && n.appear > 0.9 && n.loaded && n.sprite && n.sprite2 && n.photoIds.length > 1) {
            this.tickSlideshow(n, engine, frame, now, dt)
          }
        }
      }

      // --- Stip: vol zichtbaar bij de as (waar de kaart uit opstijgt) en daarna
      // een blijvende, subtiele markering op de jaarlijn — precies waar de
      // leader-lijn aankomt (schuift bij het opstijgen naar die basis toe). ----
      if (n.dot) {
        const SUBTLE = 0.5 // rest-alpha van de stip zodra de kaart volledig boven staat
        const dotAlpha = 1 - n.appear + SUBTLE * n.appear
        const showDot = inView && dotAlpha > 0.01
        n.dot.visible = showDot
        if (showDot) {
          // Bij het opstijgen glijdt de stip van zijn spreid-offset naar de
          // leader-basis (anchorX) zodat 'ie netjes onder de lijn eindigt.
          n.dot.position.set(n.anchorX + off * invZ * (1 - n.appear), 0)
          n.dot.scale.set(invZ)
          n.dot.alpha = dotAlpha
        }
      }

      // --- Hit-box: de kaart als die overheerst, anders de stip -------------
      if (!inView) {
        n.hitHalfW = 0
      } else if (n.appear > 0.5) {
        n.hitCx = n.anchorX + (this.curvedLeaders ? n.curOffX : 0) * invZ
        n.hitCy = n.curY * invZ
        n.hitHalfW = ((n.cardW * n.curFitScale) / 2 + BORDER) * invZ
        n.hitHalfH = ((n.cardH * n.curFitScale) / 2 + BORDER) * invZ
      } else if (n.dot) {
        n.hitCx = n.anchorX + off * invZ
        n.hitCy = 0
        n.hitHalfW = Math.max(MARKER_HIT_MIN, DOT_HIT) * invZ
        n.hitHalfH = DOT_HIT * invZ
      } else {
        // Span-overflow: alleen de balk op de as is de marker (niet klikbaar hier).
        n.hitHalfW = 0
      }
    }
    this.animateBorders(ctx.dtMS)
    // Datum-highlight bij hover (na de node-lus: gebruikt de nu bijgewerkte curOffX/
    // curY/appear van de gehoverde kaart).
    this.drawHoverFx(z, invZ, dt)
    this.primed = true
  }

  /** Bij actieve toetsenbord-nav houdt alleen de gefocuste tegel z'n witte rand;
   * de rest faadt weg ("zoep"). Zonder nav hebben alle tegels hun rand. */
  private animateBorders(dtMS: number): void {
    const k = Math.min(1, dtMS / 130) // ~130ms fade
    for (const n of this.nodes) {
      if (!n.frame) continue
      const target = this.kbFocusId === null ? 1 : n.eventId === this.kbFocusId ? 1 : 0
      n.borderAlpha += (target - n.borderAlpha) * k
      n.frame.alpha = n.borderAlpha
    }
  }

  // ---- Toetsenbord-navigatie (spatial) --------------------------------------

  /** Nodes in navigatievolgorde: op datum (anchorX), dan verticaal (curY). */
  private focusOrder(): Node[] {
    return [...this.nodes].sort((a, b) => a.anchorX - b.anchorX || a.curY - b.curY || a.hash - b.hash)
  }

  private scrollIntoView(n: Node): void {
    const z = this.engine.camera.zoom
    // Wereld-x van de kaart zelf (incl. horizontale offset t.o.v. z'n datum).
    const cardX = n.anchorX + (this.curvedLeaders ? n.offX : 0) / z
    const b = this.engine.camera.worldBounds(this.engine.viewport())
    // Iets ruimere marge → begint eerder (rustiger) te schuiven i.p.v. op het
    // laatste moment; langere, zachte pan voor een organischer gevoel.
    const margin = (b.maxX - b.minX) * 0.28
    if (cardX < b.minX + margin || cardX > b.maxX - margin) {
      // Snel starten, zacht/lang uitlopen (easeOutQuint) → vloeiend en organisch.
      this.engine.animateCamera(cardX, 0, z, 820, (t) => 1 - Math.pow(1 - t, 5))
    }
  }

  focusFirst(): string | null {
    if (this.nodes.length === 0) return null
    const cx = this.engine.camera.x
    let best: Node | null = null
    let bestD = Infinity
    for (const n of this.nodes) {
      const d = Math.abs(n.anchorX - cx)
      if (d < bestD) {
        bestD = d
        best = n
      }
    }
    this.kbFocusId = best?.eventId ?? null
    if (best) this.scrollIntoView(best)
    return this.kbFocusId
  }

  focusNeighbor(dir: 'left' | 'right' | 'up' | 'down'): string | null {
    const order = this.focusOrder()
    if (order.length === 0) return null
    const cur = order.findIndex((n) => n.eventId === this.kbFocusId)
    if (cur < 0) return this.focusFirst()
    const step = dir === 'right' || dir === 'down' ? 1 : -1
    const n = order[Math.max(0, Math.min(order.length - 1, cur + step))]
    this.kbFocusId = n.eventId
    this.scrollIntoView(n)
    return this.kbFocusId
  }

  focusedId(): string | null {
    return this.kbFocusId
  }

  clearKbFocus(): void {
    this.kbFocusId = null // animateBorders zet alle randen weer terug
  }

  /** Zet de focus direct op een event-id (als het bestaat), zonder camera-beweging.
   * Voor focus-continuïteit bij terugkeer uit een memory (L2). */
  focusOn(id: string): void {
    if (this.nodes.some((n) => n.eventId === id)) this.kbFocusId = id
  }

  private tickSlideshow(n: Node, engine: RenderEngine, frame: number, now: number, dt: number): void {
    const s2 = n.sprite2!
    const s1 = n.sprite!
    if (n.fade > 0) {
      n.fade += dt / 300
      s2.alpha = Math.min(1, n.fade)
      if (n.fade >= 1) {
        s1.texture = s2.texture
        s1.setSize(s2.width, s2.height)
        s2.alpha = 0
        n.photoIdx = n.pendingIdx
        n.curKey = n.pendingKey
        n.pendingKey = ''
        n.fade = 0
        n.nextAt = now + this.slideMs * (0.7 + Math.random() * 0.6)
      }
      return
    }
    if (now < n.nextAt) return
    const nextIdx = (n.photoIdx + 1) % n.photoIds.length
    const key = `cover-${n.photoIds[nextIdx]}`
    const tex = engine.textures.get(key, frame)
    if (tex) {
      s2.texture = tex
      s2.tint = 0xffffff
      fitCover(s2, tex)
      s2.alpha = 0
      n.pendingIdx = nextIdx
      n.pendingKey = key
      n.fade = 0.001
    } else {
      const src = this.backend.thumb(n.photoIds[nextIdx], 256)
      engine.textures.request({ key, url: src.url, hue: src.hue, size: 256 })
    }
  }

  hitTest(worldX: number, worldY: number): string | null {
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const n = this.nodes[i]
      if (n.hitHalfW <= 0) continue
      if (Math.abs(worldX - n.hitCx) <= n.hitHalfW && Math.abs(worldY - n.hitCy) <= n.hitHalfH) {
        return n.eventId
      }
    }
    return null
  }

  /** Shift-slepen op een cover-kaart wijzigt het belang (grootte): de kaart-
   * schermgrootte volgt live; bij loslaten persisteren we de nieuwe `size`. */
  beginResize(worldX: number, worldY: number): DragHandle | null {
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const n = this.nodes[i]
      if (!n.lane || n.hitHalfW <= 0) continue
      if (Math.abs(worldX - n.hitCx) > n.hitHalfW || Math.abs(worldY - n.hitCy) > n.hitHalfH) continue
      if (n.synthetic) return null // "Losse foto's"-bundel: grootte niet curetaarbaar
      const cx = n.hitCx
      const cy = n.hitCy
      const startDist = Math.max(20, Math.hypot(worldX - cx, worldY - cy))
      const startSize = n.size
      let changed = false
      const apply = (size: number): void => {
        n.size = Math.max(1, Math.min(100, Math.round(size)))
        n.eff = effectiveSize(n.size, n.itemCount)
        n.cardH = cardScreenH(n.eff, n.eventId)
        n.cardW = n.cardH * CARD_ASPECT
        n.baseScreenScale = n.cardH / THUMB_H
        // Tijdens het slepen de kaart op ware grootte houden (zie `resizingId`):
        // anders zou de packer 'm stil verkleinen terwijl je 'm groter sleept.
        n.fitScale = 1
        // Belang veranderde → de toelatingsvolgorde en de benodigde breedte ook.
        this.cardNodes.sort(admissionOrder)
        this.layoutDirty = true
      }
      this.resizingId = n.eventId
      const release = (): void => {
        this.resizingId = null
        this.layoutDirty = true // packer mag hem nu weer verkleinen als het moet
      }
      return {
        moveTo: (mx, my) => {
          const f = Math.hypot(mx - cx, my - cy) / startDist
          apply(startSize * f)
          changed = true
        },
        end: () => {
          release()
          if (changed) void this.backend.setEventSize(n.eventId, n.size)
        },
        // Afgebroken sleep (pointercancel / tweede vinger): niets persisteren én de
        // kaart terug op zijn oorspronkelijke maat, zodat wat je ziet klopt met wat
        // er is opgeslagen.
        cancel: () => {
          if (changed) apply(startSize)
          release()
        },
      }
    }
    return null
  }

  destroy(): void {
    this.root.destroy({ children: true })
  }
}
