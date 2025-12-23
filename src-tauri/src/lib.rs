use tauri_plugin_sql::{Migration, MigrationKind};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let migrations = vec![
    Migration {
      version: 1,
      description: "create_initial_tables",
      sql: r#"
        CREATE TABLE IF NOT EXISTS events (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL CHECK(type IN ('year', 'period', 'event', 'item')),
          title TEXT,
          start_at TEXT NOT NULL,
          end_at TEXT,
          parent_id TEXT REFERENCES events(id),
          cover_media_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS items (
          id TEXT PRIMARY KEY,
          event_id TEXT NOT NULL REFERENCES events(id),
          item_type TEXT NOT NULL CHECK(item_type IN ('text', 'photo', 'video', 'link')),
          content TEXT NOT NULL,
          caption TEXT,
          happened_at TEXT,
          place_lat REAL,
          place_lng REAL,
          place_label TEXT
        );
        CREATE TABLE IF NOT EXISTS canvas_items (
          event_id TEXT NOT NULL REFERENCES events(id),
          item_id TEXT NOT NULL REFERENCES items(id),
          x REAL NOT NULL DEFAULT 0,
          y REAL NOT NULL DEFAULT 0,
          scale REAL NOT NULL DEFAULT 1,
          rotation REAL NOT NULL DEFAULT 0,
          z_index INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (event_id, item_id)
        );
        CREATE INDEX IF NOT EXISTS idx_events_parent ON events(parent_id);
        CREATE INDEX IF NOT EXISTS idx_events_start ON events(start_at);
        CREATE INDEX IF NOT EXISTS idx_items_event ON items(event_id);
      "#,
      kind: MigrationKind::Up,
    },
  ];

  tauri::Builder::default()
    .plugin(
      tauri_plugin_sql::Builder::default()
        .add_migrations("sqlite:lifeline.db", migrations)
        .build(),
    )
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
