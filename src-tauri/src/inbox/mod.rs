//! Mobiele-inbox, desktop-kant.
//!
//! - `crypto` (fase 2): het versleutelde blobformaat, byte-identiek aan de PWA.
//! - `store` + `api` + de commands hieronder (fase 4): pairing & sleutelbeheer.
//!
//! De import-flow (fase 5) komt later in `import.rs`.

pub mod crypto;
mod api;
mod import;
mod store;

use base64::Engine;
use rand::RngCore;
use serde::Serialize;
use tauri::{AppHandle, State, Window};

use crate::commands::VaultService;

/// Resultaat van pairing/rotate: de QR-payload (éénmalig terug te geven, nergens
/// gelogd) + een korte mailbox-id voor de UI.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairResult {
    pub qr_payload: String,
    pub mailbox_short_id: String,
}

/// Niet-geheime status voor de Settings-UI (nooit tokens/sleutels).
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct InboxStatus {
    pub configured: bool,
    pub server_url: Option<String>,
    pub mailbox_short_id: Option<String>,
    pub paired_at: Option<String>,
}

// ---- helpers ----

fn rand32() -> [u8; 32] {
    let mut b = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut b);
    b
}

fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn short(mailbox_id: &str) -> String {
    mailbox_id.chars().take(8).collect()
}

/// Trim + trailing slash eraf; eist **HTTPS**. De owner/upload-tokens reizen als
/// bearer-headers over elke call, dus http zou ze op het netwerk blootleggen
/// (§7.3 MITM). Enige uitzondering: `http://localhost`/`127.0.0.1` voor lokaal
/// testen met een dev-Worker.
fn normalize_server(url: &str) -> Result<String, String> {
    let s = url.trim().trim_end_matches('/');
    if !(s.starts_with("https://") || is_local_http(s)) {
        return Err("Server-URL moet met https:// beginnen.".into());
    }
    if s.len() < "https://a.b".len() {
        return Err("Vul een geldige server-URL in.".into());
    }
    Ok(s.to_string())
}

/// `http://` mag alleen naar een échte localhost-host. De host is het deel tussen
/// `http://` en de eerste `:` (poort) of `/` (pad); via die boundary telt
/// `http://localhost.evil.com` (host `localhost.evil.com`) NIET als lokaal — anders
/// zou een geknutselde URL de bearer-tokens alsnog plaintext naar een remote host
/// sturen.
fn is_local_http(s: &str) -> bool {
    let Some(rest) = s.strip_prefix("http://") else {
        return false;
    };
    let host = rest.split(['/', ':']).next().unwrap_or("");
    host == "localhost" || host == "127.0.0.1"
}

/// De QR-payload (§7.1). Wijst naar de root (`/#…`), niet naar een aparte
/// /pair-route: de PWA leest het fragment ongeacht het pad, en de Worker serveert
/// de PWA op `/`. Het fragment (`#…`) wordt door browsers niet naar de server
/// gestuurd, dus token + sleutel blijven client-side.
fn qr(server: &str, mailbox_id: &str, upload_token: &str, master_key_b64: &str) -> String {
    format!("{server}/#v=1&mb={mailbox_id}&t={upload_token}&k={master_key_b64}")
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

// ---- Tauri-commands ----

/// Koppel een nieuwe telefoon: genereer ids/tokens/sleutel, registreer bij de
/// server (alleen hashes), bewaar geheim in de Credential Manager en geef de
/// QR-payload éénmalig terug.
#[tauri::command]
pub async fn inbox_pair(server_url: String, invite_code: String) -> Result<PairResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let server = normalize_server(&server_url)?;
        let invite = invite_code.trim();
        if invite.is_empty() {
            return Err("Vul een invite-code in.".into());
        }
        let mailbox_id = uuid::Uuid::new_v4().to_string();
        let owner_token = b64url(&rand32());
        let upload_token = b64url(&rand32());
        let master = rand32();

        api::register_mailbox(
            &server,
            invite,
            &mailbox_id,
            &api::sha256_hex(&owner_token),
            &api::sha256_hex(&upload_token),
        )?;

        let pairing = store::Pairing {
            server_url: server.clone(),
            mailbox_id: mailbox_id.clone(),
            owner_token,
            upload_token: upload_token.clone(),
            master_key_hex: hex(&master),
            paired_at: now_iso(),
        };
        store::save(&pairing)?;

        Ok(PairResult {
            qr_payload: qr(&server, &mailbox_id, &upload_token, &b64url(&master)),
            mailbox_short_id: short(&mailbox_id),
        })
    })
    .await
    .map_err(|e| format!("taak-fout: {e}"))?
}

/// Niet-geheime koppelstatus voor de UI.
#[tauri::command]
pub async fn inbox_status() -> Result<InboxStatus, String> {
    match store::load()? {
        Some(p) => Ok(InboxStatus {
            configured: true,
            server_url: Some(p.server_url),
            mailbox_short_id: Some(short(&p.mailbox_id)),
            paired_at: Some(p.paired_at),
        }),
        None => Ok(InboxStatus::default()),
    }
}

/// Aantal klaarstaande memories (voor de badge). Fout = niet gekoppeld of offline;
/// de frontend toont de badge dan gewoon niet.
#[tauri::command]
pub async fn inbox_pending_count() -> Result<u32, String> {
    let p = store::load()?.ok_or("Niet gekoppeld.")?;
    tauri::async_runtime::spawn_blocking(move || api::count_ready(&p.server_url, &p.mailbox_id, &p.owner_token))
        .await
        .map_err(|e| format!("taak-fout: {e}"))?
}

