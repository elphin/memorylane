// Render-engine: bindt PixiJS, camera, gestures, texture-pipeline en LOD samen.
// Draait ticker-driven buiten React-state. De `world`-container krijgt elke
// frame de camera-transform; scenes haken in via `onFrame`.

import { Application, Container, Ticker, UPDATE_PRIORITY } from 'pixi.js'
import { CLASSIC_DARK } from '../../theme/tokens'
import { Camera, type Viewport } from './camera'
import { GestureController, type DragHandle, type DragMods } from './gestures'
import { LodManager } from './lod'
import { TextureManager } from './textures'

export interface FrameContext {
  engine: RenderEngine
  frame: number
  dtMS: number
}

export class RenderEngine {
  readonly app = new Application()
  readonly world = new Container()
  // Laag bóven de wereld voor het uitgaande niveau tijdens een transitie: het
  // blijft in beeld (bevroren op zijn laatste scherm-transform) en animeert in
  // schermruimte mee (zoomt door + faadt uit) terwijl het nieuwe niveau eronder
  // eruit groeit → crossfade i.p.v. harde swap.
  readonly overlay = new Container()
  readonly camera = new Camera()
  readonly textures = new TextureManager()
  readonly lod = new LodManager()
  gestures!: GestureController

  /** Scene-hook, elke frame ná de camera-transform. */
  onFrame?: (ctx: FrameContext) => void

  /** Tap-hook met wereldcoördinaten (voor hit-testing van tegels). */
  onTap?: (worldX: number, worldY: number) => void

  /** Sleep-hook: geeft een handle terug als er een object onder het wereldpunt
   * ligt (dan sleept dat i.p.v. de camera). `mods` = toets-modifiers bij pointerdown. */
  beginDrag?: (worldX: number, worldY: number, mods: DragMods) => DragHandle | null

  /** Hover-hook: wereldpunt onder de muis (of null bij verlaten). */
  onHover?: (worldX: number | null, worldY: number) => void

  /** Rechtermuisklik-hook (contextmenu) — bijv. een niveau terug. */
  onSecondary?: () => void

  private frame = 0
  private initialized = false
  private destroyed = false

  // Vloeiende camera-animatie tussen niveaus (tweent x/y + exponentieel zoom).
  private camAnim: {
    fromX: number
    fromY: number
    fromZoom: number
    toX: number
    toY: number
    toZoom: number
    start: number
    dur: number
    ease?: (t: number) => number
  } | null = null
  // Reveal-animatie van nieuwe scene-inhoud: inzoomen = groeien uit het
  // aangeklikte punt, uitzoomen = krimpen naar het midden.
  private reveal: {
    root: Container
    fromScale: number
    fromX: number
    fromY: number
    toX: number
    toY: number
    start: number
    dur: number
    slide?: boolean
  } | null = null
  // Exit-animatie van het uitgaande niveau (leeft in `overlay`, in schermruimte).
  // `onDone` ruimt de oude scene op zodra de animatie klaar is (of afgebroken).
  private exitAnim: {
    onDone: () => void
    fromScale: number
    fromX: number
    fromY: number
    toScale: number
    toX: number
    toY: number
    start: number
    dur: number
    slide?: boolean
  } | null = null
  private lastTapScreen = { x: 0, y: 0 }

