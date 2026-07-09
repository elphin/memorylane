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
  // Werkelijke afmeting van de huidige inhoud (tekstkaart groeit mee met de
  // tekst) — bepaalt de camera-fit én de hit-test.
  private contentW = FOCUS
  private contentH = FOCUS
  // Laatst gefitte (geklemde) zoom; de app-shell gebruikt dit als referentie voor
  // de "ver uitzoomen = terug"-drempel, zodat stappen naar een grotere sibling
  // (lange notitie) niet meteen als uitzoomen wordt gelezen.
  baseZoom = 1

  constructor(
    private engine: RenderEngine,
    private backend: Backend,
    private items: Item[],
    startIndex: number,
    // Aangeroepen na elke stap (tik óf pijltjestoets) met de richting en het nieuwe
    // item-id, zodat de app-shell de titel kan meelaten lopen.
    private onStep?: (delta: number, currentId: string | null) => void,
  ) {
    this.index = Math.max(0, Math.min(startIndex, items.length - 1))
    this.root.addChild(this.display)
    engine.world.addChild(this.root)
    this.build()
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
      // Tekst eerst opbouwen en meten; de kaart groeit mee met de inhoud (met
      // een ondergrens), zodat lange notities volledig in het kader passen.
      const pad = 48
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
      const cardH = Math.max(CARD_H, Math.ceil(text.height) + pad * 2)
      const bg = new Graphics()
      bg.roundRect(-CARD_W / 2, -cardH / 2, CARD_W, cardH, 16).fill(0xfffdf5).stroke({
        width: 1,
        color: 0xe0dccb,
      })
      this.display.addChild(bg)
      this.display.addChild(text)
      this.contentW = CARD_W
      this.contentH = cardH
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
      this.contentW = FOCUS
      this.contentH = FOCUS
    }

    // Caption onder het item (alleen bij foto's; bij tekst ís de kaart de tekst).
    if (item.caption && !isText) {
      const cap = new Text({
        text: item.caption,
        style: { fill: 0xcfd6e4, fontSize: 18, fontFamily: 'Segoe UI, sans-serif' },
      })
      cap.resolution = 2
      cap.anchor.set(0.5, 0)
      cap.position.set(0, this.contentH / 2 + 20)
      this.display.addChild(cap)
    }

    this.fitCamera()
  }

  private fitCamera(): void {
    const vp = this.engine.viewport()
    const zoom = Math.min(vp.width / (this.contentW + 160), vp.height / (this.contentH + 200))
    this.baseZoom = Math.max(this.engine.camera.minZoom, Math.min(zoom, 2))
    this.engine.jumpCamera(0, 0, this.baseZoom)
  }

  step(delta: number): void {
    if (this.items.length < 2) return
    this.index = (this.index + delta + this.items.length) % this.items.length
    this.build()
    this.onStep?.(delta, this.current?.id ?? null)
  }

  /** Ververs de item-data (na een bewerking) en herbouw het huidige item. */
  refresh(items: Item[]): void {
    if (items.length === 0) return
    this.items = items
    this.index = Math.max(0, Math.min(this.index, items.length - 1))
    this.build()
  }

  private onKey = (e: KeyboardEvent): void => {
    // Niet navigeren terwijl de gebruiker in een invoerveld typt (bewerk-overlay):
    // dan zijn de pijltjes voor de tekstcursor, niet voor vorige/volgende item.
    const el = document.activeElement
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return
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
      // L3 = het detailniveau: laad de scherpe 2048-bron (niet de 1024-thumbnail).
      const src = this.backend.thumb(item.id, 2048)
      engine.textures.request({ key: this.currentKey, url: src.url, hue: src.hue, size: 2048 })
    }
  }

  /** Puur: geeft het id van het gefocuste item terug als het punt binnen de
   * kaart/foto valt, anders null (lege ruimte = de app-shell zoomt uit). De
   * links/rechts-helft-logica (vorige/volgende) zit in de app-shell. */
  hitTest(worldX: number, worldY: number): string | null {
    const item = this.current
    if (!item) return null
    return Math.abs(worldX) <= this.contentW / 2 && Math.abs(worldY) <= this.contentH / 2
      ? item.id
      : null
  }

  currentId(): string | null {
    return this.current?.id ?? null
  }

  destroy(): void {
    window.removeEventListener('keydown', this.onKey)
    this.root.destroy({ children: true })
  }
}
