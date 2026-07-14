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
import type { FrameContext, RenderEngine } from '../core/engine'
import type { DragHandle } from '../core/gestures'
import type { Scene } from './scene'

const AXIS_W = 2400 // wereldbreedte van de jaar-as (Jan..Dec) bij zoom=1
const THUMB_W = 168
const THUMB_H = 126
const BORDER = 8
const CARD_ASPECT = THUMB_W / THUMB_H

// Kaart-schermhoogtes (px) naar zwaarte. Vast op het scherm, ongeacht de zoom.
const CARD_H_BASE = 96 // schermhoogte bij effectiveSize 50
const CARD_H_MIN = 66
const CARD_H_MAX = 132

// Lanes (schermruimte, boven/onder de as).
const AXIS_CLEAR_PX = 40 // scherm tussen as en de eerste lane
const LANE_GAP_PX = 40 // ruimte tussen lanes (incl. plek voor de titel ertussen)
const LANE_PITCH = CARD_H_MAX + LANE_GAP_PX
const CARD_GAP_PX = 16 // min. horizontale scherm-ruimte tussen kaarten in een lane
const STICKY_GAP_PX = 4 // lossere gap voor een kaart die z'n lane behoudt (hysterese)

const DOT_R = 7 // stip-straal (scherm-px)
const DOT_HIT = 22 // royale klik-halfmaat van een stip (scherm-px)
const MARKER_HIT_MIN = 20
const LABEL_SCREEN_Y = 20 // maandlabel-offset onder de as (scherm-px)
const TITLE_MAX = 24 // max. tekens van een memory-titel

/** Effectieve zwaarte: rating-`size` leidend, met een bescheiden log-nudge voor
 * rijkere memories (max +12 < de 20-stap tussen de buckets → tiers blijven). */
