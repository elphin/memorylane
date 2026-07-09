// L1 — Jaar: een horizontale maand-tijdlijn (Jan–Dec) met per event een
// thumbnail op zijn datum. Bij drukte stapelen thumbnails boven én onder de as,
// elk met een leader-lijntje naar de datumplek. Klik op een event → L2-canvas.
// Zo zijn de niveaus consistent: L1 = jaar-tijdlijn van events, L2 = foto's van
// één event, L3 = één foto.

import { Container, Graphics, Sprite, Text, Texture } from 'pixi.js'
import type { Backend, EventSummary, YearDetail } from '../../lib/backend'
import type { FrameContext, RenderEngine } from '../core/engine'
import type { DragHandle } from '../core/gestures'
import type { Scene } from './scene'

const AXIS_W = 2400 // wereldbreedte van de jaar-as (Jan..Dec)
const THUMB_W = 168
const THUMB_H = 126
const BORDER = 8
const AXIS_GAP = 118 // afstand as → midden van de eerste lane-kaart
const LABEL_CLEARANCE = 46 // extra ruimte onder de as (voor de maandnamen)
const LANE_GAP = 22 // verticale ruimte tussen lanes
const CARD_GAP = 26 // min. horizontale ruimte tussen kaarten in dezelfde lane
const DOT_R = 9 // marker voor events zonder cover

// Belang → kaartschaal. size 50 = standaard (1.0); geklemd zodat kleine events
// leesbaar blijven en grote niet de tijdlijn overheersen.
const CARD_MIN_SCALE = 0.6
const CARD_MAX_SCALE = 1.8
/** Visuele schaal van een event-kaart op basis van zijn `size` (1–100). */
function cardScale(size?: number): number {
  const s = size == null ? 50 : size
  return Math.max(CARD_MIN_SCALE, Math.min(CARD_MAX_SCALE, s / 50))
}

/** Plaatsing van één cover-kaart (resultaat van de lane-packing). */
interface Placement {
  ev: EventSummary
  anchorX: number
  cardX: number
  cardY: number
  side: number
  bs: number // baseScale (grootte-schaal) van deze kaart
  ch: number // geschaalde kaarthoogte
  innerY: number // binnenrand (leader-eindpunt)
  startY: number // leader-startpunt op de as (blokrand bij meerdaags)
}

/** Zuivere lane-packing: plaatst de (op datum gesorteerde) cover-events rond hun
 * datum in lanes boven/onder de as, geschaald met `factor` × hun eigen `size`.
 * Geen Pixi-neveneffecten → herbruikbaar door `setup()` (tekenen) én de
 * "passend maken"-solver (alleen `maxAbsY` meten bij een proef-factor). */
