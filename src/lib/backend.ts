// Backend-abstractie tussen de UI en de Rust-index. In Tauri gaat alles via
// typed `invoke`-commands en worden thumbnails via het `thumb://`-protocol
// geserveerd. In de browser (dev) valt het terug op een mock met synthetische
// data en procedurele thumbnails, zodat de scenes zonder Tauri te verifiëren zijn.

import type { ItemType } from '../render/scenes/types'

export interface YearSummary {
  id: string
  year: number
  title: string
  startAt: string
  endAt?: string
  eventCount: number
  itemCount: number
  coverItemId?: string
  /** Foto-id's van dit jaar (voor de willekeurige jaar-tegel-slideshow). */
  photoIds: string[]
  /** Uitgelichte foto-id's van dit jaar (voor de 'uitgelicht'-slideshow). */
  featuredIds: string[]
  /** Vaste jaar-cover (item-id) indien geprikt — tegel is dan statisch. */
  pinnedCover?: string
}

export interface EventSummary {
  id: string
  kind: 'event' | 'period'
  title?: string
  startAt: string
  endAt?: string
  itemCount: number
  coverItemId?: string
  /** Foto-id's van dit event (voor de slideshow-roulatie op de tijdlijn). */
  photoIds: string[]
  /** Belang/grootte op de jaar-tijdlijn (1–100). Afwezig = standaard (50). */
  size?: number
}

export interface Year {
  id: string
  year: number
  title: string
  startAt: string
  endAt?: string
  folderName: string
  /** Globale schaalfactor voor álle event-kaarten van dit jaar (proportioneel
   * "passend maken"). Afwezig = 1.0 (geen schaling). */
  sizeFactor?: number
}

export interface YearDetail {
  year: Year
  events: EventSummary[]
}

export interface DensityPoint {
  timestampMs: number
  itemType: ItemType
  itemId: string
  eventId: string
  eventTitle?: string
}

export interface YearPhoto {
  itemId: string
  itemType: ItemType
  eventId: string
}

export interface Item {
  id: string
  eventId: string
  itemType: ItemType
  media?: string
  url?: string
  caption?: string
  bodyText?: string
  slug?: string
  /** Tijdstip (ms) voor chronologische sortering (grid-layout). */
  timestampMs?: number
}

export interface CanvasItem {
  eventId: string
  itemRef: string
  x: number
  y: number
  scale: number
  rotation: number
  zIndex: number
  textScale?: number
  width?: number
  height?: number
}

export interface EventInfo {
  id: string
  kind: 'event' | 'period'
  title?: string
  startAt: string
  endAt?: string
  folderPath: string
  /** Id van het jaar waaronder dit event valt. */
  yearId: string
  /** Slug of id van de uitgelichte foto (jaar-omslag), indien gekozen. */
  featuredPhoto?: string
}

export interface EventDetail {
  event: EventInfo
  items: Item[]
  canvas: CanvasItem[]
  /** Vaste jaar-cover (item-id) van dit jaar, of undefined — voor de 2e ring op L2. */
  yearCover?: string
}

export interface ExifEntry {
  label: string
  value: string
}

export interface ItemMetadata {
  caption: string
  date: string
  place: string
  people: string[]
  tags: string[]
  /** Read-only ingebedde EXIF-velden (label + waarde). */
  exif: ExifEntry[]
}

/** Layout-input voor het opslaan van een canvas (naar `save_canvas_layout`). */
export interface CanvasLayoutInput {
  itemRef: string
  x: number
  y: number
  scale: number
  rotation: number
  zIndex: number
  textScale?: number
  width?: number
  height?: number
}

export interface IndexSummary {
  yearCount: number
  eventCount: number
  itemCount: number
  errorCount: number
}

export interface SearchResult {
  itemId: string
  eventId: string
  yearId: string
  eventTitle?: string
  snippet: string
}

