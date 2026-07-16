// L0 — Lifeline: alle jaren als tegels naast elkaar, elk met een cover-foto en
// jaartal. Tik (of zoom) op een jaar → naar L1. Bewust simpel: weinig tegels,
// dus geen zware virtualisatie nodig. Optioneel rouleren de covers als slideshow
// (door de uitgelichte of alle foto's van dat jaar).

import { Container, Graphics, Sprite, Text, Texture } from 'pixi.js'
import type { Backend, YearSummary } from '../../lib/backend'
import type { FrameContext, RenderEngine } from '../core/engine'
import type { Scene } from './scene'

const TILE_W = 320
const TILE_H = 240
const GAP = 80
const COVER_H = TILE_H - 56
const COVER_W = TILE_W - 16

interface Tile {
  year: YearSummary
  worldX: number
  cover: Sprite
  cover2: Sprite // crossfade-overlay voor de slideshow
  bg: Graphics
  focusRing: Graphics // witte rand bij toetsenbord-focus
  focusAlpha: number // gedempte zichtbaarheid van de focus-ring (0..1)
  container: Container
  scale: number
  // Slideshow: rouleer de cover door `pool` (crossfade). `pool` is leeg → statisch.
  pool: string[]
  idx: number
  curKey: string // texture-key die nu in `cover` zit (warm houden)
  pendingKey: string // texture-key die nu in `cover2` zit tijdens een fade
  pendingIdx: number
  nextAt: number // wereldklok-tijd (ms) waarop de volgende foto komt
  fade: number // 0 = niet aan het faden; >0 = crossfade-voortgang
  loaded: boolean
}

/** Cover-fit: vul het coverkader met behoud van aspect (mogelijk bijgesneden). */
function fitCover(sprite: Sprite, tex: Texture): void {
  const s = Math.max(COVER_W / tex.width, COVER_H / tex.height)
  sprite.setSize(tex.width * s, tex.height * s)
  sprite.position.set(COVER_W / 2 - (tex.width * s) / 2, COVER_H / 2 - (tex.height * s) / 2)
}

export class LifelineScene implements Scene {
  readonly root = new Container()
  private tiles: Tile[] = []
  private hoveredId: string | null = null
  private slideEnabled: boolean
  private slideMs: number
  // Toetsenbord-navigatie: year.id van het gefocuste jaar (consistent met hitTest
  // en enterYear), of null in muis-modus.
  private kbFocusId: string | null = null

  constructor(
    private engine: RenderEngine,
    private backend: Backend,
    years: YearSummary[],
    slideshow: { enabled: boolean; mode: 'featured' | 'random'; speedMs: number } = {
      enabled: false,
      mode: 'featured',
      speedMs: 5000,
    },
  ) {
    this.slideEnabled = slideshow.enabled
    this.slideMs = Math.max(1500, slideshow.speedMs)

    years.forEach((year, i) => {
      const worldX = i * (TILE_W + GAP)
      const tile = new Container()
      // Pivot in het midden zodat hover-schaal netjes vanuit het centrum groeit.
      tile.pivot.set(TILE_W / 2, TILE_H / 2)
      tile.position.set(worldX + TILE_W / 2, 0)

      const bg = new Graphics()
      bg.roundRect(0, 0, TILE_W, TILE_H, 12).fill(0x1a2030).stroke({ width: 2, color: 0x2c3650 })
      tile.addChild(bg)

      // Cover + crossfade-overlay in een geklipte container (afgeronde hoeken).
      const coverArea = new Container()
      coverArea.position.set(8, 8)
      const mask = new Graphics()
      mask.roundRect(0, 0, COVER_W, COVER_H, 8).fill(0xffffff)
      const cover = new Sprite(Texture.WHITE)
      cover.tint = 0x0e1420
      cover.setSize(COVER_W, COVER_H)
      const cover2 = new Sprite(Texture.WHITE)
      cover2.setSize(COVER_W, COVER_H)
      cover2.alpha = 0
      coverArea.addChild(cover)
      coverArea.addChild(cover2)
      coverArea.addChild(mask)
      coverArea.mask = mask
      tile.addChild(coverArea)

      const label = new Text({
        text: year.title,
        style: {
          fill: 0xffffff,
          fontSize: 24,
          fontWeight: '700',
          fontFamily: 'Segoe UI, sans-serif',
        },
      })
      label.resolution = 2
      label.anchor.set(0.5, 0)
      label.position.set(TILE_W / 2, COVER_H + 12)
      tile.addChild(label)

      const sub = new Text({
        text: `${year.itemCount} herinneringen`,
        style: { fill: 0x8a97b0, fontSize: 13, fontFamily: 'Segoe UI, sans-serif' },
      })
      sub.resolution = 2
      sub.anchor.set(0.5, 0)
      sub.position.set(TILE_W / 2, COVER_H + 40)
      tile.addChild(sub)

      // Toetsenbord-focus-indicator: de EIGEN rand van de tegel licht wit op (op de
      // bg-omtrek, net als de jaar-view/canvas hun eigen rand gebruiken). Standaard
      // onzichtbaar; faadt in op de gefocuste tegel.
      const focusRing = new Graphics()
      focusRing.roundRect(0, 0, TILE_W, TILE_H, 12).stroke({ width: 3, color: 0xffffff })
      focusRing.visible = false
      tile.addChild(focusRing)

      this.root.addChild(tile)

      // Vaste jaar-cover (geprikt) wint altijd: geen slideshow, één vaste foto.
      // Anders: pool voor de slideshow — 'uitgelicht' (val terug op alle foto's) of
      // 'willekeurig' (alle foto's).
      const pinned = year.pinnedCover
      const pool = pinned
        ? []
        : slideshow.mode === 'featured'
          ? year.featuredIds.length
            ? year.featuredIds
            : year.photoIds
          : year.photoIds
      // Basis-cover: de pin, anders bij een actieve slideshow de eerste pool-foto,
      // anders de representatieve cover uit de index.
      const baseId = pinned ?? (this.slideEnabled && pool.length ? pool[0] : year.coverItemId)
      this.tiles.push({
        year,
        worldX,
        cover,
        cover2,
        bg,
        focusRing,
        focusAlpha: 0,
        container: tile,
        scale: 1,
        pool,
        idx: 0,
        curKey: baseId ? `cover-${baseId}` : '',
        pendingKey: '',
        pendingIdx: 0,
        nextAt: 0,
        fade: 0,
        loaded: false,
      })
    })

    engine.world.addChild(this.root)
    this.fitCamera()
  }

