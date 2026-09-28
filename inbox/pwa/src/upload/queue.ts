// Upload-flow (§6.5): concept → envelope + media versleutelen → aankondigen
// (presign) → PUT naar R2 met voortgang → complete (met resume bij ontbrekende
// bestanden). De app moet open blijven; de versleutelde bytes leven kort in het
// geheugen.
//
// Wat er verstuurd wordt, blijft als snapshot (`draft` + media-blobs) in de
// outbox-rij staan tot de desktop de import bevestigt. Verloopt een memory in de
// brievenbus, dan is hij dus opnieuw te versturen, en tot de import is hij aan te
// passen (= vervangen door een nieuwe versie).

import { createMemory, completeMemory, deleteMemory, fetchOutbox, ApiError } from '../api/client'
import { encryptBlob, randomNonce } from '../crypto/blob'
import { buildEnvelopeBytes } from '../crypto/envelope'
import {
  deleteMediaIfUnused,
  deleteOutbox,
  getMedia,
  getOutbox,
  listOutbox,
  moveDraftToOutbox,
  patchOutbox,
  replaceOutbox,
  type Draft,
  type OutboxEntry,
  type Pairing,
} from '../store/db'
import { hexToBytes } from '../crypto/vectors'
import { uuid } from '../util'
import { READY_RETENTION_DAYS, reconcile } from './reconcile'

export interface Progress {
  phase: 'encrypt' | 'upload' | 'finalize' | 'done'
  fileIndex: number
  fileCount: number
  bytesSent: number
  bytesTotal: number
}

const ENVELOPE = 'envelope'

// Uploads die nu in deze app lopen. Het dashboard gebruikt dit om een
// 'uploading'-rij zonder lopende upload als onderbroken te tonen.
const active = new Set<string>()
export const isUploading = (memoryId: string): boolean => active.has(memoryId)

// Memories die nu verwijderd of vervangen worden. Een upload mag daar niet meer
// aan beginnen (anders maakt hij een net ingetrokken memory op de server opnieuw
// aan en komt die thuis alsnog binnen). `active` en `blocked` sluiten elkaar
// uit: beide worden synchroon (zonder await ertussen) gecontroleerd en gezet.
const blocked = new Set<string>()

/** Reserveer een memory voor verwijderen/vervangen. Weigert als hij nu
 * verstuurd wordt. Geeft een functie terug die de reservering weer opheft. */
function claimForChange(memoryId: string): () => void {
  if (active.has(memoryId)) throw new Error('Deze memory wordt nu verstuurd — wacht even tot dat klaar is.')
  if (blocked.has(memoryId)) throw new Error('Hier wordt al aan gewerkt.')
  blocked.add(memoryId)
  return () => blocked.delete(memoryId)
}

/** Kan niet meer aangepast worden: de desktop heeft 'm al binnengehaald. */
export class AlreadyImportedError extends Error {
  constructor() {
    super('Deze memory is intussen thuis geïmporteerd. Aanpassen doe je nu in MemoryLane op de computer.')
  }
}

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

// ---- Thumbnails (om de memory later te kunnen inzien) ----

const THUMB_PX = 320

function canvasToJpeg(src: CanvasImageSource, w: number, h: number): Promise<Blob | null> {
  const scale = Math.min(1, THUMB_PX / Math.max(w, h))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(w * scale))
  canvas.height = Math.max(1, Math.round(h * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) return Promise.resolve(null)
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height)
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.8))
}

async function imageThumb(blob: Blob): Promise<Blob | null> {
  const bmp = await createImageBitmap(blob)
  try {
    return await canvasToJpeg(bmp, bmp.width, bmp.height)
  } finally {
    bmp.close()
  }
}

