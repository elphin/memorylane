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

  private frame = 0
  private initialized = false
  private destroyed = false

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
      () => {},
      (sx, sy) => {
        const w = this.camera.screenToWorld(sx, sy, this.viewport())
        this.onTap?.(w.x, w.y)
      },
      (wx, wy) => this.beginDrag?.(wx, wy) ?? null,
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

  private tick = (ticker: Ticker): void => {
    this.frame++
    this.gestures.tickInertia()
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
