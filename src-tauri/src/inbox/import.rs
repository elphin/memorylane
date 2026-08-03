//! De inbox-import (fase 5, §9.2): haal klaarstaande memories op, ontsleutel ze,
//! en schrijf ze via de writer-laag rechtstreeks de vault in (één rescan aan het
//! eind, in `commands`). Idempotent over crashes heen dankzij een persistent
//! ledger in de app-data-dir — bewust NIET in de in-memory index-SQLite.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Window};

use super::{api, crypto, store};
use crate::vault::writer;

// ---- Rapport + voortgang ----

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub imported: u32,
    pub skipped: u32,
    pub errors: Vec<ImportError>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportError {
    pub memory_id: String,
    pub message: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress<'a> {
    memory_id: &'a str,
    memory_index: usize,
    memory_count: usize,
    step: &'a str,
    file_index: usize,
    file_count: usize,
}

fn emit(w: &Window, memory_id: &str, mi: usize, mc: usize, step: &str, fi: usize, fc: usize) {
    let _ = w.emit(
        "inbox://progress",
        Progress { memory_id, memory_index: mi, memory_count: mc, step, file_index: fi, file_count: fc },
    );
}

// ---- Envelope (§8.2) ----

#[derive(Deserialize)]
struct Envelope {
    v: u32,
    #[serde(rename = "memoryId")]
    memory_id: String,
    title: String,
    #[serde(rename = "startAt")]
    start_at: String,
    #[serde(rename = "endAt")]
    end_at: Option<String>,
    note: Option<String>,
    files: Vec<EnvFile>,
}

#[derive(Deserialize)]
struct EnvFile {
    #[serde(rename = "fileId")]
    file_id: String,
    name: String,
    mime: String,
    order: u32,
}

// ---- Ledger (idempotentie) ----

#[derive(Serialize, Deserialize, Default)]
struct Ledger {
    memories: HashMap<String, LedgerEntry>,
}

#[derive(Serialize, Deserialize, Clone)]
struct LedgerEntry {
    state: String, // "importing" | "imported"
    event_id: Option<String>,
    folder_path: Option<String>,
    at: String,
}

fn ledger_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("inbox-ledger.json"))
}

fn load_ledger(app: &AppHandle) -> Ledger {
    ledger_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_ledger(app: &AppHandle, l: &Ledger) -> Result<(), String> {
    let p = ledger_path(app)?;
    if let Some(par) = p.parent() {
        std::fs::create_dir_all(par).map_err(|e| e.to_string())?;
    }
    let tmp = p.with_extension(format!("tmp.{}", std::process::id()));
    std::fs::write(&tmp, serde_json::to_string_pretty(l).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

// ---- Temp-map-guard (ruimt altijd op) ----

struct TempGuard(PathBuf);
impl Drop for TempGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

// ---- Helpers ----

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn master_from_hex(hex: &str) -> Result<[u8; 32], String> {
    if hex.len() != 64 {
        return Err("masterKey heeft niet 32 bytes".into());
    }
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).map_err(|_| "masterKey niet hex".to_string())?;
    }
    Ok(out)
}

fn is_date(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b[0..4].iter().all(u8::is_ascii_digit)
        && b[5..7].iter().all(u8::is_ascii_digit)
        && b[8..10].iter().all(u8::is_ascii_digit)
}

/// Extensie uit een MIME-type (voor bestanden zonder bruikbare naam).
fn ext_from_mime(mime: &str) -> &'static str {
    match mime.to_ascii_lowercase().as_str() {
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/heic" => "heic",
        "image/heif" => "heif",
        "image/avif" => "avif",
        "video/mp4" => "mp4",
        "video/quicktime" => "mov",
        "video/webm" => "webm",
        _ => "bin",
    }
}

/// Sanitiseer een bestandsnaam uit de envelope: alleen de basename, geen
/// path-separators/controltekens; een lege naam wordt `bestand.<ext-uit-mime>`.
fn sanitize_name(name: &str, mime: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let cleaned: String = base.chars().filter(|c| !c.is_control() && *c != '/' && *c != '\\').collect();
    let trimmed = cleaned.trim().trim_matches('.').trim().to_string();
    if trimmed.is_empty() {
        format!("bestand.{}", ext_from_mime(mime))
    } else {
        trimmed
    }
}