  async init(container: HTMLElement): Promise<void> {
    if (this.destroyed) return
    await this.app.init({
      resizeTo: container,
      // Foto-sprites zijn axis-aligned quads; MSAA kost frame-tijd zonder
      // zichtbare winst. Uit = flink sneller.
      antialias: false,
      background: CLASSIC_DARK.colors.appBg,
      preference: 'webgl',
      powerPreference: 'high-performance',
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
    })
    // Tijdens de async init kan er al gedestroyed zijn (StrictMode remount).
    if (this.destroyed) {
      this.app.destroy(true)
      return
    }
    container.appendChild(this.app.canvas)
    this.app.stage.addChild(this.world)
    this.app.stage.addChild(this.overlay)

    this.gestures = new GestureController(
      this.app.canvas as HTMLCanvasElement,
      this.camera,
      () => this.viewport(),
      // Een gebruikersgebaar onderbreekt een lopende camera-animatie én rondt
      // een lopende reveal direct af (naar identiteit), zodat pan/zoom tijdens
      // de reveal een schone overdracht geeft i.p.v. een doorlopende transform.
      () => {
        this.camAnim = null
        this.finishReveal()
        this.finishExit()
      },
      (sx, sy) => {
        this.lastTapScreen = { x: sx, y: sy }
        const w = this.camera.screenToWorld(sx, sy, this.viewport())
        this.onTap?.(w.x, w.y)
      },
      // Geen nieuwe sleep starten tijdens een niveau-transitie: het oude niveau
      // leeft dan nog ~380ms in de overlay met een actieve beginDrag-hook, maar
      // is visueel al weg — anders zou je onzichtbare items kunnen grijpen.
      (wx, wy, mods) => (this.isTransitioning ? null : (this.beginDrag?.(wx, wy, mods) ?? null)),
      (sx, sy) => {
        if (sx === null) {
          this.onHover?.(null, 0)
          return
        }
        const w = this.camera.screenToWorld(sx, sy, this.viewport())
        this.onHover?.(w.x, w.y)
      },
      // Thunk (niet de rauwe callback) zodat een ná-init gezette engine.onSecondary
      // zichtbaar is — net als onTap/onHover hierboven.
      () => this.onSecondary?.(),
    )

    this.app.ticker.add(this.tick, undefined, UPDATE_PRIORITY.HIGH)
    this.initialized = true
  }

  /** Zet de muiscursor op de canvas (bijv. 'pointer' boven een klikbaar object,
   * '' voor de standaard). Veilig als de app nog niet/niet meer bestaat. */
  setCursor(style: string): void {
    const canvas = this.app?.canvas as HTMLCanvasElement | undefined
    if (canvas) canvas.style.cursor = style
  }

  /** Logische viewport-grootte (CSS-pixels), gelijk aan de gesture-coördinaten. */
  viewport(): Viewport {
    return { width: this.app.screen.width, height: this.app.screen.height }
  }

  get frameNumber(): number {
    return this.frame
  }

  /** True zolang een niveau-transitie-animatie loopt. */
  get isAnimatingCamera(): boolean {
    return this.camAnim !== null
  }

  /** Stopt een lopende soepele wheel-zoom (bijv. wanneer de zoom-uit-drempel een
   * niveau-terug triggert, zodat de zoom niet doorschiet in de transitie). */
  endZoom(): void {
    this.gestures?.endZoom()
  }

  /** True zolang een scene-reveal loopt. */
  get isRevealing(): boolean {
    return this.reveal !== null
  }

  /** True zolang er een niveau-transitie loopt (reveal in óf exit uit). */
  get isTransitioning(): boolean {
    return this.reveal !== null || this.exitAnim !== null
  }

  /** Doelzoom van de lopende animatie (of de huidige zoom als er geen loopt). */
  get pendingZoom(): number {
    return this.camAnim?.toZoom ?? this.camera.zoom
  }

  /** Laatste tap-positie (schermcoördinaten) — reveal-focus bij inzoomen. */
  get tapScreen(): { x: number; y: number } {
    return this.lastTapScreen
  }

  /** Zet de camera direct op een doel (de reveal verzorgt de beweging). */
  jumpCamera(x: number, y: number, zoom: number): void {
    this.camAnim = null
    this.gestures?.endZoom() // een harde jump (niveau-wissel/fit) stopt een lopende zoom
    this.camera.x = x
    this.camera.y = y
    this.camera.zoom = zoom
  }