/** Een thumbnail-bron voor de texture-pipeline: een echte URL of een hue. */
export interface ThumbSource {
  url?: string
  hue?: number
}

export interface Backend {
  readonly isMock: boolean
  getVaultPath(): Promise<string | null>
  pickAndSetVault(): Promise<IndexSummary | null>
  /** Herbouwt de index volledig uit de huidige vault (scan + herindexeren). */
  reindex(): Promise<IndexSummary>
  listYears(): Promise<YearSummary[]>
  getYear(yearId: string): Promise<YearDetail | null>
  getTimelineDensity(yearId: string): Promise<DensityPoint[]>
  getYearPhotos(yearId: string): Promise<YearPhoto[]>
  getEvent(eventId: string): Promise<EventDetail | null>
  saveCanvasLayout(eventId: string, items: CanvasLayoutInput[]): Promise<void>
  createTextItem(eventId: string, caption: string | null, body: string): Promise<string>
  /** Zet (of wist bij `null`) de uitgelichte foto van een event (jaar-omslag). */
  setFeatured(eventId: string, itemRef: string | null): Promise<void>
  /** Zet (of wist bij `null`) de vaste jaar-cover (item-id) van een jaar. */
  setYearCover(yearId: string, itemRef: string | null): Promise<void>
  /** Zet (of wist bij `null`/≈1.0) de globale event-kaartschaal van een jaar. */
  setYearSizeFactor(yearId: string, factor: number | null): Promise<void>
  /** Zet (of wist bij `null`) het belang/grootte (1–100) van een event. */
  setEventSize(eventId: string, size: number | null): Promise<void>
  createEvent(
    yearId: string,
    title: string,
    startAt: string,
    endAt: string | null,
    size?: number | null,
  ): Promise<string>
  /** Maakt een memory in het jaar dat bij `startAt` hoort en maakt die jaarmap zo
   * nodig aan — het pad voor de allereerste memory in een lege vault. */
  createEventAtDate(
    title: string,
    startAt: string,
    endAt: string | null,
    size?: number | null,
  ): Promise<string>
  /** Werkt titel/begin-/einddatum van een event bij. `endAt = null` verwijdert
   * de einddatum. */
  updateEvent(eventId: string, title: string, startAt: string, endAt: string | null): Promise<void>
  /** Opent een bestandskiezer en importeert de gekozen foto's; geeft het aantal. */
  importPhotos(eventId: string): Promise<number>
  deleteItem(itemId: string): Promise<void>
  /** Werkt caption en/of body van een item bij. `null` = veld ongemoeid laten;
   * lege caption-string verwijdert de caption. */
  updateItem(itemId: string, caption: string | null, body: string | null): Promise<void>
  /** Leest de bewerkbare sidecar-metadata van een item (voor het bewerk-paneel). */
  getItemMetadata(itemId: string): Promise<ItemMetadata>
  /** Schrijft de bewerkbare metadata naar de sidecar (lege waarden = wissen). */
  updateItemMetadata(
    itemId: string,
    caption: string,
    date: string,
    place: string,
    people: string[],
    tags: string[],
  ): Promise<void>
  search(query: string): Promise<SearchResult[]>
  /** Foto-item-ids voor de screensaver. `scopeKind`: 'all' | 'year' | 'event'
   * (met bijbehorend `scopeId`); `include` = minstens één van die tags, `exclude`
   * = geen van die tags (lege arrays = geen filter). */
  getScreensaverPhotos(
    scopeKind: 'all' | 'year' | 'event',
    scopeId: string | null,
    include: string[],
    exclude: string[],
  ): Promise<string[]>
  thumb(itemId: string, size: 64 | 128 | 256 | 1024 | 2048): ThumbSource
}

// ---- Tauri-detectie ------------------------------------------------------

