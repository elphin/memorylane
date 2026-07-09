//! Typed Tauri commands — de enige surface waar de webview mee praat.
//! Geen raw SQL over IPC; alles gaat via domein-commands.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::index::{
    self, DensityPoint, EventDetail, SearchResult, YearDetail, YearPhoto, YearSummary,
};
use crate::media::{self, cache::Tier};
use crate::model::{CanvasItem, IndexError, VaultModel};
use crate::vault;
use crate::vault::writer;

/// Gedeelde applicatiestaat: de index-connectie + het actieve vault-pad.
pub struct VaultService {
    conn: Mutex<Connection>,
    vault_path: Mutex<Option<PathBuf>>,
}

impl VaultService {
    /// Bouwt de service met een lege in-memory index.
    pub fn new() -> Result<Self, String> {
        let conn = index::open_in_memory().map_err(|e| e.to_string())?;
        Ok(VaultService {
            conn: Mutex::new(conn),
            vault_path: Mutex::new(None),
        })
    }

    /// Herstelt het laatst gebruikte vault-pad uit config en indexeert het.
    /// Faalt zacht: bij problemen blijft de index leeg (UI toont first-run).
    pub fn restore(&self, app: &AppHandle) {
        let Some(path) = read_config(app).and_then(|c| c.vault_path) else {
            return;
        };
        let path = PathBuf::from(path);
        if !path.is_dir() {
            log::warn!("opgeslagen vault-pad bestaat niet meer: {}", path.display());
            return;
        }
        if let Err(e) = self.reindex_path(&path) {
            log::warn!("herindexeren bij opstart mislukt: {e}");
        }
    }

    fn reindex_path(&self, path: &Path) -> Result<IndexSummary, String> {
        let model = vault::scan(path);
        let summary = IndexSummary::from_model(&model);
        {
            let mut conn = self.conn.lock().map_err(lock_err)?;
            index::load(&mut conn, &model).map_err(|e| e.to_string())?;
        }
        *self.vault_path.lock().map_err(lock_err)? = Some(path.to_path_buf());
        Ok(summary)
    }

    fn with_conn<T>(
        &self,
        f: impl FnOnce(&Connection) -> rusqlite::Result<T>,
    ) -> Result<T, String> {
        let conn = self.conn.lock().map_err(lock_err)?;
        f(&conn).map_err(|e| e.to_string())
    }

    /// Resolveert een item naar zijn bronmedia en zorgt dat de thumbnail voor
    /// `tier` op schijf staat; geeft het cache-pad terug. Gebruikt de
    /// content-hash-memo om her-hashen van ongewijzigde bestanden te vermijden.
    pub fn resolve_thumb(
        &self,
        cache_root: &Path,
        item_id: &str,
        tier: Tier,
    ) -> Result<PathBuf, String> {
        let (folder, media) = {
            let conn = self.conn.lock().map_err(lock_err)?;
            index::item_media_ref(&conn, item_id)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| format!("geen media voor item {item_id}"))?
        };

        let vault = {
            let guard = self.vault_path.lock().map_err(lock_err)?;
            guard.clone().ok_or("geen vault ingesteld")?
        };
        let src = vault.join(&folder).join(&media);
        let meta = std::fs::metadata(&src).map_err(|e| format!("media niet leesbaar: {e}"))?;

        // Containment: het bronbestand moet binnen de vault liggen. Beschermt
        // tegen een gecraft `media:`-veld met `../` dat buiten de vault leest.
        let canon_src = std::fs::canonicalize(&src).map_err(|e| e.to_string())?;
        let canon_vault = std::fs::canonicalize(&vault).map_err(|e| e.to_string())?;
        if !canon_src.starts_with(&canon_vault) {
            return Err(format!("media buiten de vault geweigerd: {media}"));
        }

        let size = meta.len() as i64;
        let mtime = mtime_ms(&meta);
        let src_key = src.to_string_lossy().to_string();

        // Content-hash via memo (of berekenen + opslaan).
        let hash = {
            let conn = self.conn.lock().map_err(lock_err)?;
            match index::cached_hash(&conn, &src_key, mtime, size).map_err(|e| e.to_string())? {
                Some(h) => h,
                None => {
                    let h = media::hash::hash_file(&src).map_err(|e| e.to_string())?;
                    index::put_hash(&conn, &src_key, mtime, size, &h).map_err(|e| e.to_string())?;
                    h
                }
            }
        };

