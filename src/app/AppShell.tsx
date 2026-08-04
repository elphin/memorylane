// App-shell: mount de render-engine, laadt de jaren via de backend en beheert
// de scenes (L0 lifeline ↔ L1 jaar). Transities zijn zoom-gedreven (geen
// terug-knoppen): tik op een jaar → in; ver uitzoomen in een jaar → terug.
// DOM wordt alleen gebruikt voor overlays (loading, first-run, leeg).

import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, domAnimation, LazyMotion, m } from 'motion/react'
import type {
  Backend,
  EventInfo,
  ExifEntry,
  Item,
  MaterializationReport,
  SearchResult,
  YearSummary,
} from '../lib/backend'
import { createBackend, soundLabel } from '../lib/backend'
import { isSound } from '../render/scenes/types'
import { RenderEngine } from '../render/core/engine'
import { loadThemeFonts } from '../theme/fonts'
import { THEMES, themeById } from '../theme/registry'
import { ACCENT_SWATCHES, FRAME_STYLES, TITLE_FONTS, resolveTheme, type ThemeChoiceLike } from '../theme/resolve'
import { BACKGROUNDS, BACKGROUND_NONE, loadBackgroundTexture } from '../theme/textures'
import { THEME, setActiveTheme, type ResolvedTheme } from '../theme/tokens'
import { UI_DARK, UI_LIGHT, ui, type UiPalette } from '../theme/ui'
import { IconEigen, IconGrid, IconScatter, IconImage, IconNote, IconSliders, IconPalette, IconPencil, IconPlus, IconTrash, IconCrop, IconCover, IconExternal, IconMusicPlus } from './icons'
import { EventScene } from '../render/scenes/event'
import type { NodePosition } from '../render/scenes/scene'
import { Screensaver } from './Screensaver'
import { SettingsPhone } from './SettingsPhone'
import { FocusVideoLayer } from './FocusVideoLayer'
import { MusicLayer, PauseIcon, PlayIcon, type NowPlaying } from './MusicLayer'
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
  /** Maak het jaar (uit de datum) aan i.p.v. in het huidige jaar (lifeline: nieuw jaar). */
  atDate?: boolean
  /** "In aanbouw"-status van de memory (alleen in bewerk-modus). */
  underConstruction?: boolean
  /** Item-id van de gekozen omslagfoto (alleen bewerk-modus). `undefined` = nog geen
   * vaste keuze; de tijdlijn toont dan een willekeurige foto uit de memory. */
  coverItemId?: string
  /** Trefwoorden van de memory (alleen bewerk-modus), als komma-string in het veld. */
  tags?: string
  /** Synthetische "Losse foto's"-bundel: geen eigen `_event.md`, dus geen tags. */
  synthetic?: boolean
}

/** Komma-string → schone lijst (getrimd, geen lege, geen dubbele). */
function parseTags(s: string): string[] {
  const out: string[] = []
  for (const raw of s.split(',')) {
    const t = raw.trim()
    // Hoofdletterloos ontdubbelen, maar de eerst getypte schrijfwijze behouden.
    if (t && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t)
  }
  return out
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
  /** Kader-stijl van dit item ('' = geërfd van het thema). */
  frame: string
  /** Oorspronkelijke waarde bij openen (alleen schrijven bij wijziging). */
  frame0: string
  /** Geluidsitem (losse opname): dan is de kader-keuze betekenisloos, want de
   * kaart forceert 'plain'. Een bediening tonen die aantoonbaar niets doet -- en
   * bij opslaan wél naar schijf schrijft -- is erger dan geen bediening. */
  isSound?: boolean
}

/** App-voorkeuren (UI, geen vault-data) — bewaard in localStorage. */
interface Settings {
  /** Mag de app bij een geplakte link online de titel, artiest en albumhoes
   * opzoeken? Standaard aan; uit betekent: alleen wat je zelf typt. */
  musicLookup: boolean
  /** Volume van de muziek (0-100). Achtergrondmuziek, geen concert. */
  musicVolume: number
  /** Wanneer muziek VANZELF begint. Oplopende schaal; standaard alleen bij een
   * diavoorstelling, want geluid dat begint zodra je iets opent is voor veel
   * mensen precies de reden om een app weg te zetten. Handmatig starten kan
   * altijd, ook op 'nooit'. */
  musicAuto: 'nooit' | 'diavoorstelling' | 'diavoorstelling-en-memory'
  /** Actief thema (id uit de thema-registry): kleuren/fonts van de tijdlijn. */
  themeId: string
  /** Weergave waarin een event-canvas standaard opent. */
  defaultLayout: 'custom' | 'grid' | 'scatter'
  /** Rouleren de thumbnails op de jaar-tijdlijn door de foto's (slideshow)? */
  slideshow: boolean
  /** Seconden per foto in de slideshow. */
  slideshowSpeed: number
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
  /** Bij hover over een memory: een vonk langs de leader naar de datum, de stip/balk
   * licht op en de exacte datum verschijnt (jaar-view). */
  hoverPulse: boolean
  /** Fijne maatverdeling op de jaar-as: week- en dag-streepjes die infaden bij
   * inzoomen (maand-streepjes staan er altijd). */
  fineTicks: boolean
  /** Snijd foto's in de memory-view naar een vierkant (1:1) bij? Uit = natuurlijke
   * verhouding (de kaart neemt de vorm van de foto over). */
  squarePhotos: boolean
  /** Dikte (px) van de zichtbare rand om de foto's in een memory. 0 = geen rand.
   * De jaar-tegels volgen proportioneel (zie `YEAR_BORDER_RATIO`), zodat de
   * standaardwaarde exact het bestaande beeld oplevert. De klik-zone wordt nooit
   * kleiner, dus een dunne rand maakt niets moeilijker aan te klikken. */
  borderThickness: number
  /** Toon de titel bovenin (Memory Lane / jaar / eventnaam). */
  showTitle: boolean
  /** Bij een detailfoto: toon de caption als titel (indien aanwezig; anders de
   * eventnaam). Uit = altijd de eventnaam. */
  photoTitleFromCaption: boolean
  /** Weergave van de diavoorstelling: 'kenburns' (zoom/pan) of 'crossfade' (stil). */
  diaMode: 'kenburns' | 'crossfade'
  /** Seconden per foto in de diavoorstelling. */
  diaSpeed: number
  /** Schuif-/fade-animatie bij vorige/volgende in de detail-view (L3). */
  l3StepAnimation: boolean
  /** Klik op lege ruimte (naast een item) gaat één niveau terug. Uit = de klik
   * doet niets; Escape/terugknop/rechtsklik blijven werken. */
  backOnEmptyClick: boolean
  /** Ver uitzoomen gaat één niveau terug. Uit = uitzoomen stopt op het overzicht
   * (geen terug), zonder te verdwalen. */
  backOnZoomOut: boolean
  /** Rechtermuisknop gaat één niveau terug. */
  backOnRightClick: boolean
}

const DEFAULT_SETTINGS: Settings = {
  musicLookup: true,
  musicVolume: 60,
  musicAuto: 'diavoorstelling',
  themeId: 'classic-dark',
  defaultLayout: 'custom',
  slideshow: true,
  slideshowSpeed: 5,
  viewMode: false,
  screensaverInclude: '',
  screensaverExclude: '',
  showSearchButton: false,
  yearTileSlideshow: false,
  yearCoverMode: 'featured',
  scatterRotate: true,
  showMemoryTitles: true,
  curvedLeaders: true,
  hoverPulse: true,
  fineTicks: true,
  squarePhotos: false,
  borderThickness: 8,
  showTitle: true,
  photoTitleFromCaption: false,
  diaMode: 'kenburns',
  diaSpeed: 7,
  l3StepAnimation: true,
  backOnEmptyClick: true,
  backOnZoomOut: true,
  backOnRightClick: true,
}
const SETTINGS_KEY = 'memorylane-settings'
/** De jaar-tegels hadden altijd een dunnere rand (6) dan de foto's op het
 * memory-canvas (8) — kleine tegels verdragen minder rand. Eén instelling stuurt
 * beide; de jaar-view volgt in die verhouding, zodat de standaard (8) precies het
 * beeld van vóór de instelling geeft. */
const YEAR_BORDER_RATIO = 6 / 8
/** De jaar-rand bij de standaard-instelling (vangnet bij een corrupte opslag). */
const DEFAULT_YEAR_BORDER_PX = 6
const yearBorderPx = (px: number): number =>
  Number.isFinite(px) ? px * YEAR_BORDER_RATIO : DEFAULT_YEAR_BORDER_PX
