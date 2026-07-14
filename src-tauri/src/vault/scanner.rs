//! Vault-scanner: leest de mappenstructuur (jaren → events → items) in een
//! `VaultModel`. Strikt **read-only** — schrijft nooit in de vault.
//!
//! Kern-edge-cases (in het wild aangetroffen in de testvault):
//! - **Duplicate item-`.md`'s** die naar hetzelfde mediabestand wijzen
//!   (v1-bug): gededupliceerd, rijkste/oudste wint, duplicaat gelogd.
//! - **Losse media** zonder eigen `.md`: als synthetisch item met stabiel id
//!   (hash van vault-relatief pad), zodat referenties over scans heen kloppen.
//! - **`_`-prefix bestanden** zijn specials en worden nooit een item.
//! - Jaarmap zonder `_year.md`, eventmap zonder `_event.md`/`_canvas.json`.

use std::fs;
use std::path::Path;

use crate::model::{
    Event, EventKind, IndexError, Item, ItemType, Location, Severity, VaultModel, Year,
};
use crate::vault::canvas;
use crate::vault::frontmatter::{self, Parsed, Yaml};

/// Scant de vault-root en bouwt het volledige in-memory model.
pub fn scan(root: &Path) -> VaultModel {
    let mut model = VaultModel::default();

    let entries = match sorted_dir(root) {
        Ok(e) => e,
        Err(e) => {
            model.errors.push(IndexError {
                path: String::new(),
                severity: Severity::Error,
                reason: format!("kan vault-root niet lezen: {e}"),
            });
            return model;
        }
    };

    for entry in entries {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if !path.is_dir() {
            continue; // root-level bestanden (index.db, etc.) negeren
        }
        if is_ignored_dir(&name) {
            continue;
        }
        if is_year_folder(&name) {
            scan_year(root, &path, &name, &mut model);
        }
        // Niet-jaar-mappen op root-niveau worden genegeerd.
    }

    model
}

fn scan_year(root: &Path, year_path: &Path, folder_name: &str, model: &mut VaultModel) {
    let year_num: i32 = folder_name.parse().unwrap_or(0);
    let year_md = year_path.join("_year.md");
    let parsed = read_parsed(&year_md);
    log_unterminated(&parsed, &year_md, root, model);

    let id = parsed
        .as_ref()
        .and_then(|p| p.get_str("id"))
        .unwrap_or_else(|| stable_id("year", folder_name));
    let title = parsed
        .as_ref()
        .and_then(|p| p.get_str("title"))
        .unwrap_or_else(|| folder_name.to_string());
    let start_at = parsed
        .as_ref()
        .and_then(|p| p.get_str("startAt"))
        .unwrap_or_else(|| format!("{folder_name}-01-01"));
    let end_at = parsed
        .as_ref()
        .and_then(|p| p.get_str("endAt"))
        .or_else(|| Some(format!("{folder_name}-12-31")));

    let cover = parsed.as_ref().and_then(|p| p.get_str("cover"));
    let size_factor = parsed
        .as_ref()
        .and_then(|p| p.get_str("sizeFactor"))
        .and_then(|s| s.trim().parse::<f64>().ok());
    let year = Year {
        id: id.clone(),
        year: year_num,
        title,
        start_at,
        end_at,
        folder_name: folder_name.to_string(),
        cover,
        size_factor,
    };

    let entries = match sorted_dir(year_path) {
        Ok(e) => e,
        Err(e) => {
            model.errors.push(IndexError {
                path: folder_name.to_string(),
                severity: Severity::Error,
                reason: format!("kan jaarmap niet lezen: {e}"),
            });
            model.years.push(year);
            return;
        }
    };

    model.years.push(year.clone());

    let mut loose_media: Vec<String> = Vec::new();
    for entry in entries {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if path.is_dir() {
            if is_ignored_dir(&name) {
                continue;
            }
            scan_event(root, &path, &year, model);
        } else if !is_special(&name) && is_media_file(&name) {
            // Losse media direct in de jaarmap: verzamelen en straks bundelen in
            // één synthetische "Losse foto's"-memory (i.p.v. skippen).
            loose_media.push(name);
        }
    }
    if !loose_media.is_empty() {
        scan_loose_media_event(root, year_path, &year, &loose_media, model);
    }
}

