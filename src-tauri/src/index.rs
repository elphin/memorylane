//! SQLite-index: een weggooibare cache afgeleid van de vault.
//!
//! De index leeft in `app_data_dir`, nooit in de vault zelf. De index wordt
//! volledig herbouwd uit een [`VaultModel`] (fase 1 = full rebuild; incrementele
//! sync via een file-watcher volgt in fase 9). Queries lezen alleen hieruit.

use rusqlite::{params, Connection};
use serde::Serialize;

use crate::model::{
    CanvasItem, Event, EventKind, IndexError, Item, ItemType, Location, Severity, VaultModel, Year,
};

const SCHEMA: &str = r#"
CREATE TABLE years (
    id TEXT PRIMARY KEY, year INTEGER NOT NULL, title TEXT NOT NULL,
    start_at TEXT NOT NULL, end_at TEXT, folder_name TEXT NOT NULL
);
CREATE TABLE events (
    id TEXT PRIMARY KEY, year_id TEXT NOT NULL, kind TEXT NOT NULL,
    title TEXT, description TEXT, start_at TEXT NOT NULL, end_at TEXT,
    location_lat REAL, location_lng REAL, location_label TEXT,
    featured_photo TEXT, tags TEXT NOT NULL, folder_path TEXT NOT NULL
);
CREATE TABLE items (
    id TEXT PRIMARY KEY, event_id TEXT NOT NULL, item_type TEXT NOT NULL,
    media TEXT, url TEXT, caption TEXT, happened_at TEXT, timestamp_ms INTEGER,
    place_lat REAL, place_lng REAL, place_label TEXT,
    people TEXT NOT NULL, tags TEXT NOT NULL, category TEXT, body_text TEXT,
    slug TEXT, synthetic INTEGER NOT NULL
);
CREATE TABLE canvas_items (
    event_id TEXT NOT NULL, item_ref TEXT NOT NULL,
    x REAL, y REAL, scale REAL, rotation REAL, z_index INTEGER,
    text_scale REAL, width REAL, height REAL
);
CREATE TABLE index_errors (path TEXT, severity TEXT, reason TEXT);
-- Content-hash memo: vermijdt her-hashen van ongewijzigde media (mtime+size).
-- Blijft bestaan over rebuilds heen (niet geleegd in `load`).
CREATE TABLE media_hash (
    path TEXT PRIMARY KEY, mtime_ms INTEGER NOT NULL, size INTEGER NOT NULL, hash TEXT NOT NULL
);
CREATE INDEX idx_events_year ON events(year_id);
CREATE INDEX idx_items_event ON items(event_id);
CREATE INDEX idx_items_ts ON items(timestamp_ms);
CREATE INDEX idx_canvas_event ON canvas_items(event_id);
CREATE VIRTUAL TABLE items_fts USING fts5(item_id UNINDEXED, caption, body_text, tokenize='unicode61');
"#;

/// Maakt een in-memory database met het volledige schema (voor tests én als
/// basis voor de app-connectie).
pub fn open_in_memory() -> rusqlite::Result<Connection> {
    let conn = Connection::open_in_memory()?;
    conn.execute_batch(SCHEMA)?;
    Ok(conn)
}