  /** Zet de camera zo dat alle jaren in beeld passen. */
  fitCamera(): void {
    const vp = this.engine.viewport()
    const count = Math.max(1, this.tiles.length)
    const totalW = count * TILE_W + (count - 1) * GAP
    const zoom = Math.min(vp.width / (totalW + GAP * 2), vp.height / (TILE_H * 1.6))
    // Midden van het raster: eerste tegel start op x=0, laatste eindigt op totalW.
    this.engine.jumpCamera(totalW / 2, 0, Math.max(this.engine.camera.minZoom, zoom))
  }

  onHover(worldX: number | null, worldY: number): void {
    this.hoveredId = worldX === null ? null : this.hitTest(worldX, worldY)
  }

  // ---- Toetsenbord-navigatie (jaren-rij, L0) ----

  /** Focus het jaar het dichtst bij het scherm-midden (camera-x). Geeft year.id. */
  focusFirst(): string | null {
    if (this.tiles.length === 0) return null
    const cx = this.engine.camera.x
    let best: Tile | null = null
    let bestD = Infinity
    for (const t of this.tiles) {
      const center = t.worldX + TILE_W / 2
      const d = Math.abs(center - cx)
      if (d < bestD) {
        bestD = d
        best = t
      }
    }
    if (!best) return null
    this.kbFocusId = best.year.id
    this.scrollIntoView(best)
    return this.kbFocusId
  }

  /** Verplaats de focus naar het vorige/volgende jaar (links/rechts). De jaren
   * staan in één horizontale rij, dus boven/onder doen niets. Geeft year.id. */
  focusNeighbor(dir: 'left' | 'right' | 'up' | 'down'): string | null {
    if (dir === 'up' || dir === 'down') return this.kbFocusId
    if (!this.kbFocusId) return this.focusFirst()
    // Tegels staan al op oplopende worldX (bouwvolgorde); zoek de huidige index.
    const idx = this.tiles.findIndex((t) => t.year.id === this.kbFocusId)
    if (idx < 0) return this.focusFirst()
    const next = Math.max(0, Math.min(this.tiles.length - 1, idx + (dir === 'left' ? -1 : 1)))
    const t = this.tiles[next]
    this.kbFocusId = t.year.id
    this.scrollIntoView(t)
    return this.kbFocusId
  }

  focusedId(): string | null {
    return this.kbFocusId
  }

  clearKbFocus(): void {
    this.kbFocusId = null
  }

  /** Zet de focus direct op een jaar-id (als het bestaat), zonder camera-beweging.
   * Voor focus-continuïteit bij terugkeer uit een jaar (L1). */
  focusOn(id: string): void {
    if (this.tiles.some((t) => t.year.id === id)) this.kbFocusId = id
  }