/// Bundelt losse media direct in een jaarmap tot één synthetische "Losse foto's"-
/// memory. De memory heeft de jaarmap zelf als `folder_path` (zo resolven de
/// media-paden), een stabiel id en synthetische items. Effectief read-only: er
/// staat geen `_event.md` op schijf, dus schrijf-acties op deze memory beklijven
/// niet zoals bij een echte memory — uitgelicht/grootte geven een fout (geen
/// `_event.md`), en foto's importeren / canvas-layout landen wél in de jaarmap
/// maar worden bij de volgende scan opnieuw als losse media gebundeld (sidecar-
/// `.md`/`_canvas.json` worden op jaarniveau niet gelezen). Bedoeld om bestaande
/// foto-archieven meteen zichtbaar te maken; voor curatie maak je een echte memory.
fn scan_loose_media_event(
    root: &Path,
    year_path: &Path,
    year: &Year,
    media_files: &[String],
    model: &mut VaultModel,
) {
    let folder_path = rel_path(root, year_path); // de jaarmap zelf
    let event_id = stable_id("event", &format!("{folder_path}#loose"));
    let event_start_ms = to_millis(&year.start_at);
    for media in media_files {
        let media_rel = format!("{folder_path}/{media}");
        let item_type = media
            .rsplit('.')
            .next()
            .and_then(ItemType::from_extension)
            .unwrap_or(ItemType::Photo);
        model.items.push(Item {
            id: stable_id("item", &media_rel),
            event_id: event_id.clone(),
            item_type,
            media: Some(media.clone()),
            url: None,
            caption: None,
            happened_at: None,
            timestamp_ms: event_start_ms,
            place: None,
            people: Vec::new(),
            tags: Vec::new(),
            category: None,
            body_text: None,
            slug: None,
            synthetic: true,
        });
    }
    model.events.push(Event {
        id: event_id,
        kind: EventKind::Event,
        title: Some("Losse foto's".to_string()),
        description: None,
        start_at: year.start_at.clone(),
        end_at: None,
        location: None,
        featured_photo: None,
        tags: Vec::new(),
        size: None,
        under_construction: None,
        year_id: year.id.clone(),
        folder_path,
    });
}

