mod commands;
mod index;
mod model;
mod vault;

use commands::VaultService;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Index-service opzetten en het laatst gebruikte vault-pad herstellen.
            let service = VaultService::new().map_err(std::io::Error::other)?;
            service.restore(&app.handle().clone());
            app.manage(service);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_version,
            commands::get_vault_path,
            commands::set_vault_path,
            commands::reindex,
            commands::list_years,
            commands::get_year,
            commands::get_event,
            commands::get_timeline_density,
            commands::get_index_errors,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
