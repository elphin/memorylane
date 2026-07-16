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
  /** Grid-sorteervolgorde + seed (voor 'random'), zodat de gekozen sortering
   * per event onthouden kan worden. */
  gridSort: 'date' | 'name' | 'random'
  gridSeed: number
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
  frame: Graphics | null // witte rand-kaart (foto); wordt op de foto-verhouding gezet
  mask: Graphics | null // clip-masker (foto)
  ring: Graphics | null // gouden rand als deze foto de event-omslag (featured) is
  yearRing: Graphics | null // blauwe rand als deze foto de vaste jaar-cover is
  focusRing: Graphics | null // aparte focus-ring (alleen notities; foto's gebruiken hun frame)
  focusAlpha: number // gedempte zichtbaarheid van de focus-ring (0..1, notities)
  borderAlpha: number // gedempte zichtbaarheid van de eigen witte rand (foto's, 0..1)
  // Notitie-kaart (tekst/link): losse onderdelen zodat de box los van de tekst
  // hergroot kan worden (Alt-slepen = box groter, font gelijk; tekst herloopt).
  textBg: Graphics | null
  textEl: Text | null
  textClip: Graphics | null
  x: number
  y: number
  // Doel-positie/-rotatie; `update()` lerpt de node hier vloeiend naartoe (voor
  // de animatie bij het wisselen van layout-stand).
  tx: number
  ty: number
  trot: number
  // Halve kaartmaat (incl. rand) voor hittest/bounds — apart per as zodat een
  // niet-vierkante foto correct raakbaar is. cardW/cardH = de foto-inhoud.
  halfW: number
  halfH: number
  cardW: number
  cardH: number
  frameBorder: number // huidige (gedempte) witte-rand-dikte waarmee het frame getekend is
  z: number
  // Eigen ("custom") layout: de posities/rotatie/z uit `_canvas.json` (of auto-grid).
  // Grid/scatter herschikken tijdelijk; hiernaar keer je altijd terug.
  baseX: number
  baseY: number
  baseRot: number
  baseZ: number
  key: string
  loaded: boolean
  tier: number // huidige geladen bron-resolutie (256/1024/2048) — LOD
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
  // Featured-randen zijn alleen zichtbaar terwijl de toets(en) ingedrukt zijn.
  private ringCtrl = false
  private ringShift = false
  private mode: 'custom' | 'grid' | 'scatter' = 'custom'
  // Sorteervolgorde van het grid + een seed die per 'willekeurig'-klik verspringt.
  private gridSort: 'date' | 'name' | 'random' = 'date'
  private gridSeed = 1
  // Herpak het grid zodra een foto-verhouding is geladen (grid-modus).
  private regridPending = false
  // Toetsenbord-navigatie: item.id van het gefocuste item (consistent met hitTest
  // en enterFocus), of null in muis-modus.
  private kbFocusId: string | null = null

  constructor(
    private engine: RenderEngine,
    private backend: Backend,
    detail: EventDetail,
    private onSave: (items: CanvasLayoutInput[]) => void,
    // Aangeroepen als een niet-'custom' opstelling verandert (drag in grid/scatter):
    // de app onthoudt de view dan per event (grid/scatter leven niet in de vault).
    private onViewChange?: (state: LayoutState) => void,
    // Foto's naar een vierkant (1:1) bijsnijden? Uit = natuurlijke verhouding.
    private squarePhotos = false,
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
      let frame: Graphics | null = null
      let mask: Graphics | null = null
      let ring: Graphics | null = null
      let yearRing: Graphics | null = null
      let textBg: Graphics | null = null
      let textEl: Text | null = null
      let textClip: Graphics | null = null
      if (isText) {
        const tc = this.buildTextCard(container, item)
        textBg = tc.bg
        textEl = tc.text
        textClip = tc.clip
      } else {
        const card = this.buildPhotoCard(container)
        sprite = card.sprite
        frame = card.frame
        mask = card.mask
        yearRing = this.buildYearRing(container) // onder de gouden ring
        ring = this.buildFeaturedRing(container)
        // Randen standaard verborgen: alleen zichtbaar terwijl Ctrl / Ctrl+Shift
        // ingedrukt is (zie setRingKeys).
        // Video's krijgen een play-badge zodat ze meteen herkenbaar zijn.
        if (item.itemType === 'video') this.buildPlayBadge(container)
      }

      // Toetsenbord-focus-indicator. Foto's gebruiken hun EIGEN witte rand (de
      // `frame` faadt weg voor niet-gefocuste tegels, net als de jaar-view); een
      // notitie heeft geen witte fotorand en krijgt daarom een aparte ring.
      let focusRing: Graphics | null = null
      if (isText) {
        focusRing = new Graphics()
        focusRing.visible = false
        container.addChild(focusRing)
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
      const node: Node = {
        item,
        ref,
        container,
        sprite,
        frame,
        mask,
        ring,
        yearRing,
        focusRing,
        focusAlpha: 0,
        borderAlpha: 1,
        textBg,
        textEl,
        textClip,
        x,
        y,
        tx: x,
        ty: y,
        trot: rot,
        halfW: half,
        halfH: half,
        cardW: PHOTO,
        cardH: PHOTO,
        frameBorder: BORDER,
        z,
        baseX: x,
        baseY: y,
        baseRot: rot,
        baseZ: z,
        key: `item-${item.id}`,
        loaded: false,
        tier: 0,
        scale: saved?.scale ?? 1,
        rotation: rot,
        textScale: saved?.textScale,
        width: saved?.width,
        height: saved?.height,
      }
      this.nodes.push(node)
      // Notitie: box op maat zetten (onthouden width/height of default) → juiste
      // hittest-halfmaten (breedte×hoogte i.p.v. vierkant) + herlopen tekst.
      if (isText) {
        this.sizeTextCard(node, node.width ?? TEXT_W, node.height ?? TEXT_H)
      }
    })

    this.root.sortableChildren = true
    engine.world.addChild(this.root)
    this.fitCamera(cols, Math.max(1, Math.ceil(detail.items.length / cols)))
  }

  private buildPhotoCard(container: Container): { sprite: Sprite; frame: Graphics; mask: Graphics } {
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
    return { sprite, frame, mask }
  }

  /** Zet een foto-kaart op afmeting `w`×`h` (foto-inhoud): hertekent de witte
   * rand, het masker en de eventuele rings, en werkt de hittest-halfmaten bij.
   * Voor de natuurlijke-verhouding-modus (niet 1:1). */
  private sizePhotoCard(n: Node, w: number, h: number): void {
    n.cardW = w
    n.cardH = h
    n.halfW = w / 2 + BORDER
    n.halfH = h / 2 + BORDER
    n.mask?.clear()
    n.mask?.rect(-w / 2, -h / 2, w, h).fill(0xffffff)
    n.sprite?.setSize(w, h)
    this.drawFrameBorder(n)
  }

  /** Effectieve witte-rand-dikte: dempt mee met de eigen schaal, zodat een
   * opgeschaalde foto geen evenredig dikke (log-uit-proportie) rand krijgt. */
  private effBorder(scale: number): number {
    return BORDER / Math.sqrt(Math.max(1, scale))
  }

  /** (Her)teken de witte rand + de (goud/blauw) rings op de huidige kaartmaat met
   * de gedempte rand-dikte. Wijzigt geen zichtbaarheid (die stuurt refreshRings). */
  private drawFrameBorder(n: Node): void {
    if (!n.frame) return
    const eb = this.effBorder(n.scale)
    n.frameBorder = eb
    const w = n.cardW
    const h = n.cardH
    n.frame.clear()
    n.frame.roundRect(-w / 2 - eb, -h / 2 - eb, w + eb * 2, h + eb * 2, 4).fill(0xf5f5f0)
    const k = eb / BORDER // schaalt ring-dikte + -offset mee met de gedempte rand
    if (n.ring) {
      const rw = w / 2 + eb + 3 * k
      const rh = h / 2 + eb + 3 * k
      n.ring.clear()
      n.ring.roundRect(-rw, -rh, rw * 2, rh * 2, 6).stroke({ width: 4 * k, color: 0xffc24b, alignment: 0 })
    }
    if (n.yearRing) {
      const rw = w / 2 + eb + 8 * k
      const rh = h / 2 + eb + 8 * k
      n.yearRing.clear()
      n.yearRing.roundRect(-rw, -rh, rw * 2, rh * 2, 8).stroke({ width: 4 * k, color: 0x4b9bff, alignment: 0 })
    }
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

  /** Gecentreerde play-badge (donkere cirkel + witte driehoek) — markeert een
   * video onder de foto's. Bovenop de kaart, schaalt mee met de tegel. */
  private buildPlayBadge(container: Container): Graphics {
    const R = 16
    const g = new Graphics()
    g.circle(0, 0, R).fill({ color: 0x000000, alpha: 0.45 })
    g.circle(0, 0, R).stroke({ width: 2, color: 0xffffff, alpha: 0.92 })
    // Driehoek proportioneel aan R (lichte offset naar rechts oogt gecentreerd).
    g.poly([-R * 0.28, -R * 0.4, -R * 0.28, R * 0.4, R * 0.52, 0]).fill({ color: 0xffffff, alpha: 0.96 })
    container.addChild(g)
    return g
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

  /** Zet de uitgelichte foto (op ref) — de rand toont pas bij ingedrukte toets. */
  setFeatured(ref: string | null): void {
    this.featuredRef = ref
    this.refreshRings()
  }

  /** Zet de vaste jaar-cover (op item-id) — de blauwe rand toont pas bij toets. */
  setYearFeatured(itemId: string | null): void {
    this.yearCoverId = itemId
    this.refreshRings()
  }

  /** Toon de featured-randen alleen terwijl de toets(en) ingedrukt zijn: Ctrl =
   * gouden memory-cover, Ctrl+Shift = blauwe jaar-cover. */
  setRingKeys(ctrl: boolean, shift: boolean): void {
    if (this.ringCtrl === ctrl && this.ringShift === shift) return
    this.ringCtrl = ctrl
    this.ringShift = shift
    this.refreshRings()
  }

  private refreshRings(): void {
    for (const n of this.nodes) {
      if (n.ring) n.ring.visible = this.ringCtrl && n.ref === this.featuredRef
      if (n.yearRing) n.yearRing.visible = this.ringCtrl && this.ringShift && n.item.id === this.yearCoverId
    }
  }

  /** (Her)teken de notitie-focus-ring op de huidige kaartmaat (halfW/halfH), net
   * buiten de rand. Wit en subtiel. Foto's gebruiken hun eigen frame (geen ring). */
  private drawFocusRing(n: Node): void {
    if (!n.focusRing) return
    const pad = 4
    const hw = n.halfW + pad
    const hh = n.halfH + pad
    n.focusRing.clear()
    n.focusRing.roundRect(-hw, -hh, hw * 2, hh * 2, 8).stroke({ width: 3, color: 0xffffff, alignment: 0 })
  }

  // ---- Toetsenbord-navigatie (2D spatial focus, L2) ----

  /** Focus het item het dichtst bij het scherm-midden (camera-positie). Werkt op
   * de DOEL-posities (tx/ty), niet het animatie-tussenframe. Geeft item.id terug. */
  focusFirst(): string | null {
    if (this.nodes.length === 0) return null
    const cx = this.engine.camera.x
    const cy = this.engine.camera.y
    let best: Node | null = null
    let bestD = Infinity
    for (const n of this.nodes) {
      const d = (n.tx - cx) ** 2 + (n.ty - cy) ** 2
      if (d < bestD - 1e-6 || (Math.abs(d - bestD) <= 1e-6 && best && n.item.id.localeCompare(best.item.id) < 0)) {
        bestD = d
        best = n
      }
    }
    if (!best) return null
    this.kbFocusId = best.item.id
    this.scrollIntoView(best)
    return this.kbFocusId
  }

  /** Verplaats de focus naar de dichtstbijzijnde buur in een richting (2D). Kegel
   * van 45° op de DOEL-posities; buiten de kegel valt 'ie terug op het hele
   * richtings-halfvlak (toets nooit "dood"); score = |primair| + 2·|perp|, met
   * item.id als deterministische tie-break. Geen kandidaat → focus blijft staan. */
  focusNeighbor(dir: 'left' | 'right' | 'up' | 'down'): string | null {
    if (!this.kbFocusId) return this.focusFirst()
    const cur = this.nodes.find((n) => n.item.id === this.kbFocusId)
    if (!cur) return this.focusFirst()
    const horiz = dir === 'left' || dir === 'right'
    const sign = dir === 'left' || dir === 'up' ? -1 : 1
    const eps = 1
    const inDir: { n: Node; prim: number; perp: number }[] = []
    for (const n of this.nodes) {
      if (n === cur) continue
      const dx = n.tx - cur.tx
      const dy = n.ty - cur.ty
      const prim = horiz ? dx : dy
      const perp = horiz ? dy : dx
      if (prim * sign <= eps) continue // niet in de gevraagde richting
      inDir.push({ n, prim: Math.abs(prim), perp: Math.abs(perp) })
    }
    if (inDir.length === 0) return this.kbFocusId // niets in die richting → blijf staan
    const cone = inDir.filter((c) => c.prim >= c.perp) // 45°-kegel: recht in de richting
    const pool = cone.length ? cone : inDir
    let best: (typeof pool)[number] | null = null
    let bestScore = Infinity
    for (const c of pool) {
      const score = c.prim + 2 * c.perp
      if (
        score < bestScore - 1e-6 ||
        (Math.abs(score - bestScore) <= 1e-6 && best && c.n.item.id.localeCompare(best.n.item.id) < 0)
      ) {
        bestScore = score
        best = c
      }
    }
    if (!best) return this.kbFocusId
    this.kbFocusId = best.n.item.id
    this.scrollIntoView(best.n)
    return this.kbFocusId
  }

  focusedId(): string | null {
    return this.kbFocusId
  }

  clearKbFocus(): void {
    this.kbFocusId = null
  }

  /** Pan de camera (2D) naar het gefocuste item als het buiten een comfort-marge
   * valt; zoom ongemoeid. Meestal past alles al in beeld → geen beweging. Nult
   * eerst resterende fling-inertie zodat die de animatie niet overschrijft. */
  private scrollIntoView(n: Node): void {
    const z = this.engine.camera.zoom
    const b = this.engine.camera.worldBounds(this.engine.viewport())
    const mx = (b.maxX - b.minX) * 0.2
    const my = (b.maxY - b.minY) * 0.2
    const outX = n.tx < b.minX + mx || n.tx > b.maxX - mx
    const outY = n.ty < b.minY + my || n.ty > b.maxY - my
    if (outX || outY) {
      this.engine.syncElastic()
      this.engine.animateCamera(n.tx, n.ty, z, 820, (t) => 1 - Math.pow(1 - t, 5))
    }
  }

  /** Grid-plaatsing (chronologisch) als een "shelf"/justified-gallery: kaarten op
   * hun WERKELIJKE grootte (verhouding × eigen schaal) links→rechts in rijen, met
   * gaps ertussen; een rij breekt als hij te breed wordt. Zo overlappen niet-
   * vierkante of geschaalde foto's elkaar niet, en oogt het raster natuurlijker
   * dan een strak vierkant grid. Zet alleen doel-posities/z (update() animeert). */
  /** Volgorde van de nodes voor het grid, volgens de gekozen sorteerstand. */
  private orderedForGrid(): Node[] {
    const arr = [...this.nodes]
    if (this.gridSort === 'name') {
      return arr.sort((a, b) =>
        this.nameKey(a).localeCompare(this.nameKey(b), undefined, { numeric: true, sensitivity: 'base' }),
      )
    }
    if (this.gridSort === 'random') {
      return arr.sort((a, b) => this.randKey(a.ref) - this.randKey(b.ref))
    }
    return arr.sort((a, b) => (a.item.timestampMs ?? Infinity) - (b.item.timestampMs ?? Infinity))
  }

  /** Naam/bestandsnaam-sleutel: bijschrift, anders media/url-bestandsnaam, anders id. */
  private nameKey(n: Node): string {
    const it = n.item
    const raw = it.caption || it.media || it.url || it.slug || it.id || ''
    return raw.split(/[\\/]/).pop() ?? raw // alleen de bestandsnaam bij een pad
  }

  /** Deterministische hash van ref + seed → stabiele willekeurige volgorde per
   * seed (herpakken bij foto-load schudt NIET), verspringt bij een nieuwe seed. */
  private randKey(ref: string): number {
    let h = this.gridSeed >>> 0
    for (let i = 0; i < ref.length; i++) h = Math.imul(h ^ ref.charCodeAt(i), 0x01000193) >>> 0
    return h
  }

  /** Zet de grid-sorteervolgorde en herpak. 'random' geeft elke aanroep een nieuwe
   * worp (ook als je er al op staat) → herhaald klikken schudt opnieuw. */
  setGridSort(sort: 'date' | 'name' | 'random'): void {
    if (sort === 'random') this.gridSeed = (this.gridSeed + 0x9e3779b1) >>> 0
    this.gridSort = sort
    this.mode = 'grid'
    this.layoutGridPositions()
    this.refit()
  }

  private layoutGridPositions(): void {
    const ordered = this.orderedForGrid()
    const gap = 28
    const items = ordered.map((n) => ({ n, w: 2 * n.halfW * n.scale, h: 2 * n.halfH * n.scale }))
    if (items.length === 0) return
    const avgW = items.reduce((s, it) => s + it.w, 0) / items.length
    const cols = Math.max(1, Math.round(Math.sqrt(items.length)))
    // Strip-breedte: minstens het breedste item, doel ~`cols` kolommen breed.
    const stripW = Math.max(...items.map((it) => it.w), cols * (avgW + gap) - gap)

    // Skyline-packing (bottom-left): plaats elk item op de laagste x waar het past.
    // Zo vullen korte kaarten de ruimte NAAST een hoge notitie op (meerdere
    // foto-rijen naast één hoge tegel) i.p.v. één rij per hoogste item (shelf).
    type Seg = { x: number; w: number; top: number }
    let sky: Seg[] = [{ x: 0, w: stripW, top: 0 }]
    const maxTop = (x0: number, w: number): number => {
      let t = 0
      for (const s of sky) {
        if (s.x + s.w <= x0 + 1e-6 || s.x >= x0 + w - 1e-6) continue
        if (s.top > t) t = s.top
      }
      return t
    }
    const raise = (x0: number, w: number, newTop: number): void => {
      const x1 = x0 + w
      const next: Seg[] = []
      for (const s of sky) {
        if (s.x + s.w <= x0 + 1e-6 || s.x >= x1 - 1e-6) {
          next.push(s)
          continue
        }
        if (s.x < x0 - 1e-6) next.push({ x: s.x, w: x0 - s.x, top: s.top })
        if (s.x + s.w > x1 + 1e-6) next.push({ x: x1, w: s.x + s.w - x1, top: s.top })
      }
      next.push({ x: x0, w, top: newTop })
      next.sort((a, b) => a.x - b.x)
      sky = []
      for (const s of next) {
        const last = sky[sky.length - 1]
        if (last && Math.abs(last.top - s.top) < 1e-6 && Math.abs(last.x + last.w - s.x) < 1e-6) last.w += s.w
        else sky.push({ ...s })
      }
    }

    const placed: { it: (typeof items)[number]; x: number; y: number }[] = []
    let zi = 0
    for (const it of items) {
      let bestX = 0
      let bestTop = Infinity
      for (const s of sky) {
        if (s.x + it.w > stripW + 1e-6) continue // past niet binnen de strip vanaf hier
        const top = maxTop(s.x, it.w + gap)
        if (top < bestTop - 1e-6) {
          bestTop = top
          bestX = s.x
        }
      }
      if (bestTop === Infinity) {
        // Breder dan de strip: bovenop alles op x=0.
        bestX = 0
        bestTop = Math.max(...sky.map((s) => s.top))
      }
      placed.push({ it, x: bestX, y: bestTop })
      raise(bestX, it.w + gap, bestTop + it.h + gap)
      it.n.z = zi++
      it.n.container.zIndex = it.n.z
      this.zTop = Math.max(this.zTop, it.n.z)
    }
    // Het hele blok centreren rond (0,0) op de werkelijke item-extents.
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (const p of placed) {
      minX = Math.min(minX, p.x)
      maxX = Math.max(maxX, p.x + p.it.w)
      minY = Math.min(minY, p.y)
      maxY = Math.max(maxY, p.y + p.it.h)
    }
    const cX = (minX + maxX) / 2
    const cY = (minY + maxY) / 2
    for (const p of placed) {
      p.it.n.tx = p.x + p.it.w / 2 - cX
      p.it.n.ty = p.y + p.it.h / 2 - cY
      p.it.n.trot = 0
    }
  }

  /** Herschik het canvas. 'custom' herstelt de eigen posities; 'grid' zet ze
   * chronologisch in een "shelf"-raster (rekening houdend met formaat); 'scatter'
   * verspreidt ze speels
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
      this.layoutGridPositions()
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
      gridSort: this.gridSort,
      gridSeed: this.gridSeed,
      positions: this.nodes.map((n) => ({
        ref: n.ref,
        x: Math.round(n.tx),
        y: Math.round(n.ty),
        rot: Math.round(n.trot * 1000) / 1000,
        z: Math.round(n.z),
      })),
    }
  }

  /** Herstel een onthouden grid-sortering (sort + seed) zonder te herpakken —
   * applyPositions zet de exacte opstelling; dit houdt alleen de stand consistent
   * zodat een latere herpak/reshuffle de juiste volgorde gebruikt. */
  restoreGridSort(sort: 'date' | 'name' | 'random', seed: number): void {
    this.gridSort = sort
    this.gridSeed = seed
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
      minX = Math.min(minX, n.x - n.halfW * n.scale)
      maxX = Math.max(maxX, n.x + n.halfW * n.scale)
      minY = Math.min(minY, n.y - n.halfH * n.scale)
      maxY = Math.max(maxY, n.y + n.halfH * n.scale)
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
    // Geanimeerd (i.p.v. springen) naar de passende camera, zodat "Alles passend"
    // vloeiend inzoomt/uitzoomt.
    this.engine.animateCamera(
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
      minX = Math.min(minX, n.tx - n.halfW * n.scale)
      maxX = Math.max(maxX, n.tx + n.halfW * n.scale)
      minY = Math.min(minY, n.ty - n.halfH * n.scale)
      maxY = Math.max(maxY, n.ty + n.halfH * n.scale)
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
      if (n.sprite && Math.abs(worldX - n.x) <= n.halfW * n.scale && Math.abs(worldY - n.y) <= n.halfH * n.scale) {
        return n.ref
      }
    }
    return null
  }

  private buildTextCard(container: Container, item: Item): { bg: Graphics; text: Text; clip: Graphics } {
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
    // Boven-uitgelijnd + geklipt op het kader: lange tekst loopt niet buiten de
    // box (met Alt-slepen maak je de box groter → meer tekst zichtbaar; Alt-tik =
    // passend om alle tekst te tonen).
    text.anchor.set(0.5, 0)
    text.position.set(0, -TEXT_H / 2 + 14)
    container.addChild(text)
    const clip = new Graphics()
    clip.roundRect(-TEXT_W / 2, -TEXT_H / 2, TEXT_W, TEXT_H, 10).fill(0xffffff)
    container.addChild(clip)
    text.mask = clip
    return { bg, text, clip }
  }

  /** Herteken de notitie-box op maat `w`×`h` (font blijft gelijk; tekst herloopt
   * op de nieuwe breedte en wordt op de nieuwe hoogte geklipt). Werkt de hittest-
   * halfmaten bij. */
  private sizeTextCard(n: Node, w: number, h: number): void {
    n.width = w
    n.height = h
    n.halfW = w / 2
    n.halfH = h / 2
    if (n.textBg) {
      n.textBg.clear()
      n.textBg.roundRect(-w / 2, -h / 2, w, h, 10).fill(0xfffdf5).stroke({ width: 1, color: 0xe0dccb })
    }
    if (n.textClip) {
      n.textClip.clear()
      n.textClip.roundRect(-w / 2, -h / 2, w, h, 10).fill(0xffffff)
    }
    if (n.textEl) {
      n.textEl.style.wordWrapWidth = w - 32
      n.textEl.position.set(0, -h / 2 + 14)
    }
    this.drawFocusRing(n) // box-maat veranderde → focus-ring mee hertekenen
  }

  /** "Passend": maak de box (op de huidige breedte) precies hoog genoeg voor alle
   * tekst, zodat je een lang verhaal volledig ziet. */
  private fitTextCard(n: Node): void {
    if (!n.textEl) return
    const w = n.width ?? TEXT_W
    n.textEl.style.wordWrapWidth = w - 32
    const needed = n.textEl.height + 28 // volledige gewrapte teksthoogte + marge
    this.sizeTextCard(n, w, Math.max(TEXT_H, needed))
    this.persist()
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
      if (Math.abs(wx - n.x) <= n.halfW * n.scale && Math.abs(wy - n.y) <= n.halfH * n.scale) {
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
      const hw = n.halfW * n.scale
      const hh = n.halfH * n.scale
      if (Math.abs(wx - n.x) > hw || Math.abs(wy - n.y) > hh) continue
      // Naar voren halen.
      n.z = ++this.zTop
      n.container.zIndex = n.z
      let changed = false
      // Notitie (tekst/link): Alt = box-resize i.p.v. roteren. Slepen maakt de box
      // groter/kleiner (font gelijk, tekst herloopt); een Alt-tík (geen beweging)
      // maakt de box passend om álle tekst te tonen.
      const isTextNode = n.item.itemType === 'text' || n.item.itemType === 'link'
      if (kind === 'rotate' && isTextNode) {
        const moveTol = 6 / this.engine.camera.zoom // world-drempel ~ 6 scherm-px
        return {
          moveTo: (mx, my) => {
            if (!changed && Math.hypot(mx - wx, my - wy) < moveTol) return // tik → geen resize
            // De box-hoek volgt de cursor: halve maten = afstand tot het midden,
            // teruggerekend naar lokale (ongeschaalde) coördinaten (÷ n.scale).
            const hw = Math.min(TEXT_W * 4, Math.max(TEXT_W * 0.5, Math.abs(mx - n.x) / n.scale))
            const hh = Math.min(TEXT_H * 6, Math.max(TEXT_H * 0.5, Math.abs(my - n.y) / n.scale))
            this.sizeTextCard(n, hw * 2, hh * 2)
            changed = true
          },
          end: () => {
            if (changed) this.persist()
            else this.fitTextCard(n) // Alt-tik = passend
          },
        }
      }
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
    const { engine, frame, dtMS } = ctx
    // Foto('s) laadden hun verhouding → herpak het grid (posities animeren mee).
    if (this.regridPending && this.mode === 'grid') {
      this.layoutGridPositions()
      this.regridPending = false
    }
    // Toetsenbord-focus-indicator in-/uitfaden. Foto's: hun eigen witte rand blijft
    // op de gefocuste tegel en faadt weg op de rest (net als de jaar-view). Notities:
    // een aparte ring op de gefocuste. Zonder toetsenbord-focus zijn alle randen vol.
    const kf = Math.min(1, dtMS / 130)
    for (const n of this.nodes) {
      const focused = n.item.id === this.kbFocusId
      if (n.frame) {
        const target = this.kbFocusId === null || focused ? 1 : 0
        n.borderAlpha += (target - n.borderAlpha) * kf
        n.frame.alpha = n.borderAlpha
      }
      if (n.focusRing) {
        const target = this.kbFocusId !== null && focused ? 1 : 0
        n.focusAlpha += (target - n.focusAlpha) * kf
        n.focusRing.alpha = n.focusAlpha
        n.focusRing.visible = n.focusAlpha > 0.01
      }
    }
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

      // Witte rand mee dempen als de eigen schaal wijzigt (Shift-slepen), zodat
      // een opgeschaalde foto geen te dikke rand krijgt.
      if (n.frame && Math.abs(this.effBorder(n.scale) - n.frameBorder) > 0.15) {
        this.drawFrameBorder(n)
      }

      if (!n.sprite || !n.item.media) continue

      // Basis-thumbnail (256) laden.
      if (!n.loaded) {
        const tex = engine.textures.get(n.key, frame)
        if (tex) {
          n.sprite.texture = tex
          n.sprite.tint = 0xffffff
          if (this.squarePhotos) {
            // Cover-crop naar het vierkante masker (1:1).
            const s = Math.max(PHOTO / tex.width, PHOTO / tex.height)
            n.sprite.setSize(tex.width * s, tex.height * s)
          } else {
            // Natuurlijke verhouding: de kaart krijgt de foto-vorm (langste zijde = PHOTO).
            const mx = Math.max(tex.width, tex.height)
            if (mx > 0) {
              const s = PHOTO / mx
              this.sizePhotoCard(n, tex.width * s, tex.height * s)
            } else {
              this.sizePhotoCard(n, PHOTO, PHOTO) // vangnet tegen een 0×0-texture
            }
            // De kaartgrootte veranderde → herpak het grid als dat de stand is.
            if (this.mode === 'grid') this.regridPending = true
          }
          n.loaded = true
          n.tier = 256
        } else {
          const src = this.backend.thumb(n.item.id, 256)
          engine.textures.request({ key: n.key, url: src.url, hue: src.hue, size: 256 })
        }
        continue
      }

      // LOD-upgrade: staat de foto groot in beeld (opgeschaald én/of ingezoomd),
      // laad dan een scherpere bron zodat 'ie niet wazig wordt.
      const onScreen = PHOTO * n.scale * engine.camera.zoom
      const need = onScreen > 620 ? 2048 : onScreen > 300 ? 1024 : 256
      if (need > n.tier) {
        const key = `${n.key}@${need}`
        const tex = engine.textures.get(key, frame)
        if (tex) {
          n.sprite.texture = tex
          n.sprite.tint = 0xffffff
          if (this.squarePhotos) {
            const s = Math.max(PHOTO / tex.width, PHOTO / tex.height)
            n.sprite.setSize(tex.width * s, tex.height * s)
          } else {
            // Zelfde weergavemaat, scherpere bron.
            n.sprite.setSize(n.cardW, n.cardH)
          }
          n.tier = need
        } else {
          const src = this.backend.thumb(n.item.id, need as 1024 | 2048)
          engine.textures.request({ key, url: src.url, hue: src.hue, size: need })
        }
      }
    }
  }

  hitTest(worldX: number, worldY: number): string | null {
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const n = this.nodes[i]
      if (Math.abs(worldX - n.x) <= n.halfW * n.scale && Math.abs(worldY - n.y) <= n.halfH * n.scale) {
        return n.item.id
      }
    }
    return null
  }

  destroy(): void {
    this.root.destroy({ children: true })
  }
}
