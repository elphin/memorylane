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
const PHOTO_BORDER = 16 // witte rand rond de foto (L3)

export class FocusScene implements Scene {
  readonly root = new Container()
  private display = new Container()
  private index: number
  private sprite: Sprite | null = null
  private frame: Graphics | null = null // witte fotorand (past zich aan de foto aan)
  private caption: Text | null = null // caption onder de foto (herpositioneert na load)
  private currentKey = ''
  private loaded = false
  // Werkelijke afmeting van de huidige inhoud (tekstkaart groeit mee met de
  // tekst) — bepaalt de camera-fit én de hit-test.
  private contentW = FOCUS
  private contentH = FOCUS
  // Werkelijk WEERGEGEVEN afmeting (foto na contain-fit = tw×th; tekst = kaart).
  // Voor de DOM-video-overlay die exact over de video moet liggen.
  private dispW = FOCUS
  private dispH = FOCUS
  // Werkelijke video-verhouding (b/h), pas bekend na loadedmetadata — de overlay
  // wordt daarmee exact op de video gelegd (geen zwarte klikbare randen).
  private videoAspect: number | null = null
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
    this.frame = null
    this.caption = null
    this.loaded = false
    this.videoAspect = null
    this.display.visible = true // een vorige video kan 'm verborgen hebben
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
      this.dispW = CARD_W
      this.dispH = cardH
    } else {
      // Witte fotorand die zich straks (na load) om de werkelijke foto vouwt.
      const frame = new Graphics()
      this.display.addChild(frame)
      this.frame = frame
      const sprite = new Sprite(Texture.WHITE)
      sprite.anchor.set(0.5)
      sprite.setSize(FOCUS, FOCUS)
      sprite.tint = 0x1a1f2b
      this.display.addChild(sprite)
      this.sprite = sprite
      this.currentKey = `focus-${item.id}`
      this.contentW = FOCUS
      this.contentH = FOCUS
      this.dispW = FOCUS
      this.dispH = FOCUS
      this.drawPhotoFrame(FOCUS, FOCUS)
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
      this.caption = cap
    }

    this.fitCamera()
  }

  /** Teken de witte fotorand rond een foto van `w`×`h` (past zich aan de werkelijke
   * fotoverhouding aan; net als de tegels in de jaar-view). */
  private drawPhotoFrame(w: number, h: number): void {
    if (!this.frame) return
    this.frame.clear()
    this.frame
      .roundRect(-w / 2 - PHOTO_BORDER, -h / 2 - PHOTO_BORDER, w + PHOTO_BORDER * 2, h + PHOTO_BORDER * 2, 8)
      .fill(0xf5f5f0)
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
    // Ook een gefocuste <video> overslaan: dan zijn de pijltjes voor spoelen (de
    // chevrons/klik doen de sibling-navigatie), niet voor vorige/volgende item.
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'VIDEO')) return
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
      // Contain-fit: de hele foto zichtbaar; de witte rand vouwt zich om de
      // werkelijke afmetingen, en de caption schuift onder de foto.
      const s = Math.min(FOCUS / tex.width, FOCUS / tex.height)
      const tw = tex.width * s
      const th = tex.height * s
      this.sprite.setSize(tw, th)
      this.dispW = tw
      this.dispH = th
      this.drawPhotoFrame(tw, th)
      if (this.caption) this.caption.position.set(0, th / 2 + PHOTO_BORDER + 18)
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

  /** Het huidige item (voor de app-shell: type-detectie t.b.v. de video-overlay). */
  currentItem(): Item | null {
    return this.current ?? null
  }

  /** Zet de werkelijke video-verhouding (b/h) zodat de overlay-rect exact op de
   * video valt (geen zwarte randen). Null = terug naar de thumbnail-maat. */
  setVideoAspect(aspect: number | null): void {
    this.videoAspect = aspect && Number.isFinite(aspect) && aspect > 0 ? aspect : null
  }

  /** Verberg/toon de Pixi-inhoud (poster+kader) — aan tijdens DOM-video-afspelen,
   * zodat een afwijkend-geroteerde thumbnail niet naast de video piept. */
  setContentHidden(hidden: boolean): void {
    this.display.visible = !hidden
  }

  /** CSS-schermrechthoek van het weergegeven item (of null). Alleen betrouwbaar
   * als er GEEN transitie loopt (de reveal transformeert de root los van de
   * camera; dan klopt worldToScreen niet). De app-shell gebruikt dit om de
   * DOM-video exact over de video te leggen. */
  screenRect(): { left: number; top: number; width: number; height: number } | null {
    const item = this.current
    if (!item) return null
    let w = this.dispW
    let h = this.dispH
    // Video: gebruik de échte verhouding (contain-fit in het FOCUS-vlak) i.p.v. de
    // thumbnail-maat, zodat de overlay exact op de video valt.
    if (item.itemType === 'video' && this.videoAspect) {
      if (this.videoAspect >= 1) {
        w = FOCUS
        h = FOCUS / this.videoAspect
      } else {
        h = FOCUS
        w = FOCUS * this.videoAspect
      }
    }
    const vp = this.engine.viewport()
    const cam = this.engine.camera
    const tl = cam.worldToScreen(-w / 2, -h / 2, vp)
    const br = cam.worldToScreen(w / 2, h / 2, vp)
    return { left: tl.x, top: tl.y, width: br.x - tl.x, height: br.y - tl.y }
  }

  destroy(): void {
    window.removeEventListener('keydown', this.onKey)
    this.root.destroy({ children: true })
  }
}