  /** Onthult een nieuwe scene: mode `in` = groeien uit `(sx,sy)`, mode `out` =
   * krimpen vanuit het schermmidden. Transformeert de scene-root los van de
   * camera, zodat de transitie altijd vanuit het logische punt komt. */
  revealScene(root: Container, mode: 'in' | 'out', sx?: number, sy?: number, dur = 380): void {
    const cx = this.camera.x
    const cy = this.camera.y
    root.pivot.set(cx, cy)
    let fromScale: number
    let fromX: number
    let fromY: number
    if (mode === 'in') {
      const vp = this.viewport()
      const fw = this.camera.screenToWorld(sx ?? vp.width / 2, sy ?? vp.height / 2, vp)
      fromScale = 0.12
      fromX = fw.x
      fromY = fw.y
    } else {
      fromScale = 1.7
      fromX = cx
      fromY = cy
    }
    root.scale.set(fromScale)
    root.position.set(fromX, fromY)
    root.alpha = 0
    this.reveal = { root, fromScale, fromX, fromY, toX: cx, toY: cy, start: performance.now(), dur }
  }

  /** Laat het uitgaande niveau meebewegen tijdens een transitie: het wordt naar
   * de `overlay` verplaatst (bevroren op zijn huidige scherm-transform) en zoomt
   * in schermruimte door + faadt uit. Mode `in` = door het aangeklikte punt naar
   * voren (alsof je erdoorheen duikt), `out` = terug naar achteren via het
   * midden. `onDone` vernietigt de oude scene zodra klaar/afgebroken. Met
   * `centered` gaat óók de `in`-modus door het schermmidden i.p.v. het
   * aangeklikte punt (voor een symmetrische centrale zoom, bv. jaar-entry). */
  exitScene(oldRoot: Container, mode: 'in' | 'out', onDone: () => void, dur = 380, centered = false): void {
    // Een lopende exit eerst netjes afronden (snelle dubbele navigatie).
    if (this.exitAnim) this.finishExit()
    // Als deze root nog midden in zijn eigen reveal zat, die eerst op identiteit
    // zetten — anders vechten reveal en exit om dezelfde transform.
    if (this.reveal?.root === oldRoot) this.finishReveal()
    if (oldRoot.destroyed) {
      onDone()
      return
    }
    // Bevries de overlay op de huidige scherm-transform van de wereld, zodat het
    // oude niveau exact op zijn plek blijft staan op het moment van overzetten.
    const vp = this.viewport()
    const z = this.camera.zoom
    const fromScale = z
    const fromX = vp.width / 2 - this.camera.x * z
    const fromY = vp.height / 2 - this.camera.y * z
    this.overlay.addChild(oldRoot)
    this.overlay.pivot.set(0, 0)
    this.overlay.scale.set(fromScale)
    this.overlay.position.set(fromX, fromY)
    this.overlay.alpha = 1

    // Zoom-naar-punt in schermruimte: bij `in` groeit het door het klikpunt weg,
    // bij `out` krimpt het naar het midden.
    const factor = mode === 'in' ? 2.6 : 0.4
    const tapFocus = mode === 'in' && !centered
    const px = tapFocus ? this.lastTapScreen.x : vp.width / 2
    const py = tapFocus ? this.lastTapScreen.y : vp.height / 2
    const toScale = fromScale * factor
    const toX = px - (px - fromX) * factor
    const toY = py - (py - fromY) * factor
    this.exitAnim = { onDone, fromScale, fromX, fromY, toScale, toX, toY, start: performance.now(), dur }
  }

