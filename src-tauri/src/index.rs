//! SQLite-index: een weggooibare cache afgeleid van de vault.
//!
//! De index leeft in `app_data_dir`, nooit in de vault zelf. Fase 1
//! implementeert hier het schema, reconcile en de query-laag (FTS5).

use rusqlite::Connection;

/// Opent een in-memory database. Fase 1 vervangt dit door de echte
/// schema-setup met WAL op een bestand in `app_data_dir`.
#[allow(dead_code)] // skelet: eerste caller komt in fase 1; tests gebruiken het al
pub fn open_in_memory() -> rusqlite::Result<Connection> {
    Connection::open_in_memory()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// FTS5 moet beschikbaar zijn in de gebundelde SQLite —
    /// harde eis voor de zoekfunctie (plan §2).
    #[test]
    fn fts5_is_available() {
        let conn = open_in_memory().expect("open in-memory db");
        conn.execute_batch("CREATE VIRTUAL TABLE t USING fts5(content);")
            .expect("FTS5 virtual table");
    }
}
