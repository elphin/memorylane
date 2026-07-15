//! Geheime opslag van de pairing (fase 4). De masterKey en het owner-token mogen
//! NIET op schijf of in de vault belanden (die kan op een NAS/gedeelde schijf
//! staan) — ze gaan in de **Windows Credential Manager** via de `keyring`-crate.
//! Alles staat als één JSON-blob onder service `memorylane-inbox`, account
//! `pairing`. De niet-geheime status voor de UI komt via `inbox_status`.

use keyring::Entry;
use serde::{Deserialize, Serialize};

const SERVICE: &str = "memorylane-inbox";
const ACCOUNT: &str = "pairing";

/// De volledige pairing zoals de desktop 'm bewaart. `owner_token` authenticeert
/// alle owner-calls (server bewaart alleen SHA-256(token)); `upload_token` +
/// `master_key_hex` zitten in de QR en zijn nodig om die desgewenst opnieuw te
/// tonen. Bij rotatie wisselen `upload_token` en `master_key_hex` mee.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Pairing {
    pub server_url: String,
    pub mailbox_id: String,
    pub owner_token: String,
    pub upload_token: String,
    pub master_key_hex: String,
    pub paired_at: String, // RFC 3339
}

fn entry() -> Result<Entry, String> {
    Entry::new(SERVICE, ACCOUNT).map_err(|e| format!("keyring openen: {e}"))
}

/// Lees de pairing (of `None` als er nog geen is).
pub fn load() -> Result<Option<Pairing>, String> {
    match entry()?.get_password() {
        Ok(json) => serde_json::from_str(&json).map(Some).map_err(|e| format!("pairing parsen: {e}")),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("keyring lezen: {e}")),
    }
}

/// Schrijf (of overschrijf) de pairing.
pub fn save(p: &Pairing) -> Result<(), String> {
    let json = serde_json::to_string(p).map_err(|e| e.to_string())?;
    entry()?.set_password(&json).map_err(|e| format!("keyring schrijven: {e}"))
}

/// Wis de pairing. Ontbreekt hij al, dan is dat geen fout (idempotent ontkoppelen).
pub fn clear() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("keyring wissen: {e}")),
    }
}
