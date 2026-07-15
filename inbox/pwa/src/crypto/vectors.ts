// Gedeelde definitie van de crypto-testvectoren (§12). De inputs staan in
// inbox/shared/test-vectors/vectors.json (door `npm run gen-vectors` gevuld met de
// verwachte container-SHA-256). De TS- én Rust-tests bouwen uit deze spec dezelfde
// plaintext/nonces en bewijzen dat hun container byte-identiek is (zelfde SHA-256).

export interface PlaintextSpec {
  kind: 'utf8' | 'hex' | 'pattern'
  value?: string // utf8/hex
  len?: number // pattern
  seed?: number // pattern
}

export interface VectorSpec {
  name: string
  memoryId: string
  fileId: string
  plaintext: PlaintextSpec
  expectedSha256?: string // container-SHA-256 (hex), gevuld door gen-vectors
  expectedLen?: number
}

export type Mutation = 'flip_last_byte' | 'swap_first_two_chunks' | 'increment_plaintext_size'

export interface CorruptionSpec {
  name: string
  base: string // naam van een VectorSpec
  mutation: Mutation
}

export interface VectorsFile {
  masterKeyHex: string
  vectors: VectorSpec[]
  corruptions: CorruptionSpec[]
}

// 32-byte masterKey (§7.2) — vast voor de vectoren.
export const MASTER_KEY_HEX = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'
const MEMORY = '11111111-1111-4111-8111-111111111111'

// De canonieke vector-spec. 8 MiB = 8388608 → v2 (2*8MiB+100) = 3 chunks, laatste partieel.
export const VECTORS: VectorSpec[] = [
  {
    name: 'vector-01-text',
    memoryId: MEMORY,
    fileId: '22222222-2222-4222-8222-222222222222',
    plaintext: { kind: 'utf8', value: 'Hallo MemoryLane! 🌍\nTweede regel: café — ‘quote’.' },
  },
  {
    name: 'vector-02-multichunk',
    memoryId: MEMORY,
    fileId: '33333333-3333-4333-8333-333333333333',
    plaintext: { kind: 'pattern', len: 2 * 8 * 1024 * 1024 + 100, seed: 7 },
  },
  {
    name: 'vector-03-envelope',
    memoryId: MEMORY,
    fileId: 'envelope',
    plaintext: {
      kind: 'utf8',
      value: '{"v":1,"memoryId":"11111111-1111-4111-8111-111111111111","title":"Weekend","startAt":"2026-07-11","files":[]}',
    },
  },
]

export const CORRUPTIONS: CorruptionSpec[] = [
  { name: 'vector-04-tag-bitflip', base: 'vector-01-text', mutation: 'flip_last_byte' },
  { name: 'vector-05-swap-chunks', base: 'vector-02-multichunk', mutation: 'swap_first_two_chunks' },
  { name: 'vector-06-lie-size', base: 'vector-01-text', mutation: 'increment_plaintext_size' },
]

// ---- deterministische helpers (Rust reimplementeert deze identiek) ----

/** Vaste nonce per chunk: [chunkIndex, 0x11, 0x22, …, 0xbb]. */
export function fixedNonce(i: number): Uint8Array {
  return new Uint8Array([i & 0xff, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb])
}

export function buildPlaintext(spec: PlaintextSpec): Uint8Array {
  if (spec.kind === 'utf8') return new TextEncoder().encode(spec.value ?? '')
  if (spec.kind === 'hex') return hexToBytes(spec.value ?? '')
  // pattern: byte[j] = (j * seed + 0x5a) & 0xff
  const len = spec.len ?? 0
  const seed = spec.seed ?? 1
  const out = new Uint8Array(len)
  for (let j = 0; j < len; j++) out[j] = (j * seed + 0x5a) & 0xff
  return out
}

const HEADER = 16
const NONCE = 12
export const CHUNK_SIZE = 8 * 1024 * 1024

/** Pas een corruptie toe op een container (voor de "moet falen"-vectoren). */
export function mutate(container: Uint8Array, mutation: Mutation): Uint8Array {
  const c = container.slice()
  if (mutation === 'flip_last_byte') {
    c[c.length - 1] ^= 0x01 // laatste tag-byte kapot → GCM-auth faalt
    return c
  }
  if (mutation === 'increment_plaintext_size') {
    const dv = new DataView(c.buffer, c.byteOffset, c.byteLength)
    dv.setBigUint64(8, dv.getBigUint64(8, true) + 1n, true) // gelogen plaintextSize
    return c
  }
  // swap_first_two_chunks: verwissel chunk 0 en 1 (alleen zinvol bij ≥2 chunks).
  // Chunk 0 en 1 zijn beide vol (NONCE + CHUNK_SIZE + 16 tag).
  const full = NONCE + CHUNK_SIZE + 16
  const a0 = HEADER
  const a1 = HEADER + full
  const chunk0 = c.slice(a0, a0 + full)
  const chunk1 = c.slice(a1, a1 + full)
  c.set(chunk1, a0)
  c.set(chunk0, a1)
  return c
}

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}
export function bytesToHex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
}
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer)))
}
