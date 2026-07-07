// Perf-harness UI: mount de render-engine met 5000 synthetische sprites, toon
// een live fps/frametime-overlay en stel een globale `__runBench()` bloot zodat
// de benchmark ook geautomatiseerd (via devtools) gedraaid kan worden.

import { useEffect, useRef, useState } from 'react'
import { RenderEngine } from '../core/engine'
import { runBenchmark, type BenchResult } from './benchmark'
import { HarnessScene } from './scene'

interface BenchWindow {
  __runBench?: () => Promise<BenchResult>
  __benchResult?: BenchResult
}

const SPRITES = 5000

export function PerfHarness() {
  const hostRef = useRef<HTMLDivElement>(null)
  const [overlay, setOverlay] = useState('engine start…')
  const [bench, setBench] = useState<BenchResult | null>(null)
  const engineRef = useRef<RenderEngine | null>(null)

  useEffect(() => {
    let engine: RenderEngine | null = null
    let scene: HarnessScene | null = null
    let raf = 0
    let disposed = false

    void (async () => {
      engine = new RenderEngine()
      await engine.init(hostRef.current!)
      if (disposed) {
        engine.destroy()
        return
      }
      scene = new HarnessScene(engine, SPRITES)
      engineRef.current = engine
      // Debug-hook voor geautomatiseerde metingen.
      ;(window as unknown as { __engine?: RenderEngine }).__engine = engine

      let last = performance.now()
      let acc = 0
      let frames = 0
      const loop = (): void => {
        const now = performance.now()
        acc += now - last
        frames += 1
        last = now
        if (acc >= 500 && engine) {
          const fps = (frames * 1000) / acc
          setOverlay(
            `${fps.toFixed(0)} fps · ${SPRITES} sprites · band ${engine.lod.band}` +
              ` · tex ${engine.textures.size} · queue ${engine.textures.queued}`,
          )
          acc = 0
          frames = 0
        }
        raf = requestAnimationFrame(loop)
      }
      raf = requestAnimationFrame(loop)
    })()

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      scene?.destroy()
      engine?.destroy()
      engineRef.current = null
    }
  }, [])

  const doBench = async (): Promise<BenchResult> => {
    const engine = engineRef.current
    if (!engine) throw new Error('engine niet gereed')
    const result = await runBenchmark(engine)
    setBench(result)
    ;(window as unknown as BenchWindow).__benchResult = result
    // eslint-disable-next-line no-console
    console.log('[[BENCH]]' + JSON.stringify(result))
    return result
  }

  // Globale trigger voor geautomatiseerd meten.
  useEffect(() => {
    ;(window as unknown as BenchWindow).__runBench = doBench
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <div ref={hostRef} style={{ position: 'absolute', inset: 0 }} />
      <div
        style={{
          position: 'absolute',
          top: 8,
          left: 8,
          padding: '6px 10px',
          background: 'rgba(0,0,0,0.6)',
          borderRadius: 6,
          font: '12px monospace',
          pointerEvents: 'none',
        }}
      >
        {overlay}
      </div>
      <button
        onClick={() => void doBench()}
        style={{
          position: 'absolute',
          top: 8,
          right: 8,
          padding: '6px 12px',
          borderRadius: 6,
          border: '1px solid #475569',
          background: '#334155',
          color: '#fff',
          cursor: 'pointer',
          font: '12px sans-serif',
        }}
      >
        Run benchmark
      </button>
      {bench && (
        <pre
          style={{
            position: 'absolute',
            bottom: 8,
            left: 8,
            margin: 0,
            padding: '8px 12px',
            background: bench.pass ? 'rgba(20,60,30,0.85)' : 'rgba(70,20,20,0.85)',
            borderRadius: 6,
            font: '12px monospace',
          }}
        >
          {`gate ${bench.pass ? 'GEHAALD ✓' : 'NIET gehaald ✗'} — 1%-low ${bench.p99}ms\n` +
            JSON.stringify(bench, null, 2)}
        </pre>
      )}
    </div>
  )
}
