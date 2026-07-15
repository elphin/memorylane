// Client naar de brievenbus-Worker. De telefoon gebruikt uitsluitend het
// upload-token uit de pairing.

import type { Pairing } from '../store/db'

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message)
  }
}

function authHeaders(p: Pairing): Record<string, string> {
  return { 'X-Mailbox': p.mailboxId, Authorization: `Bearer ${p.uploadToken}` }
}

async function req(p: Pairing, path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(p.serverUrl + path, {
    ...init,
    headers: { ...authHeaders(p), ...(init?.headers as Record<string, string> | undefined) },
  })
  if (!res.ok) throw await toError(res)
  return res
}

async function toError(res: Response): Promise<ApiError> {
  let code = 'http'
  let message = `Serverfout (${res.status})`
  try {
    const b = (await res.json()) as { error?: { code?: string; message?: string } }
    if (b.error?.code) code = b.error.code
    if (b.error?.message) message = b.error.message
  } catch {
    /* geen JSON-body */
  }
  return new ApiError(res.status, code, message)
}

export interface CreateResult {
  uploadUrls: Record<string, string> // { envelope: url, [fileId]: url }
}

export async function createMemory(
  p: Pairing,
  memoryId: string,
  files: { fileId: string; bytes: number }[],
  envelopeBytes: number,
): Promise<CreateResult> {
  const res = await req(p, '/api/memories', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ memoryId, files, envelopeBytes }),
  })
  return (await res.json()) as CreateResult
}

export type CompleteResult = { status: 'ready' } | { status: 'incomplete'; missing: string[] }

export async function completeMemory(p: Pairing, memoryId: string): Promise<CompleteResult> {
  const res = await fetch(`${p.serverUrl}/api/memories/${memoryId}/complete`, {
    method: 'POST',
    headers: authHeaders(p),
  })
  if (res.status === 409) {
    const b = (await res.json().catch(() => ({}))) as { error?: { code?: string }; missing?: string[] }
    // Alleen de echte "nog niet compleet" (§5.5) is een resume-signaal; een 409 als
    // already_imported/already_finalized is een eindstatus en moet als fout omhoog.
    if (b.error?.code === 'incomplete') return { status: 'incomplete', missing: b.missing ?? [] }
    throw new ApiError(409, b.error?.code ?? 'conflict', 'Deze memory is al afgerond of geïmporteerd.')
  }
  if (!res.ok) throw await toError(res)
  return { status: 'ready' }
}

export async function deleteMemory(p: Pairing, memoryId: string): Promise<void> {
  await req(p, `/api/memories/${memoryId}`, { method: 'DELETE' })
}

export interface RemoteOutbox {
  memoryId: string
  status: 'uploading' | 'ready' | 'imported'
  createdAt: string
}
export async function fetchOutbox(p: Pairing): Promise<RemoteOutbox[]> {
  const res = await req(p, '/api/outbox')
  return (await res.json()) as RemoteOutbox[]
}

/** Valideert de pairing met een goedkope geauthenticeerde call. */
export async function verifyPairing(p: Pairing): Promise<void> {
  await req(p, '/api/outbox')
}
