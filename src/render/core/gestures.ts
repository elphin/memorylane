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

export class GestureController {
  private pointers = new Map<number, PointerPos>()
  private dragging = false
  private lastDrag: PointerPos = { x: 0, y: 0 }
  private lastMove: PointerPos = { x: 0, y: 0 }
  private pinchDist = 0
  private pinchMid: PointerPos = { x: 0, y: 0 }
  private vx = 0
  private vy = 0

  constructor(
    private canvas: HTMLCanvasElement,
    private camera: Camera,
    private getVp: () => Viewport,
    private onChange: () => void,
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
    this.canvas.setPointerCapture(e.pointerId)
    const p = this.localPos(e)
    this.pointers.set(e.pointerId, p)
    if (this.pointers.size === 1) {
      this.dragging = true
      this.lastDrag = p
      this.lastMove = { x: 0, y: 0 }
      this.vx = 0
      this.vy = 0
    } else if (this.pointers.size === 2) {
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
    if (this.pointers.size === 0 && this.dragging) {
      this.dragging = false
      // Start inertie vanaf de laatste bewegingssnelheid.
      this.vx = this.lastMove.x
      this.vy = this.lastMove.y
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
