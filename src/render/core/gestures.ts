// Gesture-afhandeling voor de camera: muiswiel/trackpad (zoom + pan),
// pointer-drag (pan met inertia) en twee-vinger pinch (zoom + pan).
// Bewust met native Pointer/Wheel events i.p.v. een library — direct en snel,
// buiten React-state (ticker-driven).

import type { Camera, Viewport } from './camera'

const FRICTION = 0.92
const MIN_INERTIA = 0.05

interface PointerPos {
  x: number
  y: number
}

/** Handle om een object te slepen i.p.v. de camera te pannen. */
export interface DragHandle {
  moveTo(worldX: number, worldY: number): void
  end(): void
}

export class GestureController {
  private pointers = new Map<number, PointerPos>()
  private dragging = false
  private lastDrag: PointerPos = { x: 0, y: 0 }
  private lastMove: PointerPos = { x: 0, y: 0 }
  private pinchDist = 0
  private pinchMid: PointerPos = { x: 0, y: 0 }
  private vx = 0
  private vy = 0

  private downPos: PointerPos = { x: 0, y: 0 }
  private downId = -1
  private dragTarget: DragHandle | null = null

  constructor(
    private canvas: HTMLCanvasElement,
    private camera: Camera,
    private getVp: () => Viewport,
    private onChange: () => void,
    /** Aangeroepen bij een tap (klik zonder noemenswaardige beweging). */
    private onTap?: (sx: number, sy: number) => void,
    /** Kan een sleepbaar object teruggeven op wereldpunt; dan sleept dat i.p.v.
     * de camera te pannen. */
    private beginDrag?: (worldX: number, worldY: number) => DragHandle | null,
  ) {
    canvas.addEventListener('wheel', this.onWheel, { passive: false })
    canvas.addEventListener('pointerdown', this.onPointerDown)
    canvas.addEventListener('pointermove', this.onPointerMove)
    canvas.addEventListener('pointerup', this.onPointerUp)
    canvas.addEventListener('pointercancel', this.onPointerUp)
    // Voorkom browser-gebaren (page-zoom) op het canvas.
    canvas.style.touchAction = 'none'
  }

  destroy(): void {
    this.canvas.removeEventListener('wheel', this.onWheel)
    this.canvas.removeEventListener('pointerdown', this.onPointerDown)
    this.canvas.removeEventListener('pointermove', this.onPointerMove)
    this.canvas.removeEventListener('pointerup', this.onPointerUp)
    this.canvas.removeEventListener('pointercancel', this.onPointerUp)
  }

  private localPos(e: { clientX: number; clientY: number }): PointerPos {
    const r = this.canvas.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault()
    const vp = this.getVp()
    const p = this.localPos(e)
    this.vx = 0
    this.vy = 0
    if (e.ctrlKey) {
      // Trackpad-pinch of ctrl+wheel → zoom naar cursor.
      const factor = Math.exp(-e.deltaY * 0.01)
      this.camera.zoomAt(p.x, p.y, factor, vp)
    } else {
      // Twee-vinger scroll / muiswiel → pan.
      this.camera.panScreen(e.deltaX, e.deltaY)
    }
    this.onChange()
  }

