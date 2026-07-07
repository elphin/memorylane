// Texture-pipeline: decode in een worker, uploads naar de GPU begrensd tot een
// budget per frame, en een LRU-cache met plafond op het aantal GPU-textures.
// Voorkomt decode/upload-storms tijdens snelle pan (de fase 4-gate).

import { Texture } from 'pixi.js'
import type { DecodeRequest, DecodeResult } from './decode.worker'

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
  private failed = new Set<string>()
  private requestQueue: DecodeRequest[] = []
  private queuedKeys = new Set<string>()
  private readyQueue: Array<{ key: string; bitmap: ImageBitmap | null }> = []
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
      this.readyQueue.push({ key, bitmap: bitmap ?? null })
    }
  }

  /** Vraagt een texture op (idempotent); wordt begrensd verstuurd in `pump`,
   * zodat een frame met veel zichtbare sprites de worker niet overspoelt. */
  request(req: DecodeRequest): void {
    if (
      this.cache.has(req.key) ||
      this.pending.has(req.key) ||
      this.failed.has(req.key) ||
      this.queuedKeys.has(req.key)
    ) {
      return
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
    // Begrensd requests naar de worker sturen (anti-flood).
    let sent = 0
    while (this.requestQueue.length > 0 && sent < this.requestsPerFrame) {
      const req = this.requestQueue.shift()!
      this.queuedKeys.delete(req.key)
      this.pending.add(req.key)
      this.worker.postMessage(req)
      sent++
    }

    let uploads = 0
    while (this.readyQueue.length > 0 && uploads < this.uploadsPerFrame) {
      const item = this.readyQueue.shift()!
      this.pending.delete(item.key)
      if (!item.bitmap) {
        // Decode-fout: markeer als mislukt zodat we niet eeuwig opnieuw proberen.
        this.failed.add(item.key)
        continue
      }
      const texture = Texture.from(item.bitmap)
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
