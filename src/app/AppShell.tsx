// App-shell: mount de render-engine, laadt de jaren via de backend en beheert
// de scenes (L0 lifeline ↔ L1 jaar). Transities zijn zoom-gedreven (geen
// terug-knoppen): tik op een jaar → in; ver uitzoomen in een jaar → terug.
// DOM wordt alleen gebruikt voor overlays (loading, first-run, leeg).

import { useEffect, useRef, useState } from 'react'
import type { Backend, EventInfo, ExifEntry, Item, SearchResult, YearSummary } from '../lib/backend'
import { createBackend } from '../lib/backend'
import { RenderEngine } from '../render/core/engine'
import { EventScene } from '../render/scenes/event'
import type { NodePosition } from '../render/scenes/scene'
import { Screensaver } from './Screensaver'
import { FocusScene } from '../render/scenes/focus'
import { LifelineScene } from '../render/scenes/lifeline'
import type { Scene } from '../render/scenes/scene'
import { YearScene, YEAR_COMMIT_PX } from '../render/scenes/year'

type Phase = 'loading' | 'first-run' | 'empty' | 'ready' | 'error'

interface EventForm {
  mode: 'create' | 'edit'
  eventId?: string
  title: string
  startAt: string
  endAt: string
  /** Belang/grootte (1–100) die de kaartgrootte op de jaar-tijdlijn bepaalt. */
  size?: number
}

/** Drie startwaarden voor het belang van een nieuw event (de gebruiker kan het
 * later op de tijdlijn fijn-afstellen). */
const IMPORTANCE_CHOICES: { size: number; label: string; hint: string }[] = [
  { size: 30, label: 'Gewoon', hint: 'Het onthouden waard' },
  { size: 50, label: 'Bijzonder', hint: 'Echt een bijzonder moment' },
  { size: 70, label: 'Uitzonderlijk', hint: 'Springt eruit in het jaar' },
]

/** Foto-metadata in het bewerk-paneel; mensen/trefwoorden als komma-strings. */
interface MetaForm {
  id: string
  caption: string
  date: string
  place: string
  people: string
  tags: string
  exif: ExifEntry[]
}

/** App-voorkeuren (UI, geen vault-data) — bewaard in localStorage. */
interface Settings {
  /** Weergave waarin een event-canvas standaard opent. */
  defaultLayout: 'custom' | 'grid' | 'scatter'
  /** Rouleren de thumbnails op de jaar-tijdlijn door de foto's (slideshow)? */
  slideshow: boolean
  /** Seconden per foto in de slideshow. */
  slideshowSpeed: number
  /** Vergrendel verticaal pannen op het overzicht (L0) en de jaar-tijdlijn (L1). */
  lockVerticalPan: boolean
  /** View-modus: verberg alle knoppen voor een schone weergave (toets E schakelt). */
  viewMode: boolean
  /** Screensaver-tagfilter: alleen foto's met minstens één van deze tags (komma-gescheiden). */
  screensaverInclude: string
  /** Screensaver-tagfilter: foto's met een van deze tags uitsluiten (komma-gescheiden). */
  screensaverExclude: string
  /** Toon de zoekknop linksboven. Uit? Zoeken kan altijd nog met Ctrl+K. */
  showSearchButton: boolean
  /** Laat de jaar-tegels op het overzicht als slideshow door foto's rouleren. */
  yearTileSlideshow: boolean
  /** Bron voor de jaar-tegel-cover: 'featured' = de uitgelichte foto's van dat
   * jaar, 'random' = alle foto's. */
  yearCoverMode: 'featured' | 'random'
  /** Legt scatter de foto's licht scheef (geroteerd) of recht? */
  scatterRotate: boolean
  /** Toon de naam van een memory bij zijn kaart in de jaar-view. */
  showMemoryTitles: boolean
  /** Teken de lijntjes van de as naar een memory-kaart gebogen (of recht). */
  curvedLeaders: boolean
  /** Snijd foto's in de memory-view naar een vierkant (1:1) bij? Uit = natuurlijke
   * verhouding (de kaart neemt de vorm van de foto over). */
  squarePhotos: boolean
  /** Toon de titel bovenin (Memory Lane / jaar / eventnaam). */
  showTitle: boolean
  /** Bij een detailfoto: toon de caption als titel (indien aanwezig; anders de
   * eventnaam). Uit = altijd de eventnaam. */
  photoTitleFromCaption: boolean
  /** Weergave van de diavoorstelling: 'kenburns' (zoom/pan) of 'crossfade' (stil). */
  diaMode: 'kenburns' | 'crossfade'
  /** Seconden per foto in de diavoorstelling. */
  diaSpeed: number
}

const DEFAULT_SETTINGS: Settings = {
  defaultLayout: 'custom',
  slideshow: true,
  slideshowSpeed: 5,
  lockVerticalPan: false,
  viewMode: false,
  screensaverInclude: '',
  screensaverExclude: '',
  showSearchButton: false,
  yearTileSlideshow: false,
  yearCoverMode: 'featured',
  scatterRotate: true,
  showMemoryTitles: true,
  curvedLeaders: true,
  squarePhotos: false,
  showTitle: true,
  photoTitleFromCaption: false,
  diaMode: 'kenburns',
  diaSpeed: 7,
}
const SETTINGS_KEY = 'memorylane-settings'

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    return raw ? { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) } : DEFAULT_SETTINGS
  } catch {
    return DEFAULT_SETTINGS
  }
}

function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s))
  } catch {
    /* localStorage niet beschikbaar → voorkeuren gelden alleen deze sessie */
  }
}

/** Onthouden weergave per event: de layout-stand, en voor grid/scatter de exacte
 * posities (custom-posities leven in de vault-`_canvas.json`, niet hier). */
type LayoutView = { mode: 'custom' } | { mode: 'grid' | 'scatter'; positions: NodePosition[] }
const EVENTVIEWS_KEY = 'memorylane-eventviews'

/** Valideer één opgeslagen view-record (localStorage kan oud/corrupt zijn). */
function parseView(v: unknown): LayoutView | null {
  if (!v || typeof v !== 'object') return null
  const mode = (v as { mode?: unknown }).mode
  if (mode === 'custom') return { mode: 'custom' }
  if (mode !== 'grid' && mode !== 'scatter') return null
  const raw = (v as { positions?: unknown }).positions
  if (!Array.isArray(raw)) return null
  const positions: NodePosition[] = []
  for (const p of raw) {
    if (
      p &&
      typeof p === 'object' &&
      typeof (p as NodePosition).ref === 'string' &&
      typeof (p as NodePosition).x === 'number' &&
      typeof (p as NodePosition).y === 'number' &&
      typeof (p as NodePosition).rot === 'number' &&
      typeof (p as NodePosition).z === 'number'
    ) {
      positions.push(p as NodePosition)
    }
  }
  return { mode, positions }
}

function loadEventViews(): Record<string, LayoutView> {
  try {
    const raw = localStorage.getItem(EVENTVIEWS_KEY)
    if (!raw) return {}
    const obj = JSON.parse(raw) as Record<string, unknown>
    const out: Record<string, LayoutView> = {}
    for (const [id, v] of Object.entries(obj)) {
      const view = parseView(v)
      if (view) out[id] = view
    }
    return out
  } catch {
    return {}
  }
}

function saveEventView(eventId: string, view: LayoutView): void {
  try {
    const all = loadEventViews()
    all[eventId] = view
    localStorage.setItem(EVENTVIEWS_KEY, JSON.stringify(all))
  } catch {
    /* localStorage niet beschikbaar → view geldt alleen deze sessie */
  }
}

function removeEventView(eventId: string): void {
  try {
    const all = loadEventViews()
    if (!(eventId in all)) return
    delete all[eventId]
    localStorage.setItem(EVENTVIEWS_KEY, JSON.stringify(all))
  } catch {
    /* negeer */
  }
}

/** Schakel echte fullscreen (borderloos, hele monitor). In Tauri via de venster-API,
 * in de browser-dev via de Fullscreen-API. */
async function toggleFullscreen(): Promise<void> {
  try {
    if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      const w = getCurrentWindow()
      await w.setFullscreen(!(await w.isFullscreen()))
    } else if (document.fullscreenElement) {
      await document.exitFullscreen()
    } else {
      await document.documentElement.requestFullscreen()
    }
  } catch {
    /* fullscreen niet beschikbaar → negeren */
  }
}

