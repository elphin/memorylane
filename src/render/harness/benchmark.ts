// Omgevings-robuuste perf-benchmark met ÉCHTE textures.
//
// De benchmark is requestAnimationFrame-gedreven (via de Pixi-ticker), zodat de
// decode-worker tússen frames textures kan afleveren — anders zou een strak
// synchrone lus de worker verhongeren en een texture-loze scene meten.
//
// Per frame meten we niet de rAF-interval (die is in een geautomatiseerde tab
// niet vsync-representatief) maar de **synchrone main-thread werk-kost**: we
// bracketten het hele frame met een ticker-callback op de hoogste prioriteit
// (vóór de engine-tick, camera zetten + t0) en één op de laagste (ná de render,
// t1). t1−t0 = al het werk: camera-transform, scene-update (culling +
// texture-toewijzing + crossfade), upload-pump én de texImage2D-uploads die de
// render synchroon doet. GPU-rasterisatie is async en verwaarloosbaar voor
// quads. De gate kijkt naar de 1%-low (p99) werk-kost.

import { UPDATE_PRIORITY } from 'pixi.js'
import type { RenderEngine } from '../core/engine'

export interface BenchResult {
  frames: number
  avgMs: number
  p50: number
  p95: number
  p99: number
  p999: number
  maxMs: number
  /** Theoretische max fps uit de gemiddelde werk-kost. */
  fps: number
  /** 1%-low (p99) werk-kost ≤ 16.6ms → 60fps haalbaar. */
  pass: boolean
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[idx]
}

function round(v: number): number {
  return Math.round(v * 100) / 100
}

function stats(work: number[]): BenchResult {
  const sorted = [...work].sort((a, b) => a - b)
  const avg = sorted.reduce((a, b) => a + b, 0) / (sorted.length || 1)
  const p99 = percentile(sorted, 99)
  return {
    frames: sorted.length,
    avgMs: round(avg),
    p50: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    p99: round(p99),
    p999: round(percentile(sorted, 99.9)),
    maxMs: round(sorted[sorted.length - 1] ?? 0),
    fps: round(1000 / avg),
    pass: p99 <= 16.6,
  }
}

/** Scripted camerapad als functie van globale t (0..1) over 4 fases. */
function driveCamera(
  engine: RenderEngine,
  t: number,
  origin: { x: number; y: number },
  span: number,
): void {
  const cam = engine.camera
  if (t < 0.3) {
    cam.x = origin.x + Math.sin((t / 0.3) * Math.PI * 2) * span
    cam.y = origin.y
  } else if (t < 0.55) {
    cam.zoom = 0.15 + ((t - 0.3) / 0.25) * (6 - 0.15)
  } else if (t < 0.8) {
    cam.zoom = 6 - ((t - 0.55) / 0.25) * (6 - 0.15)
  } else {
    const u = (t - 0.8) / 0.2
    cam.x = origin.x + Math.sin(u * Math.PI * 12) * span
    cam.y = origin.y + Math.cos(u * Math.PI * 10) * span
  }
}

export function runBenchmark(engine: RenderEngine): Promise<BenchResult> {
  const cam = engine.camera
  const saved = { x: cam.x, y: cam.y, zoom: cam.zoom }
  const origin = { x: cam.x, y: cam.y }
  const span = 4000
  const steps = 700
  const warmup = 60 // eerste frames negeren (streaming op gang laten komen)

  const work: number[] = []
  let frame = 0
  let t0 = 0

  return new Promise((resolve) => {
    // Hoogste prioriteit: vóór de engine-tick — camera zetten en t0 stempelen.
    const start = (): void => {
      driveCamera(engine, frame / steps, origin, span)
      t0 = performance.now()
    }
    // Laagste prioriteit: ná de render — synchrone frame-werk-kost vastleggen.
    const end = (): void => {
      const dt = performance.now() - t0
      if (frame >= warmup) work.push(dt)
      frame++
      if (frame >= steps) {
        engine.app.ticker.remove(start)
        engine.app.ticker.remove(end)
        cam.x = saved.x
        cam.y = saved.y
        cam.zoom = saved.zoom
        resolve(stats(work))
      }
    }
    engine.app.ticker.add(start, null, UPDATE_PRIORITY.INTERACTION)
    engine.app.ticker.add(end, null, UPDATE_PRIORITY.UTILITY)
  })
}