/** Eerste frame van een video; lukt dat niet binnen een paar seconden, dan geen thumb. */
function videoThumb(blob: Blob): Promise<Blob | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob)
    const v = document.createElement('video')
    let settled = false
    const finish = (b: Blob | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      URL.revokeObjectURL(url)
      v.removeAttribute('src')
      v.load()
      resolve(b)
    }
    const timer = setTimeout(() => finish(null), 2500)
    v.muted = true
    v.playsInline = true
    v.preload = 'auto'
    v.onloadeddata = () => {
      v.currentTime = Math.min(0.5, (v.duration || 1) / 2)
    }
    v.onseeked = () => {
      canvasToJpeg(v, v.videoWidth, v.videoHeight).then(finish, () => finish(null))
    }
    v.onerror = () => finish(null)
    v.src = url
  })
}

/** Thumbnails voor alle media van een concept. Best-effort: een mislukte thumb
 * wordt gewoon overgeslagen. */
export async function makeThumbs(draft: Draft, existing: Record<string, Blob> = {}): Promise<Record<string, Blob>> {
  const out: Record<string, Blob> = {}
  // iOS laadt video's zonder tik soms niet; dan wacht elke video de hele timeout.
  // Na dit budget slaan we verdere video-thumbs over zodat versturen snel start.
  const videoDeadline = Date.now() + 6000
  for (const m of draft.media) {
    if (m.mime.startsWith('video/') && !existing[m.fileId] && Date.now() > videoDeadline) continue
    if (existing[m.fileId]) {
      out[m.fileId] = existing[m.fileId]
      continue
    }
    try {
      const blob = await getMedia(draft.id, m.fileId)
      if (!blob) continue
      const t = m.mime.startsWith('image/') ? await imageThumb(blob) : m.mime.startsWith('video/') ? await videoThumb(blob) : null
      if (t) out[m.fileId] = t
    } catch {
      /* geen thumb — niet erg */
    }
  }
  return out
}

/** Vraag de browser de opslag niet op te ruimen (iOS wist anders na 7 dagen
 * zonder gebruik alles wat een niet-geïnstalleerde web-app bewaart). */
function askPersistentStorage(): void {
  void navigator.storage?.persist?.().catch(() => false)
}

function snapshotRow(memoryId: string, draft: Draft, thumbs: Record<string, Blob>, createdAt: string): OutboxEntry {
  return {
    memoryId,
    title: draft.title.trim(),
    startAt: draft.startAt,
    mediaCount: draft.media.length,
    createdAt,
    status: 'uploading',
    draft: { ...draft, updatedAt: new Date().toISOString() },
    thumbs,
  }
}

// ---- Voorbereiden: de outbox-rij (met snapshot) staat er vóór de upload ----

/** Nieuw concept versturen: concept → outbox-rij (één transactie). Geeft het memoryId. */
export async function prepareNew(draft: Draft): Promise<string> {
  askPersistentStorage()
  const thumbs = await makeThumbs(draft) // vóór de transactie: async werk erin sluit 'm af
  const memoryId = uuid()
  await moveDraftToOutbox(draft.id, snapshotRow(memoryId, draft, thumbs, new Date().toISOString()))
  return memoryId
}

/** Aangepaste versie versturen: oude versie uit de brievenbus halen en de rij
 * vervangen door een nieuwe met een NIEUW memoryId (de desktop onthoudt per
 * memoryId wat hij al heeft geïmporteerd). Weigert als de oude al thuis is. */
export async function prepareReplace(pairing: Pairing, oldMemoryId: string, draft: Draft): Promise<string> {
  const release = claimForChange(oldMemoryId)
  try {
    return await replaceClaimed(pairing, oldMemoryId, draft)
  } finally {
    release()
  }
}

async function replaceClaimed(pairing: Pairing, oldMemoryId: string, draft: Draft): Promise<string> {
  const old = await getOutbox(oldMemoryId)
  if (!old) throw new Error('Deze memory staat niet meer op je telefoon.')
  if (old.status === 'imported') throw new AlreadyImportedError()

  // Eerst kijken, dan intrekken; `was` vangt een import die er net tussen kwam.
  const remote = (await fetchOutbox(pairing)).find((r) => r.memoryId === oldMemoryId)
  if (remote?.status === 'imported' || (await deleteMemory(pairing, oldMemoryId)) === 'imported') {
    await markImported(old)
    throw new AlreadyImportedError()
  }

  const thumbs = await makeThumbs(draft, old.thumbs)
  const memoryId = uuid()
  await replaceOutbox(oldMemoryId, snapshotRow(memoryId, draft, thumbs, old.createdAt))
  return memoryId
}