fn validate_envelope(env: &Envelope, memory_id: &str) -> Result<(), String> {
    if env.v != 1 {
        return Err("onbekende envelope-versie".into());
    }
    if env.memory_id != memory_id {
        return Err("memoryId in de envelope komt niet overeen".into());
    }
    if env.title.trim().is_empty() {
        return Err("lege titel".into());
    }
    if !is_date(&env.start_at) {
        return Err("ongeldige startAt".into());
    }
    if let Some(e) = env.end_at.as_deref() {
        if !is_date(e) {
            return Err("ongeldige endAt".into());
        }
        if e < env.start_at.as_str() {
            return Err("endAt ligt vóór startAt".into());
        }
    }
    Ok(())
}

// ---- Hoofdflow ----

enum Outcome {
    Imported,
    AckedOnly,
}

/// Importeer alle klaarstaande memories. Roept per memory `import_one`; fouten
/// per memory worden verzameld, niet fataal. De caller doet daarna één rescan.
pub fn run(app: &AppHandle, window: &Window, vault_root: &Path, pairing: &store::Pairing) -> Result<ImportReport, String> {
    let master = master_from_hex(&pairing.master_key_hex)?;
    let mut ledger = load_ledger(app);
    let ids = api::list_ready_ids(&pairing.server_url, &pairing.mailbox_id, &pairing.owner_token)?;
    let count = ids.len();
    let mut report = ImportReport::default();
    for (idx, memory_id) in ids.iter().enumerate() {
        match import_one(app, window, vault_root, pairing, &master, &mut ledger, memory_id, idx, count) {
            Ok(Outcome::Imported) => report.imported += 1,
            Ok(Outcome::AckedOnly) => {} // was al geïmporteerd, alleen ge-ackt
            Err(e) => {
                report.skipped += 1;
                report.errors.push(ImportError { memory_id: memory_id.clone(), message: e });
            }
        }
    }
    Ok(report)
}

