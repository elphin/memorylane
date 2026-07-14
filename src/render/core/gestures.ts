// Gesture-afhandeling voor de camera: muiswiel/trackpad (zoom + pan),
// pointer-drag (pan met inertia) en twee-vinger pinch (zoom + pan).
// Bewust met native Pointer/Wheel events i.p.v. een library — direct en snel,
// buiten React-state (ticker-driven).

import type { Camera, Viewport } from './camera'

const FRICTION = 0.92
const MIN_INERTIA = 0.05
// Rubber-band-sterkte (scherm-px): hoe zwaarder het voelt om voorbij de grens te
// trekken. De rauwe overscroll wordt logaritmisch gedempt naar de getekende x.
const RUBBER = 130

interface PointerPos {
  x: number
  y: number
}

/** Toets-modifiers op het moment van pointerdown (voor roteren/schalen i.p.v. slepen). */
export interface DragMods {
  alt: boolean
  shift: boolean
  ctrl: boolean
}

/** Handle om een object te slepen i.p.v. de camera te pannen. */
export interface DragHandle {
  moveTo(worldX: number, worldY: number): void
  /** Normale afronding (pointerup): commit de sleep. */
  end(): void
  /** Afbreken (pointercancel of onderbroken door een tweede vinger/pinch): ruim
   * tijdelijke UI op ZONDER het commit-neveneffect (bijv. geen dialog openen).
   * Ontbreekt `cancel`, dan valt de controller terug op `end()`. */
  cancel?(): void
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
  // Rauwe (ongeklemde) horizontale positie voor de elastische scroll-grens; de
  // getekende `camera.x` volgt via rubber-band (zie applyElasticX).
  private rawX = 0

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
    private beginDrag?: (worldX: number, worldY: number, mods: DragMods) => DragHandle | null,
    /** Muispositie bij hoveren (sx=null bij verlaten). */
    private onHover?: (sx: number | null, sy: number) => void,
  ) {
    canvas.addEventListener('wheel', this.onWheel, { passive: false })
    canvas.addEventListener('pointerdown', this.onPointerDown)
    canvas.addEventListener('pointermove', this.onPointerMove)
    canvas.addEventListener('pointerup', this.onPointerUp)
    canvas.addEventListener('pointercancel', this.onPointerCancel)
    canvas.addEventListener('pointerleave', this.onPointerLeave)
    // Voorkom browser-gebaren (page-zoom) op het canvas.
    canvas.style.touchAction = 'none'
  }

  destroy(): void {
    this.canvas.removeEventListener('wheel', this.onWheel)
    this.canvas.removeEventListener('pointerdown', this.onPointerDown)
    this.canvas.removeEventListener('pointermove', this.onPointerMove)
    this.canvas.removeEventListener('pointerup', this.onPointerUp)
    this.canvas.removeEventListener('pointercancel', this.onPointerCancel)
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave)
  }

  private onPointerLeave = (): void => {
    this.onHover?.(null, 0)
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
    // Wiel = zoomen naar de cursor (wat de meeste mensen verwachten). Delta
    // geclampt zodat een muiswiel-notch niet te grof springt; trackpad-pinch
    // (ctrlKey, kleine delta) voelt fijner.
    const delta = Math.max(-140, Math.min(140, e.deltaY))
    const factor = Math.exp(-delta * (e.ctrlKey ? 0.01 : 0.0016))
    this.camera.zoomAt(p.x, p.y, factor, vp)
    // Inzoomen mag niet buiten de elastische grens ontsnappen.
    this.syncRawX()
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
      // Rauwe horizontale positie op de huidige camera-x zetten (nieuwe drag).
      this.rawX = this.camera.x
      // Object onder de pointer? Dan dat slepen i.p.v. de camera.
      const w = this.camera.screenToWorld(p.x, p.y, this.getVp())
      this.dragTarget =
        this.beginDrag?.(w.x, w.y, { alt: e.altKey, shift: e.shiftKey, ctrl: e.ctrlKey }) ?? null
    } else if (this.pointers.size === 2) {
      // Een tweede vinger start een pinch: breek een eventuele object-sleep af
      // i.p.v. de handle te laten hangen — anders "springt" het object bij
      // terugkeer naar één vinger of blijft het plakken. `cancel` (val terug op
      // `end`) zodat een sleep die commit-neveneffecten heeft (bijv. de L1-range
      // die een dialog opent) hier NIET committeert; L2 persisteert een
      // verplaatsing gewoon via zijn `end`-fallback.
      if (this.dragTarget) {
        ;(this.dragTarget.cancel ?? this.dragTarget.end).call(this.dragTarget)
        this.dragTarget = null
      }
      this.dragging = false
      this.updatePinchRef()
    }
  }

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.pointers.has(e.pointerId)) {
      // Geen knop ingedrukt → hover (alleen zinvol voor een muis).
      if (e.pointerType === 'mouse') {
        const h = this.localPos(e)
        this.onHover?.(h.x, h.y)
      }
      return
    }
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
      // Content volgt de vinger → camera beweegt tegengesteld. In de elastische
      // modus (jaar-view) loopt x via de rauwe positie + rubber-band.
      if (this.camera.boundsX) {
        this.rawX += -dx / this.camera.zoom
        if (!this.camera.lockY) this.camera.y += -dy / this.camera.zoom
        this.applyElasticX()
      } else {
        this.camera.panScreen(-dx, -dy)
      }
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

  // Pointercancel (OS pakt de pointer af, gesture-conflict, scroll-overname):
  // dit is een ANNULERING, geen afronding. Breek een object-sleep af via
  // `cancel` (val terug op `end`) en genereer NOOIT een tap — anders zou een
  // afgebroken Ctrl-range alsnog een dialog openen of navigeren.
  private onPointerCancel = (e: PointerEvent): void => {
    if (this.canvas.hasPointerCapture(e.pointerId)) {
      this.canvas.releasePointerCapture(e.pointerId)
    }
    this.pointers.delete(e.pointerId)
    if (this.pointers.size < 2) {
      this.pinchDist = 0
    }
    if (this.dragTarget && this.pointers.size === 0) {
      ;(this.dragTarget.cancel ?? this.dragTarget.end).call(this.dragTarget)
      this.dragTarget = null
    }
    if (this.pointers.size === 0) {
      // Laatste pointer weg: stop de drag, geen inertie (afbreken ≠ afronden).
      this.dragging = false
      this.vx = 0
      this.vy = 0
    } else if (this.pointers.size === 1) {
      // Eén van twee vingers gecanceld: hervat een enkelvoudige drag vanaf de
      // resterende pointer (zoals onPointerUp), anders is die vinger "dood" voor
      // pan/pinch tot een volledige lift.
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
      // Binnen de elastische grens houden (pinch-pan hard geklemd).
      if (this.camera.boundsX) this.syncRawX()
      this.onChange()
    }
    this.pinchDist = dist
    this.pinchMid = mid
  }

  /** Map de rauwe horizontale positie via rubber-band naar `camera.x` en bewaar de
   * (rauwe) overscroll in scherm-px. Zonder `boundsX` = 1:1. */
  private applyElasticX(): void {
    const cam = this.camera
    const b = cam.boundsX
    if (!b) {
      cam.x = this.rawX
      cam.overscrollPx = 0
      return
    }
    const clamped = Math.max(b.min, Math.min(b.max, this.rawX))
    const overWorld = this.rawX - clamped
    if (overWorld === 0) {
      cam.x = this.rawX
      cam.overscrollPx = 0
      return
    }
    const rawPx = overWorld * cam.zoom // rauwe overscroll (scherm-px, signed)
    const dispPx = Math.sign(rawPx) * RUBBER * Math.log(1 + Math.abs(rawPx) / RUBBER)
    cam.x = clamped + dispPx / cam.zoom
    cam.overscrollPx = rawPx
  }

  /** Synchroniseer de rauwe positie met de (bijv. door zoom gewijzigde) `camera.x`,
   * geklemd binnen de grenzen zodat inzoomen niet buiten de grens ontsnapt. */
  private syncRawX(): void {
    const b = this.camera.boundsX
    const x = b ? Math.max(b.min, Math.min(b.max, this.camera.x)) : this.camera.x
    this.camera.x = x
    this.rawX = x
    this.camera.overscrollPx = 0
  }

  /** Stop de camera-drag en inertie (bijv. bij een commit tijdens het slepen).
   * Reset ook de overscroll zodat een direct-opnieuw-indrukken (zonder pan) niet
   * ongewild nóg een commit triggert. */
  endDrag(): void {
    this.dragging = false
    this.vx = 0
    this.vy = 0
    this.camera.overscrollPx = 0
    this.rawX = this.camera.x
  }

  /** Is er een actieve camera-drag (vinger neer)? */
  isDragging(): boolean {
    return this.dragging
  }

  /** Past resterende inertie toe (per frame door de engine aangeroepen). */
  tickInertia(): void {
    if (this.dragging) return
    const cam = this.camera
    // Elastische modus (jaar-view): inertie/bounce op de rauwe positie.
    if (cam.boundsX) {
      let moved = false
      if (Math.abs(this.vx) >= MIN_INERTIA) {
        this.rawX += this.vx / cam.zoom
        this.vx *= FRICTION
        moved = true
      } else this.vx = 0
      // Terugveren naar de grens (bounce) + inertie sterk dempen in de overscroll.
      const clamped = Math.max(cam.boundsX.min, Math.min(cam.boundsX.max, this.rawX))
      if (this.rawX !== clamped) {
        this.rawX += (clamped - this.rawX) * 0.18
        this.vx *= 0.5
        if (Math.abs(this.rawX - clamped) < 0.5 / cam.zoom) this.rawX = clamped
        moved = true
      }
      if (!cam.lockY && Math.abs(this.vy) >= MIN_INERTIA) {
        cam.y += this.vy / cam.zoom
        this.vy *= FRICTION
        moved = true
      } else this.vy = 0
      if (moved) {
        this.applyElasticX()
        this.onChange()
      }
      return
    }
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