function computePlacements(
  withCoverSorted: EventSummary[],
  factor: number,
  anchorXOf: (ev: EventSummary) => number,
  spanIds: Set<string>,
): { placements: Placement[]; maxAbsY: number } {
  const laneRight: Record<string, number> = {}
  let maxAbsY = 0
  // Speelse verticale variatie: meer events → meer verschil (jitter naar buiten).
  const jyAmp = Math.min(120, 30 + withCoverSorted.length * 2)
  // Constante vrije ruimte as→binnenrand van een lane-0-kaart; rijafstand op de
  // grootst mogelijke kaart, zodat grote/kleine kaarten nooit tussen lanes botsen.
  const INNER_CLEAR = AXIS_GAP - THUMB_H / 2
  const LANE_PITCH = THUMB_H * CARD_MAX_SCALE + LANE_GAP
  const placements: Placement[] = []
  withCoverSorted.forEach((ev, j) => {
    const anchorX = anchorXOf(ev)
    const bs = cardScale((ev.size ?? 50) * factor)
    const cw = THUMB_W * bs
    const ch = THUMB_H * bs
    const seed = hashId(ev.id)
    const jx = ((seed % 1000) / 1000 - 0.5) * 64 // ±32 (speels zijwaarts)
    const jy = (((seed >>> 10) % 1000) / 1000) * jyAmp // 0..jyAmp, altijd naar buiten
    const cardX = anchorX + jx
    const prefer = j % 2 === 0 ? -1 : 1 // -1 = boven (neg. y), 1 = onder
    let side = prefer
    let level = 0
    for (let lvl = 0; lvl < 64; lvl++) {
      const kPref = `${prefer}:${lvl}`
      const kOther = `${-prefer}:${lvl}`
      if (cardX - cw / 2 > (laneRight[kPref] ?? -1e9) + CARD_GAP) {
        side = prefer
        level = lvl
        break
      }
      if (cardX - cw / 2 > (laneRight[kOther] ?? -1e9) + CARD_GAP) {
        side = -prefer
        level = lvl
        break
      }
    }
    laneRight[`${side}:${level}`] = cardX + cw / 2
    const gap = INNER_CLEAR + ch / 2 + (side === 1 ? LABEL_CLEARANCE : 0)
    const cardY = side * (gap + level * LANE_PITCH + jy)
    maxAbsY = Math.max(maxAbsY, Math.abs(cardY) + ch / 2)
    const innerY = cardY - side * (ch / 2)
    const startY = spanIds.has(ev.id) ? side * 9 : 0
    placements.push({ ev, anchorX, cardX, cardY, side, bs, ch, innerY, startY })
  })
  return { placements, maxAbsY }
}

const MONTHS = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec']

interface Node {
  eventId: string
  anchorX: number // x op de as (de datum van het event)
  cardX: number
  cardY: number // 0 voor stip-events (op de as)
  hasCover: boolean
  coverItemId?: string
  container: Container
  sprite: Sprite | null
  sprite2: Sprite | null // crossfade-overlay voor de slideshow
  halfW: number
  halfH: number
  key: string
  loaded: boolean
  scale: number
  baseScale: number // vaste grootte-schaal (belang); apart van de hover-animatie
  size: number // belang 1–100 (bron van baseScale); leeft mee met Shift-resize
  wasVisible: boolean // vorige frame in beeld? (voor nextAt-reset bij herintrede)
  // Slideshow-roulatie (alleen cover-kaarten met >1 foto).
  photoIds: string[]
  photoIdx: number
  pendingIdx: number
  curKey: string // key van de texture die nu in `sprite` zit (warm houden)
  pendingKey: string // key van de texture die nu in `sprite2` zit tijdens een fade
  nextAt: number // frame waarop de volgende foto komt
  fade: number // 0 = niet aan het faden; >0 = crossfade-voortgang
}

// Felle basiskleuren met sterk wisselende tinten (warm/koel afgewisseld, over de
// hele kleurcirkel) zodat twee naburige blokjes altijd contrasteren.
const SPAN_PALETTE_RAW = [
  0xff5c5c, 0x3cd6d6, 0xffd93c, 0xb15cff, 0x6ee06e, 0xff5cc0, 0x5c8cff, 0xffa63c, 0x38c9a0,
  0xf05545,
]
/** Meng een felle kleur met de donkere achtergrond tot een gedimde, maar
 * ONDOORZICHTIGE kleur — zo schijnen de as-lijn en leader niet door het blokje. */
function opaqueSpan(color: number): number {
  const bg = 0x0a0a0f
  const mix = (c: number, b: number): number => Math.round(c * 0.45 + b * 0.55)
  const r = mix((color >> 16) & 255, (bg >> 16) & 255)
  const g = mix((color >> 8) & 255, (bg >> 8) & 255)
  const b = mix(color & 255, bg & 255)
  return (r << 16) | (g << 8) | b
}
const SPAN_PALETTE = SPAN_PALETTE_RAW.map(opaqueSpan)

