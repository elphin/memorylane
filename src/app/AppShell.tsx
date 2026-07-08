// App-shell: mount de render-engine, laadt de jaren via de backend en beheert
// de scenes (L0 lifeline ↔ L1 jaar). Transities zijn zoom-gedreven (geen
// terug-knoppen): tik op een jaar → in; ver uitzoomen in een jaar → terug.
// DOM wordt alleen gebruikt voor overlays (loading, first-run, leeg).

import { useEffect, useRef, useState } from 'react'
import type { Backend, Item, SearchResult, YearSummary } from '../lib/backend'
import { createBackend } from '../lib/backend'
import { RenderEngine } from '../render/core/engine'
import { EventScene } from '../render/scenes/event'
import { FocusScene } from '../render/scenes/focus'
import { LifelineScene } from '../render/scenes/lifeline'
import type { Scene } from '../render/scenes/scene'
import { YearScene } from '../render/scenes/year'

type Phase = 'loading' | 'first-run' | 'empty' | 'ready' | 'error'

/** Reveal een nieuwe scene: inzoomen (`in`) groeit uit het aangeklikte punt,
 * uitzoomen (`out`) krimpt vanuit het midden. */
function revealScene(engine: RenderEngine, scene: Scene, dir: 'in' | 'out'): void {
  if (dir === 'in') {
    engine.revealScene(scene.root, 'in', engine.tapScreen.x, engine.tapScreen.y)
  } else {
    engine.revealScene(scene.root, 'out')
  }
}

