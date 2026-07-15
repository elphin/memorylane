import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { decryptBlob, encryptBlob } from '../src/crypto/blob'
import { buildPlaintext, bytesToHex, fixedNonce, hexToBytes, mutate, sha256Hex } from '../src/crypto/vectors'
import type { VectorsFile } from '../src/crypto/vectors'

const data: VectorsFile = JSON.parse(
  readFileSync(path.join(import.meta.dirname, '..', '..', 'shared', 'test-vectors', 'vectors.json'), 'utf8'),
)
const master = hexToBytes(data.masterKeyHex)
const byName = new Map(data.vectors.map((v) => [v.name, v]))

describe('crypto — vectoren (encrypt → byte-identiek)', () => {
  for (const v of data.vectors) {
    it(`${v.name}: encrypt matcht de vector + round-trip`, async () => {
      const plaintext = buildPlaintext(v.plaintext)
      const container = await encryptBlob(plaintext, master, v.memoryId, v.fileId, fixedNonce)
      expect(container.length).toBe(v.expectedLen)
      expect(await sha256Hex(container)).toBe(v.expectedSha256)
      // Round-trip terug naar exact de plaintext.
      const back = await decryptBlob(container, master, v.memoryId, v.fileId)
      expect(bytesToHex(back)).toBe(bytesToHex(plaintext))
    })
  }
})

describe('crypto — weigert corrupte/verkeerde input', () => {
  for (const cor of data.corruptions) {
    it(`${cor.name}: decrypt faalt`, async () => {
      const base = byName.get(cor.base)!
      const container = await encryptBlob(buildPlaintext(base.plaintext), master, base.memoryId, base.fileId, fixedNonce)
      const bad = mutate(container, cor.mutation)
      await expect(decryptBlob(bad, master, base.memoryId, base.fileId)).rejects.toThrow()
    })
  }

  it('verkeerde sleutel → faalt', async () => {
    const v = data.vectors[0]
    const container = await encryptBlob(buildPlaintext(v.plaintext), master, v.memoryId, v.fileId, fixedNonce)
    const wrong = master.slice()
    wrong[0] ^= 0xff
    await expect(decryptBlob(container, wrong, v.memoryId, v.fileId)).rejects.toThrow()
  })

  it('verkeerde memoryId/fileId (AAD/salt) → faalt', async () => {
    const v = data.vectors[0]
    const container = await encryptBlob(buildPlaintext(v.plaintext), master, v.memoryId, v.fileId, fixedNonce)
    await expect(decryptBlob(container, master, v.memoryId, 'ander-bestand')).rejects.toThrow()
    await expect(decryptBlob(container, master, '99999999-9999-4999-8999-999999999999', v.fileId)).rejects.toThrow()
  })

  it('leeg bestand verboden', async () => {
    await expect(encryptBlob(new Uint8Array(0), master, data.vectors[0].memoryId, 'x', fixedNonce)).rejects.toThrow()
  })

  it('vijandige plaintextSize (16-byte blob) → nette fout, geen giga-allocatie', async () => {
    const blob = new Uint8Array(16)
    blob.set([0x4d, 0x4c, 0x49, 0x31], 0) // "MLI1"
    blob[4] = 1
    new DataView(blob.buffer).setBigUint64(8, 0xffffffffffffffffn, true)
    await expect(decryptBlob(blob, master, 'm', 'x')).rejects.toThrow()
  })
})