fn scan_event(root: &Path, event_path: &Path, year: &Year, model: &mut VaultModel) {
    let folder_name = event_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let folder_path = rel_path(root, event_path);

    let event_md = event_path.join("_event.md");
    let parsed = read_parsed(&event_md);
    log_unterminated(&parsed, &event_md, root, model);

    let inferred = infer_event_from_folder(&folder_name);
    let id = parsed
        .as_ref()
        .and_then(|p| p.get_str("id"))
        .unwrap_or_else(|| stable_id("event", &folder_path));
    let kind = parsed
        .as_ref()
        .and_then(|p| p.get_str("type"))
        .and_then(|t| EventKind::parse(&t))
        .unwrap_or(EventKind::Event);
    let title = parsed
        .as_ref()
        .and_then(|p| p.get_str("title"))
        .or(inferred.title);
    let start_at = parsed
        .as_ref()
        .and_then(|p| p.get_str("startAt"))
        .or(inferred.start_at)
        .unwrap_or_else(|| year.start_at.clone());

    let event = Event {
        id: id.clone(),
        kind,
        title,
        description: parsed.as_ref().and_then(|p| p.get_str("description")),
        start_at: start_at.clone(),
        end_at: parsed.as_ref().and_then(|p| p.get_str("endAt")),
        location: parsed.as_ref().and_then(|p| read_location(p, "location")),
        featured_photo: parsed.as_ref().and_then(|p| p.get_str("featuredPhoto")),
        tags: parsed
            .as_ref()
            .and_then(|p| p.get("tags"))
            .map(|y| y.as_string_list())
            .unwrap_or_default(),
        size: parsed
            .as_ref()
            .and_then(|p| p.get_str("size"))
            .and_then(|s| s.trim().parse::<i64>().ok()),
        under_construction: parsed
            .as_ref()
            .and_then(|p| p.get_str("underConstruction"))
            .map(|s| s.trim().eq_ignore_ascii_case("true")),
        year_id: year.id.clone(),
        folder_path: folder_path.clone(),
    };

    // Canvas.
    let canvas_json = event_path.join("_canvas.json");
    if canvas_json.is_file() {
        match fs::read_to_string(&canvas_json) {
            Ok(content) => match canvas::read_canvas(&content, &event.id) {
                Ok(mut items) => model.canvas_items.append(&mut items),
                Err(reason) => model.errors.push(IndexError {
                    path: rel_path(root, &canvas_json),
                    severity: Severity::Error,
                    reason,
                }),
            },
            Err(e) => model.errors.push(IndexError {
                path: rel_path(root, &canvas_json),
                severity: Severity::Error,
                reason: format!("kan _canvas.json niet lezen: {e}"),
            }),
        }
    }

    // Items + losse media verzamelen.
    let entries = match sorted_dir(event_path) {
        Ok(e) => e,
        Err(e) => {
            model.errors.push(IndexError {
                path: folder_path,
                severity: Severity::Error,
                reason: format!("kan eventmap niet lezen: {e}"),
            });
            model.events.push(event);
            return;
        }
    };

    let event_start_ms = to_millis(&start_at);
    let mut parsed_items: Vec<ParsedItem> = Vec::new();
    let mut media_files: Vec<String> = Vec::new();

    for entry in entries {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if !path.is_file() || is_special(&name) {
            continue;
        }
        if name.ends_with(".md") {
            if let Some(pi) = read_item(root, &path, &name, &event, event_start_ms, model) {
                parsed_items.push(pi);
            }
        } else if is_media_file(&name) {
            media_files.push(name);
        }
    }

    // Dedupe: meerdere item-.md's die naar hetzelfde mediabestand wijzen.
    // Remapt onderweg canvas-verwijzingen van gedropte duplicaten naar de winnaar.
    let kept = dedupe_items(parsed_items, &event.id, &folder_path, model);

    // Welke media zijn geclaimd door een overlevend item?
    let claimed: std::collections::HashSet<String> = kept
        .iter()
        .filter_map(|it| it.media.clone())
        .map(|m| m.to_ascii_lowercase())
        .collect();

    for it in &kept {
        // Media-referentie die niet op schijf staat → waarschuwen.
        if let Some(media) = &it.media {
            if !media_files
                .iter()
                .any(|m| m.eq_ignore_ascii_case(media))
            {
                model.errors.push(IndexError {
                    path: format!("{folder_path}/{}", it.slug.clone().unwrap_or_default()),
                    severity: Severity::Warning,
                    reason: format!("verwijst naar ontbrekend mediabestand '{media}'"),
                });
            }
        }
    }
    model.items.extend(kept);

    // Losse media zonder eigen .md → synthetisch item met stabiel id.
    for media in &media_files {
        if claimed.contains(&media.to_ascii_lowercase()) {
            continue;
        }
        let media_rel = format!("{folder_path}/{media}");
        let item_type = media
            .rsplit('.')
            .next()
            .and_then(ItemType::from_extension)
            .unwrap_or(ItemType::Photo);
        model.items.push(Item {
            id: stable_id("item", &media_rel),
            event_id: event.id.clone(),
            item_type,
            media: Some(media.clone()),
            url: None,
            caption: None,
            happened_at: None,
            timestamp_ms: event_start_ms,
            place: None,
            people: Vec::new(),
            tags: Vec::new(),
            category: None,
            body_text: None,
            slug: None,
            synthetic: true,
        });
    }

    model.events.push(event);
}

