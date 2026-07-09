// L2 — Event-canvas: de items van één gebeurtenis als vrij, sleepbaar canvas.
// Foto's als kaartjes met witte rand, tekst als kaart. Posities komen uit
// `_canvas.json` (indien aanwezig) of een auto-grid. Slepen persisteert via
// de backend (write-through naar `_canvas.json`).

import { Container, Graphics, Sprite, Text, Texture } from 'pixi.js'
import type { Backend, CanvasLayoutInput, EventDetail, Item } from '../../lib/backend'
import type { FrameContext, RenderEngine } from '../core/engine'
import type { DragHandle } from '../core/gestures'
import type { NodePosition, Scene } from './scene'

/** Huidige stand + doelposities van het canvas (voor per-event view-geheugen). */
export interface LayoutState {
  mode: 'custom' | 'grid' | 'scatter'
  positions: NodePosition[]
}

const PHOTO = 200
const BORDER = 8
const TEXT_W = 240
const TEXT_H = 150
const CELL = 260

interface Node {
  item: Item
  ref: string
  container: Container
  sprite: Sprite | null
  ring: Graphics | null // gouden rand als deze foto de event-omslag (featured) is
  yearRing: Graphics | null // blauwe rand als deze foto de vaste jaar-cover is
  x: number
  y: number
  // Doel-positie/-rotatie; `update()` lerpt de node hier vloeiend naartoe (voor
  // de animatie bij het wisselen van layout-stand).
  tx: number
  ty: number
  trot: number
  half: number
  z: number
  // Eigen ("custom") layout: de posities/rotatie/z uit `_canvas.json` (of auto-grid).
  // Grid/scatter herschikken tijdelijk; hiernaar keer je altijd terug.
  baseX: number
  baseY: number
  baseRot: number
  baseZ: number
  key: string
  loaded: boolean
  // Layout-eigenschappen uit `_canvas.json` die deze fase (nog) niet visueel
  // toegepast worden maar WEL behouden moeten blijven bij het terugschrijven —
  // anders wist de eerste drag bestaande curatie (schaal/rotatie/afmeting).
  scale: number
  rotation: number
  textScale?: number
  width?: number
  height?: number
}

export class EventScene implements Scene {
  readonly root = new Container()
  private nodes: Node[] = []
  private zTop = 0
  private hoveredId: string | null = null
  private featuredRef: string | null
  private yearCoverId: string | null
  private mode: 'custom' | 'grid' | 'scatter' = 'custom'

  constructor(
    private engine: RenderEngine,
    private backend: Backend,
    detail: EventDetail,
    private onSave: (items: CanvasLayoutInput[]) => void,
    // Aangeroepen als een niet-'custom' opstelling verandert (drag in grid/scatter):
    // de app onthoudt de view dan per event (grid/scatter leven niet in de vault).
    private onViewChange?: (state: LayoutState) => void,
  ) {
    this.featuredRef = detail.event.featuredPhoto ?? null
    this.yearCoverId = detail.yearCover ?? null
    const layout = new Map(detail.canvas.map((c) => [c.itemRef, c]))
    const cols = Math.max(1, Math.ceil(Math.sqrt(detail.items.length)))

    detail.items.forEach((item, i) => {
      const ref = item.slug ?? item.id
      const container = new Container()
      const isText = item.itemType === 'text' || item.itemType === 'link'
      const half = isText ? Math.max(TEXT_W, TEXT_H) / 2 : PHOTO / 2 + BORDER

      let sprite: Sprite | null = null
      let ring: Graphics | null = null
      let yearRing: Graphics | null = null
      if (isText) {
        this.buildTextCard(container, item)
      } else {
        sprite = this.buildPhotoCard(container)
        yearRing = this.buildYearRing(container) // onder de gouden ring
        yearRing.visible = item.id === this.yearCoverId
        ring = this.buildFeaturedRing(container)
        ring.visible = ref === this.featuredRef
      }

      // Positie: uit _canvas.json of auto-grid.
      const saved = layout.get(ref)
      const x = saved ? saved.x : (i % cols) * CELL - ((cols - 1) * CELL) / 2
      const y = saved ? saved.y : Math.floor(i / cols) * CELL
      const z = saved ? saved.zIndex : i
      const rot = saved?.rotation ?? 0
      container.position.set(x, y)
      container.rotation = rot
      container.zIndex = z
      this.zTop = Math.max(this.zTop, z)

      this.root.addChild(container)
      this.nodes.push({
        item,
        ref,
        container,
        sprite,
        ring,
        yearRing,
        x,
        y,
        tx: x,
        ty: y,
        trot: rot,
        half,
        z,
        baseX: x,
        baseY: y,
        baseRot: rot,
        baseZ: z,
        key: `item-${item.id}`,
        loaded: false,
        scale: saved?.scale ?? 1,
        rotation: rot,
        textScale: saved?.textScale,
        width: saved?.width,
        height: saved?.height,
      })
    })

    this.root.sortableChildren = true
    engine.world.addChild(this.root)
    this.fitCamera(cols, Math.max(1, Math.ceil(detail.items.length / cols)))
  }