function effectiveSize(size: number | undefined, itemCount: number): number {
  const base = size == null ? 50 : size
  const nudge = Math.max(0, Math.min(12, Math.round(4 * (Math.log2(1 + Math.max(0, itemCount)) - 1))))
  return Math.max(1, Math.min(100, base + nudge))
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

interface Lane {
  side: number // -1 = boven de as (neg. y), 1 = onder
  level: number // 0 = dichtst bij de as
}

interface Node {
  eventId: string
  anchorX: number // wereld-x (de datum)
  hasCover: boolean
  isSpan: boolean
  coverItemId?: string
  eff: number // effectiveSize (belang) — bepaalt grootte + packing-prioriteit
  size: number // rauwe rating 1–100 (bron van eff; leeft mee met Shift-resize)
  itemCount: number // aantal items (voor effectiveSize bij live resize)
  hash: number
  prefSide: number // voorkeurskant voor lane-balancering
  // Schermgroottes (px).
  cardW: number
  cardH: number
  baseScreenScale: number // cardH / THUMB_H (kaart in THUMB-eenheden getekend)
  // Packing-toestand (leeft mee over frames voor stabiliteit).
  lane: Lane | null // null = stip/overflow
  // Pixi-objecten.
  card: Container | null // cover-events
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
  // Slideshow-roulatie.
  photoIds: string[]
  photoIdx: number
  pendingIdx: number
  curKey: string
  pendingKey: string
  nextAt: number
  fade: number
}

// Felle basiskleuren (warm/koel afgewisseld) voor de meerdaagse-blokjes.
const SPAN_PALETTE_RAW = [
  0xff5c5c, 0x3cd6d6, 0xffd93c, 0xb15cff, 0x6ee06e, 0xff5cc0, 0x5c8cff, 0xffa63c, 0x38c9a0,
  0xf05545,
]
function opaqueSpan(color: number): number {
  const bg = 0x0a0a0f
  const mix = (c: number, b: number): number => Math.round(c * 0.45 + b * 0.55)
  const r = mix((color >> 16) & 255, (bg >> 16) & 255)
  const g = mix((color >> 8) & 255, (bg >> 8) & 255)
  const b = mix(color & 255, bg & 255)
  return (r << 16) | (g << 8) | b
}
const SPAN_PALETTE = SPAN_PALETTE_RAW.map(opaqueSpan)

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
  private leaders = new Graphics()
  private cardsLayer = new Container()
  private dotsLayer = new Container()
  private nodes: Node[] = []
  private coverNodes: Node[] = [] // op belang gesorteerd (packing-volgorde)
  private monthLabels: { text: Text; midX: number }[] = []
  private hoveredId: string | null = null
  private yearStart = 0
  private span = 1
  private dayPicker = false
  private hoverWX: number | null = null
  private dayLine = new Graphics()
  private dayLabel: Text
  private rangeBand = new Graphics()
  private slideEnabled: boolean
  private slideMs: number
  private showTitles: boolean

  constructor(
    private engine: RenderEngine,
    private backend: Backend,
    detail: YearDetail,
    opts: { enabled: boolean; speedMs: number; showTitles?: boolean } = { enabled: false, speedMs: 5000 },
  ) {
    this.slideEnabled = opts.enabled
    this.slideMs = Math.max(800, opts.speedMs)
    this.showTitles = opts.showTitles ?? false
    const year = detail.year.year
    const yearStart = new Date(year, 0, 1).getTime()
    const yearEnd = new Date(year, 11, 31, 23, 59, 59).getTime()
    const span = Math.max(1, yearEnd - yearStart)
    this.yearStart = yearStart
    this.span = span
    const dateToX = (ms: number): number => {
      const p = Math.min(1, Math.max(0, (ms - yearStart) / span))
      return -AXIS_W / 2 + p * AXIS_W
    }

    // ---- As-lijn + maand-separators (wereldruimte, stretchen met de zoom) ----
    const axis = new Graphics()
    axis.moveTo(-AXIS_W / 2, 0).lineTo(AXIS_W / 2, 0).stroke({ width: 1, color: 0x3a4256, pixelLine: true })
    for (let m = 1; m < 12; m++) {
      const mx = dateToX(new Date(year, m, 1).getTime())
      axis.moveTo(mx, -14).lineTo(mx, 14).stroke({ width: 1, color: 0x2a3142, pixelLine: true })
    }
    this.root.addChild(axis)
    this.root.addChild(this.rangeBand)

    // Maandlabels: constante schermgrootte, op het midden van elke maand (schuiven
    // mee als de as uitrekt). Positie/schaal per frame (counter-scale).
    for (let m = 0; m < 12; m++) {
      const midX = (dateToX(new Date(year, m, 1).getTime()) + dateToX(new Date(year, m + 1, 1).getTime())) / 2
      const label = new Text({
        text: MONTHS[m],
        style: { fill: 0x8a97b0, fontSize: 15, fontFamily: 'Segoe UI, sans-serif' },
      })
      label.resolution = 2
      label.anchor.set(0.5, 0)
      this.root.addChild(label)
      this.monthLabels.push({ text: label, midX })
    }

    // ---- Meerdaagse (span) balken op de as (de balk is hun marker) -----------
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

    // ---- Lagen (achter→voor: leaders < stippen < kaarten) -------------------
    this.root.addChild(this.leaders)
    this.root.addChild(this.dotsLayer)
    this.root.addChild(this.cardsLayer)

    // ---- Nodes bouwen -------------------------------------------------------
    for (const ev of detail.events) {
      const node = this.buildNode(ev, anchorXOf(ev), isSpan(ev))
      this.nodes.push(node)
      if (node.hasCover) this.coverNodes.push(node)
    }
    // Packing-volgorde: strikt op belang aflopend, dan id-hash (deterministisch).
    this.coverNodes.sort((a, b) => b.eff - a.eff || a.hash - b.hash)
    this.coverNodes.forEach((n, i) => (n.prefSide = i % 2 === 0 ? -1 : 1))

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

    // Dag-indicator (Ctrl).
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

  private buildNode(ev: EventSummary, anchorX: number, isSpan: boolean): Node {
    const eff = effectiveSize(ev.size, ev.itemCount)
    const cardH = cardScreenH(eff, ev.id)
    const cardW = cardH * CARD_ASPECT
    const hasCover = !!ev.coverItemId

    let card: Container | null = null
    let title: Text | null = null
    let sprite: Sprite | null = null
    let sprite2: Sprite | null = null
    if (hasCover) {
      card = new Container()
      const frame = new Graphics()
      frame
        .roundRect(-THUMB_W / 2 - BORDER, -THUMB_H / 2 - BORDER, THUMB_W + BORDER * 2, THUMB_H + BORDER * 2, 5)
        .fill(0xf5f5f0)
      card.addChild(frame)
      const photoLayer = new Container()
      sprite = new Sprite(Texture.WHITE)
      sprite.anchor.set(0.5)
      sprite.setSize(THUMB_W, THUMB_H)
      sprite.tint = 0x2a3345
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
            fill: 0xe8edf6,
            fontSize: 18,
            fontWeight: '600',
            fontFamily: 'Segoe UI, sans-serif',
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
      card.visible = false
      this.cardsLayer.addChild(card)
    }

    // Stip-marker: voor non-cover events (permanent, met titel) en voor
    // cover-overflow bij een NIET-span (span heeft de balk als marker).
    let dot: Container | null = null
    if (!isSpan) {
      dot = new Container()
      const g = new Graphics()
      g.circle(0, 0, DOT_R).fill(hasCover ? 0xcfd6e4 : 0x8a97b0).stroke({ width: 2, color: 0x1a2030 })
      dot.addChild(g)
      if (!hasCover) {
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
        dot.addChild(label)
      }
      dot.visible = false
      this.dotsLayer.addChild(dot)
    }

    return {
      eventId: ev.id,
      anchorX,
      hasCover,
      isSpan,
      coverItemId: ev.coverItemId,
      eff,
      size: ev.size ?? 50,
      itemCount: ev.itemCount,
      hash: hashId(ev.id),
      prefSide: -1,
      cardW,
      cardH,
      baseScreenScale: cardH / THUMB_H,
      lane: null,
      card,
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

  /** Aantal lanes per kant dat in de viewporthoogte past (minimaal 1). Reserveert
   * de volle kaarthoogte + titelruimte in de buitenste lane, zodat een grote
   * kaart met titel niet boven/onder buiten beeld valt. */
  private lanesPerSide(vpH: number): number {
    const TITLE_CLEAR = 30
    return Math.max(1, Math.floor((vpH / 2 - AXIS_CLEAR_PX - CARD_H_MAX - TITLE_CLEAR) / LANE_PITCH) + 1)
  }

  /** Scherm-y (px, t.o.v. de as) van het midden van een lane. */
  private laneCenterY(lane: Lane): number {
    return lane.side * (AXIS_CLEAR_PX + CARD_H_MAX / 2 + lane.level * LANE_PITCH)
  }

  /** Breedte-dominante fit: het hele jaar past in de breedte; kaarten (constante
   * schermgrootte) vullen de lanes rond de gecentreerde as. */
  private fitCamera(): void {
    const vp = this.engine.viewport()
    const zoom = Math.max(this.engine.camera.minZoom, Math.min(vp.width / (AXIS_W + 160), 1))
    this.engine.jumpCamera(0, 0, zoom)
  }

  /** Wijs elke cover-node een lane toe (of stip) in SCHERMruimte, greedy op
   * belang, met plakkerige lane-behoud (hysterese) voor stabiliteit. */
  private repack(vpW: number, vpH: number): void {
    const z = this.engine.camera.zoom
    const camX = this.engine.camera.x
    const N = this.lanesPerSide(vpH)
    const occ = new Map<string, { lo: number; hi: number }[]>()
    for (const n of this.coverNodes) {
      const sx = (n.anchorX - camX) * z + vpW / 2
      const halfW = n.cardW / 2
      // Kandidaat-lanes: eerst de huidige (sticky, lossere gap), dan van binnen
      // naar buiten vanaf de voorkeurskant.
      const cands: { lane: Lane; sticky: boolean }[] = []
      if (n.lane) cands.push({ lane: n.lane, sticky: true })
      for (let lvl = 0; lvl < N; lvl++) {
        for (const side of n.prefSide < 0 ? [-1, 1] : [1, -1]) {
          if (n.lane && n.lane.side === side && n.lane.level === lvl) continue
          cands.push({ lane: { side, level: lvl }, sticky: false })
        }
      }
      let assigned: Lane | null = null
      for (const c of cands) {
        if (c.lane.level >= N) continue
        const key = `${c.lane.side}:${c.lane.level}`
        const gap = c.sticky ? STICKY_GAP_PX : CARD_GAP_PX
        const list = occ.get(key)
        let ok = true
        if (list) {
          for (const iv of list) {
            if (!(sx + halfW + gap < iv.lo || sx - halfW - gap > iv.hi)) {
              ok = false
              break
            }
          }
        }
        if (ok) {
          assigned = c.lane
          const l = occ.get(key) ?? []
          l.push({ lo: sx - halfW, hi: sx + halfW })
          occ.set(key, l)
          break
        }
      }
      n.lane = assigned
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

    // Maandlabels: constante schermgrootte, meebewegend met de uitrekkende as.
    for (const ml of this.monthLabels) {
      ml.text.scale.set(invZ)
      ml.text.position.set(ml.midX, LABEL_SCREEN_Y * invZ)
    }

    // Lane-toewijzing (kaart vs. stip) opnieuw bepalen.
    this.repack(vp.width, vp.height)

    this.leaders.clear()

    for (const n of this.nodes) {
      const screenX = (n.anchorX - camX) * z + halfW
      const inView = screenX + n.cardW / 2 > -marginPx && screenX - n.cardW / 2 < vp.width + marginPx
      const wasVisible = n.wasVisible

      if (n.hasCover && n.lane) {
        // --- Kaart ---
        if (n.dot) n.dot.visible = false
        const card = n.card!
        card.visible = inView
        n.wasVisible = inView
        if (!inView) {
          n.hitHalfW = 0
          continue
        }
        const laneY = this.laneCenterY(n.lane)
        // Hover-animatie.
        const targetHover = n.eventId === this.hoveredId ? 1.05 : 1
        n.hover += (targetHover - n.hover) * 0.2
        card.position.set(n.anchorX, laneY * invZ)
        card.scale.set((n.baseScreenScale * n.hover) * invZ)

        // Titel aan de buitenkant van de kaart (kant volgt de lane).
        if (n.title && n.titleSide !== n.lane.side) {
          n.titleSide = n.lane.side
          const outer = n.lane.side < 0 ? -1 : 1
          n.title.anchor.set(0.5, outer < 0 ? 1 : 0)
          n.title.position.set(0, outer * (THUMB_H / 2 + BORDER + 6))
        }

        // Leader: 1px van de as naar de onderrand van de kaart (wereldruimte).
        const innerY = (laneY - n.lane.side * (n.cardH / 2)) * invZ
        this.leaders
          .moveTo(n.anchorX, 0)
          .lineTo(n.anchorX, innerY)
          .stroke({ width: 1, color: 0x3a4256, alpha: 0.6, pixelLine: true })

        // Basis-cover laden (alleen zichtbare kaarten laden een texture).
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
          // Terug in beeld: een crossfade die tijdens de afwezigheid "bevroor" kan
          // een inmiddels geëvicte overlay-texture tonen → netjes afbreken.
          if (n.fade > 0 && n.sprite2) {
            n.sprite2.alpha = 0
            n.fade = 0
            n.pendingKey = ''
          }
          n.nextAt = now + this.slideMs * (0.3 + Math.random())
        }
        if (this.slideEnabled && n.loaded && n.sprite && n.sprite2 && n.photoIds.length > 1) {
          this.tickSlideshow(n, engine, frame, now, dt)
        }

        // Hit-box (wereld) = de constante scherm-kaart gedeeld door de zoom.
        n.hitCx = n.anchorX
        n.hitCy = laneY * invZ
        n.hitHalfW = (n.cardW / 2 + BORDER) * invZ
        n.hitHalfH = (n.cardH / 2 + BORDER) * invZ
      } else if (n.dot) {
        // --- Stip (non-cover, of cover-overflow bij een niet-span) ---
        if (n.card) n.card.visible = false
        // Kleine deterministische scherm-offset zodat same-date stippen niet
        // exact overlappen.
        const off = (((n.hash >>> 3) % 5) - 2) * 6
        n.dot.visible = inView
        n.wasVisible = inView
        if (!inView) {
          n.hitHalfW = 0
          continue
        }
        n.dot.position.set(n.anchorX + off * invZ, 0)
        n.dot.scale.set(invZ)
        n.hitCx = n.anchorX + off * invZ
        n.hitCy = 0
        n.hitHalfW = Math.max(MARKER_HIT_MIN, DOT_HIT) * invZ
        n.hitHalfH = DOT_HIT * invZ
      } else {
        // --- Span-overflow: alleen de balk (geen kaart, geen stip) ---
        if (n.card) n.card.visible = false
        n.wasVisible = false
        n.hitHalfW = 0
      }
    }
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
      if (!n.hasCover || !n.lane || n.hitHalfW <= 0) continue
      if (Math.abs(worldX - n.hitCx) > n.hitHalfW || Math.abs(worldY - n.hitCy) > n.hitHalfH) continue
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
      }
      return {
        moveTo: (mx, my) => {
          const f = Math.hypot(mx - cx, my - cy) / startDist
          apply(startSize * f)
          changed = true
          // Belang veranderde → herorden de packing-prioriteit.
          this.coverNodes.sort((a, b) => b.eff - a.eff || a.hash - b.hash)
        },
        end: () => {
          if (changed) void this.backend.setEventSize(n.eventId, n.size)
        },
      }
    }
    return null
  }

  destroy(): void {
    this.root.destroy({ children: true })
  }
}
