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
    start_at TEXT NOT NULL, end_at TEXT, folder_name TEXT NOT NULL, cover_photo TEXT,
    size_factor REAL
);
CREATE TABLE events (
    id TEXT PRIMARY KEY, year_id TEXT NOT NULL, kind TEXT NOT NULL,
    title TEXT, description TEXT, start_at TEXT NOT NULL, end_at TEXT,
    location_lat REAL, location_lng REAL, location_label TEXT,
    featured_photo TEXT, tags TEXT NOT NULL, folder_path TEXT NOT NULL, size INTEGER,
    under_construction INTEGER, synthetic INTEGER NOT NULL
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
CREATE VIRTUAL TABLE items_fts USING fts5(item_id UNINDEXED, caption, body_text, tags, people, place, tokenize='unicode61');
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
            "INSERT INTO years (id, year, title, start_at, end_at, folder_name, cover_photo, size_factor)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![y.id, y.year, y.title, y.start_at, y.end_at, y.folder_name, y.cover, y.size_factor],
        )?;
    }

    for e in &model.events {
        let (lat, lng, label) = split_location(&e.location);
        tx.execute(
            "INSERT INTO events (id, year_id, kind, title, description, start_at, end_at,
                 location_lat, location_lng, location_label, featured_photo, tags, folder_path, size,
                 under_construction, synthetic)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)",
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
                e.size,
                e.under_construction,
                e.synthetic as i64,
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
        let mut fts_stmt = tx.prepare(
            "INSERT INTO items_fts (item_id, caption, body_text, tags, people, place)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )?;
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
            // Indexeer zodra er íets doorzoekbaars is — ook een foto met alleen
            // tags/people/place (anders is die onvindbaar). Tags/people als spatie-
            // gescheiden tekst zodat FTS elk woord als token indexeert.
            let has_text = it.caption.is_some()
                || it.body_text.is_some()
                || !it.tags.is_empty()
                || !it.people.is_empty()
                || label.is_some();
            if has_text {
                fts_stmt.execute(params![
                    it.id,
                    it.caption,
                    it.body_text,
                    it.tags.join(" "),
                    it.people.join(" "),
                    label,
                ])?;
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
    /// Foto-id's van dit jaar (chronologisch, max ~48) — voor de willekeurige
    /// jaar-tegel-slideshow.
    pub photo_ids: Vec<String>,
    /// Uitgelichte foto-id's van dit jaar (de event-omslagen) — voor de
    /// 'uitgelicht'-slideshow. Leeg → val terug op `photo_ids`.
    pub featured_ids: Vec<String>,
    /// Vaste jaar-cover (item-id) indien geprikt — de tegel is dan statisch (geen
    /// slideshow/willekeurig). None = geen pin.
    pub pinned_cover: Option<String>,
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
    /// Foto-id's van dit event (chronologisch, max ~24) — voor de slideshow-roulatie.
    pub photo_ids: Vec<String>,
    /// Grootte/belang op de jaar-tijdlijn (1–100), of None = standaard (50).
    pub size: Option<i64>,
    /// "In aanbouw"-status (badge in de jaar-view). Afwezig/None = false.
    pub under_construction: Option<bool>,
    /// True = synthetische "Losse foto's"-bundel (curatie niet mogelijk).
    pub synthetic: bool,
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
    /// Vaste jaar-cover (item-id) van het jaar waar dit event onder valt, of None.
    /// Voor de tweede ring op L2 en de toggle-vergelijking.
    pub year_cover: Option<String>,
}

/// Een foto/video van een jaar voor de L1-collage (ook ongedateerde items).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YearPhoto {
    pub item_id: String,
    pub item_type: ItemType,
    pub event_id: String,
}

/// Een zoekresultaat (full-text) met genoeg context om naartoe te navigeren.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub item_id: String,
    pub event_id: String,
    pub year_id: String,
    pub event_title: Option<String>,
    pub snippet: String,
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

/// Splitst een `group_concat`-resultaat (`"a,b,c"`) in losse id's; leeg → [].
fn split_ids(joined: Option<String>) -> Vec<String> {
    joined
        .map(|s| s.split(',').filter(|p| !p.is_empty()).map(|p| p.to_string()).collect())
        .unwrap_or_default()
}