function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** Bepaalt de thumb://-URL; WebView2 (Windows) mapt custom schemes op http. */
function thumbUrl(itemId: string, size: number): string {
  const isWindows =
    typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent)
  const id = encodeURIComponent(itemId)
  return isWindows
    ? `http://thumb.localhost/${id}?size=${size}`
    : `thumb://localhost/${id}?size=${size}`
}

// ---- Tauri-backend -------------------------------------------------------

class TauriBackend implements Backend {
  readonly isMock = false
  private invoke!: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>

  private async api(): Promise<
    <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>
  > {
    if (!this.invoke) {
      const core = await import('@tauri-apps/api/core')
      this.invoke = core.invoke as typeof this.invoke
    }
    return this.invoke
  }

  async getVaultPath(): Promise<string | null> {
    const invoke = await this.api()
    return await invoke<string | null>('get_vault_path')
  }

  async pickAndSetVault(): Promise<IndexSummary | null> {
    const dialog = await import('@tauri-apps/plugin-dialog')
    const picked = await dialog.open({ directory: true, multiple: false })
    if (typeof picked !== 'string') return null
    const invoke = await this.api()
    return await invoke<IndexSummary>('set_vault_path', { path: picked })
  }

  async reindex(): Promise<IndexSummary> {
    const invoke = await this.api()
    return await invoke<IndexSummary>('reindex')
  }

  async listYears(): Promise<YearSummary[]> {
    const invoke = await this.api()
    return await invoke<YearSummary[]>('list_years')
  }

  async getYear(yearId: string): Promise<YearDetail | null> {
    const invoke = await this.api()
    return await invoke<YearDetail | null>('get_year', { yearId })
  }

  async getTimelineDensity(yearId: string): Promise<DensityPoint[]> {
    const invoke = await this.api()
    return await invoke<DensityPoint[]>('get_timeline_density', { yearId })
  }

  async getYearPhotos(yearId: string): Promise<YearPhoto[]> {
    const invoke = await this.api()
    return await invoke<YearPhoto[]>('get_year_photos', { yearId })
  }

  async getScreensaverPhotos(
    scopeKind: 'all' | 'year' | 'event',
    scopeId: string | null,
    include: string[],
    exclude: string[],
  ): Promise<string[]> {
    const invoke = await this.api()
    return await invoke<string[]>('get_screensaver_photos', {
      scopeKind,
      scopeId,
      include,
      exclude,
    })
  }

  async getEvent(eventId: string): Promise<EventDetail | null> {
    const invoke = await this.api()
    return await invoke<EventDetail | null>('get_event', { eventId })
  }

  async saveCanvasLayout(eventId: string, items: CanvasLayoutInput[]): Promise<void> {
    const invoke = await this.api()
    await invoke('save_canvas_layout', { eventId, items })
  }

  async createTextItem(eventId: string, caption: string | null, body: string): Promise<string> {
    const invoke = await this.api()
    return await invoke<string>('create_text_item', { eventId, caption, body })
  }

  async createEvent(
    yearId: string,
    title: string,
    startAt: string,
    endAt: string | null,
    size?: number | null,
  ): Promise<string> {
    const invoke = await this.api()
    return await invoke<string>('create_event', {
      yearId,
      title,
      startAt,
      endAt,
      size: size ?? null,
    })
  }

  async createEventAtDate(
    title: string,
    startAt: string,
    endAt: string | null,
    size?: number | null,
  ): Promise<string> {
    const invoke = await this.api()
    return await invoke<string>('create_event_at_date', {
      title,
      startAt,
      endAt,
      size: size ?? null,
    })
  }

  async updateEvent(
    eventId: string,
    title: string,
    startAt: string,
    endAt: string | null,
  ): Promise<void> {
    const invoke = await this.api()
    await invoke('update_event', { eventId, title, startAt, endAt })
  }

  async setFeatured(eventId: string, itemRef: string | null): Promise<void> {
    const invoke = await this.api()
    await invoke('set_featured', { eventId, itemRef })
  }

