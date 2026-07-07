// App-shell: mount de render-engine, laadt de jaren via de backend en beheert
// de scenes (L0 lifeline ↔ L1 jaar). Transities zijn zoom-gedreven (geen
// terug-knoppen): tik op een jaar → in; ver uitzoomen in een jaar → terug.
// DOM wordt alleen gebruikt voor overlays (loading, first-run, leeg).

import { useEffect, useRef, useState } from 'react'
import type { Backend, YearSummary } from '../lib/backend'
import { createBackend } from '../lib/backend'
import { RenderEngine } from '../render/core/engine'
import { LifelineScene } from '../render/scenes/lifeline'
import type { Scene } from '../render/scenes/scene'
import { YearScene } from '../render/scenes/year'

type Phase = 'loading' | 'first-run' | 'empty' | 'ready' | 'error'

export function AppShell() {
  const hostRef = useRef<HTMLDivElement>(null)
  const [phase, setPhase] = useState<Phase>('loading')
  const [message, setMessage] = useState('')

  const engineRef = useRef<RenderEngine | null>(null)
  const backendRef = useRef<Backend | null>(null)
  const sceneRef = useRef<Scene | null>(null)
  const yearsRef = useRef<YearSummary[]>([])
  const levelRef = useRef<'lifeline' | 'year'>('lifeline')
  const entryZoomRef = useRef(1)
  const enterSeqRef = useRef(0)
  const enteringRef = useRef(false)

  useEffect(() => {
    let engine: RenderEngine | null = null
    let disposed = false

    const setupLifeline = (): void => {
      if (!engine || !backendRef.current) return
      // Invalideer een eventuele in-flight enterYear.
      enterSeqRef.current++
      sceneRef.current?.destroy()
      sceneRef.current = new LifelineScene(engine, backendRef.current, yearsRef.current)
      levelRef.current = 'lifeline'
    }

    const enterYear = async (yearId: string): Promise<void> => {
      if (!engine || !backendRef.current || enteringRef.current) return
      enteringRef.current = true
      const seq = ++enterSeqRef.current
      try {
        const photos = await backendRef.current.getYearPhotos(yearId)
        // Verouderde/parallelle resolves negeren (tap-race).
        if (disposed || !engine || seq !== enterSeqRef.current) return
        sceneRef.current?.destroy()
        // Null vóór constructie: als YearScene gooit blijft er geen vernietigde
        // scene achter waar onFrame op update() zou aanroepen.
        sceneRef.current = null
        sceneRef.current = new YearScene(engine, backendRef.current, photos)
        levelRef.current = 'year'
        entryZoomRef.current = engine.camera.zoom
      } catch (e) {
        if (!disposed) {
          setMessage(String(e))
          setPhase('error')
        }
      } finally {
        enteringRef.current = false
      }
    }

    const loadYears = async (): Promise<void> => {
      if (!backendRef.current) return
      const years = await backendRef.current.listYears()
      if (disposed) return
      yearsRef.current = years
      if (years.length === 0) {
        setPhase('empty')
        return
      }
      setupLifeline()
      setPhase('ready')
    }

    void (async () => {
      engine = new RenderEngine()
      await engine.init(hostRef.current!)
      if (disposed) {
        engine.destroy()
        return
      }
      engineRef.current = engine
      backendRef.current = createBackend()

      engine.onFrame = (ctx) => {
        sceneRef.current?.update(ctx)
        // Ver uitzoomen in een jaar → terug naar de lifeline.
        if (levelRef.current === 'year' && ctx.engine.camera.zoom < entryZoomRef.current * 0.45) {
          setupLifeline()
        }
      }
      engine.onTap = (wx, wy) => {
        const hit = sceneRef.current?.hitTest?.(wx, wy)
        if (!hit) return
        if (levelRef.current === 'lifeline') void enterYear(hit)
      }

      try {
        const path = await backendRef.current.getVaultPath()
        if (disposed) return
        if (!path) {
          setPhase('first-run')
          return
        }
        await loadYears()
      } catch (e) {
        setMessage(String(e))
        setPhase('error')
      }
    })()

    return () => {
      disposed = true
      sceneRef.current?.destroy()
      sceneRef.current = null
      engine?.destroy()
      engineRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const pickVault = async (): Promise<void> => {
    const backend = backendRef.current
    if (!backend) return
    setPhase('loading')
    try {
      const summary = await backend.pickAndSetVault()
      if (!summary) {
        setPhase('first-run')
        return
      }
      const years = await backend.listYears()
      yearsRef.current = years
      const engine = engineRef.current
      if (engine && years.length > 0) {
        sceneRef.current?.destroy()
        sceneRef.current = new LifelineScene(engine, backend, years)
        levelRef.current = 'lifeline'
        setPhase('ready')
      } else {
        setPhase('empty')
      }
    } catch (e) {
      setMessage(String(e))
      setPhase('error')
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <div ref={hostRef} style={{ position: 'absolute', inset: 0 }} />
      {phase !== 'ready' && <Overlay phase={phase} message={message} onPick={() => void pickVault()} />}
    </div>
  )
}

function Overlay({
  phase,
  message,
  onPick,
}: {
  phase: Phase
  message: string
  onPick: () => void
}) {
  const box: React.CSSProperties = {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    textAlign: 'center',
    padding: 24,
  }
  if (phase === 'loading') {
    return (
      <div style={box}>
        <div style={{ color: '#8a97b0', font: '14px sans-serif' }}>Laden…</div>
      </div>
    )
  }
  if (phase === 'first-run') {
    return (
      <div style={box}>
        <div style={{ fontSize: 28, fontWeight: 700 }}>MemoryLane</div>
        <div style={{ color: '#8a97b0', maxWidth: 420, font: '14px sans-serif' }}>
          Kies de map met je herinneringen. Je mappen op schijf blijven altijd de bron —
          MemoryLane bouwt er alleen een tijdlijn omheen.
        </div>
        <button onClick={onPick} style={primaryBtn}>
          Kies je MemoryLane-map
        </button>
      </div>
    )
  }
  if (phase === 'empty') {
    return (
      <div style={box}>
        <div style={{ fontSize: 22, fontWeight: 700 }}>Nog leeg</div>
        <div style={{ color: '#8a97b0', font: '14px sans-serif' }}>
          Er zijn nog geen jaren gevonden in deze map.
        </div>
      </div>
    )
  }
  return (
    <div style={box}>
      <div style={{ fontSize: 20, fontWeight: 700, color: '#ff8a8a' }}>Er ging iets mis</div>
      <div style={{ color: '#8a97b0', font: '13px monospace', maxWidth: 520 }}>{message}</div>
    </div>
  )
}

const primaryBtn: React.CSSProperties = {
  padding: '10px 20px',
  borderRadius: 8,
  border: 'none',
  background: '#3b82f6',
  color: '#fff',
  font: '15px sans-serif',
  cursor: 'pointer',
}