pub fn list_years(conn: &Connection) -> rusqlite::Result<Vec<YearSummary>> {
    // event_count = aantal door de gebruiker aangemaakte memories. De synthetische
    // "Losse foto's"-bundel (synthetic = 1) telt NIET mee: dat is geen echte memory.
    let mut stmt = conn.prepare(
        "SELECT y.id, y.year, y.title, y.start_at, y.end_at,
             (SELECT count(*) FROM events e WHERE e.year_id = y.id AND e.synthetic = 0),
             (SELECT count(*) FROM items i JOIN events e ON i.event_id = e.id WHERE e.year_id = y.id),
             COALESCE(
               (SELECT i.id FROM items i JOIN events e ON i.event_id = e.id
                  WHERE e.year_id = y.id AND i.item_type = 'photo' AND i.id = y.cover_photo LIMIT 1),
               (SELECT i.id FROM items i JOIN events e ON i.event_id = e.id
                   WHERE e.year_id = y.id AND i.item_type = 'photo'
                   ORDER BY (i.timestamp_ms IS NULL), i.timestamp_ms LIMIT 1)),
             (SELECT group_concat(id) FROM
               (SELECT i.id FROM items i JOIN events e ON i.event_id = e.id
                    WHERE e.year_id = y.id AND i.item_type = 'photo'
                    ORDER BY (i.timestamp_ms IS NULL), i.timestamp_ms LIMIT 48)),
             (SELECT group_concat(fid) FROM
               (SELECT (SELECT i.id FROM items i WHERE i.event_id = e.id AND i.item_type = 'photo'
                            AND (i.slug = e.featured_photo OR i.id = e.featured_photo) LIMIT 1) AS fid
                    FROM events e
                    WHERE e.year_id = y.id AND e.featured_photo IS NOT NULL)
               WHERE fid IS NOT NULL),
             (SELECT i.id FROM items i JOIN events e ON i.event_id = e.id
                WHERE e.year_id = y.id AND i.item_type = 'photo' AND i.id = y.cover_photo LIMIT 1)
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
            photo_ids: split_ids(r.get(8)?),
            featured_ids: split_ids(r.get(9)?),
            pinned_cover: r.get(10)?,
        })
    })?;
    rows.collect()
}