#[allow(clippy::too_many_arguments)]
fn import_one(
    app: &AppHandle,
    window: &Window,
    vault_root: &Path,
    p: &store::Pairing,
    master: &[u8; 32],
    ledger: &mut Ledger,
    memory_id: &str,
    idx: usize,
    count: usize,
) -> Result<Outcome, String> {
    // Ledger-check (herstel na crash).
    if let Some(entry) = ledger.memories.get(memory_id).cloned() {
        if entry.state == "imported" {
            // Vorige run crashte ná import, vóór/tijdens ack → alleen nog acken.
            api::ack_memory(&p.server_url, &p.mailbox_id, &p.owner_token, memory_id)?;
            return Ok(Outcome::AckedOnly);
        }
        if entry.state == "importing" {
            // Vorige run crashte middenin het schrijven → half event opruimen. Lukt
            // dat NIET (bv. trash faalt op een NAS-vault, map vergrendeld), dan
            // moeten we stoppen: anders zou de her-import een dúbbel event maken
            // (id-suffix) dat ná de ack niet meer van de server te herstellen is.
            // `delete_event` geeft Ok als de map al weg is, dus dit is veilig.
            if let Some(folder) = entry.folder_path.as_deref() {
                writer::delete_event(vault_root, folder)?;
            }
        }
    }

    // Verse presigned URLs + envelope.
    emit(window, memory_id, idx, count, "download", 0, 0);
    let urls = api::memory_urls(&p.server_url, &p.mailbox_id, &p.owner_token, memory_id)?;
    let env_url = urls.get("envelope").ok_or("envelope ontbreekt op de server")?;
    let env_ct = api::download_bytes(env_url)?;
    let env_bytes = crypto::decrypt_blob(&env_ct, master, memory_id, "envelope")?;
    let env: Envelope = serde_json::from_slice(&env_bytes).map_err(|e| format!("envelope ongeldig: {e}"))?;
    validate_envelope(&env, memory_id)?;

    // Temp-map (wordt door de guard altijd opgeruimd).
    let temp = std::env::temp_dir().join("memorylane-inbox").join(memory_id);
    let _ = std::fs::remove_dir_all(&temp);
    std::fs::create_dir_all(&temp).map_err(|e| format!("temp-map: {e}"))?;
    let _guard = TempGuard(temp.clone());

    // De envelope is de autoriteit over de bestandslijst: elk bestand MOET er zijn,
    // anders slaan we de hele memory over (géén ack) — een kapotte server mag niet
    // stilletjes bestanden laten wegvallen.
    let fc = env.files.len();
    // (order, vault-naam, temp-pad, fallback-happenedAt, opname-metadata uit de EXIF)
    let mut plains: Vec<(u32, String, PathBuf, String, crate::media::exif_read::ShotMeta)> =
        Vec::with_capacity(fc);
    for (fi, f) in env.files.iter().enumerate() {
        emit(window, memory_id, idx, count, "download", fi, fc);
        let url = urls.get(&f.file_id).ok_or_else(|| format!("bestand ontbreekt op de server: {}", f.name))?;
        // Temp-bestandsnamen zijn puur op de lus-index gebaseerd — nooit op
        // `f.file_id`/`f.name` uit de (semi-vertrouwde) envelope, die illegale of
        // reserveerde tekens kunnen bevatten en `File::create` op Windows laten
        // falen. De vault-naam wordt los afgeleid via `import_media` (generate_slug).
        let ct_path = temp.join(format!("{fi:04}.ct"));
        let plain_path = temp.join(format!("{fi:04}.plain"));
        api::download_to_file(url, &ct_path)?;

        emit(window, memory_id, idx, count, "decrypt", fi, fc);
        decrypt_file(&ct_path, &plain_path, master, memory_id, &f.file_id)
            .map_err(|e| format!("ontsleutelen mislukt ({}): {e}", f.name))?;
        let _ = std::fs::remove_file(&ct_path); // ciphertext niet meer nodig

        let name = sanitize_name(&f.name, &f.mime);
        // 12:00:00 + order → monotone volgorde (Z verplicht voor to_millis). `mm/ss`
        // blijft geldig zolang order < 3600; de server begrenst media/memory
        // (LIMITS.maxFilesPerMemory = 50), dus dat kan niet worden overschreden.
        // Dit is de FALLBACK; hieronder wint de echte opnametijd uit de EXIF.
        let happened = format!("{}T12:{:02}:{:02}Z", env.start_at, f.order / 60, f.order % 60);
        // De envelope draagt geen EXIF mee, maar de foto-bytes zelf wél — lees ze hier
        // uit het zojuist ontsleutelde bestand.
        let shot = crate::media::exif_read::read_shot_meta(&plain_path);
        plains.push((f.order, name, plain_path, happened, shot));
    }

    // Vault-import via de writer-laag.
    emit(window, memory_id, idx, count, "write", 0, fc);
    let year = &env.start_at[0..4];
    let (event_id, folder) =
        writer::create_event(vault_root, year, env.title.trim(), &env.start_at, env.end_at.as_deref(), None)
            .map_err(|e| e.to_string())?;
    // Ledger 'importing' meteen na create_event (folder bekend) → crash-herstel.
    ledger.memories.insert(
        memory_id.to_string(),
        LedgerEntry {
            state: "importing".into(),
            event_id: Some(event_id.clone()),
            folder_path: Some(folder.clone()),
            at: now_iso(),
        },
    );
    save_ledger(app, ledger)?;

    // Geïmporteerde memories starten "in aanbouw".
    writer::set_event_under_construction(vault_root, &folder, true).map_err(|e| e.to_string())?;

    // Notitie (indien niet-leeg) — geen happenedAt, sorteert vóór de media.
    if let Some(note) = env.note.as_deref().filter(|n| !n.trim().is_empty()) {
        writer::create_text_item(vault_root, &folder, None, note).map_err(|e| e.to_string())?;
    }

    // Media in envelope-volgorde.
    plains.sort_by_key(|f| f.0);
    // Opnamemoment: de EXIF-tijd is de waarheid over WANNEER een foto genomen is, dus
    // die wint van de volgorde waarin je ze in de telefoon-app zette (keuze van Jim).
    // Heeft géén enkel bestand een opnametijd, dan houdt de hele memory het geschatte
    // `T12:MM:SS`-schema — een half geschatte reeks is verwarrender dan een consequent
    // geschatte. Bestanden zonder EXIF (video, screenshot, doorgestuurde foto) worden
    // tússen hun buren geïnterpoleerd, zodat ze op hun gekozen plek blijven staan.
    let times: Vec<Option<chrono::DateTime<chrono::FixedOffset>>> = plains
        .iter()
        .map(|(_, _, _, _, shot)| {
            shot.taken_at
                .as_deref()
                .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
        })
        .collect();
    let use_exif = times.iter().any(Option::is_some);
    let stamps = interpolate_times(&times);
    for (i, (_, name, plain_path, happened, shot)) in plains.iter().enumerate() {
        let when = match stamps.get(i).copied().flatten().filter(|_| use_exif) {
            Some(t) => t.to_rfc3339(),
            None => happened.clone(),
        };
        let place = shot.lat.zip(shot.lng);
        writer::import_media(vault_root, &folder, plain_path, name, &when, place)?;
    }

    // Ledger 'imported' → dan pas acken. Mislukt de ack (netwerk), dan repareert
    // de volgende run 'm (ledger staat op imported → alleen ack).
    ledger.memories.insert(
        memory_id.to_string(),
        LedgerEntry { state: "imported".into(), event_id: Some(event_id), folder_path: Some(folder), at: now_iso() },
    );
    save_ledger(app, ledger)?;

    emit(window, memory_id, idx, count, "ack", fc, fc);
    let _ = api::ack_memory(&p.server_url, &p.mailbox_id, &p.owner_token, memory_id);
    Ok(Outcome::Imported)
}

