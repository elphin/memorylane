// L1 — Jaar: een horizontale maand-tijdlijn (Jan–Dec). Semantische zoom:
// ver uitgezoomd zie je alleen de BELANGRIJKSTE memories als kleine markers op
// de as (minder belangrijke vallen weg, afhankelijk van de schermruimte); zoom
// je in, dan "bloeien" de markers open — ze stijgen naar hun lane en worden
// thumbnails, en minder belangrijke memories faden er geleidelijk bij. Zo werken
// ook honderden events per jaar vloeiend. Klik op een event → L2-canvas.

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

// --- Semantische-zoom-parameters (afgestemd op de fit-zoom z0 ≈ 0.42) ---------
const SCREEN_GAP_PX = 130 // declutter-afstand in SCHERM-pixels (zelf-schalend)
const FULL_ZOOM = 1.1 // zoom waarbij ÁLLE events aanwezig zijn (viewport-onafh.)
const REVEAL_BAND = 0.18 // relatieve breedte van de fade-in rond revealZoom
const BLOOM_LO = 80 // schermhoogte (px) waaronder een kaart een marker blijft
const BLOOM_HI = 150 // schermhoogte (px) waarboven een kaart volle thumbnail is
const MARKER_R = 7 // straal van de pip-marker op de as
const MARKER_HIT = 24 // royale klik-halfmaat van een marker (tegen mis-taps)
const HIT_PRESENCE = 0.35 // onder deze presence is een node niet klikbaar

// Belang → kaartschaal. size 50 = standaard (1.0); geklemd zodat kleine events
// leesbaar blijven en grote niet de tijdlijn overheersen.
const CARD_MIN_SCALE = 0.6
const CARD_MAX_SCALE = 1.8
/** Visuele schaal van een event-kaart op basis van zijn `size` (1–100). */
function cardScale(size: number): number {
  return Math.max(CARD_MIN_SCALE, Math.min(CARD_MAX_SCALE, size / 50))
}

