// Request/response-types voor de brievenbus-API (§5.5). Fase 3 (PWA) hergebruikt
// deze; ze worden dan naar inbox/shared/ verplaatst.

export interface ApiError {
  error: { code: string; message: string }
}

// POST /api/mailboxes
export interface RegisterMailboxBody {
  mailboxId: string
  ownerTokenHash: string
  uploadTokenHash: string
}

// POST /api/mailboxes/rotate-upload-token
export interface RotateUploadTokenBody {
  uploadTokenHash: string
}

// POST /api/memories
export interface CreateMemoryBody {
  memoryId: string
  files: { fileId: string; bytes: number }[]
  envelopeBytes: number
}
export interface CreateMemoryResponse {
  uploadUrls: Record<string, string> // { envelope: url, [fileId]: url }
}

// POST /api/memories/:id/complete → 200 { status:'ready' } of 409 met missing[]
export interface CompleteResponse {
  status: 'ready'
}
export interface CompleteConflict {
  error: { code: 'incomplete'; message: string }
  missing: string[] // fileIds (of 'envelope') die ontbreken/afwijken
}

// GET /api/memories?status=ready (owner)
export interface ReadyMemory {
  memoryId: string
  fileCount: number
  totalBytes: number
  createdAt: string
}

// GET /api/memories/:id/urls (owner) → de map direct: { envelope: url, [fileId]: url }
export type MemoryUrlsResponse = Record<string, string>

// GET /api/memories/count?status=ready (owner)
export interface CountResponse {
  count: number
}

// GET /api/outbox (upload)
export interface OutboxEntry {
  memoryId: string
  status: 'uploading' | 'ready' | 'imported'
  createdAt: string
}