  async setYearCover(yearId: string, itemRef: string | null): Promise<void> {
    const invoke = await this.api()
    await invoke('set_year_cover', { yearId, itemRef })
  }

  async setEventSize(eventId: string, size: number | null): Promise<void> {
    const invoke = await this.api()
    await invoke('set_event_size', { eventId, size })
  }

  async setYearSizeFactor(yearId: string, factor: number | null): Promise<void> {
    const invoke = await this.api()
    await invoke('set_year_size_factor', { yearId, factor })
  }

  async importPhotos(eventId: string): Promise<number> {
    const dialog = await import('@tauri-apps/plugin-dialog')
    const picked = await dialog.open({
      multiple: true,
      directory: false,
      filters: [
        {
          name: 'Media',
          extensions: ['jpg', 'jpeg', 'png', 'heic', 'heif', 'gif', 'webp', 'mp4', 'mov'],
        },
      ],
    })
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : []
    if (paths.length === 0) return 0
    const invoke = await this.api()
    return await invoke<number>('import_photos', { eventId, sources: paths })
  }

  async deleteItem(itemId: string): Promise<void> {
    const invoke = await this.api()
    await invoke('delete_item', { itemId })
  }

  async updateItem(itemId: string, caption: string | null, body: string | null): Promise<void> {
    const invoke = await this.api()
    await invoke('update_item', { itemId, caption, body })
  }

  async getItemMetadata(itemId: string): Promise<ItemMetadata> {
    const invoke = await this.api()
    return await invoke<ItemMetadata>('get_item_metadata', { itemId })
  }

  async updateItemMetadata(
    itemId: string,
    caption: string,
    date: string,
    place: string,
    people: string[],
    tags: string[],
  ): Promise<void> {
    const invoke = await this.api()
    await invoke('update_item_metadata', { itemId, caption, date, place, people, tags })
  }

  async search(query: string): Promise<SearchResult[]> {
    const invoke = await this.api()
    return await invoke<SearchResult[]>('search', { query })
  }

  thumb(itemId: string, size: number): ThumbSource {
    return { url: thumbUrl(itemId, size) }
  }
}

export function createBackend(): Backend {
  if (inTauri()) return new TauriBackend()
  // Lazy import om mock-data buiten de Tauri-build te houden.
  return new MockBackend()
}

// ---- Mock-backend (browser dev) ------------------------------------------

function hueFor(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360
  return h
}

class MockBackend implements Backend {
  readonly isMock = true
  private years: YearSummary[]
  private details = new Map<string, YearDetail>()
  private density = new Map<string, DensityPoint[]>()
  private adds = new Map<string, Item[]>()
  private deleted = new Set<string>()
  private edits = new Map<string, { caption: string | null; body: string | null }>()
  private meta = new Map<string, ItemMetadata>()
  private featured = new Map<string, string>() // eventId → item-ref
  private yearCovers = new Map<string, string>() // yearId → item-id (vaste jaar-cover)
  private yearFactors = new Map<string, number>() // yearId → globale event-kaartschaal
  private newEventSeq = 0
  private thumbCache = new Map<string, string>()