  /** Schuif een nieuwe scene-root horizontaal in beeld vanaf `dir` (+1 = van
   * rechts, -1 = van links) — puur een zijwaartse translatie, geen zoom. Reuse
   * van het reveal-mechanisme met fromScale=1. NB: het "filmstrip"-effect (oude
   * scene uit één kant, nieuwe van de andere, als één stijf geheel) klopt alleen
   * doordat elk jaar op DEZELFDE fit-zoom past (AXIS_W is constant) → gelijke
   * scherm-delta voor in- en uitschuiven; een per-jaar-zoom zou dit breken. */
  slideInScene(root: Container, dir: number, dur = 520): void {
    const cx = this.camera.x
    const cy = this.camera.y
    const off = (dir * this.viewport().width) / this.camera.zoom // één viewport in wereld
    root.pivot.set(cx, cy)
    root.scale.set(1)
    root.position.set(cx + off, cy)
    root.alpha = 0
    this.reveal = { root, fromScale: 1, fromX: cx + off, fromY: cy, toX: cx, toY: cy, start: performance.now(), dur, slide: true }
  }

  /** Schuif de oude scene-root horizontaal uit beeld naar `dir` (+1 = naar rechts).
   * De root wordt in de overlay bevroren op zijn huidige scherm-transform. */
  slideOutScene(oldRoot: Container, dir: number, onDone: () => void, dur = 520): void {
    if (this.exitAnim) this.finishExit()
    if (this.reveal?.root === oldRoot) this.finishReveal()
    if (oldRoot.destroyed) {
      onDone()
      return
    }
    const vp = this.viewport()
    const z = this.camera.zoom
    const fromX = vp.width / 2 - this.camera.x * z
    const fromY = vp.height / 2 - this.camera.y * z
    this.overlay.addChild(oldRoot)
    this.overlay.pivot.set(0, 0)
    this.overlay.scale.set(z)
    this.overlay.position.set(fromX, fromY)
    this.overlay.alpha = 1
    const toX = fromX + dir * vp.width
    this.exitAnim = { onDone, fromScale: z, fromX, fromY, toScale: z, toX, toY: fromY, start: performance.now(), dur, slide: true }
  }

  /** Stop een actieve camera-drag (bijv. bij een commit tijdens het slepen), zodat
   * verdere pointermoves niet meer pannen tot een nieuwe pointerdown. */
  endDrag(): void {
    this.gestures?.endDrag()
  }

  /** Is er een actieve camera-drag (vinger neer)? */
  isDragging(): boolean {
    return this.gestures?.isDragging() ?? false
  }

  /** Peg de elastische rauwe positie op de huidige camera (na een transitie die
   * de camera verplaatst), zodat een overgebleven overscroll de camera niet laat
   * terugveren tijdens de daaropvolgende animatie. */
  syncElastic(): void {
    this.gestures?.resetElasticToCamera()
  }

  private advanceExit(): void {
    if (!this.exitAnim) return
    const a = this.exitAnim
    const t = Math.min(1, (performance.now() - a.start) / a.dur)
    const e = easeInOutCubic(t)
    this.overlay.scale.set(a.fromScale + (a.toScale - a.fromScale) * e)
    this.overlay.position.set(a.fromX + (a.toX - a.fromX) * e, a.fromY + (a.toY - a.fromY) * e)
    // Zijwaartse jaar-overgang: oude tijdlijn blijft ondoorzichtig en schuift als
    // stijf geheel de ene kant uit (naast de nieuwe, geen overlap → geen crossfade
    // nodig). Zoom-exit faadt juist iets sneller dan de beweging zodat het nieuwe
    // niveau tijdig doorschemert.
    this.overlay.alpha = a.slide ? 1 : Math.max(0, 1 - t * 1.3)
    if (t >= 1) this.finishExit()
  }

  /** Rondt de exit-animatie af: ruimt de oude scene op en reset de overlay. */
  private finishExit(): void {
    if (!this.exitAnim) return
    const done = this.exitAnim.onDone
    this.exitAnim = null
    done()
    // Overlay leegmaken en terug naar identiteit voor de volgende transitie.
    this.overlay.removeChildren()
    this.overlay.scale.set(1)
    this.overlay.position.set(0, 0)
    this.overlay.alpha = 1
  }