  private buildPhotoCard(container: Container): Sprite {
    const frame = new Graphics()
    frame
      .roundRect(-PHOTO / 2 - BORDER, -PHOTO / 2 - BORDER, PHOTO + BORDER * 2, PHOTO + BORDER * 2, 4)
      .fill(0xf5f5f0)
    container.addChild(frame)
    const mask = new Graphics()
    mask.rect(-PHOTO / 2, -PHOTO / 2, PHOTO, PHOTO).fill(0xffffff)
    const sprite = new Sprite(Texture.WHITE)
    sprite.anchor.set(0.5)
    sprite.setSize(PHOTO, PHOTO)
    sprite.tint = 0x2a3345
    container.addChild(sprite)
    container.addChild(mask)
    sprite.mask = mask
    return sprite
  }

  /** Gekleurde rand die de uitgelichte (featured) foto markeert; standaard uit. */
  private buildFeaturedRing(container: Container): Graphics {
    const r = PHOTO / 2 + BORDER + 3
    const ring = new Graphics()
    ring.roundRect(-r, -r, r * 2, r * 2, 6).stroke({ width: 4, color: 0xffc24b, alignment: 0 })
    ring.visible = false
    container.addChild(ring)
    return ring
  }

  /** Blauwe rand (net buiten de gouden) die de vaste jaar-cover markeert. */
  private buildYearRing(container: Container): Graphics {
    const r = PHOTO / 2 + BORDER + 8
    const ring = new Graphics()
    ring.roundRect(-r, -r, r * 2, r * 2, 8).stroke({ width: 4, color: 0x4b9bff, alignment: 0 })
    ring.visible = false
    container.addChild(ring)
    return ring
  }

  /** Zet de uitgelichte foto (op ref) — werkt de rand in-place bij. */
  setFeatured(ref: string | null): void {
    this.featuredRef = ref
    for (const n of this.nodes) {
      if (n.ring) n.ring.visible = n.ref === ref
    }
  }

  /** Zet de vaste jaar-cover (op item-id) — werkt de blauwe rand in-place bij. */
  setYearFeatured(itemId: string | null): void {
    this.yearCoverId = itemId
    for (const n of this.nodes) {
      if (n.yearRing) n.yearRing.visible = n.item.id === itemId
    }
  }