/// Nieuwe koppelcode: roteert upload-token én masterKey. Weigert (`pending:<n>`)
/// zolang er nog `ready`-memories onder de oude sleutel staan — de frontend biedt
/// dan importeren of expliciet weggooien aan.
#[tauri::command]
pub async fn inbox_rotate_upload_token() -> Result<PairResult, String> {
    let mut p = store::load()?.ok_or("Niet gekoppeld.")?;
    tauri::async_runtime::spawn_blocking(move || {
        // Deze telling dekt ook de discard→rotate-TOCTOU af: mocht de telefoon
        // tussen "pending weggooien" en hier tóch nog iets uploaden, dan weigert
        // deze check opnieuw (verse `pending:<n>`) i.p.v. stil een nog-te-
        // importeren memory onontsleutelbaar te maken.
        let pending = api::count_ready(&p.server_url, &p.mailbox_id, &p.owner_token)?;
        if pending > 0 {
            return Err(format!("pending:{pending}"));
        }
        let upload_token = b64url(&rand32());
        let master = rand32();
        // Server eerst (die is de bron van waarheid voor de token-hash), dán het
        // keyring. Faalt `store::save` hierna, dan komt de fout omhoog en toont de
        // UI géén QR; de gebruiker probeert opnieuw (ownerToken blijft geldig, de
        // brievenbus is nog leeg, dus een herhaalde rotate is veilig).
        api::rotate_upload_token(&p.server_url, &p.mailbox_id, &p.owner_token, &api::sha256_hex(&upload_token))?;
        p.upload_token = upload_token.clone();
        p.master_key_hex = hex(&master);
        store::save(&p)?;
        Ok(PairResult {
            qr_payload: qr(&p.server_url, &p.mailbox_id, &upload_token, &b64url(&master)),
            mailbox_short_id: short(&p.mailbox_id),
        })
    })
    .await
    .map_err(|e| format!("taak-fout: {e}"))?
}

/// Gooi alle nog-pending (`ready`) memories op de server weg. Geeft het aantal
/// verwijderde memories terug. Gebruikt door de rotate- en ontkoppel-flow.
#[tauri::command]
pub async fn inbox_discard_pending() -> Result<u32, String> {
    let p = store::load()?.ok_or("Niet gekoppeld.")?;
    tauri::async_runtime::spawn_blocking(move || {
        let ids = api::list_ready_ids(&p.server_url, &p.mailbox_id, &p.owner_token)?;
        let mut n = 0u32;
        for id in ids {
            api::delete_memory(&p.server_url, &p.mailbox_id, &p.owner_token, &id)?;
            n += 1;
        }
        Ok(n)
    })
    .await
    .map_err(|e| format!("taak-fout: {e}"))?
}

/// Ontkoppel deze desktop: verwijder de mailbox op de server (best-effort) en wis
/// de geheimen lokaal. Lokaal ontkoppelen slaagt altijd, ook als de server weg is
/// (de cron ruimt een verweesde mailbox anders binnen 30 dagen op).
#[tauri::command]
pub async fn inbox_unpair() -> Result<(), String> {
    if let Some(p) = store::load()? {
        let _ = tauri::async_runtime::spawn_blocking(move || {
            api::delete_mailbox(&p.server_url, &p.mailbox_id, &p.owner_token)
        })
        .await;
    }
    store::clear()
}

/// Importeer alle klaarstaande memories in de vault (§9.2). Het zware werk (HTTP +
/// ontsleutelen + schrijven) draait in `spawn_blocking`; daarna herindexeert de
/// VaultService één keer zodat de nieuwe events in de UI verschijnen.
#[tauri::command]
pub async fn inbox_import(
    app: AppHandle,
    window: Window,
    state: State<'_, VaultService>,
) -> Result<import::ImportReport, String> {
    let vault_root = state
        .current_vault()
        .map_err(|_| "Kies eerst een vault-map in Instellingen → Opslag.".to_string())?;
    let pairing = store::load()?.ok_or("Niet gekoppeld.")?;
    let report = tauri::async_runtime::spawn_blocking(move || import::run(&app, &window, &vault_root, &pairing))
        .await
        .map_err(|e| format!("taak-fout: {e}"))??;
    state.rescan()?;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_server_requires_https_or_localhost() {
        assert_eq!(normalize_server("https://x.workers.dev/").unwrap(), "https://x.workers.dev");
        assert!(normalize_server("http://localhost:8787").is_ok());
        assert!(normalize_server("http://127.0.0.1:8787/").is_ok());
        // Remote plaintext geweigerd.
        assert!(normalize_server("http://evil.com").is_err());
        // Boundary-bypass (host = localhost.evil.com) geweigerd.
        assert!(normalize_server("http://localhost.evil.com").is_err());
        assert!(normalize_server("http://127.0.0.1.evil.com").is_err());
        assert!(normalize_server("ftp://x.y").is_err());
        assert!(normalize_server("").is_err());
    }

    #[test]
    fn qr_payload_shape() {
        assert_eq!(qr("https://h", "mb-1", "tok", "keyb64"), "https://h/#v=1&mb=mb-1&t=tok&k=keyb64");
    }

    #[test]
    fn rand32_is_32_bytes_and_varies() {
        assert_eq!(rand32().len(), 32);
        assert_ne!(rand32(), rand32());
    }
}