/** Smoothstep tussen a en b (0 onder a, 1 boven b, S-curve ertussen). */
function smoothstep(a: number, b: number, x: number): number {
  if (a === b) return x < a ? 0 : 1
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** Effectieve zwaarte van een memory: de rating-`size` is leidend, met een
 * bescheiden, log-geschaalde bonus voor rijkere memories (meer items). De bonus
 * is geklemd op +12 — kleiner dan de 20-stap tussen de buckets — zodat de
 * rating-tiers (gewoon<bijzonder<uitzonderlijk) nooit worden ingehaald. Voedt
 * ZOWEL de kaartgrootte ALS de reveal-prioriteit (samenhangend). */
function effectiveSize(size: number | undefined, itemCount: number): number {
  const base = size == null ? 50 : size
  const nudge = Math.max(0, Math.min(12, Math.round(4 * (Math.log2(1 + Math.max(0, itemCount)) - 1))))
  return Math.max(1, Math.min(100, base + nudge))
}

/** Deterministische ±8% schaalvariatie zodat memories binnen dezelfde zwaarte
 * niet exact even groot zijn (organischer). Alleen visueel — NIET in de
 * reveal-prioriteit (die gebruikt de zuivere effectiveSize + id-hash). */
function jitterScale(id: string): number {
  const r = ((hashId(id) >>> 13) % 1000) / 1000
  return 1 + (r - 0.5) * 0.16
}

/** Plaatsing van één cover-kaart (resultaat van de lane-packing). */
interface Placement {
  ev: EventSummary
  anchorX: number
  cardX: number // laneX (eindpositie bij bloom=1), inclusief jitter
  cardY: number // laneY (eindpositie bij bloom=1)
  side: number
  bs: number // baseScale (grootte-schaal) van deze kaart
  ch: number // geschaalde kaarthoogte
  innerY: number // binnenrand (leader-eindpunt)
  startY: number // leader-startpunt op de as (blokrand bij meerdaags)
  isSpan: boolean
}

/** Zuivere lane-packing: plaatst de (op datum gesorteerde) cover-events rond hun
 * datum in lanes boven/onder de as, geschaald met `factor` × hun eigen zwaarte.
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
  const jyAmp = Math.min(120, 30 + withCoverSorted.length * 2)
  const INNER_CLEAR = AXIS_GAP - THUMB_H / 2
  const LANE_PITCH = THUMB_H * CARD_MAX_SCALE + LANE_GAP
  const placements: Placement[] = []
  withCoverSorted.forEach((ev, j) => {
    const anchorX = anchorXOf(ev)
    const bs = cardScale(effectiveSize(ev.size, ev.itemCount) * factor) * jitterScale(ev.id)
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
    placements.push({ ev, anchorX, cardX, cardY, side, bs, ch, innerY, startY, isSpan: spanIds.has(ev.id) })
  })
  return { placements, maxAbsY }
}

const MONTHS = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec']

interface Node {
  eventId: string
  anchorX: number // x op de as (de datum van het event)
  laneX: number // eind-x van de kaart (bloom=1), inclusief jitter
  laneY: number // eind-y van de kaart (bloom=1); 0 voor dot-events
  hasCover: boolean
  coverItemId?: string
  container: Container // de cover-kaart, of de dot-container
  marker: Graphics | null // pip op de as (cover-events, niet spans)
  leader: Graphics | null // per-kaart leader (statische geometrie, alpha animeert)
  sprite: Sprite | null
  sprite2: Sprite | null // crossfade-overlay voor de slideshow
  key: string
  loaded: boolean
  scale: number // hover-animatie
  baseScale: number // grootte-schaal (effectiveSize × jaar-factor × jitter)
  size: number // rauwe belang-rating 1–100 (bron van baseScale, leeft mee met resize)
  itemCount: number // aantal items (voor effectiveSize bij live resize)
  revealZoom: number // zoom waarop dit event verschijnt (0 = altijd)
  presence: number // huidige zichtbaarheid (per frame) — voor hittest
  bloom: number // huidige marker→thumbnail-voortgang (per frame)
  wasVisible: boolean
  // Per-frame hit-box (marker→kaart geïnterpoleerd met bloom).
  hitCx: number
  hitCy: number
  hitHalfW: number
  hitHalfH: number
  cardHalfW: number // volle kaart-halfmaat (bloom=1) / dot-hitbreedte
  cardHalfH: number
  // Slideshow-roulatie (alleen cover-kaarten met >1 foto).
  photoIds: string[]
  photoIdx: number
  pendingIdx: number
  curKey: string
  pendingKey: string
  nextAt: number
  fade: number
}

// Felle basiskleuren met sterk wisselende tinten (warm/koel afgewisseld) zodat
// twee naburige meerdaagse-blokjes altijd contrasteren.
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
  private leadersLayer = new Container()
  private markersLayer = new Container()
  private cardsLayer = new Container()
  private nodes: Node[] = []
  private hoveredId: string | null = null
  private yearStart = 0
  private span = 1
  private z0 = 0.5 // fit-zoom (breedte-dominant); anker voor de bloom-ondergrens
  private dayPicker = false
  private hoverWX: number | null = null
  private dayLine = new Graphics()
  private dayLabel: Text
  private rangeBand = new Graphics()
  private slideEnabled: boolean
  private slideMs: number
  private yearFactor = 1
  // Bewaard voor de "passend maken"-solver.
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
    this.yearFactor = Math.max(0.1, Math.min(5, detail.year.sizeFactor ?? 1))
    const dateToX = (ms: number): number => {
      const p = Math.min(1, Math.max(0, (ms - yearStart) / span))
      return -AXIS_W / 2 + p * AXIS_W
    }

    // ---- Achtergrond: as-lijn, maand-separators en -labels -----------------
    const axis = new Graphics()
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
    this.root.addChild(this.rangeBand)

    // Meerdaagse events (period): een balkje op de as over de hele periode.
    // Deze balk is de marker van een span-event (dus geen aparte pip erbovenop);
    // hij blijft zichtbaar als vaste as-context.
    const spans = new Graphics()
    this.root.addChild(spans)
    const isSpan = (e: EventSummary): boolean =>
      !!e.endAt && dateToX(parseLocalDate(e.endAt)) - dateToX(parseLocalDate(e.startAt)) > 4
    const spanColor = new Map<string, number>()
    detail.events
      .filter(isSpan)
      .sort((a, b) => parseLocalDate(a.startAt) - parseLocalDate(b.startAt))
      .forEach((e, k) => spanColor.set(e.id, SPAN_PALETTE[k % SPAN_PALETTE.length]!))
    for (const e of detail.events) {
      if (!isSpan(e)) continue
      const sX = dateToX(parseLocalDate(e.startAt))
      const eX = dateToX(parseLocalDate(e.endAt!))
      spans.rect(sX, -9, eX - sX, 18).fill(spanColor.get(e.id) ?? SPAN_PALETTE[0]!)
    }
    const anchorXOf = (ev: EventSummary): number => {
      const startX = dateToX(parseLocalDate(ev.startAt))
      if (isSpan(ev)) return (startX + dateToX(parseLocalDate(ev.endAt!))) / 2
      return startX
    }

    // ---- Reveal-prioriteit (density-LOD) -----------------------------------
    // Strikte totale ordening (effectiveSize aflopend, dan id-hash) zodat elk
    // event op één na precies één "belangrijkere" referent heeft. Een event
    // verschijnt zodra de as-afstand tot de dichtstbijzijnde belangrijkere buur
    // groot genoeg is op het scherm (SCREEN_GAP_PX). Zo tonen ver-uitgezoomd
    // alleen de belangrijkste, en komen de rest er bij het inzoomen op volgorde
    // van belang bij. Same-datum (afstand 0) → geklemd op FULL_ZOOM.
    const ranked = detail.events.map((ev) => ({
      id: ev.id,
      anchorX: anchorXOf(ev),
      eff: effectiveSize(ev.size, ev.itemCount),
      h: hashId(ev.id),
    }))
    const order = [...ranked].sort((a, b) => b.eff - a.eff || a.h - b.h)
    const rankOf = new Map<string, number>()
    order.forEach((r, i) => rankOf.set(r.id, i))
    const revealZoom = new Map<string, number>()
    for (const e of ranked) {
      const er = rankOf.get(e.id)!
      let dx = Infinity
      for (const f of ranked) {
        if (rankOf.get(f.id)! < er) {
          const d = Math.abs(e.anchorX - f.anchorX)
          if (d < dx) dx = d
        }
      }
      const rz = dx === Infinity ? 0 : Math.min(FULL_ZOOM, SCREEN_GAP_PX / Math.max(dx, 0.0001))
      revealZoom.set(e.id, rz)
    }

    // ---- Lagen (z-order: leaders < markers/dots < kaarten) -----------------
    this.root.addChild(this.leadersLayer)
    this.root.addChild(this.markersLayer)
    this.root.addChild(this.cardsLayer)

    const withCover = detail.events.filter((e) => e.coverItemId)
    const withoutCover = detail.events.filter((e) => !e.coverItemId)
    withCover.sort((a, b) => parseLocalDate(a.startAt) - parseLocalDate(b.startAt))

    this.withCoverSorted = withCover
    this.anchorXOf = anchorXOf
    this.spanIds = new Set(spanColor.keys())

    const { placements } = computePlacements(withCover, this.yearFactor, anchorXOf, this.spanIds)
    for (const p of placements) {
      this.nodes.push(this.buildCard(p, revealZoom.get(p.ev.id) ?? 0))
    }
    withoutCover.forEach((ev) => {
      this.nodes.push(this.buildDot(ev, anchorXOf(ev), revealZoom.get(ev.id) ?? 0))
    })

    if (detail.events.length === 0) {
      const hint = new Text({
        text: 'Geen memories in dit jaar',
        style: { fill: 0x6a7690, fontSize: 20, fontFamily: 'Segoe UI, sans-serif' },
      })
      hint.resolution = 2
      hint.anchor.set(0.5)
      hint.position.set(0, -60)
      this.root.addChild(hint)
    }

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
    this.fitCamera()
  }

  /** Datum (`YYYY-MM-DD`) die hoort bij een wereld-x op de as. */
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

  /** Verticale halve hoogte van het zichtbare wereldgebied (voor de range-band /
   * dag-lijn) — met markers op de as is de volledige lane-hoogte niet relevant. */
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
    const h = this.bandHalfH()
    this.dayLine.clear()
    this.dayLine.moveTo(x, -h).lineTo(x, h).stroke({ width: 1.5, color: 0x6ea8ff, alpha: 0.9 })
    const d = new Date(this.yearStart + Math.min(1, Math.max(0, (x + AXIS_W / 2) / AXIS_W)) * this.span)
    this.dayLabel.text = `${d.getDate()} ${MONTHS[d.getMonth()]}`
    this.dayLabel.position.set(x, -h - 6)
  }

  private buildCard(p: Placement, revealZoom: number): Node {
    const ev = p.ev
    const container = new Container()
    container.position.set(p.cardX, p.cardY)
    container.scale.set(p.bs)

    const frame = new Graphics()
    frame
      .roundRect(-THUMB_W / 2 - BORDER, -THUMB_H / 2 - BORDER, THUMB_W + BORDER * 2, THUMB_H + BORDER * 2, 5)
      .fill(0xf5f5f0)
    container.addChild(frame)

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
    container.visible = false
    this.cardsLayer.addChild(container)

    // Per-kaart leader met STATISCHE geometrie naar de eindpositie; alleen de
    // alpha animeert met bloom (geen per-frame hertekening → 60fps-vriendelijk).
    const leader = new Graphics()
    const midY = (p.startY + p.innerY) / 2
    leader
      .moveTo(p.anchorX, p.startY)
      .bezierCurveTo(p.anchorX, midY, p.cardX, midY, p.cardX, p.innerY)
      .stroke({ width: 2, color: 0x3a4256, alpha: 0.7, pixelLine: true })
    leader.alpha = 0
    this.leadersLayer.addChild(leader)

    // Pip-marker op de as (niet voor spans — de balk is daar de marker).
    let marker: Graphics | null = null
    if (!p.isSpan) {
      marker = new Graphics()
      marker.circle(0, 0, MARKER_R).fill(0xcfd6e4).stroke({ width: 2, color: 0x1a2030 })
      marker.position.set(p.anchorX, 0)
      marker.alpha = 0
      this.markersLayer.addChild(marker)
    }

    const photoIds = ev.photoIds ?? []
    const startIdx = Math.max(0, photoIds.indexOf(ev.coverItemId ?? ''))
    return {
      eventId: ev.id,
      anchorX: p.anchorX,
      laneX: p.cardX,
      laneY: p.cardY,
      hasCover: true,
      coverItemId: ev.coverItemId,
      container,
      marker,
      leader,
      sprite,
      sprite2,
      key: `cover-${ev.coverItemId}`,
      loaded: false,
      scale: 1,
      baseScale: p.bs,
      size: ev.size ?? 50,
      itemCount: ev.itemCount,
      revealZoom,
      presence: 0,
      bloom: 0,
      wasVisible: false,
      hitCx: p.anchorX,
      hitCy: 0,
      hitHalfW: 0,
      hitHalfH: 0,
      cardHalfW: (THUMB_W / 2 + BORDER) * p.bs,
      cardHalfH: (THUMB_H / 2 + BORDER) * p.bs,
      photoIds,
      photoIdx: startIdx,
      pendingIdx: startIdx,
      curKey: `cover-${ev.coverItemId}`,
      pendingKey: '',
      nextAt: 0,
      fade: 0,
    }
  }

  private buildDot(ev: EventSummary, anchorX: number, revealZoom: number): Node {
    const container = new Container()
    container.position.set(anchorX, 0)

    const dot = new Graphics()
    dot.circle(0, 0, DOT_R).fill(0x8a97b0).stroke({ width: 2, color: 0x1a2030 })
    container.addChild(dot)

    const label = new Text({
      text: ev.title ?? 'Memory',
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

    container.visible = false
    this.markersLayer.addChild(container)
    return {
      eventId: ev.id,
      anchorX,
      laneX: anchorX,
      laneY: 0,
      hasCover: false,
      container,
      marker: null,
      leader: null,
      sprite: null,
      sprite2: null,
      key: '',
      loaded: false,
      scale: 1,
      baseScale: 1,
      size: ev.size ?? 50,
      itemCount: ev.itemCount,
      revealZoom,
      presence: 0,
      bloom: 0,
      wasVisible: false,
      hitCx: anchorX,
      hitCy: 0,
      hitHalfW: 0,
      hitHalfH: 0,
      cardHalfW: Math.max(DOT_R, 70),
      cardHalfH: DOT_R + 26,
      photoIds: [],
      photoIdx: 0,
      pendingIdx: 0,
      curKey: '',
      pendingKey: '',
      nextAt: 0,
      fade: 0,
    }
  }

  /** Breedte-dominante fit: het hele jaar past in de breedte, met markers rond
   * de as. Zo blijft de fit-zoom z0 stabiel, ongeacht het aantal events (de
   * volledige lane-hoogte telt pas als je inzoomt en de kaarten bloeien). */
  private fitCamera(): void {
    const vp = this.engine.viewport()
    const contentW = AXIS_W + THUMB_W * CARD_MAX_SCALE + 120
    const zoom = Math.max(this.engine.camera.minZoom, Math.min(vp.width / contentW, 1))
    this.z0 = zoom
    this.engine.jumpCamera(0, 0, zoom)
  }

  /** Zichtbaarheid van een event bij deze zoom (density-LOD, met fade-band). */
  private presenceOf(zoom: number, revealZoom: number): number {
    if (revealZoom <= 0 || zoom >= FULL_ZOOM) return 1
    return smoothstep(revealZoom * (1 - REVEAL_BAND), revealZoom * (1 + REVEAL_BAND), zoom)
  }

  /** Marker→thumbnail-voortgang o.b.v. de schermgrootte van de kaart, met een
   * harde ondergrens rond de fit-zoom zodat bij binnenkomst alles marker is. */
  private bloomOf(zoom: number, baseScale: number): number {
    const screenH = THUMB_H * baseScale * zoom
    return smoothstep(BLOOM_LO, BLOOM_HI, screenH) * smoothstep(this.z0 * 1.03, this.z0 * 1.3, zoom)
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
    const zoom = engine.camera.zoom
    const b = engine.camera.worldBounds(engine.viewport())
    const marginX = THUMB_W
    const marginY = THUMB_H

    for (const n of this.nodes) {
      const presence = this.presenceOf(zoom, n.revealZoom)
      n.presence = presence
      // Culling: neem zowel de as-positie (marker) als de lane-positie (kaart).
      const loX = Math.min(n.anchorX, n.laneX) - marginX
      const hiX = Math.max(n.anchorX, n.laneX) + marginX
      const loY = Math.min(0, n.laneY) - marginY
      const hiY = Math.max(0, n.laneY) + marginY
      const inView = hiX > b.minX && loX < b.maxX && hiY > b.minY && loY < b.maxY
      const visible = presence > 0.01 && inView
      const wasVisible = n.wasVisible
      n.wasVisible = visible
      if (!visible) {
        n.container.visible = false
        if (n.marker) n.marker.visible = false
        if (n.leader) n.leader.alpha = 0
        n.hitHalfW = 0
        n.hitHalfH = 0
        continue
      }

      const target = n.eventId === this.hoveredId ? 1.05 : 1
      n.scale += (target - n.scale) * 0.2

      if (n.hasCover) {
        const bloom = this.bloomOf(zoom, n.baseScale)
        n.bloom = bloom
        if (n.marker) {
          n.marker.visible = bloom < 0.999
          n.marker.alpha = presence * (1 - bloom)
        }
        const showCard = bloom > 0.01
        n.container.visible = showCard
        if (showCard) {
          const bx = lerp(n.anchorX, n.laneX, bloom)
          const by = lerp(0, n.laneY, bloom)
          n.container.position.set(bx, by)
          n.container.alpha = presence * bloom
          n.container.scale.set(n.scale * n.baseScale * lerp(0.5, 1, bloom))

          // Basis-cover laden — pas als de kaart merkbaar bloeit (markers laden geen
          // texture → ver uitgezoomd blijven 100+ events goedkoop).
          if (n.sprite && !n.loaded && n.coverItemId && bloom > 0.12) {
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
          // Houd de getoonde texture(s) "warm" tegen eviction (zwarte kaart).
          if (n.loaded && bloom > 0.12) {
            if (n.curKey) engine.textures.get(n.curKey, frame)
            if (n.fade > 0 && n.pendingKey) engine.textures.get(n.pendingKey, frame)
          }
          if (!wasVisible && n.loaded && n.fade === 0) {
            n.nextAt = now + this.slideMs * (0.3 + Math.random())
          }
          // Slideshow alleen op een volledig gebloeide, zichtbare kaart.
          if (this.slideEnabled && n.loaded && n.sprite && n.sprite2 && n.photoIds.length > 1 && bloom > 0.85) {
            this.tickSlideshow(n, engine, frame, now, dt)
          } else if (n.fade > 0 && n.sprite && n.sprite2) {
            // Een crossfade die door uitzoomen/culling onder de slideshow-drempel
            // zakt: netjes afronden, anders blijft de overlay half over de basis
            // hangen tot je weer voorbij de drempel zoomt.
            n.sprite.texture = n.sprite2.texture
            n.sprite.setSize(n.sprite2.width, n.sprite2.height)
            n.sprite2.alpha = 0
            n.photoIdx = n.pendingIdx
            n.curKey = n.pendingKey
            n.pendingKey = ''
            n.fade = 0
          }
        }
        if (n.leader) n.leader.alpha = presence * bloom

        n.hitCx = lerp(n.anchorX, n.laneX, bloom)
        n.hitCy = lerp(0, n.laneY, bloom)
        n.hitHalfW = lerp(MARKER_HIT, n.cardHalfW, bloom)
        n.hitHalfH = lerp(MARKER_HIT, n.cardHalfH, bloom)
      } else {
        // Dot-event (geen cover): altijd een marker op de as.
        n.container.visible = true
        n.container.alpha = presence
        n.container.scale.set(n.scale)
        n.hitCx = n.anchorX
        n.hitCy = 0
        n.hitHalfW = n.cardHalfW
        n.hitHalfH = n.cardHalfH
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
      n.fade = 0.001 // start crossfade
    } else {
      const src = this.backend.thumb(n.photoIds[nextIdx], 256)
      engine.textures.request({ key, url: src.url, hue: src.hue, size: 256 })
    }
  }

  hitTest(worldX: number, worldY: number): string | null {
    // Van voor naar achter (laatste toegevoegd = bovenop). Alleen voldoende
    // aanwezige nodes zijn klikbaar (een half-gefade marker niet).
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const n = this.nodes[i]
      if (n.presence < HIT_PRESENCE || n.hitHalfW <= 0) continue
      if (Math.abs(worldX - n.hitCx) <= n.hitHalfW && Math.abs(worldY - n.hitCy) <= n.hitHalfH) {
        return n.eventId
      }
    }
    return null
  }

  /** Shift-slepen op een cover-kaart wijzigt het belang (grootte): de schaal
   * volgt live de sleepafstand vanaf het kaartmidden, bij loslaten persisteren
   * we de nieuwe `size` naar de vault. Niets geraakt → null (dan pant de camera).
   * NB: de reveal-prioriteit is precomputed; die herberekent pas na het herladen
   * van het jaar (setEventSize → rescan). Tijdens de drag is dat prima. */
  beginResize(worldX: number, worldY: number): DragHandle | null {
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const n = this.nodes[i]
      if (!n.hasCover || n.presence < HIT_PRESENCE || n.hitHalfW <= 0) continue
      if (Math.abs(worldX - n.hitCx) > n.hitHalfW || Math.abs(worldY - n.hitCy) > n.hitHalfH) continue
      const startDist = Math.max(20, Math.hypot(worldX - n.hitCx, worldY - n.hitCy))
      const startSize = n.size
      let changed = false
      const apply = (size: number): void => {
        n.size = Math.max(1, Math.min(100, Math.round(size)))
        // Eén baseScale voedt zowel de getekende schaal als de hit-box.
        n.baseScale = cardScale(effectiveSize(n.size, n.itemCount) * this.yearFactor) * jitterScale(n.eventId)
        n.cardHalfW = (THUMB_W / 2 + BORDER) * n.baseScale
        n.cardHalfH = (THUMB_H / 2 + BORDER) * n.baseScale
      }
      const cx = n.hitCx
      const cy = n.hitCy
      return {
        moveTo: (mx, my) => {
          const f = Math.hypot(mx - cx, my - cy) / startDist
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
   * de VOLLEDIG GEBLOEIDE lane-layout nog binnen een comfortabele hoogte past,
   * proportioneel (de onderlinge zwaarte-verhoudingen blijven intact). Geeft de
   * factor terug (AppShell persisteert 'm en herlaadt het jaar). */
  computeFitFactor(): number {
    if (this.withCoverSorted.length === 0) return 1
    const vp = this.engine.viewport()
    const contentW = AXIS_W + THUMB_W * CARD_MAX_SCALE + 120
    const targetContentH = (vp.height / vp.width) * contentW
    const targetMaxAbsY = Math.max(160, (targetContentH - 120) / 2)
    const measure = (f: number): number =>
      computePlacements(this.withCoverSorted, f, this.anchorXOf, this.spanIds).maxAbsY
    const FMIN = 0.5
    const FMAX = 1.6
    if (measure(FMIN) > targetMaxAbsY) return FMIN
    if (measure(FMAX) <= targetMaxAbsY) return FMAX
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