/** Lokale datum als `YYYY-MM-DD` (niet UTC — voorkomt dag-/jaarverschuiving). */
function todayISO(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

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
  const [modal, setModal] = useState<null | 'note'>(null)
  const [editing, setEditing] = useState<null | { id: string; kind: 'text' | 'photo'; value: string }>(null)
  const [eventForm, setEventForm] = useState<null | EventForm>(null)
  const [metaForm, setMetaForm] = useState<null | MetaForm>(null)
  const [layoutMode, setLayoutMode] = useState<'custom' | 'grid' | 'scatter'>('custom')
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [vaultPath, setVaultPath] = useState<string | null>(null)
  // Titel bovenin: "Memory Lane" (overzicht), het jaar, of de eventnaam. `dir`
  // bepaalt de richting van de zoom/crossfade (in = dieper, out = terug).
  const [header, setHeader] = useState<{ text: string; dir: 'in' | 'out' }>({
    text: 'Memory Lane',
    dir: 'out',
  })
  // Screensaver: null = dicht, anders de (context-afhankelijke) foto-ids.
  const [screensaverIds, setScreensaverIds] = useState<string[] | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  // De zoekknop verbergt na muis-inactiviteit; muisbeweging toont 'm weer. (De ▶-
  // en ⚙-knop blijven altijd staan.)
  const [chromeVisible, setChromeVisible] = useState(true)
  // "Alles passend"-knop: zichtbaar als er inhoud buiten beeld valt (L2).
  const [showFit, setShowFit] = useState(false)
  const showFitRef = useRef(false)
  // Ref-spiegel zodat de (één keer opgezette) engine-closures de actuele
  // voorkeuren lezen zonder stale closure.
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  // Zelfde truc voor `phase`: de globale key-closure (Ctrl+K) leest de actuele fase.
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  // Zodat de toets-closure (sneltoets S) de diavoorstelling kan starten.
  const startScreensaverRef = useRef<() => void>(() => {})

  // Titel bij een detailfoto: caption (indien de instelling aan is én er een
  // caption is), anders de eventnaam. Zo krijg je zonder caption geen rare
  // bestandsnamen, maar netjes de eventnaam.
  const focusTitleFor = (item: Item | undefined): string => {
    const cap = item?.caption?.trim()
    if (settingsRef.current.photoTitleFromCaption && cap) return cap
    const info = currentEventInfoRef.current
    return info ? info.title || info.startAt : 'Memory Lane'
  }

  const updateSettings = (patch: Partial<Settings>): void => {
    const next = { ...settingsRef.current, ...patch }
    settingsRef.current = next
    setSettings(next)
    saveSettings(next)
    applyPanLockRef.current() // pan-lock meteen toepassen op het huidige niveau
    // Jaar-tegel-slideshow leeft in de scene → herbouw de lifeline als die zichtbaar is.
    if (
      (patch.yearTileSlideshow !== undefined ||
        patch.yearCoverMode !== undefined ||
        patch.slideshowSpeed !== undefined) &&
      levelRef.current === 'lifeline'
    ) {
      setupLifelineRef.current()
    }
    // Memory-titels + leader-stijl leven in de jaar-scene → herbouw het jaar.
    if (
      (patch.showMemoryTitles !== undefined || patch.curvedLeaders !== undefined) &&
      levelRef.current === 'year' &&
      currentYearRef.current
    ) {
      void enterYearRef.current(currentYearRef.current)
    }
    // Foto-verhouding leeft in de event-scene → herbouw het event als het open is.
    if (patch.squarePhotos !== undefined && levelRef.current === 'event' && currentEventRef.current) {
      void enterEventRef.current(currentEventRef.current)
    }
  }

  // Sneltoetsen op een kale letter: E = view-modus (knoppen tonen/verbergen),
  // S = diavoorstelling starten. (Geen Ctrl/Alt/Meta; niet in een invoerveld of
  // onder een open dialog/overlay.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // F11: echte fullscreen aan/uit — werkt overal (ook in invoervelden).
      if (e.key === 'F11') {
        e.preventDefault()
        void toggleFullscreen()
        return
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const el = document.activeElement
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return
      if (dialogOpenRef.current || overlayOpenRef.current) return
      if (e.key === 'e' || e.key === 'E') {
        e.preventDefault()
        updateSettings({ viewMode: !settingsRef.current.viewMode })
      } else if (e.key === 's' || e.key === 'S') {
        e.preventDefault()
        startScreensaverRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
  // Staat er een blokkerende DOM-dialog open? De canvas-gestures (in een closure
  // die maar één keer draait) kunnen de React-state niet stale-vrij lezen; deze
  // ref wel. Voorkomt dat een Ctrl-sleep een half-ingevulde dialog stil overschrijft.
  const dialogOpenRef = useRef(false)
  // Staat er een DOM-overlay zónder eigen invoerveld open (instellingen/zoeken)?
  // De globale key-handler (Esc/Backspace → goBack) draait in de mount-closure en
  // moet dan niets navigeren onder de overlay. De INPUT/TEXTAREA-guard dekt dit
  // niet: het instellingen-paneel heeft geen invoerveld, dus focus zit op een knop.
  const overlayOpenRef = useRef(false)

  const engineRef = useRef<RenderEngine | null>(null)
  const backendRef = useRef<Backend | null>(null)
  const sceneRef = useRef<Scene | null>(null)
  const yearsRef = useRef<YearSummary[]>([])
  const levelRef = useRef<'lifeline' | 'year' | 'event' | 'focus'>('lifeline')
  const currentYearRef = useRef<string | null>(null)
  const currentEventRef = useRef<string | null>(null)
  const currentEventInfoRef = useRef<EventInfo | null>(null)
  const currentYearCoverRef = useRef<string | null>(null) // item-id van de jaar-cover
  const currentItemsRef = useRef<Item[]>([])
  const entryZoomRef = useRef(1)
  const enterSeqRef = useRef(0)
  const enteringRef = useRef(false)
  const applyPanLockRef = useRef<() => void>(() => {})
  // Zodat instellingen (jaar-tegel-slideshow) de lifeline live kunnen herbouwen.
  const setupLifelineRef = useRef<() => void>(() => {})

  useEffect(() => {
    let engine: RenderEngine | null = null
    let disposed = false
    let ctrlDown = false // Ctrl ingedrukt → dag-indicator op de jaar-tijdlijn
    // Zet door de Ctrl-sleep-handle bij `end()`; door de eropvolgende `onTap`
    // geconsumeerd. Zo wordt de tap ná een Ctrl-sleep/klik betrouwbaar onderdrukt,
    // óók als de gebruiker Ctrl losliet tussen pointerdown en pointerup (dan is
    // `ctrlDown` al false en zou de tap anders alsnog navigeren + dubbel openen).
    let rangeJustEnded = false

    const setupLifeline = (): void => {
      if (!engine || !backendRef.current) return
      // Invalideer een eventuele in-flight enterYear.
      enterSeqRef.current++
      // Oud niveau laat uitzoomen + uitfaden (crossfade), niet hard weg.
      const old = sceneRef.current
      sceneRef.current = null
      if (old) engine.exitScene(old.root, 'out', () => old.destroy())
      const scene = new LifelineScene(engine, backendRef.current, yearsRef.current, {
        enabled: settingsRef.current.yearTileSlideshow,
        mode: settingsRef.current.yearCoverMode,
        speedMs: settingsRef.current.slideshowSpeed * 1000,
      })
      sceneRef.current = scene
      engine.revealScene(scene.root, 'out')
      levelRef.current = 'lifeline'
      setUiLevel('lifeline')
      setHeader({ text: 'Memory Lane', dir: 'out' })
      applyPanLock()
    }
    setupLifelineRef.current = setupLifeline

    const enterYear = async (
      yearId: string,
      dir: 'in' | 'out' | 'slideNext' | 'slidePrev' = 'in',
    ): Promise<void> => {
      if (!engine || !backendRef.current || enteringRef.current) return
      enteringRef.current = true
      const seq = ++enterSeqRef.current
      // Zijwaartse jaar-overgang (+1 = nieuwe jaar komt van rechts): oude scene
      // schuift de andere kant uit, nieuwe schuift van deze kant in.
      const slide = dir === 'slideNext' || dir === 'slidePrev'
      const slideDir = dir === 'slideNext' ? 1 : -1
      try {
        const detail = await backendRef.current.getYear(yearId)
        if (disposed || !engine || seq !== enterSeqRef.current || !detail) return
        // Oud niveau meebewegen + uitfaden (crossfade). Móet vóór de nieuwe
        // scene-constructor: die roept jumpCamera en verandert de camera.
        const old = sceneRef.current
        sceneRef.current = null
        if (old) {
          // Jaar-entry/-exit zoomt symmetrisch door het SCHERMMIDDEN (net als het
          // uitzoomen naar de lifeline), niet vanaf de aangeklikte jaar-tegel.
          // Dit hoort bij de gecentreerde reveal hieronder: exit `centered=true`
          // + reveal zonder tap-coördinaten moeten altijd samen wijzigen.
          if (slide) engine.slideOutScene(old.root, -slideDir, () => old.destroy())
          else engine.exitScene(old.root, dir as 'in' | 'out', () => old.destroy(), undefined, true)
        }
        // Buurjaren (voor de overscroll-preview + jaar-overgang): de jarenlijst is
        // chronologisch oplopend → later jaar = rechts, eerder = links.
        const yi = yearsRef.current.findIndex((y) => y.id === yearId)
        const neighbors = {
          prev: yi > 0 ? yearsRef.current[yi - 1]?.title : undefined,
          next: yi >= 0 && yi < yearsRef.current.length - 1 ? yearsRef.current[yi + 1]?.title : undefined,
        }
        const scene = new YearScene(engine, backendRef.current, detail, {
          enabled: settingsRef.current.slideshow,
          speedMs: settingsRef.current.slideshowSpeed * 1000,
          showTitles: settingsRef.current.showMemoryTitles,
          curvedLeaders: settingsRef.current.curvedLeaders,
          neighbors,
        })
        sceneRef.current = scene
        // De scene-constructor heeft de camera al naar het nieuwe jaar gezet
        // (jumpCamera). Peg de elastische rauwe positie daarop, zodat een
        // overgebleven overscroll (van een jaar-slide-commit) de camera niet
        // laat terugveren tíjdens de slide — anders sleept dat de nieuwe tijdlijn
        // zichtbaar de verkeerde kant op i.p.v. schoon van opzij in te schuiven.
        engine.syncElastic()
        if (ctrlDown) scene.setDayPicker(true)
        // Gecentreerde reveal (geen tap-coördinaten → schermmidden): spiegelt de
        // gecentreerde exit hierboven, zodat een jaar in-/uitzoomen altijd vanuit
        // het midden gebeurt i.p.v. vanaf de aangeklikte tegel (zie comment boven).
        if (slide) engine.slideInScene(scene.root, slideDir)
        else engine.revealScene(scene.root, dir as 'in' | 'out')
        levelRef.current = 'year'
        setUiLevel('year')
        setHeader({ text: detail.year.title, dir: slide ? 'in' : (dir as 'in' | 'out') })
        applyPanLock()
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

    // Open een net gebouwde event-scene in de globale standaard-weergave, en
    // bevries een (willekeurige) scatter meteen zodat terugkeren 'm herstelt.
    const applyDefaultView = (scene: EventScene, eventId: string): void => {
      const dl = settingsRef.current.defaultLayout
      if (dl !== 'custom') {
        scene.applyLayout(dl, true, settingsRef.current.scatterRotate) // snap: geen inklap-animatie bij binnenkomst
        setLayoutMode(dl)
        saveEventView(eventId, { mode: dl, positions: scene.layoutState().positions })
      } else {
        setLayoutMode('custom')
      }
    }

    // Herstel de onthouden weergave van dit event (of val terug op de standaard).
    const initEventView = (scene: EventScene, eventId: string): void => {
      const saved = loadEventViews()[eventId]
      if (!saved) {
        applyDefaultView(scene, eventId)
        return
      }
      if (saved.mode === 'custom') {
        // Custom-posities komen uit de vault (_canvas.json); scene staat er al op.
        setLayoutMode('custom')
        return
      }
      const { matched, total } = scene.applyPositions(saved.mode, saved.positions, true)
      if (matched === 0) {
        // Alle refs verouderd (bv. hernoemd/verwijderd) → weggooien, standaard tonen.
        removeEventView(eventId)
        applyDefaultView(scene, eventId)
        return
      }
      setLayoutMode(saved.mode)
      // Wijkt de node-set af van de snapshot (item toegevoegd → matched<total, of
      // verwijderd → snapshot bevat een verweesde ref)? Onthoud de opgeschoonde
      // opstelling, zodat dode refs niet blijven hangen.
      if (matched < total || matched < saved.positions.length) {
        saveEventView(eventId, { mode: saved.mode, positions: scene.layoutState().positions })
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
        const scene = new EventScene(
          engine,
          backend,
          detail,
          (items) => {
            void backend.saveCanvasLayout(eventId, items).catch((e) => {
              if (!disposed) {
                setMessage(String(e))
                setPhase('error')
              }
            })
          },
          (state) => {
            // Drag in grid/scatter → onthoud de view. Alleen als dit nog het
            // actieve event is (geen stale write na snel wegnavigeren).
            if (currentEventRef.current !== eventId) return
            saveEventView(
              eventId,
              state.mode === 'custom' ? { mode: 'custom' } : { mode: state.mode, positions: state.positions },
            )
          },
          settingsRef.current.squarePhotos,
        )
        sceneRef.current = scene
        // Open in de onthouden weergave van dit event (vóór de reveal, zodat de
        // camera-fit meteen klopt); valt terug op de globale standaard.
        initEventView(scene, eventId)
        revealScene(engine, scene, dir)
        levelRef.current = 'event'
        setUiLevel('event')
        setHeader({ text: detail.event.title || detail.event.startAt, dir })
        applyPanLock()
        currentEventRef.current = eventId
        currentEventInfoRef.current = detail.event
        currentYearCoverRef.current = detail.yearCover ?? null
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
      const scene = new FocusScene(engine, backendRef.current, items, index, (delta, id) => {
        // Titel meelaten lopen bij stappen (tik óf pijltjestoets).
        const it = id ? currentItemsRef.current.find((x) => x.id === id) : undefined
        setHeader({ text: focusTitleFor(it), dir: delta > 0 ? 'in' : 'out' })
      })
      sceneRef.current = scene
      revealScene(engine, scene, 'in')
      levelRef.current = 'focus'
      setUiLevel('focus')
      setHeader({ text: focusTitleFor(items[index]), dir: 'in' })
      applyPanLock()
      entryZoomRef.current = engine.pendingZoom
    }

    enterYearRef.current = (id) => void enterYear(id)
    enterEventRef.current = (id) => void enterEvent(id)

    // Verticale-pan-lock toepassen op basis van niveau + instelling (alleen de
    // horizontale niveaus L0/L1).
    const applyPanLock = (): void => {
      if (!engine) return
      const lvl = levelRef.current
      // De jaar-view rekent kaart-posities t.o.v. een verticaal gecentreerde as
      // (camera.y=0), dus daar staat de verticale lock ALTIJD aan (los van de
      // instelling). Op de lifeline volgt de lock de instelling.
      engine.camera.lockY =
        lvl === 'year' || (settingsRef.current.lockVerticalPan && lvl === 'lifeline')
      // Bij een actieve lock de as/inhoud precies verticaal centreren (y=0).
      if (engine.camera.lockY) engine.camera.y = 0
    }
    applyPanLockRef.current = applyPanLock

    // Eén niveau terug (Esc / uitzoomen).
    const goBack = (): void => {
      if (enteringRef.current) return
      if (levelRef.current === 'year') setupLifeline()
      else if (levelRef.current === 'event' && currentYearRef.current) void enterYear(currentYearRef.current, 'out')
      else if (levelRef.current === 'focus' && currentEventRef.current) void enterEvent(currentEventRef.current, 'out')
    }

    // Ctrl+klik op een foto (L2): togglet de uitgelichte foto (jaar-omslag).
    // Optimistisch: markering + info meteen bij, schrijf async weg.
    const toggleFeatured = (ref: string): void => {
      const backend = backendRef.current
      const eventId = currentEventRef.current
      if (!backend || !eventId) return
      const current = currentEventInfoRef.current?.featuredPhoto ?? null
      const next = current === ref ? null : ref
      if (currentEventInfoRef.current) {
        currentEventInfoRef.current = { ...currentEventInfoRef.current, featuredPhoto: next ?? undefined }
      }
      sceneRef.current?.setFeatured?.(next)
      void backend.setFeatured(eventId, next).catch((e) => {
        setMessage(String(e))
        setPhase('error')
      })
    }

    // Ctrl+Shift-klik: prik/loskoppel de VASTE jaar-cover (max één per jaar). De pin
    // gebeurt op item-id; het jaar komt betrouwbaar uit het event zelf (yearId).
    const toggleYearCover = (ref: string): void => {
      const backend = backendRef.current
      const info = currentEventInfoRef.current
      if (!backend || !info) return
      const item = currentItemsRef.current.find((it) => (it.slug ?? it.id) === ref)
      if (!item) return
      const next = currentYearCoverRef.current === item.id ? null : item.id
      currentYearCoverRef.current = next
      sceneRef.current?.setYearFeatured?.(next)
      void backend
        .setYearCover(info.yearId, next)
        .then(async () => {
          // Zodat de lifeline-tegel bij terugkeer de nieuwe cover toont.
          yearsRef.current = await backend.listYears()
        })
        .catch((e) => {
          setMessage(String(e))
          setPhase('error')
        })
    }

    const onKeyDown = (e: KeyboardEvent): void => {
      // Laat invoervelden (composer/zoeken) hun eigen toetsen afhandelen.
      const el = document.activeElement
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return
      // Een open DOM-overlay (instellingen/zoeken) vangt Esc/Backspace zelf af —
      // niet navigeren onder de overlay.
      if (overlayOpenRef.current) return
      if (e.key === 'Escape' || e.key === 'Backspace') {
        e.preventDefault()
        goBack()
      }
    }
    window.addEventListener('keydown', onKeyDown)

    // Ctrl (in-/uitdrukken) toont/verbergt de dag-indicator op de jaar-tijdlijn.
    const onCtrlKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Control' && e.key !== 'Shift') return
      if (e.key === 'Control') {
        const down = e.type === 'keydown'
        if (ctrlDown !== down) {
          ctrlDown = down
          if (levelRef.current === 'year') sceneRef.current?.setDayPicker?.(down)
        }
      }
      // Event-canvas: featured-randen (goud = Ctrl, blauw jaar-cover = Ctrl+Shift)
      // tonen zolang de toets(en) ingedrukt zijn.
      if (levelRef.current === 'event') sceneRef.current?.setRingKeys?.(e.ctrlKey, e.shiftKey)
    }
    window.addEventListener('keydown', onCtrlKey)
    window.addEventListener('keyup', onCtrlKey)

    // Vensterfocus verliezen (bijv. Alt-Tab met Ctrl ingedrukt) → de keyup mist,
    // waardoor de indicator/tap-modus "aan" zou blijven. Reset op blur.
    const onBlur = (): void => {
      if (levelRef.current === 'event') sceneRef.current?.setRingKeys?.(false, false)
      if (!ctrlDown) return
      ctrlDown = false
      if (levelRef.current === 'year') sceneRef.current?.setDayPicker?.(false)
    }
    window.addEventListener('blur', onBlur)

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
        // Buiten de jaar-view geen elastische scroll-grens (de jaar-scene zet 'm
        // elke frame; andere niveaus zouden anders een stale grens erven).
        if (levelRef.current !== 'year') ctx.engine.camera.boundsX = null
        // "Alles passend"-knop tonen zodra er inhoud buiten beeld valt (alleen L2,
        // niet tijdens een transitie). Alleen setState bij een echte verandering.
        const cb =
          levelRef.current === 'event' && !ctx.engine.isTransitioning
            ? sceneRef.current?.contentBounds?.()
            : null
        let show = false
        if (cb) {
          const wb = ctx.engine.camera.worldBounds(ctx.engine.viewport())
          const M = 4 // kleine marge tegen randgevallen/afronding
          show =
            cb.minX < wb.minX - M ||
            cb.maxX > wb.maxX + M ||
            cb.minY < wb.minY - M ||
            cb.maxY > wb.maxY + M
        }
        if (show !== showFitRef.current) {
          showFitRef.current = show
          setShowFit(show)
        }
        // Ver uitzoomen → één niveau terug. Niet tijdens een lopende
        // transitie-animatie (dan zit de zoom nog onder de drempel). In L3 volgt
        // de referentie de scene (sibling-nav herfit de camera), zodat stappen
        // naar een grotere notitie niet meteen als "terug" telt.
        const refZoom = sceneRef.current?.baseZoom ?? entryZoomRef.current
        // Op de jaar-view is inzoomen het hoofdgebaar (de tijd-as rekt uit); onder
        // de fit-zoom is er niets zinnigs te zien, dus daar volstaat een drempel
        // dicht bij de fit (uitzoomen onder het overzicht = terug). Op andere
        // niveaus blijft de ruimere 0.45-drempel.
        const backMult = levelRef.current === 'year' ? 0.7 : 0.45
        const backThreshold = ctx.engine.camera.zoom < refZoom * backMult
        if (backThreshold && !enteringRef.current && !ctx.engine.isTransitioning) {
          goBack()
        }
        // Jaar-overgang: bewust doortrekken (vinger neer) voorbij de grens tot de
        // buurjaar-naam vol is → schuif naar dat jaar. Alleen bij een aangehouden
        // pull (isDragging), nooit via inertie/flick.
        else if (
          levelRef.current === 'year' &&
          !enteringRef.current &&
          !ctx.engine.isTransitioning &&
          ctx.engine.isDragging() &&
          Math.abs(ctx.engine.camera.overscrollPx) >= YEAR_COMMIT_PX
        ) {
          const over = ctx.engine.camera.overscrollPx
          const yi = yearsRef.current.findIndex((y) => y.id === currentYearRef.current)
          const target = yi < 0 ? undefined : over > 0 ? yearsRef.current[yi + 1] : yearsRef.current[yi - 1]
          if (target) {
            ctx.engine.endDrag() // stop de drag zodat de slide niet meegepand wordt
            void enterYear(target.id, over > 0 ? 'slideNext' : 'slidePrev')
          }
        }
      }
      engine.onHover = (wx, wy) => {
        const scene = sceneRef.current
        scene?.onHover?.(wx, wy)
        // Pointer-cursor zodra je boven een klikbaar object hangt (kaart/tegel/item).
        const hit = wx === null ? null : (scene?.hitTest?.(wx, wy) ?? null)
        engineRef.current?.setCursor(hit ? 'pointer' : '')
      }
      // Sleep-dispatcher: op de jaar-tijdlijn met Ctrl = een datum-range slepen
      // (begin→eind) i.p.v. de camera pannen; anders delegeren naar de scene
      // (bijv. een canvas-item slepen op L2).
      engine.beginDrag = (wx, wy, mods) => {
        // Elke nieuwe pointerdown gaat hier langs (ook een gewone klik → null).
        // Reset de tap-onderdrukking, zodat een blijvende `true` van een vorige
        // ≥6px Ctrl-sleep (waar géén onTap op volgde) niet de volgende klik slikt.
        rangeJustEnded = false
        // View-modus = alleen kijken. Geen enkele bewerk-sleep: geen foto
        // verplaatsen (L2), roteren/schalen, event-resize, uitgelicht zetten of
        // datum-range trekken. Val terug op `null` → de gesture-controller pant
        // dan gewoon de camera. Tikken (navigeren tussen niveaus) blijft werken.
        if (settingsRef.current.viewMode) return null
        const scene = sceneRef.current
        // Geen nieuwe Ctrl-range starten terwijl er al een dialog open staat —
        // anders zou de sleep die half-ingevulde dialog stil overschrijven.
        if (
          levelRef.current === 'year' &&
          ctrlDown &&
          !dialogOpenRef.current &&
          scene?.dateAt &&
          scene.setRange
        ) {
          const startWX = wx
          let endWX = wx
          scene.setRange(startWX, startWX)
          return {
            moveTo: (mx: number) => {
              endWX = mx
              scene.setRange?.(startWX, endWX)
            },
            end: () => {
              scene.setRange?.(null, null)
              // De gesture-controller roept ná deze end() bij <6px nog onTap aan;
              // markeer dat zodat die tap (klik óf sleep) niet óók navigeert.
              rangeJustEnded = true
              const a = Math.min(startWX, endWX)
              const b = Math.max(startWX, endWX)
              const startDate = scene.dateAt!(a)
              const endDate = scene.dateAt!(b)
              setEventForm({
                mode: 'create',
                title: '',
                startAt: startDate,
                endAt: startDate === endDate ? '' : endDate,
              })
            },
            // Afgebroken (pointercancel of onderbroken door een tweede vinger):
            // alleen de band opruimen, NIET committen — geen dialog openen. De
            // vlag blijft gezet zodat een eventuele naloop-tap niet navigeert.
            cancel: () => {
              scene.setRange?.(null, null)
              rangeJustEnded = true
            },
          }
        }
        // Ctrl op het event-canvas: een foto (de)selecteren als uitgelichte
        // (jaar-omslag). Via een handle zodat Ctrl bij pointerdown "vastgezet"
        // wordt (robuust als Ctrl tussen down en up wordt losgelaten), en geen
        // item-drag start. `end()` togglet en onderdrukt de naloop-tap→L3.
        if (levelRef.current === 'event' && ctrlDown && scene?.refAt) {
          const ref = scene.refAt(wx, wy)
          const yearPin = mods.shift // Ctrl+Shift = vaste jaar-cover i.p.v. event-cover
          return {
            moveTo: () => {},
            end: () => {
              rangeJustEnded = true
              if (ref) {
                if (yearPin) toggleYearCover(ref)
                else toggleFeatured(ref)
              }
            },
            cancel: () => {
              rangeJustEnded = true
            },
          }
        }
        // Alt-slepen = roteren, Shift-slepen = schalen (een zelf-geplaatste foto op
        // het event-canvas). Valt terug op een gewone sleep als er niets te pakken is.
        if (levelRef.current === 'event' && (mods.alt || mods.shift) && scene?.beginTransform) {
          const h = scene.beginTransform(wx, wy, mods.alt ? 'rotate' : 'scale')
          if (h) {
            // Onderdruk de naloop-tap (→L3) na een transform (ook bij een mini-beweging).
            return {
              moveTo: h.moveTo,
              end: () => {
                rangeJustEnded = true
                h.end()
              },
              cancel: () => {
                rangeJustEnded = true
                h.cancel?.()
              },
            }
          }
        }
        // Shift-slepen op de jaar-tijdlijn = het belang (grootte) van een event
        // bijstellen. Valt terug op een camera-pan als er geen kaart geraakt is.
        if (levelRef.current === 'year' && mods.shift && scene?.beginResize) {
          const h = scene.beginResize(wx, wy)
          if (h) {
            return {
              moveTo: h.moveTo,
              // Onderdruk de naloop-tap (→L2) na een resize, ook bij een mini-beweging.
              end: () => {
                rangeJustEnded = true
                h.end()
              },
              cancel: () => {
                rangeJustEnded = true
                h.cancel?.()
              },
            }
          }
        }
        return scene?.beginDrag?.(wx, wy) ?? null
      }
      engine.onTap = (wx, wy) => {
        // Negeer taps tijdens de transitie: de root is dan geschaald/verschoven,
        // dus een hitTest tegen de (uiteindelijke) wereldcoördinaten zou het
        // verkeerde object raken en ongewild navigeren.
        if (engine?.isTransitioning) return
        const scene = sceneRef.current
        const level = levelRef.current

        // Ctrl op de jaar-tijdlijn wordt volledig door de sleep-handle afgehandeld
        // (klik = één datum via end(), sleep = range) — hier niets doen, anders
        // zou een Ctrl+klik óók navigeren of dubbel een event maken. We kijken
        // naar `rangeJustEnded` (gezet in de handle) i.p.v. alleen de live
        // `ctrlDown`: Ctrl kan losgelaten zijn tussen down en up, maar de handle
        // liep al en opende de dialog — dan mag deze tap niet alsnog navigeren.
        if (rangeJustEnded) {
          rangeJustEnded = false
          return
        }
        if (level === 'year' && ctrlDown) return

        const hit = scene?.hitTest?.(wx, wy) ?? null

        // L3-focus: klik óp de foto = vorige/volgende (linker-/rechterhelft),
        // klik ernáást (lege ruimte) = uitzoomen naar het canvas.
        if (level === 'focus') {
          // step() laat de titel via de onStep-callback meelopen.
          if (hit) scene?.step?.(wx >= 0 ? 1 : -1)
          else goBack()
          return
        }

        // L1/L2: klik óp een item = een niveau dieper.
        if (hit) {
          if (level === 'lifeline') void enterYear(hit)
          else if (level === 'year') void enterEvent(hit)
          else if (level === 'event') enterFocus(hit)
          return
        }
        // Klik naast een item = een niveau uitzoomen (lifeline is de top → niets).
        if (level !== 'lifeline') goBack()
      }

      try {
        const path = await backendRef.current.getVaultPath()
        if (disposed) return
        setVaultPath(path)
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
      window.removeEventListener('keydown', onCtrlKey)
      window.removeEventListener('keyup', onCtrlKey)
      window.removeEventListener('blur', onBlur)
      if (searchTimerRef.current) window.clearTimeout(searchTimerRef.current)
      sceneRef.current?.destroy()
      sceneRef.current = null
      engine?.destroy()
      engineRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Houd de gesture-closure op de hoogte of er een blokkerende dialog open staat.
  useEffect(() => {
    dialogOpenRef.current = !!(modal || editing || eventForm || metaForm)
  }, [modal, editing, eventForm, metaForm])

  // Houd de key-closure op de hoogte of een invoerloze overlay open staat. De
  // screensaver hoort hier ook bij: dan slaan de globale Esc/'e'-handlers zichzelf
  // over en navigeert er niets onder de screensaver.
  useEffect(() => {
    overlayOpenRef.current = settingsOpen || searchOpen || screensaverIds !== null
  }, [settingsOpen, searchOpen, screensaverIds])

  // Korte toast (bijv. "geen foto's gevonden") die vanzelf verdwijnt.
  useEffect(() => {
    if (!toast) return
    const t = window.setTimeout(() => setToast(null), 2600)
    return () => window.clearTimeout(t)
  }, [toast])

  // Ctrl/Cmd+K opent altijd zoeken — ook als de zoekknop verborgen is.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        if (dialogOpenRef.current || overlayOpenRef.current) return
        if (phaseRef.current === 'ready') setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Verberg de zoekknop na ~4s zonder muisbeweging; muisbeweging toont 'm weer.
  // Tijdens de diavoorstelling niet actief (die dekt het scherm volledig af).
  useEffect(() => {
    if (screensaverIds !== null) return
    setChromeVisible(true)
    let timer = 0
    const schedule = (): void => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setChromeVisible(false), 4000)
    }
    const onMove = (): void => {
      setChromeVisible(true) // React bailt uit als de waarde al true is
      schedule()
    }
    window.addEventListener('mousemove', onMove)
    schedule()
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('mousemove', onMove)
    }
  }, [screensaverIds])

  // Herbouw het overzicht (lifeline) uit de huidige backend-staat — na een
  // vault-wissel of herindexering.
  const rebuildLifeline = async (): Promise<void> => {
    const backend = backendRef.current
    const engine = engineRef.current
    if (!backend || !engine) return
    const years = await backend.listYears()
    yearsRef.current = years
    setVaultPath(await backend.getVaultPath())
    if (years.length > 0) {
      sceneRef.current?.destroy()
      sceneRef.current = new LifelineScene(engine, backend, years, {
        enabled: settingsRef.current.yearTileSlideshow,
        mode: settingsRef.current.yearCoverMode,
        speedMs: settingsRef.current.slideshowSpeed * 1000,
      })
      levelRef.current = 'lifeline'
      setUiLevel('lifeline')
      setHeader({ text: 'Memory Lane', dir: 'out' })
      setPhase('ready')
    } else {
      setPhase('empty')
    }
  }

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
      await rebuildLifeline()
    } catch (e) {
      setMessage(String(e))
      setPhase('error')
    }
  }

  // Beheer: index herberekenen (scan de vault opnieuw).
  const reindexVault = async (): Promise<void> => {
    const backend = backendRef.current
    if (!backend) return
    setSettingsOpen(false)
    setPhase('loading')
    try {
      await backend.reindex()
      await rebuildLifeline()
    } catch (e) {
      setMessage(String(e))
      setPhase('error')
    }
  }

  // Beheer: alle app-instellingen (localStorage) terug naar standaard — foto's en
  // de vault blijven ongemoeid.
  const resetAppSettings = (): void => {
    try {
      localStorage.removeItem(SETTINGS_KEY)
      localStorage.removeItem(EVENTVIEWS_KEY)
    } catch {
      /* negeren */
    }
    settingsRef.current = DEFAULT_SETTINGS
    setSettings(DEFAULT_SETTINGS)
    applyPanLockRef.current()
    setToast('App-instellingen teruggezet naar standaard.')
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

  // Nieuw event: default-startdatum = het jaar waarin we zitten (of vandaag).
  const openNewEvent = (): void => {
    const yearNum = yearsRef.current.find((y) => y.id === currentYearRef.current)?.year
    const startAt = yearNum ? `${yearNum}-01-01` : todayISO()
    setEventForm({ mode: 'create', title: '', startAt, endAt: '', size: 50 })
  }

  // Start de diavoorstelling met een context-afhankelijke foto-set: op het overzicht
  // alle foto's, in een jaar die van dat jaar, in een event alleen die van het
  // event. Tag-filter (include/exclude) uit de instellingen.
  const startScreensaver = async (): Promise<void> => {
    const backend = backendRef.current
    if (!backend) return
    let scopeKind: 'all' | 'year' | 'event' = 'all'
    let scopeId: string | null = null
    const lvl = levelRef.current
    if (lvl === 'year') {
      scopeKind = 'year'
      scopeId = currentYearRef.current
    } else if (lvl === 'event' || lvl === 'focus') {
      scopeKind = 'event'
      scopeId = currentEventRef.current
    }
    const parse = (s: string): string[] => s.split(',').map((t) => t.trim()).filter(Boolean)
    const include = parse(settingsRef.current.screensaverInclude)
    const exclude = parse(settingsRef.current.screensaverExclude)
    try {
      const ids = await backend.getScreensaverPhotos(scopeKind, scopeId, include, exclude)
      if (ids.length === 0) {
        setToast('Geen foto’s voor de diavoorstelling (check eventueel de tag-filters).')
        return
      }
      setSettingsOpen(false)
      setScreensaverIds(ids)
    } catch (e) {
      setToast(String(e))
    }
  }
  startScreensaverRef.current = () => void startScreensaver()

  const changeLayout = (mode: 'custom' | 'grid' | 'scatter'): void => {
    setLayoutMode(mode)
    const scene = sceneRef.current
    scene?.applyLayout?.(mode, false, settingsRef.current.scatterRotate)
    // Onthoud de view per event. Grid/scatter: de zojuist gezette doelposities.
    const id = currentEventRef.current
    const state = scene?.layoutState?.()
    if (id && state) {
      saveEventView(id, mode === 'custom' ? { mode: 'custom' } : { mode, positions: state.positions })
    }
  }

  // Toggle of scatter foto's licht scheef legt. Zit je nu in scatter, pas het dan
  // meteen toe (posities blijven, alleen de rotatie wijzigt) en onthoud de view.
  const toggleScatterRotate = (): void => {
    const next = !settingsRef.current.scatterRotate
    updateSettings({ scatterRotate: next })
    if (layoutMode === 'scatter') {
      sceneRef.current?.setScatterRotation?.(next)
      const id = currentEventRef.current
      const state = sceneRef.current?.layoutState?.()
      if (id && state) saveEventView(id, { mode: 'scatter', positions: state.positions })
    }
  }

  // Legt de huidige (scatter/grid/gesleepte) opstelling vast als de eigen layout.
  const saveLayoutAsCustom = (): void => {
    sceneRef.current?.saveAsCustom?.()
    setLayoutMode('custom')
    const id = currentEventRef.current
    if (id) saveEventView(id, { mode: 'custom' })
  }

  const openEditEvent = (): void => {
    const info = currentEventInfoRef.current
    if (!info) return
    setEventForm({
      mode: 'edit',
      eventId: info.id,
      title: info.title ?? '',
      startAt: info.startAt,
      endAt: info.endAt ?? '',
      // Seed het huidige belang zodat de rating de juiste bucket voorselecteert
      // (undefined = standaard 50, tonen we als "Bijzonder").
      size: info.size,
    })
  }

  const submitEventForm = async (): Promise<void> => {
    const backend = backendRef.current
    const f = eventForm
    if (!backend || !f || !f.title.trim() || !f.startAt || mutatingRef.current) return
    const end = f.endAt.trim() ? f.endAt : null
    mutatingRef.current = true
    setBusy(true)
    try {
      if (f.mode === 'create') {
        const yearId = currentYearRef.current
        if (yearId) {
          await backend.createEvent(yearId, f.title.trim(), f.startAt, end, f.size ?? null)
          enterYearRef.current(yearId) // ververs de jaar-tijdlijn
        } else {
          // Geen huidig jaar (lege vault / eerste memory): maak het jaar + de
          // memory aan op datum, herbouw de lifeline en duik het nieuwe jaar in.
          await backend.createEventAtDate(f.title.trim(), f.startAt, end, f.size ?? null)
          await rebuildLifeline()
          const yearNum = Number(f.startAt.slice(0, 4))
          const created = yearsRef.current.find((y) => y.year === yearNum)
          if (created) enterYearRef.current(created.id)
        }
      } else if (f.eventId) {
        await backend.updateEvent(f.eventId, f.title.trim(), f.startAt, end)
        // Belang is een apart, non-destructief veld: alleen (her)schrijven als de
        // gebruiker het echt wijzigde t.o.v. het geladen event (undefined = 50).
        // Zo blijft een fijn-afgestelde (Shift-sleep) size behouden bij een
        // titel-/datum-edit, en vermijden we een tweede rescan bij geen wijziging.
        const origSize = currentEventInfoRef.current?.size ?? 50
        if (f.size != null && f.size !== origSize) {
          await backend.setEventSize(f.eventId, f.size)
        }
        // Een datum-edit kan het event naar een ander jaar verplaatsen. Houd
        // `currentYearRef` in de pas met de nieuwe startdatum, anders landt
        // uitzoomen (goBack) op het oude — nu lege — jaar.
        const newYear = Number(f.startAt.slice(0, 4))
        const matched = yearsRef.current.find((y) => y.year === newYear)
        if (matched) currentYearRef.current = matched.id
        enterEventRef.current(f.eventId) // ververs event-info
      }
      setEventForm(null)
    } catch (e) {
      setMessage(String(e))
      setPhase('error')
    } finally {
      mutatingRef.current = false
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

  // Bewerk het huidige item (L3): tekst-notitie → body, foto → caption.
  // Ververs het event en herbouw het focus-item in-place (na een bewerking).
  const refreshFocus = async (): Promise<void> => {
    const backend = backendRef.current
    const eventId = currentEventRef.current
    if (!backend || !eventId) return
    const detail = await backend.getEvent(eventId)
    if (detail) {
      currentItemsRef.current = detail.items
      sceneRef.current?.refresh?.(detail.items)
      // Titel meelaten lopen als de caption van de huidige foto is gewijzigd.
      if (levelRef.current === 'focus') {
        const id = sceneRef.current?.currentId?.()
        const item = id ? detail.items.find((it) => it.id === id) : undefined
        setHeader({ text: focusTitleFor(item), dir: 'in' })
      }
    }
  }

  const startEdit = (): void => {
    const id = sceneRef.current?.currentId?.()
    if (!id) return
    const item = currentItemsRef.current.find((it) => it.id === id)
    if (!item) return
    const isText = item.itemType === 'text' || item.itemType === 'link'
    if (isText) {
      // Tekst-notitie → body bewerken.
      setEditing({ id, kind: 'text', value: item.bodyText ?? '' })
      return
    }
    // Foto → metadata-paneel (laad de huidige sidecar-waarden).
    const backend = backendRef.current
    if (!backend) return
    void backend
      .getItemMetadata(id)
      .then((m) => {
        setMetaForm({
          id,
          caption: m.caption,
          date: m.date,
          place: m.place,
          people: m.people.join(', '),
          tags: m.tags.join(', '),
          exif: m.exif,
        })
      })
      .catch((e) => {
        setMessage(String(e))
        setPhase('error')
      })
  }

  const submitEdit = async (): Promise<void> => {
    const backend = backendRef.current
    const ed = editing
    if (!backend || !ed || mutatingRef.current) return
    mutatingRef.current = true
    setBusy(true)
    try {
      // Tekst → body bijwerken (caption null = ongemoeid).
      await backend.updateItem(ed.id, null, ed.value)
      await refreshFocus()
      setEditing(null)
    } catch (e) {
      setMessage(String(e))
      setPhase('error')
    } finally {
      mutatingRef.current = false
      setBusy(false)
    }
  }

  const submitMeta = async (): Promise<void> => {
    const backend = backendRef.current
    const f = metaForm
    if (!backend || !f || mutatingRef.current) return
    const toList = (s: string): string[] => s.split(',').map((x) => x.trim()).filter(Boolean)
    mutatingRef.current = true
    setBusy(true)
    try {
      await backend.updateItemMetadata(f.id, f.caption, f.date, f.place, toList(f.people), toList(f.tags))
      await refreshFocus()
      setMetaForm(null)
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
      {phase !== 'ready' && (
        <Overlay
          phase={phase}
          message={message}
          onPick={() => void pickVault()}
          onCreateFirst={openNewEvent}
        />
      )}
      {phase === 'ready' && settings.showTitle && !screensaverIds && (
        <TitleBar text={header.text} dir={header.dir} />
      )}
      {phase === 'ready' && !modal && !editing && !eventForm && !metaForm && !searchOpen && !settingsOpen && !settings.viewMode && chromeVisible && settings.showSearchButton && (
        <button onClick={() => setSearchOpen(true)} style={searchBtn} title="Zoeken (Ctrl+K)">
          Zoeken…
        </button>
      )}
      {phase === 'ready' && !modal && !editing && !eventForm && !metaForm && !searchOpen && !settingsOpen && !settings.viewMode && (
        <button onClick={() => setSettingsOpen(true)} style={gearBtn} title="Instellingen">
          ⚙
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
      {settingsOpen && (
        <SettingsPanel
          settings={settings}
          onChange={updateSettings}
          onClose={() => setSettingsOpen(false)}
          vaultPath={vaultPath}
          onChangeVault={() => void pickVault()}
          onReindex={() => void reindexVault()}
          onResetSettings={resetAppSettings}
        />
      )}
      {screensaverIds && (
        <Screensaver
          photoIds={screensaverIds}
          thumb={(id, size) => backendRef.current!.thumb(id, size)}
          speedMs={settings.diaSpeed * 1000}
          mode={settings.diaMode}
          onClose={() => setScreensaverIds(null)}
        />
      )}
      {showFit &&
        phase === 'ready' &&
        !modal &&
        !editing &&
        !eventForm &&
        !metaForm &&
        !searchOpen &&
        !settingsOpen &&
        !screensaverIds && (
          <button
            onClick={() => {
              sceneRef.current?.fitToView?.()
              // Herijk de terug-uitzoom-referentie op de zojuist gefitte zoom.
              // Anders kan een fit die ver uitzoomt (inhoud ver buiten beeld, bv.
              // een foto ver opzij) onder de goBack-drempel (entryZoom*0.45)
              // duiken en de gebruiker meteen het canvas uit stuiteren. fitToView
              // animeert nu → lees de DOEL-zoom (pendingZoom), niet de nog-lopende.
              const z = engineRef.current?.pendingZoom
              if (z !== undefined) entryZoomRef.current = z
            }}
            style={fitBtn}
            title="Alles passend in beeld"
          >
            ⤢ Alles passend
          </button>
        )}
      {toast && <div style={toastStyle}>{toast}</div>}
      {phase === 'ready' && !modal && !editing && !eventForm && !metaForm && !searchOpen && !settingsOpen && !settings.viewMode && (
        <Fab
          uiLevel={uiLevel}
          layoutMode={layoutMode}
          onAddEvent={openNewEvent}
          onAddNote={() => setModal('note')}
          onAddPhotos={() => void addPhotos()}
          onEditEvent={openEditEvent}
          onLayout={changeLayout}
          onSaveLayout={saveLayoutAsCustom}
          onEdit={startEdit}
          onDelete={() => void deleteCurrent()}
          scatterRotate={settings.scatterRotate}
          onToggleScatterRotate={toggleScatterRotate}
        />
      )}
      {modal && (
        <Composer
          value={draft}
          busy={busy}
          onChange={setDraft}
          onSubmit={() => void submitNote()}
          onCancel={() => {
            setModal(null)
            setDraft('')
          }}
        />
      )}
      {editing && (
        <EditPanel
          kind={editing.kind}
          value={editing.value}
          busy={busy}
          onChange={(v) => setEditing({ ...editing, value: v })}
          onSubmit={() => void submitEdit()}
          onCancel={() => setEditing(null)}
        />
      )}
      {eventForm && (
        <EventDialog
          form={eventForm}
          busy={busy}
          onChange={(patch) => setEventForm({ ...eventForm, ...patch })}
          onSubmit={() => void submitEventForm()}
          onCancel={() => setEventForm(null)}
        />
      )}
      {metaForm && (
        <MetaPanel
          form={metaForm}
          busy={busy}
          onChange={(patch) => setMetaForm({ ...metaForm, ...patch })}
          onSubmit={() => void submitMeta()}
          onCancel={() => setMetaForm(null)}
        />
      )}
    </div>
  )
}

function MetaPanel({
  form,
  busy,
  onChange,
  onSubmit,
  onCancel,
}: {
  form: MetaForm
  busy: boolean
  onChange: (patch: Partial<MetaForm>) => void
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
      <div style={{ width: 520, maxWidth: '92%', background: '#161c28', borderRadius: 12, padding: 20 }}>
        <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 12 }}>Foto-gegevens</div>
        <label style={metaLabel}>
          Bijschrift
          <input
            autoFocus
            value={form.caption}
            onChange={(e) => onChange({ caption: e.target.value })}
            placeholder="Bijschrift bij de foto"
            style={{ ...field, marginTop: 4 }}
          />
        </label>
        <div style={{ display: 'flex', gap: 12, marginTop: 12 }}>
          <label style={{ ...metaLabel, flex: 1 }}>
            Datum
            <input
              type="date"
              value={form.date}
              onChange={(e) => onChange({ date: e.target.value })}
              style={{ ...field, marginTop: 4 }}
            />
          </label>
          <label style={{ ...metaLabel, flex: 1 }}>
            Plaats
            <input
              value={form.place}
              onChange={(e) => onChange({ place: e.target.value })}
              placeholder="bijv. Amsterdam"
              style={{ ...field, marginTop: 4 }}
            />
          </label>
        </div>
        <label style={{ ...metaLabel, marginTop: 12 }}>
          Mensen (komma-gescheiden)
          <input
            value={form.people}
            onChange={(e) => onChange({ people: e.target.value })}
            placeholder="Jim, Wout, oma"
            style={{ ...field, marginTop: 4 }}
          />
        </label>
        <label style={{ ...metaLabel, marginTop: 12 }}>
          Trefwoorden (komma-gescheiden)
          <input
            value={form.tags}
            onChange={(e) => onChange({ tags: e.target.value })}
            placeholder="strand, zomer, vakantie"
            style={{ ...field, marginTop: 4 }}
          />
        </label>
        {form.exif.length > 0 && (
          <div style={{ marginTop: 16, borderTop: '1px solid #2c3650', paddingTop: 12 }}>
            <div style={{ fontSize: 12, color: '#6a7690', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>
              EXIF (uit de foto)
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {form.exif.map((e) => (
                <div key={e.label} style={{ display: 'flex', gap: 14, fontSize: 13 }}>
                  <span style={{ color: '#8a97b0', minWidth: 150 }}>{e.label}</span>
                  <span style={{ color: '#dfe7f5' }}>{e.value}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
          <button onClick={onCancel} style={ghostBtn}>Annuleren</button>
          <button onClick={onSubmit} disabled={busy} style={primaryBtn}>
            {busy ? 'Bezig…' : 'Opslaan'}
          </button>
        </div>
      </div>
    </div>
  )
}

function SettingsPanel({
  settings,
  onChange,
  onClose,
  vaultPath,
  onChangeVault,
  onReindex,
  onResetSettings,
}: {
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
  onClose: () => void
  vaultPath: string | null
  onChangeVault: () => void
  onReindex: () => void
  onResetSettings: () => void
}) {
  const [tab, setTab] = useState<'weergave' | 'tijdlijn' | 'dia' | 'beheer'>('weergave')
  const seg = (m: 'custom' | 'grid' | 'scatter'): React.CSSProperties => ({
    ...ghostBtn,
    background: settings.defaultLayout === m ? '#3b82f6' : 'transparent',
    borderColor: settings.defaultLayout === m ? '#3b82f6' : '#2c3650',
    color: '#fff',
  })
  const segOn = (active: boolean): React.CSSProperties => ({
    ...ghostBtn,
    background: active ? '#3b82f6' : 'transparent',
    borderColor: active ? '#3b82f6' : '#2c3650',
    color: '#fff',
  })
  const desc = (t: React.ReactNode): React.ReactElement => (
    <div style={{ fontSize: 12, color: '#6a7690', marginTop: 6 }}>{t}</div>
  )
  const Toggle = ({
    on,
    set,
    label,
  }: {
    on: boolean
    set: (v: boolean) => void
    label: string
  }): React.ReactElement => (
    <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
      <input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} />
      <span style={{ fontSize: 14, color: '#fff' }}>{label}</span>
    </label>
  )
  const subhead = (t: string): React.ReactElement => (
    <div style={{ fontSize: 13, color: '#8a97b0', margin: '16px 0 6px' }}>{t}</div>
  )
  const tabBtn = (id: typeof tab, label: string): React.ReactElement => (
    <button
      onClick={() => setTab(id)}
      style={{
        flex: 1,
        padding: '10px 8px',
        border: 'none',
        borderBottom: tab === id ? '2px solid #3b82f6' : '2px solid transparent',
        background: 'transparent',
        color: tab === id ? '#fff' : '#8a97b0',
        font: '13px sans-serif',
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  )
  return (
    <div
      onClick={onClose}
      style={{
        position: 'absolute',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 640,
          maxWidth: '94%',
          maxHeight: '88vh',
          background: '#161c28',
          borderRadius: 12,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 700, padding: '18px 22px 10px' }}>Instellingen</div>
        <div style={{ display: 'flex', padding: '0 12px', borderBottom: '1px solid #2c3650' }}>
          {tabBtn('weergave', 'Weergave')}
          {tabBtn('tijdlijn', 'Tijdlijn & canvas')}
          {tabBtn('dia', 'Diavoorstelling')}
          {tabBtn('beheer', 'Beheer')}
        </div>
        <div style={{ overflowY: 'auto', padding: '14px 22px 6px', flex: '1 1 auto' }}>
          {tab === 'weergave' && (
            <>
              <Toggle on={settings.showTitle} set={(v) => onChange({ showTitle: v })} label="Titel bovenin tonen" />
              {desc('"Memory Lane" op het overzicht, het jaar in een jaar, de memory-naam in een memory.')}
              {settings.showTitle && (
                <div style={{ marginTop: 10 }}>
                  <Toggle
                    on={settings.photoTitleFromCaption}
                    set={(v) => onChange({ photoTitleFromCaption: v })}
                    label="Bij een detailfoto de caption als titel"
                  />
                  {desc('Heeft de foto geen caption, dan blijft de memory-naam staan (geen bestandsnamen).')}
                </div>
              )}
              <div style={{ height: 1, background: '#2c3650', margin: '16px 0' }} />
              <Toggle
                on={settings.showSearchButton}
                set={(v) => onChange({ showSearchButton: v })}
                label="Zoekknop tonen"
              />
              {desc(
                <>
                  Uit? Zoeken kan altijd nog met <b>Ctrl+K</b>. De knop verdwijnt sowieso na een paar
                  seconden zonder muisbeweging.
                </>,
              )}
              <div style={{ height: 1, background: '#2c3650', margin: '16px 0' }} />
              <Toggle
                on={settings.viewMode}
                set={(v) => onChange({ viewMode: v })}
                label="View-modus (alle knoppen verbergen)"
              />
              {desc(
                <>
                  Een schone weergave zonder knoppen. Druk op <b>E</b> om te wisselen.
                </>,
              )}
              <div style={{ height: 1, background: '#2c3650', margin: '16px 0' }} />
              <Toggle
                on={settings.lockVerticalPan}
                set={(v) => onChange({ lockVerticalPan: v })}
                label="Verticaal pannen vergrendelen (overzicht + jaar-tijdlijn)"
              />
              {desc('Houdt de horizontale niveaus verticaal gecentreerd; je scrollt/zoomt alleen zijwaarts.')}
            </>
          )}

          {tab === 'tijdlijn' && (
            <>
              {subhead('Standaard canvas-weergave')}
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => onChange({ defaultLayout: 'custom' })} style={seg('custom')}>Eigen</button>
                <button onClick={() => onChange({ defaultLayout: 'grid' })} style={seg('grid')}>Grid</button>
                <button onClick={() => onChange({ defaultLayout: 'scatter' })} style={seg('scatter')}>Scatter</button>
              </div>
              {desc('Hoe een memory opent. Je eigen posities blijven altijd bewaard onder "Eigen".')}
              <div style={{ marginTop: 12 }}>
                <Toggle
                  on={settings.scatterRotate}
                  set={(v) => onChange({ scatterRotate: v })}
                  label="Scatter legt foto's licht scheef"
                />
                {desc("Uit = recht. Ook per memory te wisselen met het ⟲-knopje naast Scatter.")}
              </div>

              <div style={{ marginTop: 12 }}>
                <Toggle
                  on={settings.squarePhotos}
                  set={(v) => onChange({ squarePhotos: v })}
                  label="Foto's vierkant bijsnijden (in een memory)"
                />
                {desc('Uit = de foto behoudt zijn eigen verhouding (de tegel neemt de vorm van de foto over).')}
              </div>

              <div style={{ height: 1, background: '#2c3650', margin: '16px 0' }} />
              <Toggle
                on={settings.showMemoryTitles}
                set={(v) => onChange({ showMemoryTitles: v })}
                label="Memory-namen tonen in de jaar-view"
              />
              {desc('De naam bij de kaart, zichtbaar zodra je inzoomt op een thumbnail. Lange namen worden afgekapt.')}

              <div style={{ height: 1, background: '#2c3650', margin: '16px 0' }} />
              <Toggle
                on={settings.curvedLeaders}
                set={(v) => onChange({ curvedLeaders: v })}
                label="Gebogen verbindingslijntjes (as → memory)"
              />
              {desc('Uit = rechte lijntjes. De lijntjes lopen van de tijdlijn naar de memory-kaart.')}

              <div style={{ height: 1, background: '#2c3650', margin: '16px 0' }} />
              <Toggle
                on={settings.slideshow}
                set={(v) => onChange({ slideshow: v })}
                label="Slideshow op de jaar-tijdlijn (thumbnails rouleren)"
              />
              {settings.slideshow && (
                <div style={{ marginTop: 10 }}>
                  <div style={{ fontSize: 13, color: '#8a97b0', marginBottom: 4 }}>
                    Snelheid: {settings.slideshowSpeed}s per foto
                  </div>
                  <input
                    type="range"
                    min={2}
                    max={15}
                    step={1}
                    value={settings.slideshowSpeed}
                    onChange={(e) => onChange({ slideshowSpeed: Number(e.target.value) })}
                    style={{ width: '100%' }}
                  />
                </div>
              )}
              {desc('Wijzigingen gelden bij het (opnieuw) openen van een jaar.')}

              <div style={{ height: 1, background: '#2c3650', margin: '16px 0' }} />
              <Toggle
                on={settings.yearTileSlideshow}
                set={(v) => onChange({ yearTileSlideshow: v })}
                label="Jaartegels als slideshow (covers rouleren)"
              />
              {settings.yearTileSlideshow && (
                <div style={{ marginTop: 10 }}>
                  <div style={{ fontSize: 13, color: '#8a97b0', marginBottom: 6 }}>Cover-bron</div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={() => onChange({ yearCoverMode: 'featured' })} style={segOn(settings.yearCoverMode === 'featured')}>
                      Uitgelicht
                    </button>
                    <button onClick={() => onChange({ yearCoverMode: 'random' })} style={segOn(settings.yearCoverMode === 'random')}>
                      Willekeurig
                    </button>
                  </div>
                </div>
              )}
              {desc(
                "'Uitgelicht' rouleert door de uitgelichte foto's van dat jaar (geen uitgelicht → alle foto's); 'willekeurig' door alle foto's. Een vaste jaar-cover (Ctrl+Shift-klik) overrulet dit.",
              )}
            </>
          )}

          {tab === 'dia' && (
            <>
              {subhead('Weergave')}
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => onChange({ diaMode: 'kenburns' })} style={segOn(settings.diaMode === 'kenburns')}>
                  Ken Burns
                </button>
                <button onClick={() => onChange({ diaMode: 'crossfade' })} style={segOn(settings.diaMode === 'crossfade')}>
                  Overvloeien
                </button>
              </div>
              {desc("'Ken Burns' zoomt/pant langzaam; 'Overvloeien' toont een stilstaande foto die overvloeit.")}
              <div style={{ fontSize: 13, color: '#8a97b0', margin: '14px 0 4px' }}>
                Snelheid: {settings.diaSpeed}s per foto
              </div>
              <input
                type="range"
                min={2}
                max={20}
                step={1}
                value={settings.diaSpeed}
                onChange={(e) => onChange({ diaSpeed: Number(e.target.value) })}
                style={{ width: '100%' }}
              />

              <div style={{ height: 1, background: '#2c3650', margin: '16px 0' }} />
              {subhead('Tagfilter')}
              <label style={{ display: 'block', fontSize: 12, color: '#9aa6c0', marginBottom: 4 }}>
                Alleen deze tags (komma-gescheiden)
              </label>
              <input
                type="text"
                value={settings.screensaverInclude}
                onChange={(e) => onChange({ screensaverInclude: e.target.value })}
                placeholder="bijv. vakantie, familie"
                style={tagInput}
              />
              <label style={{ display: 'block', fontSize: 12, color: '#9aa6c0', margin: '10px 0 4px' }}>
                Zonder deze tags (komma-gescheiden)
              </label>
              <input
                type="text"
                value={settings.screensaverExclude}
                onChange={(e) => onChange({ screensaverExclude: e.target.value })}
                placeholder="bijv. werk"
                style={tagInput}
              />
              {desc(
                <>
                  De diavoorstelling toont foto's afhankelijk van waar je bent (overzicht = alles, jaar
                  = dat jaar, memory = die memory). Start 'm met de sneltoets <b>S</b>. Sluiten met Esc.
                </>,
              )}
            </>
          )}

          {tab === 'beheer' && (
            <>
              {subhead('Vault-map (waar je bestanden staan)')}
              <div
                style={{
                  fontSize: 13,
                  color: '#cfd6e4',
                  background: 'rgba(12,16,24,0.6)',
                  border: '1px solid #2c3650',
                  borderRadius: 8,
                  padding: '8px 10px',
                  wordBreak: 'break-all',
                }}
              >
                {vaultPath ?? '(nog geen map gekozen)'}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button onClick={onChangeVault} style={ghostBtn}>Andere map kiezen…</button>
                <button onClick={onReindex} style={ghostBtn}>Index herberekenen</button>
              </div>
              {desc(
                'Kies een andere map met je vault, of herbereken de index (scan de map opnieuw) als je bestanden buiten de app hebt gewijzigd. Je bestanden blijven altijd behouden — de index is een weggooibare cache.',
              )}

              <div style={{ height: 1, background: '#2c3650', margin: '16px 0' }} />
              {subhead('Resetten')}
              <button onClick={onResetSettings} style={{ ...ghostBtn, borderColor: '#7a3b3b', color: '#ffb4b4' }}>
                App-instellingen resetten
              </button>
              {desc(
                'Zet alle app-instellingen (weergave, diavoorstelling, per-memory onthouden standen) terug naar standaard. Je foto’s, memories en curatie in de vault blijven ongemoeid.',
              )}
            </>
          )}
        </div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            padding: '12px 20px',
            borderTop: '1px solid #2c3650',
          }}
        >
          <button onClick={onClose} style={primaryBtn}>Klaar</button>
        </div>
      </div>
    </div>
  )
}

function Fab({
  uiLevel,
  layoutMode,
  onAddEvent,
  onAddNote,
  onAddPhotos,
  onEditEvent,
  onLayout,
  onSaveLayout,
  onEdit,
  onDelete,
  scatterRotate,
  onToggleScatterRotate,
}: {
  uiLevel: 'lifeline' | 'year' | 'event' | 'focus'
  layoutMode: 'custom' | 'grid' | 'scatter'
  onAddEvent: () => void
  onAddNote: () => void
  onAddPhotos: () => void
  onEditEvent: () => void
  onLayout: (mode: 'custom' | 'grid' | 'scatter') => void
  onSaveLayout: () => void
  onEdit: () => void
  onDelete: () => void
  scatterRotate: boolean
  onToggleScatterRotate: () => void
}) {
  const wrap: React.CSSProperties = { position: 'absolute', right: 20, bottom: 20, display: 'flex', gap: 10 }
  if (uiLevel === 'year') {
    return (
      <div style={wrap}>
        <button onClick={onAddEvent} style={fabBtn}>+ Nieuwe memory</button>
      </div>
    )
  }
  if (uiLevel === 'event') {
    const seg = (m: 'custom' | 'grid' | 'scatter'): React.CSSProperties => ({
      ...fabBtn,
      background: layoutMode === m ? '#3b82f6' : '#1f2734',
    })
    return (
      <div style={wrap}>
        {/* Vooraan (links) zodat het verschijnen de layout-knoppen NIET verschuift
            — de rij is rechts verankerd, dus een knop links laat de rest op zijn plek. */}
        {layoutMode !== 'custom' && (
          <button onClick={onSaveLayout} style={{ ...fabBtn, background: '#166534' }} title="Deze opstelling vastleggen als je eigen layout">
            Opslaan als Eigen
          </button>
        )}
        <button onClick={() => onLayout('custom')} style={seg('custom')}>Eigen</button>
        <button onClick={() => onLayout('grid')} style={seg('grid')}>Grid</button>
        <button onClick={() => onLayout('scatter')} style={seg('scatter')} title="Elke klik een nieuwe worp">
          Scatter 🎲
        </button>
        <button
          onClick={onToggleScatterRotate}
          style={{ ...fabBtn, background: scatterRotate ? '#3b82f6' : '#1f2734', width: 42, paddingLeft: 0, paddingRight: 0 }}
          title={scatterRotate ? 'Scatter legt foto’s scheef (klik = recht)' : 'Scatter legt foto’s recht (klik = scheef)'}
        >
          {scatterRotate ? '⟲' : '▭'}
        </button>
        <button onClick={onAddPhotos} style={fabBtn}>+ Foto&apos;s</button>
        <button onClick={onAddNote} style={fabBtn}>+ Notitie</button>
        <button onClick={onEditEvent} style={fabBtn}>Bewerk memory</button>
      </div>
    )
  }
  if (uiLevel === 'focus') {
    return (
      <div style={wrap}>
        <button onClick={onEdit} style={fabBtn}>Bewerk</button>
        <button onClick={onDelete} style={{ ...fabBtn, background: '#7f1d1d' }}>Verwijder</button>
      </div>
    )
  }
  return null
}

function EditPanel({
  kind,
  value,
  busy,
  onChange,
  onSubmit,
  onCancel,
}: {
  kind: 'text' | 'photo'
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
          {kind === 'text' ? 'Notitie bewerken' : 'Bijschrift bewerken'}
        </div>
        {kind === 'text' ? (
          <textarea
            autoFocus
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Schrijf een herinnering…"
            style={{ ...field, height: 200, resize: 'vertical' }}
          />
        ) : (
          <input
            autoFocus
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Bijschrift bij de foto"
            style={field}
          />
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 14 }}>
          <button onClick={onCancel} style={ghostBtn}>Annuleren</button>
          <button onClick={onSubmit} disabled={busy} style={primaryBtn}>
            {busy ? 'Bezig…' : 'Opslaan'}
          </button>
        </div>
      </div>
    </div>
  )
}

function EventDialog({
  form,
  busy,
  onChange,
  onSubmit,
  onCancel,
}: {
  form: EventForm
  busy: boolean
  onChange: (patch: Partial<EventForm>) => void
  onSubmit: () => void
  onCancel: () => void
}) {
  const endBeforeStart = form.endAt !== '' && form.endAt < form.startAt
  const invalid = !form.title.trim() || !form.startAt || endBeforeStart
  // Belang-rating: bij bewerken kan de size fijn-afgesteld zijn (Shift-slepen op
  // de tijdlijn) en dus tussen de buckets in liggen — dan markeren we de
  // dichtstbijzijnde en tonen "aangepast", zonder de precieze waarde te verliezen.
  const curSize = form.size ?? 50
  const nearestBucket = IMPORTANCE_CHOICES.reduce((a, b) =>
    Math.abs(b.size - curSize) < Math.abs(a.size - curSize) ? b : a,
  )
  const isCustomSize = !IMPORTANCE_CHOICES.some((c) => c.size === curSize)
  return (
    <div
      onClick={onCancel}
      style={{
        position: 'absolute',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: 480, maxWidth: '90%', background: '#161c28', borderRadius: 12, padding: 20 }}
      >
        <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 12 }}>
          {form.mode === 'create' ? 'Nieuwe memory' : 'Memory bewerken'}
        </div>
        <input
          autoFocus
          value={form.title}
          onChange={(e) => onChange({ title: e.target.value })}
          placeholder="Titel van de memory"
          style={field}
        />
        <div style={{ display: 'flex', gap: 12, marginTop: 12 }}>
          <label style={dateLabel}>
            Begindatum
            <input
              type="date"
              value={form.startAt}
              onChange={(e) => onChange({ startAt: e.target.value })}
              style={{ ...field, marginTop: 4 }}
            />
          </label>
          <label style={dateLabel}>
            Einddatum (optioneel)
            <input
              type="date"
              value={form.endAt}
              min={form.startAt || undefined}
              onChange={(e) => onChange({ endAt: e.target.value })}
              style={{ ...field, marginTop: 4 }}
            />
          </label>
        </div>
        {endBeforeStart && (
          <div style={{ color: '#f0a0a0', fontSize: 13, marginTop: 8 }}>
            De einddatum ligt vóór de begindatum.
          </div>
        )}
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 13, color: '#9aa6bd', marginBottom: 6 }}>
            Hoe bijzonder?
            {isCustomSize && (
              <span style={{ color: '#8794aa', marginLeft: 8 }}>· aangepast ({curSize})</span>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {IMPORTANCE_CHOICES.map((c) => {
              const active = isCustomSize ? c.size === nearestBucket.size : curSize === c.size
              return (
                <button
                  key={c.size}
                  type="button"
                  onClick={() => onChange({ size: c.size })}
                  title={c.hint}
                  style={{
                    flex: 1,
                    padding: '10px 8px',
                    borderRadius: 8,
                    cursor: 'pointer',
                    textAlign: 'center',
                    border: active ? '1px solid #6ea8ff' : '1px solid #2a3345',
                    background: active ? 'rgba(110,168,255,0.16)' : '#1b2230',
                    color: active ? '#dfe7f5' : '#aab4c8',
                  }}
                >
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{c.label}</div>
                  <div style={{ fontSize: 11, color: '#8794aa', marginTop: 2 }}>{c.hint}</div>
                </button>
              )
            })}
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 14 }}>
          <button onClick={onCancel} style={ghostBtn}>Annuleren</button>
          <button onClick={onSubmit} disabled={busy || invalid} style={primaryBtn}>
            {busy ? 'Bezig…' : 'Opslaan'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Composer({
  value,
  busy,
  onChange,
  onSubmit,
  onCancel,
}: {
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
        <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 12 }}>Nieuwe notitie</div>
        <textarea
          autoFocus
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Schrijf een herinnering…"
          style={{ ...field, height: 140, resize: 'vertical' }}
        />
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
                {r.eventTitle ?? 'Memory'}
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

const fitBtn: React.CSSProperties = {
  position: 'absolute',
  left: 20,
  bottom: 20,
  padding: '9px 16px',
  borderRadius: 20,
  border: '1px solid rgba(255,255,255,0.18)',
  background: 'rgba(22,28,40,0.6)',
  color: '#e6eaf2',
  font: '13px sans-serif',
  cursor: 'pointer',
  backdropFilter: 'blur(4px)',
}

/** Titel bovenin die bij een niveau-wissel zoomt + crossfadet, in dezelfde richting
 * als de scene-transitie: 'in' (dieper) = de nieuwe titel groeit uit het klein en de
 * oude zwelt weg; 'out' (terug) = de nieuwe komt uit het groot en de oude krimpt weg. */
function TitleBar({ text, dir }: { text: string; dir: 'in' | 'out' }) {
  const idRef = useRef(0)
  const prev = useRef(text)
  const [entries, setEntries] = useState<{ id: number; text: string; dir: 'in' | 'out' }[]>([
    { id: 0, text, dir },
  ])
  useEffect(() => {
    if (text === prev.current) return
    prev.current = text
    idRef.current += 1
    setEntries((e) => [...e, { id: idRef.current, text, dir }].slice(-2))
  }, [text, dir])

  const curDir = entries[entries.length - 1]!.dir
  const enterFrom = curDir === 'in' ? 0.55 : 1.4
  const exitTo = curDir === 'in' ? 1.4 : 0.55
  return (
    <>
      {entries.map((en, i) => {
        const isNew = i === entries.length - 1
        return (
          <div
            key={en.id}
            style={{
              ...titleStyle,
              animation: isNew
                ? 'ml-title-enter 380ms ease-out both'
                : 'ml-title-exit 340ms ease-in both',
              ['--from' as string]: String(enterFrom),
              ['--to' as string]: String(exitTo),
            }}
          >
            {en.text}
          </div>
        )
      })}
      <style>{`
        @keyframes ml-title-enter {
          from { opacity: 0; transform: translateX(-50%) scale(var(--from)); }
          to   { opacity: 1; transform: translateX(-50%) scale(1); }
        }
        @keyframes ml-title-exit {
          from { opacity: 1; transform: translateX(-50%) scale(1); }
          to   { opacity: 0; transform: translateX(-50%) scale(var(--to)); }
        }
      `}</style>
    </>
  )
}

const titleStyle: React.CSSProperties = {
  position: 'absolute',
  top: 18,
  left: '50%',
  transform: 'translateX(-50%)',
  maxWidth: '70%',
  textAlign: 'center',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  fontFamily: 'Georgia, "Times New Roman", serif',
  fontSize: 30,
  fontWeight: 600,
  letterSpacing: 0.5,
  color: 'rgba(245,247,251,0.92)',
  textShadow: '0 2px 12px rgba(0,0,0,0.6)',
  pointerEvents: 'none',
  zIndex: 5,
}

const toastStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: 24,
  left: '50%',
  transform: 'translateX(-50%)',
  padding: '10px 18px',
  borderRadius: 12,
  background: 'rgba(22,28,40,0.95)',
  border: '1px solid #2c3650',
  color: '#e6eaf2',
  font: '13px sans-serif',
  boxShadow: '0 6px 20px rgba(0,0,0,0.5)',
  zIndex: 1100,
  pointerEvents: 'none',
}

const gearBtn: React.CSSProperties = {
  position: 'absolute',
  top: 16,
  right: 16,
  width: 38,
  height: 38,
  borderRadius: 19,
  border: '1px solid #2c3650',
  background: 'rgba(22,28,40,0.85)',
  color: '#cfd6e4',
  fontSize: 18,
  lineHeight: '1',
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

const dateLabel: React.CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  fontSize: 13,
  color: '#8a97b0',
}

const metaLabel: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  fontSize: 13,
  color: '#8a97b0',
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
  onCreateFirst,
}: {
  phase: Phase
  message: string
  onPick: () => void
  onCreateFirst: () => void
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
        <div style={{ color: '#8a97b0', maxWidth: 420, font: '14px sans-serif' }}>
          Deze map is nog leeg. Maak je eerste memory — het bijbehorende jaar wordt
          automatisch aangemaakt.
        </div>
        <button onClick={onCreateFirst} style={primaryBtn}>
          + Maak je eerste memory
        </button>
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

const tagInput: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '8px 10px',
  borderRadius: 8,
  border: '1px solid #2c3650',
  background: 'rgba(12,16,24,0.6)',
  color: '#e6eaf2',
  font: '13px sans-serif',
}
