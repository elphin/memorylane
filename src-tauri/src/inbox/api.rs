//! HTTP-client naar de brievenbus-Worker (fase 4). Synchroon (`reqwest::blocking`)
//! omdat de aanroepers dit in een `spawn_blocking` draaien; de blocking-client
//! draait zijn eigen achtergrond-runtime, dus geen "runtime-in-runtime".
//!
//! Autorisatie: owner-calls sturen `X-Mailbox` + `Bearer <owner_token>`; de server
//! bewaart alleen SHA-256(token) en vergelijkt constant-time. Registratie stuurt
//! uitsluitend de token-hashes mee, nooit de tokens zelf.

use serde::Deserialize;
use sha2::{Digest, Sha256};

/// hex(SHA-256(text)) — exact het formaat dat de Worker opslaat/vergelijkt.
pub fn sha256_hex(text: &str) -> String {
    Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

fn client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("HTTP-client: {e}"))
}

fn neterr(e: reqwest::Error) -> String {
    if e.is_connect() || e.is_timeout() {
        "Geen verbinding met de brievenbus-server. Controleer de server-URL en je internet.".into()
    } else {
        format!("Netwerkfout: {e}")
    }
}

#[derive(Deserialize)]
struct ApiErr {
    error: Option<ApiErrBody>,
}
#[derive(Deserialize)]
struct ApiErrBody {
    #[allow(dead_code)]
    code: Option<String>,
    message: Option<String>,
}

/// Geef de response terug bij 2xx; anders de servermelding (of een status-fout).
fn check(resp: reqwest::blocking::Response) -> Result<reqwest::blocking::Response, String> {
    if resp.status().is_success() {
        return Ok(resp);
    }
    let status = resp.status().as_u16();
    let body = resp.text().unwrap_or_default();
    let msg = serde_json::from_str::<ApiErr>(&body)
        .ok()
        .and_then(|e| e.error)
        .and_then(|e| e.message)
        .unwrap_or_else(|| match status {
            401 => "Ongeldige mailbox of token.".into(),
            403 => "Ongeldige invite-code.".into(),
            429 => "Te veel pogingen — probeer het later opnieuw.".into(),
            _ => format!("Serverfout ({status})."),
        });
    Err(msg)
}

/// POST /api/mailboxes — registreer met invite-code en de twee token-hashes.
pub fn register_mailbox(
    server: &str,
    invite: &str,
    mailbox_id: &str,
    owner_hash: &str,
    upload_hash: &str,
) -> Result<(), String> {
    let body = serde_json::json!({
        "mailboxId": mailbox_id,
        "ownerTokenHash": owner_hash,
        "uploadTokenHash": upload_hash,
    });
    let resp = client()?
        .post(format!("{server}/api/mailboxes"))
        .header("X-Invite-Code", invite)
        .json(&body)
        .send()
        .map_err(neterr)?;
    check(resp).map(|_| ())
}

/// POST /api/mailboxes/rotate-upload-token — owner. Zet een nieuw upload-token-hash.
pub fn rotate_upload_token(
    server: &str,
    mailbox_id: &str,
    owner_token: &str,
    upload_hash: &str,
) -> Result<(), String> {
    let resp = client()?
        .post(format!("{server}/api/mailboxes/rotate-upload-token"))
        .header("X-Mailbox", mailbox_id)
        .bearer_auth(owner_token)
        .json(&serde_json::json!({ "uploadTokenHash": upload_hash }))
        .send()
        .map_err(neterr)?;
    check(resp).map(|_| ())
}

/// DELETE /api/mailboxes — owner. Mailbox + alle memories + R2-objecten weg.
pub fn delete_mailbox(server: &str, mailbox_id: &str, owner_token: &str) -> Result<(), String> {
    let resp = client()?
        .delete(format!("{server}/api/mailboxes"))
        .header("X-Mailbox", mailbox_id)
        .bearer_auth(owner_token)
        .send()
        .map_err(neterr)?;
    check(resp).map(|_| ())
}

