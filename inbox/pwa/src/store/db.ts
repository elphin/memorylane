// Lokale opslag (IndexedDB): pairing, concepten (incl. media-bytes zodat een
// concept een app-herstart overleeft, §6.5) en de outbox. Geen server nodig.

import { openDB, type DBSchema, type IDBPDatabase } from 'idb'

export interface Pairing {
  serverUrl: string
  mailboxId: string
  uploadToken: string
  masterKeyHex: string
}

export interface DraftMedia {
  fileId: string
  name: string
  mime: string
  plainBytes: number
}

export interface Draft {
  id: string
  title: string
  startAt: string // YYYY-MM-DD
  endAt?: string
  note: string
  media: DraftMedia[] // volgorde = importvolgorde
  createdAt: string
  updatedAt: string
}

export type OutboxStatus = 'uploading' | 'ready' | 'imported' | 'failed' | 'gone'

export interface OutboxEntry {
  memoryId: string
  title: string
  startAt: string
  mediaCount: number
  createdAt: string
  /** 'gone' = de server kent 'm niet meer (verlopen, of thuis verwijderd). */
  status: OutboxStatus
  /** Wat er verstuurd is. De media-blobs blijven onder `draft.id` in de
   * media-store staan tot de desktop de import bevestigt, zodat een verlopen
   * memory opnieuw verstuurd kan worden. Ontbreekt bij rijen van vóór deze versie. */
  draft?: Draft
  /** Kleine JPEG per foto/video (fileId → blob): blijft na import bewaard om
   * de memory te kunnen inzien als de originele blobs al zijn opgeruimd. */
  thumbs?: Record<string, Blob>
  readyAt?: string
  /** Wanneer de brievenbus 'm opruimt (van de server; lokaal geschat als die
   * het nog niet heeft gemeld). */
  expiresAt?: string
  /** Aanpassingen die nog niet verstuurd zijn (autosave in aanpas-modus). */
  edit?: Draft
}

interface MediaBlob {
  key: string // `${draftId}:${fileId}`
  draftId: string
  fileId: string
  blob: Blob
}

interface Schema extends DBSchema {
  kv: { key: string; value: { k: string; v: unknown } }
  drafts: { key: string; value: Draft }
  media: { key: string; value: MediaBlob; indexes: { draftId: string } }
  outbox: { key: string; value: OutboxEntry }
}

let dbp: Promise<IDBPDatabase<Schema>> | null = null
function db(): Promise<IDBPDatabase<Schema>> {
  if (!dbp) {
    dbp = openDB<Schema>('memorylane-onderweg', 1, {
      upgrade(d) {
        d.createObjectStore('kv', { keyPath: 'k' })
        d.createObjectStore('drafts', { keyPath: 'id' })
        const m = d.createObjectStore('media', { keyPath: 'key' })
        m.createIndex('draftId', 'draftId')
        d.createObjectStore('outbox', { keyPath: 'memoryId' })
      },
    })
  }
  return dbp
}

// ---- pairing + settings (kv) ----
export async function getPairing(): Promise<Pairing | null> {
  return ((await (await db()).get('kv', 'pairing'))?.v as Pairing | undefined) ?? null
}
export async function setPairing(p: Pairing): Promise<void> {
  await (await db()).put('kv', { k: 'pairing', v: p })
}
export async function clearPairing(): Promise<void> {
  await (await db()).delete('kv', 'pairing')
}
export async function getKv<T>(k: string): Promise<T | null> {
  return ((await (await db()).get('kv', k))?.v as T | undefined) ?? null
}
export async function setKv(k: string, v: unknown): Promise<void> {
  await (await db()).put('kv', { k, v })
}

// ---- concepten ----
export async function saveDraft(draft: Draft): Promise<void> {
  await (await db()).put('drafts', draft)
}
export async function getDraft(id: string): Promise<Draft | null> {
  return (await (await db()).get('drafts', id)) ?? null
}
export async function listDrafts(): Promise<Draft[]> {
  return (await (await db()).getAll('drafts')).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}