  /** Herschik het canvas. 'custom' herstelt de eigen posities; 'grid' zet ze
   * chronologisch in een vierkant raster; 'scatter' verspreidt ze speels
   * (kriskras + scheef, elke aanroep opnieuw). Grid/scatter persisteren NIET. */
  applyLayout(mode: 'custom' | 'grid' | 'scatter', snap = false, scatterRotate = true): void {
    this.mode = mode
    // Zet alleen de DOEL-posities/-rotatie; `update()` animeert de nodes ernaartoe.
    // z-order snapt wel meteen (anders "kruipen" de kaarten door elkaar).
    if (mode === 'custom') {
      for (const n of this.nodes) {
        n.tx = n.baseX
        n.ty = n.baseY
        n.trot = n.baseRot
        n.z = n.baseZ
        n.container.zIndex = n.z
      }
    } else if (mode === 'grid') {
      // Chronologisch (op timestamp; ongedateerd achteraan), zo vierkant mogelijk.
      const ordered = [...this.nodes].sort(
        (a, b) => (a.item.timestampMs ?? Infinity) - (b.item.timestampMs ?? Infinity),
      )
      const cols = Math.max(1, Math.ceil(Math.sqrt(ordered.length)))
      ordered.forEach((n, i) => {
        n.tx = (i % cols) * CELL - ((cols - 1) * CELL) / 2
        n.ty = Math.floor(i / cols) * CELL
        n.trot = 0
        n.z = i
        n.container.zIndex = n.z
      })
    } else {
      // Scatter: geschudde losse raster-cellen + flinke jitter + rotatie → een
      // "op tafel verspreid"-look; elke aanroep een nieuwe worp (dobbelsteen).
      const shuffled = [...this.nodes]
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
      }
      const cols = Math.max(1, Math.ceil(Math.sqrt(shuffled.length)))
      const S = CELL * 1.15
      shuffled.forEach((n, i) => {
        const jx = (Math.random() - 0.5) * S * 0.75
        const jy = (Math.random() - 0.5) * S * 0.75
        n.tx = (i % cols) * S - ((cols - 1) * S) / 2 + jx
        n.ty = Math.floor(i / cols) * S + jy
        n.trot = scatterRotate ? (Math.random() - 0.5) * 0.5 : 0 // ±0.25 rad, of recht
        n.z = Math.floor(Math.random() * 1000)
        n.container.zIndex = n.z
      })
    }
    // Trek `zTop` mee met de nieuw toegewezen z'en: anders levert een sleep
    // ná grid/scatter (`n.z = ++this.zTop`) een z ONDER de peers op (scatter
    // gebruikt z tot 999), waardoor de gesleepte kaart niet naar voren komt.
    for (const n of this.nodes) this.zTop = Math.max(this.zTop, n.z)
    if (snap) this.snapAll()
    this.refit()
  }

  /** Zet elke node meteen op zijn doel (geen animatie) — voor de eerste opbouw:
   * een onthouden scatter moet direct staan, niet vanaf de basis inklappen. */
  private snapAll(): void {
    for (const n of this.nodes) {
      n.x = n.tx
      n.y = n.ty
      n.container.position.set(n.x, n.y)
      n.container.rotation = n.trot
    }
  }

  /** Huidige stand + doelposities (tx/ty/trot/z = de eindstand, ook midden in een
   * animatie). Posities afgerond → kleinere localStorage-footprint. */
  layoutState(): LayoutState {
    return {
      mode: this.mode,
      positions: this.nodes.map((n) => ({
        ref: n.ref,
        x: Math.round(n.tx),
        y: Math.round(n.ty),
        rot: Math.round(n.trot * 1000) / 1000,
        z: Math.round(n.z),
      })),
    }
  }

  /** Herstel een onthouden scatter/grid: zet per node de doel-positie uit
   * `positions` (op ref). Items zonder opgeslagen positie (later toegevoegd) komen
   * bij het zwaartepunt met wat jitter te liggen, zodat ze meedoen i.p.v. op hun
   * basispositie te plakken. Geeft {matched,total} terug. */
  applyPositions(mode: 'grid' | 'scatter', positions: NodePosition[], snap = false): {
    matched: number
    total: number
  } {
    this.mode = mode
    const byRef = new Map(positions.map((p) => [p.ref, p]))
    // Zwaartepunt van de opgeslagen posities (plek voor nieuwe items).
    let cx = 0
    let cy = 0
    for (const p of positions) {
      cx += p.x
      cy += p.y
    }
    if (positions.length) {
      cx /= positions.length
      cy /= positions.length
    }
    let matched = 0
    for (const n of this.nodes) {
      const p = byRef.get(n.ref)
      if (p) {
        n.tx = p.x
        n.ty = p.y
        n.trot = p.rot
        n.z = p.z
        n.container.zIndex = p.z
        matched++
      } else {
        n.tx = cx + (Math.random() - 0.5) * CELL
        n.ty = cy + (Math.random() - 0.5) * CELL
        n.trot = mode === 'scatter' ? (Math.random() - 0.5) * 0.4 : 0
        n.z = ++this.zTop
        n.container.zIndex = n.z
      }
    }
    for (const n of this.nodes) this.zTop = Math.max(this.zTop, n.z)
    if (snap) this.snapAll()
    this.refit()
    return { matched, total: this.nodes.length }
  }

  /** Zet alle kaarten recht (false) of licht scheef (true) zónder de posities te
   * wijzigen — voor de scatter-rotatie-toggle. `update()` animeert de rotatie. */
  setScatterRotation(rotate: boolean): void {
    for (const n of this.nodes) {
      n.trot = rotate ? (Math.random() - 0.5) * 0.5 : 0
    }
  }

  /** Legt de HUIDIGE opstelling (posities + rotaties, bijv. een scatter of
   * gesleepte grid) vast als de eigen layout: base bijwerken + `_canvas.json`
   * schrijven, en overschakelen naar 'custom'. */
  saveAsCustom(): void {
    for (const n of this.nodes) {
      // Leg de DOEL-opstelling vast (tx/ty/trot), niet de eventuele tussenframe
      // van een nog lopende layout-animatie. Klik je "Opslaan als Eigen" vlak na
      // "Scatter" (kaarten nog aan het settelen), dan is `n.x`/`container.rotation`
      // een halverwege-waarde; `n.tx`/`n.trot` is de bedoelde eindstand. Voor een
      // gesleept item geldt tx==x (moveTo zet ze gelijk), dus dat verandert niet.
      n.baseX = n.tx
      n.baseY = n.ty
      n.baseRot = n.trot
      n.baseZ = n.z
      // Snap de node meteen op zijn eindstand (geen naschommeling na het opslaan)
      // en zorg dat persist (die n.x/n.y/n.rotation schrijft) de eindstand wegschrijft.
      n.x = n.tx
      n.y = n.ty
      n.container.position.set(n.x, n.y)
      n.container.rotation = n.trot
      n.rotation = n.trot // zodat persist de (scatter-)rotatie meeschrijft
    }
    this.mode = 'custom'
    this.persist()
  }

  /** Wereldgrenzen van alle kaarten op hun HUIDIGE positie (voor fit-to-view). */
  contentBounds(): { minX: number; minY: number; maxX: number; maxY: number } | null {
    if (this.nodes.length === 0) return null
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const n of this.nodes) {
      minX = Math.min(minX, n.x - n.half * n.scale)
      maxX = Math.max(maxX, n.x + n.half * n.scale)
      minY = Math.min(minY, n.y - n.half * n.scale)
      maxY = Math.max(maxY, n.y + n.half * n.scale)
    }
    return { minX, minY, maxX, maxY }
  }

  /** Zoom/pan de camera zo dat alle inhoud (huidige posities) precies past. */
  fitToView(): void {
    const b = this.contentBounds()
    if (!b) return
    const vp = this.engine.viewport()
    const w = b.maxX - b.minX
    const h = b.maxY - b.minY
    const zoom = Math.min(vp.width / (w + CELL), vp.height / (h + CELL))
    this.engine.jumpCamera(
      (b.minX + b.maxX) / 2,
      (b.minY + b.maxY) / 2,
      Math.max(this.engine.camera.minZoom, Math.min(zoom, 1.2)),
    )
  }

  /** Past de camera op de huidige node-bounds (na een layout-wissel). */
  private refit(): void {
    if (this.nodes.length === 0) return
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const n of this.nodes) {
      // Op de DOEL-bounds fitten (waar de animatie naartoe gaat), niet de
      // huidige tussenpositie.
      minX = Math.min(minX, n.tx - n.half * n.scale)
      maxX = Math.max(maxX, n.tx + n.half * n.scale)
      minY = Math.min(minY, n.ty - n.half * n.scale)
      maxY = Math.max(maxY, n.ty + n.half * n.scale)
    }
    const vp = this.engine.viewport()
    const w = maxX - minX
    const h = maxY - minY
    const zoom = Math.min(vp.width / (w + CELL), vp.height / (h + CELL))
    this.engine.jumpCamera(
      (minX + maxX) / 2,
      (minY + maxY) / 2,
      Math.max(this.engine.camera.minZoom, Math.min(zoom, 1.2)),
    )
  }

  /** De ref (slug/id) van het item onder een wereldpunt, of null. */
  refAt(worldX: number, worldY: number): string | null {
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const n = this.nodes[i]
      if (n.sprite && Math.abs(worldX - n.x) <= n.half * n.scale && Math.abs(worldY - n.y) <= n.half * n.scale) {
        return n.ref
      }
    }
    return null
  }

  private buildTextCard(container: Container, item: Item): void {
    const bg = new Graphics()
    bg.roundRect(-TEXT_W / 2, -TEXT_H / 2, TEXT_W, TEXT_H, 10).fill(0xfffdf5).stroke({
      width: 1,
      color: 0xe0dccb,
    })
    container.addChild(bg)
    const text = new Text({
      text: item.bodyText || item.caption || '…',
      style: {
        fill: 0x2b2b2b,
        fontSize: 16,
        fontStyle: 'italic',
        fontFamily: 'Georgia, serif',
        wordWrap: true,
        wordWrapWidth: TEXT_W - 32,
        align: 'center',
      },
    })
    text.resolution = 2
    // Boven-uitgelijnd + geklipt op het kader: lange tekst loopt niet meer buiten
    // de kaart (de volledige tekst lees je op L3, waar de kaart meegroeit).
    text.anchor.set(0.5, 0)
    text.position.set(0, -TEXT_H / 2 + 14)
    container.addChild(text)
    const clip = new Graphics()
    clip.roundRect(-TEXT_W / 2, -TEXT_H / 2, TEXT_W, TEXT_H, 10).fill(0xffffff)
    container.addChild(clip)
    text.mask = clip
  }

  private fitCamera(cols: number, rows: number): void {
    const vp = this.engine.viewport()
    const w = cols * CELL
    const h = rows * CELL
    const zoom = Math.min(vp.width / (w + CELL), vp.height / (h + CELL))
    this.engine.jumpCamera(
      0,
      h / 2 - CELL / 2,
      Math.max(this.engine.camera.minZoom, Math.min(zoom, 1.2)),
    )
  }

  beginDrag(wx: number, wy: number): DragHandle | null {
    // Slepen mag in elke stand. In 'custom' persisteert het meteen; in grid/scatter
    // verschuif je alleen visueel (niet weggeschreven) — met "Opslaan als Eigen"
    // leg je die opstelling vast als je eigen layout.
    // Bovenste item onder het punt.
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const n = this.nodes[i]
      if (Math.abs(wx - n.x) <= n.half * n.scale && Math.abs(wy - n.y) <= n.half * n.scale) {
        const offX = n.x - wx
        const offY = n.y - wy
        const startX = n.x
        const startY = n.y
        // Naar voren halen.
        n.z = ++this.zTop
        n.container.zIndex = n.z
        let moved = false
        return {
          moveTo: (mx, my) => {
            n.x = mx + offX
            n.y = my + offY
            // Doel = huidige positie, zodat de update-lerp de sleep niet tegenwerkt.
            n.tx = n.x
            n.ty = n.y
            n.container.position.set(n.x, n.y)
            // Pas als echt verplaatst telt het als een drag → write. De drempel
            // is zoom-geschaald zodat hij overeenkomt met de 6px-scherm-tapdrempel
            // in de gesture-controller (world = screen / zoom). Anders zou een tik
            // met lichte jitter bij uitgezoomd L2 zowel persist ALS onTap (→L3)
            // triggeren én het item ongewild verschuiven.
            const dragPx = 6 / this.engine.camera.zoom
            if (!moved && Math.hypot(n.x - startX, n.y - startY) > dragPx) moved = true
          },
          end: () => {
            // Alleen in de eigen layout leggen we de sleep meteen vast (base +
            // _canvas.json). In grid/scatter verschuift het item alleen visueel;
            // "Opslaan als Eigen" legt die opstelling desgewenst vast.
            if (moved && this.mode === 'custom') {
              n.baseX = n.x
              n.baseY = n.y
              n.baseZ = n.z
              this.persist()
            } else if (moved) {
              // Grid/scatter gaat niet naar de vault, maar de per-event view
              // onthouden we wél (een gesleepte scatter blijft zo bewaard).
              this.onViewChange?.(this.layoutState())
            }
          },
        }
      }
    }
    return null
  }

  /** Roteren (Alt) of schalen (Shift) van de foto onder het punt. Alleen in de
   * eigen layout ('custom'), zodat het naar `_canvas.json` gepersisteerd kan worden.
   * Roteren volgt de muishoek rond het midden; schalen de afstand tot het midden. */
  beginTransform(wx: number, wy: number, kind: 'rotate' | 'scale'): DragHandle | null {
    if (this.mode !== 'custom') return null
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const n = this.nodes[i]
      const hw = n.half * n.scale
      if (Math.abs(wx - n.x) > hw || Math.abs(wy - n.y) > hw) continue
      // Naar voren halen.
      n.z = ++this.zTop
      n.container.zIndex = n.z
      let changed = false
      if (kind === 'rotate') {
        const startAngle = Math.atan2(wy - n.y, wx - n.x)
        const startRot = n.trot
        return {
          moveTo: (mx, my) => {
            n.trot = startRot + (Math.atan2(my - n.y, mx - n.x) - startAngle)
            n.rotation = n.trot
            n.container.rotation = n.trot // meteen responsief (geen lerp-vertraging)
            changed = true
          },
          end: () => {
            if (!changed) return
            n.baseRot = n.trot
            this.persist()
          },
        }
      }
      // Schalen: factor = huidige afstand / startafstand tot het midden.
      const startDist = Math.max(1, Math.hypot(wx - n.x, wy - n.y))
      const startScale = n.scale
      return {
        moveTo: (mx, my) => {
          const f = Math.hypot(mx - n.x, my - n.y) / startDist
          n.scale = Math.min(4, Math.max(0.3, startScale * f))
          changed = true
        },
        end: () => {
          if (changed) this.persist()
        },
      }
    }
    return null
  }

  private persist(): void {
    // Behoud bestaande layout-eigenschappen (scale/rotation/textScale/width/
    // height) uit `_canvas.json`; drag wijzigt alleen positie en z-order.
    const items: CanvasLayoutInput[] = this.nodes.map((n) => ({
      itemRef: n.ref,
      x: n.x,
      y: n.y,
      scale: n.scale,
      rotation: n.rotation,
      zIndex: n.z,
      textScale: n.textScale,
      width: n.width,
      height: n.height,
    }))
    this.onSave(items)
  }

  onHover(worldX: number | null, worldY: number): void {
    this.hoveredId = worldX === null ? null : this.hitTest(worldX, worldY)
  }

  update(ctx: FrameContext): void {
    const { engine, frame } = ctx
    for (const n of this.nodes) {
      // Vloeiend naar de doel-layout bewegen (animatie bij een stand-wissel).
      // Binnen een kleine epsilon meteen snappen, zodat een node in rust niet
      // eeuwig sub-pixel micro-updates op de container-transform blijft doen.
      const dx = n.tx - n.x
      const dy = n.ty - n.y
      n.x = Math.abs(dx) < 0.05 ? n.tx : n.x + dx * 0.18
      n.y = Math.abs(dy) < 0.05 ? n.ty : n.y + dy * 0.18
      n.container.position.set(n.x, n.y)
      // Rotatie via het kortste pad naar het doel lerpen.
      let dr = n.trot - n.container.rotation
      if (dr > Math.PI) dr -= Math.PI * 2
      else if (dr < -Math.PI) dr += Math.PI * 2
      n.container.rotation =
        Math.abs(dr) < 0.001 ? n.trot : n.container.rotation + dr * 0.18

      // Vloeiende schaal: de eigen (curatie-)schaal `n.scale`, met een lichte
      // hover-boost. Zo volgt de kaart een Shift-sleep-schaal én de hover.
      const target = n.scale * (n.item.id === this.hoveredId ? 1.05 : 1)
      const s = n.container.scale.x + (target - n.container.scale.x) * 0.2
      n.container.scale.set(s)

      if (!n.sprite || n.loaded || !n.item.media) continue
      const tex = engine.textures.get(n.key, frame)
      if (tex) {
        n.sprite.texture = tex
        n.sprite.tint = 0xffffff
        const s = Math.max(PHOTO / tex.width, PHOTO / tex.height)
        n.sprite.setSize(tex.width * s, tex.height * s)
        n.loaded = true
      } else {
        const src = this.backend.thumb(n.item.id, 256)
        engine.textures.request({ key: n.key, url: src.url, hue: src.hue, size: 256 })
      }
    }
  }

  hitTest(worldX: number, worldY: number): string | null {
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const n = this.nodes[i]
      if (Math.abs(worldX - n.x) <= n.half * n.scale && Math.abs(worldY - n.y) <= n.half * n.scale) {
        return n.item.id
      }
    }
    return null
  }

  destroy(): void {
    this.root.destroy({ children: true })
  }
}