/// Herbouwt de index volledig uit het model (idempotent).
pub fn load(conn: &mut Connection, model: &VaultModel) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    // media_hash bewust NIET geleegd: het is een content-hash-cache die geldig
    // blijft zolang mtime+size kloppen.
    tx.execute_batch(
        "DELETE FROM years; DELETE FROM events; DELETE FROM items;
         DELETE FROM canvas_items; DELETE FROM index_errors; DELETE FROM items_fts;",
    )?;

    for y in &model.years {
        tx.execute(
            "INSERT INTO years (id, year, title, start_at, end_at, folder_name)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![y.id, y.year, y.title, y.start_at, y.end_at, y.folder_name],
        )?;
    }

    for e in &model.events {
        let (lat, lng, label) = split_location(&e.location);
        tx.execute(
            "INSERT INTO events (id, year_id, kind, title, description, start_at, end_at,
                 location_lat, location_lng, location_label, featured_photo, tags, folder_path)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
            params![
                e.id,
                e.year_id,
                e.kind.as_str(),
                e.title,
                e.description,
                e.start_at,
                e.end_at,
                lat,
                lng,
                label,
                e.featured_photo,
                json(&e.tags),
                e.folder_path,
            ],
        )?;
    }

    {
        let mut item_stmt = tx.prepare(
            "INSERT INTO items (id, event_id, item_type, media, url, caption, happened_at,
                 timestamp_ms, place_lat, place_lng, place_label, people, tags, category,
                 body_text, slug, synthetic)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)",
        )?;
        let mut fts_stmt =
            tx.prepare("INSERT INTO items_fts (item_id, caption, body_text) VALUES (?1, ?2, ?3)")?;
        for it in &model.items {
            let (lat, lng, label) = split_location(&it.place);
            item_stmt.execute(params![
                it.id,
                it.event_id,
                it.item_type.as_str(),
                it.media,
                it.url,
                it.caption,
                it.happened_at,
                it.timestamp_ms,
                lat,
                lng,
                label,
                json(&it.people),
                json(&it.tags),
                it.category,
                it.body_text,
                it.slug,
                it.synthetic as i64,
            ])?;
            // Alleen indexeren als er doorzoekbare tekst is (geen lege rijen).
            if it.caption.is_some() || it.body_text.is_some() {
                fts_stmt.execute(params![it.id, it.caption, it.body_text])?;
            }
        }

        let mut canvas_stmt = tx.prepare(
            "INSERT INTO canvas_items (event_id, item_ref, x, y, scale, rotation, z_index,
                 text_scale, width, height)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
        )?;
        for c in &model.canvas_items {
            canvas_stmt.execute(params![
                c.event_id,
                c.item_ref,
                c.x,
                c.y,
                c.scale,
                c.rotation,
                c.z_index,
                c.text_scale,
                c.width,
                c.height,
            ])?;
        }

        let mut err_stmt =
            tx.prepare("INSERT INTO index_errors (path, severity, reason) VALUES (?1, ?2, ?3)")?;
        for e in &model.errors {
            err_stmt.execute(params![e.path, severity_str(e.severity), e.reason])?;
        }
    }

    tx.commit()
}

// ---- Query-DTO's (camelCase naar de webview) -----------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YearSummary {
    pub id: String,
    pub year: i32,
    pub title: String,
    pub start_at: String,
    pub end_at: Option<String>,
    pub event_count: i64,
    pub item_count: i64,
    /// Representatieve foto voor de lifeline-tegel (eerste gedateerde foto).
    pub cover_item_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventSummary {
    pub id: String,
    pub kind: EventKind,
    pub title: Option<String>,
    pub start_at: String,
    pub end_at: Option<String>,
    pub item_count: i64,
    pub cover_item_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YearDetail {
    pub year: Year,
    pub events: Vec<EventSummary>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventDetail {
    pub event: Event,
    pub items: Vec<Item>,
    pub canvas: Vec<CanvasItem>,
}

/// Een foto/video van een jaar voor de L1-collage (ook ongedateerde items).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YearPhoto {
    pub item_id: String,
    pub item_type: ItemType,
    pub event_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DensityPoint {
    pub timestamp_ms: i64,
    pub item_type: ItemType,
    pub item_id: String,
    pub event_id: String,
    pub event_title: Option<String>,
}

// ---- Queries -------------------------------------------------------------

pub fn list_years(conn: &Connection) -> rusqlite::Result<Vec<YearSummary>> {
    let mut stmt = conn.prepare(
        "SELECT y.id, y.year, y.title, y.start_at, y.end_at,
             (SELECT count(*) FROM events e WHERE e.year_id = y.id),
             (SELECT count(*) FROM items i JOIN events e ON i.event_id = e.id WHERE e.year_id = y.id),
             (SELECT i.id FROM items i JOIN events e ON i.event_id = e.id
                 WHERE e.year_id = y.id AND i.item_type = 'photo'
                 ORDER BY (i.timestamp_ms IS NULL), i.timestamp_ms LIMIT 1)
         FROM years y ORDER BY y.year",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(YearSummary {
            id: r.get(0)?,
            year: r.get(1)?,
            title: r.get(2)?,
            start_at: r.get(3)?,
            end_at: r.get(4)?,
            event_count: r.get(5)?,
            item_count: r.get(6)?,
            cover_item_id: r.get(7)?,
        })
    })?;
    rows.collect()
}