  constructor() {
    const specs = [1969, 1971, 2022, 2023, 2024, 2025]
    this.years = specs.map((y, i) => {
      const id = `y${y}`
      const eventCount = 9 + (i % 5) // 9..13 events, verspreid over het jaar
      const itemCount = 6 + i * 9
      const events: EventSummary[] = Array.from({ length: eventCount }, (_, e): EventSummary => {
        // Datums over alle 12 maanden; door meer events dan maanden ontstaat er
        // bewust clustering (naburige events in dezelfde maand) → test callouts.
        const month = 1 + Math.floor((e * 12) / eventCount)
        const day = 3 + ((e * 7) % 25)
        const mm = String(month).padStart(2, '0')
        const dd = String(day).padStart(2, '0')
        // Elk 4e event is meerdaags (period) → test het span-balkje op de as.
        const multi = e % 4 === 1
        const endDd = String(Math.min(28, day + 9)).padStart(2, '0')
        return {
          id: `${id}-e${e}`,
          kind: multi ? 'period' : 'event',
          title: `Memory ${e + 1}`,
          startAt: `${y}-${mm}-${dd}`,
          endAt: multi ? `${y}-${mm}-${endDd}` : undefined,
          itemCount: Math.max(1, Math.floor(itemCount / eventCount)),
          // Af en toe een event zonder cover → test het stip-pad in de tijdlijn.
          coverItemId: e % 7 === 6 ? undefined : `${id}-e${e}-i0`,
          photoIds: [], // door getYear gevuld (mock)
          // Gevarieerde groottes → test de dynamische kaartschaling in het jaar.
          size: e % 5 === 0 ? 75 : e % 5 === 2 ? 30 : undefined,
        }
      })
      const points: DensityPoint[] = []
      for (let k = 0; k < itemCount; k++) {
        const ev = events[k % events.length]
        const month = 1 + (k % 12)
        points.push({
          timestampMs: Date.parse(`${y}-${String(month).padStart(2, '0')}-10T00:00:00Z`),
          itemType: 'photo',
          itemId: `${id}-i${k}`,
          eventId: ev.id,
          eventTitle: ev.title,
        })
      }
      this.details.set(id, { year: { id, year: y, title: String(y), startAt: `${y}-01-01`, folderName: String(y) }, events })
      this.density.set(id, points)
      // Pools voor de jaar-tegel-slideshow: alle foto's, en (mock) elke 2e event
      // als 'uitgelicht'.
      const eventPhotos = (eventId: string): string[] => {
        const nn = 6 + (hueFor(eventId) % 7)
        return Array.from({ length: Math.max(0, nn - 1) }, (_, k) => `${eventId}-i${k + 1}`)
      }
      const photoIds = events.flatMap((ev) => eventPhotos(ev.id)).slice(0, 48)
      const featuredIds = events
        .filter((_, e) => e % 2 === 0)
        .map((ev) => eventPhotos(ev.id)[0])
        .filter((x): x is string => !!x)
      return { id, year: y, title: String(y), startAt: `${y}-01-01`, endAt: `${y}-12-31`, eventCount, itemCount, coverItemId: `${id}-i0`, photoIds, featuredIds }
    })
  }