/// Een geparst item met dedupe-metadata (createdAt + rijkdom-score).
struct ParsedItem {
    item: Item,
    media: Option<String>,
    created_at: Option<String>,
    richness: u32,
}

impl std::ops::Deref for ParsedItem {
    type Target = Item;
    fn deref(&self) -> &Item {
        &self.item
    }
}

fn read_item(
    root: &Path,
    path: &Path,
    file_name: &str,
    event: &Event,
    event_start_ms: Option<i64>,
    model: &mut VaultModel,
) -> Option<ParsedItem> {
    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) => {
            model.errors.push(IndexError {
                path: rel_path(root, path),
                severity: Severity::Error,
                reason: format!("kan item niet lezen: {e}"),
            });
            return None;
        }
    };
    let parsed = frontmatter::parse(&content);
    let slug = file_name.trim_end_matches(".md").to_string();
    let rel = rel_path(root, path);

    if parsed.unterminated {
        model.errors.push(IndexError {
            path: rel.clone(),
            severity: Severity::Warning,
            reason: "frontmatter niet afgesloten met '---'; velden mogelijk niet gelezen".into(),
        });
    }

    let media = parsed.get_str("media");
    let item_type = parsed
        .get_str("type")
        .and_then(|t| ItemType::parse(&t))
        .or_else(|| {
            media
                .as_deref()
                .and_then(|m| m.rsplit('.').next())
                .and_then(ItemType::from_extension)
        })
        .unwrap_or(ItemType::Text);

    let happened_at = parsed.get_str("happenedAt");
    let timestamp_ms = happened_at
        .as_deref()
        .and_then(to_millis)
        .or(event_start_ms);

    let body_text = if parsed.body.is_empty() {
        None
    } else {
        Some(parsed.body.clone())
    };

    let people = parsed.get("people").map(|y| y.as_string_list()).unwrap_or_default();
    let tags = parsed.get("tags").map(|y| y.as_string_list()).unwrap_or_default();
    let caption = parsed.get_str("caption");
    let place = read_location(&parsed, "place");
    let category = parsed.get_str("category");
    let url = parsed.get_str("url");

    let richness = [
        caption.is_some(),
        happened_at.is_some(),
        place.is_some(),
        !people.is_empty(),
        !tags.is_empty(),
        category.is_some(),
        body_text.is_some(),
        url.is_some(),
    ]
    .iter()
    .filter(|b| **b)
    .count() as u32;

    let id = parsed
        .get_str("id")
        .unwrap_or_else(|| stable_id("item", &rel));

    Some(ParsedItem {
        item: Item {
            id,
            event_id: event.id.clone(),
            item_type,
            media: media.clone(),
            url,
            caption,
            happened_at,
            timestamp_ms,
            place,
            people,
            tags,
            category,
            body_text,
            slug: Some(slug),
            synthetic: false,
        },
        media,
        created_at: parsed.get_str("createdAt"),
        richness,
    })
}

