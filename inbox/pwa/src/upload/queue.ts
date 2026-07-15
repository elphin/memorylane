// Upload-flow (§6.5): concept → envelope + media versleutelen → aankondigen
// (presign) → PUT naar R2 met voortgang → complete (met resume bij ontbrekende
// bestanden). De app moet open blijven; de versleutelde bytes leven kort in het
// geheugen (de plaintext staat veilig in IndexedDB, dus opnieuw proberen kan).

import { createMemory, completeMemory, ApiError } from '../api/client'
import { encryptBlob, randomNonce } from '../crypto/blob'
import { buildEnvelopeBytes } from '../crypto/envelope'
import { getMedia, putOutbox, type Draft, type Pairing } from '../store/db'
import { hexToBytes } from '../crypto/vectors'

export interface Progress {
  phase: 'encrypt' | 'upload' | 'finalize' | 'done'
  fileIndex: number
  fileCount: number
  bytesSent: number
  bytesTotal: number
}

const ENVELOPE = 'envelope'

/** PUT één blob naar een presigned R2-URL via XHR (fetch heeft geen upload-
 * voortgang). Vaste content-type (§6.5): de Worker signt 'm bewust niet mee. */
function xhrPut(url: string, body: Blob, onProgress: (sent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    xhr.setRequestHeader('content-type', 'application/octet-stream')
    xhr.upload.onprogress = (e) => onProgress(e.loaded)
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`PUT faalde (${xhr.status})`))
    xhr.onerror = () => reject(new Error('netwerkfout tijdens upload'))
    xhr.send(body)
  })
}

/** Voer de hele upload uit voor `draft`. `memoryId` mag hergebruikt worden bij
 * opnieuw proberen (idempotent op de server). Roept `onProgress` door. */
export async function runUpload(
  draft: Draft,
  pairing: Pairing,
  memoryId: string,
  onProgress: (p: Progress) => void,
): Promise<void> {
  const master = hexToBytes(pairing.masterKeyHex)
  const createdAt = new Date().toISOString()
  const outbox = (status: 'uploading' | 'ready' | 'failed') =>
    putOutbox({
      memoryId,
      title: draft.title.trim(),
      startAt: draft.startAt,
      mediaCount: draft.media.length,
      createdAt,
      status,
    })

  try {
    // 1) Versleutel envelope + elk mediabestand (één tegelijk; ciphertext in het
    //    geheugen tot de upload klaar is). Voortgang op basis van plaintext-omvang,
    //    zodat de balk ook tijdens deze (voor grote foto's zware) fase beweegt.
    const plainTotal = Math.max(1, draft.media.reduce((s, m) => s + m.plainBytes, 0))
    let plainDone = 0
    const ciphers = new Map<string, Blob>()
    const envBytes = await encryptBlob(buildEnvelopeBytes(draft, memoryId, createdAt), master, memoryId, ENVELOPE, randomNonce)
    ciphers.set(ENVELOPE, new Blob([envBytes]))

    const files: { fileId: string; bytes: number }[] = []
    for (let i = 0; i < draft.media.length; i++) {
      const m = draft.media[i]
      onProgress({ phase: 'encrypt', fileIndex: i, fileCount: draft.media.length, bytesSent: plainDone, bytesTotal: plainTotal })
      const blob = await getMedia(draft.id, m.fileId)
      if (!blob) throw new Error(`Media ontbreekt lokaal: ${m.name}`)
      const plain = new Uint8Array(await blob.arrayBuffer())
      const ct = await encryptBlob(plain, master, memoryId, m.fileId, randomNonce)
      ciphers.set(m.fileId, new Blob([ct]))
      files.push({ fileId: m.fileId, bytes: ct.length })
      plainDone += m.plainBytes
    }

    const bytesTotal = envBytes.length + files.reduce((s, f) => s + f.bytes, 0)

    // 2) Aankondigen → presigned PUT-URLs (idempotent: alleen nog-niet-geüploade).
    await outbox('uploading')
    let { uploadUrls } = await createMemory(pairing, memoryId, files, envBytes.length)

    // 3) Upload met voortgang. Per fileId bijhouden hoeveel bytes verstuurd zijn
    //    (gecapt op de blobgrootte); de balk = som over alle bestanden, geklemd op
    //    het totaal. Zo kan hij niet >100% gaan of terugvallen bij een resume.
    const sentByFile = new Map<string, number>()
    const report = (phase: Progress['phase'], fileIndex: number, fileCount: number): void => {
      let s = 0
      for (const v of sentByFile.values()) s += v
      onProgress({ phase, fileIndex, fileCount, bytesSent: Math.min(s, bytesTotal), bytesTotal })
    }
    const putAll = async (urls: Record<string, string>): Promise<void> => {
      const ids = Object.keys(urls)
      for (let idx = 0; idx < ids.length; idx++) {
        const fileId = ids[idx]
        const blob = ciphers.get(fileId)
        if (!blob) throw new Error(`Ciphertext ontbreekt: ${fileId}`)
        sentByFile.set(fileId, 0) // opnieuw versturen → teller resetten
        await xhrPut(urls[fileId], blob, (sent) => {
          sentByFile.set(fileId, Math.min(sent, blob.size))
          report('upload', idx, ids.length)
        })
        sentByFile.set(fileId, blob.size)
        report('upload', idx, ids.length)
      }
    }
    await putAll(uploadUrls)

    // 4) Complete; bij ontbrekende bestanden opnieuw presignen en die opnieuw sturen.
    report('finalize', files.length, files.length)
    let result = await completeMemory(pairing, memoryId)
    let tries = 0
    while (result.status === 'incomplete' && tries++ < 3) {
      const missing = new Set(result.missing)
      // Her-aankondigen: de Worker negeert `files` op de idempotente tak en
      // presignt elke nog-ontbrekende rij (incl. de envelope) op DB-id.
      ;({ uploadUrls } = await createMemory(pairing, memoryId, files, envBytes.length))
      const retryUrls: Record<string, string> = {}
      for (const fileId of Object.keys(uploadUrls)) if (missing.has(fileId)) retryUrls[fileId] = uploadUrls[fileId]
      if (Object.keys(retryUrls).length === 0) throw new Error('De brievenbus mist bestanden maar biedt geen upload-URL.')
      await putAll(retryUrls)
      result = await completeMemory(pairing, memoryId)
    }
    if (result.status !== 'ready') throw new Error('De brievenbus kon de upload niet afronden.')

    await outbox('ready')
    onProgress({ phase: 'done', fileIndex: files.length, fileCount: files.length, bytesSent: bytesTotal, bytesTotal })
  } catch (e) {
    // Laat de outbox niet eeuwig op 'uploading' staan. 401 (verlopen token) laten
    // we met rust: de UI stuurt de gebruiker naar opnieuw-koppelen.
    if (!(e instanceof ApiError && e.status === 401)) await outbox('failed').catch(() => {})
    throw e
  }
}
