// Envelope-JSON (§8.2): de metadata van een memory, plaintext vóór versleuteling.

import type { Draft } from '../store/db'

export interface EnvelopeFile {
  fileId: string
  name: string
  mime: string
  plainBytes: number
  order: number
}

export interface Envelope {
  v: 1
  memoryId: string
  title: string
  startAt: string
  endAt?: string
  note?: string
  createdAt: string
  files: EnvelopeFile[]
}

/** Bouw de envelope-JSON-bytes voor een concept. `endAt`/`note` worden weggelaten
 * als ze leeg zijn (spiegelt de optionele velden in de vault). */
export function buildEnvelopeBytes(draft: Draft, memoryId: string, createdAt: string): Uint8Array {
  const env: Envelope = {
    v: 1,
    memoryId,
    title: draft.title.trim(),
    startAt: draft.startAt,
    createdAt,
    files: draft.media.map((m, i) => ({
      fileId: m.fileId,
      name: m.name,
      mime: m.mime,
      plainBytes: m.plainBytes,
      order: i,
    })),
  }
  if (draft.endAt) env.endAt = draft.endAt
  if (draft.note.trim()) env.note = draft.note
  return new TextEncoder().encode(JSON.stringify(env))
}
