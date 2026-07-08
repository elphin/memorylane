// Render-engine: bindt PixiJS, camera, gestures, texture-pipeline en LOD samen.
// Draait ticker-driven buiten React-state. De `world`-container krijgt elke
// frame de camera-transform; scenes haken in via `onFrame`.

import { Application, Container, Ticker, UPDATE_PRIORITY } from 'pixi.js'
import { Camera, type Viewport } from './camera'
import { GestureController, type DragHandle } from './gestures'
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
  readonly camera = new Camera()
  readonly textures = new TextureManager()
  readonly lod = new LodManager()
  gestures!: GestureController

  /** Scene-hook, elke frame ná de camera-transform. */
  onFrame?: (ctx: FrameContext) => void

  /** Tap-hook met wereldcoördinaten (voor hit-testing van tegels). */
  onTap?: (worldX: number, worldY: number) => void

  /** Sleep-hook: geeft een handle terug als er een object onder het wereldpunt
   * ligt (dan sleept dat i.p.v. de camera). */
  beginDrag?: (worldX: number, worldY: number) => DragHandle | null

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
      },
      (sx, sy) => {
        this.lastTapScreen = { x: sx, y: sy }
        const w = this.camera.screenToWorld(sx, sy, this.viewport())
        this.onTap?.(w.x, w.y)
      },
      (wx, wy) => this.beginDrag?.(wx, wy) ?? null,
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