/** Stabiele hash (FNV-1a) van een id → voor deterministische, "vrije" jitter. */
function hashId(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** Cover-fit een sprite op een thumbnail-kaart (vult, behoudt aspect). */
function fitCover(sprite: Sprite, tex: Texture): void {
  const s = Math.max(THUMB_W / tex.width, THUMB_H / tex.height)
  sprite.setSize(tex.width * s, tex.height * s)
}

/** Parse een `YYYY-MM-DD`-datum LOKAAL (niet als UTC — dat verschuift op
 * jaargrenzen een dag en zou een event buiten het jaar duwen). */
function parseLocalDate(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y || 1970, (m || 1) - 1, d || 1).getTime()
}

export class YearScene implements Scene {
  readonly root = new Container()
  private nodes: Node[] = []
  private hoveredId: string | null = null
  // Ctrl-dag-indicator: toont de datum onder de cursor + Ctrl+klik maakt een event.
  private yearStart = 0
  private span = 1
  private maxAbsY = 0
  private dayPicker = false
  private hoverWX: number | null = null
  private dayLine = new Graphics()
  private dayLabel: Text
  private rangeBand = new Graphics() // Ctrl-sleep-selectie (begin→eind)
  private slideEnabled: boolean
  private slideMs: number
  // Globale event-kaartschaal van dit jaar (proportioneel "passend maken").
  private yearFactor = 1
  // Bewaard voor de "passend maken"-solver: de gesorteerde cover-events + de
  // (zuivere) anchor-x-functie + de set van meerdaagse events.
  private withCoverSorted: EventSummary[] = []
  private anchorXOf: (ev: EventSummary) => number = () => 0
  private spanIds: Set<string> = new Set()

