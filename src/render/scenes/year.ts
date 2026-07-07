// L1 — Jaar: de foto's van één jaar als "levend plakboek"-collage. Grid met
// lichte, deterministische jitter en rotatie voor de scrapbook-look. Streamt
// thumbnails via de texture-pipeline; cullt buiten beeld.

import { Container, Graphics, Sprite, Texture } from 'pixi.js'
import type { Backend, YearPhoto } from '../../lib/backend'
import type { FrameContext, RenderEngine } from '../core/engine'
import type { Scene } from './scene'

const CELL = 230
const PHOTO = 190
const BORDER = 8

interface Photo {
  itemId: string
  eventId: string
  worldX: number
  worldY: number
  container: Container
  sprite: Sprite
  key: string
  loaded: boolean
}

/** Deterministische pseudo-random uit een string (voor stabiele jitter). */
function hash01(s: string, salt: number): number {
  let h = salt
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0x7fffffff
  return (h % 1000) / 1000
}

export class YearScene implements Scene {
  private root = new Container()
  private photos: Photo[] = []

  constructor(
    private engine: RenderEngine,
    private backend: Backend,
    photos: YearPhoto[],
  ) {
    const cols = Math.max(1, Math.ceil(Math.sqrt(photos.length)))

    photos.forEach((photo, i) => {
      const col = i % cols
      const row = Math.floor(i / cols)
      const jitterX = (hash01(photo.itemId, 7) - 0.5) * 40
      const jitterY = (hash01(photo.itemId, 13) - 0.5) * 40
      const worldX = col * CELL + jitterX
      const worldY = row * CELL + jitterY

      const container = new Container()
      container.position.set(worldX, worldY)
      container.rotation = (hash01(photo.itemId, 3) - 0.5) * 0.14 // ±0.07 rad

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

      this.root.addChild(container)
      this.photos.push({
        itemId: photo.itemId,
        eventId: photo.eventId,
        worldX,
        worldY,
        container,
        sprite,
        key: `item-${photo.itemId}`,
        loaded: false,
      })
    })

    engine.world.addChild(this.root)
    this.fitCamera(cols, Math.max(1, Math.ceil(photos.length / cols)))
  }

  private fitCamera(cols: number, rows: number): void {
    const vp = this.engine.viewport()
    const w = cols * CELL
    const h = rows * CELL
    this.engine.camera.x = w / 2 - CELL / 2
    this.engine.camera.y = h / 2 - CELL / 2
    const zoom = Math.min(vp.width / (w + CELL), vp.height / (h + CELL))
    this.engine.camera.zoom = Math.max(this.engine.camera.minZoom, Math.min(zoom, 1))
  }

  update(ctx: FrameContext): void {
    const { engine, frame } = ctx
    const vp = engine.viewport()
    const b = engine.camera.worldBounds(vp)
    const margin = CELL

    for (const p of this.photos) {
      const visible =
        p.worldX > b.minX - margin &&
        p.worldX < b.maxX + margin &&
        p.worldY > b.minY - margin &&
        p.worldY < b.maxY + margin
      p.container.visible = visible
      if (!visible) continue

      const tex = engine.textures.get(p.key, frame)
      if (tex) {
        if (!p.loaded) {
          p.sprite.texture = tex
          p.sprite.tint = 0xffffff
          const s = Math.max(PHOTO / tex.width, PHOTO / tex.height)
          p.sprite.setSize(tex.width * s, tex.height * s)
          p.loaded = true
        }
      } else {
        const src = this.backend.thumb(p.itemId, 256)
        engine.textures.request({ key: p.key, url: src.url, hue: src.hue, size: 256 })
      }
    }
  }

  hitTest(worldX: number, worldY: number): string | null {
    // Van voor naar achter (laatste getekend = bovenop).
    for (let i = this.photos.length - 1; i >= 0; i--) {
      const p = this.photos[i]
      if (
        worldX >= p.worldX - PHOTO / 2 &&
        worldX <= p.worldX + PHOTO / 2 &&
        worldY >= p.worldY - PHOTO / 2 &&
        worldY <= p.worldY + PHOTO / 2
      ) {
        // Tik op een foto → naar het canvas van de gebeurtenis (L2).
        return p.eventId
      }
    }
    return null
  }

  destroy(): void {
    this.root.destroy({ children: true })
  }
}