  async getVaultPath(): Promise<string | null> {
    return 'L:/Jim/MemoryLane (mock)'
  }
  async pickAndSetVault(): Promise<IndexSummary | null> {
    return { yearCount: this.years.length, eventCount: 12, itemCount: 200, errorCount: 0 }
  }
  async reindex(): Promise<IndexSummary> {
    return { yearCount: this.years.length, eventCount: 12, itemCount: 200, errorCount: 0 }
  }
  async listYears(): Promise<YearSummary[]> {
    // pinnedCover dynamisch: kan tijdens de sessie via setYearCover wijzigen.
    return this.years.map((y) => {
      const pin = this.yearCovers.get(y.id)
      return pin ? { ...y, pinnedCover: pin, coverItemId: pin } : { ...y, pinnedCover: undefined }
    })
  }
  async setYearCover(yearId: string, itemRef: string | null): Promise<void> {
    if (itemRef) this.yearCovers.set(yearId, itemRef)
    else this.yearCovers.delete(yearId)
  }
  async setYearSizeFactor(yearId: string, factor: number | null): Promise<void> {
    if (factor == null || Math.abs(factor - 1) <= 0.001) this.yearFactors.delete(yearId)
    else this.yearFactors.set(yearId, Math.max(0.1, Math.min(5, factor)))
  }
  async getYear(yearId: string): Promise<YearDetail | null> {
    const detail = this.details.get(yearId)
    if (!detail) return null
    const sizeFactor = this.yearFactors.get(yearId)
    // Cover per event: featured indien gekozen, anders elke keer een WILLEKEURIGE
    // foto (i=1..n-1; i=0 is de tekstkaart) — demonstreert "elke keer een andere".
    const events = detail.events.map((ev) => {
      const n = 6 + (hueFor(ev.id) % 7)
      // Foto's van dit event (i=1..n-1; i=0 is de tekstkaart) — voor de slideshow.
      const photoIds = Array.from({ length: Math.max(0, n - 1) }, (_, k) => `${ev.id}-i${k + 1}`)
      const feat = this.featured.get(ev.id)
      if (feat) return { ...ev, coverItemId: feat, photoIds }
      const k = 1 + Math.floor(Math.random() * Math.max(1, n - 1))
      return { ...ev, coverItemId: `${ev.id}-i${k}`, photoIds }
    })
    return { year: { ...detail.year, sizeFactor }, events }
  }
  async getTimelineDensity(yearId: string): Promise<DensityPoint[]> {
    return this.density.get(yearId) ?? []
  }
  async getYearPhotos(yearId: string): Promise<YearPhoto[]> {
    return (this.density.get(yearId) ?? []).map((p) => ({
      itemId: p.itemId,
      itemType: 'photo' as const,
      eventId: p.eventId,
    }))
  }
  async getScreensaverPhotos(
    scopeKind: 'all' | 'year' | 'event',
    scopeId: string | null,
    include: string[],
    exclude: string[],
  ): Promise<string[]> {
    // Deterministische synthetische tags per foto, zodat include/exclude testbaar is.
    const photoTags = (photoId: string): string[] => {
      const h = hueFor(photoId)
      const tags: string[] = []
      if (h % 3 === 0) tags.push('vakantie')
      if (h % 3 === 1) tags.push('familie')
      if (h % 5 === 0) tags.push('werk')
      return tags
    }
    const eventPhotos = (eventId: string): string[] => {
      const n = 6 + (hueFor(eventId) % 7)
      return Array.from({ length: Math.max(0, n - 1) }, (_, k) => `${eventId}-i${k + 1}`)
    }
    let ids: string[] = []
    if (scopeKind === 'event' && scopeId) {
      ids = eventPhotos(scopeId)
    } else if (scopeKind === 'year' && scopeId) {
      ids = (this.details.get(scopeId)?.events ?? []).flatMap((ev) => eventPhotos(ev.id))
    } else if (scopeKind === 'all') {
      for (const d of this.details.values()) {
        ids = ids.concat(d.events.flatMap((ev) => eventPhotos(ev.id)))
      }
    }
    if (include.length) ids = ids.filter((id) => photoTags(id).some((t) => include.includes(t)))
    if (exclude.length) ids = ids.filter((id) => !photoTags(id).some((t) => exclude.includes(t)))
    return ids
  }
  async getEvent(eventId: string): Promise<EventDetail | null> {
    const summary = this.findEvent(eventId)
    const n = 6 + (hueFor(eventId) % 7)
    const base: Item[] = Array.from({ length: n }, (_, i) => ({
      id: `${eventId}-i${i}`,
      eventId,
      itemType: i === 0 ? ('text' as const) : ('photo' as const),
      media: i === 0 ? undefined : 'foto.jpg',
      bodyText:
        i === 0
          ? 'Dit is een periode waarin ik ben geboren en waar ik helemaal niks meer van weet. Ik ben in ieder geval geboren in Amsterdam.\n\nEr zijn een paar foto’s ergens van, en daarna gaat het al vrij snel naar de feestdagen: Sinterklaas en kerst.\n\nDe foto’s die je ziet zijn onder andere van mijn vader, mijn moeder, mijn broer Wout, en natuurlijk mijn oma’s, tante Aaf en oma van Loon. Verder weet ik het even niet.'
          : undefined,
      caption: `Foto ${i}`,
      slug: `${eventId}-i${i}`,
      // Deterministische, licht-geschudde tijden zodat de grid-sortering merkbaar is.
      timestampMs: 1_719_792_000_000 + ((i * 7) % 12) * 86_400_000 + i * 3_600_000,
    }))
    const items = [...base, ...(this.adds.get(eventId) ?? [])]
      .filter((it) => !this.deleted.has(it.id))
      .map((it) => {
        const e = this.edits.get(it.id)
        if (!e) return it
        return {
          ...it,
          caption: e.caption !== null ? e.caption || undefined : it.caption,
          bodyText: e.body !== null ? e.body : it.bodyText,
        }
      })
    const yearId = eventId.split('-')[0] ?? ''
    return {
      event: {
        id: eventId,
        kind: summary?.kind ?? 'event',
        title: summary?.title ?? 'Gebeurtenis',
        startAt: summary?.startAt ?? '2024-06-15',
        endAt: summary?.endAt,
        folderPath: 'mock',
        yearId,
        featuredPhoto: this.featured.get(eventId),
      },
      items,
      canvas: [],
      yearCover: this.yearCovers.get(yearId),
    }
  }
  async saveCanvasLayout(): Promise<void> {
    /* mock: geen persistentie */
  }
  async createTextItem(eventId: string, caption: string | null, body: string): Promise<string> {
    const id = `${eventId}-add${(this.adds.get(eventId)?.length ?? 0)}`
    const list = this.adds.get(eventId) ?? []
    list.push({ id, eventId, itemType: 'text', caption: caption ?? undefined, bodyText: body, slug: id })
    this.adds.set(eventId, list)
    return id
  }
  private findEvent(eventId: string): EventSummary | undefined {
    for (const d of this.details.values()) {
      const ev = d.events.find((e) => e.id === eventId)
      if (ev) return ev
    }
    return undefined
  }
  async createEvent(
    yearId: string,
    title: string,
    startAt: string,
    endAt: string | null,
    size?: number | null,
  ): Promise<string> {
    const id = `${yearId}-new${this.newEventSeq++}`
    const detail = this.details.get(yearId)
    if (detail) {
      detail.events.push({
        id,
        kind: endAt ? 'period' : 'event',
        title,
        startAt,
        endAt: endAt ?? undefined,
        itemCount: 0,
        coverItemId: undefined,
        photoIds: [],
        size: size ?? undefined,
      })
    }
    return id
  }

