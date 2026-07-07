//! Typed Tauri commands — de enige surface waar de webview mee praat.
//! Geen raw SQL over IPC; alles gaat via domein-commands.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::index::{self, DensityPoint, EventDetail, YearDetail, YearPhoto, YearSummary};
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
pub fn get_year_photos(
    state: State<VaultService>,
    year_id: String,
) -> Result<Vec<YearPhoto>, String> {
    state.with_conn(|c| index::list_year_photos(c, &year_id))
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