// ---- De upload zelf ----

/** Verstuur de snapshot van outbox-rij `memoryId`. Opnieuw aanroepen met
 * hetzelfde id is veilig (idempotent op de server; de desktop importeert een
 * memoryId maar één keer). */
export async function runUpload(pairing: Pairing, memoryId: string, onProgress: (p: Progress) => void): Promise<void> {
  // Synchroon, vóór de eerste await: zie `blocked`.
  if (blocked.has(memoryId)) throw new Error('Deze memory wordt net verwijderd of aangepast.')
  if (active.has(memoryId)) throw new Error('Deze memory wordt al verstuurd.')
  active.add(memoryId)
  const master = hexToBytes(pairing.masterKeyHex)
  const createdAt = new Date().toISOString()

  try {
    // Pas ná het reserveren lezen: bestaat de rij niet meer (net verwijderd of
    // vervangen), dan niets versturen.
    const row = await getOutbox(memoryId)
    const draft = row?.draft
    if (!draft) throw new Error('De inhoud van deze memory is niet op je telefoon bewaard.')
    await patchOutbox(memoryId, { status: 'uploading' })

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
    //    409 = staat al klaar of is al geïmporteerd (bv. antwoord eerder verloren):
    //    dan de serverstatus overnemen i.p.v. een fout te tonen.
    let uploadUrls: Record<string, string>
    try {
      ;({ uploadUrls } = await createMemory(pairing, memoryId, files, envBytes.length))
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const remote = (await fetchOutbox(pairing)).find((r) => r.memoryId === memoryId)
        if (remote && remote.status !== 'uploading') {
          if (remote.status === 'imported') await markImported(row!)
          else await patchOutbox(memoryId, reconcile({ ...row!, status: 'uploading' }, remote, false) ?? {})
          onProgress({ phase: 'done', fileIndex: 0, fileCount: 0, bytesSent: 1, bytesTotal: 1 })
          return
        }
      }
      throw e
    }

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

    // Verloop lokaal schatten; het dashboard neemt de serverwaarde over zodra het ververst.
    const now = Date.now()
    await patchOutbox(memoryId, {
      status: 'ready',
      readyAt: new Date(now).toISOString(),
      expiresAt: new Date(now + READY_RETENTION_DAYS * 86400 * 1000).toISOString(),
    })
    onProgress({ phase: 'done', fileIndex: files.length, fileCount: files.length, bytesSent: bytesTotal, bytesTotal })
  } catch (e) {
    // Laat de outbox niet eeuwig op 'uploading' staan. 401 (verlopen token) laten
    // we met rust: de UI stuurt de gebruiker naar opnieuw-koppelen.
    if (!(e instanceof ApiError && e.status === 401)) await patchOutbox(memoryId, { status: 'failed' }).catch(() => {})
    throw e
  } finally {
    active.delete(memoryId)
  }
}

// ---- Afstemmen met de server + opruimen ----

/** Haal de serverstatus op en werk de lokale rijen bij. Geïmporteerde memories
 * geven hun media-blobs vrij (tekst + thumbs blijven om te kunnen inzien).
 * Faalt de server-call, dan gooit dit (401 → opnieuw koppelen). */
export async function syncOutbox(pairing: Pairing): Promise<void> {
  const remote = await fetchOutbox(pairing)
  const rmap = new Map(remote.map((r) => [r.memoryId, r]))
  for (const { memoryId } of await listOutbox()) {
    // Vers lezen: een upload die net klaar is mag niet met een oude status
    // overschreven worden.
    const l = await getOutbox(memoryId)
    if (!l) continue
    const patch = reconcile(l, rmap.get(memoryId), active.has(memoryId))
    if (!patch) continue
    if (patch.status === 'imported') await markImported(l)
    else await patchOutbox(memoryId, patch)
  }
}