// Scherm-px die de titel ("2024") bovenaan inneemt (top 18 + ~30px teksthoogte +
// gaatje). De dag-gids (Ctrl) start hieronder als de titel aan staat.
const TITLE_INSET_PX = 60

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
type GridSort = 'date' | 'name' | 'random'
type LayoutView =
  | { mode: 'custom' }
  | { mode: 'grid'; positions: NodePosition[]; sort?: GridSort; seed?: number }
  | { mode: 'scatter'; positions: NodePosition[] }
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
  if (mode === 'grid') {
    const s = (v as { sort?: unknown }).sort
    const seed = (v as { seed?: unknown }).seed
    const sort = s === 'date' || s === 'name' || s === 'random' ? s : undefined
    return { mode, positions, sort, seed: typeof seed === 'number' ? seed : undefined }
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

/** Bouw een op te slaan LayoutView uit de scene-layoutState (grid onthoudt de
 * gekozen sortering + seed). */
function viewFromState(state: {
  mode: 'custom' | 'grid' | 'scatter'
  positions: NodePosition[]
  gridSort: GridSort
  gridSeed: number
}): LayoutView {
  if (state.mode === 'custom') return { mode: 'custom' }
  if (state.mode === 'grid')
    return { mode: 'grid', positions: state.positions, sort: state.gridSort, seed: state.gridSeed }
  return { mode: 'scatter', positions: state.positions }
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

/** Schakel echte fullscreen (borderloos, hele monitor — geen OS-titelbalk). In Tauri
 * via de venster-API, in de browser-dev via de Fullscreen-API. Voor F11. */
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

/** Maximaliseer/herstel het OS-venster (zoals het maximaliseer-knopje in de
 * titelbalk): beeldvullend mét vensterrand. Voor F. Alleen in Tauri; in de browser
 * bestaat maximaliseren niet los van fullscreen → geen-op. */
async function toggleMaximize(): Promise<void> {
  try {
    if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      await getCurrentWindow().toggleMaximize()
    }
  } catch {
    /* niet beschikbaar → negeren */
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
  // Overzicht na een index-actie die metadata materialiseerde (of problemen vond).
  const [matReport, setMatReport] = useState<MaterializationReport | null>(null)
  const [editing, setEditing] = useState<null | { id: string; kind: 'text' | 'photo'; value: string }>(null)
  const [eventForm, setEventForm] = useState<null | EventForm>(null)
  const [metaForm, setMetaForm] = useState<null | MetaForm>(null)
  const [songForm, setSongForm] = useState<null | SongForm>(null)
  const [addSong, setAddSong] = useState<null | AddSongForm>(null)
  // https-link van het gefocuste liedje (L3), of null. Stuurt de "Openen"-knop.
  const [focusSourceUrl, setFocusSourceUrl] = useState<string | null>(null)
  // Id van het gefocuste liedje MET een lokaal bestand, of null. Stuurt zowel de
  // afspeelknop in de dock als de spatiebalk.
  const [focusPlayableId, setFocusPlayableId] = useState<string | null>(null)
  // Muziek. `nowPlaying` is de enige speler in de app; er klinkt nooit meer dan
  // één liedje tegelijk.
  const [nowPlaying, setNowPlaying] = useState<NowPlaying | null>(null)
  const [musicPaused, setMusicPaused] = useState(false)
  // Speelde er muziek toen een video begon? Dan hervatten we na afloop, zodat de
  // twee elkaar niet overstemmen.
  const musicResumeRef = useRef(false)
  // Refs voor de toets-closure (die wordt één keer geregistreerd).
  const nowPlayingRef = useRef<NowPlaying | null>(null)
  nowPlayingRef.current = nowPlaying
  const focusPlayableRef = useRef<string | null>(null)
  focusPlayableRef.current = focusPlayableId
  // Of het gefocuste item een video IS. Bewust apart van `focusVideoId`: die is
  // een mount-vlag voor de DOM-overlay en wordt tijdens elke stap/transitie
  // even null. Daarop pauzeren gaf een hoorbare muziekflard bij élke stap.
  const [videoFocused, setVideoFocused] = useState(false)
  const videoFocusedRef = useRef(false)
  const stopMusicRef = useRef<() => void>(() => {})
  // WELK liedje automatisch begon (bij het openen van een memory), of null.
  //
  // Bewust een id en geen boolean: een vlag wordt alleen gezet en nooit gewist bij
  // een handmatige start, dus zodra je zelf iets anders aanzette na een
  // auto-start werd dat óók als "automatisch" afgekapt bij het verlaten -- precies
  // de belofte die de instelling doet, gebroken.
  const autoStartedIdRef = useRef<string | null>(null)
  // Gestylede bevestigings-dialoog voor destructieve acties (i.p.v. het
  // stijlbrekende native window.confirm).
  const [confirmBox, setConfirmBox] = useState<null | {
    message: string
    confirmLabel: string
    onConfirm: () => void
  }>(null)
  const [layoutMode, setLayoutMode] = useState<'custom' | 'grid' | 'scatter'>('custom')
  const [gridSort, setGridSortMode] = useState<'date' | 'name' | 'random'>('date')
  // Weergave-popover (schuifjes-knop in de actie-balk): foto's-bijsnijden +
  // (in grid) sortering. Als open overlay geregistreerd zodat Escape 'm sluit
  // i.p.v. uit te zoomen.
  const [weergaveOpen, setWeergaveOpen] = useState(false)
  // Brug tussen de React-state en de gesture-handlers (die buiten React draaien).
  const syncRingsRef = useRef<() => void>(() => {})
  // Welke omslag-hint er bovenin staat terwijl je Ctrl (of Ctrl+Shift) vasthoudt.
  // Zonder deze balk is de enige aanwijzing een gekleurde rand om een foto die je
  // misschien niet eens in beeld hebt -- en bij een memory zónder omslag zie je
  // helemaal niets gebeuren.
  const [ringHint, setRingHint] = useState<null | { kind: 'cover' | 'year'; has: boolean }>(null)
  const setCoverPickModeRef = useRef<(on: boolean) => void>(() => {})
  // Formulier dat op "kies een omslagfoto" tijdelijk opzij is gezet, zodat de dialoog
  // ná het kiezen terugkomt met alles wat je al had ingevuld.
  const pendingEditFormRef = useRef<EventForm | null>(null)
  // Plakkende "kies de omslagfoto"-modus: dezelfde actie als Ctrl+klik, maar zonder
  // een toets vast te houden — en mét zichtbare uitleg in beeld, want de Ctrl-weg
  // was onvindbaar. Een ref ernaast omdat de gesture-handlers buiten React draaien.
  const [coverPick, setCoverPick] = useState(false)
  const coverPickRef = useRef(false)
  const [coverHint, setCoverHint] = useState<string | null>(null)
  const coverHintTimerRef = useRef<number>(0)

  /** Plakkende kies-modus aan/uit. Houdt de ref, de randen op het canvas en de
   * uitleg-balk in beeld synchroon. */
  const setCoverPickMode = useCallback((on: boolean): void => {
    if (on && levelRef.current !== 'event') return // kiezen kan alleen op het canvas
    if (coverPickRef.current === on) return
    coverPickRef.current = on
    setCoverPick(on)
    setCoverHint(null)
    window.clearTimeout(coverHintTimerRef.current)
    syncRingsRef.current()
    // Kwam je hier vanuit "Memory bewerken"? Dan gaat de dialoog weer open zodra het
    // kiezen klaar is — mét de titel/datums die je al had ingevuld, en met de nieuwe
    // omslag erin. Anders zou één klik op het thumbnail-blok je bewerking wissen.
    if (!on && pendingEditFormRef.current) {
      const form = pendingEditFormRef.current
      pendingEditFormRef.current = null
      // Sloot het kiezen doordat je iets ánders opende (dialoog, instellingen, zoeken,
      // diavoorstelling) of doordat je naar de kijk-modus ging? Dan die keuze
      // respecteren en niet alsnog een bewerk-dialoog eroverheen zetten.
      if (dialogOpenRef.current || overlayOpenRef.current || settingsRef.current.viewMode) return
      const featured = currentEventInfoRef.current?.featuredPhoto
      setEventForm({
        ...form,
        coverItemId: featured
          ? currentItemsRef.current.find((it) => it.slug === featured || it.id === featured)?.id
          : undefined,
      })
    }
  }, [])
  setCoverPickModeRef.current = setCoverPickMode

  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // Thema-kiezer voor het huidige jaar (L1) of event (L2): klein overlay-paneel,
  // keuzes worden direct toegepast (live preview via scene-herbouw op de plek).
  const [themePanel, setThemePanel] = useState<null | 'year' | 'event'>(null)
  // De huidige keuze van het open paneel (state-spiegel van currentThemeChoicesRef).
  const [themePanelValue, setThemePanelValue] = useState<ThemeChoiceLike | null>(null)
  // Serialisatie-ketting voor thema-writes (volgorde-garantie bij snel klikken).
  const themeWriteChainRef = useRef<Promise<void>>(Promise.resolve())
  // Debug: fps-tellertje (F9) voor in-app perf-metingen op de echte scenes.
  const [showFps, setShowFps] = useState(false)
  // uiMode van het thema van het HUIDIGE niveau (kan afwijken van het
  // app-thema, bijv. een donker Kodachrome-jaar in een lichte app) — stuurt de
  // over-het-canvas zwevende titel.
  const [sceneUiMode, setSceneUiMode] = useState<'dark' | 'light'>('dark')
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
  // Vensterstand-toetsen. Beide raken ALLEEN het OS-venster, nooit de app-knoppen —
  // die staan puur op de kijkmodus (E) + instellingen. F11 = chromeless volledig
  // scherm (borderloos, geen OS-titelbalk); F = venster maximaliseren (mét rand).
  const toggleFsRef = useRef<() => void>(() => {})
  const toggleMaxRef = useRef<() => void>(() => {})
  // Content-beeldvullend (alleen L3): het item vult het scherm + geblurde
  // achtergrond-vulling. Een voorkeur (ref) die bij het openen van een item wordt
  // toegepast; geen chrome-effect, dus geen React-state nodig.
  const contentFillRef = useRef(false)
  const toggleContentFillRef = useRef<() => void>(() => {})
  // Toetsenbord-navigatie actief (focus-markering zichtbaar)?
  const kbNavRef = useRef(false)
  // De zoekknop verbergt na muis-inactiviteit; muisbeweging toont 'm weer. (De ▶-
  // en ⚙-knop blijven altijd staan.)
  const [chromeVisible, setChromeVisible] = useState(true)
  // "Alles passend"-knop: zichtbaar als er inhoud buiten beeld valt (L2).
  const [showFit, setShowFit] = useState(false)
  const showFitRef = useRef(false)
  // L3 video-overlay: id van de gefocuste video (null = geen overlay). De ref is
  // de vergelijkings-spiegel voor de frame-lus; de wrapper wordt imperatief
  // gepositioneerd.
  const [focusVideoId, setFocusVideoId] = useState<string | null>(null)
  const focusVideoIdRef = useRef<string | null>(null)
  // Laatst bekende videoverhouding van de gefocuste video (uit `loadedmetadata`),
  // zodat een snap-herbouw op L3 (themawissel) de verhouding kan herstellen.
  const videoAspectRef = useRef<number | null>(null)
  const videoWrapRef = useRef<HTMLDivElement>(null)
  // De asset-URL van de gefocuste video (async opgehaald: pad → convertFileSrc).
  const [videoSrc, setVideoSrc] = useState('')
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
  /** Het id van een geluidsitem dat écht afspeelbaar is: er moet een lokaal
   * bestand zijn. Een liedje dat alleen een link is, klinkt niet in de app. */
  const playableIdOf = (item: Item | undefined): string | null =>
    item && isSound(item.itemType) && item.media ? item.id : null

  /** Start (of hervat) een liedje. Alleen mogelijk met een LOKAAL audiobestand:
   * `mediaUrl` werpt bij een item zonder media, dus dat pad wordt hier gepoort.
   * Een link-only liedje toont zijn bronknop en klinkt niet in de app. */
  const playSong = async (
    item: Item | undefined,
    /** Automatisch gestart (bij het openen van een memory)? */
    auto = false,
    /** De memory waarvoor de auto-start bedoeld was. */
    forEvent?: string,
  ): Promise<void> => {
    const backend = backendRef.current
    if (!backend || !item || !item.media) return
    const { title, artist } = soundLabel(item)
    const src = await backend.mediaUrl(item.id).catch(() => '')
    if (!src) return
    // `mediaUrl` doet meerdere awaits (waaronder een dynamische import), dus er
    // zit echt tijd tussen. Ben je die memory intussen alweer uit, dan mag er
    // geen muziek meer beginnen -- die zou dan op de jaar- of lifeline-weergave
    // starten én als "handmatig" gelabeld staan, en dus nergens meer stoppen.
    if (auto && (currentEventRef.current !== forEvent || levelRef.current !== 'event')) return
    autoStartedIdRef.current = auto ? item.id : null
    setMusicPaused(false)
    setNowPlaying({ itemId: item.id, title, artist, src })
  }

  // Video aan het woord: muziek pauzeren en na afloop hervatten. `musicResumeRef`
  // onthoudt of hij daarvóór ook echt speelde, zodat een handmatig gepauzeerd
  // liedje niet ineens vanzelf begint.
  useEffect(() => {
    if (videoFocused) {
      if (nowPlayingRef.current && !musicPaused) {
        musicResumeRef.current = true
        setMusicPaused(true)
      }
    } else if (musicResumeRef.current) {
      musicResumeRef.current = false
      setMusicPaused(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoFocused])

  /** Start automatisch het eerste liedje van een memory (met een korte infade),
   * als de instelling dat toestaat. Alleen liedjes (`song`), nooit een gesproken opname: die hoort niet
   * vanzelf te beginnen. En nooit als er al iets speelt -- dan zou het openen van
   * een memory je huidige nummer onderbreken. */
  const autoPlayForEvent = (items: Item[], eventId: string): void => {
    if (settingsRef.current.musicAuto !== 'diavoorstelling-en-memory') return
    if (nowPlayingRef.current) return
    const first = items.find((i) => i.itemType === 'song' && i.media)
    if (first) void playSong(first, true, eventId)
  }

  const stopMusic = (): void => {
    setNowPlaying(null)
    setMusicPaused(false)
    musicResumeRef.current = false
    autoStartedIdRef.current = null
  }
  stopMusicRef.current = stopMusic

  /** De https-link van een liedje, of null. Alleen `song`: bij een gesproken memo
   * is er niets om extern te openen. */
  const sourceUrlOf = (item: Item | undefined): string | null => {
    if (!item || item.itemType !== 'song') return null
    const url = normalizeLink(item.url ?? '')
    return url.startsWith('https://') ? url : null
  }

  const focusTitleFor = (item: Item | undefined): string => {
    const cap = item?.caption?.trim()
    if (settingsRef.current.photoTitleFromCaption && cap) return cap
    const info = currentEventInfoRef.current
    return info ? info.title || info.startAt : 'Memory Lane'
  }

  const updateSettings = (patch: Partial<Settings>): void => {
    // Vóór de merge bepalen (daarna is settingsRef al bijgewerkt): een klik op
    // het al-actieve thema mag de scene niet voor niets herbouwen.
    const themeChanged = patch.themeId !== undefined && patch.themeId !== settingsRef.current.themeId
    const next = { ...settingsRef.current, ...patch }
    settingsRef.current = next
    setSettings(next)
    saveSettings(next)
    applyPanLockRef.current() // pan-lock meteen toepassen op het huidige niveau
    // Themawissel: activeren + de actieve scene op zijn plaats herbouwen.
    if (themeChanged) applyThemeRef.current(next.themeId)
    if (patch.l3StepAnimation !== undefined) sceneRef.current?.setAnimateSteps?.(next.l3StepAnimation)
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
    // Kijk-modus: het notitie-sleep-hoekje hoort weg zolang bewerken uit staat.
    if (patch.viewMode !== undefined) {
      sceneRef.current?.setEditable?.(!next.viewMode)
      if (next.viewMode) setCoverPickMode(false) // kijk-modus → niets te kiezen
    }
    // Randdikte: een live setter, géén scene-herbouw. De schuif vuurt per pixel en
    // `enterYear`/`enterEvent` slaan gelijktijdige aanroepen stil over (enteringRef),
    // waardoor de instelling niet zou aankomen.
    if (patch.borderThickness !== undefined) {
      // De jaar-scene krijgt de proportioneel dunnere waarde, het canvas de rauwe.
      // `sceneRef` en `levelRef` worden altijd in hetzelfde synchrone blok gezet, dus
      // het niveau hoort hier gegarandeerd bij de actieve scene.
      sceneRef.current?.setBorderPx?.(
        levelRef.current === 'year'
          ? yearBorderPx(next.borderThickness)
          : next.borderThickness,
      )
    }
  }

  // Open de thema-kiezer voor het huidige jaar (L1) of event (L2). Synthetische
  // "Losse foto's"-bundels hebben geen eigen _event.md → geen thema mogelijk
  // (zelfde regel als de bestaande curatie).
  const openThemePanel = (scope: 'year' | 'event'): void => {
    if (scope === 'event' && currentEventInfoRef.current?.synthetic) {
      setToast('Losse foto’s — maak er eerst een memory van om een thema te kiezen')
      return
    }
    setThemePanelValue(
      (scope === 'year' ? currentThemeChoicesRef.current.year : currentThemeChoicesRef.current.event) ?? null,
    )
    setThemePanel(scope)
  }

  // Eén thema-keuze van het open paneel toepassen: direct wegschrijven naar de
  // frontmatter (file-first + rescan in de backend) en de scene op zijn plaats
  // herbouwen — dat ís de live preview. "Geërfd" (null) wist het veld weer.
  // Writes worden geserialiseerd (snel doorklikken mag de schrijfvolgorde niet
  // omdraaien) en bij een fout wordt de optimistische update teruggedraaid.
  const changeScopeTheme = (choice: ThemeChoiceLike | null): void => {
    const scope = themePanel
    if (!scope) return
    setThemePanelValue(choice)
    themeWriteChainRef.current = themeWriteChainRef.current.then(async () => {
      const backend = backendRef.current
      if (!backend) return
      const prev =
        (scope === 'year' ? currentThemeChoicesRef.current.year : currentThemeChoicesRef.current.event) ?? null
      try {
        if (scope === 'year') {
          const yid = currentYearRef.current
          if (!yid) return
          currentThemeChoicesRef.current = { ...currentThemeChoicesRef.current, year: choice }
          await backend.setYearTheme(yid, choice)
        } else {
          const eid = currentEventRef.current
          if (!eid) return
          currentThemeChoicesRef.current = { ...currentThemeChoicesRef.current, event: choice }
          await backend.setEventTheme(eid, choice)
        }
        refreshCurrentSceneRef.current()
      } catch (e) {
        currentThemeChoicesRef.current = { ...currentThemeChoicesRef.current, [scope]: prev }
        setThemePanelValue(prev)
        setToast(String(e))
      }
    })
  }

  // F11 = chromeless volledig scherm (borderloos). F = venster maximaliseren.
  // Beide raken ALLEEN het OS-venster — de app-knoppen blijven staan zoals ze staan
  // (die volgen puur de kijkmodus E + instellingen). Raakt de content-fit NIET (dat
  // is Shift+F). Herfit een paar frames zodat de L3-fit na de viewport-wijziging klopt.
  const doToggleFullscreen = (): void => {
    void toggleFullscreen()
    refitFramesRef.current = 8
  }
  toggleFsRef.current = doToggleFullscreen
  const doToggleMaximize = (): void => {
    void toggleMaximize()
    refitFramesRef.current = 8
  }
  toggleMaxRef.current = doToggleMaximize

  // Content-beeldvullend aan/uit (Shift+F). Alleen zinvol op L3: dan vult het item
  // het scherm (langste zijde) met geblurde achtergrond-vulling. Buiten focus
  // onthouden we alleen de voorkeur (toegepast bij het openen van een item).
  const doToggleContentFill = (): void => {
    const on = !contentFillRef.current
    contentFillRef.current = on
    if (levelRef.current === 'focus') {
      sceneRef.current?.setFullscreen?.(on)
      refitFramesRef.current = 8
    }
  }
  toggleContentFillRef.current = doToggleContentFill

  // Sneltoetsen op een kale letter: E = view-modus (knoppen tonen/verbergen),
  // S = diavoorstelling starten. (Geen Ctrl/Alt/Meta; niet in een invoerveld of
  // onder een open dialog/overlay.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // F11: chromeless volledig scherm (borderloos, geen OS-titelbalk) — werkt
      // overal (ook in invoervelden). De app-knoppen blijven staan zoals ze staan.
      if (e.key === 'F11') {
        e.preventDefault()
        toggleFsRef.current()
        return
      }
      // F9: fps-overlay (debug) aan/uit — werkt overal.
      if (e.key === 'F9') {
        e.preventDefault()
        setShowFps((v) => !v)
        return
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const el = document.activeElement
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return
      if (dialogOpenRef.current || overlayOpenRef.current) return
      // Spatie NIET window-breed: `FocusVideoLayer` claimt die toets al zodra er
      // een video gefocust is. Alleen reageren als L3 open staat én het gefocuste
      // item echt een afspeelbaar geluidsitem is.
      if (e.key === ' ' && levelRef.current === 'focus' && focusPlayableRef.current) {
        e.preventDefault()
        const id = focusPlayableRef.current
        if (nowPlayingRef.current?.itemId === id) setMusicPaused((v) => !v)
        else void playSong(currentItemsRef.current.find((i) => i.id === id))
        return
      }
      if (e.key === 'e' || e.key === 'E') {
        e.preventDefault()
        updateSettings({ viewMode: !settingsRef.current.viewMode })
      } else if (e.key === 't' || e.key === 'T') {
        e.preventDefault()
        updateSettings({ showTitle: !settingsRef.current.showTitle }) // titel bovenin aan/uit
      } else if (e.key === 's' || e.key === 'S') {
        e.preventDefault()
        startScreensaverRef.current()
      } else if (e.key === 'f' || e.key === 'F') {
        // Kale f = venster maximaliseren; Shift+F = content-beeldvullend (L3).
        e.preventDefault()
        if (e.shiftKey) toggleContentFillRef.current()
        else toggleMaxRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Titel aan/uit (T of instellingen) → de dag-gids in het jaar-overzicht laten
  // beginnen onder of vanaf de bovenrand. Alleen zinvol op L1; andere scenes hebben
  // geen setTitleInset (optional chaining vangt dat af).
  useEffect(() => {
    if (levelRef.current === 'year') {
      sceneRef.current?.setTitleInset?.(settings.showTitle ? TITLE_INSET_PX : 0)
    }
  }, [settings.showTitle])

  // Datum-highlight bij hover aan/uit → doorgeven aan de jaar-scene (live).
  useEffect(() => {
    if (levelRef.current === 'year') sceneRef.current?.setHoverPulse?.(settings.hoverPulse)
  }, [settings.hoverPulse])

  // Fijne maatverdeling (week/dag) aan/uit → doorgeven aan de jaar-scene (live).
  useEffect(() => {
    if (levelRef.current === 'year') sceneRef.current?.setFineTicks?.(settings.fineTicks)
  }, [settings.fineTicks])

  // Viewport-wijziging (venster-resize / fullscreen) → focus-scene herfitten. De
  // frame-lus voert het uit ná Pixi's eigen resize (vlag i.p.v. direct).
  useEffect(() => {
    const onResize = (): void => {
      refitFramesRef.current = 8
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // Toetsenbord-navigatie (lifeline, jaar-view, memory-canvas én detail). Pijltjes
  // verplaatsen de focus (de eerste druk toont 'm bij het scherm-midden); Enter
  // gaat een niveau dieper (lifeline→jaar, jaar→memory, canvas→item-focus, en op
  // het detail-niveau → content-beeldvullend). Muis zet terug naar muis-modus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const el = document.activeElement
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return
      if (dialogOpenRef.current || overlayOpenRef.current) return
      if (engineRef.current?.isTransitioning) return
      const lvl = levelRef.current
      // De pijltjes-focus-nav geldt alleen op de spatiale niveaus; op het detail-
      // niveau (L3) handelt de FocusScene de pijltjes zelf af (vorige/volgende).
      const navLevel = lvl === 'lifeline' || lvl === 'year' || lvl === 'event'
      const scene = sceneRef.current
      const dir =
        e.key === 'ArrowLeft' ? 'left'
        : e.key === 'ArrowRight' ? 'right'
        : e.key === 'ArrowUp' ? 'up'
        : e.key === 'ArrowDown' ? 'down'
        : null
      if (dir) {
        if (!navLevel || !scene?.focusNeighbor) return
        e.preventDefault()
        kbNavRef.current = true
        if (!scene.focusedId?.()) scene.focusFirst?.()
        else scene.focusNeighbor(dir)
      } else if (e.key === 'Enter') {
        if (lvl === 'focus') {
          // Detail-niveau → één niveau dieper = content-beeldvullend (aan als 't uit is).
          e.preventDefault()
          if (!contentFillRef.current) toggleContentFillRef.current()
          return
        }
        if (!navLevel) return
        const id = scene?.focusedId?.()
        if (id) {
          e.preventDefault()
          // Toetsenbord-drill-in: het diepere niveau opent meteen in focus-modus.
          if (lvl === 'lifeline') enterYearRef.current(id, true)
          else if (lvl === 'year') enterEventRef.current(id, true)
          else enterFocusRef.current(id) // memory-canvas → L3 (één item, geen focus-modus)
        }
      }
    }
    const clearNav = (): void => {
      if (kbNavRef.current) {
        kbNavRef.current = false
        sceneRef.current?.clearKbFocus?.()
      }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', clearNav)
    window.addEventListener('pointermove', clearNav) // muis bewegen = terug naar muis-modus
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', clearNav)
      window.removeEventListener('pointermove', clearNav)
    }
  }, [])

  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const searchTimerRef = useRef<number | undefined>(undefined)

  // `kbDrill` = toetsenbord-drill-in (Enter): het bovenliggende niveau opent meteen
  // in focus-modus met de eerste memory/foto gefocust.
  const enterEventRef = useRef<(id: string, kbDrill?: boolean) => void>(() => {})
  const enterYearRef = useRef<(id: string, kbDrill?: boolean) => void>(() => {})
  const enterFocusRef = useRef<(id: string) => void>(() => {})
  // Afteller: viewport gewijzigd (bv. (uit) fullscreen) → herfit de focus-scene een
  // paar frames lang (Pixi's eigen resize kan een frame later pas settelen).
  const refitFramesRef = useRef(0)
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
  // Rauwe thema-keuzes (jaar + event) van het open event, zodat de focus-scene
  // (L3) en een snap-herbouw vers kunnen resolven tegen het actuele app-thema.
  const currentThemeChoicesRef = useRef<{ year?: ThemeChoiceLike | null; event?: ThemeChoiceLike | null }>({})
  const currentYearCoverRef = useRef<string | null>(null) // item-id van de jaar-cover
  // Alle trefwoorden die in het huidige jaar voorkomen — voor de suggestie-chips in de
  // bewerk-dialoog én voor de filterbalk. Bewust op de ONGEFILTERDE lijst gevuld:
  // anders verdwijnen de andere tags uit beeld zodra je filtert en kun je alleen nog
  // wissen.
  const yearTagsRef = useRef<string[]>([])
  // Actief tagfilter op de jaar-tijdlijn (leeg = alles). In een ref én in state: de
  // scene-opbouw draait buiten React, de balk hoort in React.
  // Bewust NIET in localStorage: een filter dat een herstart overleeft opent de app
  // met een (schijnbaar) lege tijdlijn, en de oorzaak staat dan buiten beeld.
  const [tagFilter, setTagFilter] = useState<string[]>([])
  const tagFilterRef = useRef<string[]>([])
  // Filterwissels debouncen: `enterYear` slaat een aanroep stil over als er al één
  // loopt (`enteringRef`), dus snel achter elkaar klikken zou een wissel verliezen.
  const tagFilterTimerRef = useRef<number>(0)

  /** Zet het tagfilter en herbouw het jaar op zijn plek (camera blijft staan). */
  const applyTagFilter = useCallback((next: string[]): void => {
    tagFilterRef.current = next
    setTagFilter(next)
    window.clearTimeout(tagFilterTimerRef.current)
    // Vastleggen wáár we stonden: navigeer je binnen de debounce weg, dan zou de
    // herbouw op het nieuwe niveau landen en daar een lopende reveal-animatie
    // afbreken (die herbouw krijgt `snapCam` mee en bevriest de camera halverwege).
    const level = levelRef.current
    const year = currentYearRef.current
    const run = (): void => {
      if (levelRef.current !== level || currentYearRef.current !== year) return
      // `enterYear` slaat een aanroep stil over zolang er al één loopt; opnieuw
      // plannen i.p.v. laten vallen, anders toont de balk een filter dat de tijdlijn
      // niet heeft toegepast en is er geen weg terug behalve nog eens klikken.
      if (enteringRef.current) {
        tagFilterTimerRef.current = window.setTimeout(run, 60)
        return
      }
      refreshCurrentSceneRef.current()
    }
    tagFilterTimerRef.current = window.setTimeout(run, 90)
  }, [])
  const currentItemsRef = useRef<Item[]>([])
  const entryZoomRef = useRef(1)
  const enterSeqRef = useRef(0)
  const enteringRef = useRef(false)
  const applyPanLockRef = useRef<() => void>(() => {})
  // Muis-terug (terugknop linksboven + rechtermuisknop). No-op default zodat een
  // klik vóór de mount-effect 'm zet niet crasht.
  const goBackRef = useRef<() => void>(() => {})
  // Onthouden zoom-/pan-stand van de lifeline (L0): zodat terugkeer naar L0 het
  // vorige zoomniveau herstelt i.p.v. altijd "alles passend" te fitten. Bevat het
  // jaar-aantal + viewport zodat we bij een gewijzigde layout terugvallen op fit.
  const lifelineCamRef = useRef<{
    x: number
    y: number
    zoom: number
    yearCount: number
    vpW: number
    vpH: number
  } | null>(null)
  // Zodat instellingen (jaar-tegel-slideshow) de lifeline live kunnen herbouwen.
  const setupLifelineRef = useRef<() => void>(() => {})
  // Themawissel: activeert het thema en herbouwt de actieve scene op zijn plaats
  // (zelfde niveau + camera, zonder overgangsanimatie — live preview).
  const applyThemeRef = useRef<(id: string) => void>(() => {})
  // Alleen de scene-herbouw op de huidige plek (voor de jaar-/event-kiezers).
  const refreshCurrentSceneRef = useRef<() => void>(() => {})
  // Canvas-achtergrond (kleur + evt. textuurlaag) van het huidige niveau zetten.
  const setCanvasBackgroundRef = useRef<(t: ResolvedTheme, worldLocked: boolean) => void>(() => {})

  useEffect(() => {
    let engine: RenderEngine | null = null
    let disposed = false
    // Font-race (plan §6/§10): is de eager font-load al klaar, en is er een scene
    // gebouwd vóórdat de fonts binnen waren? Dan hertekenen we eenmalig zodra ze
    // er zijn (anders blijven Pixi-Text-metrics op de fallback-stack staan).
    let fontsDone = false
    let sceneBuiltBeforeFonts = false
    let ctrlDown = false // Ctrl ingedrukt → dag-indicator op de jaar-tijdlijn
    // Zet door de Ctrl-sleep-handle bij `end()`; door de eropvolgende `onTap`
    // geconsumeerd. Zo wordt de tap ná een Ctrl-sleep/klik betrouwbaar onderdrukt,
    // óók als de gebruiker Ctrl losliet tussen pointerdown en pointerup (dan is
    // `ctrlDown` al false en zou de tap anders alsnog navigeren + dubbel openen).
    let rangeJustEnded = false
    // Dubbelklik-detectie op de lifeline (lege ruimte) → passend ↔ standaard.
    let lastL0Tap = { t: 0, x: 0, y: 0 }

    // Achtergrond van het huidige niveau: effen thema-kleur + (indien het
    // thema een textuur heeft) de tiling-laag. `worldLocked` = camera-
    // gekoppeld (L2/L3); op L0/L1 staat de textuur stil op het scherm. De
    // async texture-load is race-vrij via een volgnummer.
    let bgSeq = 0
    const setCanvasBackground = (t: ResolvedTheme, worldLocked: boolean): void => {
      if (!engine) return
      engine.app.renderer.background.color = t.colors.appBg
      setSceneUiMode(t.uiMode)
      const bg = t.background
      const seq = ++bgSeq
      if (bg.kind !== 'texture') {
        engine.setBackground(null, 0, false)
        return
      }
      void loadBackgroundTexture(bg.textureId).then((tex) => {
        if (disposed || seq !== bgSeq || !engine) return
        engine.setBackground(tex, bg.tint, worldLocked)
      })
    }
    setCanvasBackgroundRef.current = setCanvasBackground

    // `snapCam`: animatieloze herbouw op de huidige plek (themawissel): geen
    // exit-/reveal-animatie en de camera wordt exact op deze stand teruggezet.
    /** Muziek die automatisch bij een memory begon, hoort ook bij die memory te
     * stoppen. Handmatig gestarte muziek blijft juist wél doorspelen: die heb je
     * zelf aangezet. `autoStartedRef` houdt dat onderscheid vast. */
    const stopAutoMusicOnLeave = (): void => {
      if (autoStartedIdRef.current && nowPlayingRef.current?.itemId === autoStartedIdRef.current) {
        stopMusicRef.current()
      }
      autoStartedIdRef.current = null
    }

    const setupLifeline = (focusAfter?: string, snapCam?: { x: number; y: number; zoom: number }): void => {
      if (!engine || !backendRef.current) return
      stopAutoMusicOnLeave()
      if (!fontsDone) sceneBuiltBeforeFonts = true
      // Invalideer een eventuele in-flight enterYear.
      enterSeqRef.current++
      // Oud niveau laat uitzoomen + uitfaden (crossfade), niet hard weg.
      const old = sceneRef.current
      sceneRef.current = null
      if (old) {
        if (snapCam) old.destroy()
        else engine.exitScene(old.root, 'out', () => old.destroy())
      }
      // Canvas-achtergrond volgt het thema van het huidige niveau: op L0 het
      // app-thema (jaar-thema's kleuren alleen hun eigen tegel).
      setCanvasBackground(THEME, false)
      const scene = new LifelineScene(engine, backendRef.current, yearsRef.current, {
        enabled: settingsRef.current.yearTileSlideshow,
        mode: settingsRef.current.yearCoverMode,
        speedMs: settingsRef.current.slideshowSpeed * 1000,
      })
      sceneRef.current = scene
      // Herstel het onthouden L0-zoom-/pan-niveau i.p.v. de constructor-fit — mits
      // de layout (jaar-aantal) én viewport ongewijzigd zijn (anders klopt de
      // positie niet en valt 'ie terug op fit). Móet vóór revealScene: die leest
      // camera.x/y als pivot/doel.
      const rc = lifelineCamRef.current
      const vpNow = engine.viewport()
      if (snapCam) {
        engine.jumpCamera(snapCam.x, snapCam.y, snapCam.zoom)
      } else if (
        rc &&
        rc.yearCount === yearsRef.current.length &&
        rc.vpW === vpNow.width &&
        rc.vpH === vpNow.height
      ) {
        engine.jumpCamera(rc.x, rc.y, rc.zoom)
      }
      if (!snapCam) engine.revealScene(scene.root, 'out')
      // Wis de elastische jaar-scroll-staat SYNCHROON. Anders draait op de
      // eerstvolgende tick `tickInertia` nog met de oude jaar-`boundsX` (die pas
      // later in `onFrame` op null gaat) én een `rawX` die door de pointerdown van
      // de klik op een uit-de-band gescrollde camera-x gepegd is → de bounce-tak
      // vuurt, verspringt de camera én roept `onChange()` aan, wat de net gestarte
      // reveal/exit hard afbreekt (abrupte terugsprong). Escape mist die pointerdown
      // en trof dit niet. jumpCamera zette de camera al op de lifeline; peg de
      // elastische positie daarop en haal de grens weg.
      engine.camera.boundsX = null
      engine.syncElastic()
      levelRef.current = 'lifeline'
      setUiLevel('lifeline')
      setHeader({ text: 'Memory Lane', dir: 'out' })
      applyPanLock()
      // Focus-continuïteit bij terug (Escape): het jaar waar je vandaan komt krijgt
      // de toetsenbord-focus (markering verschijnt, muisbeweging wist 'm weer).
      if (focusAfter) {
        scene.focusOn?.(focusAfter)
        kbNavRef.current = true
      }
    }
    setupLifelineRef.current = setupLifeline

    const enterYear = async (
      yearId: string,
      dir: 'in' | 'out' | 'slideNext' | 'slidePrev' = 'in',
      focusAfter?: string,
      focusFirstAfter?: boolean,
      // Animatieloze herbouw op de huidige plek (themawissel): geen exit/reveal,
      // camera exact terug op deze stand.
      snapCam?: { x: number; y: number; zoom: number },
    ): Promise<void> => {
      if (!engine || !backendRef.current || enteringRef.current) return
      stopAutoMusicOnLeave()
      enteringRef.current = true
      const seq = ++enterSeqRef.current
      // Zijwaartse jaar-overgang (+1 = nieuwe jaar komt van rechts): oude scene
      // schuift de andere kant uit, nieuwe schuift van deze kant in.
      const slide = dir === 'slideNext' || dir === 'slidePrev'
      const slideDir = dir === 'slideNext' ? 1 : -1
      try {
        const detail = await backendRef.current.getYear(yearId)
        if (disposed || !engine || seq !== enterSeqRef.current || !detail) return
        // Trefwoorden van dít jaar, vóór het filter — de filterbalk en de
        // suggestie-chips moeten alle tags blijven tonen, ook als er één actief is.
        yearTagsRef.current = [...new Set(detail.events.flatMap((e) => e.tags ?? []))].sort()
        // Filteren gebeurt hier, bij de scene-OPBOUW: de renderlus en de gebakken
        // periode-balken kennen geen "verborgen" stand, en zo komt de vrijgekomen
        // ruimte automatisch ten goede aan de memories die je wél wilde zien.
        const active = tagFilterRef.current
        const filtered =
          active.length === 0
            ? detail
            : {
                ...detail,
                events: detail.events.filter((e) => (e.tags ?? []).some((t) => active.includes(t))),
              }
        // Oud niveau meebewegen + uitfaden (crossfade). Móet vóór de nieuwe
        // scene-constructor: die roept jumpCamera en verandert de camera.
        const old = sceneRef.current
        sceneRef.current = null
        if (old) {
          // Jaar-entry/-exit zoomt symmetrisch door het SCHERMMIDDEN (net als het
          // uitzoomen naar de lifeline), niet vanaf de aangeklikte jaar-tegel.
          // Dit hoort bij de gecentreerde reveal hieronder: exit `centered=true`
          // + reveal zonder tap-coördinaten moeten altijd samen wijzigen.
          if (snapCam) old.destroy()
          else if (slide) engine.slideOutScene(old.root, -slideDir, () => old.destroy())
          else engine.exitScene(old.root, dir as 'in' | 'out', () => old.destroy(), undefined, true)
        }
        // Buurjaren (voor de overscroll-preview + jaar-overgang): de jarenlijst is
        // chronologisch oplopend → later jaar = rechts, eerder = links.
        const yi = yearsRef.current.findIndex((y) => y.id === yearId)
        const neighbors = {
          prev: yi > 0 ? yearsRef.current[yi - 1]?.title : undefined,
          next: yi >= 0 && yi < yearsRef.current.length - 1 ? yearsRef.current[yi + 1]?.title : undefined,
        }
        // Canvas-achtergrond volgt het geresolvede jaar-thema — zo heeft een
        // Kodachrome-jaar écht zijn eigen sfeer, en klopt de span-blend (die
        // tegen het jaar-appBg rekent) met wat er achter staat.
        setCanvasBackground(resolveTheme(detail.year.theme), false)
        const scene = new YearScene(engine, backendRef.current, filtered, {
          enabled: settingsRef.current.slideshow,
          speedMs: settingsRef.current.slideshowSpeed * 1000,
          showTitles: settingsRef.current.showMemoryTitles,
          curvedLeaders: settingsRef.current.curvedLeaders,
          neighbors,
          borderPx: yearBorderPx(settingsRef.current.borderThickness),
          emptyReason:
            active.length > 0 && filtered.events.length === 0 && detail.events.length > 0
              ? 'filter'
              : 'none',
        })
        sceneRef.current = scene
        // Animatieloze herbouw: camera exact terug op de stand van vóór de wissel
        // (de constructor deed zojuist een fit-jump).
        if (snapCam) engine.jumpCamera(snapCam.x, snapCam.y, snapCam.zoom)
        // De scene-constructor heeft de camera al naar het nieuwe jaar gezet
        // (jumpCamera). Wis de elastische grens SYNCHROON + peg de rauwe positie op
        // de nieuwe camera. Anders draait de eerste tick `tickInertia` nog met de
        // STALE lifeline-`boundsX` (die pas later in de jaar-`update()` op de juiste
        // waarde gaat) terwijl rawX al op de nieuwe (verre) camera staat → de
        // bounce-tak vuurt, roept `onChange()` aan, en dat breekt de net gestarte
        // reveal/exit hard af (geen zoom-in, camera verspringt, buurjaar gluurt in
        // beeld). Zelfde fix als in setupLifeline. Geldt ook voor de jaar-slide.
        engine.camera.boundsX = null
        engine.syncElastic()
        if (ctrlDown) scene.setDayPicker(true)
        // Dag-gids onder de titel laten beginnen als die aan staat.
        scene.setTitleInset(settingsRef.current.showTitle ? TITLE_INSET_PX : 0)
        scene.setHoverPulse(settingsRef.current.hoverPulse)
        scene.setFineTicks(settingsRef.current.fineTicks)
        // Gecentreerde reveal (geen tap-coördinaten → schermmidden): spiegelt de
        // gecentreerde exit hierboven, zodat een jaar in-/uitzoomen altijd vanuit
        // het midden gebeurt i.p.v. vanaf de aangeklikte tegel (zie comment boven).
        if (!snapCam) {
          if (slide) engine.slideInScene(scene.root, slideDir)
          else engine.revealScene(scene.root, dir as 'in' | 'out')
        }
        levelRef.current = 'year'
        setUiLevel('year')
        setHeader({ text: detail.year.title, dir: slide ? 'in' : (dir as 'in' | 'out') })
        applyPanLock()
        currentYearRef.current = yearId
        currentThemeChoicesRef.current = {
          ...currentThemeChoicesRef.current,
          year: detail.year.theme ?? null,
        }
        // In het snap-pad (themawissel) is de camera net op de oude stand gezet;
        // de entry-referentie (uitzoom-terug/zoomFloor) moet de oorspronkelijke
        // fit-zoom blijven, anders klemt uitzoomen of springt het direct terug.
        if (!snapCam) entryZoomRef.current = engine.pendingZoom
        // Focus-continuïteit bij terug (Escape): de memory waar je vandaan komt
        // krijgt de toetsenbord-focus op de jaar-tijdlijn. Bij toetsenbord-drill-in
        // (Enter vanaf de lifeline): de eerste (vroegste) memory krijgt de focus.
        if (focusAfter) {
          scene.focusOn?.(focusAfter)
          kbNavRef.current = true
        } else if (focusFirstAfter) {
          // Op de GEFILTERDE lijst: focussen op een verborgen memory zet wel de
          // toetsenbord-modus aan maar toont geen focus.
          const first = [...filtered.events].sort((a, b) => a.startAt.localeCompare(b.startAt))[0]
          if (first) {
            scene.focusOn?.(first.id)
            kbNavRef.current = true
          }
        }
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
        saveEventView(eventId, viewFromState(scene.layoutState()))
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
      // Onthouden grid-sortering herstellen (highlight + toekomstige herpak/shuffle).
      if (saved.mode === 'grid') {
        const sort = saved.sort ?? 'date'
        scene.restoreGridSort?.(sort, saved.seed ?? 1)
        setGridSortMode(sort)
      }
      // Wijkt de node-set af van de snapshot (item toegevoegd → matched<total, of
      // verwijderd → snapshot bevat een verweesde ref)? Onthoud de opgeschoonde
      // opstelling, zodat dode refs niet blijven hangen.
      if (matched < total || matched < saved.positions.length) {
        saveEventView(eventId, viewFromState(scene.layoutState()))
      }
    }

    const enterEvent = async (
      eventId: string,
      dir: 'in' | 'out' = 'in',
      focusAfter?: string,
      focusFirstAfter?: boolean,
      // Animatieloze herbouw op de huidige plek (themawissel), zie enterYear.
      snapCam?: { x: number; y: number; zoom: number },
    ): Promise<void> => {
      if (!engine || !backendRef.current || enteringRef.current) return
      // Van memory A naar memory B (bijv. via een zoekresultaat) gaat niet langs
      // het jaar-niveau, dus zonder dit zou het liedje van A doorklinken in B --
      // terwijl B zijn eigen liedje heeft.
      const sameEvent = currentEventRef.current === eventId
      if (!sameEvent) stopAutoMusicOnLeave()
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
        if (old) {
          if (snapCam) old.destroy()
          else engine.exitScene(old.root, dir, () => old.destroy())
        }
        // Canvas-achtergrond volgt het geresolvede event-thema (app → jaar → event).
        setCanvasBackground(resolveTheme(detail.yearTheme, detail.event.theme), true)
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
            saveEventView(eventId, viewFromState(state))
          },
          settingsRef.current.squarePhotos,
          settingsRef.current.borderThickness,
        )
        sceneRef.current = scene
        scene.setEditable(!settingsRef.current.viewMode)
        setGridSortMode('date') // nieuwe scene start op datum-sortering
        // Open in de onthouden weergave van dit event (vóór de reveal, zodat de
        // camera-fit meteen klopt); valt terug op de globale standaard.
        initEventView(scene, eventId)
        if (snapCam) engine.jumpCamera(snapCam.x, snapCam.y, snapCam.zoom)
        else revealScene(engine, scene, dir)
        // Zelfde elastische-staat-reset als bij het uitzoomen naar de lifeline: een
        // naar de rand gescrollde jaar-view (camera buiten `boundsX`) + de pointerdown
        // van een klik op de rand-tegel pegt `rawX` uit de band; zonder deze reset
        // zou `tickInertia` op de eerstvolgende tick (met nog de oude jaar-`boundsX`)
        // de camera verspringen en de zojuist gestarte reveal hard afbreken.
        engine.camera.boundsX = null
        engine.syncElastic()
        levelRef.current = 'event'
        setUiLevel('event')
        syncRingsRef.current() // verse scene: omslag-randen tonen als de kies-modus aan staat
        setHeader({ text: detail.event.title || detail.event.startAt, dir })
        applyPanLock()
        currentEventRef.current = eventId
        currentEventInfoRef.current = detail.event
        currentYearCoverRef.current = detail.yearCover ?? null
        currentThemeChoicesRef.current = { year: detail.yearTheme ?? null, event: detail.event.theme ?? null }
        currentItemsRef.current = detail.items
        // Alleen bij een ECHTE entry, niet bij een verversing van dezelfde memory.
        // `enterEvent` is ook de "herbouw de scene"-route: na een themawissel, een
        // toegevoegde foto of een verwijderd item. Zonder deze conditie begon de
        // muziek die je zojuist had uitgezet daar telkens opnieuw -- en werd
        // "item verwijderen" per ongeluk "volgende nummer".
        if (!sameEvent) autoPlayForEvent(detail.items, eventId)
        // Zie enterYear: entry-referentie alleen bij een echte entry bijwerken.
        if (!snapCam) entryZoomRef.current = engine.pendingZoom
        // Focus-continuïteit bij terug (Escape) uit L3: het item waar je vandaan
        // komt krijgt de toetsenbord-focus in het canvas. Bij toetsenbord-drill-in
        // (Enter vanaf de jaar-view): de eerste foto/video krijgt de focus.
        if (focusAfter) {
          scene.focusOn?.(focusAfter)
          kbNavRef.current = true
        } else if (focusFirstAfter) {
          const first =
            detail.items.find((it) => it.itemType === 'photo' || it.itemType === 'video') ?? detail.items[0]
          if (first) {
            scene.focusOn?.(first.id)
            kbNavRef.current = true
          }
        }
      } catch (e) {
        if (!disposed) {
          setMessage(String(e))
          setPhase('error')
        }
      } finally {
        enteringRef.current = false
      }
    }

    const enterFocus = (
      itemId: string,
      // Animatieloze herbouw op de huidige plek (themawissel), zie enterYear.
      snapCam?: { x: number; y: number; zoom: number },
    ): void => {
      if (!engine || !backendRef.current) return
      const items = currentItemsRef.current
      const index = items.findIndex((it) => it.id === itemId)
      if (index < 0) return
      enterSeqRef.current++ // eventuele in-flight enter invalideren
      // Oud niveau meebewegen + uitfaden (crossfade), vóór de scene-constructor.
      const old = sceneRef.current
      sceneRef.current = null
      if (old) {
        if (snapCam) old.destroy()
        else engine.exitScene(old.root, 'in', () => old.destroy())
      }
      // Canvas-achtergrond volgt het event-thema (zelfde scope als L2).
      setCanvasBackground(resolveTheme(currentThemeChoicesRef.current.year, currentThemeChoicesRef.current.event), true)
      const scene = new FocusScene(
        engine,
        backendRef.current,
        items,
        index,
        (delta, id) => {
          // Titel meelaten lopen bij stappen (tik óf pijltjestoets).
          const it = id ? currentItemsRef.current.find((x) => x.id === id) : undefined
          setHeader({ text: focusTitleFor(it), dir: delta > 0 ? 'in' : 'out' })
          setFocusSourceUrl(sourceUrlOf(it))
          setFocusPlayableId(playableIdOf(it))
        },
        // Vers resolven (app → jaar → event) zodat een themawissel meetelt.
        resolveTheme(currentThemeChoicesRef.current.year, currentThemeChoicesRef.current.event),
      )
      scene.setAnimateSteps(settingsRef.current.l3StepAnimation)
      setFocusSourceUrl(sourceUrlOf(items[index]))
      setFocusPlayableId(playableIdOf(items[index]))
      if (contentFillRef.current) scene.setFullscreen(true)
      sceneRef.current = scene
      if (snapCam) engine.jumpCamera(snapCam.x, snapCam.y, snapCam.zoom)
      else revealScene(engine, scene, 'in')
      levelRef.current = 'focus'
      setUiLevel('focus')
      setHeader({ text: focusTitleFor(items[index]), dir: 'in' })
      applyPanLock()
      // Zie enterYear: entry-referentie alleen bij een echte entry bijwerken.
      if (!snapCam) entryZoomRef.current = engine.pendingZoom
      // Snap-herbouw terwijl een video speelt: de DOM-videolaag blijft gemount
      // (zelfde item), dus `loadedmetadata` vuurt niet opnieuw — herstel de
      // bekende videoverhouding en verberg de Pixi-poster meteen (geen flits).
      if (snapCam && focusVideoIdRef.current === items[index]?.id && videoAspectRef.current !== null) {
        scene.setVideoAspect(videoAspectRef.current)
        scene.setContentHidden(true)
      }
    }

    enterYearRef.current = (id, kbDrill) => void enterYear(id, 'in', undefined, kbDrill)
    enterEventRef.current = (id, kbDrill) => void enterEvent(id, 'in', undefined, kbDrill)
    enterFocusRef.current = (id) => enterFocus(id)

    // Themawissel (instellingen): activeer het thema, zet de Pixi-achtergrondkleur
    // (die is éénmalig gezet bij app.init en geen onderdeel van een scene) en
    // herbouw de actieve scene op zijn plaats — zelfde niveau, zelfde camera,
    // zonder overgangsanimatie (live preview, geen "herlaad"-effect).
    // Herbouw de actieve scene op zijn plaats (zelfde niveau + camera, zonder
    // overgangsanimatie). Gebruikt door de themawissel én door de per-jaar/
    // per-event thema-kiezers (live preview na een frontmatter-write + rescan).
    const refreshCurrentScene = (): void => {
      if (!engine || phaseRef.current !== 'ready') return
      const cam = { x: engine.camera.x, y: engine.camera.y, zoom: engine.camera.zoom }
      const lvl = levelRef.current
      if (lvl === 'lifeline') {
        setupLifeline(undefined, cam)
      } else if (lvl === 'year' && currentYearRef.current) {
        // Toetsenbord-focus meenemen: bij een filterwissel blijft de gefocuste memory
        // anders nergens. `focusOn` is een no-op als hij weggefilterd is.
        void enterYear(currentYearRef.current, 'in', sceneRef.current?.focusedId?.() ?? undefined, false, cam)
      } else if (lvl === 'event' && currentEventRef.current) {
        void enterEvent(currentEventRef.current, 'in', undefined, false, cam)
      } else if (lvl === 'focus') {
        const itemId = sceneRef.current?.currentId?.()
        if (itemId) enterFocus(itemId, cam)
      }
    }
    refreshCurrentSceneRef.current = refreshCurrentScene

    const applyTheme = (id: string): void => {
      setActiveTheme(themeById(id))
      // DOM-achtergrond meekleuren met het thema. index.html zet een hardcoded
      // donker #0a0a0f op html/body/#root — zonder deze override flitst dat bij
      // resize/opstart onder lichte thema's. body alléén is niet genoeg: #root
      // ligt erbovenop met dezelfde CSS-achtergrond.
      applyDomBackground()
      if (!engine) return
      engine.app.renderer.background.color = THEME.colors.appBg
      refreshCurrentScene()
    }
    applyThemeRef.current = applyTheme

    // Verticale-pan-lock toepassen op basis van niveau + instelling (alleen de
    // horizontale niveaus L0/L1).
    const applyPanLock = (): void => {
      if (!engine) return
      const lvl = levelRef.current
      // Op de horizontale niveaus (lifeline + jaar-view) staat de verticale lock
      // ALTIJD aan: je schuift/zoomt daar alleen zijwaarts. De inhoud staat verticaal
      // gecentreerd (camera.y=0); verticaal pannen heeft er geen zin.
      engine.camera.lockY = lvl === 'year' || lvl === 'lifeline'
      // Bij een actieve lock de as/inhoud precies verticaal centreren (y=0).
      if (engine.camera.lockY) engine.camera.y = 0
    }
    applyPanLockRef.current = applyPanLock

    // Eén niveau terug (Esc / uitzoomen). Bij `viaKeyboard` (Escape) krijgt het
    // item/de memory/het jaar waar je vandaan komt de toetsenbord-focus op het
    // niveau erboven (focus-continuïteit); bij een muisklik-terug niet (muis-modus).
    const goBack = (viaKeyboard = false): void => {
      if (enteringRef.current) return
      const lvl = levelRef.current
      if (lvl === 'year') {
        setupLifeline(viaKeyboard ? currentYearRef.current ?? undefined : undefined)
      } else if (lvl === 'event' && currentYearRef.current) {
        void enterYear(currentYearRef.current, 'out', viaKeyboard ? currentEventRef.current ?? undefined : undefined)
      } else if (lvl === 'focus' && currentEventRef.current) {
        const itemId = viaKeyboard ? sceneRef.current?.currentId?.() ?? undefined : undefined
        void enterEvent(currentEventRef.current, 'out', itemId)
      }
    }

    // Muis-terug (terugknop + rechtermuisknop): zelfde tweetraps als Escape op het
    // detail-niveau in content-beeldvullend (eerst content-fill uit, dán een niveau
    // terug), maar in muis-modus (goBack(false), geen focus-continuïteit).
    const mouseBack = (): void => {
      if (levelRef.current === 'focus' && contentFillRef.current) {
        toggleContentFillRef.current()
        return
      }
      goBack(false)
    }
    goBackRef.current = mouseBack

    // Ctrl+klik op een foto (L2): togglet de uitgelichte foto (jaar-omslag).
    // Optimistisch: markering + info meteen bij, schrijf async weg.
    const toggleFeatured = (ref: string, force = false): void => {
      const backend = backendRef.current
      const eventId = currentEventRef.current
      if (!backend || !eventId) return
      // Losse "Losse foto's"-bundel: geen eigen _event.md → uitlichten kan niet
      // persisteren. Niet stil proberen (verwarrend), maar een korte hint tonen.
      if (currentEventInfoRef.current?.synthetic) {
        setToast('Losse foto’s — maak er eerst een memory van om een omslag te kiezen')
        return
      }
      const current = currentEventInfoRef.current?.featuredPhoto ?? null
      // Ctrl+klik is een toggle (nogmaals klikken = omslag loslaten). In de expliciete
      // "kies de omslagfoto"-modus is dat fout: je klikt om te KIEZEN, en de foto die
      // al de omslag is aanklikken zou 'm dan stil wissen.
      const next = !force && current === ref ? null : ref
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
      // Een memory die de jaargrens kruist staat in twee jaren, maar de vaste
      // jaar-omslag hoort bij het jaar waar de memory WOONT (zijn map). Kom je hier
      // vanuit het buurjaar, dan is het onduidelijk welk jaar je zojuist prikte —
      // benoem het dan expliciet in plaats van het stil te doen.
      if (currentYearRef.current && currentYearRef.current !== info.yearId) {
        const owner = yearsRef.current.find((y) => y.id === info.yearId)
        setToast(
          next
            ? `Vaste omslag gezet voor ${owner?.title ?? 'het eigen jaar'} — deze memory hoort daarbij`
            : `Vaste omslag van ${owner?.title ?? 'het eigen jaar'} losgelaten`,
        )
      }
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
      // Lifeline-zoom-shortcuts: Ctrl+0 = alles passend, Ctrl+1 = standaard
      // kaartgrootte (beide geanimeerd). Alleen op de lifeline, niet met een open
      // dialog (nieuw jaar/memory) waaronder de camera anders zou bewegen.
      if (
        e.ctrlKey &&
        (e.key === '0' || e.key === '1') &&
        levelRef.current === 'lifeline' &&
        !dialogOpenRef.current
      ) {
        e.preventDefault()
        if (e.key === '0') sceneRef.current?.zoomToFit?.()
        else sceneRef.current?.zoomToDefault?.()
        return
      }
      // Plakkende kies-modus: Escape sluit eerst die modus, niet het niveau.
      if (e.key === 'Escape' && coverPickRef.current && levelRef.current === 'event') {
        e.preventDefault()
        setCoverPickModeRef.current(false)
        return
      }
      // Escape stopt eerst de muziek, maar ALLEEN als dat werkelijk de enige
      // uitweg is: in kijkmodus (het "nu speelt"-balkje is dan weggefade en de
      // spatiebalk werkt buiten L3 niet), óf als deze muziek niet toch al stopt
      // zodra je de memory verlaat. Anders zou elke terugstap in een memory met
      // een liedje twee keer Escape kosten, waarvan de eerste niets extra's doet.
      if (e.key === 'Escape' && nowPlayingRef.current && !dialogOpenRef.current) {
        const stopsOnLeave = autoStartedIdRef.current === nowPlayingRef.current.itemId
        if (settingsRef.current.viewMode || !stopsOnLeave) {
          e.preventDefault()
          stopMusicRef.current()
          return
        }
      }
      if (e.key === 'Escape' || e.key === 'Backspace') {
        // Een open dialog (formulier/bevestiging) vangt Escape zelf af — hier
        // nooit onder de dialog door navigeren (de INPUT-guard hierboven dekt
        // dit niet als de focus op een knop in de dialog staat).
        if (dialogOpenRef.current) return
        e.preventDefault()
        // Detail-niveau in content-beeldvullend: eerst één stap terug naar de
        // normale detail-weergave (niet meteen door naar het canvas).
        if (levelRef.current === 'focus' && contentFillRef.current) {
          toggleContentFillRef.current()
          return
        }
        goBack(true) // toetsenbord-terug → focus-continuïteit op het niveau erboven
      }
    }
    window.addEventListener('keydown', onKeyDown)

    // Eén bron voor de featured-randen op het canvas: de live Ctrl/Shift-toetsen
    // ÓF de plakkende kies-modus. Zonder deze bundeling zou een Ctrl-tik of een
    // Alt-Tab de gouden rand doven terwijl de kies-modus gewoon aan blijft.
    let shiftDown = false
    const syncRings = (): void => {
      if (levelRef.current !== 'event') {
        setRingHint(null)
        return
      }
      const pick = coverPickRef.current
      sceneRef.current?.setRingKeys?.(ctrlDown || pick, shiftDown && !pick)
      // Spiegelt exact wat de scene tekent (zie `refreshRings`): de blauwe
      // jaar-rand vereist Ctrl ÉN Shift, de gouden alleen Ctrl. In de plakkende
      // kies-modus staat de eigen balk er al -- dan geen tweede.
      // `has` wordt hier vastgelegd, niet tijdens de render uit een ref gelezen:
      // een ref-wijziging veroorzaakt geen re-render, dus de tekst "nog geen
      // gekozen" zou anders stil verouderen.
      const kind = pick ? null : ctrlDown && shiftDown ? 'year' : ctrlDown ? 'cover' : null
      setRingHint(
        kind === null
          ? null
          : {
              kind,
              has:
                kind === 'year'
                  ? !!currentYearCoverRef.current
                  : !!currentEventInfoRef.current?.featuredPhoto,
            },
      )
    }
    syncRingsRef.current = syncRings

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
      shiftDown = e.shiftKey
      // Event-canvas: featured-randen (goud = Ctrl, blauw jaar-cover = Ctrl+Shift)
      // tonen zolang de toets(en) ingedrukt zijn.
      syncRings()
    }
    window.addEventListener('keydown', onCtrlKey)
    window.addEventListener('keyup', onCtrlKey)

    // Vensterfocus verliezen (bijv. Alt-Tab met Ctrl ingedrukt) → de keyup mist,
    // waardoor de indicator/tap-modus "aan" zou blijven. Reset op blur. De plakkende
    // kies-modus blijft wél staan: die hangt niet aan een toets.
    const onBlur = (): void => {
      shiftDown = false
      syncRings()
      if (!ctrlDown) return
      ctrlDown = false
      if (levelRef.current === 'year') sceneRef.current?.setDayPicker?.(false)
      syncRings()
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
      // Thema activeren vóór de engine-init (die leest de achtergrondkleur) en de
      // gebundelde fonts eager laden vóór de eerste scene-opbouw (juiste
      // Text-metrics). Een trage/falende font-load mag de start nooit blokkeren:
      // race met een korte timeout; de systeem-fallback rendert dan eerst.
      setActiveTheme(themeById(settingsRef.current.themeId))
      // Eenmalig bij de boot: de DOM-achtergrond op de thema-kleur zetten (zie
      // applyTheme — voorkomt een donkere flits bij lichte thema's).
      applyDomBackground()
      const fontsReady = loadThemeFonts().then(() => {
        fontsDone = true
      })
      // Verloren race (scene gebouwd vóór de fonts, incl. het first-run-pad dat
      // niet op fonts wacht): herteken de actieve scene eenmalig zodra ze er
      // zijn. Via setTimeout(0) zodat de state van de eerste build gesetteld is.
      void fontsReady.then(() => {
        if (disposed || !sceneBuiltBeforeFonts) return
        window.setTimeout(() => {
          if (!disposed && phaseRef.current === 'ready') applyThemeRef.current(settingsRef.current.themeId)
        }, 0)
      })
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

        // Onthoud de lifeline-camera zodra je er rustig op staat (geen entry, geen
        // transitie, geen lopende camera-animatie). Dekt elk exit-pad naar een
        // dieper niveau; bij terugkeer herstelt setupLifeline deze stand.
        if (
          levelRef.current === 'lifeline' &&
          !enteringRef.current &&
          !ctx.engine.isTransitioning &&
          !ctx.engine.isAnimatingCamera
        ) {
          const cam = ctx.engine.camera
          const vp = ctx.engine.viewport()
          lifelineCamRef.current = {
            x: cam.x,
            y: cam.y,
            zoom: cam.zoom,
            yearCount: yearsRef.current.length,
            vpW: vp.width,
            vpH: vp.height,
          }
        }

        // Herfit een paar frames na een viewport-wijziging (fullscreen), zodat het
        // ook klopt als Pixi's resize pas een frame later settelt.
        if (refitFramesRef.current > 0) {
          refitFramesRef.current--
          if (levelRef.current === 'focus') sceneRef.current?.refitToViewport?.()
        }

        // L3 video-overlay: mount de DOM-speler alleen als het gefocuste item een
        // video is én er geen transitie loopt (anders staat 'ie fout t.o.v. de
        // inzoomende poster). Positie elke frame imperatief (geen React-render).
        // ...ook niet tijdens een slide-transitie tussen items (dan schuift de
        // Pixi-poster; de DOM-speler mount pas ná de slide).
        const focusScene =
          levelRef.current === 'focus' && !ctx.engine.isTransitioning && !sceneRef.current?.stepping?.()
            ? sceneRef.current
            : null
        const focusItem = focusScene?.currentItem?.() ?? null
        const vidId = focusItem && focusItem.itemType === 'video' ? focusItem.id : null
        // Transitie-ONGEVOELIG: puur "is het gefocuste item een video". `vidId`
        // hierboven wordt tijdens elke stap even null (de DOM-overlay unmount
        // dan), en daarop de muziek pauzeren gaf een flard bij elke stap.
        const vidFocused =
          levelRef.current === 'focus' &&
          sceneRef.current?.currentItem?.()?.itemType === 'video'
        if (vidFocused !== videoFocusedRef.current) {
          videoFocusedRef.current = vidFocused
          setVideoFocused(vidFocused)
        }
        if (vidId !== focusVideoIdRef.current) {
          focusVideoIdRef.current = vidId
          videoAspectRef.current = null // ander/geen item → verhouding onbekend
          setFocusVideoId(vidId)
        }
        if (vidId) {
          focusScene?.setContentHidden?.(true) // Pixi-poster weg → alleen de DOM-video
          const r = focusScene?.screenRect?.()
          const wrap = videoWrapRef.current
          if (r && wrap) {
            wrap.style.left = `${r.left}px`
            wrap.style.top = `${r.top}px`
            wrap.style.width = `${r.width}px`
            wrap.style.height = `${r.height}px`
            wrap.style.visibility = 'visible'
          }
        }
        // Alleen de jaar-view én de lifeline hebben een elastische scroll-grens
        // (die scenes zetten 'm elke frame); andere niveaus zouden anders een stale
        // grens erven, dus daar wissen we 'm.
        if (levelRef.current !== 'year' && levelRef.current !== 'lifeline') {
          ctx.engine.camera.boundsX = null
        }
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
        // Defensief: alleen een geldige, positieve floor gebruiken. Zou refZoom
        // ooit 0/NaN zijn, dan geen floor (voorkomt een NaN-clamp = wit scherm).
        const floor = refZoom > 0 ? refZoom * backMult : 0
        // "Ver uitzoomen = terug" is instelbaar. Staat het uit, dan gaan we niet
        // terug, maar klemmen we het uitzoomen op de drempel via camera.zoomFloor
        // (dat álle zoom-paden respecteren) zodat je niet ver buiten beeld
        // verdwaalt. Alleen op sub-niveaus en niet tijdens een transitie (dan zou
        // de floor de entry-zoom kunnen hinderen). Op de lifeline (top) is er geen
        // terug, dus geen floor.
        const clampOut =
          !settingsRef.current.backOnZoomOut &&
          floor > 0 &&
          levelRef.current !== 'lifeline' &&
          !enteringRef.current &&
          !ctx.engine.isTransitioning
        ctx.engine.camera.zoomFloor = clampOut ? floor : null
        const backThreshold = ctx.engine.camera.zoom < floor
        if (
          settingsRef.current.backOnZoomOut &&
          backThreshold &&
          !enteringRef.current &&
          !ctx.engine.isTransitioning &&
          // Niet tijdens een programmatische camera-animatie (bijv. beeldvullend
          // in-/uitzoomen op L3): dan staat baseZoom al op het doel terwijl de
          // camera nog onderweg is — dat mag geen "terug" triggeren.
          !ctx.engine.isAnimatingCamera
        ) {
          ctx.engine.endZoom() // stop de soepele zoom → niet doorschieten in de transitie
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
      // Rechtermuisknop = een niveau terug (instelbaar). Zelfde muis-terug als de
      // terugknop; het contextmenu zelf wordt in de gesture-laag onderdrukt. Een
      // open overlay/dialog vangt de klik al af (dekt het canvas), maar we guarden
      // hier ook expliciet — net als de Escape-handler.
      engine.onSecondary = () => {
        if (overlayOpenRef.current || dialogOpenRef.current) return
        if (settingsRef.current.backOnRightClick) mouseBack()
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
        if (levelRef.current === 'event' && (ctrlDown || coverPickRef.current) && scene?.refAt) {
          const ref = scene.refAt(wx, wy)
          // In de plakkende kies-modus gaat Shift NIET stiekem de jaar-cover zetten:
          // je koos expliciet "thumbnail van deze memory".
          const yearPin = coverPickRef.current ? false : mods.shift
          const sticky = coverPickRef.current
          return {
            moveTo: () => {},
            end: () => {
              rangeJustEnded = true
              if (ref) {
                if (yearPin) toggleYearCover(ref)
                else toggleFeatured(ref, sticky)
                if (sticky) setCoverPickModeRef.current(false)
              } else if (sticky) {
                // Mis: zonder terugkoppeling lijkt de app te bevriezen.
                setCoverHint('Klik op een fóto om die als omslag te kiezen.')
                window.clearTimeout(coverHintTimerRef.current)
                coverHintTimerRef.current = window.setTimeout(() => setCoverHint(null), 2600)
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
          // Niet reageren midden in een slide (het item staat dan nog niet op z'n
          // plek → verkeerde hit-test).
          if (scene?.stepping?.()) return
          // step() laat de titel via de onStep-callback meelopen.
          if (hit) scene?.step?.(wx >= 0 ? 1 : -1)
          else if (settingsRef.current.backOnEmptyClick) goBack()
          return
        }

        // L1/L2: klik óp een item = een niveau dieper.
        if (hit) {
          if (level === 'lifeline') void enterYear(hit)
          else if (level === 'year') void enterEvent(hit)
          else if (level === 'event') enterFocus(hit)
          return
        }
        // Lifeline lege ruimte: één klik doet niets (top-niveau), maar een DUBBELklik
        // wisselt tussen "alles passend" en de standaard kaartgrootte.
        if (level === 'lifeline') {
          const now = performance.now()
          const near = Math.hypot(wx - lastL0Tap.x, wy - lastL0Tap.y) * (engine?.camera.zoom ?? 1) < 40
          if (now - lastL0Tap.t < 350 && near) {
            lastL0Tap.t = 0
            sceneRef.current?.zoomToggle?.()
          } else {
            lastL0Tap = { t: now, x: wx, y: wy }
          }
          return
        }
        // Klik naast een item = een niveau uitzoomen. Instelbaar: bij uitgeschakelde
        // "klik lege ruimte = terug" doet dit niets.
        if (settingsRef.current.backOnEmptyClick) goBack()
      }

      try {
        const path = await backendRef.current.getVaultPath()
        if (disposed) return
        setVaultPath(path)
        if (!path) {
          setPhase('first-run')
          return
        }
        await Promise.race([fontsReady, new Promise((r) => setTimeout(r, 1500))])
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
      window.clearTimeout(coverHintTimerRef.current)
      window.clearTimeout(tagFilterTimerRef.current)
      sceneRef.current?.destroy()
      sceneRef.current = null
      engine?.destroy()
      engineRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Houd de gesture-closure op de hoogte of er een blokkerende dialog open staat.
  // De kies-modus hoort uitsluitend bij het memory-canvas. Eén effect op het niveau
  // is waterdicht: élk pad dat je ergens anders brengt (terug, inzoomen naar één foto,
  // een ander jaar, een vault-herbouw) zet `uiLevel`, terwijl losse resets per functie
  // er altijd eentje missen — en een onzichtbaar actieve modus slikt daarna je Escape.
  useEffect(() => {
    if (uiLevel === 'event') return
    // Weg van het canvas = het kiezen is afgebroken. Het opzij gezette formulier hoort
    // dan NIET terug te komen: het gaat over een memory waar je niet meer in zit, en
    // een volgende klik zou de omslag van de verkeerde memory zetten.
    pendingEditFormRef.current = null
    setCoverPickMode(false)
  }, [uiLevel, setCoverPickMode])

  useEffect(() => {
    dialogOpenRef.current = !!(modal || editing || eventForm || metaForm || songForm || addSong || confirmBox)
    // Een open dialoog dekt het canvas af → de kies-modus zou onbereikbaar aan blijven
    // (en de balk zou over de dialoog liegen dat Esc 'm sluit).
    if (dialogOpenRef.current) setCoverPickMode(false)
  }, [modal, editing, eventForm, metaForm, songForm, addSong, confirmBox])

  // Haal de asset-URL van de gefocuste video op (pad → convertFileSrc). Async,
  // dus buiten de render; leeg bij geen video of tijdens het laden.
  useEffect(() => {
    if (!focusVideoId || !backendRef.current) {
      setVideoSrc('')
      return
    }
    let alive = true
    void backendRef.current.mediaUrl(focusVideoId).then((u) => {
      if (alive) setVideoSrc(u)
    })
    return () => {
      alive = false
    }
  }, [focusVideoId])

  // Houd de key-closure op de hoogte of een invoerloze overlay open staat. De
  // screensaver hoort hier ook bij: dan slaan de globale Esc/'e'-handlers zichzelf
  // over en navigeert er niets onder de screensaver.
  useEffect(() => {
    overlayOpenRef.current =
      settingsOpen || searchOpen || screensaverIds !== null || matReport !== null || themePanel !== null || weergaveOpen
  }, [settingsOpen, searchOpen, screensaverIds, matReport, themePanel, weergaveOpen])

  // Escape sluit de weergave-balk (los van de dialoog-Escape). Capture +
  // stopPropagation zodat de globale navigatie niet óók uitzoomt op dezelfde toets.
  useEffect(() => {
    if (!weergaveOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setWeergaveOpen(false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [weergaveOpen])

  // Klik buiten de weergave-balk (en niet op de schuifjes-knop zelf) sluit 'm.
  // Een document-listener i.p.v. een vaste backdrop-div, want de gecentreerde
  // dock gebruikt een CSS-transform — daaronder valt `position:fixed` terug op
  // de getransformeerde voorouder i.p.v. het volledige scherm.
  useEffect(() => {
    if (!weergaveOpen) return
    const onDown = (e: PointerEvent): void => {
      const t = e.target as HTMLElement | null
      if (t && (t.closest('[data-layoutbar]') || t.closest('#weergave-toggle-btn'))) return
      setWeergaveOpen(false)
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [weergaveOpen])

  // De weergave-balk hoort alleen bij het event-niveau; verlaat je dat, sluit 'm
  // (anders blijft overlayOpenRef ten onrechte "open" en blokkeert navigatie).
  useEffect(() => {
    if (uiLevel !== 'event') setWeergaveOpen(false)
  }, [uiLevel])

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
    // Nieuwe/gewijzigde vault → de onthouden L0-stand slaat nergens meer op.
    lifelineCamRef.current = null
    // En muziek uit de vórige vault mag hier niet doorklinken: die src wijst naar
    // een bestand dat bij een ander archief hoort.
    stopMusicRef.current()
    // En een tagfilter uit de vórige vault ook niet: dat zou het eerste jaar dat je
    // opent stil leeg maken.
    tagFilterRef.current = []
    setTagFilter([])
    if (years.length > 0) {
      sceneRef.current?.destroy()
      // Terug naar L0: achtergrond + titel-uiMode terug naar het app-thema
      // (je kunt hier vanaf een donker gethemad jaar/event komen).
      setCanvasBackgroundRef.current(THEME, false)
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

  // Toon het materialisatie-overzicht alleen als er echt iets gebeurde: bestanden
  // aangemaakt of problemen. Losse foto's zijn puur informatief (staan wél in het
  // overzicht als 't verschijnt), maar triggeren 'm niet — anders komt-ie elke
  // reindex terug op een archief met permanente losse foto's.
  const maybeShowReport = (m: MaterializationReport | undefined): void => {
    if (!m) return
    if (m.yearsCreated + m.eventsCreated > 0 || m.errors.length > 0) {
      setMatReport(m)
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
      maybeShowReport(summary.materialization)
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
      const summary = await backend.reindex()
      await rebuildLifeline()
      maybeShowReport(summary.materialization)
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
    // Live setters die geen scene-herbouw doen, moeten hier expliciet mee.
    sceneRef.current?.setBorderPx?.(
      levelRef.current === 'year'
        ? yearBorderPx(DEFAULT_SETTINGS.borderThickness)
        : DEFAULT_SETTINGS.borderThickness,
    )
    sceneRef.current?.setEditable?.(!DEFAULT_SETTINGS.viewMode)
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

  // Nieuw jaar (vanaf de lifeline): maak een eerste memory op een datum aan → het
  // jaar uit die datum wordt aangemaakt (atDate), ongeacht welk jaar laatst bezocht is.
  const openNewYear = (): void => {
    setEventForm({ mode: 'create', title: '', startAt: todayISO(), endAt: '', size: 50, atDate: true })
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
    // Onthoud de view per event (grid onthoudt ook de sortering + seed).
    const id = currentEventRef.current
    const state = scene?.layoutState?.()
    if (id && state) saveEventView(id, viewFromState(state))
  }

  // Grid-sorteervolgorde wisselen (alleen zichtbaar in grid-modus). 'random' schudt
  // elke klik opnieuw. Onthoud de resulterende opstelling per event.
  const changeGridSort = (sort: 'date' | 'name' | 'random'): void => {
    setGridSortMode(sort)
    const scene = sceneRef.current
    scene?.setGridSort?.(sort)
    const id = currentEventRef.current
    const state = scene?.layoutState?.()
    if (id && state) saveEventView(id, viewFromState(state))
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
      if (id && state) saveEventView(id, viewFromState(state))
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
      underConstruction: info.underConstruction ?? false,
      // `featuredPhoto` is een SLUG of een id; `backend.thumb()` wil een id. Resolven
      // via de items van dit event. Geen expliciete keuze → undefined, en dan toont
      // de dialoog bewust de grijze "kies er een"-box (de tijdlijn kiest zelf wel
      // een willekeurige foto, maar dat is geen keuze die jij gemaakt hebt).
      tags: (info.tags ?? []).join(', '),
      synthetic: info.synthetic ?? false,
      coverItemId: info.featuredPhoto
        ? currentItemsRef.current.find(
            (it) => it.slug === info.featuredPhoto || it.id === info.featuredPhoto,
          )?.id
        : undefined,
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
        // `atDate` (nieuw-jaar-flow) of een lege vault → het jaar uit de datum
        // aanmaken; anders het event in het huidige jaar.
        if (yearId && !f.atDate) {
          await backend.createEvent(yearId, f.title.trim(), f.startAt, end, f.size ?? null)
          enterYearRef.current(yearId) // ververs de jaar-tijdlijn
        } else {
          // Maak het jaar + de memory aan op datum, herbouw de lifeline en duik
          // het (mogelijk nieuwe) jaar in.
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
        // Trefwoorden: alleen schrijven bij een echte wijziging (elke schrijfactie
        // kost een rescan). Synthetische bundels hebben geen `_event.md` → overslaan.
        if (!f.synthetic) {
          const nextTags = parseTags(f.tags ?? '')
          const origTags = currentEventInfoRef.current?.tags ?? []
          const same =
            nextTags.length === origTags.length && nextTags.every((t, i) => t === origTags[i])
          if (!same) await backend.setEventTags(f.eventId, nextTags)
        }
        // "In aanbouw"-vlag: apart non-destructief veld; alleen bij een echte wijziging.
        const origUC = currentEventInfoRef.current?.underConstruction ?? false
        if ((f.underConstruction ?? false) !== origUC) {
          await backend.setEventUnderConstruction(f.eventId, f.underConstruction ?? false)
        }
        // Een datum-edit kan het event naar een ander jaar verplaatsen. Houd
        // `currentYearRef` in de pas met de nieuwe startdatum, anders landt
        // uitzoomen (goBack) op het oude — nu lege — jaar.
        //
        // Maar NIET als het jaar waar je vandaan kwam nog steeds bij deze memory
        // hoort: een memory die de jaargrens kruist staat in twee jaren, en dan zou
        // een titel-wijziging je bij het uitzoomen stil naar het ándere jaar sturen.
        const startYear = Number(f.startAt.slice(0, 4))
        const endYear = Number((end ?? f.startAt).slice(0, 4))
        const cur = yearsRef.current.find((y) => y.id === currentYearRef.current)
        const stillHere = cur != null && cur.year >= startYear && cur.year <= endYear
        if (!stillHere) {
          // Het doeljaar kan zojuist zijn aangemaakt door de verhuizing → verse lijst.
          yearsRef.current = await backend.listYears()
          const matched = yearsRef.current.find((y) => y.year === startYear)
          if (matched) currentYearRef.current = matched.id
        }
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

  const performDelete = async (id: string): Promise<void> => {
    const backend = backendRef.current
    const eventId = currentEventRef.current
    if (!backend || mutatingRef.current) return
    mutatingRef.current = true
    setBusy(true)
    try {
      await backend.deleteItem(id)
      // Speelde dit liedje? Dan blijft het anders doorklinken vanuit de
      // prullenbak, met een balkje dat een item toont dat niet meer bestaat.
      if (nowPlayingRef.current?.itemId === id) stopMusic()
      if (eventId) enterEventRef.current(eventId)
    } catch (e) {
      setMessage(String(e))
      setPhase('error')
    } finally {
      mutatingRef.current = false
      setBusy(false)
    }
  }

  // Vraagt bevestiging via de gestylede dialoog (geen native window.confirm).
  const deleteCurrent = (): void => {
    const id = sceneRef.current?.currentId?.()
    if (!id || mutatingRef.current) return
    setConfirmBox({
      message: 'Dit item naar de prullenbak verplaatsen?',
      confirmLabel: 'Verplaatsen',
      onConfirm: () => void performDelete(id),
    })
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
        // Ook de bronknop: die luistert alleen naar stappen en naar het openen van
        // L3. Zonder dit blijft hij na het bewerken van de link de OUDE link
        // openen -- of verdwijnt hij niet als je het veld leegmaakt.
        setFocusSourceUrl(sourceUrlOf(item))
        setFocusPlayableId(playableIdOf(item))
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
    // Liedje → eigen formulier. De kader-keuze (polaroid/strak) is voor een
    // liedje betekenisloos -- de kaart negeert 'm sowieso -- en titel en artiest
    // horen niet in een paneel dat "Foto-gegevens" heet.
    if (item.itemType === 'song') {
      setSongForm({
        id,
        title: item.caption ?? '',
        artist: item.artist ?? '',
        url: item.url ?? '',
      })
      return
    }
    // Foto → metadata-paneel (laad de huidige sidecar-waarden).
    const backend = backendRef.current
    if (!backend) return
    void backend
      .getItemMetadata(id)
      .then((m) => {
        // Kader-stijl komt uit het item zelf (niet uit de sidecar-metadata);
        // '' = geërfd van het thema.
        const frame = currentItemsRef.current.find((it) => it.id === id)?.frame ?? ''
        setMetaForm({
          id,
          isSound: item.itemType === 'audio',
          caption: m.caption,
          date: m.date,
          place: m.place,
          people: m.people.join(', '),
          tags: m.tags.join(', '),
          exif: m.exif,
          frame,
          frame0: frame,
        })
      })
      .catch((e) => {
        setMessage(String(e))
        setPhase('error')
      })
  }

  /** Kiest een audiobestand en leest meteen de tags. Geen netwerk. */
  const pickSongFile = async (): Promise<void> => {
    const backend = backendRef.current
    if (!backend) return
    const path = await backend.pickAudioFile().catch(() => null)
    if (!path) return
    setAddSong((f) => (f ? { ...f, audio: path, busy: true } : f))
    const found = await backend.lookupSongMeta(path, true).catch(() => null)
    setAddSong((f) =>
      f
        ? {
            ...f,
            busy: false,
            looked: true,
            // Alleen invullen wat nog leeg is: wat je zelf typte wint van een tag.
            title: f.title || found?.title || '',
            artist: f.artist || found?.artist || '',
            isrc: found?.isrc ?? f.isrc,
            durationSecs: found?.durationSecs ?? f.durationSecs,
          }
        : f,
    )
  }

  /** Zoekt de gegevens op bij de geplakte link. Alleen als de instelling aan staat. */
  const lookupSong = async (): Promise<void> => {
    const backend = backendRef.current
    const f = addSong
    if (!backend || !f) return
    const url = normalizeLink(f.input)
    if (!url.startsWith('https://')) return
    setAddSong((x) => (x ? { ...x, busy: true } : x))
    const found = settingsRef.current.musicLookup
      ? await backend.lookupSongMeta(url, false).catch(() => null)
      : null
    setAddSong((x) =>
      x
        ? {
            ...x,
            busy: false,
            looked: true,
            title: x.title || found?.title || '',
            artist: x.artist || found?.artist || '',
          }
        : x,
    )
  }

  const submitAddSong = async (): Promise<void> => {
    const backend = backendRef.current
    const f = addSong
    const eventId = currentEventRef.current
    if (!backend || !f || !eventId || mutatingRef.current) return
    // Het ene veld is óf een link óf een titel; wat je typte telt als titel als
    // het geen link is. Zo hoef je niet te weten welk soort invoer we verwachten.
    //
    // Uitsluitend uit `input` afgeleid, nooit uit een onthouden lookup-resultaat:
    // anders blijft een opgezochte link achter nadat je 'm hebt weggehaald of
    // vervangen, en sla je een liedje op met de link van een ánder nummer.
    const url = normalizeLink(f.input)
    const typed = url.startsWith('https://') ? '' : f.input.trim()
    const title = f.title.trim() || typed
    if (!title && !url && !f.audio) return
    mutatingRef.current = true
    setBusy(true)
    try {
      await backend.addSong(
        eventId,
        {
          audio: f.audio,
          title: title || null,
          artist: f.artist.trim() || null,
          url: url.startsWith('https://') ? url : null,
          isrc: f.isrc,
          durationSecs: f.durationSecs,
        },
        settingsRef.current.musicLookup,
      )
      setAddSong(null)
      // Zelfde verversing als bij foto's importeren: de scene opnieuw opbouwen
      // zodat het nieuwe liedje meteen op het canvas staat.
      enterEventRef.current(eventId)
    } catch (e) {
      setMessage(String(e))
      setPhase('error')
    } finally {
      mutatingRef.current = false
      setBusy(false)
    }
  }

  const submitSong = async (): Promise<void> => {
    const backend = backendRef.current
    const f = songForm
    if (!backend || !f || mutatingRef.current) return
    mutatingRef.current = true
    setBusy(true)
    try {
      await backend.setSongMeta(f.id, f.title, f.artist, normalizeLink(f.url))
      await refreshFocus()
      setSongForm(null)
    } catch (e) {
      setMessage(String(e))
      setPhase('error')
    } finally {
      mutatingRef.current = false
      setBusy(false)
    }
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
      // Kader alleen schrijven bij een echte wijziging (scheelt een rescan).
      if (f.frame !== f.frame0) await backend.setItemFrame(f.id, f.frame || null)
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

  // Terugknop linksboven: altijd zichtbaar op sub-niveaus (niet aan chromeVisible
  // gekoppeld, net als het tandwiel), maar weg in view-modus (schone weergave) en
  // in immersieve modi. Rechtsklik/Escape blijven daar de muis/toets-terug.
  // Actief UI-palet voor de DOM-chrome (volgt THEME.uiMode; her-render bij een
  // themawissel gebeurt via de settings-state).
  const u = ui()

  // Eén afleiding voor "staat er een blokkerende dialog open?" — gebruikt in
  // alle render-guards én (via dialogOpenRef) in de key-/gesture-closures, zodat
  // een nieuwe dialog-soort nooit op één plek vergeten kan worden.
  const anyDialog = !!(modal || editing || eventForm || metaForm || songForm || addSong || confirmBox)

  const backVisible =
    phase === 'ready' &&
    uiLevel !== 'lifeline' &&
    !anyDialog &&
    !searchOpen &&
    !settingsOpen &&
    !screensaverIds &&
    !settings.viewMode

  return (
    // LazyMotion + lichte `m`-componenten: laadt alleen de benodigde animatie-
    // features (domAnimation: fade/scale/slide + AnimatePresence-exit) in plaats van
    // de volledige `motion`-bundel. ~40 KB kleiner, exact hetzelfde gedrag — er wordt
    // nergens een `layout`/drag-animatie gebruikt (die zouden domMax vereisen).
    <LazyMotion features={domAnimation}>
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
        <TitleBar text={header.text} dir={header.dir} mode={sceneUiMode} />
      )}
      {backVisible && <BackButton onClick={() => goBackRef.current()} />}
      {phase === 'ready' && !anyDialog && !searchOpen && !settingsOpen && !settings.viewMode && chromeVisible && settings.showSearchButton && (
        <button
          onClick={() => setSearchOpen(true)}
          style={{ ...searchBtn(u), left: backVisible ? 64 : 16 }}
          title="Zoeken (Ctrl+K)"
        >
          Zoeken…
        </button>
      )}
      {phase === 'ready' && !anyDialog && !searchOpen && !settingsOpen && !settings.viewMode && (
        <button onClick={() => setSettingsOpen(true)} style={gearBtn(u)} title="Instellingen">
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
          backend={backendRef.current}
          onImported={() => void rebuildLifeline()}
        />
      )}
      <AnimatePresence>
        {themePanel && (
          <ThemePanel
            key="themepanel"
            scope={themePanel}
            title={themePanel === 'year' ? header.text : currentEventInfoRef.current?.title || 'memory'}
          inheritedName={
            themePanel === 'event' &&
            currentThemeChoicesRef.current.year?.id &&
            THEMES.some((t) => t.id === currentThemeChoicesRef.current.year?.id)
              ? `${themeById(currentThemeChoicesRef.current.year.id).name} (jaar)`
              : `${themeById(settings.themeId).name} (app)`
          }
          inheritedTheme={
            themePanel === 'event' &&
            currentThemeChoicesRef.current.year?.id &&
            THEMES.some((t) => t.id === currentThemeChoicesRef.current.year?.id)
              ? themeById(currentThemeChoicesRef.current.year.id)
              : themeById(settings.themeId)
          }
            value={themePanelValue}
            onChange={changeScopeTheme}
            onClose={() => setThemePanel(null)}
          />
        )}
      </AnimatePresence>
      {screensaverIds && (
        <Screensaver
          photoIds={screensaverIds}
          thumb={(id, size) => backendRef.current!.thumb(id, size)}
          speedMs={settings.diaSpeed * 1000}
          mode={settings.diaMode}
          onClose={() => setScreensaverIds(null)}
        />
      )}
      {/* Een video en muziek mogen elkaar niet overstemmen: zodra er een video
          gefocust is pauzeert de muziek, en na afloop hervat hij. */}
      {focusVideoId && backendRef.current && (
        <FocusVideoLayer
          ref={videoWrapRef}
          src={videoSrc}
          poster={backendRef.current.thumb(focusVideoId, 1024).url ?? ''}
          onFullscreen={doToggleFullscreen}
          onAspect={(a) => {
            videoAspectRef.current = a
            sceneRef.current?.setVideoAspect?.(a)
          }}
        />
      )}
      <MusicLayer
        now={nowPlaying}
        volume={settings.musicVolume}
        paused={musicPaused}
        hidden={settings.viewMode || anyDialog}
        onEnded={stopMusic}
        onTogglePause={() => setMusicPaused((p) => !p)}
        onStop={stopMusic}
      />
      {showFps && <FpsOverlay engineRef={engineRef} />}
      {showFit &&
        phase === 'ready' &&
        !anyDialog &&
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
            style={fitBtn(u)}
            title="Alles passend in beeld"
          >
            ⤢ Alles passend
          </button>
        )}
      {phase === 'ready' &&
        uiLevel === 'lifeline' &&
        !anyDialog &&
        !searchOpen &&
        !settingsOpen &&
        !screensaverIds &&
        !settings.viewMode && (
          <button
            onClick={() => sceneRef.current?.zoomToggle?.()}
            style={fitBtn(u)}
            title="Wissel tussen alles passend en standaard kaartgrootte (of dubbelklik op het overzicht · Ctrl+0/Ctrl+1)"
          >
            ⤢ Zoom
          </button>
        )}
      {toast && <div style={toastStyle(u)}>{toast}</div>}
      {/* Tagfilter op de jaar-tijdlijn. Alleen zichtbaar als dit jaar tags heeft; de
          chips komen uit de ONGEFILTERDE lijst, zodat je altijd kunt wisselen en niet
          alleen kunt wissen. Actief filter blijft in beeld — je mag nooit met een
          onzichtbaar filter blijven zitten. */}
      {phase === 'ready' && uiLevel === 'year' && !anyDialog && !settingsOpen && !searchOpen &&
        !screensaverIds && (yearTagsRef.current.length > 0 || tagFilter.length > 0) && (
        <div style={tagBarStyle(u)}>
          {/* Unie van "tags in dit jaar" en "actief filter": een actieve tag die in dit
              jaar niet voorkomt moet zichtbaar blijven, anders sta je in een leeg jaar
              zonder knop om het filter te wissen. */}
          {[...new Set([...yearTagsRef.current, ...tagFilter])].sort().map((t) => {
            const on = tagFilter.includes(t)
            return (
              <button
                key={t}
                type="button"
                onClick={() =>
                  applyTagFilter(on ? tagFilter.filter((x) => x !== t) : [...tagFilter, t])
                }
                title={on ? `${t} niet meer tonen` : `Alleen ${t} tonen`}
                style={{
                  padding: '5px 12px',
                  borderRadius: 999,
                  fontSize: 12,
                  cursor: 'pointer',
                  border: `1px solid ${on ? u.primary : u.border}`,
                  background: on ? u.primary : u.cardAlt,
                  color: on ? u.primaryText : u.textMuted,
                }}
              >
                {t}
              </button>
            )
          })}
          {tagFilter.length > 0 && (
            <button
              type="button"
              onClick={() => applyTagFilter([])}
              title="Alle memories weer tonen"
              style={{
                padding: '5px 12px',
                borderRadius: 999,
                fontSize: 12,
                cursor: 'pointer',
                border: `1px solid ${u.border}`,
                background: 'transparent',
                color: u.text,
              }}
            >
              ✕ wis filter
            </button>
          )}
        </div>
      )}
      {/* Kies-modus: duidelijk in beeld dát je in die modus zit. Zonder deze balk was
          de enige aanwijzing een gouden rand die je pas ziet als je al hovert. */}
      {/* AnimatePresence zodat de balk ook nét zo zacht wéggaat als hij komt --
          zonder dat knipt hij weg zodra je Ctrl loslaat. */}
      <AnimatePresence>
      {coverPick && uiLevel === 'event' && !screensaverIds && (
        <HintBar key="pickbar" tone="cover" icon={<IconCover size={18} />}>
          <span>
            <b>Kies de omslagfoto</b> — klik een foto in deze memory
          </span>
          <span style={{ opacity: 0.65 }}>Esc om te stoppen</span>
          {coverHint && <span style={{ color: '#ffd479' }}>{coverHint}</span>}
        </HintBar>
      )}
      {/* Ctrl vasthouden = "welke foto vertegenwoordigt dit?" Zonder uitleg is de
          enige aanwijzing een rand om een foto die misschien buiten beeld staat. */}
      {ringHint && !coverPick && uiLevel === 'event' && !screensaverIds && !anyDialog && (
        <HintBar
          key={`ringhint-${ringHint.kind}`}
          tone={ringHint.kind}
          icon={<IconCover size={18} />}
        >
          {ringHint.kind === 'year' ? (
            <span>
              <b>Omslagfoto van dit jaar</b> — klik een foto om 'm de hele jaartegel te laten
              vertegenwoordigen
            </span>
          ) : (
            <span>
              <b>Omslagfoto van deze memory</b> — klik een foto om 'm als thumbnail te kiezen
            </span>
          )}
          <span style={{ opacity: 0.6 }}>
            {ringHint.has
              ? ringHint.kind === 'year'
                ? 'de huidige is blauw omrand'
                : 'de huidige is goud omrand'
              : 'nog geen gekozen'}
          </span>
        </HintBar>
      )}
      </AnimatePresence>
      {matReport && <MaterializationOverlay report={matReport} onClose={() => setMatReport(null)} />}
      {phase === 'ready' && !anyDialog && !searchOpen && !settingsOpen && !settings.viewMode && (
        <Fab
          uiLevel={uiLevel}
          layoutMode={layoutMode}
          onAddEvent={openNewEvent}
          onAddYear={openNewYear}
          onAddNote={() => setModal('note')}
          onAddSong={() => setAddSong({ input: '', title: '', artist: '', audio: null, isrc: null, durationSecs: null, busy: false, looked: false })}
          onAddPhotos={() => void addPhotos()}
          onEditEvent={openEditEvent}
          onYearTheme={() => openThemePanel('year')}
          onEventTheme={() => openThemePanel('event')}
          onLayout={changeLayout}
          onSaveLayout={saveLayoutAsCustom}
          onEdit={startEdit}
          onPlaySong={
            focusPlayableId
              ? () => {
                  if (nowPlaying?.itemId === focusPlayableId) setMusicPaused((p) => !p)
                  else void playSong(currentItemsRef.current.find((i) => i.id === focusPlayableId))
                }
              : undefined
          }
          playing={!!focusPlayableId && nowPlaying?.itemId === focusPlayableId && !musicPaused}
          onOpenSource={focusSourceUrl ? () => {
            void backendRef.current?.openExternal(focusSourceUrl).catch((e) => setToast(String(e)))
          } : undefined}
          onDelete={() => void deleteCurrent()}
          scatterRotate={settings.scatterRotate}
          onToggleScatterRotate={toggleScatterRotate}
          gridSort={gridSort}
          onGridSort={changeGridSort}
          squarePhotos={settings.squarePhotos}
          onToggleSquarePhotos={() => updateSettings({ squarePhotos: !settingsRef.current.squarePhotos })}
          weergaveOpen={weergaveOpen}
          onToggleWeergave={() => setWeergaveOpen((v) => !v)}
          coverPick={coverPick}
          onToggleCoverPick={() => setCoverPickMode(!coverPickRef.current)}
        />
      )}
      <AnimatePresence>
        {modal && (
          <Composer
            key="composer"
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
      </AnimatePresence>
      <AnimatePresence>
        {editing && (
          <EditPanel
            key="editpanel"
            kind={editing.kind}
            value={editing.value}
            busy={busy}
            onChange={(v) => setEditing({ ...editing, value: v })}
            onSubmit={() => void submitEdit()}
            onCancel={() => setEditing(null)}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {eventForm && (
          <EventDialog
            key="eventdialog"
            form={eventForm}
            busy={busy}
            onChange={(patch) => setEventForm({ ...eventForm, ...patch })}
            onSubmit={() => void submitEventForm()}
            onCancel={() => setEventForm(null)}
            thumbUrl={
              eventForm.coverItemId
                ? backendRef.current?.thumb(eventForm.coverItemId, 256).url
                : undefined
            }
            tagSuggestions={yearTagsRef.current}
            onPickCover={() => {
              // Kiezen gebeurt op het canvas zelf (daar zie je de foto's groot). Het
              // formulier gaat opzij en komt na het kiezen terug — inclusief wat je
              // al had ingevuld en de zojuist gekozen omslag.
              pendingEditFormRef.current = eventForm
              setEventForm(null)
              setCoverPickMode(true)
            }}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {addSong && (
          <AddSongPanel
            key="addsongpanel"
            form={addSong}
            lookupAllowed={settings.musicLookup}
            onChange={(patch) => setAddSong((f) => (f ? { ...f, ...patch } : f))}
            onPickFile={() => void pickSongFile()}
            onLookup={() => void lookupSong()}
            onSubmit={() => void submitAddSong()}
            onCancel={() => setAddSong(null)}
          />
        )}
        {songForm && (
          <SongPanel
            key="songpanel"
            form={songForm}
            busy={busy}
            onChange={(patch) => setSongForm({ ...songForm, ...patch })}
            onSubmit={() => void submitSong()}
            onCancel={() => setSongForm(null)}
            onOpenLink={() => {
              const url = normalizeLink(songForm.url)
              // `setToast`, niet `setMessage`: die laatste rendert alleen in de
              // fout-overlay, dus elke mislukking zou hier volledig stil zijn.
              if (url) void backendRef.current?.openExternal(url).catch((e) => setToast(String(e)))
            }}
          />
        )}
        {metaForm && (
          <MetaPanel
            key="metapanel"
            form={metaForm}
            busy={busy}
            onChange={(patch) => setMetaForm({ ...metaForm, ...patch })}
            onSubmit={() => void submitMeta()}
            onCancel={() => setMetaForm(null)}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {confirmBox && (
          <ConfirmDialog
            key="confirmdialog"
            message={confirmBox.message}
            confirmLabel={confirmBox.confirmLabel}
            onConfirm={() => {
              const run = confirmBox.onConfirm
              setConfirmBox(null)
              run()
            }}
            onCancel={() => setConfirmBox(null)}
          />
        )}
      </AnimatePresence>
    </div>
    </LazyMotion>
  )
}

/** Gedeelde modal-schil met in-/uitfade-animatie (motion). De achtergrond fa't
 * in; het paneel schaalt + glijdt zacht omhoog. Klik op de achtergrond sluit
 * (via `onBackdrop`); klikken binnen het paneel niet. Wordt op de aanroep-plek
 * in een <AnimatePresence> gezet zodat ook de uit-animatie speelt. */
function AnimatedModal({
  onBackdrop,
  panelStyle,
  backdrop,
  zIndex,
  children,
}: {
  onBackdrop?: () => void
  panelStyle: React.CSSProperties
  backdrop?: string
  zIndex?: number
  children: React.ReactNode
}) {
  const u = ui()
  return (
    <m.div
      onClick={onBackdrop}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.16, ease: 'easeOut' }}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex,
        background: backdrop ?? u.backdrop,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <m.div
        onClick={(e) => e.stopPropagation()}
        initial={{ opacity: 0, scale: 0.965, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.975, y: 6 }}
        transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}
        style={panelStyle}
      >
        {children}
      </m.div>
    </m.div>
  )
}

/** Maakt een geplakte link klaar voor opslaan én voor de opener.
 *
 * Twee dingen die anders stil misgaan:
 * - De opener-scope in `capabilities/default.json` matcht met glob, en glob is
 *   HOOFDLETTERGEVOELIG. `HTTPS://…` haalt dan wel onze eigen check maar wordt
 *   door de scope geweigerd -- een knop die aan staat en niets doet.
 * - `http://`-links (oude bookmarks, gedeelde berichten) zouden de knop permanent
 *   uit laten staan met "plak eerst een https-link", terwijl je wél plakte.
 * Geeft een lege string als er niets bruikbaars overblijft. */
function normalizeLink(raw: string): string {
  const url = raw.trim()
  if (!url) return ''
  // Controltekens midden in de URL: `open` spawnt zonder foutmelding, dus die
  // zouden een stille no-op opleveren.
  if (/[\u0000-\u0020]/.test(url)) return ''
  // Een scheme-loze plak-vorm (`www.youtube.com/...`) is heel gewoon -- Chrome
  // kopieert vaak zo. Zonder aanvullen zou die als TITEL van het liedje worden
  // opgeslagen en de link definitief verdwijnen.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    return /^www\./i.test(url) ? `https://${url}` : ''
  }
  return url.replace(/^https?:\/\//i, 'https://')
}

/** Toevoeg-dialoog voor muziek. Eén veld waar je een link plakt, een bestand
 * kiest of gewoon een titel typt; wat je gaf bepaalt wat er gebeurt. */
interface AddSongForm {
  /** Wat er in het ene veld staat: een link of een getypte titel. */
  input: string
  title: string
  artist: string
  /** Pad naar een gekozen audiobestand, of null. */
  audio: string | null
  isrc: string | null
  durationSecs: number | null
  busy: boolean
  /** Is er al een keer opgezocht? Stuurt de tekst onder het veld. */
  looked: boolean
}

interface SongForm {
  id: string
  title: string
  artist: string
  url: string
}

/** Muziek toevoegen. Eén invoerveld dat zelf uitzoekt wat je gaf: een link, een
 * gekozen bestand, of gewoon een getypte titel. Alle voorgevulde velden blijven
 * bewerkbaar -- een mislukte of uitgeschakelde opzoekpoging is nooit blokkerend,
 * want de titel en artiest zijn wat er over 20 jaar nog toe doet. */
function AddSongPanel({
  form,
  lookupAllowed,
  onChange,
  onPickFile,
  onLookup,
  onSubmit,
  onCancel,
}: {
  form: AddSongForm
  lookupAllowed: boolean
  onChange: (patch: Partial<AddSongForm>) => void
  onPickFile: () => void
  onLookup: () => void
  onSubmit: () => void
  onCancel: () => void
}) {
  const u = ui()
  useEscape(onCancel)
  const looksLikeLink = /^\s*(https?:\/\/|www\.)/i.test(form.input)
  // Debounce op de WAARDE, geen `onBlur`. Met onBlur verplaatste een muisklik op
  // "Toevoegen" eerst de focus, wat de lookup startte en `busy` synchroon op true
  // zette -- de knop was daardoor `disabled` vóórdat de klik zelf landde, dus de
  // eerste klik werd ingeslikt. Precies het hoofdpad van deze dialoog.
  const lookupRef = useRef(onLookup)
  lookupRef.current = onLookup
  useEffect(() => {
    if (!looksLikeLink || !lookupAllowed) return
    const t = window.setTimeout(() => lookupRef.current(), 700)
    return () => window.clearTimeout(t)
  }, [form.input, looksLikeLink, lookupAllowed])
  const fileName = form.audio ? form.audio.split(/[\\/]/).pop() : null
  const canSave = !!(form.title.trim() || form.input.trim() || form.audio)
  return (
    <AnimatedModal
      onBackdrop={onCancel}
      panelStyle={{ width: 480, maxWidth: '92%', background: u.card, color: u.text, borderRadius: 12, padding: 20 }}
    >
      <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>Muziek toevoegen</div>
      <div style={{ fontSize: 13, opacity: 0.65, marginBottom: 14, lineHeight: 1.45 }}>
        Plak een link, kies een audiobestand, of typ gewoon welk nummer het was.
      </div>

      <label style={metaLabel(u)}>
        Link of titel
        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          <input
            autoFocus
            value={form.input}
            onChange={(e) => onChange({ input: e.target.value })}
            placeholder="https://open.spotify.com/track/…  of  Blinding Lights"
            style={{ ...field(u), flex: 1 }}
          />
          {looksLikeLink && lookupAllowed && (
            <button type="button" onClick={onLookup} disabled={form.busy} style={ghostBtn(u)}>
              {form.busy ? 'Bezig…' : 'Opzoeken'}
            </button>
          )}
        </div>
      </label>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
        <button type="button" onClick={onPickFile} disabled={form.busy} style={ghostBtn(u)}>
          Audiobestand kiezen…
        </button>
        <div style={{ fontSize: 12, opacity: 0.7, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {fileName ?? 'Geen bestand — het liedje is dan alleen te openen bij de bron'}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 12, marginTop: 14 }}>
        <label style={{ ...metaLabel(u), flex: 1 }}>
          Titel
          <input
            value={form.title}
            onChange={(e) => onChange({ title: e.target.value })}
            placeholder={looksLikeLink ? 'Wordt opgezocht' : 'Uit het veld hierboven'}
            style={{ ...field(u), marginTop: 4 }}
          />
        </label>
        <label style={{ ...metaLabel(u), flex: 1 }}>
          Artiest
          <input
            value={form.artist}
            onChange={(e) => onChange({ artist: e.target.value })}
            placeholder="The Weeknd"
            style={{ ...field(u), marginTop: 4 }}
          />
        </label>
      </div>

      <div style={{ fontSize: 12, opacity: 0.6, marginTop: 12, lineHeight: 1.45 }}>
        {!lookupAllowed
          ? 'Online opzoeken staat uit in de instellingen — vul titel en artiest zelf in.'
          : form.looked
            ? 'Alles nog aan te passen. Titel en artiest blijven bewaard, ook als de dienst waar de link naartoe wijst ooit verdwijnt.'
            : 'Bij een link halen we eenmalig de titel, artiest en albumhoes op.'}
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
        <button type="button" onClick={onCancel} style={ghostBtn(u)}>
          Annuleren
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={form.busy || !canSave}
          style={{ ...primaryBtn(u), opacity: form.busy || !canSave ? 0.5 : 1 }}
        >
          Toevoegen
        </button>
      </div>
    </AnimatedModal>
  )
}

/** Bewerkscherm voor een liedje: titel, artiest en de streaming-link.
 *
 * Bewust géén kader-keuze (die negeert de kaart toch) en géén plaats/mensen: dit
 * gaat over wát het liedje is, niet over waar de foto genomen is. De link is
 * meteen te openen, zodat je kunt controleren of je de juiste geplakt hebt. */
function SongPanel({
  form,
  busy,
  onChange,
  onSubmit,
  onCancel,
  onOpenLink,
}: {
  form: SongForm
  busy: boolean
  onChange: (patch: Partial<SongForm>) => void
  onSubmit: () => void
  onCancel: () => void
  onOpenLink: () => void
}) {
  const u = ui()
  useEscape(onCancel)
  const canOpen = normalizeLink(form.url).startsWith('https://')
  return (
    <AnimatedModal
      onBackdrop={onCancel}
      panelStyle={{ width: 480, maxWidth: '92%', background: u.card, color: u.text, borderRadius: 12, padding: 20 }}
    >
      <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 12 }}>Liedje</div>
      <label style={metaLabel(u)}>
        Titel
        <input
          autoFocus
          value={form.title}
          onChange={(e) => onChange({ title: e.target.value })}
          placeholder="Blinding Lights"
          style={{ ...field(u), marginTop: 4 }}
        />
      </label>
      <label style={{ ...metaLabel(u), marginTop: 12, display: 'block' }}>
        Artiest
        <input
          value={form.artist}
          onChange={(e) => onChange({ artist: e.target.value })}
          placeholder="The Weeknd"
          style={{ ...field(u), marginTop: 4 }}
        />
      </label>
      <label style={{ ...metaLabel(u), marginTop: 12, display: 'block' }}>
        Link
        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          <input
            value={form.url}
            onChange={(e) => onChange({ url: e.target.value })}
            placeholder="https://open.spotify.com/track/…"
            style={{ ...field(u), flex: 1 }}
          />
          <button
            type="button"
            onClick={onOpenLink}
            disabled={!canOpen}
            title={canOpen ? 'Openen in je browser' : 'Plak eerst een https-link'}
            style={{ ...ghostBtn(u), opacity: canOpen ? 1 : 0.45, cursor: canOpen ? 'pointer' : 'default' }}
          >
            Openen
          </button>
        </div>
      </label>
      <div style={{ fontSize: 12, opacity: 0.6, marginTop: 10, lineHeight: 1.45 }}>
        Titel en artiest blijven bewaard, ook als de dienst waar de link naartoe wijst
        ooit verdwijnt.
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
        <button type="button" onClick={onCancel} style={ghostBtn(u)}>
          Annuleren
        </button>
        <button type="button" onClick={onSubmit} disabled={busy} style={primaryBtn(u)}>
          Opslaan
        </button>
      </div>
    </AnimatedModal>
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
  const u = ui()
  useEscape(onCancel)
  return (
    <AnimatedModal
      onBackdrop={onCancel}
      panelStyle={{ width: 520, maxWidth: '92%', background: u.card, color: u.text, borderRadius: 12, padding: 20 }}
    >
        <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 12 }}>Foto-gegevens</div>
        <label style={metaLabel(u)}>
          Bijschrift
          <input
            autoFocus
            value={form.caption}
            onChange={(e) => onChange({ caption: e.target.value })}
            placeholder="Bijschrift bij de foto"
            style={{ ...field(u), marginTop: 4 }}
          />
        </label>
        <div style={{ display: 'flex', gap: 12, marginTop: 12 }}>
          <label style={{ ...metaLabel(u), flex: 1 }}>
            Datum
            <input
              type="date"
              value={form.date}
              onChange={(e) => onChange({ date: e.target.value })}
              style={{ ...field(u), marginTop: 4 }}
            />
          </label>
          <label style={{ ...metaLabel(u), flex: 1 }}>
            Plaats
            <input
              value={form.place}
              onChange={(e) => onChange({ place: e.target.value })}
              placeholder="bijv. Amsterdam"
              style={{ ...field(u), marginTop: 4 }}
            />
          </label>
        </div>
        <label style={{ ...metaLabel(u), marginTop: 12 }}>
          Mensen (komma-gescheiden)
          <input
            value={form.people}
            onChange={(e) => onChange({ people: e.target.value })}
            placeholder="Jim, Wout, oma"
            style={{ ...field(u), marginTop: 4 }}
          />
        </label>
        <label style={{ ...metaLabel(u), marginTop: 12 }}>
          Trefwoorden (komma-gescheiden)
          <input
            value={form.tags}
            onChange={(e) => onChange({ tags: e.target.value })}
            placeholder="strand, zomer, vakantie"
            style={{ ...field(u), marginTop: 4 }}
          />
        </label>
        {!form.isSound && (
        <div style={{ ...metaLabel(u), marginTop: 12 }}>
          Kader
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
            {[{ id: '', name: 'Geërfd (thema)' }, ...FRAME_STYLES].map((f) => (
              <button
                key={f.id || 'inherit'}
                onClick={() => onChange({ frame: f.id })}
                style={{
                  padding: '6px 12px',
                  borderRadius: 8,
                  cursor: 'pointer',
                  background: u.cardAlt,
                  color: u.text,
                  fontSize: 13,
                  border: form.frame === f.id ? `2px solid ${u.primary}` : `2px solid ${u.border}`,
                }}
              >
                {f.name}
              </button>
            ))}
          </div>
        </div>
        )}
        {form.exif.length > 0 && (
          <div style={{ marginTop: 16, borderTop: `1px solid ${u.border}`, paddingTop: 12 }}>
            <div style={{ fontSize: 12, color: u.textFaint, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>
              EXIF (uit de foto)
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {form.exif.map((e) => (
                <div key={e.label} style={{ display: 'flex', gap: 14, fontSize: 13 }}>
                  <span style={{ color: u.textMuted, minWidth: 150 }}>{e.label}</span>
                  <span style={{ color: u.btnText }}>{e.value}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
          <button onClick={onCancel} style={ghostBtn(u)}>Annuleren</button>
          <button onClick={onSubmit} disabled={busy} style={primaryBtn(u)}>
            {busy ? 'Bezig…' : 'Opslaan'}
          </button>
        </div>
    </AnimatedModal>
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
  backend,
  onImported,
}: {
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
  onClose: () => void
  vaultPath: string | null
  onChangeVault: () => void
  onReindex: () => void
  onResetSettings: () => void
  backend: Backend | null
  onImported: () => void
}) {
  const [tab, setTab] = useState<
    'thema' | 'weergave' | 'navigatie' | 'tijdlijn' | 'dia' | 'muziek' | 'beheer' | 'telefoon' | 'sneltoetsen' | 'over'
  >('thema')
  useEscape(onClose)
  // Versie runtime uit de app-bundle halen (klopt zo automatisch met de installer);
  // in browser-dev bestaat de Tauri-API niet → val terug op de build-time versie die
  // vite.config.ts uit tauri.conf.json injecteert (loopt dus vanzelf mee).
  const [appVersion, setAppVersion] = useState(__APP_VERSION__)
  useEffect(() => {
    let alive = true
    void import('@tauri-apps/api/app')
      .then((m) => m.getVersion())
      .then((v) => {
        if (alive) setAppVersion(v)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])
  const u = ui()
  const seg = (m: 'custom' | 'grid' | 'scatter'): React.CSSProperties => ({
    ...ghostBtn(u),
    background: settings.defaultLayout === m ? u.primary : 'transparent',
    borderColor: settings.defaultLayout === m ? u.primary : u.border,
    color: settings.defaultLayout === m ? u.primaryText : u.text,
  })
  const segOn = (active: boolean): React.CSSProperties => ({
    ...ghostBtn(u),
    background: active ? u.primary : 'transparent',
    borderColor: active ? u.primary : u.border,
    color: active ? u.primaryText : u.text,
  })
  const desc = (t: React.ReactNode): React.ReactElement => (
    <div style={{ fontSize: 12, color: u.textFaint, marginTop: 6 }}>{t}</div>
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
    <div
      role="switch"
      aria-checked={on}
      tabIndex={0}
      onClick={() => set(!on)}
      onKeyDown={(e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault()
          set(!on)
        }
      }}
      style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', userSelect: 'none' }}
    >
      <Switch on={on} u={u} />
      <span style={{ fontSize: 14, color: u.text }}>{label}</span>
    </div>
  )
  const subhead = (t: string): React.ReactElement => (
    <div style={{ fontSize: 13, color: u.textMuted, margin: '16px 0 6px' }}>{t}</div>
  )
  const kbd: React.CSSProperties = {
    display: 'inline-block',
    padding: '2px 7px',
    fontSize: 12,
    fontFamily: 'ui-monospace, monospace',
    color: u.textCrisp,
    background: u.kbdBg,
    border: `1px solid ${u.kbdBorder}`,
    borderRadius: 5,
    boxShadow: `0 1px 0 ${u.kbdShadow}`,
    whiteSpace: 'nowrap',
  }
  // Sidebar-navigatie: verticale sectielijst links (toptabs wrapten bij 7+
  // secties en boden geen ruimte voor logische groepering).
  const navBtn = (id: typeof tab, label: string): React.ReactElement => (
    <button
      onClick={() => setTab(id)}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '9px 14px',
        border: 'none',
        borderRadius: 8,
        background: tab === id ? u.cardAlt : 'transparent',
        color: tab === id ? u.text : u.textMuted,
        fontSize: 13,
        fontWeight: tab === id ? 600 : 400,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
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
        background: u.backdrop,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 780,
          maxWidth: '94%',
          height: 'min(660px, 88vh)',
          background: u.card,
          color: u.text,
          borderRadius: 12,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 700, padding: '18px 22px 12px' }}>Instellingen</div>
        <div style={{ display: 'flex', flex: '1 1 auto', minHeight: 0 }}>
          <div
            style={{
              width: 172,
              flex: '0 0 auto',
              padding: '4px 10px 10px 12px',
              borderRight: `1px solid ${u.border}`,
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
            }}
          >
            {navBtn('thema', 'Thema')}
            {navBtn('weergave', 'Weergave')}
            {navBtn('navigatie', 'Navigatie')}
            {navBtn('tijdlijn', 'Tijdlijn & canvas')}
            {navBtn('dia', 'Diavoorstelling')}
            {navBtn('muziek', 'Muziek')}
            {navBtn('beheer', 'Beheer')}
            {navBtn('telefoon', 'Telefoon')}
            {navBtn('sneltoetsen', 'Sneltoetsen')}
            {navBtn('over', 'Over')}
          </div>
          <div style={{ overflowY: 'auto', padding: '14px 22px 6px', flex: '1 1 auto' }}>
          {tab === 'thema' && (
            <>
              {subhead('Thema')}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
                {THEMES.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => onChange({ themeId: t.id })}
                    title={t.name}
                    style={{
                      padding: 0,
                      borderRadius: 8,
                      overflow: 'hidden',
                      cursor: 'pointer',
                      textAlign: 'left',
                      background: u.cardAlt,
                      border: settings.themeId === t.id ? `2px solid ${u.primary}` : `2px solid ${u.border}`,
                    }}
                  >
                    <div
                      style={{
                        height: 44,
                        background: hexColor(t.colors.appBg),
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 5,
                      }}
                    >
                      <span
                        style={{
                          width: 18,
                          height: 13,
                          borderRadius: 2,
                          background: hexColor(t.colors.surface),
                          border: `1px solid ${hexColor(t.colors.surfaceStroke)}`,
                        }}
                      />
                      <span style={{ width: 12, height: 12, borderRadius: 6, background: hexColor(t.colors.accent) }} />
                      <span style={{ width: 18, height: 13, borderRadius: 2, background: hexColor(t.colors.frame) }} />
                    </div>
                    <div
                      style={{
                        padding: '5px 7px',
                        fontSize: 13,
                        color: settings.themeId === t.id ? u.text : u.tileText,
                        fontFamily: t.fonts.title,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {t.name}
                    </div>
                  </button>
                ))}
              </div>
              {desc(
                'Kleuren, fonts en papier-/linnen-texturen van de tijdlijn en de panelen — direct toegepast. Per jaar of memory kiezen kan met de Thema-knop op dat niveau.',
              )}
            </>
          )}

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
              <div style={{ height: 1, background: u.border, margin: '16px 0' }} />
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
              <div style={{ height: 1, background: u.border, margin: '16px 0' }} />
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
              <div style={{ height: 1, background: u.border, margin: '16px 0' }} />
              <Toggle
                on={settings.l3StepAnimation}
                set={(v) => onChange({ l3StepAnimation: v })}
                label="Schuif-animatie bij vorige/volgende (detailweergave)"
              />
              {desc('In de detailweergave schuift de vorige foto/video weg en de nieuwe in beeld. Uit = direct wisselen.')}
            </>
          )}

          {tab === 'navigatie' && (
            <>
              {subhead('Terug navigeren')}
              {desc(
                <>
                  Hiermee bepaal je hoe je een niveau teruggaat. <b>Escape</b> en de <b>terugknop</b>{' '}
                  linksboven werken altijd, ongeacht deze instellingen.
                </>,
              )}
              <div style={{ marginTop: 10 }}>
                <Toggle
                  on={settings.backOnEmptyClick}
                  set={(v) => onChange({ backOnEmptyClick: v })}
                  label="Klik op lege ruimte gaat terug"
                />
                {desc('Een klik naast een foto/item zoomt een niveau uit. Uit? Dan doet zo’n klik niets — handig als je graag rondklikt.')}
              </div>
              <div style={{ marginTop: 12 }}>
                <Toggle
                  on={settings.backOnZoomOut}
                  set={(v) => onChange({ backOnZoomOut: v })}
                  label="Ver uitzoomen gaat terug"
                />
                {desc('Ver genoeg uitzoomen springt een niveau terug. Uit? Dan stopt het uitzoomen netjes op het overzicht.')}
              </div>
              <div style={{ marginTop: 12 }}>
                <Toggle
                  on={settings.backOnRightClick}
                  set={(v) => onChange({ backOnRightClick: v })}
                  label="Rechtermuisknop gaat terug"
                />
                {desc('Klik met de rechtermuisknop om een niveau terug te gaan — waar je muis ook staat.')}
              </div>
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

              <div style={{ marginTop: 14 }}>
                <div style={{ fontSize: 13, color: u.textMuted, marginBottom: 6 }}>
                  Rand om foto's: {settings.borderThickness === 0 ? 'geen' : `${settings.borderThickness}px`}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                  <input
                    type="range"
                    min={0}
                    max={16}
                    step={1}
                    value={settings.borderThickness}
                    onChange={(e) => onChange({ borderThickness: Number(e.target.value) })}
                    style={{ flex: 1 }}
                  />
                  {/* Levend voorbeeld: een tegeltje met exact de gekozen randdikte. */}
                  <div
                    aria-hidden
                    style={{
                      width: 54,
                      height: 40,
                      flex: '0 0 auto',
                      // De rand-kleur van het APP-thema; een jaar/event met een eigen
                      // thema kan er minimaal van afwijken.
                      background: `#${THEME.colors.frame.toString(16).padStart(6, '0')}`,
                      padding: settings.borderThickness,
                      boxSizing: 'border-box',
                      borderRadius: 2,
                      boxShadow: '0 2px 6px rgba(0,0,0,0.35)',
                    }}
                  >
                    <div
                      style={{
                        width: '100%',
                        height: '100%',
                        background: 'linear-gradient(135deg,#6d7fd6,#b45ea8)',
                      }}
                    />
                  </div>
                </div>
                {desc('Geldt voor de foto’s in een memory; de tegels in de jaar-tijdlijn volgen in dezelfde verhouding (die hebben van oudsher een iets dunnere rand). Niet voor één foto beeldvullend. De klik-zone blijft minstens even groot, dus een dunne rand maakt niets moeilijker aan te klikken.')}
              </div>

              <div style={{ height: 1, background: u.border, margin: '16px 0' }} />
              <Toggle
                on={settings.showMemoryTitles}
                set={(v) => onChange({ showMemoryTitles: v })}
                label="Memory-namen tonen in de jaar-view"
              />
              {desc('De naam bij de kaart, zichtbaar zodra je inzoomt op een thumbnail. Lange namen worden afgekapt.')}

              <div style={{ height: 1, background: u.border, margin: '16px 0' }} />
              <Toggle
                on={settings.curvedLeaders}
                set={(v) => onChange({ curvedLeaders: v })}
                label="Gebogen verbindingslijntjes (as → memory)"
              />
              {desc('Uit = rechte lijntjes. De lijntjes lopen van de tijdlijn naar de memory-kaart.')}

              <div style={{ height: 1, background: u.border, margin: '16px 0' }} />
              <Toggle
                on={settings.hoverPulse}
                set={(v) => onChange({ hoverPulse: v })}
                label="Datum-highlight bij hover (jaar-view)"
              />
              {desc('Beweeg je over een memory, dan schiet er een vonkje langs het lijntje naar de tijdlijn, licht de stip/balk op en verschijnt de exacte datum.')}

              <div style={{ height: 1, background: u.border, margin: '16px 0' }} />
              <Toggle
                on={settings.fineTicks}
                set={(v) => onChange({ fineTicks: v })}
                label="Fijne tijdlijn-verdeling (week/dag)"
              />
              {desc('Zoom je in op de jaar-as, dan verschijnen eerst de week- en daarna de dag-streepjes (maand-streepjes staan er altijd). Gegradueerd en subtiel.')}

              <div style={{ height: 1, background: u.border, margin: '16px 0' }} />
              <Toggle
                on={settings.slideshow}
                set={(v) => onChange({ slideshow: v })}
                label="Slideshow op de jaar-tijdlijn (thumbnails rouleren)"
              />
              {settings.slideshow && (
                <div style={{ marginTop: 10 }}>
                  <div style={{ fontSize: 13, color: u.textMuted, marginBottom: 4 }}>
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

              <div style={{ height: 1, background: u.border, margin: '16px 0' }} />
              <Toggle
                on={settings.yearTileSlideshow}
                set={(v) => onChange({ yearTileSlideshow: v })}
                label="Jaartegels als slideshow (covers rouleren)"
              />
              {settings.yearTileSlideshow && (
                <div style={{ marginTop: 10 }}>
                  <div style={{ fontSize: 13, color: u.textMuted, marginBottom: 6 }}>Cover-bron</div>
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

          {tab === 'muziek' && (
            <>
              {subhead('Gegevens opzoeken')}
              <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={settings.musicLookup}
                  onChange={(e) => onChange({ musicLookup: e.target.checked })}
                />
                <span>Gegevens van liedjes online opzoeken</span>
              </label>
              {desc(
                'Plak je een Spotify- of YouTube-link, dan halen we eenmalig de titel, de artiest en de albumhoes op. ' +
                  'Dat is de enige keer dat MemoryLane voor muziek contact met internet maakt: daarna staat alles lokaal in je vault. ' +
                  'Zet je dit uit, dan vul je titel en artiest zelf in.',
              )}
              {subhead('Wanneer muziek vanzelf begint')}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {([
                  ['nooit', 'Nooit'],
                  ['diavoorstelling', 'Bij een diavoorstelling'],
                  ['diavoorstelling-en-memory', 'Ook bij het openen van een memory'],
                ] as const).map(([id, label]) => (
                  <button key={id} onClick={() => onChange({ musicAuto: id })} style={segOn(settings.musicAuto === id)}>
                    {label}
                  </button>
                ))}
              </div>
              {desc(
                'Handmatig starten kan altijd, ook op "nooit": open het liedje en gebruik de afspeelknop ' +
                  'of de spatiebalk. Muziek die vanzelf begon stopt ook vanzelf als je de memory verlaat; ' +
                  'wat je zelf aanzette blijft doorspelen.',
              )}
              {subhead('Geluid')}
              <div style={{ fontSize: 13, color: u.textMuted, margin: '4px 0 4px' }}>
                Volume: {settings.musicVolume}%
              </div>
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={settings.musicVolume}
                onChange={(e) => onChange({ musicVolume: Number(e.target.value) })}
                style={{ width: '100%' }}
              />
              {desc('Muziek bij een herinnering hoort op de achtergrond te staan, niet eroverheen.')}
              {subhead('Waarom we de tekst bewaren')}
              {desc(
                'De titel en de artiest zijn wat er over twintig jaar nog toe doet. Die staan als gewone tekst in je vault, ' +
                  'dus ook als de dienst waar je link naartoe wijst ooit verdwijnt, weet je nog steeds welk nummer bij deze herinnering hoorde.',
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
              <div style={{ fontSize: 13, color: u.textMuted, margin: '14px 0 4px' }}>
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

              <div style={{ height: 1, background: u.border, margin: '16px 0' }} />
              {subhead('Tagfilter')}
              <label style={{ display: 'block', fontSize: 12, color: u.labelMuted, marginBottom: 4 }}>
                Alleen deze tags (komma-gescheiden)
              </label>
              <input
                type="text"
                value={settings.screensaverInclude}
                onChange={(e) => onChange({ screensaverInclude: e.target.value })}
                placeholder="bijv. vakantie, familie"
                style={tagInput(u)}
              />
              <label style={{ display: 'block', fontSize: 12, color: u.labelMuted, margin: '10px 0 4px' }}>
                Zonder deze tags (komma-gescheiden)
              </label>
              <input
                type="text"
                value={settings.screensaverExclude}
                onChange={(e) => onChange({ screensaverExclude: e.target.value })}
                placeholder="bijv. werk"
                style={tagInput(u)}
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
                  color: u.textSoft,
                  background: u.inputBgSoft,
                  border: `1px solid ${u.border}`,
                  borderRadius: 8,
                  padding: '8px 10px',
                  wordBreak: 'break-all',
                }}
              >
                {vaultPath ?? '(nog geen map gekozen)'}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button onClick={onChangeVault} style={ghostBtn(u)}>Andere map kiezen…</button>
                <button onClick={onReindex} style={ghostBtn(u)}>Index herberekenen</button>
              </div>
              {desc(
                'Kies een andere map met je vault, of herbereken de index (scan de map opnieuw) als je bestanden buiten de app hebt gewijzigd. Je bestanden blijven altijd behouden — de index is een weggooibare cache.',
              )}

              <div style={{ height: 1, background: u.border, margin: '16px 0' }} />
              {subhead('Resetten')}
              <button onClick={onResetSettings} style={{ ...ghostBtn(u), borderColor: u.dangerMutedBorder, color: u.dangerMutedText }}>
                App-instellingen resetten
              </button>
              {desc(
                'Zet alle app-instellingen (weergave, diavoorstelling, per-memory onthouden standen) terug naar standaard. Je foto’s, memories en curatie in de vault blijven ongemoeid.',
              )}
            </>
          )}
          {tab === 'telefoon' && (
            <>
              {backend ? (
                <SettingsPhone backend={backend} onImported={onImported} />
              ) : (
                <div style={{ color: u.textMuted, fontSize: 13 }}>Backend nog niet gereed…</div>
              )}
            </>
          )}
          {tab === 'sneltoetsen' && (
            <>
              {desc('Alle toetsen en muis-/sleepacties, gegroepeerd per context.')}
              {[
                {
                  title: 'Algemeen',
                  items: [
                    { k: ['Ctrl', 'K'], d: 'Zoeken' },
                    { k: ['S'], d: 'Diavoorstelling starten' },
                    { k: ['E'], d: 'Kijkmodus (bewerkknoppen tonen/verbergen)' },
                    { k: ['T'], d: 'Titel bovenin tonen/verbergen' },
                    { k: ['Esc'], d: 'Sluiten — dialoog, zoeken of diavoorstelling' },
                    { k: ['F11'], d: 'Volledig scherm — chromeless (geen OS-titelbalk) aan/uit' },
                    { k: ['F'], d: 'Venster maximaliseren (mét vensterrand) aan/uit' },
                    { k: ['Shift', 'F'], d: 'Foto/video beeldvullend in focus (met blur-vulling)' },
                  ],
                },
                {
                  title: 'Navigeren (zoombare tijdlijn)',
                  items: [
                    { k: ['Klik'], d: 'Op een tegel/kaart/foto → één niveau dieper' },
                    { k: ['‹'], d: 'Terugknop linksboven → één niveau terug (werkt altijd)' },
                    { k: ['Esc'], d: 'Eén niveau terug (werkt altijd)' },
                    { k: ['Rechts-klik'], d: 'Eén niveau terug (uit te zetten in Weergave)' },
                    { k: ['Klik'], d: 'Standaard: op lege ruimte ernaast → terug (uit te zetten in Weergave)' },
                    { k: ['Scroll', 'Pinch'], d: 'In-/uitzoomen naar de cursor' },
                    { k: ['Uitzoomen'], d: 'Standaard: ver genoeg → één niveau terug (uit te zetten in Weergave)' },
                    { k: ['Ctrl', '0'], d: 'Op het overzicht: alle jaren passend in beeld' },
                    { k: ['Ctrl', '1'], d: 'Op het overzicht: standaard kaartgrootte' },
                    { k: ['Dubbelklik'], d: 'Op het overzicht (lege ruimte): wissel passend ↔ standaard (ook de ⤢-knop)' },
                    { k: ['Slepen'], d: 'Pannen' },
                    { k: ['←', '→'], d: 'In een detailfoto: vorige / volgende foto' },
                    { k: ['Slepen'], d: 'In een jaar voorbij de rand → vorig/volgend jaar' },
                  ],
                },
                {
                  title: 'Jaar-tijdlijn',
                  items: [
                    { k: ['Ctrl'], d: '(ingedrukt houden) dag-indicator op de as' },
                    { k: ['Ctrl', '+', 'Klik'], d: 'Op de as → nieuwe memory op die datum' },
                    { k: ['Ctrl', '+', 'Slepen'], d: 'Op de as → datumbereik voor een meerdaagse memory' },
                    { k: ['Shift', '+', 'Slepen'], d: 'Op een memory-kaart → belang/grootte bijstellen' },
                  ],
                },
                {
                  title: 'Memory-canvas',
                  items: [
                    { k: ['Hoekje slepen'], d: 'Notitie: box groter/kleiner (werkt in elke weergave)' },
                    { k: ['Alt', '+', 'Slepen'], d: 'Notitie: box groter/kleiner (tekst herloopt, font gelijk)' },
                    { k: ['Alt', '+', 'Klik'], d: 'Notitie: terug naar automatisch passend om de tekst' },
                    { k: ['Shift', '+', 'Slepen'], d: 'Foto/notitie schalen (bij een notitie schaalt de tekst mee) — eigen layout' },
                    { k: ['Alt', '+', 'Slepen'], d: 'Foto roteren — alleen in de eigen layout' },
                    { k: ['Ctrl'], d: '(ingedrukt) gouden rand op de memory-omslag tonen' },
                    { k: ['Ctrl', '+', 'Shift'], d: '(ingedrukt) blauwe rand op de vaste jaar-cover tonen' },
                    { k: ['Ctrl', '+', 'Klik'], d: 'Foto als memory-omslag (featured)' },
                    { k: ['Ctrl', '+', 'Shift', '+', 'Klik'], d: 'Foto als vaste jaar-cover' },
                  ],
                },
              ].map((group) => (
                <div key={group.title}>
                  {subhead(group.title)}
                  {group.items.map((it, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: 12, padding: '5px 0' }}>
                      <div style={{ display: 'flex', gap: 4, flex: '0 0 190px', flexWrap: 'wrap', alignItems: 'center' }}>
                        {it.k.map((key, j) =>
                          key === '+' ? (
                            <span key={j} style={{ color: u.textFaint, fontSize: 12 }}>
                              +
                            </span>
                          ) : (
                            <span key={j} style={kbd}>
                              {key}
                            </span>
                          ),
                        )}
                      </div>
                      <div style={{ fontSize: 13, color: u.textSoft }}>{it.d}</div>
                    </div>
                  ))}
                </div>
              ))}
            </>
          )}
          {tab === 'over' && (
            <>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 4 }}>
                <div style={{ fontSize: 22, fontWeight: 700, color: u.text }}>MemoryLane</div>
                <div style={{ fontSize: 13, color: u.textMuted }}>versie {appVersion}</div>
              </div>
              <div style={{ fontSize: 14, color: u.textSoft, lineHeight: 1.6, marginTop: 10 }}>
                Een persoonlijke, inzoombare tijdlijn voor je herinneringen — van een overzicht van
                alle jaren tot één foto in detail. Alles blijft lokaal op je eigen computer.
              </div>

              {subhead('In het kort')}
              <div style={{ fontSize: 13.5, color: u.textSoft, lineHeight: 1.8 }}>
                • <b>Zoomen</b> (scrollen, of pijltjes + Enter) brengt je dieper: levenslijn → jaar →
                memory → detailfoto. <b>Uitzoomen</b> of <b>Esc</b> gaat terug.
                <br />• <b>Pijltjes</b> verplaatsen de focus (witte rand), <b>Enter</b> dieper,{' '}
                <b>Esc</b> terug — je kunt puur op het toetsenbord door alles heen.
                <br />• <b>F11</b> = volledig scherm (chromeless); <b>F</b> = venster maximaliseren;{' '}
                <b>E</b> verbergt/toont de knoppen (werkt in elke vensterstand); <b>Shift+F</b> (of
                Enter op een foto) = beeldvullend met een geblurde achtergrond.
                <br />• <b>S</b> diavoorstelling · <b>Ctrl+K</b> zoeken · <b>T</b> titel aan/uit ·{' '}
                <b>E</b> kijkmodus.
                <br />• Je telefoon koppel je onder de tab <b>Telefoon</b>; de volledige toetsenlijst
                staat onder <b>Sneltoetsen</b>.
              </div>

              {subhead('Je herinneringen')}
              <div style={{ fontSize: 13.5, color: u.textSoft, lineHeight: 1.6 }}>
                Alles staat als gewone bestanden in je eigen map (die je bij de eerste start kiest).
                Een back-up maak je simpelweg door die map te kopiëren.
              </div>

              {subhead('Gemaakt door')}
              <div style={{ fontSize: 14, color: u.textSoft, lineHeight: 1.7 }}>
                Jim
                <br />
                <span style={{ color: u.textMuted }}>info@elphinstone.nl</span>
              </div>
            </>
          )}
        </div>
        </div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            padding: '12px 20px',
            borderTop: `1px solid ${u.border}`,
          }}
        >
          <button onClick={onClose} style={primaryBtn(u)}>Klaar</button>
        </div>
      </div>
    </div>
  )
}

/** Zwevende actie-knop (pill) op het canvas, met hover-feedback. Kleur-
 * semantiek: 'primary' = dé hoofdactie van een rij (max één per rij),
 * 'neutral' = overige acties, 'ok' = bevestigend opslaan, 'danger' =
 * destructief. */
function Pill({
  kind = 'neutral',
  small = false,
  title,
  icon,
  iconOnly = false,
  onClick,
  children,
}: {
  kind?: 'neutral' | 'primary' | 'ok' | 'danger'
  small?: boolean
  title?: string
  /** Optioneel lijn-icoon vóór de tekst (of alleen het icoon bij iconOnly). */
  icon?: React.ReactNode
  /** Ronde icoon-knop zonder tekst — `title` wordt dan de aria-label. */
  iconOnly?: boolean
  onClick: () => void
  children?: React.ReactNode
}) {
  const u = ui()
  const [hover, setHover] = useState(false)
  const bg =
    kind === 'primary' ? u.primary : kind === 'ok' ? u.okDeep : kind === 'danger' ? u.dangerDeep : u.fabNeutralBg
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={iconOnly ? title : undefined}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        ...fabBtn(u),
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        background: bg,
        ...(small ? { fontSize: 12, padding: '8px 12px' } : null),
        ...(iconOnly ? { width: 44, padding: 0, justifyContent: 'center' } : null),
        filter: hover ? 'brightness(1.18)' : 'none',
        transition: 'filter 120ms',
      }}
    >
      {icon}
      {!iconOnly && children}
    </button>
  )
}

/** Segment in de weergave-schakelaar (één afgeronde track): actief = primair
 * vlak. Een klik op het actíéve segment blijft doorgegeven — Scatter werpt
 * dan opnieuw en "Willekeurig" schudt opnieuw. */
function SegBtn({
  active,
  title,
  icon,
  onClick,
  children,
}: {
  active: boolean
  title?: string
  /** Lijn-icoon boven het label (concept-stijl). */
  icon?: React.ReactNode
  onClick: () => void
  children: React.ReactNode
}) {
  const u = ui()
  const [hover, setHover] = useState(false)
  return (
    <button
      onClick={onClick}
      title={title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={
        icon
          ? {
              // Icoon-boven-label variant (concept: ~72×54).
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 4,
              minWidth: 60,
              padding: '7px 12px',
              borderRadius: 12,
              border: 'none',
              cursor: 'pointer',
              font: '12px sans-serif',
              background: active ? u.primary : hover ? 'rgba(255,255,255,0.10)' : 'transparent',
              color: active ? u.primaryText : u.floatBtnSoftText,
              transition: 'background 120ms',
              whiteSpace: 'nowrap',
            }
          : {
              padding: '8px 14px',
              borderRadius: 18,
              border: 'none',
              cursor: 'pointer',
              font: '13px sans-serif',
              background: active ? u.primary : hover ? 'rgba(255,255,255,0.10)' : 'transparent',
              color: active ? u.primaryText : u.floatBtnSoftText,
              transition: 'background 120ms',
              whiteSpace: 'nowrap',
            }
      }
    >
      {icon}
      {children}
    </button>
  )
}

/** Kale icoon-knop bínnen een dock-container: transparant met hover-highlight;
 * `primary` = paars gevuld (hoofdactie), `accent` = paars-getint (bijv.
 * "Opslaan als Eigen"). De container levert de achtergrond, dus deze knoppen
 * zijn zelf achtergrondloos (geen pil-in-pil). */
function DockIconBtn({
  title,
  icon,
  onClick,
  primary = false,
  accent = false,
  active = false,
  domId,
}: {
  title: string
  icon: React.ReactNode
  onClick: () => void
  primary?: boolean
  accent?: boolean
  active?: boolean
  /** Optioneel DOM-id (zodat een buiten-klik-vanger deze knop kan uitsluiten). */
  domId?: string
}) {
  const u = ui()
  const [hover, setHover] = useState(false)
  const bg = primary
    ? u.primary
    : accent || active
      ? u.primaryFaintBg
      : hover
        ? 'rgba(255,255,255,0.10)'
        : 'transparent'
  const color = primary ? u.primaryText : accent || active ? u.primarySoft : u.floatBtnSoftText
  return (
    <button
      id={domId}
      onClick={onClick}
      title={title}
      aria-label={title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 46,
        height: 44,
        border: accent ? `1px solid ${u.primarySoft}` : 'none',
        borderRadius: 12,
        background: bg,
        color,
        cursor: 'pointer',
        transition: 'background 120ms, filter 120ms',
        filter: hover && primary ? 'brightness(1.12)' : 'none',
      }}
    >
      {icon}
    </button>
  )
}

/** Recht/gedraaid-schakelaar (alleen in Scatter): een schuif-toggle met een
 * witte knop die naar het actieve glyph glijdt. `on` = gedraaid (scheef),
 * knop rechts; `off` = recht, knop links. Het actieve glyph staat op de witte
 * knop en is donker; het inactieve is gedempt. */
function RotateToggle({ on, onToggle, u }: { on: boolean; onToggle: () => void; u: UiPalette }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={on ? 'Scatter legt foto’s scheef (klik = recht)' : 'Scatter legt foto’s recht (klik = scheef)'}
      aria-label="Recht of gedraaid"
      aria-pressed={on}
      style={{
        position: 'relative',
        width: 58,
        height: 44,
        borderRadius: 12,
        border: `1px solid ${u.border}`,
        background: 'rgba(255,255,255,0.05)',
        cursor: 'pointer',
        padding: 5,
        display: 'flex',
        alignItems: 'center',
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: 5,
          left: 5,
          width: 24,
          height: 32,
          borderRadius: 9,
          background: '#ffffff',
          boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
          transform: `translateX(${on ? 24 : 0}px)`,
          transition: 'transform 0.24s cubic-bezier(0.2,0.8,0.2,1)',
        }}
      />
      <span style={{ position: 'relative', zIndex: 1, width: 24, display: 'flex', justifyContent: 'center', color: on ? u.floatBtnSoftText : '#1a1a1a' }}>
        <svg width={15} height={15} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}>
          <rect x="4" y="4" width="8" height="8" rx="1.3" />
        </svg>
      </span>
      <span style={{ position: 'relative', zIndex: 1, width: 24, display: 'flex', justifyContent: 'center', color: on ? '#1a1a1a' : u.floatBtnSoftText }}>
        <svg width={15} height={15} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}>
          <rect x="4" y="4" width="8" height="8" rx="1.3" transform="rotate(14 8 8)" />
        </svg>
      </span>
    </button>
  )
}

function Fab({
  uiLevel,
  layoutMode,
  onAddEvent,
  onAddYear,
  onAddNote,
  onAddSong,
  onAddPhotos,
  onEditEvent,
  onYearTheme,
  onEventTheme,
  onLayout,
  onSaveLayout,
  onEdit,
  onOpenSource,
  onPlaySong,
  playing,
  onDelete,
  scatterRotate,
  onToggleScatterRotate,
  gridSort,
  onGridSort,
  squarePhotos,
  onToggleSquarePhotos,
  weergaveOpen,
  onToggleWeergave,
  coverPick,
  onToggleCoverPick,
}: {
  uiLevel: 'lifeline' | 'year' | 'event' | 'focus'
  layoutMode: 'custom' | 'grid' | 'scatter'
  onAddEvent: () => void
  onAddYear: () => void
  onAddNote: () => void
  onAddSong: () => void
  onAddPhotos: () => void
  onEditEvent: () => void
  onYearTheme: () => void
  onEventTheme: () => void
  onLayout: (mode: 'custom' | 'grid' | 'scatter') => void
  onSaveLayout: () => void
  onEdit: () => void
  onDelete: () => void
  /** Alleen gezet als het gefocuste item een liedje met een https-link is. */
  onOpenSource?: () => void
  /** Alleen gezet als het gefocuste item een lokaal audiobestand heeft. */
  onPlaySong?: () => void
  /** Klinkt dit item op dit moment? Stuurt het label van de knop. */
  playing?: boolean
  scatterRotate: boolean
  onToggleScatterRotate: () => void
  gridSort: 'date' | 'name' | 'random'
  onGridSort: (sort: 'date' | 'name' | 'random') => void
  squarePhotos: boolean
  onToggleSquarePhotos: () => void
  weergaveOpen: boolean
  onToggleWeergave: () => void
  coverPick: boolean
  onToggleCoverPick: () => void
}) {
  const u = ui()
  // Gecentreerd onderaan: alle niveaus delen dezelfde plek en knoppentaal. De
  // centrering (translateX -50%) zit op een STATISCHE buiten-div; de entree-
  // animatie (motion, die `y` beweegt) draait op de binnen-kolom. Zo klobbert
  // motion de translateX niet (het herschrijft anders de hele transform).
  const wrap: React.CSSProperties = {
    position: 'absolute',
    left: '50%',
    bottom: 24,
    transform: 'translateX(-50%)',
  }
  const wrapCol: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 8,
  }
  const row: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'center' }
  // Gedeelde dock-balk (donker, afgerond, zwevend).
  const dockBar: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    padding: 5,
    borderRadius: 18,
    background: u.fabSortBg,
    boxShadow: '0 6px 20px rgba(0,0,0,0.45)',
  }
  const divider = <div style={{ width: 1, height: 26, background: 'rgba(255,255,255,0.14)', margin: '0 3px' }} />
  // Zachte entree per niveau: de dock fa't/glijdt omhoog in beeld (key = niveau,
  // dus opnieuw bij elke niveauwissel).
  const dockEnter = {
    initial: { opacity: 0, y: 12 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.22, ease: [0.2, 0.8, 0.2, 1] as const },
  }
  if (uiLevel === 'lifeline') {
    return (
      <div style={wrap}>
        <m.div key="lifeline" style={wrapCol} {...dockEnter}>
          <Pill kind="primary" icon={<IconPlus />} onClick={onAddYear}>Nieuw jaar</Pill>
        </m.div>
      </div>
    )
  }
  if (uiLevel === 'year') {
    return (
      <div style={wrap}>
        <m.div key="year" style={wrapCol} {...dockEnter}>
          <div style={row}>
            <Pill icon={<IconPalette size={17} />} onClick={onYearTheme} title="Thema van dit jaar">Thema</Pill>
            <Pill kind="primary" icon={<IconPlus />} onClick={onAddEvent}>Nieuwe memory</Pill>
          </div>
        </m.div>
      </div>
    )
  }
  if (uiLevel === 'event') {
    return (
      <div style={wrap}>
      <m.div key="event" style={wrapCol} {...dockEnter}>
        {/* BOVEN: de weergave-balk. Standaard verborgen; verschijnt pas als je op
            de schuifjes-knop ("Weergave aanpassen") klikt. Groeit geanimeerd in
            beeld; de context-knoppen (recht/gedraaid, opslaan, sortering) poppen
            mee in/uit terwijl de balk soepel meeschaalt. */}
        <AnimatePresence>
          {weergaveOpen && (
            <m.div
              key="layoutbar"
              data-layoutbar
              initial={{ opacity: 0, scale: 0.9, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.92, y: 8 }}
              transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}
              style={{ ...dockBar, flexWrap: 'wrap', justifyContent: 'center', maxWidth: 'min(96vw, 760px)' }}
            >
              <SegBtn active={layoutMode === 'custom'} icon={<IconEigen />} onClick={() => onLayout('custom')}>
                Eigen
              </SegBtn>
              <SegBtn active={layoutMode === 'grid'} icon={<IconGrid />} onClick={() => onLayout('grid')}>
                Grid
              </SegBtn>
              <SegBtn
                active={layoutMode === 'scatter'}
                icon={<IconScatter />}
                onClick={() => onLayout('scatter')}
                title="Elke klik een nieuwe worp"
              >
                Scatter
              </SegBtn>
              {divider}
              <SegBtn
                active={squarePhotos}
                icon={<IconCrop />}
                onClick={onToggleSquarePhotos}
                title="Foto's vierkant bijsnijden (aan/uit)"
              >
                Vierkant
              </SegBtn>
              {/* Context-knoppen: gewoon voorwaardelijk (géén animatie) — dat is
                  stabiel en hapert niet bij een layout-wissel, en "Opslaan als
                  Eigen" is zo altijd zichtbaar in zowel Grid als Scatter. */}
              {layoutMode === 'scatter' && (
                <RotateToggle on={scatterRotate} onToggle={onToggleScatterRotate} u={u} />
              )}
              {layoutMode !== 'custom' && (
                <DockIconBtn title="Opslaan als 'Eigen'" icon={<IconEigen size={18} />} onClick={onSaveLayout} accent />
              )}
              {layoutMode === 'grid' && (
                <>
                  {divider}
                  <Pill small kind={gridSort === 'date' ? 'primary' : 'neutral'} onClick={() => onGridSort('date')} title="Sorteer op datum/tijd">
                    Datum
                  </Pill>
                  <Pill small kind={gridSort === 'name' ? 'primary' : 'neutral'} onClick={() => onGridSort('name')} title="Sorteer op naam/bestandsnaam">
                    Naam
                  </Pill>
                  <Pill
                    small
                    kind={gridSort === 'random' ? 'primary' : 'neutral'}
                    onClick={() => onGridSort('random')}
                    title="Willekeurig — klik nogmaals om opnieuw te schudden"
                  >
                    Willekeurig 🎲
                  </Pill>
                </>
              )}
            </m.div>
          )}
        </AnimatePresence>
        {/* ONDER: actie-balk (icoon-knoppen), altijd zichtbaar. De schuifjes-knop
            toont/verbergt de weergave-balk; de potlood-knop is paars = hoofd.
            De balk is onderaan verankerd (wrap: bottom 24), dus hij verschuift niet
            als de weergave-balk erboven verschijnt — geen layout-animatie nodig. */}
        <div style={dockBar}>
          <DockIconBtn title="Foto's toevoegen" icon={<IconImage />} onClick={onAddPhotos} />
          <DockIconBtn title="Notitie toevoegen" icon={<IconNote />} onClick={onAddNote} />
          <DockIconBtn title="Muziek toevoegen" icon={<IconMusicPlus />} onClick={onAddSong} />
          <DockIconBtn
            title="Thumbnail selecteren — kies welke foto de omslag van deze memory is"
            icon={<IconCover />}
            onClick={onToggleCoverPick}
            active={coverPick}
          />
          <DockIconBtn title="Weergave aanpassen" icon={<IconSliders />} onClick={onToggleWeergave} active={weergaveOpen} domId="weergave-toggle-btn" />
          <DockIconBtn title="Thema & sfeer" icon={<IconPalette />} onClick={onEventTheme} />
          {divider}
          <DockIconBtn title="Bewerk memory" icon={<IconPencil />} onClick={onEditEvent} />
        </div>
      </m.div>
      </div>
    )
  }
  if (uiLevel === 'focus') {
    return (
      <div style={wrap}>
        <m.div key="focus" style={wrapCol} {...dockEnter}>
          <div style={row}>
            {/* Een liedje met een link: openen is een KIJK-actie, niet iets wat je
                pas na het openen van een bewerkformulier mag kunnen. */}
            {onPlaySong && (
              <Pill
                icon={playing ? <PauseIcon size={16} /> : <PlayIcon size={16} />}
                onClick={onPlaySong}
              >
                {playing ? 'Pauzeer' : 'Speel af'}
              </Pill>
            )}
            {onOpenSource && (
              <Pill icon={<IconExternal size={16} />} onClick={onOpenSource}>Openen</Pill>
            )}
            <Pill kind="primary" icon={<IconPencil size={16} />} onClick={onEdit}>Bewerk</Pill>
            <Pill kind="danger" icon={<IconTrash size={16} />} onClick={onDelete}>Verwijder</Pill>
          </div>
        </m.div>
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
  const u = ui()
  useEscape(onCancel)
  return (
    <AnimatedModal
      onBackdrop={onCancel}
      panelStyle={{ width: 480, maxWidth: '90%', background: u.card, color: u.text, borderRadius: 12, padding: 20 }}
    >
      <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 12 }}>
        {kind === 'text' ? 'Notitie bewerken' : 'Bijschrift bewerken'}
      </div>
      {kind === 'text' ? (
        <textarea
          autoFocus
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Schrijf een herinnering…"
          style={{ ...field(u), height: 200, resize: 'vertical' }}
        />
      ) : (
        <input
          autoFocus
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Bijschrift bij de foto"
          style={field(u)}
        />
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 14 }}>
        <button onClick={onCancel} style={ghostBtn(u)}>Annuleren</button>
        <button onClick={onSubmit} disabled={busy} style={primaryBtn(u)}>
          {busy ? 'Bezig…' : 'Opslaan'}
        </button>
      </div>
    </AnimatedModal>
  )
}

function EventDialog({
  form,
  busy,
  onChange,
  onSubmit,
  onCancel,
  thumbUrl,
  onPickCover,
  tagSuggestions,
}: {
  form: EventForm
  busy: boolean
  onChange: (patch: Partial<EventForm>) => void
  onSubmit: () => void
  onCancel: () => void
  /** Thumbnail-URL van de gekozen omslagfoto, of undefined als er geen keuze is. */
  thumbUrl?: string
  /** Sluit de dialoog en start het kiezen van een omslagfoto op het canvas. */
  onPickCover: () => void
  /** Trefwoorden die in dit jaar al gebruikt worden (aanklikbare suggesties). */
  tagSuggestions: string[]
}) {
  const u = ui()
  useEscape(onCancel)
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
  const serif = 'Georgia, "Times New Roman", serif'
  const fieldLabel: React.CSSProperties = {
    display: 'block',
    fontSize: 11,
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: u.textMuted,
    marginBottom: 7,
  }
  return (
    <AnimatedModal
      onBackdrop={onCancel}
      panelStyle={{
        width: 520,
        maxWidth: '92%',
        maxHeight: '90vh',
        overflowY: 'auto',
        background: u.card,
        color: u.text,
        borderRadius: 22,
        padding: '26px 28px',
        border: `1px solid ${u.border}`,
        boxShadow: '0 30px 80px rgba(0,0,0,0.55)',
      }}
    >
      <div style={{ fontFamily: serif, fontStyle: 'italic', fontSize: 24, marginBottom: 18 }}>
          {form.mode === 'create' ? (form.atDate ? 'Nieuw jaar — eerste memory' : 'Nieuwe memory') : 'Memory bewerken'}
        </div>
        <label style={{ display: 'block' }}>
          <span style={fieldLabel}>Titel</span>
          <input
            autoFocus
            value={form.title}
            onChange={(e) => onChange({ title: e.target.value })}
            placeholder="Titel van de memory"
            style={field(u)}
          />
        </label>
        <div style={{ display: 'flex', gap: 12, marginTop: 14 }}>
          <label style={dateLabel(u)}>
            <span style={fieldLabel}>Begindatum</span>
            <input
              type="date"
              value={form.startAt}
              onChange={(e) => onChange({ startAt: e.target.value })}
              style={{ ...field(u), marginTop: 0 }}
            />
          </label>
          <label style={dateLabel(u)}>
            <span style={fieldLabel}>
              Einddatum <span style={{ textTransform: 'none', letterSpacing: 0 }}>(optioneel)</span>
            </span>
            <input
              type="date"
              value={form.endAt}
              min={form.startAt || undefined}
              onChange={(e) => onChange({ endAt: e.target.value })}
              style={{ ...field(u), marginTop: 0 }}
            />
          </label>
        </div>
        {endBeforeStart && (
          <div style={{ color: u.errorText, fontSize: 13, marginTop: 8 }}>
            De einddatum ligt vóór de begindatum.
          </div>
        )}
        <div style={{ marginTop: 18 }}>
          <div style={fieldLabel}>
            Hoe bijzonder?
            {isCustomSize && (
              <span style={{ textTransform: 'none', letterSpacing: 0, color: u.hintMuted, marginLeft: 6 }}>
                · aangepast ({curSize})
              </span>
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
                    padding: '12px 13px',
                    borderRadius: 12,
                    cursor: 'pointer',
                    textAlign: 'left',
                    border: `1px solid ${active ? u.primary : u.borderSoft}`,
                    background: active ? u.primaryFaintBg : u.choiceBg,
                    boxShadow: active ? `0 0 0 3px ${u.primaryFaintBg}` : 'none',
                    color: active ? u.btnText : u.chipText,
                    transition: 'border 120ms, box-shadow 120ms, background 120ms',
                  }}
                >
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{c.label}</div>
                  <div style={{ fontSize: 11, color: u.hintMuted, marginTop: 3, lineHeight: 1.3 }}>{c.hint}</div>
                </button>
              )
            })}
          </div>
        </div>
        {form.mode === 'edit' && !form.synthetic && (
          <div style={{ marginTop: 18 }}>
            <div style={fieldLabel}>Trefwoorden</div>
            <input
              value={form.tags ?? ''}
              onChange={(e) => onChange({ tags: e.target.value })}
              placeholder="vakantie, concert, familie"
              style={field(u)}
            />
            {/* Bestaande trefwoorden van dit jaar: aanklikken = toevoegen/weghalen. */}
            {tagSuggestions.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                {tagSuggestions.map((t) => {
                  const cur = parseTags(form.tags ?? '')
                  // Hoofdletterloos vergelijken: "Vakantie" en "vakantie" zijn hetzelfde
                  // trefwoord; anders zou de chip een al getypte tag niet herkennen en
                  // zou je 'm dubbel toevoegen.
                  const on = cur.some((x) => x.toLowerCase() === t.toLowerCase())
                  return (
                    <button
                      key={t}
                      type="button"
                      onClick={() =>
                        onChange({
                          tags: (on
                            ? cur.filter((x) => x.toLowerCase() !== t.toLowerCase())
                            : [...cur, t]
                          ).join(', '),
                        })
                      }
                      style={{
                        padding: '4px 10px',
                        borderRadius: 999,
                        fontSize: 12,
                        cursor: 'pointer',
                        border: `1px solid ${on ? u.primary : u.borderSoft}`,
                        background: on ? u.primaryFaintBg : u.choiceBg,
                        color: on ? u.btnText : u.chipText,
                      }}
                    >
                      {t}
                    </button>
                  )
                })}
              </div>
            )}
            <div style={{ fontSize: 11, color: u.hintMuted, marginTop: 6, lineHeight: 1.35 }}>
              Waar je op de jaar-tijdlijn op kunt filteren — bijvoorbeeld alleen je
              vakanties of alleen concerten. Scheiden met komma’s.
            </div>
          </div>
        )}
        {form.mode === 'edit' && (
          <div style={{ marginTop: 18 }}>
            <div style={fieldLabel}>Thumbnail</div>
            <button
              type="button"
              onClick={onPickCover}
              title="Kies welke foto de omslag van deze memory is"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 14,
                width: '100%',
                padding: 10,
                borderRadius: 13,
                cursor: 'pointer',
                textAlign: 'left',
                border: `1px solid ${u.borderSoft}`,
                background: u.choiceBg,
                color: u.chipText,
              }}
            >
              {thumbUrl ? (
                <img
                  src={thumbUrl}
                  alt=""
                  onError={(e) => {
                    // Thumbnail nog niet gegenereerd (verse import): liever niets dan
                    // een gebroken-plaatje-icoon.
                    e.currentTarget.style.visibility = 'hidden'
                  }}
                  style={{
                    width: 84,
                    height: 62,
                    objectFit: 'cover',
                    borderRadius: 8,
                    flex: '0 0 auto',
                    background: u.cardAlt,
                  }}
                />
              ) : (
                <div
                  aria-hidden
                  style={{
                    width: 84,
                    height: 62,
                    flex: '0 0 auto',
                    borderRadius: 8,
                    background: u.cardAlt,
                    border: `1px dashed ${u.border}`,
                    display: 'grid',
                    placeItems: 'center',
                    color: u.textFaint,
                  }}
                >
                  <IconCover size={22} />
                </div>
              )}
              <span style={{ display: 'grid', gap: 3 }}>
                <span style={{ fontWeight: 600, fontSize: 14 }}>
                  {thumbUrl ? 'Andere omslagfoto kiezen' : 'Kies een omslagfoto'}
                </span>
                <span style={{ fontSize: 11, color: u.hintMuted, lineHeight: 1.35 }}>
                  {thumbUrl
                    ? 'Dit is de foto die deze memory op de tijdlijn toont. Een nieuwe keuze geldt meteen.'
                    : 'Nog geen vaste keuze — de tijdlijn toont nu telkens een andere foto uit deze memory. Een keuze geldt meteen.'}
                </span>
              </span>
            </button>
          </div>
        )}
        {form.mode === 'edit' && (
          <div
            style={{
              marginTop: 16,
              padding: '12px 14px',
              borderRadius: 13,
              border: `1px solid ${u.borderSoft}`,
              background: u.choiceBg,
            }}
          >
            <div
              role="switch"
              aria-checked={form.underConstruction ?? false}
              tabIndex={0}
              onClick={() => onChange({ underConstruction: !(form.underConstruction ?? false) })}
              onKeyDown={(e) => {
                if (e.key === ' ' || e.key === 'Enter') {
                  e.preventDefault()
                  onChange({ underConstruction: !(form.underConstruction ?? false) })
                }
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                cursor: 'pointer',
                userSelect: 'none',
                color: u.textSoft,
                fontSize: 14,
              }}
            >
              <Switch on={form.underConstruction ?? false} u={u} />
              <span>
                🔨 Deze memory is nog <strong>in aanbouw</strong>
                <span style={{ color: u.hintMuted, marginLeft: 6, fontSize: 12 }}>
                  · toont een badge in de jaar-view
                </span>
              </span>
            </div>
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 22 }}>
          <button
            onClick={onCancel}
            style={{
              padding: '10px 22px',
              borderRadius: 12,
              border: `1px solid ${u.border}`,
              background: 'transparent',
              color: u.textSoft,
              fontSize: 14,
              cursor: 'pointer',
            }}
          >
            Annuleren
          </button>
          <button
            onClick={onSubmit}
            disabled={busy || invalid}
            style={{
              padding: '10px 26px',
              borderRadius: 12,
              border: 'none',
              background: u.primary,
              color: u.primaryText,
              fontSize: 15,
              fontWeight: 600,
              cursor: busy || invalid ? 'not-allowed' : 'pointer',
              opacity: busy || invalid ? 0.5 : 1,
            }}
          >
            {busy ? 'Bezig…' : 'Opslaan'}
          </button>
        </div>
    </AnimatedModal>
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
  const u = ui()
  useEscape(onCancel)
  return (
    <AnimatedModal
      onBackdrop={onCancel}
      panelStyle={{ width: 480, maxWidth: '90%', background: u.card, color: u.text, borderRadius: 12, padding: 20 }}
    >
      <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 12 }}>Nieuwe notitie</div>
      <textarea
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Schrijf een herinnering…"
        style={{ ...field(u), height: 140, resize: 'vertical' }}
      />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 14 }}>
        <button onClick={onCancel} style={ghostBtn(u)}>Annuleren</button>
        <button onClick={onSubmit} disabled={busy || !value.trim()} style={primaryBtn(u)}>
          {busy ? 'Bezig…' : 'Opslaan'}
        </button>
      </div>
    </AnimatedModal>
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
  const u = ui()
  // Zoeken is transient (geen invoer die verloren kan gaan): Escape sluit
  // altijd direct, ook met de focus buiten (of in) het zoekveld.
  useEscape(onClose, { blurFirst: false })
  return (
    <div
      onClick={onClose}
      style={{
        position: 'absolute',
        inset: 0,
        background: u.backdropSoft,
        display: 'flex',
        justifyContent: 'center',
        paddingTop: 80,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: 560, maxWidth: '92%', background: u.card, color: u.text, borderRadius: 12, padding: 16, height: 'fit-content' }}
      >
        <input
          autoFocus
          value={query}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Zoek in je herinneringen…"
          style={field(u)}
        />
        <div style={{ marginTop: 10, maxHeight: 360, overflowY: 'auto' }}>
          {query.trim() && results.length === 0 && (
            <div style={{ color: u.textMuted, font: '13px sans-serif', padding: '10px 4px' }}>
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
                border: `1px solid ${u.border}`,
                background: u.inputBg,
                color: u.textCrisp,
                cursor: 'pointer',
                font: '14px sans-serif',
              }}
            >
              <div style={{ color: u.textMuted, fontSize: 12, marginBottom: 2 }}>
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

const searchBtn = (u: UiPalette): React.CSSProperties => ({
  position: 'absolute',
  top: 16,
  left: 16,
  padding: '8px 16px',
  borderRadius: 20,
  border: `1px solid ${u.floatBtnBorder}`,
  background: u.floatBtnBg,
  color: u.floatBtnSoftText,
  font: '13px sans-serif',
  cursor: 'pointer',
})

const fitBtn = (u: UiPalette): React.CSSProperties => ({
  position: 'absolute',
  left: 20,
  bottom: 20,
  padding: '9px 16px',
  borderRadius: 20,
  border: `1px solid ${u.fitBtnBorder}`,
  background: u.fitBtnBg,
  color: u.fitBtnText,
  font: '13px sans-serif',
  cursor: 'pointer',
  backdropFilter: 'blur(4px)',
})

/** Terugknop linksboven: een subtiele cirkel met een chevron-links. In rust een
 * vage, bijna transparante cirkel met een zwak-witte pijl (niet storend); bij
 * hover een duidelijke knop met een volwit pijltje. 38×38, gelijk aan het
 * tandwiel — groot genoeg om ook op touch te tikken. */
function BackButton({ onClick }: { onClick: () => void }) {
  const [hover, setHover] = useState(false)
  const u = ui()
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title="Een niveau terug (Esc)"
      aria-label="Een niveau terug"
      style={{ ...backBtn(u), ...(hover ? backBtnHover(u) : null) }}
    >
      <svg width={20} height={20} viewBox="0 0 24 24" fill="none" aria-hidden>
        <path
          d="M15 5l-7 7 7 7"
          stroke={hover ? u.floatBtnText : u.backArrow}
          strokeWidth={2.2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  )
}

/** Pixi-hex (0xrrggbb) → CSS-hex ('#rrggbb'), voor de thema-previews. */
function hexColor(c: number): string {
  return `#${c.toString(16).padStart(6, '0')}`
}

/** Gestylede aan/uit-schakelaar (puur visueel; de klik-afhandeling zit op de
 * omliggende rij). Vervangt de native checkbox voor een consistente,
 * thema-volgende look in beide ui-modes. */
function Switch({ on, u }: { on: boolean; u: UiPalette }) {
  return (
    <span
      aria-hidden
      style={{
        width: 34,
        height: 20,
        borderRadius: 10,
        flex: '0 0 auto',
        background: on ? u.primary : u.border,
        position: 'relative',
        display: 'inline-block',
        transition: 'background 140ms',
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 2,
          left: on ? 16 : 2,
          width: 16,
          height: 16,
          borderRadius: 8,
          background: '#ffffff',
          transition: 'left 140ms',
          boxShadow: '0 1px 2px rgba(0,0,0,0.35)',
        }}
      />
    </span>
  )
}

/** Sluit een dialog op Escape. Capture-fase + stopPropagation, zodat de
 * globale navigatie-handlers (goBack) stil blijven zolang de dialog open is.
 * Staat de focus in een invoerveld, dan verlaat de éérste Escape alleen het
 * veld (blur) — zo gooit een reflex-Escape nooit stil een half ingevuld
 * formulier weg; de tweede Escape sluit de dialog. Met `blurFirst: false`
 * sluit Escape ook vanuit een invoerveld direct (voor transient panels zoals
 * zoeken, waar niets verloren kan gaan). */
function useEscape(onClose: () => void, opts: { blurFirst?: boolean } = {}): void {
  const { blurFirst = true } = opts
  const ref = useRef(onClose)
  ref.current = onClose
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      const el = document.activeElement
      if (blurFirst && el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
        ;(el as HTMLElement).blur()
        return
      }
      ref.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}

/** Gestylede bevestigings-dialoog voor destructieve acties (vervangt het
 * stijlbrekende native window.confirm). Enter = bevestigen, Escape = annuleren. */
function ConfirmDialog({
  message,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  message: string
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
}) {
  const u = ui()
  useEscape(onCancel)
  const confirmRef = useRef(onConfirm)
  confirmRef.current = onConfirm
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Enter') return
      // Auto-repeat (Enter ingedrukt houden op de trigger-knop) mag nooit
      // meteen bevestigen, en een gefocuste knop (bijv. "Annuleren" na Tab)
      // handelt Enter zelf af via zijn eigen click.
      if (e.repeat) return
      const t = e.target as HTMLElement | null
      if (t?.tagName === 'BUTTON') return
      e.stopPropagation()
      confirmRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  return (
    <AnimatedModal
      onBackdrop={onCancel}
      zIndex={1200}
      panelStyle={{ width: 380, maxWidth: '92%', background: u.card, color: u.text, borderRadius: 12, padding: 20 }}
    >
      <div style={{ fontSize: 15, lineHeight: 1.5 }}>{message}</div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18 }}>
        <button onClick={onCancel} style={ghostBtn(u)}>
          Annuleren
        </button>
        <button onClick={onConfirm} style={{ ...primaryBtn(u), background: u.danger }}>
          {confirmLabel}
        </button>
      </div>
    </AnimatedModal>
  )
}

/** Thema-kiezer voor één niveau (jaar of event). Keuzes worden direct
 * toegepast — de tijdlijn erachter herbouwt op zijn plek (live preview);
 * "Geërfd" wist de keuze van dit niveau weer (het veld verdwijnt dan uit de
 * frontmatter). Bij een event zijn er extra accent-/titelfont-overrides. */
function ThemePanel({
  scope,
  title,
  inheritedName,
  inheritedTheme,
  value,
  onChange,
  onClose,
}: {
  scope: 'year' | 'event'
  title: string
  inheritedName: string
  inheritedTheme: ResolvedTheme
  value: ThemeChoiceLike | null
  onChange: (c: ThemeChoiceLike | null) => void
  onClose: () => void
}) {
  const u = ui()
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const norm = (c: ThemeChoiceLike): ThemeChoiceLike | null =>
    c.id || c.accent || c.background || c.titleFont ? c : null
  const patch = (p: Partial<ThemeChoiceLike>): void => {
    const next: ThemeChoiceLike = { ...value, ...p }
    for (const k of Object.keys(next) as (keyof ThemeChoiceLike)[]) {
      if (next[k] === undefined) delete next[k]
    }
    onChange(norm(next))
  }
  // "Fijn afstellen" staat standaard open zodra er al iets is fijngesteld, zodat
  // bestaande aanpassingen meteen zichtbaar zijn; anders ingeklapt.
  // Standaard uitgeklapt: alle opties (accent/lettertype/achtergrond) meteen zichtbaar.
  const [tweakOpen, setTweakOpen] = useState<boolean>(true)
  const serif = 'Georgia, "Times New Roman", serif'
  const sectionLabel = (mt: number): React.CSSProperties => ({
    fontSize: 11,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
    color: u.textMuted,
    margin: `${mt}px 0 10px`,
  })
  const preview = (t: ResolvedTheme): React.ReactElement => (
    <div
      style={{
        height: 54,
        borderRadius: 9,
        background: hexColor(t.colors.appBg),
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
      }}
    >
      <span
        style={{
          width: 20,
          height: 14,
          borderRadius: 3,
          background: hexColor(t.colors.surface),
          border: `1px solid ${hexColor(t.colors.surfaceStroke)}`,
        }}
      />
      <span style={{ width: 12, height: 12, borderRadius: 6, background: hexColor(t.colors.accent) }} />
      <span style={{ width: 20, height: 14, borderRadius: 3, background: hexColor(t.colors.frame) }} />
    </div>
  )
  const tileBtn = (selected: boolean): React.CSSProperties => ({
    padding: 8,
    borderRadius: 13,
    cursor: 'pointer',
    textAlign: 'left',
    background: selected ? u.primaryFaintBg : u.cardAlt,
    border: `1px solid ${selected ? u.primary : u.border}`,
    boxShadow: selected ? `0 0 0 3px ${u.primaryFaintBg}` : 'none',
    transition: 'border 120ms, box-shadow 120ms, background 120ms',
  })
  const tileLabelRow: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    marginTop: 8,
    padding: '0 2px',
  }
  const geerfdBadge: React.CSSProperties = {
    fontSize: 9,
    letterSpacing: 0.6,
    fontWeight: 700,
    textTransform: 'uppercase',
    color: u.primarySoft,
    background: u.primaryFaintBg,
    border: `1px solid ${u.primarySoft}`,
    padding: '2px 6px',
    borderRadius: 6,
    flex: '0 0 auto',
  }
  const nameLabel = (t: ResolvedTheme): React.CSSProperties => ({
    fontSize: 12.5,
    fontFamily: t.fonts.title,
    color: u.text,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  })
  const swatch = (selected: boolean, c?: string): React.CSSProperties => ({
    width: 30,
    height: 30,
    borderRadius: 15,
    flex: '0 0 auto',
    cursor: 'pointer',
    background: c ?? 'transparent',
    border: c ? `1px solid ${u.border}` : `1px dashed ${u.textMuted}`,
    boxShadow: selected ? `0 0 0 2px ${u.card}, 0 0 0 4px ${u.primary}` : 'none',
  })
  const pill = (selected: boolean): React.CSSProperties => ({
    padding: '9px 15px',
    borderRadius: 11,
    cursor: 'pointer',
    fontSize: 14,
    background: selected ? u.primaryFaintBg : u.cardAlt,
    color: u.text,
    border: `1px solid ${selected ? u.primary : u.border}`,
  })
  return (
    <AnimatedModal
      onBackdrop={onClose}
      backdrop={u.backdropSoft}
      zIndex={1200}
      panelStyle={{
        width: 600,
        maxWidth: '94%',
        maxHeight: '86vh',
        overflowY: 'auto',
        background: u.card,
        color: u.text,
        borderRadius: 22,
        padding: '26px 28px',
        border: `1px solid ${u.border}`,
        boxShadow: '0 30px 80px rgba(0,0,0,0.55)',
      }}
    >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
          <div>
            <div style={{ fontFamily: serif, fontStyle: 'italic', fontSize: 24, color: u.text }}>Thema</div>
            <div style={{ fontSize: 12.5, color: u.textMuted, marginTop: 2 }}>
              Kies een look voor {title}
              {scope === 'event' ? ' — fijn afstellen kan onderaan.' : '.'}
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Sluiten"
            title="Sluiten"
            style={{
              width: 34,
              height: 34,
              borderRadius: 17,
              flex: '0 0 auto',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: u.cardAlt,
              border: `1px solid ${u.border}`,
              color: u.textMuted,
              cursor: 'pointer',
              fontSize: 15,
            }}
          >
            ✕
          </button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
          <button
            onClick={() => patch({ id: undefined })}
            title={`Geërfd: ${inheritedName} — gebruik het thema van het niveau erboven`}
            style={tileBtn(!value?.id)}
          >
            {preview(inheritedTheme)}
            <div style={tileLabelRow}>
              <span style={geerfdBadge}>Geërfd</span>
              <span style={nameLabel(inheritedTheme)}>{inheritedName}</span>
            </div>
          </button>
          {THEMES.map((t) => (
            <button key={t.id} onClick={() => patch({ id: t.id })} title={t.name} style={tileBtn(value?.id === t.id)}>
              {preview(t)}
              <div style={tileLabelRow}>
                <span style={nameLabel(t)}>{t.name}</span>
              </div>
            </button>
          ))}
        </div>
        {scope === 'event' && (
          <>
            <button
              onClick={() => setTweakOpen((o) => !o)}
              aria-expanded={tweakOpen}
              aria-controls="thema-fijn-afstellen"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                background: 'transparent',
                border: 'none',
                color: u.primarySoft,
                fontSize: 13,
                cursor: 'pointer',
                padding: 0,
                margin: '18px 0 0',
              }}
            >
              <span style={{ display: 'inline-flex', transition: 'transform 160ms', transform: tweakOpen ? 'rotate(90deg)' : 'none' }}>
                ▸
              </span>
              Fijn afstellen — accent, lettertype & achtergrond
            </button>
            {tweakOpen && (
              <div id="thema-fijn-afstellen" style={{ marginTop: 14 }}>
                <div style={sectionLabel(0)}>Accentkleur</div>
                <div style={{ fontSize: 12, color: u.textMuted, margin: '-4px 0 10px', lineHeight: 1.4 }}>
                  De kleur van de markering van deze memory op de jaar-tijdlijn — of dat nu een balk
                  (meerdaagse memory), een ring-stip of een gewone stip is.
                </div>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                  <button onClick={() => patch({ accent: undefined })} title="Geërfd" style={swatch(!value?.accent)} />
                  {ACCENT_SWATCHES.map((c) => (
                    <button key={c} onClick={() => patch({ accent: c })} title={c} style={swatch(value?.accent === c, c)} />
                  ))}
                </div>
                <div style={sectionLabel(18)}>Titel-lettertype</div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button onClick={() => patch({ titleFont: undefined })} style={pill(!value?.titleFont)}>
                    Geërfd
                  </button>
                  {TITLE_FONTS.map((f) => (
                    <button
                      key={f.id}
                      onClick={() => patch({ titleFont: f.id })}
                      style={{ ...pill(value?.titleFont === f.id), fontFamily: f.stack }}
                    >
                      {f.name}
                    </button>
                  ))}
                </div>
                <div style={sectionLabel(18)}>Achtergrond</div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button onClick={() => patch({ background: undefined })} style={pill(!value?.background)}>
                    Geërfd
                  </button>
                  <button
                    onClick={() => patch({ background: BACKGROUND_NONE })}
                    style={pill(value?.background === BACKGROUND_NONE)}
                    title="Effen kleur, ook als het thema een textuur heeft"
                  >
                    Effen
                  </button>
                  {BACKGROUNDS.map((b) => (
                    <button key={b.id} onClick={() => patch({ background: b.id })} style={pill(value?.background === b.id)}>
                      {b.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginTop: 22,
            paddingTop: 16,
            borderTop: `1px solid ${u.border}`,
          }}
        >
          <button
            onClick={() => onChange(null)}
            style={{
              padding: '10px 18px',
              borderRadius: 12,
              border: `1px solid ${u.border}`,
              background: 'transparent',
              color: u.textSoft,
              fontSize: 14,
              cursor: 'pointer',
            }}
          >
            Herstel naar geërfd
          </button>
          <button
            onClick={onClose}
            style={{
              padding: '10px 26px',
              borderRadius: 12,
              border: 'none',
              background: u.primary,
              color: u.primaryText,
              fontSize: 15,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Klaar
          </button>
        </div>
    </AnimatedModal>
  )
}

/** Zet de DOM-achtergrond (html/body/#root) op de thema-achtergrondkleur, zodat
 * de hardcoded donkere `#0a0a0f` uit index.html niet doorschemert/flitst bij
 * resize of opstart onder lichte thema's. */
function applyDomBackground(): void {
  const bg = hexColor(THEME.colors.appBg)
  document.documentElement.style.background = bg
  document.body.style.background = bg
  const root = document.getElementById('root')
  if (root) root.style.background = bg
}

/** Debug (F9): klein fps-tellertje dat de Pixi-ticker van de actieve engine
 * uitleest — voor in-app perf-metingen op de echte scenes (de `?perf`-harness
 * rendert een synthetische scene en meet scene-wijzigingen dus niet). */
function FpsOverlay({ engineRef }: { engineRef: { current: RenderEngine | null } }) {
  const [fps, setFps] = useState(0)
  useEffect(() => {
    const t = window.setInterval(() => {
      setFps(Math.round(engineRef.current?.app.ticker.FPS ?? 0))
    }, 500)
    return () => window.clearInterval(t)
  }, [engineRef])
  return (
    <div
      style={{
        // Linksboven onder de terugknop — linksonder botste met de Zoom-pill.
        position: 'fixed',
        left: 16,
        top: 64,
        zIndex: 90,
        padding: '3px 8px',
        borderRadius: 6,
        background: 'rgba(0, 0, 0, 0.55)',
        color: '#9ae6a0',
        fontSize: 12,
        fontFamily: 'ui-monospace, monospace',
        pointerEvents: 'none',
      }}
    >
      {fps} fps
    </div>
  )
}

/** Overzicht na een index-actie die je mappenstructuur eenmalig doorliep en
 * ontbrekende `_year.md`/`_event.md` aanmaakte (of problemen tegenkwam). */
function MaterializationOverlay({
  report,
  onClose,
}: {
  report: MaterializationReport
  onClose: () => void
}) {
  // Escape sluit het overzicht (de globale nav-handler is uit zolang dit open staat).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const created = report.yearsCreated + report.eventsCreated
  const u = ui()
  return (
    <div style={overlayBackdrop(u)} onClick={onClose}>
      <div style={overlayCard(u)} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 10 }}>Je vault is doorlopen</div>
        <div style={{ fontSize: 14, color: u.textSoft, lineHeight: 1.6 }}>
          {created > 0 ? (
            <>
              De app heeft je mappenstructuur doorlopen en de ontbrekende metadata-bestanden
              aangemaakt, zodat elke map "van MemoryLane" is:
              <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>
                {report.yearsCreated > 0 && (
                  <li>
                    {report.yearsCreated}× <code>_year.md</code> (jaar)
                  </li>
                )}
                {report.eventsCreated > 0 && (
                  <li>
                    {report.eventsCreated}× <code>_event.md</code> (memory)
                  </li>
                )}
              </ul>
            </>
          ) : (
            <>De app heeft je mappenstructuur doorlopen. Er waren geen nieuwe bestanden nodig.</>
          )}
        </div>

        {report.loosePhotoFolders.length > 0 && (
          <div style={{ marginTop: 14, fontSize: 13.5, color: u.textSoft, lineHeight: 1.6 }}>
            <b>Losse foto's gevonden</b> (foto's direct in een jaarmap, nog niet in een memory).
            Ze zijn zichtbaar als een "Losse foto's"-bundel; maak er een memory van om ze te ordenen:
            <ul style={{ margin: '6px 0 0', paddingLeft: 20 }}>
              {report.loosePhotoFolders.slice(0, 12).map((f) => (
                <li key={f.folder}>
                  <code>{f.folder}</code> — {f.count} foto{f.count === 1 ? '' : "'s"}
                </li>
              ))}
              {report.loosePhotoFolders.length > 12 && (
                <li>…en nog {report.loosePhotoFolders.length - 12} map(pen)</li>
              )}
            </ul>
          </div>
        )}

        {report.errors.length > 0 && (
          <div style={{ marginTop: 14, fontSize: 13.5, color: u.errorListText, lineHeight: 1.6 }}>
            <b>Kon deze mappen niet bijwerken</b> (bijvoorbeeld alleen-lezen):
            <ul style={{ margin: '6px 0 0', paddingLeft: 20 }}>
              {report.errors.slice(0, 12).map((e, i) => (
                <li key={i}>
                  <code>{e.folder || '(vault-root)'}</code> — {e.reason}
                </li>
              ))}
              {report.errors.length > 12 && <li>…en nog {report.errors.length - 12}</li>}
            </ul>
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 18 }}>
          <button onClick={onClose} style={{ ...fabBtn(u), background: u.primary }}>
            Begrepen
          </button>
        </div>
      </div>
    </div>
  )
}

const overlayBackdrop = (u: UiPalette): React.CSSProperties => ({
  position: 'absolute',
  inset: 0,
  background: u.backdropHeavy,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1200,
})

const overlayCard = (u: UiPalette): React.CSSProperties => ({
  width: 560,
  maxWidth: '92%',
  maxHeight: '84vh',
  overflowY: 'auto',
  background: u.card,
  border: `1px solid ${u.border}`,
  borderRadius: 12,
  padding: '20px 22px',
  color: u.text,
  boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
})

/** Titel bovenin die bij een niveau-wissel zoomt + crossfadet, in dezelfde richting
 * als de scene-transitie: 'in' (dieper) = de nieuwe titel groeit uit het klein en de
 * oude zwelt weg; 'out' (terug) = de nieuwe komt uit het groot en de oude krimpt weg. */
// De titel zweeft over het CANVAS (niet over een paneel): zijn kleur volgt
// daarom de uiMode van het thema van het huidige niveau (`mode`) — een donker
// Kodachrome-jaar in een lichte app krijgt zo gewoon een lichte titel.
function TitleBar({ text, dir, mode }: { text: string; dir: 'in' | 'out'; mode: 'dark' | 'light' }) {
  const base = ui()
  const scene = mode === 'light' ? UI_LIGHT : UI_DARK
  const u = { ...base, canvasTitleText: scene.canvasTitleText, canvasTitleShadow: scene.canvasTitleShadow }
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
              ...titleStyle(u),
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

const titleStyle = (u: UiPalette): React.CSSProperties => ({
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
  color: u.canvasTitleText,
  textShadow: u.canvasTitleShadow,
  pointerEvents: 'none',
  zIndex: 5,
})

const toastStyle = (u: UiPalette): React.CSSProperties => ({
  position: 'absolute',
  // Boven de gecentreerde bediening-dock (die onderaan-midden staat), zodat de
  // toast er niet overheen valt.
  bottom: 150,
  left: '50%',
  transform: 'translateX(-50%)',
  padding: '10px 18px',
  borderRadius: 12,
  background: u.toastBg,
  border: `1px solid ${u.border}`,
  color: u.toastText,
  font: '13px sans-serif',
  boxShadow: '0 6px 20px rgba(0,0,0,0.5)',
  zIndex: 1100,
  pointerEvents: 'none',
})

/** Balk bovenin tijdens de "kies de omslagfoto"-modus. Bewust bovenaan (de dock
 * staat onderin) en in het goud van de omslag-rand, zodat balk en rand één verhaal
 * vertellen. */
/** Zwevend hint-balkje onder de memory-titel. Half doorzichtig met een blur, en
 * het faadt in -- het moet aanvoelen als een tooltip die verschijnt, niet als een
 * dialoog die je pad blokkeert. `pointerEvents: none`, dus je kunt er dwars
 * doorheen klikken op de foto die je wilt kiezen. */
function HintBar({
  tone,
  icon,
  children,
}: {
  tone: 'cover' | 'year'
  icon: React.ReactNode
  children: React.ReactNode
}) {
  const gold = tone === 'cover'
  return (
    <div style={hintRowStyle}>
    <m.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.16, ease: 'easeOut' }}
      style={{
        ...coverBannerStyle,
        background: gold ? 'rgba(28,22,10,0.72)' : 'rgba(12,20,32,0.72)',
        border: `1px solid ${gold ? 'rgba(255,194,75,0.45)' : 'rgba(75,155,255,0.45)'}`,
        color: gold ? '#ffe6b0' : '#cfe2ff',
        backdropFilter: 'blur(14px)',
        WebkitBackdropFilter: 'blur(14px)',
      }}
    >
      {icon}
      {children}
    </m.div>
    </div>
  )
}

/** Centrerende laag onder de memory-titel. Nodig omdat de balk zelf een
 * motion-element is: die schrijft `transform` vol met zijn eigen animatie en zou
 * een `translateX(-50%)` overschrijven -- de balk stond dan rechts van het midden. */
const hintRowStyle: React.CSSProperties = {
  position: 'absolute',
  // Onder de memory-titel (die staat op top 18 en is even breed gecentreerd).
  top: 72,
  left: 0,
  right: 0,
  display: 'flex',
  justifyContent: 'center',
  zIndex: 1100,
  pointerEvents: 'none',
}

const coverBannerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '9px 16px',
  borderRadius: 999,
  background: 'rgba(24,20,10,0.92)',
  border: '1px solid rgba(255,194,75,0.55)',
  color: '#ffe6b0',
  font: '13px sans-serif',
  boxShadow: '0 6px 24px rgba(0,0,0,0.55)',
  maxWidth: '92vw',
  flexWrap: 'wrap',
  justifyContent: 'center',
}

/** Filterbalk onderin de jaar-tijdlijn, boven de bediening-dock. */
const tagBarStyle = (u: UiPalette): React.CSSProperties => ({
  position: 'absolute',
  // Boven de bediening-dock (bottom 24) en onder de toast (bottom 150). Bij heel veel
  // tags scrollt de balk intern i.p.v. door te groeien over de toast heen.
  bottom: 92,
  maxHeight: 58,
  overflowY: 'auto',
  left: '50%',
  transform: 'translateX(-50%)',
  display: 'flex',
  flexWrap: 'wrap',
  justifyContent: 'center',
  gap: 6,
  maxWidth: '80vw',
  padding: '8px 12px',
  borderRadius: 16,
  background: u.toastBg,
  border: `1px solid ${u.border}`,
  zIndex: 60,
})

const gearBtn = (u: UiPalette): React.CSSProperties => ({
  position: 'absolute',
  top: 16,
  right: 16,
  width: 38,
  height: 38,
  borderRadius: 19,
  border: `1px solid ${u.floatBtnBorder}`,
  background: u.floatBtnBg,
  color: u.floatBtnSoftText,
  fontSize: 18,
  lineHeight: '1',
  cursor: 'pointer',
})

const backBtn = (u: UiPalette): React.CSSProperties => ({
  position: 'absolute',
  top: 16,
  left: 16,
  width: 38,
  height: 38,
  borderRadius: 19,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  // Rust: vage cirkel, nauwelijks aanwezig. Hover licht 'm op (zie backBtnHover).
  border: `1px solid ${u.backRestBorder}`,
  background: u.backRestBg,
  padding: 0,
  cursor: 'pointer',
  transition: 'background 140ms ease, border-color 140ms ease',
})

const backBtnHover = (u: UiPalette): React.CSSProperties => ({
  border: `1px solid ${u.floatBtnBorder}`,
  background: u.floatBtnBg,
})

const fabBtn = (u: UiPalette): React.CSSProperties => ({
  padding: '10px 16px',
  borderRadius: 24,
  border: 'none',
  background: u.primary,
  color: u.primaryText,
  font: '14px sans-serif',
  cursor: 'pointer',
  boxShadow: '0 4px 14px rgba(0,0,0,0.4)',
})

const field = (u: UiPalette): React.CSSProperties => ({
  width: '100%',
  boxSizing: 'border-box',
  padding: '10px 12px',
  borderRadius: 8,
  border: `1px solid ${u.inputBorder}`,
  background: u.inputBg,
  color: u.text,
  font: '15px sans-serif',
})

const dateLabel = (u: UiPalette): React.CSSProperties => ({
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  fontSize: 13,
  color: u.textMuted,
})

const metaLabel = (u: UiPalette): React.CSSProperties => ({
  display: 'flex',
  flexDirection: 'column',
  fontSize: 13,
  color: u.textMuted,
})

const ghostBtn = (u: UiPalette): React.CSSProperties => ({
  padding: '8px 16px',
  borderRadius: 8,
  border: `1px solid ${u.btnBorder}`,
  background: 'transparent',
  color: u.textSoft,
  cursor: 'pointer',
})

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
  const u = ui()
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
    // Expliciet (i.p.v. de witte body-default uit index.html), zodat de koppen
    // ook onder lichte thema's leesbaar zijn. Dark = ongewijzigd wit.
    color: u.text,
  }
  if (phase === 'loading') {
    return (
      <div style={box}>
        <div style={{ color: u.textMuted, font: '14px sans-serif' }}>Laden…</div>
      </div>
    )
  }
  if (phase === 'first-run') {
    return (
      <div style={box}>
        <div style={{ fontSize: 28, fontWeight: 700 }}>MemoryLane</div>
        <div style={{ color: u.textMuted, maxWidth: 420, font: '14px sans-serif' }}>
          Kies de map met je herinneringen. Je mappen op schijf blijven altijd de bron —
          MemoryLane bouwt er alleen een tijdlijn omheen.
        </div>
        <button onClick={onPick} style={primaryBtn(u)}>
          Kies je MemoryLane-map
        </button>
      </div>
    )
  }
  if (phase === 'empty') {
    return (
      <div style={box}>
        <div style={{ fontSize: 22, fontWeight: 700 }}>Nog leeg</div>
        <div style={{ color: u.textMuted, maxWidth: 420, font: '14px sans-serif' }}>
          Deze map is nog leeg. Maak je eerste memory — het bijbehorende jaar wordt
          automatisch aangemaakt.
        </div>
        <button onClick={onCreateFirst} style={primaryBtn(u)}>
          + Maak je eerste memory
        </button>
      </div>
    )
  }
  return (
    <div style={box}>
      <div style={{ fontSize: 20, fontWeight: 700, color: u.errorTitle }}>Er ging iets mis</div>
      <div style={{ color: u.textMuted, font: '13px monospace', maxWidth: 520 }}>{message}</div>
    </div>
  )
}

const primaryBtn = (u: UiPalette): React.CSSProperties => ({
  padding: '10px 20px',
  borderRadius: 8,
  border: 'none',
  background: u.primary,
  color: u.primaryText,
  font: '15px sans-serif',
  cursor: 'pointer',
})

const tagInput = (u: UiPalette): React.CSSProperties => ({
  width: '100%',
  boxSizing: 'border-box',
  padding: '8px 10px',
  borderRadius: 8,
  border: `1px solid ${u.inputBorder}`,
  background: u.inputBgSoft,
  color: u.textBright,
  font: '13px sans-serif',
})