/// Dedupliceert item-.md's die naar hetzelfde mediabestand wijzen. Winnaar:
/// hoogste rijkdom → oudste `createdAt` → kortste slug (de "schone" naam) →
/// laagste id (volledig deterministisch). Items zonder media (tekst/link)
/// worden nooit gededupliceerd. Canvas-verwijzingen naar een gedropt duplicaat
/// worden omgehangen naar de winnaar, zodat de layout niet stil breekt.
fn dedupe_items(
    items: Vec<ParsedItem>,
    event_id: &str,
    folder_path: &str,
    model: &mut VaultModel,
) -> Vec<Item> {
    use std::collections::HashMap;
    let mut by_media: HashMap<String, Vec<ParsedItem>> = HashMap::new();
    let mut result: Vec<Item> = Vec::new();

    for pi in items {
        match &pi.media {
            Some(m) => by_media.entry(m.to_ascii_lowercase()).or_default().push(pi),
            None => result.push(pi.item),
        }
    }

    // Deterministische groepsvolgorde (HashMap-iteratie is willekeurig).
    let mut groups: Vec<(String, Vec<ParsedItem>)> = by_media.into_iter().collect();
    groups.sort_by(|a, b| a.0.cmp(&b.0));

    for (_media, mut group) in groups {
        if group.len() == 1 {
            result.push(group.pop().unwrap().item);
            continue;
        }
        group.sort_by(|a, b| {
            b.richness
                .cmp(&a.richness)
                .then_with(|| cmp_created(&a.created_at, &b.created_at))
                .then_with(|| {
                    a.slug
                        .as_deref()
                        .unwrap_or("")
                        .len()
                        .cmp(&b.slug.as_deref().unwrap_or("").len())
                })
                .then_with(|| a.item.id.cmp(&b.item.id))
        });
        let winner = group.remove(0);
        // Waar het overlevende item in het canvas naar verwezen wordt.
        let winner_ref = winner
            .item
            .slug
            .clone()
            .unwrap_or_else(|| winner.item.id.clone());

        for dropped in &group {
            model.errors.push(IndexError {
                path: format!("{folder_path}/{}.md", dropped.slug.clone().unwrap_or_default()),
                severity: Severity::Warning,
                reason: format!(
                    "duplicaat van '{}' (zelfde media); geskipt, canvas omgehangen",
                    winner.slug.clone().unwrap_or_default()
                ),
            });
            remap_canvas(model, event_id, dropped, &winner_ref);
        }
        result.push(winner.item);
    }

    result
}

/// Hangt canvas-items van dit event die naar het gedropte duplicaat wijzen
/// (via slug óf id, case-insensitief) om naar de winnaar.
fn remap_canvas(model: &mut VaultModel, event_id: &str, dropped: &ParsedItem, winner_ref: &str) {
    let dropped_slug = dropped.item.slug.clone();
    let dropped_id = dropped.item.id.clone();
    for ci in model
        .canvas_items
        .iter_mut()
        .filter(|c| c.event_id == event_id)
    {
        let matches_slug = dropped_slug
            .as_deref()
            .is_some_and(|s| ci.item_ref.eq_ignore_ascii_case(s));
        let matches_id = ci.item_ref.eq_ignore_ascii_case(&dropped_id);
        if matches_slug || matches_id {
            ci.item_ref = winner_ref.to_string();
        }
    }
}

fn cmp_created(a: &Option<String>, b: &Option<String>) -> std::cmp::Ordering {
    match (a, b) {
        (Some(x), Some(y)) => x.cmp(y), // ISO-strings sorteren chronologisch
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    }
}

// ---- helpers -------------------------------------------------------------

struct InferredEvent {
    title: Option<String>,
    start_at: Option<String>,
}

/// Leidt titel + startdatum af uit "YYYY-MM Titel" of "YYYY-MM-DD Titel".
fn infer_event_from_folder(folder_name: &str) -> InferredEvent {
    let bytes = folder_name.as_bytes();
    // Minimaal "YYYY-MM " = 8 tekens.
    if bytes.len() >= 8 && folder_name.as_bytes()[4] == b'-' {
        let year = &folder_name[0..4];
        if year.chars().all(|c| c.is_ascii_digit()) {
            let month = &folder_name[5..7];
            if month.chars().all(|c| c.is_ascii_digit()) {
                // Optionele dag.
                let (start, rest_idx) = if bytes.len() >= 10 && bytes[7] == b'-' {
                    let day = &folder_name[8..10];
                    if day.chars().all(|c| c.is_ascii_digit()) {
                        (format!("{year}-{month}-{day}"), 10)
                    } else {
                        (format!("{year}-{month}-01"), 7)
                    }
                } else {
                    (format!("{year}-{month}-01"), 7)
                };
                let title = folder_name[rest_idx..].trim().to_string();
                return InferredEvent {
                    title: if title.is_empty() { None } else { Some(title) },
                    start_at: Some(start),
                };
            }
        }
    }
    InferredEvent {
        title: Some(folder_name.to_string()),
        start_at: None,
    }
}

