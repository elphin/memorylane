// Synthetische scene voor de fase 4-perf-gate: een raster van N cellen in
// wereldruimte. Elke cel heeft een altijd-zichtbaar LOD-blok en, ingezoomd
// (band ≥ 2), een foto-laag die met alpha = lod.fade over het blok in-faadt —
// een echte twee-lagen crossfade tijdens een bandwissel. Ver uitgezoomd tonen
// cellen alleen hun blok (LOD), wat ook de request-storm voorkomt.

import { Container, Sprite, Texture } from 'pixi.js'
import type { FrameContext, RenderEngine } from '../core/engine'

const GAP = 140
const CELL = 120
const BLOCK_TINT = 0x2a3345

interface Cell {
  block: Sprite
  photo: Sprite | null
  wx: number
  wy: number
  hue: number
  key128: string
  key256: string
}

export class HarnessScene {
  private blockLayer = new Container()
  private photoLayer = new Container()
  private cells: Cell[] = []

  constructor(
    private engine: RenderEngine,
    count: number,
  ) {
    const cols = Math.ceil(Math.sqrt(count))
    for (let i = 0; i < count; i++) {
      const wx = (i % cols) * GAP
      const wy = Math.floor(i / cols) * GAP
      const hue = (i * 47) % 360

      const block = new Sprite(Texture.WHITE)
      block.anchor.set(0.5)
      block.position.set(wx, wy)
      block.setSize(CELL, CELL)
      block.tint = BLOCK_TINT
      this.blockLayer.addChild(block)

      this.cells.push({ block, photo: null, wx, wy, hue, key128: `c${i}-128`, key256: `c${i}-256` })
    }
    engine.world.addChild(this.blockLayer)
    engine.world.addChild(this.photoLayer)

    const mid = (cols * GAP) / 2
    engine.camera.x = mid
    engine.camera.y = mid
    engine.camera.zoom = 0.3

    engine.onFrame = (ctx) => this.update(ctx)
  }

  private update(ctx: FrameContext): void {
    const { engine, frame } = ctx
    const vp = engine.viewport()
    const b = engine.camera.worldBounds(vp)
    const margin = 200 / engine.camera.zoom
    const band = engine.lod.band
    const stream = band >= 2
    const size = band >= 3 ? 256 : 128
    const fade = engine.lod.fade

    for (const c of this.cells) {
      const visible =
        c.wx > b.minX - margin &&
        c.wx < b.maxX + margin &&
        c.wy > b.minY - margin &&
        c.wy < b.maxY + margin
      c.block.visible = visible

      if (!visible || !stream) {
        // Ver uitgezoomd of buiten beeld: alleen het blok (foto verborgen).
        if (c.photo) c.photo.visible = false
        continue
      }

      const key = size === 256 ? c.key256 : c.key128
      const tex = engine.textures.get(key, frame)
      if (tex) {
        if (!c.photo) {
          const p = new Sprite(tex)
          p.anchor.set(0.5)
          p.position.set(c.wx, c.wy)
          p.setSize(CELL, CELL)
          this.photoLayer.addChild(p)
          c.photo = p
        } else if (c.photo.texture !== tex) {
          c.photo.texture = tex
          c.photo.setSize(CELL, CELL)
        }
        c.photo.visible = true
        // Crossfade: foto faadt in over het blok tijdens de bandwissel.
        c.photo.alpha = fade
      } else {
        if (c.photo) c.photo.visible = false
        engine.textures.request({ key, hue: c.hue, size })
      }
    }
  }

  get spriteCount(): number {
    return this.cells.length
  }

  destroy(): void {
    this.engine.onFrame = undefined
    this.blockLayer.destroy({ children: true })
    this.photoLayer.destroy({ children: true })
  }
}