  constructor(
    private engine: RenderEngine,
    private backend: Backend,
    detail: YearDetail,
    slideshow: { enabled: boolean; speedMs: number } = { enabled: false, speedMs: 5000 },
  ) {
    this.slideEnabled = slideshow.enabled
    this.slideMs = Math.max(800, slideshow.speedMs)
    const year = detail.year.year
    const yearStart = new Date(year, 0, 1).getTime()
    const yearEnd = new Date(year, 11, 31, 23, 59, 59).getTime()
    const span = Math.max(1, yearEnd - yearStart)
    this.yearStart = yearStart
    this.span = span
    // Factor uit `_year.md` (afwezig/≈1.0 = geen schaling), geklemd voor de zekerheid.
    this.yearFactor = Math.max(0.1, Math.min(5, detail.year.sizeFactor ?? 1))
    const dateToX = (ms: number): number => {
      const p = Math.min(1, Math.max(0, (ms - yearStart) / span))
      return -AXIS_W / 2 + p * AXIS_W
    }

    // ---- Achtergrond: as-lijn, maand-separators en -labels -----------------
    const axis = new Graphics()
    // pixelLine: alle lijnen blijven 1 scherm-pixel, ongeacht de zoom (strak).
    axis.moveTo(-AXIS_W / 2, 0).lineTo(AXIS_W / 2, 0).stroke({ width: 1, color: 0x3a4256, pixelLine: true })
    for (let m = 0; m < 12; m++) {
      const mx = dateToX(new Date(year, m, 1).getTime())
      if (m > 0) axis.moveTo(mx, -16).lineTo(mx, 16).stroke({ width: 1, color: 0x2a3142, pixelLine: true })
      const label = new Text({
        text: MONTHS[m],
        style: { fill: 0x8a97b0, fontSize: 15, fontFamily: 'Segoe UI, sans-serif' },
      })
      label.resolution = 2
      label.anchor.set(0.5, 0)
      const mNext = dateToX(new Date(year, m + 1, 1).getTime())
      label.position.set((mx + mNext) / 2, 12)
      axis.addChild(label)
    }
    this.root.addChild(axis)
    // Range-selectie-band (Ctrl+slepen) — achter de kaarten, boven de as.
    this.root.addChild(this.rangeBand)

    // Meerdaagse events (period): een balkje op de as over de hele periode.
    const spans = new Graphics()
    this.root.addChild(spans)
    // Is dit event meerdaags genoeg voor een balkje (i.p.v. één punt op de as)?
    const isSpan = (e: EventSummary): boolean =>
      !!e.endAt && dateToX(parseLocalDate(e.endAt)) - dateToX(parseLocalDate(e.startAt)) > 4
    // Kleur per meerdaags event: chronologisch uit het palet, zodat twee naburige
    // blokjes nooit dezelfde kleur krijgen.
    const spanColor = new Map<string, number>()
    detail.events
      .filter(isSpan)
      .sort((a, b) => parseLocalDate(a.startAt) - parseLocalDate(b.startAt))
      .forEach((e, k) => spanColor.set(e.id, SPAN_PALETTE[k % SPAN_PALETTE.length]!))
    // Teken de balkjes (scherpe hoeken, ondoorzichtige gedimde kleur).
    for (const e of detail.events) {
      if (!isSpan(e)) continue
      const sX = dateToX(parseLocalDate(e.startAt))
      const eX = dateToX(parseLocalDate(e.endAt!))
      spans.rect(sX, -9, eX - sX, 18).fill(spanColor.get(e.id) ?? SPAN_PALETTE[0]!)
    }
    // Datumplek van een event op de as: bij een meerdaags event het midden van de
    // periode, anders exact de startdatum. Zuiver (geen teken-neveneffect) zodat
    // de solver 'm kan hergebruiken.
    const anchorXOf = (ev: EventSummary): number => {
      const startX = dateToX(parseLocalDate(ev.startAt))
      if (isSpan(ev)) return (startX + dateToX(parseLocalDate(ev.endAt!))) / 2
      return startX
    }

    // ---- Callout-plaatsing (lanes boven/onder) -----------------------------
    // Leader-lijnen in een eigen laag áchter de kaarten, zodat kaarten ze
    // netjes afdekken en het niet rommelig wordt bij stapeling.
    const leaders = new Graphics()
    this.root.addChild(leaders)

    const withCover = detail.events.filter((e) => e.coverItemId)
    const withoutCover = detail.events.filter((e) => !e.coverItemId)
    // Sorteer op datum zodat de lane-toewijzing links→rechts loopt.
    withCover.sort((a, b) => parseLocalDate(a.startAt) - parseLocalDate(b.startAt))

    // Bewaar wat de solver nodig heeft om `maxAbsY` bij een proef-factor te meten.
    this.withCoverSorted = withCover
    this.anchorXOf = anchorXOf
    this.spanIds = new Set(spanColor.keys())

    const { placements, maxAbsY } = computePlacements(withCover, this.yearFactor, anchorXOf, this.spanIds)
    for (const p of placements) {
      // Gebogen leader (2px): van de RAND van het blokje (meerdaags) of de as-lijn,
      // in een vloeiende S-curve naar de binnenrand van de kaart.
      const midY = (p.startY + p.innerY) / 2
      leaders
        .moveTo(p.anchorX, p.startY)
        .bezierCurveTo(p.anchorX, midY, p.cardX, midY, p.cardX, p.innerY)
        .stroke({ width: 2, color: 0x3a4256, alpha: 0.7, pixelLine: true })
      this.nodes.push(this.buildCard(p.ev, p.cardX, p.cardY, p.bs))
    }

    // Events zonder cover: een stip + titel op de as.
    withoutCover.forEach((ev) => {
      this.nodes.push(this.buildDot(ev, anchorXOf(ev)))
    })

    // Lege jaren: een hint in het midden.
    if (detail.events.length === 0) {
      const hint = new Text({
        text: 'Geen gebeurtenissen in dit jaar',
        style: { fill: 0x6a7690, fontSize: 20, fontFamily: 'Segoe UI, sans-serif' },
      })
      hint.resolution = 2
      hint.anchor.set(0.5)
      hint.position.set(0, -60)
      this.root.addChild(hint)
    }

    this.maxAbsY = maxAbsY

    // Dag-indicator (Ctrl): een verticale lijn + datumlabel, standaard verborgen.
    this.dayLine.visible = false
    this.root.addChild(this.dayLine)
    this.dayLabel = new Text({
      text: '',
      style: { fill: 0xdfe7f5, fontSize: 15, fontWeight: '600', fontFamily: 'Segoe UI, sans-serif' },
    })
    this.dayLabel.resolution = 2
    this.dayLabel.anchor.set(0.5, 1)
    this.dayLabel.visible = false
    this.root.addChild(this.dayLabel)

    this.engine.world.addChild(this.root)
    this.fitCamera(maxAbsY)
  }

