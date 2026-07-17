// L3 — Focus: één item groot in beeld met alle detail. Navigeer tussen de items
// van het event met pijltjestoetsen of een tik links/rechts; ver uitzoomen gaat
// terug naar het canvas (L2). Foto's contain-fit (hele foto zichtbaar), tekst
// als grote kaart.

import { BlurFilter, Container, Graphics, Sprite, Text, Texture } from 'pixi.js'
import type { Backend, Item } from '../../lib/backend'
import type { FrameContext, RenderEngine } from '../core/engine'
import type { Scene } from './scene'

const FOCUS = 720
const CARD_W = 640
const CARD_H = 440
const PHOTO_BORDER = 16 // witte rand rond de foto (L3)
const SLIDE = 420 // wereld-offset van de slide-transitie tussen items
const SLIDE_DUR = 260 // ms
const FS_DUR = 340 // ms — beeldvullend in/uit animeren (zoom + rand/blur-fade)
const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3)
const easeInOutCubic = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2

export class FocusScene implements Scene {
  readonly root = new Container()
  // Geblurde achtergrond-vulling (alleen in content-beeldvullend): een uitvergrote,
  // vervaagde kopie van de huidige foto/poster die de zwarte balken vult. Achter
  // `display`, zodat de slide-transitie en de video-verberging 'm niet raken.
  private bgBlur = new Sprite(Texture.WHITE)
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
  // Slide+fade tussen items (instelbaar). De uitgaande laag schuift weg + faadt,
  // de nieuwe schuift in vanaf de andere kant.
  private animateSteps = true
  private transition: { outgoing: Container; incoming: Container; delta: number; start: number } | null = null
  // Fullscreen: beeldvullend fitten (geen marges, langste zijde raakt de rand).
  private fullscreen = false
  // Lopende beeldvullend-in/uit-animatie: zoomt de camera + faadt de fotorand uit
  // en de geblurde achtergrond in (of omgekeerd). null = geen animatie.
  private fsAnim: { start: number; toFull: boolean } | null = null
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
    // Blur-achtergrond als EERSTE child (achter alles). Donkere tint voor contrast
    // met de scherpe voorgrond; de blur-filter met ruime padding zodat de vervaging
    // niet hard afkapt aan de sprite-rand.
    this.bgBlur.anchor.set(0.5)
    this.bgBlur.tint = 0x6a6a6a
    this.bgBlur.visible = false
    // Zachtere, ruimere blur (minder "edgy"): sterker + meer passes voor een gladde
    // gaussiaan, en flink padding zodat de vervaging niet hard afkapt aan de
    // sprite-rand. Samen met de ruime overschaal (zie sizeBlurBg) blijft elke harde
    // rand buiten beeld.
    const blur = new BlurFilter({ strength: 64, quality: 7 })
    blur.padding = 160
    this.bgBlur.filters = [blur]
    this.root.addChild(this.bgBlur)
    this.root.addChild(this.display)
    engine.world.addChild(this.root)
    this.build()
    window.addEventListener('keydown', this.onKey)
  }

  private get current(): Item | undefined {
    return this.items[this.index]
  }

  private build(): void {
    this.finishTransition()
    this.display.removeChildren().forEach((c) => c.destroy({ children: true }))
    this.display.position.set(0, 0)
    this.display.alpha = 1
    this.display.visible = true // een vorige video kan 'm verborgen hebben
    this.buildContent(this.display, this.current)
    this.fitCamera()
  }

  /** Bouwt de visuele inhoud van `item` in `container` en zet de scene-brede
   * verwijzingen (sprite/frame/caption) + afmetingen op dat item. */
  private buildContent(container: Container, item: Item | undefined): void {
    this.sprite = null
    this.frame = null
    this.caption = null
    this.loaded = false
    this.videoAspect = null
    this.currentKey = ''
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
      container.addChild(bg)
      container.addChild(text)
      this.contentW = CARD_W
      this.contentH = cardH
      this.dispW = CARD_W
      this.dispH = cardH
    } else {
      // Witte fotorand die zich straks (na load) om de werkelijke foto vouwt. In
      // content-beeldvullend laten we 'm weg: dan vult de foto tot de rand en zouden
      // alleen de zijranden zichtbaar zijn (tegen de geblurde achtergrond = lelijk).
      const frame = new Graphics()
      frame.visible = !this.fullscreen
      container.addChild(frame)
      this.frame = frame
      const sprite = new Sprite(Texture.WHITE)
      sprite.anchor.set(0.5)
      sprite.setSize(FOCUS, FOCUS)
      sprite.tint = 0x1a1f2b
      container.addChild(sprite)
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
      container.addChild(cap)
      this.caption = cap
    }
  }

  /** Aan/uit voor de slide+fade-transitie tussen items (instelling). */
  setAnimateSteps(on: boolean): void {
    this.animateSteps = on
  }

  stepping(): boolean {
    return this.transition !== null
  }

  /** Rondt een lopende transitie meteen af (uitgaande laag weg, nieuwe op z'n plek). */
  private finishTransition(): void {
    const tr = this.transition
    if (!tr) return
    this.transition = null
    if (!tr.outgoing.destroyed) tr.outgoing.destroy({ children: true })
    if (!tr.incoming.destroyed) {
      tr.incoming.position.set(0, 0)
      tr.incoming.alpha = 1
    }
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

  /** De doel-zoom voor een gegeven modus (beeldvullend of normaal). */
  private baseZoomFor(fullscreen: boolean): number {
    const vp = this.engine.viewport()
    if (fullscreen) {
      // Beeldvullend: fit op de WERKELIJKE inhoud (foto/videokader), geen marges,
      // geen zoom-plafond — de langste zijde raakt de schermrand.
      const { w, h } = this.fitSize()
      return Math.max(this.engine.camera.minZoom, Math.min(vp.width / w, vp.height / h))
    }
    const zoom = Math.min(vp.width / (this.contentW + 160), vp.height / (this.contentH + 200))
    return Math.max(this.engine.camera.minZoom, Math.min(zoom, 2))
  }

  private fitCamera(): void {
    this.baseZoom = this.baseZoomFor(this.fullscreen)
    this.engine.jumpCamera(0, 0, this.baseZoom)
    this.refreshBlurBg()
  }

  /** Kan er een geblurde achtergrond getoond worden (foto/video met echte textuur)? */
  private canShowBlur(): boolean {
    return this.sprite !== null && this.loaded && this.sprite.texture !== Texture.WHITE
  }

  /** Schaal de geblurde kopie zó dat 'ie de hele viewport dekt bij zoom `z` (default
   * de huidige camera-zoom), ruim overschaald zodat de zachte blur-rand ver buiten
   * beeld valt. Bij de in/uit-animatie geven we bewust de KLEINSTE zoom (grootste
   * wereld) mee, zodat één schaal de hele animatie dekt (geen per-frame herschaal). */
  private sizeBlurBg(zoom?: number): void {
    if (!this.canShowBlur() || this.sprite === null) return
    const tex = this.sprite.texture
    this.bgBlur.texture = tex
    const vp = this.engine.viewport()
    const z = (zoom ?? this.engine.camera.zoom) || 1
    const worldW = vp.width / z
    const worldH = vp.height / z
    const OVER = 2.0 // overschaal-marge: zachte blur-rand blijft ruim buiten beeld
    const cover = Math.max((worldW * OVER) / tex.width, (worldH * OVER) / tex.height)
    this.bgBlur.width = tex.width * cover
    this.bgBlur.height = tex.height * cover
    this.bgBlur.position.set(0, 0)
  }

  /** Zet de blur-achtergrond in de RUST-stand (geen animatie): zichtbaar+vol in
   * beeldvullend, anders verborgen. Tekst-items tonen geen bg. */
  private refreshBlurBg(): void {
    const show = this.fullscreen && this.canShowBlur()
    this.bgBlur.visible = show
    this.bgBlur.alpha = 1
    if (show) this.sizeBlurBg()
  }

  /** Werkelijk weergegeven inhoudsmaat (foto = tw×th; video = kader op ware
   * verhouding; tekst = kaart) — voor de beeldvullende fullscreen-fit. */
  private fitSize(): { w: number; h: number } {
    const item = this.current
    if (item?.itemType === 'video' && this.videoAspect) {
      return this.videoAspect >= 1
        ? { w: FOCUS, h: FOCUS / this.videoAspect }
        : { w: FOCUS * this.videoAspect, h: FOCUS }
    }
    return { w: this.dispW, h: this.dispH }
  }

  /** Zet beeldvullende fullscreen-fit aan/uit — geanimeerd: de camera zoomt naar de
   * nieuwe fit terwijl de witte fotorand uit-/infaadt en de geblurde achtergrond
   * in-/uitfaadt. De frame-lus (update) drijft de fades; de camera-tween loopt via
   * de engine. */
  setFullscreen(on: boolean): void {
    this.fullscreen = on
    const target = this.baseZoomFor(on)
    this.baseZoom = target
    // Blur-achtergrond alvast klaarzetten: één keer schalen voor de KLEINSTE zoom
    // (grootste wereld) die de animatie aandoet, zodat 'ie de hele overgang dekt
    // zonder per frame de (dure) blur te herberekenen. Alpha/zichtbaarheid regelt de
    // animatie-lus. Alleen zinvol met een echte foto/video-textuur.
    if (this.canShowBlur()) {
      this.bgBlur.visible = true
      this.sizeBlurBg(Math.min(this.engine.camera.zoom, target))
    }
    if (this.frame) this.frame.visible = true // tijdens de fade zichtbaar houden
    this.fsAnim = { start: performance.now(), toFull: on }
    this.engine.animateCamera(0, 0, target, FS_DUR, easeInOutCubic)
  }

  step(delta: number): void {
    if (this.items.length < 2) return
    // Een lopende beeldvullend-animatie afbreken: stappen doet zelf een verse fit
    // (jumpCamera) + rust-stand, dus de fade-lus moet niet nog nasnappen.
    this.fsAnim = null
    this.index = (this.index + delta + this.items.length) % this.items.length
    if (!this.animateSteps) {
      this.build()
      this.onStep?.(delta, this.current?.id ?? null)
      return
    }
    // Slide+fade: de huidige laag wordt de uitgaande, een nieuwe komt binnen vanaf
    // de tegenovergestelde kant. (De DOM-video-overlay is tijdens `stepping()` uit,
    // zodat ook video-posters netjes meeschuiven.)
    this.finishTransition()
    const outgoing = this.display
    outgoing.visible = true
    const incoming = new Container()
    this.root.addChild(incoming)
    this.buildContent(incoming, this.current)
    incoming.position.set(delta * SLIDE, 0)
    incoming.alpha = 0
    this.display = incoming
    this.transition = { outgoing, incoming, delta, start: performance.now() }
    this.fitCamera()
    this.onStep?.(delta, this.current?.id ?? null)
  }

  /** Herfit de camera op het huidige item (na een viewport-wijziging, bv. bij app-
   * fullscreen of venster-resize), zodat het item het scherm blijft vullen. Niet
   * tijdens een lopende beeldvullend-animatie: die verzorgt zijn eigen fit en zou
   * anders hard gesnapt worden. */
  refitToViewport(): void {
    if (this.fsAnim) return
    this.fitCamera()
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

    // Slide+fade-transitie voortzetten.
    if (this.transition) {
      const tr = this.transition
      const t = Math.min(1, (performance.now() - tr.start) / SLIDE_DUR)
      const e = easeOutCubic(t)
      tr.outgoing.position.x = -tr.delta * SLIDE * e
      tr.outgoing.alpha = 1 - e
      tr.incoming.position.x = tr.delta * SLIDE * (1 - e)
      tr.incoming.alpha = e
      if (t >= 1) this.finishTransition()
    }

    // Beeldvullend in/uit: de camera-zoom loopt als tween via de engine; hier faden
    // we de witte fotorand uit en de geblurde achtergrond in (of omgekeerd) met
    // dezelfde easing. De blur is al één keer geschaald (zie setFullscreen) en
    // schaalt in wereldruimte mee met de camera → geen per-frame herberekening.
    if (this.fsAnim) {
      const t = Math.min(1, (performance.now() - this.fsAnim.start) / FS_DUR)
      if (t < 1 && !this.engine.isAnimatingCamera) {
        // De camera-tween is vroegtijdig weg (gebruiker zoomt/pant, of een step/
        // resize deed een harde fit): stop de fade in de rust-stand ZONDER de camera
        // terug te snappen — anders zou het de handmatige zoom overschrijven.
        this.fsAnim = null
        if (this.frame) {
          this.frame.alpha = 1
          this.frame.visible = !this.fullscreen
        }
        this.refreshBlurBg()
      } else {
        const eased = easeInOutCubic(t)
        const full = this.fsAnim.toFull ? eased : 1 - eased // 0 = normaal, 1 = beeldvullend
        if (this.frame) this.frame.alpha = 1 - full
        this.bgBlur.visible = this.canShowBlur()
        this.bgBlur.alpha = full
        if (t >= 1) {
          this.fsAnim = null
          // Rust-stand vastzetten + eventueel nagekomen textuur-maat corrigeren
          // (foto die net tíjdens de animatie inlaadde) met een exacte snap.
          this.baseZoom = this.baseZoomFor(this.fullscreen)
          this.engine.jumpCamera(0, 0, this.baseZoom)
          if (this.frame) {
            this.frame.alpha = 1
            this.frame.visible = !this.fullscreen
          }
          this.refreshBlurBg()
        }
      }
    }

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
      // Nu de echte foto-maat bekend is → beeldvullend opnieuw fitten. Niet tijdens
      // een lopende beeldvullend-animatie (die snapt aan het eind zelf de juiste
      // maat); anders zou jumpCamera de tween hard onderbreken.
      if (this.fullscreen && !this.fsAnim) this.fitCamera()
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
    // Beeldvullend op de ware verhouding — maar niet snappen tijdens de in/uit-
    // animatie (die corrigeert de maat zelf aan het eind).
    if (this.fullscreen && !this.fsAnim) this.fitCamera()
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