fn read_location(parsed: &Parsed, key: &str) -> Option<Location> {
    let map = parsed.get(key)?.as_map()?;
    let lat = map.get("lat").and_then(Yaml::as_f64)?;
    let lng = map.get("lng").and_then(Yaml::as_f64)?;
    let label = map.get("label").and_then(Yaml::as_str);
    Some(Location { lat, lng, label })
}

fn read_parsed(path: &Path) -> Option<Parsed> {
    if !path.is_file() {
        return None;
    }
    fs::read_to_string(path).ok().map(|c| frontmatter::parse(&c))
}

/// Logt een waarschuwing als een `_year.md`/`_event.md` een onafgesloten
/// frontmatter heeft (nooit stil).
fn log_unterminated(parsed: &Option<Parsed>, path: &Path, root: &Path, model: &mut VaultModel) {
    if let Some(p) = parsed {
        if p.unterminated {
            model.errors.push(IndexError {
                path: rel_path(root, path),
                severity: Severity::Warning,
                reason: "frontmatter niet afgesloten met '---'; velden mogelijk niet gelezen".into(),
            });
        }
    }
}

/// Gesorteerde directory-inhoud (deterministische scanvolgorde).
fn sorted_dir(path: &Path) -> std::io::Result<Vec<fs::DirEntry>> {
    let mut entries: Vec<fs::DirEntry> = fs::read_dir(path)?.collect::<Result<_, _>>()?;
    entries.sort_by_key(|e| e.file_name());
    Ok(entries)
}

fn rel_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn is_year_folder(name: &str) -> bool {
    name.len() == 4 && name.chars().all(|c| c.is_ascii_digit())
}

fn is_ignored_dir(name: &str) -> bool {
    name.starts_with('.') || name.eq_ignore_ascii_case(".memorylane")
}

/// `_`-prefix bestanden zijn specials (`_event.md`, `_year.md`, `_canvas.json`,
/// `_featured.*`) en worden nooit als item geïndexeerd.
fn is_special(name: &str) -> bool {
    name.starts_with('_')
}

fn is_media_file(name: &str) -> bool {
    let ext = match name.rsplit_once('.') {
        Some((_, e)) => e.to_ascii_lowercase(),
        None => return false,
    };
    matches!(
        ext.as_str(),
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "heic" | "heif" | "avif" | "mp4" | "mov"
            | "avi" | "mkv" | "webm" | "mp3" | "wav" | "ogg" | "m4a" | "aac" | "flac"
    )
}

/// Stabiel id uit een prefix + pad (FNV-1a 64-bit hex). Deterministisch over
/// scans heen zodat synthetische items en fallback-ids niet muteren.
fn stable_id(prefix: &str, path: &str) -> String {
    const OFFSET: u64 = 0xcbf29ce484222325;
    const PRIME: u64 = 0x100000001b3;
    let mut hash = OFFSET;
    for b in path.as_bytes() {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(PRIME);
    }
    format!("{prefix}-{hash:016x}")
}

