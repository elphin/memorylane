//! Typed Tauri commands — de enige surface waar de webview mee praat.
//! Geen raw SQL over IPC; alles gaat via domein-commands.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::index::{self, DensityPoint, EventDetail, YearDetail, YearSummary};
use crate::model::{IndexError, VaultModel};
use crate::vault;

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

#[tauri::command]
pub fn get_index_errors(state: State<VaultService>) -> Result<Vec<IndexError>, String> {
    state.with_conn(index::get_index_errors)
}