pub fn get_year(conn: &Connection, year_id: &str) -> rusqlite::Result<Option<YearDetail>> {
    let year = conn
        .query_row(
            "SELECT id, year, title, start_at, end_at, folder_name, cover_photo, size_factor FROM years WHERE id = ?1",
            params![year_id],
            |r| {
                Ok(Year {
                    id: r.get(0)?,
                    year: r.get(1)?,
                    title: r.get(2)?,
                    start_at: r.get(3)?,
                    end_at: r.get(4)?,
                    folder_name: r.get(5)?,
                    cover: r.get(6)?,
                    size_factor: r.get(7)?,
                })
            },
        )
        .ok();
    let Some(year) = year else {
        return Ok(None);
    };

    // Cover per event: is er een `featured_photo` (op slug óf id) → die; anders
    // een WILLEKEURIGE foto (per query → elke keer een andere bij een bezoek).
    let mut stmt = conn.prepare(
        "SELECT e.id, e.kind, e.title, e.start_at, e.end_at,
             (SELECT count(*) FROM items i WHERE i.event_id = e.id),
             COALESCE(
               (SELECT i.id FROM items i WHERE i.event_id = e.id AND i.item_type = 'photo'
                    AND (i.slug = e.featured_photo OR i.id = e.featured_photo) LIMIT 1),
               (SELECT i.id FROM items i WHERE i.event_id = e.id AND i.item_type = 'photo'
                    ORDER BY RANDOM() LIMIT 1)
             ),
             (SELECT group_concat(id) FROM
               (SELECT id FROM items WHERE event_id = e.id AND item_type = 'photo'
                    ORDER BY (timestamp_ms IS NULL), timestamp_ms LIMIT 24)),
             e.size, e.under_construction, e.synthetic
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
                photo_ids: split_ids(r.get::<_, Option<String>>(7)?),
                size: r.get(8)?,
                under_construction: r.get(9)?,
                synthetic: r.get::<_, i64>(10)? != 0,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    Ok(Some(YearDetail { year, events }))
}

pub fn get_event(conn: &Connection, event_id: &str) -> rusqlite::Result<Option<EventDetail>> {
    let event = conn
        .query_row(
            "SELECT id, year_id, kind, title, description, start_at, end_at,
                 location_lat, location_lng, location_label, featured_photo, tags, folder_path, size,
                 under_construction, synthetic
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

    // Vaste jaar-cover van het jaar van dit event (item-id), of None.
    let year_cover: Option<String> = conn
        .query_row(
            "SELECT i.id FROM items i JOIN events e ON i.event_id = e.id
             WHERE e.year_id = ?1 AND i.item_type = 'photo'
               AND i.id = (SELECT cover_photo FROM years WHERE id = ?1) LIMIT 1",
            params![event.year_id],
            |r| r.get::<_, String>(0),
        )
        .ok();

    Ok(Some(EventDetail {
        event,
        items,
        canvas,
        year_cover,
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

/// Foto-item-ids voor de screensaver, binnen een scope en optioneel op tags
/// gefilterd. `scope_kind`: "year" (→ `scope_id` = year_id), "event" (→ event_id),
/// anders alle foto's. `include` = minstens één van die tags; `exclude` = geen van
/// die tags. Bij "year"/"event" zonder id → lege lijst (geen panic). Alleen echte
/// (niet-synthetische) foto's, chronologisch.
pub fn list_screensaver_photos(
    conn: &Connection,
    scope_kind: &str,
    scope_id: Option<&str>,
    include: &[String],
    exclude: &[String],
) -> rusqlite::Result<Vec<String>> {
    use rusqlite::types::Value;
    let mut sql = String::from(
        "SELECT i.id FROM items i JOIN events e ON i.event_id = e.id \
         WHERE i.item_type = 'photo' AND i.synthetic = 0",
    );
    // Bind-volgorde volgt exact de SQL-opbouw: [scope_id?] [include...] [exclude...].
    let mut binds: Vec<Value> = Vec::new();
    match scope_kind {
        "year" => match scope_id {
            Some(id) => {
                sql.push_str(" AND e.year_id = ?");
                binds.push(Value::Text(id.to_string()));
            }
            None => return Ok(Vec::new()),
        },
        "event" => match scope_id {
            Some(id) => {
                sql.push_str(" AND i.event_id = ?");
                binds.push(Value::Text(id.to_string()));
            }
            None => return Ok(Vec::new()),
        },
        _ => {} // "all" (of onbekend) → geen scope-filter
    }
    if !include.is_empty() {
        let ph = vec!["?"; include.len()].join(",");
        sql.push_str(&format!(
            " AND EXISTS (SELECT 1 FROM json_each(i.tags) WHERE value IN ({ph}))"
        ));
        binds.extend(include.iter().map(|t| Value::Text(t.clone())));
    }
    if !exclude.is_empty() {
        let ph = vec!["?"; exclude.len()].join(",");
        sql.push_str(&format!(
            " AND NOT EXISTS (SELECT 1 FROM json_each(i.tags) WHERE value IN ({ph}))"
        ));
        binds.extend(exclude.iter().map(|t| Value::Text(t.clone())));
    }
    sql.push_str(" ORDER BY (i.timestamp_ms IS NULL), i.timestamp_ms, i.slug");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(binds), |r| r.get::<_, String>(0))?;
    rows.collect()
}

/// Bestandsinfo van een item voor verwijderen: (event_id, folder_path, slug, media).
pub type ItemFiles = (String, String, Option<String>, Option<String>);

pub fn item_files(conn: &Connection, item_id: &str) -> rusqlite::Result<Option<ItemFiles>> {
    Ok(conn
        .query_row(
            "SELECT i.event_id, e.folder_path, i.slug, i.media
             FROM items i JOIN events e ON i.event_id = e.id WHERE i.id = ?1",
            params![item_id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .ok())
}

/// Verwijst een ánder item in hetzelfde event naar hetzelfde mediabestand?
/// Gebruikt bij verwijderen: door de v1-duplicate-`.md`-bug (twee `.md`'s → één
/// media) mag het trashen van het mediabestand een overlevend item niet breken.
pub fn media_shared(
    conn: &Connection,
    event_id: &str,
    media: &str,
    exclude_item_id: &str,
) -> rusqlite::Result<bool> {
    let n: i64 = conn.query_row(
        "SELECT count(*) FROM items
         WHERE event_id = ?1 AND media = ?2 COLLATE NOCASE AND id != ?3",
        params![event_id, media, exclude_item_id],
        |r| r.get(0),
    )?;
    Ok(n > 0)
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

/// Mapnaam van een jaar (voor het aanmaken van een event daarin).
pub fn year_folder(conn: &Connection, year_id: &str) -> rusqlite::Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT folder_name FROM years WHERE id = ?1",
            params![year_id],
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

/// Bouwt een veilige FTS5-prefix-query uit vrije gebruikersinvoer (alleen
/// alfanumerieke tokens + `*`, impliciete AND) — voorkomt FTS-syntaxfouten.
fn fts_query(input: &str) -> Option<String> {
    let tokens: Vec<String> = input
        .split_whitespace()
        .map(|t| t.chars().filter(|c| c.is_alphanumeric()).collect::<String>())
        .filter(|t| !t.is_empty())
        .map(|t| format!("{t}*"))
        .collect();
    if tokens.is_empty() {
        None
    } else {
        Some(tokens.join(" "))
    }
}

/// Full-text zoeken op caption, body, tags, people en plaats. Geeft resultaten
/// met navigatie-context.
pub fn search(conn: &Connection, input: &str) -> rusqlite::Result<Vec<SearchResult>> {
    let Some(query) = fts_query(input) else {
        return Ok(Vec::new());
    };
    let mut stmt = conn.prepare(
        "SELECT f.item_id, i.event_id, e.year_id, e.title, i.caption, i.body_text,
                i.place_label, i.tags, i.people
         FROM items_fts f
         JOIN items i ON i.id = f.item_id
         JOIN events e ON i.event_id = e.id
         WHERE items_fts MATCH ?1
         LIMIT 50",
    )?;
    let rows = stmt.query_map(params![query], |r| {
        let nonempty = |s: Option<String>| s.filter(|v| !v.is_empty());
        let caption = nonempty(r.get(4)?);
        let body = nonempty(r.get(5)?);
        let place = nonempty(r.get(6)?);
        let tags: String = r.get(7)?;
        let people: String = r.get(8)?;
        // Toon de meest betekenisvolle tekst; een tag-/plaats-/persoon-match zonder
        // caption toont zo tóch iets leesbaars (nooit ruwe JSON).
        let tags_readable = || {
            let t = parse_json_vec(&tags).join(", ");
            let p = parse_json_vec(&people).join(", ");
            [t, p].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" · ")
        };
        let snippet = caption
            .or(body)
            .or(place)
            .unwrap_or_else(tags_readable)
            .chars()
            .take(140)
            .collect::<String>();
        Ok(SearchResult {
            item_id: r.get(0)?,
            event_id: r.get(1)?,
            year_id: r.get(2)?,
            event_title: r.get(3)?,
            snippet,
        })
    })?;
    rows.collect()
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
        size: r.get(13)?,
        under_construction: r.get(14)?,
        folder_path: r.get(12)?,
        synthetic: r.get::<_, i64>(15)? != 0,
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
            cover: None,
            size_factor: None,
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
            size: None,
            under_construction: None,
            year_id: "y2024".into(),
            folder_path: "2024/2024-11-23 palermo".into(),
            synthetic: false,
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
        assert!(!yd.events[0].synthetic); // echt event → synthetic false leest correct terug

        let ed = get_event(&conn, "ev1").unwrap().unwrap();
        assert!(!ed.event.synthetic);
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
    fn synthetic_flag_round_trips_through_db() {
        // De synthetische "Losse foto's"-vlag (true) moet door load → get_year én
        // get_event heen komen (kolom-mapping index 10 / 15).
        let mut m = VaultModel::default();
        m.years.push(Year {
            id: "y".into(),
            year: 2012,
            title: "2012".into(),
            start_at: "2012-01-01".into(),
            end_at: None,
            folder_name: "2012".into(),
            cover: None,
            size_factor: None,
        });
        m.events.push(Event {
            id: "loose".into(),
            kind: EventKind::Event,
            title: Some("Losse foto's".into()),
            description: None,
            start_at: "2012-01-01".into(),
            end_at: None,
            location: None,
            featured_photo: None,
            tags: vec![],
            size: None,
            under_construction: None,
            year_id: "y".into(),
            folder_path: "2012".into(),
            synthetic: true,
        });

        // Voeg één ECHTE memory toe naast de synthetische bundel.
        m.events.push(Event {
            id: "real".into(),
            kind: EventKind::Event,
            title: Some("Verjaardag".into()),
            description: None,
            start_at: "2012-06-01".into(),
            end_at: None,
            location: None,
            featured_photo: None,
            tags: vec![],
            size: None,
            under_construction: None,
            year_id: "y".into(),
            folder_path: "2012/2012-06-01 verjaardag".into(),
            synthetic: false,
        });

        let mut conn = open_in_memory().unwrap();
        load(&mut conn, &m).unwrap();

        assert!(get_year(&conn, "y").unwrap().unwrap().events[0].synthetic);
        assert!(get_event(&conn, "loose").unwrap().unwrap().event.synthetic);

        // list_years telt de synthetische bundel NIET mee: alleen de echte memory.
        let years = list_years(&conn).unwrap();
        assert_eq!(years[0].event_count, 1, "synthetische bundel telt niet als memory");
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

    /// Bouwt een model met getagde foto's over twee jaren + een synthetische foto.
    fn screensaver_model() -> VaultModel {
        let mut m = VaultModel::default();
        let photo = |id: &str, event_id: &str, tags: &[&str], synthetic: bool, ts: i64| Item {
            id: id.into(),
            event_id: event_id.into(),
            item_type: ItemType::Photo,
            media: Some(format!("{id}.jpg")),
            url: None,
            caption: None,
            happened_at: None,
            timestamp_ms: Some(ts),
            place: None,
            people: vec![],
            tags: tags.iter().map(|t| (*t).into()).collect(),
            category: None,
            body_text: None,
            slug: Some(id.into()),
            synthetic,
        };
        for (yid, year, eid) in [("y2024", 2024, "ev1"), ("y2023", 2023, "ev2")] {
            m.years.push(Year {
                id: yid.into(),
                year,
                title: year.to_string(),
                start_at: format!("{year}-01-01"),
                end_at: None,
                folder_name: year.to_string(),
                cover: None,
                size_factor: None,
            });
            m.events.push(Event {
                id: eid.into(),
                kind: EventKind::Event,
                title: None,
                description: None,
                start_at: format!("{year}-06-01"),
                end_at: None,
                location: None,
                featured_photo: None,
                tags: vec![],
                size: None,
                under_construction: None,
                year_id: yid.into(),
                folder_path: format!("{year}/e"),
                synthetic: false,
            });
        }
        m.items.push(photo("it1", "ev1", &[], false, 1)); // geen tags
        m.items.push(photo("ita", "ev1", &["vakantie", "strand"], false, 2));
        m.items.push(photo("itb", "ev1", &["familie"], false, 3));
        m.items.push(photo("itsyn", "ev1", &["vakantie"], true, 4)); // synthetisch → uit
        m.items.push(photo("itc", "ev2", &["vakantie"], false, 5));
        m
    }

    #[test]
    fn screensaver_scope_and_synthetic() {
        let mut conn = open_in_memory().unwrap();
        load(&mut conn, &screensaver_model()).unwrap();
        let all = list_screensaver_photos(&conn, "all", None, &[], &[]).unwrap();
        assert_eq!(all, vec!["it1", "ita", "itb", "itc"]); // synthetisch weggelaten, chronologisch
        let y = list_screensaver_photos(&conn, "year", Some("y2024"), &[], &[]).unwrap();
        assert_eq!(y, vec!["it1", "ita", "itb"]);
        let e = list_screensaver_photos(&conn, "event", Some("ev2"), &[], &[]).unwrap();
        assert_eq!(e, vec!["itc"]);
    }

    #[test]
    fn screensaver_tag_include_exclude() {
        let mut conn = open_in_memory().unwrap();
        load(&mut conn, &screensaver_model()).unwrap();
        let inc = |t: &[&str]| t.iter().map(|s| (*s).into()).collect::<Vec<String>>();
        // include any-of "vakantie" → ita + itc (it1 leeg, itb familie, syn uit).
        let v = list_screensaver_photos(&conn, "all", None, &inc(&["vakantie"]), &[]).unwrap();
        assert_eq!(v, vec!["ita", "itc"]);
        // exclude "familie" binnen y2024 → it1 + ita (itb valt af).
        let v = list_screensaver_photos(&conn, "year", Some("y2024"), &[], &inc(&["familie"])).unwrap();
        assert_eq!(v, vec!["it1", "ita"]);
        // volgorde-kritisch: scope + include + exclude samen → itc (ita heeft 'strand').
        let v = list_screensaver_photos(&conn, "all", None, &inc(&["vakantie"]), &inc(&["strand"]))
            .unwrap();
        assert_eq!(v, vec!["itc"]);
    }

    #[test]
    fn screensaver_scope_without_id_is_empty() {
        let mut conn = open_in_memory().unwrap();
        load(&mut conn, &screensaver_model()).unwrap();
        assert!(list_screensaver_photos(&conn, "year", None, &[], &[]).unwrap().is_empty());
        assert!(list_screensaver_photos(&conn, "event", None, &[], &[]).unwrap().is_empty());
    }

    #[test]
    fn search_finds_by_caption_with_context() {
        let mut conn = open_in_memory().unwrap();
        load(&mut conn, &sample_model()).unwrap();
        let results = search(&conn, "zonsondergang").unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].item_id, "it1");
        assert_eq!(results[0].event_id, "ev1");
        assert_eq!(results[0].year_id, "y2024");
        assert!(results[0].snippet.contains("zonsondergang"));
        // Prefix-match werkt ook.
        assert_eq!(search(&conn, "zonson").unwrap().len(), 1);
        // Lege/whitespace-query geeft niets (geen FTS-fout).
        assert!(search(&conn, "   ").unwrap().is_empty());
        // Speciale tekens breken de FTS-parser niet.
        assert!(search(&conn, "\"'(*)").unwrap().is_empty());
    }

    #[test]
    fn list_years_cover_pools() {
        // Zonder uitgelichte foto's: featured_ids leeg, photo_ids bevat de foto.
        let mut conn = open_in_memory().unwrap();
        load(&mut conn, &sample_model()).unwrap();
        let y = &list_years(&conn).unwrap()[0];
        assert!(y.photo_ids.contains(&"it1".to_string()));
        assert!(y.featured_ids.is_empty());

        // Met een uitgelichte foto (op slug): featured_ids resolveert naar het id.
        let mut m = sample_model();
        m.events[0].featured_photo = Some("strand".into());
        let mut conn = open_in_memory().unwrap();
        load(&mut conn, &m).unwrap();
        let y = &list_years(&conn).unwrap()[0];
        assert_eq!(y.featured_ids, vec!["it1"]);
        assert!(y.photo_ids.contains(&"it1".to_string()));
    }

    #[test]
    fn search_finds_photo_by_tag_people_place() {
        let mut m = sample_model();
        // Een foto zonder caption/body, alleen tags/people/plaats — voorheen
        // helemaal niet geïndexeerd (de gemelde bug).
        m.items.push(Item {
            id: "ph".into(),
            event_id: "ev1".into(),
            item_type: ItemType::Photo,
            media: Some("p.jpg".into()),
            url: None,
            caption: None,
            happened_at: None,
            timestamp_ms: Some(9),
            place: Some(Location { lat: 0.0, lng: 0.0, label: Some("Rome".into()) }),
            people: vec!["Oma".into()],
            tags: vec!["kerstmis".into()],
            category: None,
            body_text: None,
            slug: Some("ph".into()),
            synthetic: false,
        });
        let mut conn = open_in_memory().unwrap();
        load(&mut conn, &m).unwrap();

        let found = |q: &str| search(&conn, q).unwrap().into_iter().any(|r| r.item_id == "ph");
        assert!(found("kerstmis"), "vindbaar op tag");
        assert!(found("Oma"), "vindbaar op persoon");
        assert!(found("Rome"), "vindbaar op plaats");
        // Snippet toont leesbare tekst (geen ruwe JSON) bij een tag-match.
        let snip = search(&conn, "kerstmis")
            .unwrap()
            .into_iter()
            .find(|r| r.item_id == "ph")
            .unwrap()
            .snippet;
        assert!(snip.contains("Rome") || snip.contains("kerstmis"), "leesbare snippet: {snip}");
        assert!(!snip.contains('['), "geen ruwe JSON in snippet: {snip}");
        // De caption-match blijft gewoon werken.
        assert!(search(&conn, "zonsondergang").unwrap().iter().any(|r| r.item_id == "it1"));
    }

    /// De slideshow-query in `get_year`: `photo_ids` bevat alle foto's van het
    /// event, chronologisch (ongedateerde achteraan), gecapt op 24; een event
    /// zonder foto's geeft [] (NULL → split_ids). Alleen foto's (geen tekst).
    #[test]
    fn get_year_photo_ids_are_chronological_and_photos_only() {
        fn photo(id: &str, event_id: &str, ts: Option<i64>) -> Item {
            Item {
                id: id.into(),
                event_id: event_id.into(),
                item_type: ItemType::Photo,
                media: Some(format!("{id}.jpg")),
                url: None,
                caption: None,
                happened_at: None,
                timestamp_ms: ts,
                place: None,
                people: vec![],
                tags: vec![],
                category: None,
                body_text: None,
                slug: Some(id.into()),
                synthetic: false,
            }
        }

        let mut m = VaultModel::default();
        m.years.push(Year {
            id: "y2024".into(),
            year: 2024,
            title: "2024".into(),
            start_at: "2024-01-01".into(),
            end_at: None,
            folder_name: "2024".into(),
            cover: None,
            size_factor: None,
        });
        m.events.push(Event {
            id: "ev1".into(),
            kind: EventKind::Event,
            title: Some("ev1".into()),
            description: None,
            start_at: "2024-01-01".into(),
            end_at: None,
            location: None,
            featured_photo: None,
            tags: vec![],
            size: None,
            under_construction: None,
            year_id: "y2024".into(),
            folder_path: "2024/ev1".into(),
            synthetic: false,
        });
        // Bewust in niet-chronologische invoer-volgorde + één ongedateerde.
        m.items.push(photo("p_late", "ev1", Some(3000)));
        m.items.push(photo("p_early", "ev1", Some(1000)));
        m.items.push(photo("p_undated", "ev1", None));
        m.items.push(photo("p_mid", "ev1", Some(2000)));
        // Een tekst-item mag NIET in photo_ids belanden.
        m.items.push(Item {
            id: "t1".into(),
            event_id: "ev1".into(),
            item_type: ItemType::Text,
            media: None,
            url: None,
            caption: Some("notitie".into()),
            happened_at: None,
            timestamp_ms: Some(500),
            place: None,
            people: vec![],
            tags: vec![],
            category: None,
            body_text: None,
            slug: Some("t1".into()),
            synthetic: false,
        });
        // Event zónder foto's → photo_ids = [].
        m.events.push(Event {
            id: "ev2".into(),
            kind: EventKind::Event,
            title: Some("ev2".into()),
            description: None,
            start_at: "2024-02-01".into(),
            end_at: None,
            location: None,
            featured_photo: None,
            tags: vec![],
            size: None,
            under_construction: None,
            year_id: "y2024".into(),
            folder_path: "2024/ev2".into(),
            synthetic: false,
        });

        let mut conn = open_in_memory().unwrap();
        load(&mut conn, &m).unwrap();
        let yd = get_year(&conn, "y2024").unwrap().unwrap();
        let ev1 = yd.events.iter().find(|e| e.id == "ev1").unwrap();
        assert_eq!(
            ev1.photo_ids,
            vec!["p_early", "p_mid", "p_late", "p_undated"],
            "chronologisch, ongedateerde achteraan, geen tekst-item"
        );
        let ev2 = yd.events.iter().find(|e| e.id == "ev2").unwrap();
        assert!(ev2.photo_ids.is_empty(), "event zonder foto's → lege lijst");
    }

    #[test]
    fn missing_year_returns_none() {
        let conn = open_in_memory().unwrap();
        assert!(get_year(&conn, "nope").unwrap().is_none());
        assert!(get_event(&conn, "nope").unwrap().is_none());
    }

    /// De cover-subquery in `get_year`: een gezette `featuredPhoto` (op slug) kiest
    /// exact die foto; een `featuredPhoto` die naar een verwijderde/onbestaande
    /// foto wijst valt via COALESCE terug op een willekeurige foto (nooit NULL
    /// zolang het event foto's heeft); een event zónder foto's geeft NULL (geen
    /// omslag). Dit is de data-integriteitskern van de featured-foto-feature.
    #[test]
    fn get_year_cover_honors_featured_and_falls_back() {
        fn photo(id: &str, event_id: &str, slug: &str) -> Item {
            Item {
                id: id.into(),
                event_id: event_id.into(),
                item_type: ItemType::Photo,
                media: Some(format!("{slug}.jpg")),
                url: None,
                caption: None,
                happened_at: None,
                timestamp_ms: None,
                place: None,
                people: vec![],
                tags: vec![],
                category: None,
                body_text: None,
                slug: Some(slug.into()),
                synthetic: false,
            }
        }
        fn event(id: &str, featured: Option<&str>) -> Event {
            Event {
                id: id.into(),
                kind: EventKind::Event,
                title: Some(id.into()),
                description: None,
                start_at: "2024-01-01".into(),
                end_at: None,
                location: None,
                featured_photo: featured.map(|s| s.into()),
                tags: vec![],
                size: None,
                under_construction: None,
                year_id: "y2024".into(),
                folder_path: format!("2024/{id}"),
                synthetic: false,
            }
        }

        let mut m = VaultModel::default();
        m.years.push(Year {
            id: "y2024".into(),
            year: 2024,
            title: "2024".into(),
            start_at: "2024-01-01".into(),
            end_at: None,
            folder_name: "2024".into(),
            cover: None,
            size_factor: None,
        });
        // A: featured wijst naar een bestaande foto-slug → die exact.
        m.events.push(event("evA", Some("mooi")));
        m.items.push(photo("a1", "evA", "saai"));
        m.items.push(photo("a2", "evA", "mooi"));
        // B: featured wijst naar een verwijderde foto → val terug op RANDOM (niet NULL).
        m.events.push(event("evB", Some("weg")));
        m.items.push(photo("b1", "evB", "over"));
        // C: featured is een tekst-item (geen foto) → val terug op RANDOM foto.
        m.events.push(event("evC", Some("notitie")));
        m.items.push(Item {
            id: "c-text".into(),
            event_id: "evC".into(),
            item_type: ItemType::Text,
            media: None,
            url: None,
            caption: Some("een notitie".into()),
            happened_at: None,
            timestamp_ms: None,
            place: None,
            people: vec![],
            tags: vec![],
            category: None,
            body_text: None,
            slug: Some("notitie".into()),
            synthetic: false,
        });
        m.items.push(photo("c1", "evC", "foto"));
        // D: event zonder foto's → cover NULL (geen omslag).
        m.events.push(event("evD", None));

        let mut conn = open_in_memory().unwrap();
        load(&mut conn, &m).unwrap();
        let yd = get_year(&conn, "y2024").unwrap().unwrap();
        let cover = |id: &str| -> Option<String> {
            yd.events.iter().find(|e| e.id == id).unwrap().cover_item_id.clone()
        };

        assert_eq!(cover("evA").as_deref(), Some("a2"), "featured-slug kiest exact die foto");
        assert_eq!(cover("evB").as_deref(), Some("b1"), "verwijderde featured → val terug op foto");
        assert_eq!(cover("evC").as_deref(), Some("c1"), "tekst-featured → val terug op foto (nooit de tekst)");
        assert!(cover("evD").is_none(), "event zonder foto's heeft geen omslag");
    }
}