  /** Animeert de camera vloeiend naar een doel (voor niveau-transities). */
  animateCamera(toX: number, toY: number, toZoom: number, dur = 420, ease?: (t: number) => number): void {
    this.gestures?.endZoom() // een camera-animatie neemt de zoom over → stop een lopende wheel-zoom
    this.camAnim = {
      fromX: this.camera.x,
      fromY: this.camera.y,
      fromZoom: this.camera.zoom,
      toX,
      toY,
      toZoom,
      start: performance.now(),
      dur,
      ease,
    }
  }

  private advanceCameraAnim(): void {
    if (!this.camAnim) return
    const a = this.camAnim
    const t = Math.min(1, (performance.now() - a.start) / a.dur)
    const e = (a.ease ?? easeInOutCubic)(t)
    this.camera.x = a.fromX + (a.toX - a.fromX) * e
    this.camera.y = a.fromY + (a.toY - a.fromY) * e
    // Zoom exponentieel interpoleren → uniform aanvoelende zoombeweging.
    this.camera.zoom = a.fromZoom * Math.pow(a.toZoom / a.fromZoom, e)
    if (t >= 1) this.camAnim = null
  }

  /** Rondt een lopende reveal af: zet de root terug naar identiteit en stopt. */
  private finishReveal(): void {
    if (!this.reveal) return
    const root = this.reveal.root
    this.reveal = null
    if (root.destroyed) return
    root.scale.set(1)
    root.pivot.set(0, 0)
    root.position.set(0, 0)
    root.alpha = 1
  }

  private advanceReveal(): void {
    if (!this.reveal) return
    const r = this.reveal
    // Vangnet: als de scene tussentijds gedestroyed is (snelle dubbele navigatie
    // of vault-wissel) wijst de reveal naar een dode container — dan stoppen we
    // zonder de (genulde) transform-props aan te raken.
    if (r.root.destroyed) {
      this.reveal = null
      return
    }
    const t = Math.min(1, (performance.now() - r.start) / r.dur)
    // Zijwaartse jaar-overgang: symmetrische easeInOutCubic (gelijk aan de exit)
    // → oude en nieuwe scene bewegen als één stijve filmstrip; ondoorzichtig,
    // want de nieuwe start buiten beeld en schuift zichtbaar helemaal in. Een
    // zoom-reveal gebruikt easeOutCubic + snelle fade-in.
    const e = r.slide ? easeInOutCubic(t) : easeOutCubic(t)
    r.root.scale.set(r.fromScale + (1 - r.fromScale) * e)
    r.root.position.set(r.fromX + (r.toX - r.fromX) * e, r.fromY + (r.toY - r.fromY) * e)
    r.root.alpha = r.slide ? 1 : Math.min(1, t * 1.6)
    if (t >= 1) this.finishReveal()
  }

  private tick = (ticker: Ticker): void => {
    this.frame++
    this.advanceCameraAnim()
    this.gestures.tickInertia()
    this.gestures.tickZoom(ticker.deltaMS)
    this.advanceReveal()
    this.advanceExit()
    this.lod.update(this.camera.zoom)

    const vp = this.viewport()
    const z = this.camera.zoom
    this.world.scale.set(z)
    this.world.position.set(vp.width / 2 - this.camera.x * z, vp.height / 2 - this.camera.y * z)

    this.textures.pump(this.frame)
    this.onFrame?.({ engine: this, frame: this.frame, dtMS: ticker.deltaMS })
  }

  destroy(): void {
    // Init-safe én idempotent: destroy kan vóór of tijdens init worden
    // aangeroepen (React StrictMode mount→unmount→remount).
    if (this.destroyed) return
    this.destroyed = true
    // Ruim een lopende exit-animatie op (vernietigt de bevroren oude scene).
    this.finishExit()
    this.gestures?.destroy()
    this.textures.destroy()
    if (this.initialized) {
      this.app.ticker.remove(this.tick)
      this.app.destroy(true, { children: true, texture: false })
    }
  }
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3)
}