pub fn get_year(conn: &Connection, year_id: &str) -> rusqlite::Result<Option<YearDetail>> {
    let year = conn
        .query_row(
            "SELECT id, year, title, start_at, end_at, folder_name FROM years WHERE id = ?1",
            params![year_id],
            |r| {
                Ok(Year {
                    id: r.get(0)?,
                    year: r.get(1)?,
                    title: r.get(2)?,
                    start_at: r.get(3)?,
                    end_at: r.get(4)?,
                    folder_name: r.get(5)?,
                })
            },
        )
        .ok();
    let Some(year) = year else {
        return Ok(None);
    };

    let mut stmt = conn.prepare(
        "SELECT e.id, e.kind, e.title, e.start_at, e.end_at,
             (SELECT count(*) FROM items i WHERE i.event_id = e.id),
             (SELECT i.id FROM items i WHERE i.event_id = e.id AND i.item_type = 'photo'
                 ORDER BY (i.timestamp_ms IS NULL), i.timestamp_ms LIMIT 1)
         FROM events e WHERE e.year_id = ?1 ORDER BY e.start_at",
    )?;
    let events = stmt
        .query_map(params![year_id], |r| {
            let kind: String = r.get(1)?;
            Ok(EventSummary {
                id: r.get(0)?,
                kind: EventKind::parse(&kind).unwrap_or(EventKind::Event),
                title: r.get(2)?,
                start_at: r.get(3)?,
                end_at: r.get(4)?,
                item_count: r.get(5)?,
                cover_item_id: r.get(6)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    Ok(Some(YearDetail { year, events }))
}

pub fn get_event(conn: &Connection, event_id: &str) -> rusqlite::Result<Option<EventDetail>> {
    let event = conn
        .query_row(
            "SELECT id, year_id, kind, title, description, start_at, end_at,
                 location_lat, location_lng, location_label, featured_photo, tags, folder_path
             FROM events WHERE id = ?1",
            params![event_id],
            row_to_event,
        )
        .ok();
    let Some(event) = event else {
        return Ok(None);
    };

    let mut items_stmt = conn.prepare(
        "SELECT id, event_id, item_type, media, url, caption, happened_at, timestamp_ms,
             place_lat, place_lng, place_label, people, tags, category, body_text, slug, synthetic
         FROM items WHERE event_id = ?1 ORDER BY timestamp_ms, slug",
    )?;
    let items = items_stmt
        .query_map(params![event_id], row_to_item)?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut canvas_stmt = conn.prepare(
        "SELECT event_id, item_ref, x, y, scale, rotation, z_index, text_scale, width, height
         FROM canvas_items WHERE event_id = ?1 ORDER BY z_index",
    )?;
    let canvas = canvas_stmt
        .query_map(params![event_id], |r| {
            Ok(CanvasItem {
                event_id: r.get(0)?,
                item_ref: r.get(1)?,
                x: r.get(2)?,
                y: r.get(3)?,
                scale: r.get(4)?,
                rotation: r.get(5)?,
                z_index: r.get(6)?,
                text_scale: r.get(7)?,
                width: r.get(8)?,
                height: r.get(9)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    Ok(Some(EventDetail {
        event,
        items,
        canvas,
    }))
}

pub fn get_timeline_density(
    conn: &Connection,
    year_id: &str,
) -> rusqlite::Result<Vec<DensityPoint>> {
    let mut stmt = conn.prepare(
        "SELECT i.timestamp_ms, i.item_type, i.id, i.event_id, e.title
         FROM items i JOIN events e ON i.event_id = e.id
         WHERE e.year_id = ?1 AND i.timestamp_ms IS NOT NULL
         ORDER BY i.timestamp_ms",
    )?;
    let rows = stmt.query_map(params![year_id], |r| {
        let t: String = r.get(1)?;
        Ok(DensityPoint {
            timestamp_ms: r.get(0)?,
            item_type: ItemType::parse(&t).unwrap_or(ItemType::Photo),
            item_id: r.get(2)?,
            event_id: r.get(3)?,
            event_title: r.get(4)?,
        })
    })?;
    rows.collect()
}

/// Vault-relatieve folder + mediabestandsnaam voor een item (voor `thumb://`).
/// `None` als het item niet bestaat of geen media heeft.
pub fn item_media_ref(
    conn: &Connection,
    item_id: &str,
) -> rusqlite::Result<Option<(String, String)>> {
    let row = conn
        .query_row(
            "SELECT e.folder_path, i.media
             FROM items i JOIN events e ON i.event_id = e.id
             WHERE i.id = ?1 AND i.media IS NOT NULL",
            params![item_id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .ok();
    Ok(row)
}

/// Gememoiseerde content-hash voor `path`, geldig als mtime+size ongewijzigd.
pub fn cached_hash(
    conn: &Connection,
    path: &str,
    mtime_ms: i64,
    size: i64,
) -> rusqlite::Result<Option<String>> {
    let hash = conn
        .query_row(
            "SELECT hash FROM media_hash WHERE path = ?1 AND mtime_ms = ?2 AND size = ?3",
            params![path, mtime_ms, size],
            |r| r.get::<_, String>(0),
        )
        .ok();
    Ok(hash)
}

/// Slaat een content-hash op in de memo (upsert op pad).
pub fn put_hash(
    conn: &Connection,
    path: &str,
    mtime_ms: i64,
    size: i64,
    hash: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO media_hash (path, mtime_ms, size, hash) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(path) DO UPDATE SET mtime_ms = ?2, size = ?3, hash = ?4",
        params![path, mtime_ms, size, hash],
    )?;
    Ok(())
}

/// Alle foto's/video's van een jaar voor de L1-collage. Anders dan de density
/// (die getimestampte items op de tijdlijn plaatst) neemt dit ook ONgedateerde
/// items mee, zodat een jaar vol foto's zonder EXIF-datum niet leeg oogt.
pub fn list_year_photos(conn: &Connection, year_id: &str) -> rusqlite::Result<Vec<YearPhoto>> {
    let mut stmt = conn.prepare(
        "SELECT i.id, i.item_type, i.event_id
         FROM items i JOIN events e ON i.event_id = e.id
         WHERE e.year_id = ?1 AND i.item_type IN ('photo', 'video')
         ORDER BY (i.timestamp_ms IS NULL), i.timestamp_ms, i.slug",
    )?;
    let rows = stmt.query_map(params![year_id], |r| {
        let t: String = r.get(1)?;
        Ok(YearPhoto {
            item_id: r.get(0)?,
            item_type: ItemType::parse(&t).unwrap_or(ItemType::Photo),
            event_id: r.get(2)?,
        })
    })?;
    rows.collect()
}

/// Vault-relatieve folder van een event (voor het schrijven van `_canvas.json`).
pub fn event_folder(conn: &Connection, event_id: &str) -> rusqlite::Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT folder_path FROM events WHERE id = ?1",
            params![event_id],
            |r| r.get::<_, String>(0),
        )
        .ok())
}

/// Vervangt de canvas-items van een event in de index (na een schrijf naar file).
pub fn replace_canvas(
    conn: &Connection,
    event_id: &str,
    items: &[CanvasItem],
) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM canvas_items WHERE event_id = ?1", params![event_id])?;
    let mut stmt = conn.prepare(
        "INSERT INTO canvas_items (event_id, item_ref, x, y, scale, rotation, z_index,
             text_scale, width, height)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
    )?;
    for c in items {
        stmt.execute(params![
            c.event_id,
            c.item_ref,
            c.x,
            c.y,
            c.scale,
            c.rotation,
            c.z_index,
            c.text_scale,
            c.width,
            c.height,
        ])?;
    }
    Ok(())
}

pub fn get_index_errors(conn: &Connection) -> rusqlite::Result<Vec<IndexError>> {
    let mut stmt =
        conn.prepare("SELECT path, severity, reason FROM index_errors ORDER BY severity, path")?;
    let rows = stmt.query_map([], |r| {
        let sev: String = r.get(1)?;
        Ok(IndexError {
            path: r.get(0)?,
            severity: if sev == "error" {
                Severity::Error
            } else {
                Severity::Warning
            },
            reason: r.get(2)?,
        })
    })?;
    rows.collect()
}

// ---- row-mappers & helpers -----------------------------------------------

fn row_to_event(r: &rusqlite::Row) -> rusqlite::Result<Event> {
    let kind: String = r.get(2)?;
    let tags: String = r.get(11)?;
    Ok(Event {
        id: r.get(0)?,
        year_id: r.get(1)?,
        kind: EventKind::parse(&kind).unwrap_or(EventKind::Event),
        title: r.get(3)?,
        description: r.get(4)?,
        start_at: r.get(5)?,
        end_at: r.get(6)?,
        location: build_location(r.get(7)?, r.get(8)?, r.get(9)?),
        featured_photo: r.get(10)?,
        tags: parse_json_vec(&tags),
        folder_path: r.get(12)?,
    })
}

fn row_to_item(r: &rusqlite::Row) -> rusqlite::Result<Item> {
    let item_type: String = r.get(2)?;
    let people: String = r.get(11)?;
    let tags: String = r.get(12)?;
    let synthetic: i64 = r.get(16)?;
    Ok(Item {
        id: r.get(0)?,
        event_id: r.get(1)?,
        item_type: ItemType::parse(&item_type).unwrap_or(ItemType::Text),
        media: r.get(3)?,
        url: r.get(4)?,
        caption: r.get(5)?,
        happened_at: r.get(6)?,
        timestamp_ms: r.get(7)?,
        place: build_location(r.get(8)?, r.get(9)?, r.get(10)?),
        people: parse_json_vec(&people),
        tags: parse_json_vec(&tags),
        category: r.get(13)?,
        body_text: r.get(14)?,
        slug: r.get(15)?,
        synthetic: synthetic != 0,
    })
}

fn split_location(loc: &Option<Location>) -> (Option<f64>, Option<f64>, Option<String>) {
    match loc {
        Some(l) => (Some(l.lat), Some(l.lng), l.label.clone()),
        None => (None, None, None),
    }
}

fn build_location(
    lat: Option<f64>,
    lng: Option<f64>,
    label: Option<String>,
) -> Option<Location> {
    match (lat, lng) {
        (Some(lat), Some(lng)) => Some(Location { lat, lng, label }),
        _ => None,
    }
}

fn json(v: &[String]) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| "[]".to_string())
}

fn parse_json_vec(s: &str) -> Vec<String> {
    serde_json::from_str(s).unwrap_or_default()
}

fn severity_str(s: Severity) -> &'static str {
    match s {
        Severity::Error => "error",
        Severity::Warning => "warning",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// FTS5 moet beschikbaar zijn in de gebundelde SQLite — harde eis voor zoek.
    #[test]
    fn fts5_is_available() {
        let conn = open_in_memory().expect("open in-memory db");
        conn.execute_batch("CREATE VIRTUAL TABLE t USING fts5(content);")
            .expect("FTS5 virtual table");
    }

    fn sample_model() -> VaultModel {
        let mut m = VaultModel::default();
        m.years.push(Year {
            id: "y2024".into(),
            year: 2024,
            title: "2024".into(),
            start_at: "2024-01-01".into(),
            end_at: Some("2024-12-31".into()),
            folder_name: "2024".into(),
        });
        m.events.push(Event {
            id: "ev1".into(),
            kind: EventKind::Event,
            title: Some("Palermo".into()),
            description: None,
            start_at: "2024-11-23".into(),
            end_at: None,
            location: Some(Location {
                lat: 38.1,
                lng: 13.3,
                label: Some("Palermo".into()),
            }),
            featured_photo: None,
            tags: vec!["vakantie".into()],
            year_id: "y2024".into(),
            folder_path: "2024/2024-11-23 palermo".into(),
        });
        m.items.push(Item {
            id: "it1".into(),
            event_id: "ev1".into(),
            item_type: ItemType::Photo,
            media: Some("strand.jpg".into()),
            url: None,
            caption: Some("Strand bij zonsondergang".into()),
            happened_at: Some("2024-11-23".into()),
            timestamp_ms: Some(1_700_000_000_000),
            place: None,
            people: vec![],
            tags: vec![],
            category: Some("vakantie".into()),
            body_text: None,
            slug: Some("strand".into()),
            synthetic: false,
        });
        m.canvas_items.push(CanvasItem {
            event_id: "ev1".into(),
            item_ref: "strand".into(),
            x: 10.0,
            y: -5.0,
            scale: 1.0,
            rotation: 0.0,
            z_index: 0,
            text_scale: None,
            width: Some(200.0),
            height: Some(150.0),
        });
        m.errors.push(IndexError {
            path: "2024/x/dup.md".into(),
            severity: Severity::Warning,
            reason: "duplicaat".into(),
        });
        m
    }

    #[test]
    fn load_and_query_roundtrip() {
        let mut conn = open_in_memory().unwrap();
        load(&mut conn, &sample_model()).unwrap();

        let years = list_years(&conn).unwrap();
        assert_eq!(years.len(), 1);
        assert_eq!(years[0].event_count, 1);
        assert_eq!(years[0].item_count, 1);
        assert_eq!(years[0].cover_item_id.as_deref(), Some("it1"));

        let yd = get_year(&conn, "y2024").unwrap().unwrap();
        assert_eq!(yd.events.len(), 1);
        assert_eq!(yd.events[0].item_count, 1);
        assert_eq!(yd.events[0].cover_item_id.as_deref(), Some("it1"));

        let ed = get_event(&conn, "ev1").unwrap().unwrap();
        assert_eq!(ed.event.title.as_deref(), Some("Palermo"));
        assert_eq!(ed.event.location.as_ref().unwrap().label.as_deref(), Some("Palermo"));
        assert_eq!(ed.items.len(), 1);
        assert_eq!(ed.items[0].category.as_deref(), Some("vakantie"));
        assert_eq!(ed.canvas.len(), 1);
        assert_eq!(ed.canvas[0].width, Some(200.0));

        let density = get_timeline_density(&conn, "y2024").unwrap();
        assert_eq!(density.len(), 1);
        assert_eq!(density[0].item_type, ItemType::Photo);

        let errors = get_index_errors(&conn).unwrap();
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].severity, Severity::Warning);
    }

    #[test]
    fn load_is_idempotent() {
        let mut conn = open_in_memory().unwrap();
        load(&mut conn, &sample_model()).unwrap();
        load(&mut conn, &sample_model()).unwrap();
        assert_eq!(list_years(&conn).unwrap().len(), 1);
        assert_eq!(get_event(&conn, "ev1").unwrap().unwrap().items.len(), 1);
    }

    #[test]
    fn fts_search_finds_caption() {
        let mut conn = open_in_memory().unwrap();
        load(&mut conn, &sample_model()).unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM items_fts WHERE items_fts MATCH 'zonsondergang'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn year_photos_include_undated() {
        let mut m = sample_model();
        // Voeg een foto zonder timestamp toe aan hetzelfde event.
        m.items.push(Item {
            id: "it2".into(),
            event_id: "ev1".into(),
            item_type: ItemType::Photo,
            media: Some("geen-datum.jpg".into()),
            url: None,
            caption: None,
            happened_at: None,
            timestamp_ms: None,
            place: None,
            people: vec![],
            tags: vec![],
            category: None,
            body_text: None,
            slug: Some("geen-datum".into()),
            synthetic: false,
        });
        let mut conn = open_in_memory().unwrap();
        load(&mut conn, &m).unwrap();

        // Density laat de ongedateerde foto weg...
        assert_eq!(get_timeline_density(&conn, "y2024").unwrap().len(), 1);
        // ...maar de collage-query neemt beide mee.
        let photos = list_year_photos(&conn, "y2024").unwrap();
        assert_eq!(photos.len(), 2);
        assert!(photos.iter().any(|p| p.item_id == "it2"));
    }

    #[test]
    fn missing_year_returns_none() {
        let conn = open_in_memory().unwrap();
        assert!(get_year(&conn, "nope").unwrap().is_none());
        assert!(get_event(&conn, "nope").unwrap().is_none());
    }
}
