// Decode-worker: zet een bron (URL-thumbnail óf procedureel gegenereerd voor de
// perf-harness) om naar een ImageBitmap, buiten de main-thread zodat decoden de
// UI niet laat haperen. De ImageBitmap wordt transfer-verhuisd (zero-copy).

export interface DecodeRequest {
  key: string
  /** Thumbnail-URL (bijv. `thumb://...`); afwezig = procedureel genereren. */
  url?: string
  /** Procedurele parameters voor de harness. */
  hue?: number
  size?: number
}

export interface DecodeResult {
  key: string
  bitmap?: ImageBitmap
  error?: string
}

async function decode(req: DecodeRequest): Promise<ImageBitmap> {
  if (req.url) {
    const res = await fetch(req.url)
    if (!res.ok) throw new Error(`fetch ${res.status}`)
    const blob = await res.blob()
    return await createImageBitmap(blob)
  }
  // Procedureel: een herkenbare gradient-tegel (harness-synthetische data).
  const size = req.size ?? 128
  const hue = req.hue ?? 200
  const canvas = new OffscreenCanvas(size, size)
  const ctx = canvas.getContext('2d')!
  const grad = ctx.createLinearGradient(0, 0, size, size)
  grad.addColorStop(0, `hsl(${hue}, 65%, 55%)`)
  grad.addColorStop(1, `hsl(${(hue + 60) % 360}, 65%, 35%)`)
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, size, size)
  ctx.strokeStyle = 'rgba(255,255,255,0.25)'
  ctx.lineWidth = size * 0.04
  ctx.strokeRect(0, 0, size, size)
  return await createImageBitmap(canvas)
}

self.onmessage = async (e: MessageEvent<DecodeRequest>) => {
  const req = e.data
  try {
    const bitmap = await decode(req)
    const result: DecodeResult = { key: req.key, bitmap }
    ;(self as unknown as Worker).postMessage(result, [bitmap])
  } catch (err) {
    const result: DecodeResult = { key: req.key, error: String(err) }
    ;(self as unknown as Worker).postMessage(result)
  }
}