  /** Datum (`YYYY-MM-DD`) die hoort bij een wereld-x op de as. */
  dateAt(worldX: number): string {
    const p = Math.min(1, Math.max(0, (worldX + AXIS_W / 2) / AXIS_W))
    const d = new Date(this.yearStart + p * this.span)
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    return `${d.getFullYear()}-${mm}-${dd}`
  }

  /** Zet de Ctrl-dag-indicator aan/uit. */
  setDayPicker(active: boolean): void {
    this.dayPicker = active
    this.renderDay()
  }

  /** Toon (of wis bij null) de Ctrl-sleep-selectie als een band begin→eind; de
   * dag-indicator volgt de bewegende rand (toont de einddatum). */
  setRange(startWorldX: number | null, endWorldX: number | null): void {
    this.rangeBand.clear()
    if (startWorldX === null || endWorldX === null) {
      this.hoverWX = null
      this.renderDay()
      return
    }
    const a = Math.min(startWorldX, endWorldX)
    const b = Math.max(startWorldX, endWorldX)
    const h = this.maxAbsY + 40
    this.rangeBand.rect(a, -h, b - a, 2 * h).fill({ color: 0x6ea8ff, alpha: 0.14 })
    this.hoverWX = endWorldX
    this.renderDay()
  }

  private renderDay(): void {
    const show = this.dayPicker && this.hoverWX !== null
    this.dayLine.visible = show
    this.dayLabel.visible = show
    if (!show || this.hoverWX === null) return
    const x = this.hoverWX
    const h = this.maxAbsY + 40
    this.dayLine.clear()
    this.dayLine.moveTo(x, -h).lineTo(x, h).stroke({ width: 1.5, color: 0x6ea8ff, alpha: 0.9 })
    const d = new Date(this.yearStart + Math.min(1, Math.max(0, (x + AXIS_W / 2) / AXIS_W)) * this.span)
    this.dayLabel.text = `${d.getDate()} ${MONTHS[d.getMonth()]}`
    this.dayLabel.position.set(x, -h - 6)
  }

