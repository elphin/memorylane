// Validatie + R2-key-helpers. Keys bevatten UITSLUITEND server-gevalideerde
// uuid's (nooit bestandsnamen) → key-injectie uitgesloten (§5.3).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HEX64_RE = /^[0-9a-f]{64}$/i

export const isUuid = (s: unknown): s is string => typeof s === 'string' && UUID_RE.test(s)
export const isHex64 = (s: unknown): s is string => typeof s === 'string' && HEX64_RE.test(s)

/** fileId is 'envelope' óf een uuid. */
export const isFileId = (s: unknown): s is string => s === 'envelope' || isUuid(s)

/** R2-object-key voor één bestand/envelope van een memory. */
export const objKey = (mailboxId: string, memoryId: string, fileId: string): string =>
  `mb/${mailboxId}/${memoryId}/${fileId === 'envelope' ? 'envelope' : fileId}.bin`

/** Prefix van alle objecten van één memory (voor list/delete). */
export const memoryPrefix = (mailboxId: string, memoryId: string): string =>
  `mb/${mailboxId}/${memoryId}/`

export const nowIso = (now = Date.now()): string => new Date(now).toISOString()
