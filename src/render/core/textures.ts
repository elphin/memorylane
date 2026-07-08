// Texture-pipeline: decode in een worker, uploads naar de GPU begrensd tot een
// budget per frame, en een LRU-cache met plafond op het aantal GPU-textures.
// Voorkomt decode/upload-storms tijdens snelle pan (de fase 4-gate).

import { Texture } from 'pixi.js'
import type { DecodeRequest, DecodeResult } from './decode.worker'

/** Frames voordat een gefaalde thumbnail opnieuw geprobeerd mag worden (~3s). */
const RETRY_FRAMES = 180

interface CacheEntry {
  texture: Texture
  lastUsed: number
}

export interface TextureManagerOptions {
  /** Max nieuwe GPU-uploads per frame (spreidt de kosten). */
  uploadsPerFrame?: number
  /** Max nieuwe decode-requests per frame (voorkomt worker-flooding). */
  requestsPerFrame?: number
  /** Max aantal textures in de cache (LRU-eviction daarboven). */
  maxTextures?: number
}

export class TextureManager {
  private worker: Worker
  private cache = new Map<string, CacheEntry>()
  private pending = new Set<string>()
  // key → frame waarop de load faalde. Verloopt (RETRY_FRAMES) zodat een
  // transiënte fout (bijv. een 503 bij een volle wachtrij tijdens snel pannen)
  // later opnieuw geprobeerd wordt i.p.v. permanent placeholder te blijven.
  private failed = new Map<string, number>()
  private frame = 0
  private requestQueue: DecodeRequest[] = []
  private queuedKeys = new Set<string>()
  private readyQueue: Array<{ key: string; source: ImageBitmap | HTMLImageElement | null }> = []
  private uploadsPerFrame: number
  private requestsPerFrame: number
  private maxTextures: number

  constructor(opts: TextureManagerOptions = {}) {
    this.uploadsPerFrame = opts.uploadsPerFrame ?? 2
    this.requestsPerFrame = opts.requestsPerFrame ?? 8
    this.maxTextures = opts.maxTextures ?? 1000
    this.worker = new Worker(new URL('./decode.worker.ts', import.meta.url), {
      type: 'module',
    })
    this.worker.onmessage = (e: MessageEvent<DecodeResult>) => {
      const { key, bitmap } = e.data
      // `pending` blijft staan tot de texture echt in de cache zit (pump),
      // anders zou een key die in de readyQueue wacht elke frame opnieuw
      // aangevraagd worden → postMessage-storm.
      this.readyQueue.push({ key, source: bitmap ?? null })
    }
  }

  /** Laadt een echte thumbnail-URL via een <img> op de main-thread. Dit werkt —
   * anders dan `fetch` in een Web Worker — betrouwbaar met Tauri's custom
   * `thumb://`-protocol in WebView2. `decode()` decodeert off-thread; de
   * `crossOrigin`-vlag + CORS-header op de respons voorkomen canvas-tainting. */
  private loadImage(req: DecodeRequest): void {
    const url = req.url as string
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onerror = () => this.readyQueue.push({ key: req.key, source: null })
    img.src = url
    img
      .decode()
      .then(() => this.readyQueue.push({ key: req.key, source: img }))
      .catch(() => this.readyQueue.push({ key: req.key, source: null }))
  }

  /** Vraagt een texture op (idempotent); wordt begrensd verstuurd in `pump`,
   * zodat een frame met veel zichtbare sprites de worker niet overspoelt. */
  request(req: DecodeRequest): void {
    if (this.cache.has(req.key) || this.pending.has(req.key) || this.queuedKeys.has(req.key)) {
      return
    }
    const failedAt = this.failed.get(req.key)
    if (failedAt !== undefined) {
      if (this.frame - failedAt < RETRY_FRAMES) return // recent gefaald: nog niet opnieuw
      this.failed.delete(req.key) // verlopen → opnieuw proberen
    }
    this.queuedKeys.add(req.key)
    this.requestQueue.push(req)
  }

  /** Geeft de texture als die klaar is, en markeert hem als recent gebruikt. */
  get(key: string, frame: number): Texture | null {
    const entry = this.cache.get(key)
    if (!entry) return null
    entry.lastUsed = frame
    return entry.texture
  }

  has(key: string): boolean {
    return this.cache.has(key)
  }

  /** Per frame: verstuur begrensd nieuwe requests, upload klare bitmaps, evict. */
  pump(frame: number): void {
    this.frame = frame
    // Begrensd nieuwe requests starten (anti-flood). URL → <img>-loader,
    // procedureel (harness/mock hue) → worker.
    let sent = 0
    while (this.requestQueue.length > 0 && sent < this.requestsPerFrame) {
      const req = this.requestQueue.shift()!
      this.queuedKeys.delete(req.key)
      this.pending.add(req.key)
      if (req.url) {
        this.loadImage(req)
      } else {
        this.worker.postMessage(req)
      }
      sent++
    }

    let uploads = 0
    while (this.readyQueue.length > 0 && uploads < this.uploadsPerFrame) {
      const item = this.readyQueue.shift()!
      this.pending.delete(item.key)
      if (!item.source || this.cache.has(item.key)) {
        // Decode-fout → markeer als mislukt (verloopt, zie RETRY_FRAMES);
        // al gecachet → dubbele levering, negeren.
        if (!item.source) this.failed.set(item.key, frame)
        continue
      }
      const texture = Texture.from(item.source)
      this.cache.set(item.key, { texture, lastUsed: frame })
      uploads++
    }
    if (uploads > 0) this.evict(frame)
  }

  /** Aantal wachtende requests/uploads (voor de fps-overlay). */
  get queued(): number {
    return this.requestQueue.length + this.pending.size + this.readyQueue.length
  }

  get size(): number {
    return this.cache.size
  }

  /** Evict LRU boven de cap, maar nooit textures die recent (in beeld) gebruikt
   * zijn — anders wordt een zichtbare sprite zwart. Als alles recent is, mag de
   * cache tijdelijk boven de cap groeien. */
  private evict(frame: number): void {
    if (this.cache.size <= this.maxTextures) return
    const RECENT = 30 // frames
    const evictable = [...this.cache.entries()]
      .filter(([, e]) => e.lastUsed < frame - RECENT)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed)
    let toRemove = this.cache.size - this.maxTextures
    for (const [key, entry] of evictable) {
      if (toRemove <= 0) break
      entry.texture.destroy(true)
      this.cache.delete(key)
      toRemove--
    }
  }

  destroy(): void {
    this.worker.terminate()
    for (const entry of this.cache.values()) entry.texture.destroy(true)
    this.cache.clear()
    this.readyQueue = []
    this.requestQueue = []
    this.queuedKeys.clear()
    this.pending.clear()
    this.failed.clear()
  }
}
