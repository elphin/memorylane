mod commands;
mod index;
mod media;
mod model;
mod vault;

use std::sync::mpsc::{sync_channel, TrySendError};
use std::sync::{Arc, Mutex};

use commands::VaultService;
use media::cache::Tier;
use tauri::http::{Request, Response};
use tauri::{AppHandle, Manager, UriSchemeResponder};

/// Een `thumb://`-request in de wachtrij naar de worker-pool.
struct ThumbJob {
    app: AppHandle,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
}

/// Aantal thumbnail-workers: begrensd zodat een snelle pan (duizenden requests)
/// geen thread-/geheugenexplosie geeft. Vervangt ongebonden `thread::spawn`.
fn worker_count() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get().saturating_sub(2).clamp(2, 8))
        .unwrap_or(4)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Bounded wachtrij + vaste worker-pool voor thumbnail-generatie.
    let (tx, rx) = sync_channel::<ThumbJob>(1024);
    let rx = Arc::new(Mutex::new(rx));
    for _ in 0..worker_count() {
        let rx = Arc::clone(&rx);
        std::thread::spawn(move || loop {
            let job = {
                let guard = match rx.lock() {
                    Ok(g) => g,
                    Err(_) => break,
                };
                guard.recv()
            };
            match job {
                Ok(ThumbJob {
                    app,
                    request,
                    responder,
                }) => {
                    // Een paniek in een decoder mag de worker niet doden en de
                    // request niet laten hangen.
                    let resp = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        handle_thumb(&app, &request)
                    }))
                    .unwrap_or_else(|_| error_response());
                    responder.respond(resp);
                }
                Err(_) => break, // kanaal gesloten
            }
        });
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .register_asynchronous_uri_scheme_protocol("thumb", move |ctx, request, responder| {
            let job = ThumbJob {
                app: ctx.app_handle().clone(),
                request,
                responder,
            };
            // Non-blocking inleveren; bij een volle wachtrij meteen 503.
            if let Err(err) = tx.try_send(job) {
                let job = match err {
                    TrySendError::Full(j) | TrySendError::Disconnected(j) => j,
                };
                job.responder.respond(busy_response());
            }
        })
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
            commands::get_year_photos,
            commands::save_canvas_layout,
            commands::create_text_item,
            commands::create_event,
            commands::delete_item,
            commands::update_item,
            commands::import_photos,
            commands::search,
            commands::get_index_errors,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Behandelt een `thumb://`-request. URL-vorm: `thumb://localhost/<itemId>?size=256`
/// (op Windows gemapt naar `http://thumb.localhost/...`). Geeft JPEG-bytes of 404.
fn handle_thumb(app: &AppHandle, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let uri = request.uri();
    // Item-id uit het laatste padsegment; valt terug op de host. URL-decoded
    // zodat id's met bijzondere tekens (percent-encoded) resolven.
    let from_path = uri
        .path()
        .rsplit('/')
        .find(|s| !s.is_empty())
        .map(percent_decode);
    let item_id = from_path
        .or_else(|| uri.host().map(percent_decode))
        .unwrap_or_default();
    let tier = uri
        .query()
        .and_then(size_param)
        .and_then(|s| Tier::parse(&s))
        .unwrap_or(Tier::Small);

    match thumb_bytes(app, &item_id, tier) {
        Ok(bytes) => Response::builder()
            .status(200)
            .header("Content-Type", "image/jpeg")
            // CORS zodat een <img crossOrigin="anonymous"> uploadbaar is naar
            // WebGL zonder canvas-tainting (thumb:// is cross-origin t.o.v. de app).
            .header("Access-Control-Allow-Origin", "*")
            // De URL is item-id-gekeyd (muteerbaar bij een foto-vervanging),
            // dus geen `immutable`.
            .header("Cache-Control", "no-cache")
            .body(bytes)
            .unwrap_or_else(|_| error_response()),
        Err(e) => {
            log::warn!("thumb '{item_id}' faalde: {e}");
            Response::builder()
                .status(404)
                .body(Vec::new())
                .unwrap_or_else(|_| error_response())
        }
    }
}

fn thumb_bytes(app: &AppHandle, item_id: &str, tier: Tier) -> Result<Vec<u8>, String> {
    if item_id.is_empty() {
        return Err("leeg item-id".into());
    }
    let cache_root = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    let service = app.state::<VaultService>();
    let path = service.resolve_thumb(&cache_root, item_id, tier)?;
    std::fs::read(&path).map_err(|e| e.to_string())
}

/// Haalt de `size`-parameter uit een query-string (`size=256`).
fn size_param(query: &str) -> Option<String> {
    query
        .split('&')
        .find_map(|kv| kv.strip_prefix("size=").map(|v| v.to_string()))
}

/// Minimale percent-decoding (`%XX`) zonder externe dependency.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn error_response() -> Response<Vec<u8>> {
    Response::builder().status(500).body(Vec::new()).unwrap()
}

fn busy_response() -> Response<Vec<u8>> {
    Response::builder()
        .status(503)
        .header("Retry-After", "1")
        .body(Vec::new())
        .unwrap_or_else(|_| error_response())
}