  private buildCard(ev: EventSummary, anchorX: number, cardY: number, baseScale: number): Node {
    const container = new Container()
    container.position.set(anchorX, cardY)
    // De kaart wordt in nominale THUMB-eenheden getekend; de grootte-schaal zit
    // op de container (zo blijven fitCover/mask/rand simpel en proportioneel).
    container.scale.set(baseScale)

    const frame = new Graphics()
    frame
      .roundRect(-THUMB_W / 2 - BORDER, -THUMB_H / 2 - BORDER, THUMB_W + BORDER * 2, THUMB_H + BORDER * 2, 5)
      .fill(0xf5f5f0)
    container.addChild(frame)

    // Geklipte laag met de basis-sprite + een crossfade-overlay (slideshow).
    const photoLayer = new Container()
    const sprite = new Sprite(Texture.WHITE)
    sprite.anchor.set(0.5)
    sprite.setSize(THUMB_W, THUMB_H)
    sprite.tint = 0x2a3345
    const sprite2 = new Sprite(Texture.WHITE)
    sprite2.anchor.set(0.5)
    sprite2.setSize(THUMB_W, THUMB_H)
    sprite2.alpha = 0
    const mask = new Graphics()
    mask.rect(-THUMB_W / 2, -THUMB_H / 2, THUMB_W, THUMB_H).fill(0xffffff)
    photoLayer.addChild(sprite)
    photoLayer.addChild(sprite2)
    photoLayer.addChild(mask)
    photoLayer.mask = mask
    container.addChild(photoLayer)

    this.root.addChild(container)
    const photoIds = ev.photoIds ?? []
    const startIdx = Math.max(0, photoIds.indexOf(ev.coverItemId ?? ''))
    return {
      eventId: ev.id,
      anchorX,
      cardX: anchorX,
      cardY,
      hasCover: true,
      coverItemId: ev.coverItemId,
      container,
      sprite,
      sprite2,
      halfW: (THUMB_W / 2 + BORDER) * baseScale,
      halfH: (THUMB_H / 2 + BORDER) * baseScale,
      key: `cover-${ev.coverItemId}`,
      loaded: false,
      scale: 1,
      baseScale,
      size: ev.size ?? 50,
      wasVisible: false,
      photoIds,
      photoIdx: startIdx,
      pendingIdx: startIdx,
      curKey: `cover-${ev.coverItemId}`,
      pendingKey: '',
      // Versprongen start zodat niet alle kaarten tegelijk wisselen.
      nextAt: 0,
      fade: 0,
    }
  }

  private buildDot(ev: EventSummary, anchorX: number): Node {
    const container = new Container()
    container.position.set(anchorX, 0)

    const dot = new Graphics()
    dot.circle(0, 0, DOT_R).fill(0x8a97b0).stroke({ width: 2, color: 0x1a2030 })
    container.addChild(dot)

    const label = new Text({
      text: ev.title ?? 'Gebeurtenis',
      style: {
        fill: 0xcfd6e4,
        fontSize: 13,
        fontFamily: 'Segoe UI, sans-serif',
        wordWrap: true,
        wordWrapWidth: 140,
        align: 'center',
      },
    })
    label.resolution = 2
    label.anchor.set(0.5, 1)
    label.position.set(0, -DOT_R - 6)
    container.addChild(label)

    this.root.addChild(container)
    return {
      eventId: ev.id,
      anchorX,
      cardX: anchorX,
      cardY: 0,
      hasCover: false,
      container,
      sprite: null,
      sprite2: null,
      halfW: Math.max(DOT_R, 70),
      halfH: DOT_R + 26,
      key: '',
      loaded: false,
      scale: 1,
      baseScale: 1,
      size: ev.size ?? 50,
      wasVisible: false,
      photoIds: [],
      photoIdx: 0,
      pendingIdx: 0,
      curKey: '',
      pendingKey: '',
      nextAt: 0,
      fade: 0,
    }
  }

  private fitCamera(maxAbsY: number): void {
    const vp = this.engine.viewport()
    const contentW = AXIS_W + THUMB_W * CARD_MAX_SCALE + 120
    const contentH = Math.max(2 * maxAbsY, 320) + 120
    const zoom = Math.min(vp.width / contentW, vp.height / contentH)
    this.engine.jumpCamera(0, 0, Math.max(this.engine.camera.minZoom, Math.min(zoom, 1)))
  }

  onHover(worldX: number | null, worldY: number): void {
    this.hoveredId = worldX === null ? null : this.hitTest(worldX, worldY)
    this.hoverWX = worldX
    if (this.dayPicker) this.renderDay()
  }