        media::thumbs::ensure_thumb(&src, tier, cache_root, &hash).map_err(|e| e.to_string())
    }

    fn current_vault(&self) -> Result<PathBuf, String> {
        self.vault_path
            .lock()
            .map_err(lock_err)?
            .clone()
            .ok_or_else(|| "geen vault ingesteld".to_string())
    }

    /// Herindexeert het huidige vault-pad (na een structurele wijziging).
    fn rescan(&self) -> Result<(), String> {
        let path = self.current_vault()?;
        let model = vault::scan(&path);
        let mut conn = self.conn.lock().map_err(lock_err)?;
        index::load(&mut conn, &model).map_err(|e| e.to_string())
    }

    /// Voegt een tekst-notitie toe aan een event (file first, dan herindexeren).
    pub fn create_text_item(
        &self,
        event_id: &str,
        caption: Option<&str>,
        body: &str,
    ) -> Result<String, String> {
        let vault = self.current_vault()?;
        let folder = {
            let conn = self.conn.lock().map_err(lock_err)?;
            index::event_folder(&conn, event_id)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| format!("event {event_id} niet gevonden"))?
        };
        let (id, _slug) =
            writer::create_text_item(&vault, &folder, caption, body).map_err(|e| e.to_string())?;
        self.rescan()?;
        Ok(id)
    }

    /// Werkt de caption en/of body van een bestaand item bij (file first, dan
    /// herindexeren). `caption`/`body` = `None` laat dat veld ongemoeid.
    pub fn update_item(
        &self,
        item_id: &str,
        caption: Option<&str>,
        body: Option<&str>,
    ) -> Result<(), String> {
        let vault = self.current_vault()?;
        let (_event_id, folder, slug, _media) = {
            let conn = self.conn.lock().map_err(lock_err)?;
            index::item_files(&conn, item_id)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| format!("item {item_id} niet gevonden"))?
        };
        // Synthetische items (losse media zonder `.md`) hebben geen bewerkbaar
        // bestand; die zouden eerst een sidecar nodig hebben (latere fase).
        let slug = slug.ok_or_else(|| "dit item heeft geen bewerkbaar bestand".to_string())?;
        writer::update_item(&vault, &folder, &slug, caption, body).map_err(|e| e.to_string())?;
        self.rescan()?;
        Ok(())
    }

    /// Leest de bewerkbare sidecar-metadata van een item + read-only ingebedde
    /// EXIF (voor de bewerk-UI). EXIF wordt tolerant gelezen (leeg bij geen data).
    pub fn get_item_metadata(&self, item_id: &str) -> Result<ItemMetadata, String> {
        let vault = self.current_vault()?;
        let (_event_id, folder, slug, media) = {
            let conn = self.conn.lock().map_err(lock_err)?;
            index::item_files(&conn, item_id)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| format!("item {item_id} niet gevonden"))?
        };
        let slug = slug.ok_or_else(|| "dit item heeft geen bewerkbaar bestand".to_string())?;
        let path = vault.join(&folder).join(format!("{slug}.md"));
        let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let p = vault::frontmatter::parse(&content);

        // Ingebedde EXIF uit het mediabestand (alleen voor foto's). Containment:
        // media komt uit onvertrouwde frontmatter — canonicaliseer en eis dat het
        // binnen de vault ligt (zelfde bescherming als resolve_thumb).
        let exif = media
            .as_deref()
            .and_then(|m| {
                let src = vault.join(&folder).join(m);
                let canon_src = std::fs::canonicalize(&src).ok()?;
                let canon_vault = std::fs::canonicalize(&vault).ok()?;
                canon_src.starts_with(&canon_vault).then_some(src)
            })
            .map(|src| media::exif_read::read_exif(&src))
            .unwrap_or_default()
            .into_iter()
            .map(|(label, value)| ExifEntry { label, value })
            .collect();

        Ok(ItemMetadata {
            caption: p.get_str("caption").unwrap_or_default(),
            date: p.get_str("date").unwrap_or_default(),
            place: p.get_str("place").unwrap_or_default(),
            people: p.get("people").map(|v| v.as_string_list()).unwrap_or_default(),
            tags: p.get("tags").map(|v| v.as_string_list()).unwrap_or_default(),
            exif,
        })
    }

    /// Werkt de bewerkbare sidecar-metadata van een item bij (file first, rescan).
    #[allow(clippy::too_many_arguments)]
    pub fn update_item_metadata(
        &self,
        item_id: &str,
        caption: &str,
        date: &str,
        place: &str,
        people: &[String],
        tags: &[String],
    ) -> Result<(), String> {
        let vault = self.current_vault()?;
        let (_event_id, folder, slug, _media) = {
            let conn = self.conn.lock().map_err(lock_err)?;
            index::item_files(&conn, item_id)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| format!("item {item_id} niet gevonden"))?
        };
        let slug = slug.ok_or_else(|| "dit item heeft geen bewerkbaar bestand".to_string())?;
        writer::update_item_meta(&vault, &folder, &slug, caption, date, place, people, tags)
            .map_err(|e| e.to_string())?;
        self.rescan()?;
        Ok(())
    }

    /// Zet (of wist bij `None`) de uitgelichte foto van een event (file first,
    /// dan herindexeren). `item_ref` = de slug of id van de foto.
    pub fn set_featured(&self, event_id: &str, item_ref: Option<&str>) -> Result<(), String> {
        let vault = self.current_vault()?;
        let folder = {
            let conn = self.conn.lock().map_err(lock_err)?;
            index::event_folder(&conn, event_id)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| format!("event {event_id} niet gevonden"))?
        };
        writer::set_event_featured(&vault, &folder, item_ref).map_err(|e| e.to_string())?;
        self.rescan()?;
        Ok(())
    }

    /// Zet (of wist bij `None`) de vaste jaar-cover in `_year.md` (file first, rescan).
    pub fn set_year_cover(&self, year_id: &str, item_ref: Option<&str>) -> Result<(), String> {
        let vault = self.current_vault()?;
        let folder = {
            let conn = self.conn.lock().map_err(lock_err)?;
            index::year_folder(&conn, year_id)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| format!("jaar {year_id} niet gevonden"))?
        };
        writer::set_year_cover(&vault, &folder, item_ref).map_err(|e| e.to_string())?;
        self.rescan()?;
        Ok(())
    }

    /// Zet (of wist bij `None`/≈1.0) de globale event-kaartschaal van een jaar.
    pub fn set_year_size_factor(&self, year_id: &str, factor: Option<f64>) -> Result<(), String> {
        let vault = self.current_vault()?;
        let folder = {
            let conn = self.conn.lock().map_err(lock_err)?;
            index::year_folder(&conn, year_id)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| format!("jaar {year_id} niet gevonden"))?
        };
        writer::set_year_size_factor(&vault, &folder, factor).map_err(|e| e.to_string())?;
        self.rescan()?;
        Ok(())
    }

    /// Importeert foto's (bronpaden van de bestandskiezer) in een event.
    pub fn import_photos(&self, event_id: &str, sources: &[String]) -> Result<usize, String> {
        let vault = self.current_vault()?;
        let folder = {
            let conn = self.conn.lock().map_err(lock_err)?;
            index::event_folder(&conn, event_id)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| format!("event {event_id} niet gevonden"))?
        };
        // Batch-import is resilient: één onleesbaar bestand mag de rest niet
        // wegvegen. We importeren per bestand, herindexeren zodra er íéts is
        // gekopieerd (zodat de geslaagde foto's zichtbaar worden, ook bij een
        // gedeeltelijke fout), en falen alleen hard als álles mislukt.
        let mut count = 0usize;
        let mut errors: Vec<String> = Vec::new();
        for src in sources {
            match writer::import_photo(&vault, &folder, std::path::Path::new(src)) {
                Ok(_) => count += 1,
                Err(e) => {
                    log::warn!("foto-import overgeslagen ({src}): {e}");
                    errors.push(e);
                }
            }
        }
        if count > 0 {
            self.rescan()?;
        }
        if count == 0 && !errors.is_empty() {
            return Err(format!("import mislukt: {}", errors.join("; ")));
        }
        Ok(count)
    }

    /// Maakt een nieuw event in een jaar (file first, dan herindexeren).
    pub fn create_event(
        &self,
        year_id: &str,
        title: &str,
        start_at: &str,
        end_at: Option<&str>,
        size: Option<i64>,
    ) -> Result<String, String> {
        let vault = self.current_vault()?;
        let year_folder = {
            let conn = self.conn.lock().map_err(lock_err)?;
            index::year_folder(&conn, year_id)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| format!("jaar {year_id} niet gevonden"))?
        };
        let (id, _folder) =
            writer::create_event(&vault, &year_folder, title, start_at, end_at, size)
                .map_err(|e| e.to_string())?;
        self.rescan()?;
        Ok(id)
    }

    /// Maakt een memory in het jaar dat bij `start_at` hoort — en maakt die jaarmap
    /// zo nodig aan. Vereist GEEN bestaand jaar, dus dit is het pad voor de
    /// allereerste memory in een lege vault (file first, dan herindexeren).
    pub fn create_event_at_date(
        &self,
        title: &str,
        start_at: &str,
        end_at: Option<&str>,
        size: Option<i64>,
    ) -> Result<String, String> {
        let vault = self.current_vault()?;
        // Vereis een echt jaar in `start_at` — anders zou `writer::create_event`
        // (met lege jaar-hint) in de vault-root schrijven. De UI levert altijd een
        // geldige datum; deze guard beschermt het rauwe IPC-command.
        if writer::year_of(start_at).is_none() {
            return Err(format!("ongeldige datum voor eerste memory: {start_at}"));
        }
        // `writer::create_event` leidt de jaarmap uit `start_at` af en maakt 'm aan;
        // de `year_folder`-parameter wordt genegeerd zodra `start_at` een jaar bevat.
        let (id, _folder) = writer::create_event(&vault, "", title, start_at, end_at, size)
            .map_err(|e| e.to_string())?;
        self.rescan()?;
        Ok(id)
    }

    /// Zet (of wist bij `None`) het `size`-veld (belang, 1–100) van een event.
    pub fn set_event_size(&self, event_id: &str, size: Option<i64>) -> Result<(), String> {
        let vault = self.current_vault()?;
        let folder = {
            let conn = self.conn.lock().map_err(lock_err)?;
            index::event_folder(&conn, event_id)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| format!("event {event_id} niet gevonden"))?
        };
        writer::set_event_size(&vault, &folder, size).map_err(|e| e.to_string())?;
        self.rescan()?;
        Ok(())
    }

    /// Werkt titel/begin-/einddatum van een bestaand event bij (file first, dan
    /// herindexeren). `end_at = None` verwijdert de einddatum.
    pub fn update_event(
        &self,
        event_id: &str,
        title: &str,
        start_at: &str,
        end_at: Option<&str>,
    ) -> Result<(), String> {
        let vault = self.current_vault()?;
        let folder = {
            let conn = self.conn.lock().map_err(lock_err)?;
            index::event_folder(&conn, event_id)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| format!("event {event_id} niet gevonden"))?
        };
        // `update_event` kan de event-map naar een ander jaar verhuizen als de
        // startdatum van jaar verandert; het nieuwe pad interesseert ons niet
        // (de rescan herontdekt het), maar de fout wel.
        writer::update_event(&vault, &folder, title, start_at, end_at).map_err(|e| e.to_string())?;
        self.rescan()?;
        Ok(())
    }

    /// Verwijdert een item naar de prullenbak (`.md` + media), dan herindexeren.
    pub fn delete_item(&self, item_id: &str) -> Result<(), String> {
        let vault = self.current_vault()?;
        let (event_id, folder, slug, media) = {
            let conn = self.conn.lock().map_err(lock_err)?;
            index::item_files(&conn, item_id)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| format!("item {item_id} niet gevonden"))?
        };
        if let Some(slug) = slug {
            writer::trash_file(&vault, &format!("{folder}/{slug}.md"))?;
        }
        if let Some(media) = media {
            // Trash het mediabestand alleen als geen ánder item ernaar verwijst.
            // Door de v1-duplicate-`.md`-bug kunnen twee items dezelfde media
            // delen; dan zou trashen een overlevend item breken.
            let shared = {
                let conn = self.conn.lock().map_err(lock_err)?;
                index::media_shared(&conn, &event_id, &media, item_id).map_err(|e| e.to_string())?
            };
            if !shared {
                writer::trash_file(&vault, &format!("{folder}/{media}"))?;
            }
        }
        self.rescan()?;
        Ok(())
    }

    /// Schrijft de canvas-layout van een event naar `_canvas.json` (file first)
    /// en werkt de index bij. De folder komt uit de index (vertrouwd, uit de scan).
    pub fn save_canvas(&self, event_id: &str, items: Vec<CanvasItem>) -> Result<(), String> {
        let vault = {
            let guard = self.vault_path.lock().map_err(lock_err)?;
            guard.clone().ok_or("geen vault ingesteld")?
        };
        let conn = self.conn.lock().map_err(lock_err)?;
        let folder = index::event_folder(&conn, event_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("event {event_id} niet gevonden"))?;
        writer::write_canvas(&vault, &folder, &items).map_err(|e| e.to_string())?;
        index::replace_canvas(&conn, event_id, &items).map_err(|e| e.to_string())?;
        Ok(())
    }
}

