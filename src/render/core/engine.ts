// Render-engine: bindt PixiJS, camera, gestures, texture-pipeline en LOD samen.
// Draait ticker-driven buiten React-state. De `world`-container krijgt elke
// frame de camera-transform; scenes haken in via `onFrame`.

import { Application, Container, Ticker, UPDATE_PRIORITY } from 'pixi.js'
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
  } | null = null
  private lastTapScreen = { x: 0, y: 0 }

  async init(container: HTMLElement): Promise<void> {
    if (this.destroyed) return
    await this.app.init({
      resizeTo: container,
      // Foto-sprites zijn axis-aligned quads; MSAA kost frame-tijd zonder
      // zichtbare winst. Uit = flink sneller.
      antialias: false,
      background: 0x0a0a0f,
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
    )

    this.app.ticker.add(this.tick, undefined, UPDATE_PRIORITY.HIGH)
    this.initialized = true
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
   * midden. `onDone` vernietigt de oude scene zodra klaar/afgebroken. */
  exitScene(oldRoot: Container, mode: 'in' | 'out', onDone: () => void, dur = 380): void {
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
    const px = mode === 'in' ? this.lastTapScreen.x : vp.width / 2
    const py = mode === 'in' ? this.lastTapScreen.y : vp.height / 2
    const toScale = fromScale * factor
    const toX = px - (px - fromX) * factor
    const toY = py - (py - fromY) * factor
    this.exitAnim = { onDone, fromScale, fromX, fromY, toScale, toX, toY, start: performance.now(), dur }
  }

  private advanceExit(): void {
    if (!this.exitAnim) return
    const a = this.exitAnim
    const t = Math.min(1, (performance.now() - a.start) / a.dur)
    const e = easeInOutCubic(t)
    this.overlay.scale.set(a.fromScale + (a.toScale - a.fromScale) * e)
    this.overlay.position.set(a.fromX + (a.toX - a.fromX) * e, a.fromY + (a.toY - a.fromY) * e)
    // Iets sneller uitfaden dan de beweging, zodat het nieuwe niveau tijdig
    // doorschemert.
    this.overlay.alpha = Math.max(0, 1 - t * 1.3)
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
  animateCamera(toX: number, toY: number, toZoom: number, dur = 420): void {
    this.camAnim = {
      fromX: this.camera.x,
      fromY: this.camera.y,
      fromZoom: this.camera.zoom,
      toX,
      toY,
      toZoom,
      start: performance.now(),
      dur,
    }
  }

  private advanceCameraAnim(): void {
    if (!this.camAnim) return
    const a = this.camAnim
    const t = Math.min(1, (performance.now() - a.start) / a.dur)
    const e = easeInOutCubic(t)
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
    const e = easeOutCubic(t)
    r.root.scale.set(r.fromScale + (1 - r.fromScale) * e)
    r.root.position.set(r.fromX + (r.toX - r.fromX) * e, r.fromY + (r.toY - r.fromY) * e)
    r.root.alpha = Math.min(1, t * 1.6)
    if (t >= 1) this.finishReveal()
  }

  private tick = (ticker: Ticker): void => {
    this.frame++
    this.advanceCameraAnim()
    this.gestures.tickInertia()
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