  update(ctx: FrameContext): void {
    const { engine, frame, dtMS } = ctx
    // Slideshow-timing op wereldklok (fps-onafhankelijk); dt geclampt tegen
    // sprongen na een tab-throttle/hapering.
    const now = performance.now()
    const dt = Math.min(dtMS, 100)
    const b = engine.camera.worldBounds(engine.viewport())
    const marginX = THUMB_W
    const marginY = THUMB_H

    for (const n of this.nodes) {
      const visible =
        n.cardX + n.halfW > b.minX - marginX &&
        n.cardX - n.halfW < b.maxX + marginX &&
        n.cardY + n.halfH > b.minY - marginY &&
        n.cardY - n.halfH < b.maxY + marginY
      const wasVisible = n.wasVisible
      n.wasVisible = visible
      n.container.visible = visible
      if (!visible) continue

      // Net weer in beeld: verschuif `nextAt` naar de toekomst zodat een
      // ver-in-het-verleden liggende deadline geen directe wissel forceert
      // (culling pauzeert de slideshow; herintrede mag niet meteen springen).
      if (!wasVisible && n.loaded && n.fade === 0) {
        n.nextAt = now + this.slideMs * (0.3 + Math.random())
      }

      // Micro-animatie: vloeiende hover-schaal.
      const target = n.eventId === this.hoveredId ? 1.05 : 1
      n.scale += (target - n.scale) * 0.2
      n.container.scale.set(n.scale * n.baseScale)

      // Basis-cover laden.
      if (n.sprite && !n.loaded && n.coverItemId) {
        const tex = engine.textures.get(n.key, frame)
        if (tex) {
          n.sprite.texture = tex
          n.sprite.tint = 0xffffff
          fitCover(n.sprite, tex)
          n.loaded = true
          n.curKey = n.key
          // Versprongen start zodat niet alle kaarten tegelijk wisselen.
          if (n.nextAt === 0) n.nextAt = now + this.slideMs * (0.3 + Math.random())
        } else {
          const src = this.backend.thumb(n.coverItemId, 256)
          engine.textures.request({ key: n.key, url: src.url, hue: src.hue, size: 256 })
        }
      }

      // Houd de texture(s) die nu op deze zichtbare kaart getoond worden "warm"
      // in de LRU-cache: anders bevriest hun `lastUsed` (we `get`-en ze niet elke
      // frame) en kan de eviction ze `destroy`-en terwijl de sprite ze nog
      // gebruikt → zwarte kaart. (Zelfde patroon als de lifeline-tegels.)
      if (n.loaded) {
        if (n.curKey) engine.textures.get(n.curKey, frame)
        if (n.fade > 0 && n.pendingKey) engine.textures.get(n.pendingKey, frame)
      }

      // Slideshow: rouleer de cover door de foto's van het event (crossfade).
      if (this.slideEnabled && n.loaded && n.sprite && n.sprite2 && n.photoIds.length > 1) {
        this.tickSlideshow(n, engine, frame, now, dt)
      }
    }
  }

  /** Eén slideshow-stap voor een cover-kaart: volgende foto voorbereiden en
   * crossfaden; bij voltooien de overlay de nieuwe basis maken. */
  private tickSlideshow(n: Node, engine: RenderEngine, frame: number, now: number, dt: number): void {
    const s2 = n.sprite2!
    const s1 = n.sprite!
    if (n.fade > 0) {
      n.fade += dt / 300 // ~0.3s crossfade
      s2.alpha = Math.min(1, n.fade)
      if (n.fade >= 1) {
        s1.texture = s2.texture
        s1.setSize(s2.width, s2.height)
        s2.alpha = 0
        n.photoIdx = n.pendingIdx
        n.curKey = n.pendingKey // s1 toont nu de zojuist ingefade-de foto
        n.pendingKey = ''
        n.fade = 0
        // Versprongen volgende beurt (licht random in tijd).
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
      n.fade = 0.001 // start crossfade
    } else {
      const src = this.backend.thumb(n.photoIds[nextIdx], 256)
      engine.textures.request({ key, url: src.url, hue: src.hue, size: 256 })
    }
  }

  hitTest(worldX: number, worldY: number): string | null {
    // Van voor naar achter (laatste toegevoegd = bovenop).
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const n = this.nodes[i]
      if (Math.abs(worldX - n.cardX) <= n.halfW && Math.abs(worldY - n.cardY) <= n.halfH) {
        return n.eventId
      }
    }
    return null
  }

