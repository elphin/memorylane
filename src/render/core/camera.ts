// Camera voor de zoombare tijdlijn: één {x, y, zoom} in wereldruimte.
// x,y = het wereldpunt dat in het midden van het viewport staat; zoom = pixels
// per wereld-eenheid. Zoom-naar-cursor houdt het wereldpunt onder de cursor vast.

export interface Viewport {
  width: number
  height: number
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

export class Camera {
  x = 0
  y = 0
  zoom = 1
  minZoom = 0.01
  maxZoom = 40
  // Vergrendel verticaal pannen (voor de horizontale L0/L1-niveaus): `y` blijft
  // op de fit-waarde; pan/zoom laten 'm ongemoeid.
  lockY = false
  // Elastische horizontale scroll-grenzen (rust-positie; wereld-x). null = geen
  // grens. De gesture-laag mapt een rauwe positie via rubber-band naar `x` (en
  // veert terug). Alleen de jaar-view zet dit.
  boundsX: { min: number; max: number } | null = null
  // Getekende overscroll voorbij de grens (scherm-px, signed; + = rechts). Rauw
  // (groeit door met de pull) → voor de buurjaar-preview en de commit-drempel.
  overscrollPx = 0

  screenToWorld(sx: number, sy: number, vp: Viewport): { x: number; y: number } {
    return {
      x: this.x + (sx - vp.width / 2) / this.zoom,
      y: this.y + (sy - vp.height / 2) / this.zoom,
    }
  }

  worldToScreen(wx: number, wy: number, vp: Viewport): { x: number; y: number } {
    return {
      x: (wx - this.x) * this.zoom + vp.width / 2,
      y: (wy - this.y) * this.zoom + vp.height / 2,
    }
  }

  /** Zoom met `factor` rond schermpunt (sx,sy); dat wereldpunt blijft vast. */
  zoomAt(sx: number, sy: number, factor: number, vp: Viewport): void {
    const before = this.screenToWorld(sx, sy, vp)
    this.zoom = clamp(this.zoom * factor, this.minZoom, this.maxZoom)
    const after = this.screenToWorld(sx, sy, vp)
    this.x += before.x - after.x
    if (!this.lockY) this.y += before.y - after.y
  }

  /** Verplaats de camera met een scherm-delta in pixels (camera beweegt mee). */
  panScreen(dx: number, dy: number): void {
    this.x += dx / this.zoom
    if (!this.lockY) this.y += dy / this.zoom
  }

  /** Zichtbare wereld-rechthoek voor viewport-culling. */
  worldBounds(vp: Viewport): { minX: number; minY: number; maxX: number; maxY: number } {
    const halfW = vp.width / 2 / this.zoom
    const halfH = vp.height / 2 / this.zoom
    return {
      minX: this.x - halfW,
      minY: this.y - halfH,
      maxX: this.x + halfW,
      maxY: this.y + halfH,
    }
  }
}
