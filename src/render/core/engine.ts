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
  // Fade-in van nieuwe scene-inhoud.
  private fadeStart = 0
  private fadeDur = 0

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
      // Een gebruikersgebaar onderbreekt een lopende camera-animatie.
      () => {
        this.camAnim = null
      },
      (sx, sy) => {
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

  /** Doelzoom van de lopende animatie (of de huidige zoom als er geen loopt). */
  get pendingZoom(): number {
    return this.camAnim?.toZoom ?? this.camera.zoom
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

  /** Faadt de scene-inhoud in (bij een niveauwissel). */
  fadeIn(dur = 260): void {
    this.fadeStart = performance.now()
    this.fadeDur = dur
    this.world.alpha = 0
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

  private advanceFade(): void {
    if (this.fadeDur <= 0) return
    const t = Math.min(1, (performance.now() - this.fadeStart) / this.fadeDur)
    this.world.alpha = t
    if (t >= 1) {
      this.fadeDur = 0
      this.world.alpha = 1
    }
  }

  private tick = (ticker: Ticker): void => {
    this.frame++
    this.advanceCameraAnim()
    this.gestures.tickInertia()
    this.advanceFade()
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