  /** Pan de camera horizontaal naar het gefocuste jaar als het buiten een
   * comfort-marge valt; zoom ongemoeid. Meestal passen alle jaren al in beeld →
   * geen beweging. Nult eerst resterende inertie. */
  private scrollIntoView(t: Tile): void {
    const center = t.worldX + TILE_W / 2
    const z = this.engine.camera.zoom
    const b = this.engine.camera.worldBounds(this.engine.viewport())
    const margin = (b.maxX - b.minX) * 0.2
    if (center < b.minX + margin || center > b.maxX - margin) {
      this.engine.syncElastic()
      this.engine.animateCamera(center, 0, z, 820, (p) => 1 - Math.pow(1 - p, 5))
    }
  }

  update(ctx: FrameContext): void {
    const { engine, frame, dtMS } = ctx
    const now = performance.now()
    const dt = Math.min(dtMS, 100)
    const kf = Math.min(1, dtMS / 130)
    for (const tile of this.tiles) {
      // Vloeiende hover-schaal (lerp naar doel).
      const target = tile.year.id === this.hoveredId ? 1.05 : 1
      tile.scale += (target - tile.scale) * 0.2
      tile.container.scale.set(tile.scale)

      // Toetsenbord-focus-ring in-/uitfaden: alleen het gefocuste jaar toont 'm.
      const fTarget = tile.year.id === this.kbFocusId ? 1 : 0
      tile.focusAlpha += (fTarget - tile.focusAlpha) * kf
      tile.focusRing.alpha = tile.focusAlpha
      tile.focusRing.visible = tile.focusAlpha > 0.01

      // Basis-cover laden.
      const baseId = tile.curKey.slice('cover-'.length)
      if (!tile.loaded && baseId) {
        const tex = engine.textures.get(tile.curKey, frame)
        if (tex) {
          tile.cover.texture = tex
          tile.cover.tint = 0xffffff
          fitCover(tile.cover, tex)
          tile.loaded = true
          // Versprongen start zodat niet alle tegels tegelijk wisselen.
          if (tile.nextAt === 0) tile.nextAt = now + this.slideMs * (0.3 + Math.random())
        } else {
          const src = this.backend.thumb(baseId, 256)
          engine.textures.request({ key: tile.curKey, url: src.url, hue: src.hue, size: 256 })
        }
        continue
      }

      // Houd de actieve textures warm (voorkom eviction die de cover zwart maakt).
      if (tile.curKey) engine.textures.get(tile.curKey, frame)
      if (tile.fade > 0 && tile.pendingKey) engine.textures.get(tile.pendingKey, frame)

      // Slideshow: rouleer de cover door de pool (crossfade).
      if (this.slideEnabled && tile.loaded && tile.pool.length > 1) {
        this.tickSlideshow(tile, engine, frame, now, dt)
      }
    }
  }

  /** Eén slideshow-stap: volgende foto voorbereiden en crossfaden; bij voltooien
   * wordt de overlay de nieuwe basis. */
  private tickSlideshow(t: Tile, engine: RenderEngine, frame: number, now: number, dt: number): void {
    if (t.fade > 0) {
      t.fade += dt / 300 // ~0.3s crossfade
      t.cover2.alpha = Math.min(1, t.fade)
      if (t.fade >= 1) {
        t.cover.texture = t.cover2.texture
        t.cover.setSize(t.cover2.width, t.cover2.height)
        t.cover.position.copyFrom(t.cover2.position)
        t.cover2.alpha = 0
        t.idx = t.pendingIdx
        t.curKey = t.pendingKey
        t.pendingKey = ''
        t.fade = 0
        // Versprongen volgende beurt (licht random in tijd).
        t.nextAt = now + this.slideMs * (0.7 + Math.random() * 0.6)
      }
      return
    }
    if (now < t.nextAt) return
    const nextIdx = (t.idx + 1) % t.pool.length
    const key = `cover-${t.pool[nextIdx]}`
    const tex = engine.textures.get(key, frame)
    if (tex) {
      t.cover2.texture = tex
      t.cover2.tint = 0xffffff
      fitCover(t.cover2, tex)
      t.cover2.alpha = 0
      t.pendingIdx = nextIdx
      t.pendingKey = key
      t.fade = 0.001 // start crossfade
    } else {
      const src = this.backend.thumb(t.pool[nextIdx], 256)
      engine.textures.request({ key, url: src.url, hue: src.hue, size: 256 })
    }
  }

  hitTest(worldX: number, worldY: number): string | null {
    for (const tile of this.tiles) {
      if (
        worldX >= tile.worldX &&
        worldX <= tile.worldX + TILE_W &&
        worldY >= -TILE_H / 2 &&
        worldY <= TILE_H / 2
      ) {
        return tile.year.id
      }
    }
    return null
  }

  destroy(): void {
    this.root.destroy({ children: true })
  }
}
