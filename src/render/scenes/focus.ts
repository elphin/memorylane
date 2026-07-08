// L3 — Focus: één item groot in beeld met alle detail. Navigeer tussen de items
// van het event met pijltjestoetsen of een tik links/rechts; ver uitzoomen gaat
// terug naar het canvas (L2). Foto's contain-fit (hele foto zichtbaar), tekst
// als grote kaart.

import { Container, Graphics, Sprite, Text, Texture } from 'pixi.js'
import type { Backend, Item } from '../../lib/backend'
import type { FrameContext, RenderEngine } from '../core/engine'
import type { Scene } from './scene'

const FOCUS = 720
const CARD_W = 640
const CARD_H = 440

export class FocusScene implements Scene {
  readonly root = new Container()
  private display = new Container()
  private index: number
  private sprite: Sprite | null = null
  private currentKey = ''
  private loaded = false

  constructor(
    private engine: RenderEngine,
    private backend: Backend,
    private items: Item[],
    startIndex: number,
  ) {
    this.index = Math.max(0, Math.min(startIndex, items.length - 1))
    this.root.addChild(this.display)
    engine.world.addChild(this.root)
    this.build()
    this.fitCamera()
    window.addEventListener('keydown', this.onKey)
  }

  private get current(): Item | undefined {
    return this.items[this.index]
  }

  private build(): void {
    this.display.removeChildren().forEach((c) => c.destroy({ children: true }))
    this.sprite = null
    this.loaded = false
    const item = this.current
    if (!item) return

    const isText = item.itemType === 'text' || item.itemType === 'link'
    if (isText) {
      const bg = new Graphics()
      bg.roundRect(-CARD_W / 2, -CARD_H / 2, CARD_W, CARD_H, 16).fill(0xfffdf5).stroke({
        width: 1,
        color: 0xe0dccb,
      })
      this.display.addChild(bg)
      const text = new Text({
        text: item.bodyText || item.caption || '…',
        style: {
          fill: 0x2b2b2b,
          fontSize: 26,
          fontStyle: 'italic',
          fontFamily: 'Georgia, serif',
          wordWrap: true,
          wordWrapWidth: CARD_W - 64,
          align: 'center',
          lineHeight: 36,
        },
      })
      text.resolution = 2
      text.anchor.set(0.5)
      this.display.addChild(text)
    } else {
      const bg = new Graphics()
      bg.roundRect(-FOCUS / 2 - 6, -FOCUS / 2 - 6, FOCUS + 12, FOCUS + 12, 6).fill(0x000000)
      this.display.addChild(bg)
      const sprite = new Sprite(Texture.WHITE)
      sprite.anchor.set(0.5)
      sprite.setSize(FOCUS, FOCUS)
      sprite.tint = 0x1a1f2b
      this.display.addChild(sprite)
      this.sprite = sprite
      this.currentKey = `focus-${item.id}`
    }

    // Caption onder het item.
    if (item.caption) {
      const cap = new Text({
        text: item.caption,
        style: { fill: 0xcfd6e4, fontSize: 18, fontFamily: 'Segoe UI, sans-serif' },
      })
      cap.resolution = 2
      cap.anchor.set(0.5, 0)
      cap.position.set(0, FOCUS / 2 + 20)
      this.display.addChild(cap)
    }
  }

  private fitCamera(): void {
    const vp = this.engine.viewport()
    const zoom = Math.min(vp.width / (FOCUS + 160), vp.height / (FOCUS + 200))
    this.engine.jumpCamera(0, 0, Math.max(this.engine.camera.minZoom, Math.min(zoom, 2)))
  }

  step(delta: number): void {
    if (this.items.length < 2) return
    this.index = (this.index + delta + this.items.length) % this.items.length
    this.build()
  }

  private onKey = (e: KeyboardEvent): void => {
    if (e.key === 'ArrowLeft') this.step(-1)
    else if (e.key === 'ArrowRight') this.step(1)
  }

  update(ctx: FrameContext): void {
    const { engine, frame } = ctx
    const item = this.current
    if (!this.sprite || this.loaded || !item || !item.media) return
    const tex = engine.textures.get(this.currentKey, frame)
    if (tex) {
      this.sprite.texture = tex
      this.sprite.tint = 0xffffff
      // Contain-fit: de hele foto zichtbaar.
      const s = Math.min(FOCUS / tex.width, FOCUS / tex.height)
      this.sprite.setSize(tex.width * s, tex.height * s)
      this.loaded = true
    } else {
      const src = this.backend.thumb(item.id, 1024)
      engine.textures.request({ key: this.currentKey, url: src.url, hue: src.hue, size: 1024 })
    }
  }

  /** Puur: geeft het id van het gefocuste item terug als het punt binnen de
   * kaart/foto valt, anders null (lege ruimte = de app-shell zoomt uit). De
   * links/rechts-helft-logica (vorige/volgende) zit in de app-shell. */
  hitTest(worldX: number, worldY: number): string | null {
    const item = this.current
    if (!item) return null
    const isText = item.itemType === 'text' || item.itemType === 'link'
    const halfW = isText ? CARD_W / 2 : FOCUS / 2
    const halfH = isText ? CARD_H / 2 : FOCUS / 2
    return Math.abs(worldX) <= halfW && Math.abs(worldY) <= halfH ? item.id : null
  }

  currentId(): string | null {
    return this.current?.id ?? null
  }

  destroy(): void {
    window.removeEventListener('keydown', this.onKey)
    this.root.destroy({ children: true })
  }
}