export async function deleteDraft(id: string): Promise<void> {
  const d = await db()
  const keys = await d.getAllKeysFromIndex('media', 'draftId', id)
  const tx = d.transaction(['drafts', 'media'], 'readwrite')
  await tx.objectStore('drafts').delete(id)
  for (const k of keys) await tx.objectStore('media').delete(k)
  await tx.done
}

// ---- media-bytes ----
const mediaKey = (draftId: string, fileId: string): string => `${draftId}:${fileId}`
export async function putMedia(draftId: string, fileId: string, blob: Blob): Promise<void> {
  await (await db()).put('media', { key: mediaKey(draftId, fileId), draftId, fileId, blob })
}
export async function getMedia(draftId: string, fileId: string): Promise<Blob | null> {
  return (await (await db()).get('media', mediaKey(draftId, fileId)))?.blob ?? null
}
export async function deleteMedia(draftId: string, fileId: string): Promise<void> {
  await (await db()).delete('media', mediaKey(draftId, fileId))
}

// ---- outbox ----
export async function putOutbox(e: OutboxEntry): Promise<void> {
  await (await db()).put('outbox', e)
}
/** Pure samenvoeg-regel van `patchOutbox`: velden uit `patch` winnen, `undefined`
 * wist, alles wat niet in `patch` staat (snapshot, thumbs) blijft. */
export function mergeOutbox(cur: OutboxEntry, patch: Partial<OutboxEntry>): OutboxEntry {
  const next: OutboxEntry = { ...cur, ...patch, memoryId: cur.memoryId }
  for (const k of Object.keys(patch) as (keyof OutboxEntry)[]) if (patch[k] === undefined) delete next[k]
  return next
}
/** Werk velden van een bestaande rij bij (lezen + schrijven in één transactie),
 * zodat een statuswijziging nooit de bewaarde `draft`/`thumbs` overschrijft.
 * Een `undefined`-waarde in `patch` wist dat veld. Geen rij → no-op. */
export async function patchOutbox(memoryId: string, patch: Partial<OutboxEntry>): Promise<OutboxEntry | null> {
  const tx = (await db()).transaction('outbox', 'readwrite')
  const cur = await tx.store.get(memoryId)
  if (!cur) {
    await tx.done
    return null
  }
  const next = mergeOutbox(cur, patch)
  await tx.store.put(next)
  await tx.done
  return next
}
/** Concept → outbox in één transactie: de rij met snapshot erin, de concept-rij
 * eruit. De media-blobs blijven staan (ze horen nu bij de outbox-rij). */
export async function moveDraftToOutbox(draftId: string, entry: OutboxEntry): Promise<void> {
  const tx = (await db()).transaction(['drafts', 'outbox'], 'readwrite')
  await tx.objectStore('outbox').put(entry)
  await tx.objectStore('drafts').delete(draftId)
  await tx.done
}
/** Oude rij vervangen door een nieuwe (aanpassen = nieuw memoryId) in één transactie. */
export async function replaceOutbox(oldMemoryId: string, entry: OutboxEntry): Promise<void> {
  const tx = (await db()).transaction('outbox', 'readwrite')
  await tx.store.delete(oldMemoryId)
  await tx.store.put(entry)
  await tx.done
}
/** Verwijder de media-blobs van `draftId`, tenzij een concept of een andere
 * outbox-rij ze nog gebruikt. */
export async function deleteMediaIfUnused(draftId: string, exceptMemoryId?: string): Promise<void> {
  const d = await db()
  if (await d.get('drafts', draftId)) return
  const rows = await d.getAll('outbox')
  if (rows.some((r) => r.memoryId !== exceptMemoryId && r.draft?.id === draftId)) return
  const keys = await d.getAllKeysFromIndex('media', 'draftId', draftId)
  const tx = d.transaction('media', 'readwrite')
  for (const k of keys) await tx.store.delete(k)
  await tx.done
}
export async function getOutbox(memoryId: string): Promise<OutboxEntry | null> {
  return (await (await db()).get('outbox', memoryId)) ?? null
}
export async function listOutbox(): Promise<OutboxEntry[]> {
  return (await (await db()).getAll('outbox')).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}
export async function deleteOutbox(memoryId: string): Promise<void> {
  await (await db()).delete('outbox', memoryId)
}
