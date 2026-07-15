// Genereert inbox/shared/test-vectors/vectors.json: de canonieke vector-spec +
// de verwachte container-SHA-256/lengte, berekend met de TS-referentie-impl.
// Draai: `npm run gen-vectors`. De uitvoer wordt gecommit; de Rust-tests moeten
// dezelfde SHA-256 produceren (byte-identiek).

import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { encryptBlob } from '../src/crypto/blob'
import { CORRUPTIONS, MASTER_KEY_HEX, VECTORS, buildPlaintext, fixedNonce, hexToBytes, sha256Hex } from '../src/crypto/vectors'
import type { VectorsFile } from '../src/crypto/vectors'

const master = hexToBytes(MASTER_KEY_HEX)

const vectors = []
for (const v of VECTORS) {
  const plaintext = buildPlaintext(v.plaintext)
  const container = await encryptBlob(plaintext, master, v.memoryId, v.fileId, fixedNonce)
  vectors.push({
    name: v.name,
    memoryId: v.memoryId,
    fileId: v.fileId,
    plaintext: v.plaintext,
    expectedSha256: await sha256Hex(container),
    expectedLen: container.length,
  })
}

const out: VectorsFile = { masterKeyHex: MASTER_KEY_HEX, vectors, corruptions: CORRUPTIONS }

const dir = path.join(import.meta.dirname, '..', '..', 'shared', 'test-vectors')
mkdirSync(dir, { recursive: true })
writeFileSync(path.join(dir, 'vectors.json'), JSON.stringify(out, null, 2) + '\n')
console.log(`Geschreven: ${path.join(dir, 'vectors.json')} (${vectors.length} vectoren)`)