  async createEventAtDate(
    title: string,
    startAt: string,
    endAt: string | null,
    size?: number | null,
  ): Promise<string> {
    const yearNum = Number(startAt.slice(0, 4))
    const yearId = `y${yearNum}`
    // Jaar nog niet bekend? Maak het aan (leeg jaar + tegel), net als de scanner
    // een nieuwe jaarmap zou oppikken.
    if (!this.details.has(yearId)) {
      this.details.set(yearId, {
        year: { id: yearId, year: yearNum, title: String(yearNum), startAt: `${yearNum}-01-01`, folderName: String(yearNum) },
        events: [],
      })
      this.years.push({
        id: yearId,
        year: yearNum,
        title: String(yearNum),
        startAt: `${yearNum}-01-01`,
        endAt: `${yearNum}-12-31`,
        eventCount: 0,
        itemCount: 0,
        coverItemId: undefined,
        photoIds: [],
        featuredIds: [],
      })
      this.years.sort((a, b) => a.year - b.year)
    }
    return this.createEvent(yearId, title, startAt, endAt, size)
  }

  async setEventSize(eventId: string, size: number | null): Promise<void> {
    const ev = this.findEvent(eventId)
    if (ev) ev.size = size == null ? undefined : Math.max(1, Math.min(100, Math.round(size)))
  }
  async updateEvent(
    eventId: string,
    title: string,
    startAt: string,
    endAt: string | null,
  ): Promise<void> {
    const ev = this.findEvent(eventId)
    if (ev) {
      ev.title = title
      ev.startAt = startAt
      ev.endAt = endAt ?? undefined
      ev.kind = endAt ? 'period' : 'event'
    }
  }
  async setFeatured(eventId: string, itemRef: string | null): Promise<void> {
    if (itemRef) this.featured.set(eventId, itemRef)
    else this.featured.delete(eventId)
  }
  async importPhotos(eventId: string): Promise<number> {
    const list = this.adds.get(eventId) ?? []
    const start = list.length
    for (let i = 0; i < 3; i++) {
      const id = `${eventId}-photo${start + i}`
      list.push({ id, eventId, itemType: 'photo', media: 'foto.jpg', caption: `Nieuwe foto ${start + i}`, slug: id })
    }
    this.adds.set(eventId, list)
    return 3
  }
  async deleteItem(itemId: string): Promise<void> {
    this.deleted.add(itemId)
  }
  async updateItem(itemId: string, caption: string | null, body: string | null): Promise<void> {
    const prev = this.edits.get(itemId) ?? { caption: null, body: null }
    this.edits.set(itemId, {
      caption: caption !== null ? caption : prev.caption,
      body: body !== null ? body : prev.body,
    })
  }
  async getItemMetadata(itemId: string): Promise<ItemMetadata> {
    // Nep-EXIF zodat de read-only weergave in de mock te zien is.
    const exif: ExifEntry[] = [
      { label: 'Genomen op', value: '2024-08-15 14:32:07' },
      { label: 'Camera', value: 'Canon EOS R6' },
      { label: 'Diafragma', value: 'f/2.8' },
      { label: 'Sluitertijd', value: '1/250 s' },
      { label: 'ISO', value: '200' },
      { label: 'Afmeting', value: '6000 × 4000' },
    ]
    const m = this.meta.get(itemId)
    if (m) return { ...m, exif }
    return { caption: this.edits.get(itemId)?.caption ?? '', date: '', place: '', people: [], tags: [], exif }
  }
  async updateItemMetadata(
    itemId: string,
    caption: string,
    date: string,
    place: string,
    people: string[],
    tags: string[],
  ): Promise<void> {
    this.meta.set(itemId, { caption, date, place, people, tags, exif: [] })
    // Caption ook in de gedeelde edits zodat de L3-caption/kaart ververst.
    const prev = this.edits.get(itemId) ?? { caption: null, body: null }
    this.edits.set(itemId, { caption, body: prev.body })
  }
  async search(query: string): Promise<SearchResult[]> {
    const q = query.toLowerCase().trim()
    if (!q) return []
    const out: SearchResult[] = []
    for (const [eventId, items] of this.adds) {
      for (const it of items) {
        if (this.deleted.has(it.id)) continue
        const text = (it.bodyText || it.caption || '').toLowerCase()
        if (text.includes(q)) {
          out.push({
            itemId: it.id,
            eventId,
            yearId: eventId.split('-')[0],
            snippet: it.bodyText || it.caption || '',
          })
        }
      }
    }
    return out
  }
  thumb(itemId: string): ThumbSource {
    // Data-URL i.p.v. hue, zodat het echte <img>-loader-pad (dat ook thumb://
    // in Tauri gebruikt) in de browser wordt uitgeoefend.
    let url = this.thumbCache.get(itemId)
    if (!url) {
      const hue = hueFor(itemId)
      const cvs = document.createElement('canvas')
      cvs.width = 128
      cvs.height = 128
      const ctx = cvs.getContext('2d')!
      const g = ctx.createLinearGradient(0, 0, 128, 128)
      g.addColorStop(0, `hsl(${hue}, 65%, 55%)`)
      g.addColorStop(1, `hsl(${(hue + 60) % 360}, 65%, 35%)`)
      ctx.fillStyle = g
      ctx.fillRect(0, 0, 128, 128)
      url = cvs.toDataURL('image/jpeg')
      this.thumbCache.set(itemId, url)
    }
    return { url }
  }
}