/// Parseert "YYYY-MM-DD" of volledige ISO naar ms sinds epoch (UTC).
fn to_millis(date: &str) -> Option<i64> {
    use chrono::{DateTime, NaiveDate};
    let date = date.trim();
    if date.contains('T') {
        if let Ok(dt) = DateTime::parse_from_rfc3339(date) {
            return Some(dt.timestamp_millis());
        }
    }
    if let Ok(d) = NaiveDate::parse_from_str(date, "%Y-%m-%d") {
        return d
            .and_hms_opt(0, 0, 0)
            .map(|dt| dt.and_utc().timestamp_millis());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_id_is_deterministic() {
        assert_eq!(stable_id("item", "2024/x/a.jpg"), stable_id("item", "2024/x/a.jpg"));
        assert_ne!(stable_id("item", "a"), stable_id("item", "b"));
    }

    #[test]
    fn infers_event_with_day() {
        let e = infer_event_from_folder("1969-07-01 Jim geboren");
        assert_eq!(e.title.unwrap(), "Jim geboren");
        assert_eq!(e.start_at.unwrap(), "1969-07-01");
    }

    #[test]
    fn infers_event_month_only() {
        let e = infer_event_from_folder("2024-11 palermo");
        assert_eq!(e.title.unwrap(), "palermo");
        assert_eq!(e.start_at.unwrap(), "2024-11-01");
    }

    #[test]
    fn non_date_folder_uses_full_name_as_title() {
        let e = infer_event_from_folder("f,sandf nasd,mf ns");
        assert_eq!(e.title.unwrap(), "f,sandf nasd,mf ns");
        assert!(e.start_at.is_none());
    }

    #[test]
    fn to_millis_handles_date_and_iso() {
        assert!(to_millis("1969-07-01").is_some());
        assert!(to_millis("2025-12-23T21:27:59.407Z").is_some());
        assert!(to_millis("geen datum").is_none());
    }

    #[test]
    fn loose_year_media_becomes_a_synthetic_memory() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        // Jaar 2012 met twee losse foto's + één echte event-submap met een foto.
        std::fs::create_dir_all(root.join("2012/Vakantie")).unwrap();
        std::fs::write(root.join("2012/strand.jpg"), b"x").unwrap();
        std::fs::write(root.join("2012/zee.png"), b"x").unwrap();
        std::fs::write(root.join("2012/Vakantie/foto.jpg"), b"x").unwrap();

        let model = scan(root);

        assert_eq!(model.years.len(), 1);
        assert_eq!(model.events.len(), 2, "echte event + synthetische losse-foto's");
        let loose = model
            .events
            .iter()
            .find(|e| e.title.as_deref() == Some("Losse foto's"))
            .expect("synthetische losse-foto's memory");
        assert_eq!(loose.folder_path, model.years[0].folder_name); // = de jaarmap zelf
        assert_eq!(loose.year_id, model.years[0].id);
        let loose_items: Vec<_> = model.items.iter().filter(|i| i.event_id == loose.id).collect();
        assert_eq!(loose_items.len(), 2, "beide losse foto's als items");
        assert!(loose_items.iter().all(|i| i.synthetic));
        // De echte event bestaat óók (met zijn eigen submap-foto).
        assert!(model.events.iter().any(|e| e.folder_path.ends_with("Vakantie")));
    }

    #[test]
    fn year_with_only_loose_media_still_shows_a_memory() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        // Enkel losse foto's, geen submappen — het klassieke "archief"-geval.
        std::fs::create_dir_all(root.join("2018")).unwrap();
        std::fs::write(root.join("2018/a.jpg"), b"x").unwrap();
        std::fs::write(root.join("2018/b.jpg"), b"x").unwrap();

        let model = scan(root);
        assert_eq!(model.years.len(), 1);
        assert_eq!(model.events.len(), 1, "één synthetische losse-foto's memory");
        let ev = &model.events[0];
        assert_eq!(ev.title.as_deref(), Some("Losse foto's"));
        // Media resolven t.o.v. de jaarmap: folder_path + media = 2018/a.jpg.
        let items: Vec<_> = model.items.iter().filter(|i| i.event_id == ev.id).collect();
        assert_eq!(items.len(), 2);
        assert_eq!(format!("{}/{}", ev.folder_path, items[0].media.as_deref().unwrap_or("")), "2018/a.jpg");
    }

    #[test]
    fn year_and_special_detection() {
        assert!(is_year_folder("1971"));
        assert!(!is_year_folder("197"));
        assert!(!is_year_folder("abcd"));
        assert!(is_special("_event.md"));
        assert!(is_special("_featured.jpg"));
        assert!(!is_special("foto.jpg"));
    }
}
