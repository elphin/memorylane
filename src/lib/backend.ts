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
}

export interface EventSummary {
  id: string
  kind: 'event' | 'period'
  title?: string
  startAt: string
  endAt?: string
  itemCount: number
  coverItemId?: string
}

export interface Year {
  id: string
  year: number
  title: string
  startAt: string
  endAt?: string
  folderName: string
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
}

export interface EventDetail {
  event: EventInfo
  items: Item[]
  canvas: CanvasItem[]
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
  listYears(): Promise<YearSummary[]>
  getYear(yearId: string): Promise<YearDetail | null>
  getTimelineDensity(yearId: string): Promise<DensityPoint[]>
  getYearPhotos(yearId: string): Promise<YearPhoto[]>
  getEvent(eventId: string): Promise<EventDetail | null>
  saveCanvasLayout(eventId: string, items: CanvasLayoutInput[]): Promise<void>
  createTextItem(eventId: string, caption: string | null, body: string): Promise<string>
  createEvent(yearId: string, title: string, startAt: string): Promise<string>
  /** Opent een bestandskiezer en importeert de gekozen foto's; geeft het aantal. */
  importPhotos(eventId: string): Promise<number>
  deleteItem(itemId: string): Promise<void>
  search(query: string): Promise<SearchResult[]>
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

  async createEvent(yearId: string, title: string, startAt: string): Promise<string> {
    const invoke = await this.api()
    return await invoke<string>('create_event', { yearId, title, startAt })
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
  private thumbCache = new Map<string, string>()

  constructor() {
    const specs = [1969, 1971, 2022, 2023, 2024, 2025]
    this.years = specs.map((y, i) => {
      const id = `y${y}`
      const eventCount = 1 + (i % 3)
      const itemCount = 6 + i * 9
      const events: EventSummary[] = Array.from({ length: eventCount }, (_, e) => ({
        id: `${id}-e${e}`,
        kind: 'event' as const,
        title: `Gebeurtenis ${e + 1}`,
        startAt: `${y}-0${1 + (e % 9)}-15`,
        itemCount: Math.max(1, Math.floor(itemCount / eventCount)),
        coverItemId: `${id}-e${e}-i0`,
      }))
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
      return { id, year: y, title: String(y), startAt: `${y}-01-01`, endAt: `${y}-12-31`, eventCount, itemCount, coverItemId: `${id}-i0` }
    })
  }

  async getVaultPath(): Promise<string | null> {
    return 'L:/Jim/MemoryLane (mock)'
  }
  async pickAndSetVault(): Promise<IndexSummary | null> {
    return { yearCount: this.years.length, eventCount: 12, itemCount: 200, errorCount: 0 }
  }
  async listYears(): Promise<YearSummary[]> {
    return this.years
  }
  async getYear(yearId: string): Promise<YearDetail | null> {
    return this.details.get(yearId) ?? null
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
  async getEvent(eventId: string): Promise<EventDetail | null> {
    const n = 6 + (hueFor(eventId) % 7)
    const base: Item[] = Array.from({ length: n }, (_, i) => ({
      id: `${eventId}-i${i}`,
      eventId,
      itemType: i === 0 ? ('text' as const) : ('photo' as const),
      media: i === 0 ? undefined : 'foto.jpg',
      bodyText: i === 0 ? 'Wat een dag was dit — de zon, de zee, en wij.' : undefined,
      caption: `Foto ${i}`,
      slug: `${eventId}-i${i}`,
    }))
    const items = [...base, ...(this.adds.get(eventId) ?? [])].filter((it) => !this.deleted.has(it.id))
    return {
      event: { id: eventId, kind: 'event', title: 'Gebeurtenis', startAt: '2024-06-15', folderPath: 'mock' },
      items,
      canvas: [],
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
  async createEvent(yearId: string, _title: string, _startAt: string): Promise<string> {
    return `${yearId}-newevent`
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
