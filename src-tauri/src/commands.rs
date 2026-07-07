//! Typed Tauri commands — the only surface the webview talks to.
//! Fase 1 voegt toe: `list_years`, `get_year`, `get_event`,
//! `get_timeline_density`, `get_index_errors`, vault-pad-config.

/// Smoke-test command voor het v2-skelet.
#[tauri::command]
pub fn app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}
