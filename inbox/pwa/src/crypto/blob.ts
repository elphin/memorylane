// MemoryLane Onderweg — versleuteld blobformaat (§8). Byte-voor-byte identiek aan
// de Rust-kant (src-tauri/src/inbox/crypto.rs); bewezen met de gedeelde vectoren
// in inbox/shared/test-vectors/.
//
// Container:
//   0  4  magic "MLI1" | 4 1 version=1 | 5 3 reserved=0 | 8 8 plaintextSize u64 LE
//   16 …  chunks: elk  nonce(12) || AES-256-GCM(ct + tag16)
// Chunk-plaintext: vast 8 MiB (laatste korter). AAD per chunk:
//   "ml1|"+memoryId+"|"+fileId+"|"+chunkIndex+"|"+chunkCount

const MAGIC = new Uint8Array([0x4d, 0x4c, 0x49, 0x31]) // "MLI1"
const VERSION = 1
export const CHUNK = 8 * 1024 * 1024 // 8 MiB plaintext per chunk
const NONCE_LEN = 12
const TAG_LEN = 16
const enc = new TextEncoder()

export type NonceFn = (chunkIndex: number) => Uint8Array
export const randomNonce: NonceFn = () => crypto.getRandomValues(new Uint8Array(NONCE_LEN))

function chunkCount(plaintextSize: number): number {
  return Math.max(1, Math.ceil(plaintextSize / CHUNK))
}

/** Per-bestand sleutel via HKDF-SHA256 (§7.2). `fileId === 'envelope'` voor de envelope. */
export async function deriveFileKey(
  masterKey: Uint8Array,
  memoryId: string,
  fileId: string,
): Promise<Uint8Array> {
  const info = fileId === 'envelope' ? 'ml-inbox:v1:envelope' : `ml-inbox:v1:file:${fileId}`
  const km = await crypto.subtle.importKey('raw', bufferSource(masterKey), 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(`ml-inbox:${memoryId}`), info: enc.encode(info) },
    km,
    256,
  )
  return new Uint8Array(bits)
}

function aad(memoryId: string, fileId: string, i: number, n: number): Uint8Array {
  return enc.encode(`ml1|${memoryId}|${fileId}|${i}|${n}`)
}

/** Versleutel `plaintext` tot een container. `nonceFn` is injecteerbaar (vectoren);
 * productie gebruikt `randomNonce`. Een leeg bestand is verboden (§8.1). */
export async function encryptBlob(
  plaintext: Uint8Array,
  masterKey: Uint8Array,
  memoryId: string,
  fileId: string,
  nonceFn: NonceFn = randomNonce,
): Promise<Uint8Array> {
  if (plaintext.length === 0) throw new Error('leeg bestand is verboden')
  const key = await crypto.subtle.importKey(
    'raw',
    bufferSource(await deriveFileKey(masterKey, memoryId, fileId)),
    'AES-GCM',
    false,
    ['encrypt'],
  )
  const n = chunkCount(plaintext.length)
  const header = new Uint8Array(16)
  header.set(MAGIC, 0)
  header[4] = VERSION
  new DataView(header.buffer).setBigUint64(8, BigInt(plaintext.length), true)
  const parts: Uint8Array[] = [header]
  for (let i = 0; i < n; i++) {
    const chunk = plaintext.subarray(i * CHUNK, Math.min((i + 1) * CHUNK, plaintext.length))
    const nonce = nonceFn(i)
    if (nonce.length !== NONCE_LEN) throw new Error('nonce moet 12 bytes zijn')
    const ct = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: bufferSource(nonce), additionalData: bufferSource(aad(memoryId, fileId, i, n)), tagLength: 128 },
        key,
        bufferSource(chunk),
      ),
    )
    parts.push(nonce, ct)
  }
  return concat(parts)
}

/** Ontsleutel een container → plaintext. Valideert magic/version/plaintextSize +
 * elke GCM-tag; elke afwijking gooit. */
export async function decryptBlob(
  blob: Uint8Array,
  masterKey: Uint8Array,
  memoryId: string,
  fileId: string,
): Promise<Uint8Array> {
  if (blob.length < 16) throw new Error('te kort')
  if (!eq(blob.subarray(0, 4), MAGIC)) throw new Error('verkeerde magic')
  if (blob[4] !== VERSION) throw new Error('verkeerde versie')
  const plainSize = Number(new DataView(blob.buffer, blob.byteOffset, blob.byteLength).getBigUint64(8, true))
  // Vijandige header: ciphertext ≥ plaintext, dus plainSize > blob.length is kapot.
  // Vroeg weigeren zodat een enorme gelogen grootte geen giga-allocatie forceert.
  if (plainSize > blob.length) throw new Error('plaintextSize groter dan de blob')
  const key = await crypto.subtle.importKey(
    'raw',
    bufferSource(await deriveFileKey(masterKey, memoryId, fileId)),
    'AES-GCM',
    false,
    ['decrypt'],
  )
  const n = chunkCount(plainSize)
  const out = new Uint8Array(plainSize)
  let off = 16
  let written = 0
  for (let i = 0; i < n; i++) {
    const expected = Math.min(CHUNK, plainSize - i * CHUNK)
    if (off + NONCE_LEN + expected + TAG_LEN > blob.length) throw new Error('getrunceerd')
    const nonce = blob.subarray(off, off + NONCE_LEN)
    off += NONCE_LEN
    const ct = blob.subarray(off, off + expected + TAG_LEN)
    off += expected + TAG_LEN
    const pt = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: bufferSource(nonce), additionalData: bufferSource(aad(memoryId, fileId, i, n)), tagLength: 128 },
        key,
        bufferSource(ct),
      ),
    )
    out.set(pt, written)
    written += pt.length
  }
  if (off !== blob.length) throw new Error('bytes over aan het eind')
  if (written !== plainSize) throw new Error('plaintextSize klopt niet')
  return out
}

// ---- helpers ----
function concat(parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((s, p) => s + p.length, 0)
  const out = new Uint8Array(len)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}
function eq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
// Kopie naar een strakke ArrayBuffer (subarray-views doorgeven aan WebCrypto kan
// de onderliggende buffer meenemen; een kopie voorkomt subtiele offset-bugs).
function bufferSource(u: Uint8Array): ArrayBuffer {
  return u.slice().buffer
}