/** Rij op 'imported' en de media-blobs vrijgeven (tekst + thumbs blijven). Een
 * nog niet verstuurde `edit` blijft bewaard om thuis over te nemen. */
async function markImported(e: OutboxEntry): Promise<void> {
  await patchOutbox(e.memoryId, { status: 'imported' })
  if (e.draft) await deleteMediaIfUnused(e.draft.id, e.memoryId)
}

/** Haal een memory weg: uit de brievenbus (als die er nog is) en van de telefoon.
 * Lukt intrekken op de server niet, dan laten we de rij staan — anders komt hij
 * thuis alsnog binnen terwijl hij hier weg lijkt. Alleen bij 'gone' (server kent
 * 'm niet meer) en 'imported' is de server niet nodig. */
export async function removeEntry(pairing: Pairing, entry: OutboxEntry): Promise<void> {
  const release = claimForChange(entry.memoryId)
  try {
    // Vers lezen: de status kan veranderd zijn sinds het scherm 'm laadde.
    const cur = (await getOutbox(entry.memoryId)) ?? entry
    if (cur.status !== 'imported' && cur.status !== 'gone') await deleteMemory(pairing, cur.memoryId)
    await deleteOutbox(cur.memoryId)
    if (cur.draft) await deleteMediaIfUnused(cur.draft.id)
  } finally {
    release()
  }
}

// ---- Onderbroken uploads vanzelf hervatten ----

// Eén automatische poging per memory per app-sessie: een upload die om een
// blijvende reden faalt, blijft zo niet eindeloos opnieuw proberen.
const autoTried = new Set<string>()
let resuming = false

// Memories die nu in de aanpas-modus open staan: die versturen we niet vanzelf,
// anders vertrekt de oude versie terwijl je 'm aan het aanpassen bent.
const held = new Set<string>()
export function holdForEdit(memoryId: string): () => void {
  held.add(memoryId)
  return () => held.delete(memoryId)
}

// Schermen die willen weten dat de achtergrond-hervatting een rij veranderde.
// Een set i.p.v. één callback: een scherm dat later opent (terwijl de lus al
// loopt) moet ook bijgewerkt worden.
const outboxListeners = new Set<() => void>()
export function onOutboxChange(cb: () => void): () => void {
  outboxListeners.add(cb)
  return () => outboxListeners.delete(cb)
}
const notifyOutbox = (): void => outboxListeners.forEach((l) => l())

/** Verstuur mislukte/onderbroken memories opnieuw op de achtergrond (zelfde
 * memoryId: de desktop importeert er nooit twee van). Niet voor 'gone' (kan thuis
 * bewust verwijderd zijn) en niet als er onverstuurde wijzigingen klaarstaan.
 * `onChange` laat het scherm verversen; 401 gaat omhoog (opnieuw koppelen). */
export async function autoResume(pairing: Pairing): Promise<void> {
  if (resuming || !navigator.onLine) return
  resuming = true
  try {
    for (const { memoryId } of await listOutbox()) {
      const e = await getOutbox(memoryId) // vers: kan intussen veranderd zijn
      if (!e || e.status !== 'failed' || !e.draft || e.edit) continue
      if (autoTried.has(memoryId) || active.has(memoryId) || blocked.has(memoryId) || held.has(memoryId)) continue
      autoTried.add(memoryId)
      const run = runUpload(pairing, memoryId, () => {})
      notifyOutbox() // toont nu "Bezig met versturen…"
      try {
        await run
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) throw err
        /* blijft 'failed'; handmatig opnieuw versturen kan altijd */
      } finally {
        notifyOutbox()
      }
      if (!navigator.onLine) break
    }
  } finally {
    resuming = false
  }
}