  private onPointerDown = (e: PointerEvent): void => {
    // setPointerCapture kan gooien bij synthetische events; niet fataal.
    try {
      this.canvas.setPointerCapture(e.pointerId)
    } catch {
      /* genegeerd */
    }
    const p = this.localPos(e)
    this.pointers.set(e.pointerId, p)
    if (this.pointers.size === 1) {
      this.dragging = true
      this.lastDrag = p
      this.lastMove = { x: 0, y: 0 }
      this.downPos = p
      this.downId = e.pointerId
      this.vx = 0
      this.vy = 0
      // Object onder de pointer? Dan dat slepen i.p.v. de camera.
      const w = this.camera.screenToWorld(p.x, p.y, this.getVp())
      this.dragTarget = this.beginDrag?.(w.x, w.y) ?? null
    } else if (this.pointers.size === 2) {
      // Een tweede vinger start een pinch: rond een eventuele object-sleep netjes
      // af (persist bij beweging) i.p.v. de handle te laten hangen — anders
      // "springt" het object bij terugkeer naar één vinger of blijft het plakken.
      if (this.dragTarget) {
        this.dragTarget.end()
        this.dragTarget = null
      }
      this.dragging = false
      this.updatePinchRef()
    }
  }

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.pointers.has(e.pointerId)) return
    const p = this.localPos(e)
    this.pointers.set(e.pointerId, p)

    if (this.pointers.size >= 2) {
      this.handlePinch()
      return
    }
    if (this.dragTarget) {
      const w = this.camera.screenToWorld(p.x, p.y, this.getVp())
      this.dragTarget.moveTo(w.x, w.y)
      this.onChange()
      return
    }
    if (this.dragging) {
      const dx = p.x - this.lastDrag.x
      const dy = p.y - this.lastDrag.y
      // Content volgt de vinger → camera beweegt tegengesteld.
      this.camera.panScreen(-dx, -dy)
      this.lastMove = { x: -dx, y: -dy }
      this.lastDrag = p
      this.onChange()
    }
  }

  private onPointerUp = (e: PointerEvent): void => {
    if (this.canvas.hasPointerCapture(e.pointerId)) {
      this.canvas.releasePointerCapture(e.pointerId)
    }
    this.pointers.delete(e.pointerId)
    if (this.pointers.size < 2) {
      this.pinchDist = 0
    }
    // Object-sleep afronden. Bewoog het nauwelijks → tap (bijv. item aantikken
    // om in te zoomen naar L3), anders een echte sleep (geen tap, geen inertie).
    if (this.dragTarget && this.pointers.size === 0) {
      const p = this.localPos(e)
      const moved = Math.hypot(p.x - this.downPos.x, p.y - this.downPos.y)
      this.dragTarget.end()
      this.dragTarget = null
      this.dragging = false
      if (e.pointerId === this.downId && moved < 6) this.onTap?.(p.x, p.y)
      return
    }
    if (this.pointers.size === 0 && this.dragging) {
      this.dragging = false
      // Tap: losgelaten pointer, nauwelijks bewogen → klik i.p.v. pan.
      const p = this.localPos(e)
      const moved = Math.hypot(p.x - this.downPos.x, p.y - this.downPos.y)
      if (e.pointerId === this.downId && moved < 6) {
        this.onTap?.(p.x, p.y)
        this.vx = 0
        this.vy = 0
      } else {
        // Start inertie vanaf de laatste bewegingssnelheid.
        this.vx = this.lastMove.x
        this.vy = this.lastMove.y
      }
    } else if (this.pointers.size === 1) {
      // Terug naar één vinger: hervat drag vanaf de resterende pointer.
      const [pos] = [...this.pointers.values()]
      this.dragging = true
      this.lastDrag = pos
    }
  }

  private twoPointers(): [PointerPos, PointerPos] {
    const it = this.pointers.values()
    return [it.next().value as PointerPos, it.next().value as PointerPos]
  }

  private updatePinchRef(): void {
    const [a, b] = this.twoPointers()
    this.pinchDist = Math.hypot(a.x - b.x, a.y - b.y)
    this.pinchMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  }

  private handlePinch(): void {
    const vp = this.getVp()
    const [a, b] = this.twoPointers()
    const dist = Math.hypot(a.x - b.x, a.y - b.y)
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    if (this.pinchDist > 0) {
      const factor = dist / this.pinchDist
      this.camera.zoomAt(mid.x, mid.y, factor, vp)
      // Pan mee met de verplaatsing van het middelpunt.
      this.camera.panScreen(-(mid.x - this.pinchMid.x), -(mid.y - this.pinchMid.y))
      this.onChange()
    }
    this.pinchDist = dist
    this.pinchMid = mid
  }

  /** Past resterende inertie toe (per frame door de engine aangeroepen). */
  tickInertia(): void {
    if (this.dragging) return
    if (Math.abs(this.vx) < MIN_INERTIA && Math.abs(this.vy) < MIN_INERTIA) {
      this.vx = 0
      this.vy = 0
      return
    }
    this.camera.panScreen(this.vx, this.vy)
    this.vx *= FRICTION
    this.vy *= FRICTION
    this.onChange()
  }
}