export function AppShell() {
  const hostRef = useRef<HTMLDivElement>(null)
  const [phase, setPhase] = useState<Phase>('loading')
  const [message, setMessage] = useState('')
  const [uiLevel, setUiLevel] = useState<'lifeline' | 'year' | 'event' | 'focus'>('lifeline')
  const [modal, setModal] = useState<null | 'note' | 'event'>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const searchTimerRef = useRef<number | undefined>(undefined)

  const enterEventRef = useRef<(id: string) => void>(() => {})
  const enterYearRef = useRef<(id: string) => void>(() => {})
  // Re-entrancy-slot voor mutaties: `busy`-state is niet betrouwbaar tegen een
  // dubbele klik binnen dezelfde tick (stale closure) — een ref wel.
  const mutatingRef = useRef(false)

  const engineRef = useRef<RenderEngine | null>(null)
  const backendRef = useRef<Backend | null>(null)
  const sceneRef = useRef<Scene | null>(null)
  const yearsRef = useRef<YearSummary[]>([])
  const levelRef = useRef<'lifeline' | 'year' | 'event' | 'focus'>('lifeline')
  const currentYearRef = useRef<string | null>(null)
  const currentEventRef = useRef<string | null>(null)
  const currentItemsRef = useRef<Item[]>([])
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
      // Oud niveau laat uitzoomen + uitfaden (crossfade), niet hard weg.
      const old = sceneRef.current
      sceneRef.current = null
      if (old) engine.exitScene(old.root, 'out', () => old.destroy())
      const scene = new LifelineScene(engine, backendRef.current, yearsRef.current)
      sceneRef.current = scene
      engine.revealScene(scene.root, 'out')
      levelRef.current = 'lifeline'
      setUiLevel('lifeline')
    }

    const enterYear = async (yearId: string, dir: 'in' | 'out' = 'in'): Promise<void> => {
      if (!engine || !backendRef.current || enteringRef.current) return
      enteringRef.current = true
      const seq = ++enterSeqRef.current
      try {
        const photos = await backendRef.current.getYearPhotos(yearId)
        if (disposed || !engine || seq !== enterSeqRef.current) return
        // Oud niveau meebewegen + uitfaden (crossfade). Móet vóór de nieuwe
        // scene-constructor: die roept jumpCamera en verandert de camera.
        const old = sceneRef.current
        sceneRef.current = null
        if (old) engine.exitScene(old.root, dir, () => old.destroy())
        const scene = new YearScene(engine, backendRef.current, photos)
        sceneRef.current = scene
        revealScene(engine, scene, dir)
        levelRef.current = 'year'
        setUiLevel('year')
        currentYearRef.current = yearId
        entryZoomRef.current = engine.pendingZoom
      } catch (e) {
        if (!disposed) {
          setMessage(String(e))
          setPhase('error')
        }
      } finally {
        enteringRef.current = false
      }
    }

    const enterEvent = async (eventId: string, dir: 'in' | 'out' = 'in'): Promise<void> => {
      if (!engine || !backendRef.current || enteringRef.current) return
      enteringRef.current = true
      const seq = ++enterSeqRef.current
      const backend = backendRef.current
      try {
        const detail = await backend.getEvent(eventId)
        if (disposed || !engine || seq !== enterSeqRef.current || !detail) return
        // Oud niveau meebewegen + uitfaden (crossfade). Vóór de scene-constructor
        // (jumpCamera) zodat de overlay op de oude camera bevriest.
        const old = sceneRef.current
        sceneRef.current = null
        if (old) engine.exitScene(old.root, dir, () => old.destroy())
        const scene = new EventScene(engine, backend, detail, (items) => {
          void backend.saveCanvasLayout(eventId, items).catch((e) => {
            if (!disposed) {
              setMessage(String(e))
              setPhase('error')
            }
          })
        })
        sceneRef.current = scene
        revealScene(engine, scene, dir)
        levelRef.current = 'event'
        setUiLevel('event')
        currentEventRef.current = eventId
        currentItemsRef.current = detail.items
        entryZoomRef.current = engine.pendingZoom
      } catch (e) {
        if (!disposed) {
          setMessage(String(e))
          setPhase('error')
        }
      } finally {
        enteringRef.current = false
      }
    }

    const enterFocus = (itemId: string): void => {
      if (!engine || !backendRef.current) return
      const items = currentItemsRef.current
      const index = items.findIndex((it) => it.id === itemId)
      if (index < 0) return
      enterSeqRef.current++ // eventuele in-flight enter invalideren
      // Oud niveau meebewegen + uitfaden (crossfade), vóór de scene-constructor.
      const old = sceneRef.current
      sceneRef.current = null
      if (old) engine.exitScene(old.root, 'in', () => old.destroy())
      const scene = new FocusScene(engine, backendRef.current, items, index)
      sceneRef.current = scene
      revealScene(engine, scene, 'in')
      levelRef.current = 'focus'
      setUiLevel('focus')
      entryZoomRef.current = engine.pendingZoom
    }

    enterYearRef.current = (id) => void enterYear(id)
    enterEventRef.current = (id) => void enterEvent(id)

    // Eén niveau terug (Esc / uitzoomen).
    const goBack = (): void => {
      if (enteringRef.current) return
      if (levelRef.current === 'year') setupLifeline()
      else if (levelRef.current === 'event' && currentYearRef.current) void enterYear(currentYearRef.current, 'out')
      else if (levelRef.current === 'focus' && currentEventRef.current) void enterEvent(currentEventRef.current, 'out')
    }

    const onKeyDown = (e: KeyboardEvent): void => {
      // Laat invoervelden (composer/zoeken) hun eigen toetsen afhandelen.
      const el = document.activeElement
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return
      if (e.key === 'Escape' || e.key === 'Backspace') {
        e.preventDefault()
        goBack()
      }
    }
    window.addEventListener('keydown', onKeyDown)

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
      ;(window as unknown as { __engine?: RenderEngine }).__engine = engine

      engine.onFrame = (ctx) => {
        sceneRef.current?.update(ctx)
        // Ver uitzoomen → één niveau terug. Niet tijdens een lopende
        // transitie-animatie (dan zit de zoom nog onder de drempel).
        const backThreshold = ctx.engine.camera.zoom < entryZoomRef.current * 0.45
        if (backThreshold && !enteringRef.current && !ctx.engine.isTransitioning) {
          goBack()
        }
      }
      engine.onHover = (wx, wy) => {
        sceneRef.current?.onHover?.(wx, wy)
      }
      engine.onTap = (wx, wy) => {
        // Negeer taps tijdens de reveal: de root is dan geschaald/verschoven,
        // dus een hitTest tegen de (uiteindelijke) wereldcoördinaten zou het
        // verkeerde object raken en ongewild een niveau dieper navigeren.
        if (engine?.isTransitioning) return
        // FocusScene.hitTest verwerkt links/rechts-tik zelf (sibling-nav) en
        // geeft null terug; de andere niveaus navigeren op het geraakte id.
        const hit = sceneRef.current?.hitTest?.(wx, wy)
        if (!hit) return
        if (levelRef.current === 'lifeline') void enterYear(hit)
        else if (levelRef.current === 'year') void enterEvent(hit)
        else if (levelRef.current === 'event') enterFocus(hit)
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
      window.removeEventListener('keydown', onKeyDown)
      if (searchTimerRef.current) window.clearTimeout(searchTimerRef.current)
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

  const submitNote = async (): Promise<void> => {
    const eventId = currentEventRef.current
    const backend = backendRef.current
    if (!eventId || !backend || !draft.trim()) {
      setModal(null)
      return
    }
    setBusy(true)
    try {
      await backend.createTextItem(eventId, null, draft.trim())
      enterEventRef.current(eventId)
      setModal(null)
      setDraft('')
    } catch (e) {
      setMessage(String(e))
      setPhase('error')
    } finally {
      setBusy(false)
    }
  }

  const submitEvent = async (): Promise<void> => {
    const yearId = currentYearRef.current
    const backend = backendRef.current
    if (!yearId || !backend || !draft.trim()) {
      setModal(null)
      return
    }
    setBusy(true)
    try {
      // Lokale datum (niet toISOString/UTC): rond middernacht zou UTC de
      // vorige dag — en op 1 jan zelfs het vorige jaar — kunnen opleveren,
      // wat het event op de verkeerde dag/in het verkeerde jaar zou zetten.
      const now = new Date()
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
        now.getDate(),
      ).padStart(2, '0')}`
      await backend.createEvent(yearId, draft.trim(), today)
      enterYearRef.current(yearId)
      setModal(null)
      setDraft('')
    } catch (e) {
      setMessage(String(e))
      setPhase('error')
    } finally {
      setBusy(false)
    }
  }

  const addPhotos = async (): Promise<void> => {
    const eventId = currentEventRef.current
    const backend = backendRef.current
    if (!eventId || !backend || mutatingRef.current) return
    mutatingRef.current = true
    setBusy(true)
    try {
      const n = await backend.importPhotos(eventId)
      if (n > 0) enterEventRef.current(eventId)
    } catch (e) {
      setMessage(String(e))
      setPhase('error')
    } finally {
      mutatingRef.current = false
      setBusy(false)
    }
  }

  const deleteCurrent = async (): Promise<void> => {
    const backend = backendRef.current
    const id = sceneRef.current?.currentId?.()
    const eventId = currentEventRef.current
    if (!backend || !id || mutatingRef.current) return
    if (!window.confirm('Dit item naar de prullenbak verplaatsen?')) return
    mutatingRef.current = true
    setBusy(true)
    try {
      await backend.deleteItem(id)
      if (eventId) enterEventRef.current(eventId)
    } catch (e) {
      setMessage(String(e))
      setPhase('error')
    } finally {
      mutatingRef.current = false
      setBusy(false)
    }
  }

  const runSearch = (q: string): void => {
    setSearchQuery(q)
    if (searchTimerRef.current) window.clearTimeout(searchTimerRef.current)
    const backend = backendRef.current
    if (!backend) return
    searchTimerRef.current = window.setTimeout(() => {
      void backend
        .search(q)
        .then(setSearchResults)
        .catch(() => setSearchResults([]))
    }, 220)
  }

  const closeSearch = (): void => {
    if (searchTimerRef.current) window.clearTimeout(searchTimerRef.current)
    setSearchOpen(false)
    setSearchQuery('')
    setSearchResults([])
  }

  const openResult = (r: SearchResult): void => {
    currentYearRef.current = r.yearId
    enterEventRef.current(r.eventId)
    closeSearch()
  }

  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <div ref={hostRef} style={{ position: 'absolute', inset: 0 }} />
      {phase !== 'ready' && <Overlay phase={phase} message={message} onPick={() => void pickVault()} />}
      {phase === 'ready' && !modal && !searchOpen && (
        <button onClick={() => setSearchOpen(true)} style={searchBtn} title="Zoeken">
          Zoeken…
        </button>
      )}
      {searchOpen && (
        <SearchPanel
          query={searchQuery}
          results={searchResults}
          onChange={runSearch}
          onPick={openResult}
          onClose={closeSearch}
        />
      )}
      {phase === 'ready' && !modal && (
        <Fab
          uiLevel={uiLevel}
          onAddEvent={() => setModal('event')}
          onAddNote={() => setModal('note')}
          onAddPhotos={() => void addPhotos()}
          onDelete={() => void deleteCurrent()}
        />
      )}
      {modal && (
        <Composer
          kind={modal}
          value={draft}
          busy={busy}
          onChange={setDraft}
          onSubmit={() => void (modal === 'note' ? submitNote() : submitEvent())}
          onCancel={() => {
            setModal(null)
            setDraft('')
          }}
        />
      )}
    </div>
  )
}

function Fab({
  uiLevel,
  onAddEvent,
  onAddNote,
  onAddPhotos,
  onDelete,
}: {
  uiLevel: 'lifeline' | 'year' | 'event' | 'focus'
  onAddEvent: () => void
  onAddNote: () => void
  onAddPhotos: () => void
  onDelete: () => void
}) {
  const wrap: React.CSSProperties = { position: 'absolute', right: 20, bottom: 20, display: 'flex', gap: 10 }
  if (uiLevel === 'year') {
    return (
      <div style={wrap}>
        <button onClick={onAddEvent} style={fabBtn}>+ Nieuw event</button>
      </div>
    )
  }
  if (uiLevel === 'event') {
    return (
      <div style={wrap}>
        <button onClick={onAddPhotos} style={fabBtn}>+ Foto&apos;s</button>
        <button onClick={onAddNote} style={fabBtn}>+ Notitie</button>
      </div>
    )
  }
  if (uiLevel === 'focus') {
    return (
      <div style={wrap}>
        <button onClick={onDelete} style={{ ...fabBtn, background: '#7f1d1d' }}>Verwijder</button>
      </div>
    )
  }
  return null
}

function Composer({
  kind,
  value,
  busy,
  onChange,
  onSubmit,
  onCancel,
}: {
  kind: 'note' | 'event'
  value: string
  busy: boolean
  onChange: (v: string) => void
  onSubmit: () => void
  onCancel: () => void
}) {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div style={{ width: 480, maxWidth: '90%', background: '#161c28', borderRadius: 12, padding: 20 }}>
        <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 12 }}>
          {kind === 'note' ? 'Nieuwe notitie' : 'Nieuw event'}
        </div>
        {kind === 'note' ? (
          <textarea
            autoFocus
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Schrijf een herinnering…"
            style={{ ...field, height: 140, resize: 'vertical' }}
          />
        ) : (
          <input
            autoFocus
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Titel van het event"
            style={field}
          />
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 14 }}>
          <button onClick={onCancel} style={ghostBtn}>Annuleren</button>
          <button onClick={onSubmit} disabled={busy || !value.trim()} style={primaryBtn}>
            {busy ? 'Bezig…' : 'Opslaan'}
          </button>
        </div>
      </div>
    </div>
  )
}

function SearchPanel({
  query,
  results,
  onChange,
  onPick,
  onClose,
}: {
  query: string
  results: SearchResult[]
  onChange: (q: string) => void
  onPick: (r: SearchResult) => void
  onClose: () => void
}) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'absolute',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        justifyContent: 'center',
        paddingTop: 80,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: 560, maxWidth: '92%', background: '#161c28', borderRadius: 12, padding: 16, height: 'fit-content' }}
      >
        <input
          autoFocus
          value={query}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && onClose()}
          placeholder="Zoek in je herinneringen…"
          style={field}
        />
        <div style={{ marginTop: 10, maxHeight: 360, overflowY: 'auto' }}>
          {query.trim() && results.length === 0 && (
            <div style={{ color: '#8a97b0', font: '13px sans-serif', padding: '10px 4px' }}>
              Niets gevonden.
            </div>
          )}
          {query.trim() && results.map((r) => (
            <button
              key={r.itemId}
              onClick={() => onPick(r)}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '10px 12px',
                marginTop: 6,
                borderRadius: 8,
                border: '1px solid #2c3650',
                background: '#0e1420',
                color: '#e6ebf5',
                cursor: 'pointer',
                font: '14px sans-serif',
              }}
            >
              <div style={{ color: '#8a97b0', fontSize: 12, marginBottom: 2 }}>
                {r.eventTitle ?? 'Gebeurtenis'}
              </div>
              {r.snippet}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

const searchBtn: React.CSSProperties = {
  position: 'absolute',
  top: 16,
  left: 16,
  padding: '8px 16px',
  borderRadius: 20,
  border: '1px solid #2c3650',
  background: 'rgba(22,28,40,0.85)',
  color: '#cfd6e4',
  font: '13px sans-serif',
  cursor: 'pointer',
}

const fabBtn: React.CSSProperties = {
  padding: '10px 16px',
  borderRadius: 24,
  border: 'none',
  background: '#3b82f6',
  color: '#fff',
  font: '14px sans-serif',
  cursor: 'pointer',
  boxShadow: '0 4px 14px rgba(0,0,0,0.4)',
}

const field: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '10px 12px',
  borderRadius: 8,
  border: '1px solid #2c3650',
  background: '#0e1420',
  color: '#fff',
  font: '15px sans-serif',
}

const ghostBtn: React.CSSProperties = {
  padding: '8px 16px',
  borderRadius: 8,
  border: '1px solid #2c3650',
  background: 'transparent',
  color: '#cfd6e4',
  cursor: 'pointer',
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