/// Streaming-ontsleutel een ciphertext-bestand naar een plaintext-bestand.
fn decrypt_file(ct: &Path, plain: &Path, master: &[u8; 32], memory_id: &str, file_id: &str) -> Result<(), String> {
    let r = std::io::BufReader::new(std::fs::File::open(ct).map_err(|e| e.to_string())?);
    let w = std::io::BufWriter::new(std::fs::File::create(plain).map_err(|e| e.to_string())?);
    crypto::decrypt_stream(r, w, master, memory_id, file_id).map(|_| ())
}

/// Vult de gaten in een reeks opnametijden: een bestand zonder EXIF komt tússen zijn
/// buren te liggen (gelijk verdeeld), vóór de eerste of ná de laatste bekende tijd als
/// het aan een uiteinde staat. Zo blijft de door de gebruiker gekozen volgorde intact
/// én is de reeks oplopend — dat laatste is wat `ORDER BY timestamp_ms` nodig heeft.
///
/// Zijn er helemaal geen tijden, dan blijft alles `None` (de aanroeper valt dan terug
/// op het geschatte schema).
fn interpolate_times(
    times: &[Option<chrono::DateTime<chrono::FixedOffset>>],
) -> Vec<Option<chrono::DateTime<chrono::FixedOffset>>> {
    let mut out = times.to_vec();
    if !times.iter().any(Option::is_some) {
        return out;
    }
    const TAIL_STEP: i64 = 1; // seconden per bestand ná de laatste bekende tijd
    let mut i = 0;
    while i < out.len() {
        if out[i].is_some() {
            i += 1;
            continue;
        }
        // Gat [i, j) zoeken en de randen erbij pakken.
        let mut j = i;
        while j < out.len() && out[j].is_none() {
            j += 1;
        }
        let before = if i == 0 { None } else { out[i - 1] };
        let after = if j < out.len() { out[j] } else { None };
        let gap = (j - i) as i64;
        match (before, after) {
            (Some(a), Some(b)) => {
                // Gelijk verdelen over de beschikbare ruimte. Is die er niet (burst:
                // beide buren in dezelfde seconde), dan krijgt het gat de tijd van de
                // linkerbuur: gelijke stempels zijn prima — `ORDER BY timestamp_ms,
                // slug` heeft een deterministische tie-break — maar een stempel NÁ de
                // rechterbuur zou het bestand achter zijn eigen opvolger zetten.
                let span = (b - a).num_milliseconds().max(0);
                for k in 0..gap {
                    let ms = span * (k + 1) / (gap + 1);
                    out[i + k as usize] = Some(a + chrono::Duration::milliseconds(ms));
                }
            }
            (Some(a), None) => {
                for k in 0..gap {
                    out[i + k as usize] = Some(a + chrono::Duration::seconds((k + 1) * TAIL_STEP));
                }
            }
            (None, Some(b)) => {
                for k in 0..gap {
                    out[k as usize] = Some(b - chrono::Duration::seconds(gap - k));
                }
            }
            (None, None) => unreachable!("er is minstens één bekende tijd"),
        }
        i = j;
    }
    out
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_name_strips_paths_and_control() {
        assert_eq!(sanitize_name("../../etc/passwd", "image/jpeg"), "passwd");
        assert_eq!(sanitize_name("IMG_0001.JPG", "image/jpeg"), "IMG_0001.JPG");
        assert_eq!(sanitize_name("a\\b\\c.mov", "video/quicktime"), "c.mov");
        assert_eq!(sanitize_name("   ", "image/heic"), "bestand.heic");
        assert_eq!(sanitize_name("..", "video/mp4"), "bestand.mp4");
    }

    #[test]
    fn is_date_accepts_only_yyyy_mm_dd() {
        assert!(is_date("2026-07-11"));
        assert!(!is_date("2026-7-11"));
        assert!(!is_date("2026-07-11T12:00"));
        assert!(!is_date("11-07-2026"));
    }

    #[test]
    fn master_from_hex_validates_length() {
        assert!(master_from_hex("00").is_err());
        assert_eq!(master_from_hex(&"ab".repeat(32)).unwrap()[0], 0xab);
    }
    /// Bestanden zonder EXIF (video, screenshot) horen tússen hun buren te belanden,
    /// zodat de door de gebruiker gekozen volgorde intact blijft én de reeks oplopend
    /// is — `ORDER BY timestamp_ms` heeft dat laatste nodig.
    #[test]
    fn interpolate_times_fills_gaps_monotonically() {
        let t = |s: &str| chrono::DateTime::parse_from_rfc3339(s).unwrap();
        // Gat in het midden: gelijk verdeeld tussen de buren.
        let out = interpolate_times(&[
            Some(t("2024-07-11T10:00:00+02:00")),
            None,
            None,
            Some(t("2024-07-11T10:00:30+02:00")),
        ]);
        let v: Vec<_> = out.iter().map(|o| o.unwrap()).collect();
        assert_eq!(v[1], t("2024-07-11T10:00:10+02:00"));
        assert_eq!(v[2], t("2024-07-11T10:00:20+02:00"));
        assert!(v.windows(2).all(|w| w[0] <= w[1]), "moet oplopend zijn: {v:?}");

        // Burst (beide buren in dezelfde seconde): er is geen ruimte te verdelen, dus
        // gelijke stempels — maar NOOIT ná de rechterbuur, want dan zou het bestand
        // achter zijn eigen opvolger belanden.
        let out = interpolate_times(&[
            Some(t("2024-07-11T10:00:00+02:00")),
            None,
            Some(t("2024-07-11T10:00:00+02:00")),
        ]);
        let v: Vec<_> = out.iter().map(|o| o.unwrap()).collect();
        assert!(v.windows(2).all(|w| w[0] <= w[1]), "mag niet omkeren: {v:?}");

        // Kop en staart zonder EXIF.
        let out = interpolate_times(&[None, Some(t("2024-07-11T10:00:00+02:00")), None]);
        let v: Vec<_> = out.iter().map(|o| o.unwrap()).collect();
        assert!(v[0] < v[1] && v[1] < v[2], "kop vóór, staart ná: {v:?}");

        // Helemaal geen tijden → niets ingevuld (aanroeper valt terug op de schatting).
        let out = interpolate_times(&[None, None]);
        assert!(out.iter().all(Option::is_none));

        // Lege lijst mag niet paniekeren.
        assert!(interpolate_times(&[]).is_empty());
    }
}