/// Modificatietijd in ms sinds epoch (0 als onbeschikbaar).
fn mtime_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Eén read-only EXIF-veld (label + weergavewaarde).
#[derive(Debug, Serialize)]
pub struct ExifEntry {
    pub label: String,
    pub value: String,
}

/// Bewerkbare sidecar-metadata van een item + read-only ingebedde EXIF.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemMetadata {
    pub caption: String,
    pub date: String,
    pub place: String,
    pub people: Vec<String>,
    pub tags: Vec<String>,
    pub exif: Vec<ExifEntry>,
}

/// Samenvatting van een indexeer-run, terug naar de UI.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexSummary {
    pub year_count: usize,
    pub event_count: usize,
    pub item_count: usize,
    pub error_count: usize,
}

impl IndexSummary {
    fn from_model(m: &VaultModel) -> Self {
        IndexSummary {
            year_count: m.years.len(),
            event_count: m.events.len(),
            item_count: m.items.len(),
            error_count: m.errors.len(),
        }
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    vault_path: Option<String>,
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("config.json"))
}

fn read_config(app: &AppHandle) -> Option<AppConfig> {
    let path = config_path(app).ok()?;
    let content = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

fn write_config(app: &AppHandle, config: &AppConfig) -> Result<(), String> {
    let path = config_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

fn lock_err<T>(_: T) -> String {
    "interne vergrendelingsfout".to_string()
}

// ---- Commands ------------------------------------------------------------

/// Versie van de app (smoke-test).
#[tauri::command]
pub fn app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// Het huidige vault-pad, of `None` bij first-run.
#[tauri::command]
pub fn get_vault_path(state: State<VaultService>) -> Result<Option<String>, String> {
    let path = state.vault_path.lock().map_err(lock_err)?;
    Ok(path.as_ref().map(|p| p.to_string_lossy().to_string()))
}

/// Kiest (of wijzigt) de vault-map: valideert, bewaart in config en indexeert.
#[tauri::command]
pub fn set_vault_path(
    app: AppHandle,
    state: State<VaultService>,
    path: String,
) -> Result<IndexSummary, String> {
    let dir = PathBuf::from(&path);
    if !dir.is_dir() {
        return Err(format!("map bestaat niet: {path}"));
    }
    write_config(
        &app,
        &AppConfig {
            vault_path: Some(path),
        },
    )?;
    state.reindex_path(&dir)
}

/// Herindexeert het huidige vault-pad (full rebuild).
#[tauri::command]
pub fn reindex(state: State<VaultService>) -> Result<IndexSummary, String> {
    let path = {
        let guard = state.vault_path.lock().map_err(lock_err)?;
        guard.clone()
    };
    match path {
        Some(p) => state.reindex_path(&p),
        None => Err("geen vault ingesteld".to_string()),
    }
}

#[tauri::command]
pub fn list_years(state: State<VaultService>) -> Result<Vec<YearSummary>, String> {
    state.with_conn(index::list_years)
}

#[tauri::command]
pub fn get_year(
    state: State<VaultService>,
    year_id: String,
) -> Result<Option<YearDetail>, String> {
    state.with_conn(|c| index::get_year(c, &year_id))
}

#[tauri::command]
pub fn get_event(
    state: State<VaultService>,
    event_id: String,
) -> Result<Option<EventDetail>, String> {
    state.with_conn(|c| index::get_event(c, &event_id))
}

#[tauri::command]
pub fn get_timeline_density(
    state: State<VaultService>,
    year_id: String,
) -> Result<Vec<DensityPoint>, String> {
    state.with_conn(|c| index::get_timeline_density(c, &year_id))
}

/// Input voor één canvas-item vanuit de UI (camelCase).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasLayoutInput {
    pub item_ref: String,
    pub x: f64,
    pub y: f64,
    pub scale: f64,
    pub rotation: f64,
    pub z_index: i64,
    pub text_scale: Option<f64>,
    pub width: Option<f64>,
    pub height: Option<f64>,
}

#[tauri::command]
pub fn save_canvas_layout(
    state: State<VaultService>,
    event_id: String,
    items: Vec<CanvasLayoutInput>,
) -> Result<(), String> {
    let canvas_items = items
        .into_iter()
        .map(|i| CanvasItem {
            event_id: event_id.clone(),
            item_ref: i.item_ref,
            x: i.x,
            y: i.y,
            scale: i.scale,
            rotation: i.rotation,
            z_index: i.z_index,
            text_scale: i.text_scale,
            width: i.width,
            height: i.height,
        })
        .collect();
    state.save_canvas(&event_id, canvas_items)
}

#[tauri::command]
pub fn create_text_item(
    state: State<VaultService>,
    event_id: String,
    caption: Option<String>,
    body: String,
) -> Result<String, String> {
    state.create_text_item(&event_id, caption.as_deref(), &body)
}

#[tauri::command]
pub fn create_event(
    state: State<VaultService>,
    year_id: String,
    title: String,
    start_at: String,
    end_at: Option<String>,
    size: Option<i64>,
) -> Result<String, String> {
    state.create_event(&year_id, &title, &start_at, end_at.as_deref(), size)
}

/// Maakt een memory op datum (maakt de jaarmap zo nodig aan) — voor de eerste
/// memory in een lege vault.
#[tauri::command]
pub fn create_event_at_date(
    state: State<VaultService>,
    title: String,
    start_at: String,
    end_at: Option<String>,
    size: Option<i64>,
) -> Result<String, String> {
    state.create_event_at_date(&title, &start_at, end_at.as_deref(), size)
}

/// Zet (of wist) het belang/`size`-veld (1–100) van een event.
#[tauri::command]
pub fn set_event_size(
    state: State<VaultService>,
    event_id: String,
    size: Option<i64>,
) -> Result<(), String> {
    state.set_event_size(&event_id, size)
}

#[tauri::command]
pub fn update_event(
    state: State<VaultService>,
    event_id: String,
    title: String,
    start_at: String,
    end_at: Option<String>,
) -> Result<(), String> {
    state.update_event(&event_id, &title, &start_at, end_at.as_deref())
}

#[tauri::command]
pub fn set_featured(
    state: State<VaultService>,
    event_id: String,
    item_ref: Option<String>,
) -> Result<(), String> {
    state.set_featured(&event_id, item_ref.as_deref())
}

/// Zet (of wist) de vaste jaar-cover (item-id) van een jaar.
#[tauri::command]
pub fn set_year_cover(
    state: State<VaultService>,
    year_id: String,
    item_ref: Option<String>,
) -> Result<(), String> {
    state.set_year_cover(&year_id, item_ref.as_deref())
}

/// Zet (of wist) de globale event-kaartschaal (proportioneel "passend maken") van een jaar.
#[tauri::command]
pub fn set_year_size_factor(
    state: State<VaultService>,
    year_id: String,
    factor: Option<f64>,
) -> Result<(), String> {
    state.set_year_size_factor(&year_id, factor)
}

#[tauri::command]
pub fn delete_item(state: State<VaultService>, item_id: String) -> Result<(), String> {
    state.delete_item(&item_id)
}

#[tauri::command]
pub fn update_item(
    state: State<VaultService>,
    item_id: String,
    caption: Option<String>,
    body: Option<String>,
) -> Result<(), String> {
    state.update_item(&item_id, caption.as_deref(), body.as_deref())
}

#[tauri::command]
pub fn get_item_metadata(
    state: State<VaultService>,
    item_id: String,
) -> Result<ItemMetadata, String> {
    state.get_item_metadata(&item_id)
}

#[tauri::command]
pub fn update_item_metadata(
    state: State<VaultService>,
    item_id: String,
    caption: String,
    date: String,
    place: String,
    people: Vec<String>,
    tags: Vec<String>,
) -> Result<(), String> {
    state.update_item_metadata(&item_id, &caption, &date, &place, &people, &tags)
}

#[tauri::command]
pub fn import_photos(
    state: State<VaultService>,
    event_id: String,
    sources: Vec<String>,
) -> Result<usize, String> {
    state.import_photos(&event_id, &sources)
}

#[tauri::command]
pub fn get_year_photos(
    state: State<VaultService>,
    year_id: String,
) -> Result<Vec<YearPhoto>, String> {
    state.with_conn(|c| index::list_year_photos(c, &year_id))
}

#[tauri::command]
pub fn search(state: State<VaultService>, query: String) -> Result<Vec<SearchResult>, String> {
    state.with_conn(|c| index::search(c, &query))
}

/// Foto-item-ids voor de screensaver: scope ("all"/"year"/"event") + tag-filter.
#[tauri::command]
pub fn get_screensaver_photos(
    state: State<VaultService>,
    scope_kind: String,
    scope_id: Option<String>,
    include: Vec<String>,
    exclude: Vec<String>,
) -> Result<Vec<String>, String> {
    state.with_conn(|c| {
        index::list_screensaver_photos(c, &scope_kind, scope_id.as_deref(), &include, &exclude)
    })
}

#[tauri::command]
pub fn get_index_errors(state: State<VaultService>) -> Result<Vec<IndexError>, String> {
    state.with_conn(index::get_index_errors)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::RgbImage;

    /// Bouwt een mini-vault met één foto-item en indexeert die.
    fn service_with_photo(root: &Path) -> VaultService {
        std::fs::create_dir_all(root.join("2024/2024-01-01 test")).unwrap();
        std::fs::write(
            root.join("2024/_year.md"),
            "---\nid: y24\ntype: year\ntitle: \"2024\"\nstartAt: 2024-01-01\n---\n",
        )
        .unwrap();
        std::fs::write(
            root.join("2024/2024-01-01 test/_event.md"),
            "---\nid: ev1\ntype: event\ntitle: Test\nstartAt: 2024-01-01\n---\n",
        )
        .unwrap();
        std::fs::write(
            root.join("2024/2024-01-01 test/foto.md"),
            "---\nid: photo1\ntype: photo\nmedia: foto.jpg\ncaption: Test\n---\n",
        )
        .unwrap();
        RgbImage::from_fn(500, 300, |x, _| image::Rgb([(x % 256) as u8, 100, 150]))
            .save(root.join("2024/2024-01-01 test/foto.jpg"))
            .unwrap();

        let service = VaultService::new().unwrap();
        service.reindex_path(root).unwrap();
        service
    }

    #[test]
    fn year_cover_pins_and_clears() {
        let tmp = tempfile::tempdir().unwrap();
        let service = service_with_photo(tmp.path());

        service.set_year_cover("y24", Some("photo1")).unwrap();
        let years = service.with_conn(index::list_years).unwrap();
        let y = years.iter().find(|y| y.id == "y24").unwrap();
        assert_eq!(y.pinned_cover.as_deref(), Some("photo1"));
        assert_eq!(y.cover_item_id.as_deref(), Some("photo1"));
        let ym = std::fs::read_to_string(tmp.path().join("2024/_year.md")).unwrap();
        assert!(ym.contains("cover: photo1"), "cover in _year.md: {ym}");

        service.set_year_cover("y24", None).unwrap();
        let years = service.with_conn(index::list_years).unwrap();
        assert_eq!(years.iter().find(|y| y.id == "y24").unwrap().pinned_cover, None);
    }

    #[test]
    fn year_cover_without_year_md_keeps_year_id() {
        // Kritiek: een jaar ZONDER `_year.md` heeft een gesynthetiseerd id. Het
        // prikken van een cover maakt `_year.md` aan; dat mag het jaar-id NIET
        // wijzigen (anders raken events los).
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("2024/2024-01-01 test")).unwrap();
        std::fs::write(
            root.join("2024/2024-01-01 test/_event.md"),
            "---\nid: ev1\ntype: event\ntitle: Test\nstartAt: 2024-01-01\n---\n",
        )
        .unwrap();
        std::fs::write(
            root.join("2024/2024-01-01 test/foto.md"),
            "---\nid: photo1\ntype: photo\nmedia: foto.jpg\n---\n",
        )
        .unwrap();
        RgbImage::from_fn(10, 10, |_, _| image::Rgb([0, 0, 0]))
            .save(root.join("2024/2024-01-01 test/foto.jpg"))
            .unwrap();

        let service = VaultService::new().unwrap();
        service.reindex_path(root).unwrap();
        let years = service.with_conn(index::list_years).unwrap();
        let year_id = years[0].id.clone();
        assert_eq!(years[0].event_count, 1);

        service.set_year_cover(&year_id, Some("photo1")).unwrap();

        let years = service.with_conn(index::list_years).unwrap();
        assert_eq!(years.len(), 1);
        assert_eq!(years[0].id, year_id, "jaar-id mag niet wijzigen");
        assert_eq!(years[0].event_count, 1, "event nog gekoppeld aan het jaar");
        assert_eq!(years[0].pinned_cover.as_deref(), Some("photo1"));
        let ym = std::fs::read_to_string(root.join("2024/_year.md")).unwrap();
        assert!(!ym.contains("id:"), "geen id in aangemaakt _year.md: {ym}");
    }

    #[test]
    fn resolve_thumb_generates_and_caches() {
        let tmp = tempfile::tempdir().unwrap();
        let service = service_with_photo(tmp.path());
        let cache = tmp.path().join("cache");

        let p = service
            .resolve_thumb(&cache, "photo1", Tier::Micro)
            .unwrap();
        assert!(p.exists(), "thumbnail moet gegenereerd zijn");

        // Tweede aanroep: gebruikt de hash-memo, zelfde pad.
        let p2 = service
            .resolve_thumb(&cache, "photo1", Tier::Micro)
            .unwrap();
        assert_eq!(p, p2);

        // De hash is gememoiseerd in de index.
        let conn = service.conn.lock().unwrap();
        let count: i64 = conn
            .query_row("SELECT count(*) FROM media_hash", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn resolve_thumb_unknown_item_errors() {
        let tmp = tempfile::tempdir().unwrap();
        let service = service_with_photo(tmp.path());
        let cache = tmp.path().join("cache");
        assert!(service.resolve_thumb(&cache, "nope", Tier::Small).is_err());
    }

    #[test]
    fn resolve_thumb_rejects_path_traversal() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("vault");
        std::fs::create_dir_all(root.join("2024/2024-01-01 test")).unwrap();
        std::fs::write(
            root.join("2024/_year.md"),
            "---\nid: y24\ntype: year\ntitle: \"2024\"\nstartAt: 2024-01-01\n---\n",
        )
        .unwrap();
        std::fs::write(
            root.join("2024/2024-01-01 test/_event.md"),
            "---\nid: ev1\ntype: event\ntitle: Test\nstartAt: 2024-01-01\n---\n",
        )
        .unwrap();
        // Gecraft item dat naar buiten de vault wijst.
        std::fs::write(
            root.join("2024/2024-01-01 test/evil.md"),
            "---\nid: evil\ntype: photo\nmedia: ../../../secret.jpg\n---\n",
        )
        .unwrap();
        // Bestand buiten de vault dat het zou proberen te lezen.
        RgbImage::from_fn(10, 10, |_, _| image::Rgb([0u8, 0, 0]))
            .save(tmp.path().join("secret.jpg"))
            .unwrap();

        let service = VaultService::new().unwrap();
        service.reindex_path(&root).unwrap();
        let cache = tmp.path().join("cache");
        let result = service.resolve_thumb(&cache, "evil", Tier::Small);
        assert!(result.is_err(), "path-traversal moet geweigerd worden");
    }
}
