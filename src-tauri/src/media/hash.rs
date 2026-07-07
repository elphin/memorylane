//! Content-hashing van mediabestanden (BLAKE3).
//!
//! De hash is de cache-sleutel voor thumbnails: identieke inhoud → dezelfde
//! thumbnail, ongeacht pad of bestandsnaam. Om niet elk bestand bij elke run
//! opnieuw te hashen, memoiseert de indexer op `(mtime, size)` — die memoisatie
//! leeft in de index-DB (fase 3b), niet hier.

use std::path::Path;

/// Hasht de volledige inhoud van een bestand en geeft een hex-string terug.
pub fn hash_file(path: &Path) -> std::io::Result<String> {
    let bytes = std::fs::read(path)?;
    Ok(hash_bytes(&bytes))
}

/// Hasht een byte-buffer (BLAKE3, hex).
pub fn hash_bytes(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}
