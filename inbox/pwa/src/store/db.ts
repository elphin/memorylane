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

export interface OutboxEntry {
  memoryId: string
  title: string
  startAt: string
  mediaCount: number
  createdAt: string
  status: 'uploading' | 'ready' | 'imported' | 'failed'
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
export async function getOutbox(memoryId: string): Promise<OutboxEntry | null> {
  return (await (await db()).get('outbox', memoryId)) ?? null
}
export async function listOutbox(): Promise<OutboxEntry[]> {
  return (await (await db()).getAll('outbox')).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}
export async function deleteOutbox(memoryId: string): Promise<void> {
  await (await db()).delete('outbox', memoryId)
}
