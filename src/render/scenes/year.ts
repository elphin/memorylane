// L1 — Jaar: een horizontale maand-tijdlijn (Jan–Dec) met per event een
// thumbnail op zijn datum. Bij drukte stapelen thumbnails boven én onder de as,
// elk met een leader-lijntje naar de datumplek. Klik op een event → L2-canvas.
// Zo zijn de niveaus consistent: L1 = jaar-tijdlijn van events, L2 = foto's van
// één event, L3 = één foto.

import { Container, Graphics, Sprite, Text, Texture } from 'pixi.js'
import type { Backend, EventSummary, YearDetail } from '../../lib/backend'
import type { FrameContext, RenderEngine } from '../core/engine'
import type { Scene } from './scene'

const AXIS_W = 2400 // wereldbreedte van de jaar-as (Jan..Dec)
const THUMB_W = 168
const THUMB_H = 126
const BORDER = 8
const AXIS_GAP = 104 // afstand as → midden van de eerste lane-kaart
const LANE_GAP = 22 // verticale ruimte tussen lanes
const CARD_GAP = 26 // min. horizontale ruimte tussen kaarten in dezelfde lane
const DOT_R = 9 // marker voor events zonder cover

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
    const dateToX = (ms: number): number => {
      const p = Math.min(1, Math.max(0, (ms - yearStart) / span))
      return -AXIS_W / 2 + p * AXIS_W
    }

    // ---- Achtergrond: as-lijn, maand-separators en -labels -----------------
    const axis = new Graphics()
    axis.moveTo(-AXIS_W / 2, 0).lineTo(AXIS_W / 2, 0).stroke({ width: 2, color: 0x3a4256 })
    for (let m = 0; m < 12; m++) {
      const mx = dateToX(new Date(year, m, 1).getTime())
      if (m > 0) axis.moveTo(mx, -16).lineTo(mx, 16).stroke({ width: 1, color: 0x2a3142 })
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
    // Datumplek van een event op de as: bij een meerdaags event het midden van
    // de periode (en teken meteen het balkje), anders exact de startdatum.
    const anchorFor = (ev: EventSummary): number => {
      const startX = dateToX(parseLocalDate(ev.startAt))
      if (ev.endAt) {
        const endX = dateToX(parseLocalDate(ev.endAt))
        if (endX - startX > 4) {
          spans.roundRect(startX, -7, endX - startX, 14, 7).fill({ color: 0x4a5570, alpha: 0.9 })
          return (startX + endX) / 2
        }
      }
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

    const laneRight: Record<string, number> = {}
    let maxAbsY = 0

    withCover.forEach((ev, j) => {
      const anchorX = anchorFor(ev)
      // Wissel de voorkeurszijde per event → gebalanceerd boven/onder.
      const prefer = j % 2 === 0 ? -1 : 1 // -1 = boven (neg. y), 1 = onder
      let side = prefer
      let level = 0
      for (let lvl = 0; lvl < 64; lvl++) {
        const kPref = `${prefer}:${lvl}`
        const kOther = `${-prefer}:${lvl}`
        if (anchorX - THUMB_W / 2 > (laneRight[kPref] ?? -1e9) + CARD_GAP) {
          side = prefer
          level = lvl
          break
        }
        if (anchorX - THUMB_W / 2 > (laneRight[kOther] ?? -1e9) + CARD_GAP) {
          side = -prefer
          level = lvl
          break
        }
      }
      laneRight[`${side}:${level}`] = anchorX + THUMB_W / 2
      const cardY = side * (AXIS_GAP + level * (THUMB_H + LANE_GAP))
      maxAbsY = Math.max(maxAbsY, Math.abs(cardY) + THUMB_H / 2)

      // Leader: van de datumplek op de as naar de binnenrand van de kaart.
      const innerY = cardY - side * (THUMB_H / 2)
      leaders.moveTo(anchorX, 0).lineTo(anchorX, innerY).stroke({ width: 1.5, color: 0x3a4256, alpha: 0.7 })

      this.nodes.push(this.buildCard(ev, anchorX, cardY))
    })

    // Events zonder cover: een stip + titel op de as.
    withoutCover.forEach((ev) => {
      const anchorX = anchorFor(ev)
      this.nodes.push(this.buildDot(ev, anchorX))
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

  private buildCard(ev: EventSummary, anchorX: number, cardY: number): Node {
    const container = new Container()
    container.position.set(anchorX, cardY)

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
      halfW: THUMB_W / 2 + BORDER,
      halfH: THUMB_H / 2 + BORDER,
      key: `cover-${ev.coverItemId}`,
      loaded: false,
      scale: 1,
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
    const contentW = AXIS_W + THUMB_W + 120
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
      n.container.scale.set(n.scale)

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

  destroy(): void {
    this.root.destroy({ children: true })
  }
}
