-- MemoryLane Onderweg — D1-schema (brievenbus-administratie).
-- Zie §5.2 van MOBILE_INBOX_PLAN.md. Alle queries via prepared statements (bind()),
-- nooit string-interpolatie.

CREATE TABLE mailboxes (
  id                TEXT PRIMARY KEY,             -- uuid, door desktop gegenereerd
  owner_token_hash  TEXT NOT NULL,                -- hex(SHA-256(token))
  upload_token_hash TEXT NOT NULL,
  created_at        TEXT NOT NULL,                -- ISO-8601 UTC
  last_seen_at      TEXT
);

CREATE TABLE memories (
  id           TEXT NOT NULL,                     -- uuid, door telefoon gegenereerd
  mailbox_id   TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  status       TEXT NOT NULL CHECK (status IN ('uploading','ready','imported')),
  file_count   INTEGER NOT NULL,
  total_bytes  INTEGER NOT NULL,                  -- som van declared_bytes (ciphertext)
  created_at   TEXT NOT NULL,
  ready_at     TEXT,
  imported_at  TEXT,
  PRIMARY KEY (mailbox_id, id)
);

CREATE TABLE files (
  memory_id      TEXT NOT NULL,
  mailbox_id     TEXT NOT NULL,
  id             TEXT NOT NULL,                   -- fileId (uuid) of het woord 'envelope'
  r2_key         TEXT NOT NULL,
  declared_bytes INTEGER NOT NULL,                -- ciphertext-grootte die de client aankondigt
  uploaded       INTEGER NOT NULL DEFAULT 0,      -- 1 zodra bevestigd via de list-verificatie bij complete
  PRIMARY KEY (mailbox_id, memory_id, id),
  FOREIGN KEY (mailbox_id, memory_id) REFERENCES memories(mailbox_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_memories_status ON memories(mailbox_id, status);

-- Rate limiting (§5.4): één rij per (key, window_start); UPSERT verhoogt count.
CREATE TABLE rate_limits (
  key          TEXT NOT NULL,                     -- bv. "auth:<ip>", "register", "create:<mailbox>"
  window_start TEXT NOT NULL,                     -- ISO-8601 UTC, begin van het venster
  count        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);