  /** Shift-slepen op een cover-kaart wijzigt het belang (grootte): de schaal
   * volgt live de sleepafstand vanaf het kaartmidden, bij loslaten persisteren
   * we de nieuwe `size` naar de vault. Niets geraakt → null (dan pant de camera). */
  beginResize(worldX: number, worldY: number): DragHandle | null {
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const n = this.nodes[i]
      if (!n.hasCover) continue
      if (Math.abs(worldX - n.cardX) > n.halfW || Math.abs(worldY - n.cardY) > n.halfH) continue
      // Afstand-tot-midden bij pointerdown als referentie (net als de foto-schaal
      // op het event-canvas); een ondergrens houdt het rond het midden rustig.
      const startDist = Math.max(20, Math.hypot(worldX - n.cardX, worldY - n.cardY))
      const startSize = n.size
      let changed = false
      const apply = (size: number): void => {
        n.size = Math.max(1, Math.min(100, Math.round(size)))
        // De visuele schaal is altijd size × de globale jaar-factor.
        n.baseScale = cardScale(n.size * this.yearFactor)
        n.halfW = (THUMB_W / 2 + BORDER) * n.baseScale
        n.halfH = (THUMB_H / 2 + BORDER) * n.baseScale
        n.container.scale.set(n.scale * n.baseScale)
      }
      return {
        moveTo: (mx, my) => {
          const f = Math.hypot(mx - n.cardX, my - n.cardY) / startDist
          apply(startSize * f)
          changed = true
        },
        end: () => {
          if (changed) void this.backend.setEventSize(n.eventId, n.size)
        },
      }
    }
    return null
  }

  /** "Passend maken": zoekt de grootste globale factor (binnen [0.5, 1.6]) waarbij
   * de layout nog binnen de comfortabele (horizontaal-begrensde) zoom past, zodat
   * belangrijke events zo groot mogelijk blijven zonder de tijdlijn te overspoelen.
   * Proportioneel — de onderlinge `size`-verhoudingen blijven intact. Geeft de
   * factor terug (AppShell persisteert 'm en herlaadt het jaar). */
  computeFitFactor(): number {
    if (this.withCoverSorted.length === 0) return 1
    const vp = this.engine.viewport()
    const contentW = AXIS_W + THUMB_W * CARD_MAX_SCALE + 120
    // Doelhoogte = waar de verticale beperking de horizontale net gaat domineren
    // (spiegelt `fitCamera`: contentH = 2·maxAbsY + 120, met de 320-vloer).
    const targetContentH = (vp.height / vp.width) * contentW
    const targetMaxAbsY = Math.max(160, (targetContentH - 120) / 2)
    const measure = (f: number): number =>
      computePlacements(this.withCoverSorted, f, this.anchorXOf, this.spanIds).maxAbsY
    const FMIN = 0.5
    const FMAX = 1.6
    // Past zelfs de kleinste factor niet (te veel events op dezelfde datum)?
    // Accepteer de overloop — `fitCamera` zoomt dan verder uit.
    if (measure(FMIN) > targetMaxAbsY) return FMIN
    // Past de grootste factor nog? Gebruik die (kaarten zo groot als toegestaan).
    if (measure(FMAX) <= targetMaxAbsY) return FMAX
    // Binair zoeken naar de grens (maxAbsY is monotoon niet-dalend in de factor).
    let lo = FMIN
    let hi = FMAX
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2
      if (measure(mid) <= targetMaxAbsY) lo = mid
      else hi = mid
    }
    return Math.round(lo * 100) / 100
  }

  destroy(): void {
    this.root.destroy({ children: true })
  }
}