/// GET /api/memories/count?status=ready — owner. Aantal klaarstaande memories.
pub fn count_ready(server: &str, mailbox_id: &str, owner_token: &str) -> Result<u32, String> {
    #[derive(Deserialize)]
    struct CountResp {
        count: u32,
    }
    let resp = client()?
        .get(format!("{server}/api/memories/count?status=ready"))
        .header("X-Mailbox", mailbox_id)
        .bearer_auth(owner_token)
        .send()
        .map_err(neterr)?;
    let resp = check(resp)?;
    Ok(resp.json::<CountResp>().map_err(|e| format!("antwoord lezen: {e}"))?.count)
}

/// GET /api/memories?status=ready — owner. Alleen de memoryId's (voor discard).
pub fn list_ready_ids(server: &str, mailbox_id: &str, owner_token: &str) -> Result<Vec<String>, String> {
    #[derive(Deserialize)]
    struct MemRow {
        #[serde(rename = "memoryId")]
        memory_id: String,
    }
    let resp = client()?
        .get(format!("{server}/api/memories?status=ready"))
        .header("X-Mailbox", mailbox_id)
        .bearer_auth(owner_token)
        .send()
        .map_err(neterr)?;
    let resp = check(resp)?;
    Ok(resp
        .json::<Vec<MemRow>>()
        .map_err(|e| format!("antwoord lezen: {e}"))?
        .into_iter()
        .map(|m| m.memory_id)
        .collect())
}

/// DELETE /api/memories/:id — owner. Trekt één memory in.
pub fn delete_memory(server: &str, mailbox_id: &str, owner_token: &str, memory_id: &str) -> Result<(), String> {
    let resp = client()?
        .delete(format!("{server}/api/memories/{memory_id}"))
        .header("X-Mailbox", mailbox_id)
        .bearer_auth(owner_token)
        .send()
        .map_err(neterr)?;
    check(resp).map(|_| ())
}

/// GET /api/memories/:id/urls — owner. Verse presigned GET-URLs `{fileId: url}`
/// (incl. `envelope`).
pub fn memory_urls(
    server: &str,
    mailbox_id: &str,
    owner_token: &str,
    memory_id: &str,
) -> Result<std::collections::HashMap<String, String>, String> {
    let resp = client()?
        .get(format!("{server}/api/memories/{memory_id}/urls"))
        .header("X-Mailbox", mailbox_id)
        .bearer_auth(owner_token)
        .send()
        .map_err(neterr)?;
    let resp = check(resp)?;
    resp.json::<std::collections::HashMap<String, String>>()
        .map_err(|e| format!("antwoord lezen: {e}"))
}

/// POST /api/memories/:id/ack — owner. Import gelukt: server verwijdert R2 + zet
/// de memory op `imported` (tombstone).
pub fn ack_memory(server: &str, mailbox_id: &str, owner_token: &str, memory_id: &str) -> Result<(), String> {
    let resp = client()?
        .post(format!("{server}/api/memories/{memory_id}/ack"))
        .header("X-Mailbox", mailbox_id)
        .bearer_auth(owner_token)
        .send()
        .map_err(neterr)?;
    check(resp).map(|_| ())
}

/// Presigned R2 GET → geheel in geheugen (alleen voor de kleine envelope). Geen
/// auth-headers: de URL is zelf al ondertekend.
pub fn download_bytes(url: &str) -> Result<Vec<u8>, String> {
    let resp = client()?.get(url).send().map_err(neterr)?;
    let resp = check(resp)?;
    Ok(resp.bytes().map_err(|e| format!("download lezen: {e}"))?.to_vec())
}

/// Presigned R2 GET → streaming naar een bestand (voor grote media; niet in RAM).
pub fn download_to_file(url: &str, dest: &std::path::Path) -> Result<u64, String> {
    let resp = client()?.get(url).send().map_err(neterr)?;
    let mut resp = check(resp)?;
    let mut file = std::fs::File::create(dest).map_err(|e| format!("temp aanmaken: {e}"))?;
    let n = std::io::copy(&mut resp, &mut file).map_err(|e| format!("download schrijven: {e}"))?;
    Ok(n)
}
