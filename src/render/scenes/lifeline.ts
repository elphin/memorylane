// L0 — Lifeline: alle jaren als tegels naast elkaar, elk met een cover-foto en
// jaartal. Tik (of zoom) op een jaar → naar L1. Bewust simpel: weinig tegels,
// dus geen zware virtualisatie nodig.

import { Container, Graphics, Sprite, Text, Texture } from 'pixi.js'
import type { Backend, YearSummary } from '../../lib/backend'
import type { FrameContext, RenderEngine } from '../core/engine'
import type { Scene } from './scene'

const TILE_W = 320
const TILE_H = 240
const GAP = 80
const COVER_H = TILE_H - 56

interface Tile {
  year: YearSummary
  worldX: number
  cover: Sprite
  bg: Graphics
  container: Container
  scale: number
  key: string
}

export class LifelineScene implements Scene {
  readonly root = new Container()
  private tiles: Tile[] = []
  private hoveredId: string | null = null

  constructor(
    private engine: RenderEngine,
    private backend: Backend,
    years: YearSummary[],
  ) {
    years.forEach((year, i) => {
      const worldX = i * (TILE_W + GAP)
      const tile = new Container()
      // Pivot in het midden zodat hover-schaal netjes vanuit het centrum groeit.
      tile.pivot.set(TILE_W / 2, TILE_H / 2)
      tile.position.set(worldX + TILE_W / 2, 0)

      const bg = new Graphics()
      bg.roundRect(0, 0, TILE_W, TILE_H, 12).fill(0x1a2030).stroke({ width: 2, color: 0x2c3650 })
      tile.addChild(bg)

      // Cover met afgeronde mask; cover-fit (vult het vlak, behoudt aspect).
      const coverArea = new Container()
      coverArea.position.set(8, 8)
      const mask = new Graphics()
      mask.roundRect(0, 0, TILE_W - 16, COVER_H, 8).fill(0xffffff)
      const cover = new Sprite(Texture.WHITE)
      cover.tint = 0x0e1420
      cover.setSize(TILE_W - 16, COVER_H)
      coverArea.addChild(cover)
      coverArea.addChild(mask)
      cover.mask = mask
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

      this.root.addChild(tile)
      this.tiles.push({ year, worldX, cover, bg, container: tile, scale: 1, key: `cover-${year.id}` })
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

  update(ctx: FrameContext): void {
    const { engine, frame } = ctx
    for (const tile of this.tiles) {
      // Vloeiende hover-schaal (lerp naar doel).
      const target = tile.year.id === this.hoveredId ? 1.05 : 1
      tile.scale += (target - tile.scale) * 0.2
      tile.container.scale.set(tile.scale)

      if (!tile.year.coverItemId) continue
      const tex = engine.textures.get(tile.key, frame)
      if (tex) {
        if (tile.cover.texture !== tex) {
          tile.cover.texture = tex
          tile.cover.tint = 0xffffff
          // Cover-fit: vul het vlak met behoud van aspect.
          const s = Math.max((TILE_W - 16) / tex.width, COVER_H / tex.height)
          tile.cover.setSize(tex.width * s, tex.height * s)
          tile.cover.position.set(
            (TILE_W - 16) / 2 - (tex.width * s) / 2,
            COVER_H / 2 - (tex.height * s) / 2,
          )
        }
      } else {
        const src = this.backend.thumb(tile.year.coverItemId, 256)
        engine.textures.request({ key: tile.key, url: src.url, hue: src.hue, size: 256 })
      }
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
