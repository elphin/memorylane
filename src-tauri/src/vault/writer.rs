//! Schrijfpad naar de vault. Tot nu toe was alles read-only; dit is de eerste
//! mutatie: de canvas-layout (`_canvas.json`) van een event persisteren als de
//! gebruiker items versleept. Schrijft in het v1-compatibele formaat.
//!
//! (Echo-suppressie voor de file-watcher komt in fase 9; er is nu nog geen
//! watcher, dus een directe schrijf is veilig.)

use std::path::Path;

use serde::Serialize;

use crate::model::{CanvasItem, ItemType, ThemeChoice};

// ---- Slug- en YAML-helpers (port van v1 generator.ts) --------------------

/// URL-veilige slug uit tekst (ascii, lowercase, streepjes).
pub fn generate_slug(text: &str, max_len: usize) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for ch in text.to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            prev_dash = false;
        } else if !prev_dash && !out.is_empty() {
            out.push('-');
            prev_dash = true;
        }
    }
    let trimmed = out.trim_matches('-');
    let sliced: String = trimmed.chars().take(max_len).collect();
    let sliced = sliced.trim_matches('-').to_string();
    if sliced.is_empty() {
        "untitled".to_string()
    } else {
        sliced
    }
}

/// Unieke slug = basis + korte id-suffix (voorkomt collisions — v1-bug).
pub fn generate_unique_slug(text: &str, id: &str) -> String {
    let base = generate_slug(text, 40);
    let short: String = id.chars().filter(|c| *c != '-').take(8).collect();
    format!("{base}_{short}")
}

/// Sanitiseert een mapnaam (Windows-onveilige tekens → `_`).
fn sanitize_folder(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c => c,
        })
        .collect();
    let trimmed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let sliced: String = trimmed.chars().take(100).collect();
    if sliced.trim().is_empty() {
        "unnamed".to_string()
    } else {
        sliced.trim().to_string()
    }
}

/// Quote een YAML-scalar als nodig (spiegelt v1 formatYamlValue).
fn yaml_str(v: &str) -> String {
    let needs = v.contains(':')
        || v.contains('#')
        || v.contains('\n')
        // Leidende indicator-tekens: zonder quotes leest de eigen parser deze
        // verkeerd terug (bijv. `[done]` → flow-seq → titel weg; `"hi"` →
        // ontdubbelquote → quotes weg). Quoten garandeert de round-trip.
        || v.starts_with('[')
        || v.starts_with('{')
        || v.starts_with('"')
        || v.starts_with('\'')
        || v.starts_with(' ')
        || v.ends_with(' ')
        || v == "true"
        || v == "false"
        || v == "null"
        || v.parse::<f64>().is_ok();
    if needs {
        format!("\"{}\"", v.replace('"', "\\\""))
    } else {
        v.to_string()
    }
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

// ---- Markdown-generatie --------------------------------------------------

/// Markdown voor een tekst-item (`<slug>.md`).
pub fn text_item_markdown(id: &str, caption: Option<&str>, body: &str, category: Option<&str>) -> String {
    let now = now_iso();
    let mut fm = format!("---\nid: {id}\ntype: text\n");
    if let Some(c) = caption {
        fm.push_str(&format!("caption: {}\n", yaml_str(c)));
    }
    if let Some(cat) = category {
        fm.push_str(&format!("category: {}\n", yaml_str(cat)));
    }
    fm.push_str(&format!("createdAt: {}\n", yaml_str(&now)));
    fm.push_str(&format!("updatedAt: {}\n", yaml_str(&now)));
    fm.push_str("---\n");
    let body = body.trim();
    if body.is_empty() {
        fm
    } else {
        format!("{fm}\n{body}\n")
    }
}

/// Markdown voor een media-item (`<slug>.md`) dat naar een mediabestand wijst.
/// `item_type` is "photo"/"video"/"audio" (afgeleid uit de extensie — de scanner
/// laat frontmatter-`type` winnen van de extensie, dus een `.mp4` MOET hier
/// `video` krijgen, niet `photo`). `happened_at` zet optioneel het `happenedAt`-
/// tijdstip voor volgorde-behoud (moet een RFC 3339-string met offset zijn, bv.
/// `…T12:00:05Z`).
pub fn media_item_markdown(
    id: &str,
    item_type: &str,
    media: &str,
    caption: Option<&str>,
    happened_at: Option<&str>,
) -> String {
    let now = now_iso();
    let mut fm = format!("---\nid: {id}\ntype: {item_type}\nmedia: {}\n", yaml_str(media));
    if let Some(c) = caption {
        fm.push_str(&format!("caption: {}\n", yaml_str(c)));
    }
    if let Some(h) = happened_at {
        fm.push_str(&format!("happenedAt: {}\n", yaml_str(h)));
    }
    fm.push_str(&format!("createdAt: {}\n", yaml_str(&now)));
    fm.push_str(&format!("updatedAt: {}\n", yaml_str(&now)));
    fm.push_str("---\n");
    fm
}

/// Itemtype-string voor een media-extensie; valt terug op "photo" voor onbekende
/// (de bestaande, tolerante default van de drag&drop-import).
fn media_type_for_ext(ext: &str) -> &'static str {
    ItemType::from_extension(ext).map(|t| t.as_str()).unwrap_or("photo")
}

/// Markdown voor een event (`_event.md`). `end_at` optioneel (period).
pub fn event_markdown(
    id: &str,
    title: &str,
    start_at: &str,
    end_at: Option<&str>,
    size: Option<i64>,
) -> String {
    let now = now_iso();
    let mut fm = format!(
        "---\nid: {id}\ntype: event\ntitle: {}\nstartAt: {}\n",
        yaml_str(title),
        yaml_str(start_at),
    );
    if let Some(e) = end_at {
        if !e.is_empty() {
            fm.push_str(&format!("endAt: {}\n", yaml_str(e)));
        }
    }
    if let Some(s) = size {
        fm.push_str(&format!("size: {}\n", s.clamp(1, 100)));
    }
    fm.push_str(&format!(
        "createdAt: {}\nupdatedAt: {}\n---\n",
        yaml_str(&now),
        yaml_str(&now),
    ));
    fm
}

/// Zet (of verwijdert bij `None`) een top-level frontmatter-veld in-place.
/// Vervangt de bestaande regel of voegt 'm toe; laat geneste velden met rust.
fn set_fm_field(fm: &mut Vec<String>, key: &str, value: Option<&str>) {
    let prefix = format!("{key}:");
    let idx = fm.iter().position(|l| l.starts_with(&prefix));
    match value {
        None => {
            if let Some(i) = idx {
                fm.remove(i);
            }
        }
        Some(v) => {
            let line = format!("{key}: {}", yaml_str(v));
            match idx {
                Some(i) => fm[i] = line,
                None => fm.push(line),
            }
        }
    }
}

/// Het jaar (`YYYY`) uit een startAt (`YYYY-MM-DD` of ISO). `None` als de eerste
/// vier tekens geen jaar zijn.
pub(crate) fn year_of(start_at: &str) -> Option<String> {
    let head: String = start_at.chars().take(4).collect();
    if head.len() == 4 && head.chars().all(|c| c.is_ascii_digit()) {
        Some(head)
    } else {
        None
    }
}

/// De jaarmap-component (eerste padsegment) van een event-folder-pad.
fn year_component(folder_path: &str) -> &str {
    folder_path.split('/').next().unwrap_or(folder_path)
}

/// Werkt titel/begin-/einddatum van een bestaand event-`_event.md` bij op
/// regel-niveau (overige velden blijven behouden). `end_at = None` verwijdert de
/// einddatum.
///
/// **Jaar-consistentie:** het jaar waarin een event getoond wordt, wordt door de
/// scanner afgeleid uit de JAARMAP waar de event-map fysiek in ligt — niet uit de
/// frontmatter-`startAt`. Wijzigt een datum-edit het jaar, dan zou het event stil
/// in het verkeerde jaar blijven hangen (en op de rand van de as geklemd worden).
/// Daarom verplaatsen we de event-map naar de jaarmap die bij de nieuwe `startAt`
/// hoort zodra het jaar verandert. Binnen hetzelfde jaar wordt de map bewust NIET
/// hernoemd (identiteit zit in de frontmatter; een stale naam is onschadelijk).
///
/// Geeft het (mogelijk nieuwe) folder-pad terug.
pub fn update_event(
    vault_root: &Path,
    folder_path: &str,
    title: &str,
    start_at: &str,
    end_at: Option<&str>,
) -> std::io::Result<String> {
    // Bepaal of de event-map naar een ander jaar moet verhuizen.
    let effective_folder = relocate_year_if_needed(vault_root, folder_path, start_at)?;
    let path = vault_root.join(&effective_folder).join("_event.md");
    // Robuust bij een ontbrekende `_event.md` (bijv. een foto-map die nooit een
    // eigen event-bestand kreeg): NIET crashen. Bestaat 'ie niet én is het een losse
    // jaarmap (geen subfolder) → niet persisteerbaar, netjes overslaan. Anders
    // materialiseren we minimale event-frontmatter. Zelfde aanpak als edit_event_md.
    let original = std::fs::read_to_string(&path).ok();
    if original.is_none() && !effective_folder.contains('/') {
        return Ok(effective_folder);
    }
    let fenced = original.as_ref().and_then(|c| {
        let n = c.replace("\r\n", "\n");
        let lines: Vec<String> = n.split('\n').map(|s| s.to_string()).collect();
        let open = lines.iter().position(|l| l.trim() == "---")?;
        let close = lines
            .iter()
            .enumerate()
            .skip(open + 1)
            .find(|(_, l)| l.trim() == "---")
            .map(|(i, _)| i)?;
        Some((lines, open, close))
    });
    let (mut fm, body): (Vec<String>, String) = if let Some((lines, open, close)) = fenced {
        (
            lines[open + 1..close].iter().map(|s| s.to_string()).collect(),
            lines[close + 1..].join("\n").trim().to_string(),
        )
    } else {
        // Ontbreekt of geen fences: minimale event-frontmatter met de bestaande tekst
        // als body.
        (
            vec!["type: event".to_string()],
            original.as_deref().unwrap_or("").trim().to_string(),
        )
    };
    // Leg een expliciete `id` vast als die ontbreekt: de STABIELE id die de scanner
    // anders uit het ORIGINELE pad zou afleiden. Zo verschuift de id niet als deze
    // edit de map naar een ander jaar verhuist (anders faalt de vervolg-setEventSize
    // met de oude id). Voor een event dat al een id heeft, blijft die staan.
    if !fm.iter().any(|l| l.trim_start().starts_with("id:")) {
        set_fm_field(&mut fm, "id", Some(&crate::vault::scanner::stable_id("event", folder_path)));
    }
    set_fm_field(&mut fm, "title", Some(title));
    set_fm_field(&mut fm, "startAt", Some(start_at));
    // Lege einddatum telt als "geen einddatum" → verwijderen.
    let end = end_at.filter(|e| !e.is_empty());
    set_fm_field(&mut fm, "endAt", end);
    set_fm_field(&mut fm, "updatedAt", Some(&now_iso()));

    let mut out = String::from("---\n");
    out.push_str(&fm.join("\n"));
    out.push_str("\n---\n");
    if !body.is_empty() {
        out.push('\n');
        out.push_str(&body);
        out.push('\n');
    }
    write_atomic(&path, &out)?;
    Ok(effective_folder)
}

/// Verplaatst de event-map naar de jaarmap die bij `start_at` hoort als het jaar
/// afwijkt van het huidige (eerste padsegment). Geeft het effectieve folder-pad
/// terug (ongewijzigd als er geen verhuizing nodig of mogelijk is).
///
/// Verplaatst nooit als: het jaar niet uit `start_at` te lezen is, het jaar al
/// klopt, of het doel al bestaat (dan blijft het event staan — de scanner
/// klemt 'm op de rand; beter dan twee events samenvoegen of een bestaande map
/// overschrijven).
fn relocate_year_if_needed(
    vault_root: &Path,
    folder_path: &str,
    start_at: &str,
) -> std::io::Result<String> {
    let Some(new_year) = year_of(start_at) else {
        return Ok(folder_path.to_string());
    };
    let current_year = year_component(folder_path);
    if current_year == new_year {
        return Ok(folder_path.to_string());
    }
    // Behoud de mapnaam zelf; alleen het jaar-segment verandert.
    let base_name = folder_path
        .split_once('/')
        .map(|(_, rest)| rest)
        .unwrap_or(folder_path);
    let target = format!("{new_year}/{base_name}");
    let target_abs = vault_root.join(&target);
    // Doel bestaat al → niet verhuizen (voorkomt overschrijven/samenvoegen).
    if target_abs.exists() {
        return Ok(folder_path.to_string());
    }
    if let Some(parent) = target_abs.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::rename(vault_root.join(folder_path), &target_abs)?;
    Ok(target)
}

// ---- Schrijf-operaties ---------------------------------------------------

fn write_atomic(path: &Path, content: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension(format!("tmp.{}", std::process::id()));
    std::fs::write(&tmp, content)?;
    // Faalt de rename (bijv. doel net read-only), ruim de temp op i.p.v. rommel
    // achter te laten in de vault.
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

/// Maakt een minimale `_event.md` aan als die ONTBREEKT (idempotent; bestaat 'ie al
/// → niets doen). Bewust ZONDER `id` (de scanner leidt hetzelfde stable_id uit het
/// pad af) en zonder title/startAt (die leidt de scanner uit de mapnaam af) — exact
/// consistent met de materialisatie in `edit_event_md`. Geeft true als aangemaakt.
pub fn ensure_event_md(vault_root: &Path, folder_path: &str) -> std::io::Result<bool> {
    let path = vault_root.join(folder_path).join("_event.md");
    if path.exists() {
        return Ok(false);
    }
    let content = format!("---\ntype: event\nupdatedAt: {}\n---\n", yaml_str(&now_iso()));
    write_atomic(&path, &content)?;
    Ok(true)
}

/// Maakt een minimale `_year.md` aan als die ONTBREEKT (idempotent). ZONDER `id`
/// (jaar-id blijft folder-derived en stabiel) — zelfde format als de materialisatie
/// in `set_year_cover`. Geeft true als aangemaakt.
pub fn ensure_year_md(vault_root: &Path, folder_name: &str) -> std::io::Result<bool> {
    let path = vault_root.join(folder_name).join("_year.md");
    if path.exists() {
        return Ok(false);
    }
    let content = format!(
        "---\ntype: year\ntitle: {}\nstartAt: {}-01-01\n---\n",
        yaml_str(folder_name),
        folder_name,
    );
    write_atomic(&path, &content)?;
    Ok(true)
}

/// Maakt een tekst-item in een eventmap. Geeft (id, slug) terug.
pub fn create_text_item(
    vault_root: &Path,
    folder_path: &str,
    caption: Option<&str>,
    body: &str,
) -> std::io::Result<(String, String)> {
    let id = uuid::Uuid::new_v4().to_string();
    let slug = generate_unique_slug(caption.unwrap_or("notitie"), &id);
    let md = text_item_markdown(&id, caption, body, None);
    let path = vault_root.join(folder_path).join(format!("{slug}.md"));
    write_atomic(&path, &md)?;
    Ok((id, slug))
}

/// Werkt een bestaand item-`.md` bij: vervangt/voegt `caption` in de
/// frontmatter (`Some("")` verwijdert het veld, `Some(x)` zet het, `None` laat
/// het ongemoeid) en/of vervangt de body (`None` = body ongemoeid). Bewerkt op
/// regel-niveau: alle overige frontmatter-velden (id, type, media, category,
/// exif, plaats, …) blijven exact behouden — non-destructief, future-proof.
pub fn update_item(
    vault_root: &Path,
    folder_path: &str,
    slug: &str,
    caption: Option<&str>,
    body: Option<&str>,
) -> std::io::Result<()> {
    let path = vault_root.join(folder_path).join(format!("{slug}.md"));
    let original = std::fs::read_to_string(&path)?;
    let updated = apply_item_edits(&original, caption, body);
    write_atomic(&path, &updated)
}

/// Past caption/body-bewerkingen toe op de ruwe markdown zonder de rest te
/// herschrijven. Zonder geldige frontmatter-fences wordt de inhoud ongemoeid
/// teruggegeven (onze eigen items hebben altijd fences).
fn apply_item_edits(content: &str, caption: Option<&str>, body: Option<&str>) -> String {
    let normalized = content.replace("\r\n", "\n");
    let lines: Vec<&str> = normalized.split('\n').collect();
    let open = lines.iter().position(|l| l.trim() == "---");
    let close = open.and_then(|o| {
        lines
            .iter()
            .enumerate()
            .skip(o + 1)
            .find(|(_, l)| l.trim() == "---")
            .map(|(i, _)| i)
    });
    let (Some(open), Some(close)) = (open, close) else {
        return normalized;
    };

    let mut fm: Vec<String> = lines[open + 1..close].iter().map(|s| s.to_string()).collect();

    // Alleen top-level velden (indent 0) matchen: een geneste `caption:`,
    // `type:` of `updatedAt:` binnen een sub-map/-seq (bijv. `place:`) mag NIET
    // geraakt worden — dat zou de geneste structuur breken (regel un-indenten →
    // map eindigt vroeg) en is precies het dataverlies dat non-destructief
    // schrijven moet voorkomen. Onze eigen top-level velden staan altijd op
    // kolom 0; `starts_with` (zonder trim) matcht daarom exact die.
    if let Some(cap) = caption {
        let idx = fm.iter().position(|l| l.starts_with("caption:"));
        if cap.is_empty() {
            if let Some(i) = idx {
                fm.remove(i);
            }
        } else {
            let line = format!("caption: {}", yaml_str(cap));
            match idx {
                Some(i) => fm[i] = line,
                None => {
                    // Netjes na de `type:`-regel invoegen (of vooraan als die mist).
                    let at = fm
                        .iter()
                        .position(|l| l.starts_with("type:"))
                        .map(|i| i + 1)
                        .unwrap_or(0);
                    fm.insert(at, line);
                }
            }
        }
    }

    // `updatedAt` bijwerken (vervang bestaande regel, of voeg toe).
    let ua = format!("updatedAt: {}", yaml_str(&now_iso()));
    match fm.iter().position(|l| l.starts_with("updatedAt:")) {
        Some(i) => fm[i] = ua,
        None => fm.push(ua),
    }

    let new_body = match body {
        Some(b) => b.trim().to_string(),
        None => lines[close + 1..].join("\n").trim().to_string(),
    };

    let mut out = String::from("---\n");
    out.push_str(&fm.join("\n"));
    out.push_str("\n---\n");
    if !new_body.is_empty() {
        out.push('\n');
        out.push_str(&new_body);
        out.push('\n');
    }
    out
}

/// Zet of verwijdert een top-level frontmatter-veld INCLUSIEF een eventueel
/// bijbehorend geïndenteerd blok (geneste map/seq). Zo wordt bij het overschrijven
/// van bijv. een `place:`-map met een scalar het hele oude blok verwijderd i.p.v.
/// alleen de sleutelregel (anders blijven geïndenteerde regels verweesd achter).
/// True als de eerstvolgende niet-lege regel geïndenteerd is (spatie/tab). Zo
/// horen lege regels binnen een geneste blok bij dat blok i.p.v. de drain te
/// laten stoppen.
fn next_nonblank_is_indented(rest: &[String]) -> bool {
    rest.iter()
        .find(|l| !l.trim().is_empty())
        .map(|l| l.starts_with([' ', '\t']))
        .unwrap_or(false)
}

fn set_fm_block(fm: &mut Vec<String>, key: &str, line_value: Option<String>) {
    let prefix = format!("{key}:");
    if let Some(i) = fm.iter().position(|l| l.starts_with(&prefix)) {
        // Drain de sleutelregel plus het bijbehorende geïndenteerde blok. Een
        // top-level veld begint op kolom 0, dus indented regels horen bij dít
        // blok. Lege regels binnen de frontmatter (die onze eigen writer niet
        // produceert, maar handmatig/v1-bewerkte bestanden wél) horen óók bij
        // het blok zolang er daarna nog een indented regel volgt — anders zou de
        // drain te vroeg stoppen en verweesde geneste regels achterlaten die de
        // reconstructie zouden breken. We nemen een lege regel dus alleen mee als
        // er verderop nog indented inhoud van hetzelfde blok komt.
        let mut end = i + 1;
        while end < fm.len() {
            if fm[end].starts_with([' ', '\t']) {
                end += 1;
            } else if fm[end].trim().is_empty()
                && next_nonblank_is_indented(&fm[end + 1..])
            {
                // Lege regel gevolgd door nog meer indented inhoud → onderdeel
                // van dít blok (anders bleven geneste regels verweesd achter).
                end += 1;
            } else {
                break;
            }
        }
        fm.drain(i..end);
        if let Some(v) = line_value {
            fm.insert(i, format!("{key}: {v}"));
        }
    } else if let Some(v) = line_value {
        fm.push(format!("{key}: {v}"));
    }
}

/// Inline flow-map voor een ThemeChoice (`{id: warm-linen, accent: "#c47b4f"}`):
/// alleen de gevulde subvelden, in vaste volgorde id/accent/background/titleFont,
/// waardes via `yaml_str` (quotet o.a. `#`, dus hex-kleuren round-trippen).
/// `None` als alle subvelden leeg zijn (= "geërfd" → veld verwijderen).
fn theme_flow_map(theme: &ThemeChoice) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    let mut push = |key: &str, value: &Option<String>| {
        if let Some(v) = value.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            parts.push(format!("{key}: {}", yaml_str(v)));
        }
    };
    push("id", &theme.id);
    push("accent", &theme.accent);
    push("background", &theme.background);
    push("titleFont", &theme.title_font);
    if parts.is_empty() {
        None
    } else {
        Some(format!("{{{}}}", parts.join(", ")))
    }
}

/// Inline flow-seq (`["a", "b"]`) met altijd-gequote items (round-trip-veilig via
/// de eigen parser); `None` als de lijst na trimmen leeg is.
fn flow_seq(items: &[String]) -> Option<String> {
    let cleaned: Vec<String> = items
        .iter()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| format!("\"{}\"", s.replace('"', "\\\"")))
        .collect();
    if cleaned.is_empty() {
        None
    } else {
        Some(format!("[{}]", cleaned.join(", ")))
    }
}

/// Werkt de bewerkbare metadata van een item bij: caption, datum, plaats, mensen
/// en trefwoorden — geschreven in de sidecar-frontmatter (non-destructief:
/// overige velden + body blijven behouden). Lege waarden verwijderen het veld.
#[allow(clippy::too_many_arguments)]
pub fn update_item_meta(
    vault_root: &Path,
    folder_path: &str,
    slug: &str,
    caption: &str,
    date: &str,
    place: &str,
    people: &[String],
    tags: &[String],
) -> std::io::Result<()> {
    let path = vault_root.join(folder_path).join(format!("{slug}.md"));
    let original = std::fs::read_to_string(&path)?;
    let normalized = original.replace("\r\n", "\n");
    let lines: Vec<&str> = normalized.split('\n').collect();
    let open = lines.iter().position(|l| l.trim() == "---");
    let close = open.and_then(|o| {
        lines
            .iter()
            .enumerate()
            .skip(o + 1)
            .find(|(_, l)| l.trim() == "---")
            .map(|(i, _)| i)
    });
    let (Some(open), Some(close)) = (open, close) else {
        return write_atomic(&path, &normalized);
    };
    let mut fm: Vec<String> = lines[open + 1..close].iter().map(|s| s.to_string()).collect();
    let scalar = |v: &str| {
        let t = v.trim();
        if t.is_empty() {
            None
        } else {
            Some(yaml_str(t))
        }
    };
    set_fm_block(&mut fm, "caption", scalar(caption));
    set_fm_block(&mut fm, "date", scalar(date));
    set_fm_block(&mut fm, "place", scalar(place));
    set_fm_block(&mut fm, "people", flow_seq(people));
    set_fm_block(&mut fm, "tags", flow_seq(tags));
    set_fm_block(&mut fm, "updatedAt", Some(yaml_str(&now_iso())));

    let body = lines[close + 1..].join("\n").trim().to_string();
    let mut out = String::from("---\n");
    out.push_str(&fm.join("\n"));
    out.push_str("\n---\n");
    if !body.is_empty() {
        out.push('\n');
        out.push_str(&body);
        out.push('\n');
    }
    write_atomic(&path, &out)
}

/// Zet (of wist bij `None`/leeg) de frame-stijl van een item in de sidecar-
/// frontmatter (`frame: polaroid`). Opake string: de geldige waarden kent alleen
/// de frontend. Non-destructief op regel-niveau via `set_fm_field`: overige
/// frontmatter-velden + body blijven exact behouden (zelfde aanpak als
/// [`update_item`]). Zonder frontmatter-fences blijft de inhoud ongemoeid
/// (onze eigen items hebben altijd fences).
pub fn set_item_frame(
    vault_root: &Path,
    folder_path: &str,
    slug: &str,
    frame: Option<&str>,
) -> std::io::Result<()> {
    let path = vault_root.join(folder_path).join(format!("{slug}.md"));
    let original = std::fs::read_to_string(&path)?;
    let normalized = original.replace("\r\n", "\n");
    let lines: Vec<&str> = normalized.split('\n').collect();
    let open = lines.iter().position(|l| l.trim() == "---");
    let close = open.and_then(|o| {
        lines
            .iter()
            .enumerate()
            .skip(o + 1)
            .find(|(_, l)| l.trim() == "---")
            .map(|(i, _)| i)
    });
    let (Some(open), Some(close)) = (open, close) else {
        return write_atomic(&path, &normalized);
    };
    let mut fm: Vec<String> = lines[open + 1..close].iter().map(|s| s.to_string()).collect();
    // Leeg/whitespace telt als wissen ("geërfd" laat geen spoor achter).
    set_fm_field(&mut fm, "frame", frame.map(str::trim).filter(|s| !s.is_empty()));
    set_fm_field(&mut fm, "updatedAt", Some(&now_iso()));

    let body = lines[close + 1..].join("\n").trim().to_string();
    let mut out = String::from("---\n");
    out.push_str(&fm.join("\n"));
    out.push_str("\n---\n");
    if !body.is_empty() {
        out.push('\n');
        out.push_str(&body);
        out.push('\n');
    }
    write_atomic(&path, &out)
}

/// Zet (of verwijdert bij `None`/leeg) de uitgelichte foto (`featuredPhoto`) van
/// een event op regel-niveau; overige frontmatter-velden + body blijven behouden.
/// Werkt de frontmatter van `<folder>/_event.md` bij via `apply` (+ `updatedAt`).
/// Non-destructief: raakt alleen de betreffende regel(s), body blijft intact.
///
/// Ontbreekt het `_event.md` (bijv. een geïmporteerde/gescande memory zonder
/// sidecar), dan MATERIALISEREN we er één met minimale frontmatter — bewust ZONDER
/// `id` (de scanner leidt hetzelfde `stable_id` uit de mapnaam af, dus de memory
/// raakt niet los) en zonder titel/datum (die leidt de scanner ook uit de map af).
/// Voor losse foto's direct in een JAARmap (folder_path zonder submap) is er geen
/// eigen `_event.md`-plek — dat zou de jaarmap tot event maken — dus dan doen we
/// niets (i.p.v. de vorige ENOENT-crash).
fn edit_event_md(
    vault_root: &Path,
    folder_path: &str,
    apply: impl FnOnce(&mut Vec<String>),
) -> std::io::Result<()> {
    let path = vault_root.join(folder_path).join("_event.md");
    let original = std::fs::read_to_string(&path).ok();
    if original.is_none() && !folder_path.contains('/') {
        return Ok(()); // losse-media bundel in een jaarmap → niet persisteerbaar
    }
    let fenced = original.as_ref().and_then(|c| {
        let n = c.replace("\r\n", "\n");
        let lines: Vec<String> = n.split('\n').map(|s| s.to_string()).collect();
        let open = lines.iter().position(|l| l.trim() == "---")?;
        let close = lines
            .iter()
            .enumerate()
            .skip(open + 1)
            .find(|(_, l)| l.trim() == "---")
            .map(|(i, _)| i)?;
        Some((lines, open, close))
    });
    let (mut fm, body): (Vec<String>, String) = if let Some((lines, open, close)) = fenced {
        (
            lines[open + 1..close].iter().map(|s| s.to_string()).collect(),
            lines[close + 1..].join("\n").trim().to_string(),
        )
    } else {
        // Ontbreekt of geen fences: minimale event-frontmatter ZONDER id.
        (
            vec!["type: event".to_string()],
            original.as_deref().unwrap_or("").trim().to_string(),
        )
    };
    apply(&mut fm);
    set_fm_field(&mut fm, "updatedAt", Some(&now_iso()));

    let mut out = String::from("---\n");
    out.push_str(&fm.join("\n"));
    out.push_str("\n---\n");
    if !body.is_empty() {
        out.push('\n');
        out.push_str(&body);
        out.push('\n');
    }
    write_atomic(&path, &out)
}

/// Zet (of wist bij `None`) de uitgelichte foto in `<folder>/_event.md`.
pub fn set_event_featured(
    vault_root: &Path,
    folder_path: &str,
    featured: Option<&str>,
) -> std::io::Result<()> {
    edit_event_md(vault_root, folder_path, |fm| {
        set_fm_field(fm, "featuredPhoto", featured.filter(|f| !f.is_empty()));
    })
}

/// Zet (of wist bij `None`) het `size`-veld (belang, 1–100) in `<folder>/_event.md`.
pub fn set_event_size(
    vault_root: &Path,
    folder_path: &str,
    size: Option<i64>,
) -> std::io::Result<()> {
    edit_event_md(vault_root, folder_path, |fm| {
        let value = size.map(|s| s.clamp(1, 100).to_string());
        set_fm_field(fm, "size", value.as_deref());
    })
}

/// Zet (`true`) of wist (`false`) de `underConstruction`-vlag in `<folder>/_event.md`.
/// Uit = veld verwijderen (afwezig = false), zodat de vault schoon blijft.
pub fn set_event_under_construction(
    vault_root: &Path,
    folder_path: &str,
    on: bool,
) -> std::io::Result<()> {
    edit_event_md(vault_root, folder_path, |fm| {
        set_fm_field(fm, "underConstruction", if on { Some("true") } else { None });
    })
}

/// Zet (of wist) het `theme`-veld in `<folder>/_event.md` als één inline
/// flow-map-regel (`theme: {id: …, accent: "#…"}`). `None` — of een ThemeChoice
/// zonder gevulde subvelden — verwijdert het veld/blok volledig ("geërfd" laat
/// geen spoor achter). Via `set_fm_block`, dus een handgeschreven genest
/// `theme:`-blok wordt netjes gedraind en door de ene regel vervangen. Zelfde
/// materialisatie-/no-op-gedrag als [`set_event_size`] (via `edit_event_md`).
pub fn set_event_theme(
    vault_root: &Path,
    folder_path: &str,
    theme: Option<&ThemeChoice>,
) -> std::io::Result<()> {
    let value = theme.and_then(theme_flow_map);
    edit_event_md(vault_root, folder_path, |fm| {
        set_fm_block(fm, "theme", value);
    })
}

/// Zet (of wist bij `None`) de vaste jaar-cover in `<folder>/_year.md`. Bestaat er
/// geen `_year.md` (of één zonder frontmatter-fences), dan maken we er één met
/// minimale frontmatter — bewust ZONDER `id`, zodat de scanner deterministisch
/// hetzelfde jaar-id afleidt (stable_id op de mapnaam) en events niet losraken.
pub fn set_year_cover(
    vault_root: &Path,
    folder_name: &str,
    cover: Option<&str>,
) -> std::io::Result<()> {
    let path = vault_root.join(folder_name).join("_year.md");
    let original = std::fs::read_to_string(&path).ok();
    // Niets te wissen als er geen bestand is → geen loos `_year.md` aanmaken.
    if cover.is_none() && original.is_none() {
        return Ok(());
    }
    let fenced = original.as_ref().and_then(|c| {
        let n = c.replace("\r\n", "\n");
        let lines: Vec<String> = n.split('\n').map(|s| s.to_string()).collect();
        let open = lines.iter().position(|l| l.trim() == "---")?;
        let close = lines
            .iter()
            .enumerate()
            .skip(open + 1)
            .find(|(_, l)| l.trim() == "---")
            .map(|(i, _)| i)?;
        Some((lines, open, close))
    });
    let (mut fm, body): (Vec<String>, String) = if let Some((lines, open, close)) = fenced {
        (
            lines[open + 1..close].iter().map(|s| s.to_string()).collect(),
            lines[close + 1..].join("\n").trim().to_string(),
        )
    } else {
        // Geen fences (bestand ontbreekt of malformed): minimale frontmatter ZONDER id.
        (
            vec![
                "type: year".to_string(),
                format!("title: \"{folder_name}\""),
                format!("startAt: {folder_name}-01-01"),
            ],
            original.as_deref().unwrap_or("").trim().to_string(),
        )
    };
    set_fm_field(&mut fm, "cover", cover.filter(|c| !c.is_empty()));

    let mut out = String::from("---\n");
    out.push_str(&fm.join("\n"));
    out.push_str("\n---\n");
    if !body.is_empty() {
        out.push('\n');
        out.push_str(&body);
        out.push('\n');
    }
    write_atomic(&path, &out)
}

/// Zet (of wist bij `None`/≈1.0) de globale schaalfactor voor de event-kaarten
/// van een jaar in `<folder>/_year.md`. Zelfde `_year.md`-aanmaaklogica als
/// [`set_year_cover`] (bewust ZONDER `id` → jaar-id blijft stabiel). Een factor
/// vlak bij 1.0 wist het veld (dat is de standaard, geen clutter in de vault).
pub fn set_year_size_factor(
    vault_root: &Path,
    folder_name: &str,
    factor: Option<f64>,
) -> std::io::Result<()> {
    let path = vault_root.join(folder_name).join("_year.md");
    let original = std::fs::read_to_string(&path).ok();
    // Normaliseer: None of ≈1.0 betekent "geen factor" → veld weglaten/wissen.
    let value = factor
        .filter(|f| f.is_finite() && (*f - 1.0).abs() > 0.001)
        .map(|f| format!("{:.4}", f.clamp(0.1, 5.0)));
    if value.is_none() && original.is_none() {
        return Ok(()); // niets te wissen, geen loos bestand aanmaken
    }
    let fenced = original.as_ref().and_then(|c| {
        let n = c.replace("\r\n", "\n");
        let lines: Vec<String> = n.split('\n').map(|s| s.to_string()).collect();
        let open = lines.iter().position(|l| l.trim() == "---")?;
        let close = lines
            .iter()
            .enumerate()
            .skip(open + 1)
            .find(|(_, l)| l.trim() == "---")
            .map(|(i, _)| i)?;
        Some((lines, open, close))
    });
    let (mut fm, body): (Vec<String>, String) = if let Some((lines, open, close)) = fenced {
        (
            lines[open + 1..close].iter().map(|s| s.to_string()).collect(),
            lines[close + 1..].join("\n").trim().to_string(),
        )
    } else {
        (
            vec![
                "type: year".to_string(),
                format!("title: \"{folder_name}\""),
                format!("startAt: {folder_name}-01-01"),
            ],
            original.as_deref().unwrap_or("").trim().to_string(),
        )
    };
    set_fm_field(&mut fm, "sizeFactor", value.as_deref());

    let mut out = String::from("---\n");
    out.push_str(&fm.join("\n"));
    out.push_str("\n---\n");
    if !body.is_empty() {
        out.push('\n');
        out.push_str(&body);
        out.push('\n');
    }
    write_atomic(&path, &out)
}

/// Zet (of wist) het `theme`-veld in `<folder>/_year.md` als één inline
/// flow-map-regel. `None` — of een ThemeChoice zonder gevulde subvelden —
/// verwijdert het veld/blok volledig ("geërfd" laat geen spoor achter).
/// Zelfde `_year.md`-aanmaaklogica als [`set_year_cover`] (bewust ZONDER `id`
/// → jaar-id blijft stabiel); wissen zonder bestand blijft een no-op.
pub fn set_year_theme(
    vault_root: &Path,
    folder_name: &str,
    theme: Option<&ThemeChoice>,
) -> std::io::Result<()> {
    let path = vault_root.join(folder_name).join("_year.md");
    let original = std::fs::read_to_string(&path).ok();
    let value = theme.and_then(theme_flow_map);
    // Niets te wissen als er geen bestand is → geen loos `_year.md` aanmaken.
    if value.is_none() && original.is_none() {
        return Ok(());
    }
    let fenced = original.as_ref().and_then(|c| {
        let n = c.replace("\r\n", "\n");
        let lines: Vec<String> = n.split('\n').map(|s| s.to_string()).collect();
        let open = lines.iter().position(|l| l.trim() == "---")?;
        let close = lines
            .iter()
            .enumerate()
            .skip(open + 1)
            .find(|(_, l)| l.trim() == "---")
            .map(|(i, _)| i)?;
        Some((lines, open, close))
    });
    let (mut fm, body): (Vec<String>, String) = if let Some((lines, open, close)) = fenced {
        (
            lines[open + 1..close].iter().map(|s| s.to_string()).collect(),
            lines[close + 1..].join("\n").trim().to_string(),
        )
    } else {
        // Geen fences (bestand ontbreekt of malformed): minimale frontmatter ZONDER id.
        (
            vec![
                "type: year".to_string(),
                format!("title: \"{folder_name}\""),
                format!("startAt: {folder_name}-01-01"),
            ],
            original.as_deref().unwrap_or("").trim().to_string(),
        )
    };
    set_fm_block(&mut fm, "theme", value);

    let mut out = String::from("---\n");
    out.push_str(&fm.join("\n"));
    out.push_str("\n---\n");
    if !body.is_empty() {
        out.push('\n');
        out.push_str(&body);
        out.push('\n');
    }
    write_atomic(&path, &out)
}

/// Maakt een event in een jaarmap. Geeft (id, folder_path) terug.
///
/// De mapnaam wordt uniek gemaakt: twee events met dezelfde titel én datum
/// zouden anders dezelfde map delen en zou de tweede `create_event` het
/// `_event.md` (de identiteit) van het bestaande event overschrijven — stil
/// dataverlies (het plan eist expliciet unieke slugs, `writer.ts:345`).
pub fn create_event(
    vault_root: &Path,
    year_folder: &str,
    title: &str,
    start_at: &str,
    end_at: Option<&str>,
    size: Option<i64>,
) -> std::io::Result<(String, String)> {
    let id = uuid::Uuid::new_v4().to_string();
    // De event-map moet onder de jaarmap liggen die bij `start_at` hoort — de
    // scanner leidt het jaar uit de MAP af, niet uit de frontmatter. Kiest de
    // gebruiker een datum in een ander jaar dan het bekeken jaar, dan plaatsen we
    // 'm alsnog in het juiste jaar (map wordt zo nodig aangemaakt).
    let target_year = year_of(start_at).unwrap_or_else(|| year_folder.to_string());
    let base_name = format!("{start_at} {}", sanitize_folder(title));
    let folder_path = unique_event_folder(vault_root, &target_year, &base_name, &id);
    let md = event_markdown(&id, title, start_at, end_at, size);
    let path = vault_root.join(&folder_path).join("_event.md");
    write_atomic(&path, &md)?;
    Ok((id, folder_path))
}

/// Kiest een niet-bestaande eventmap: eerst de kale `{jaar}/{basis}`; bij een
/// collisie een korte id-suffix erachter (nieuw uuid per event → uniek).
fn unique_event_folder(vault_root: &Path, year_folder: &str, base_name: &str, id: &str) -> String {
    let candidate = format!("{year_folder}/{base_name}");
    if !vault_root.join(&candidate).exists() {
        return candidate;
    }
    let short: String = id.chars().filter(|c| *c != '-').take(8).collect();
    format!("{year_folder}/{base_name} {short}")
}

/// Importeert een foto (drag&drop-pad): kopieert het bronbestand de eventmap in
/// en schrijft een item-`.md` met de bestandsnaam-stam als caption, zonder
/// `happenedAt`. Geeft het nieuwe item-id terug.
pub fn import_photo(vault_root: &Path, folder_path: &str, source: &Path) -> Result<String, String> {
    let name = source.file_name().and_then(|s| s.to_str()).unwrap_or("foto.jpg");
    import_media_inner(vault_root, folder_path, source, name, true, None)
}

/// Importeert een mediabestand (inbox-pad): kopieert `source` de eventmap in met
/// een naam afgeleid van `original_name` (uit de envelope — de bron-temp heeft een
/// `<order>_`-prefix die we hier níét willen), zonder caption, en met een
/// `happened_at`-tijdstip voor volgorde-behoud (moet `…T12:MM:SSZ` zijn — de `Z`
/// is verplicht, anders faalt `to_millis` stil). Geeft het nieuwe item-id terug.
pub fn import_media(
    vault_root: &Path,
    folder_path: &str,
    source: &Path,
    original_name: &str,
    happened_at: &str,
) -> Result<String, String> {
    import_media_inner(vault_root, folder_path, source, original_name, false, Some(happened_at))
}

/// Gedeelde kern van `import_photo`/`import_media`. `name` levert extensie + stam
/// (bepaalt het vault-bestandsnaam-patroon en het itemtype); `caption_from_stem`
/// zet de stam als caption (drag&drop) of niet (inbox).
fn import_media_inner(
    vault_root: &Path,
    folder_path: &str,
    source: &Path,
    name: &str,
    caption_from_stem: bool,
    happened_at: Option<&str>,
) -> Result<String, String> {
    let name_path = Path::new(name);
    let ext = name_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_else(|| "jpg".to_string());
    let stem = name_path.file_stem().and_then(|s| s.to_str()).unwrap_or("bestand");
    let id = uuid::Uuid::new_v4().to_string();
    let base = generate_slug(stem, 40);
    let short: String = id.chars().filter(|c| *c != '-').take(8).collect();
    let media = format!("{base}_{short}.{ext}");
    let slug = format!("{base}_{short}");

    let dir = vault_root.join(folder_path);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // Kopieer (nooit verplaatsen) de bron de eventmap in. Faalt de kopie
    // halverwege (onleesbare bron, schijf vol), dan kan op sommige platforms een
    // half-geschreven doelbestand achterblijven; dat zou de scanner als "losse
    // media" oppikken en een kapotte thumbnail tonen. Ruim het daarom op.
    let dest = dir.join(&media);
    if let Err(e) = std::fs::copy(source, &dest) {
        let _ = std::fs::remove_file(&dest);
        return Err(format!("kopiëren mislukt: {e}"));
    }

    // §9.3: leid het type af uit de extensie zodat een `.mp4` als `video` wordt
    // geïndexeerd, niet als `photo` (de scanner laat frontmatter-type winnen).
    let caption = if caption_from_stem { Some(stem) } else { None };
    let md = media_item_markdown(&id, media_type_for_ext(&ext), &media, caption, happened_at);
    write_atomic(&dir.join(format!("{slug}.md")), &md).map_err(|e| e.to_string())?;
    Ok(id)
}

/// Verplaatst een hele eventmap naar de OS-prullenbak (omkeerbaar). Gebruikt door
/// de inbox-import om een half geïmporteerd event op te ruimen vóór een herstart.
/// Containment: weiger elk pad buiten de vault én de vault-root zelf.
pub fn delete_event(vault_root: &Path, folder_path: &str) -> Result<(), String> {
    let path = vault_root.join(folder_path);
    if !path.exists() {
        return Ok(());
    }
    let canon = std::fs::canonicalize(&path).map_err(|e| e.to_string())?;
    let canon_vault = std::fs::canonicalize(vault_root).map_err(|e| e.to_string())?;
    if !canon.starts_with(&canon_vault) || canon == canon_vault {
        return Err(format!("map buiten de vault (of de vault zelf) geweigerd: {folder_path}"));
    }
    trash::delete(&canon).map_err(|e| e.to_string())
}

/// Verplaatst een bestand naar de OS-prullenbak (omkeerbaar).
///
/// Containment: `relative` kan (deels) uit onvertrouwde frontmatter komen — het
/// `media:`-veld van een item is vrije tekst en kan `../` bevatten. Zonder
/// controle zou `trash_file` een bestand *buiten* de vault naar de prullenbak
/// kunnen verplaatsen. We canonicaliseren en eisen dat het doel binnen de vault
/// ligt (zelfde bescherming als `resolve_thumb`).
pub fn trash_file(vault_root: &Path, relative: &str) -> Result<(), String> {
    let path = vault_root.join(relative);
    if !path.exists() {
        return Ok(());
    }
    let canon = std::fs::canonicalize(&path).map_err(|e| e.to_string())?;
    let canon_vault = std::fs::canonicalize(vault_root).map_err(|e| e.to_string())?;
    if !canon.starts_with(&canon_vault) {
        return Err(format!("bestand buiten de vault geweigerd: {relative}"));
    }
    trash::delete(&canon).map_err(|e| e.to_string())
}

#[derive(Serialize)]
struct CanvasEntry<'a> {
    #[serde(rename = "itemSlug")]
    item_slug: &'a str,
    x: f64,
    y: f64,
    scale: f64,
    rotation: f64,
    #[serde(rename = "zIndex")]
    z_index: i64,
    #[serde(rename = "textScale", skip_serializing_if = "Option::is_none")]
    text_scale: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    width: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    height: Option<f64>,
}

#[derive(Serialize)]
struct CanvasFile<'a> {
    version: u32,
    items: Vec<CanvasEntry<'a>>,
}

/// Serialiseert canvas-items naar de `_canvas.json`-tekst (v1-formaat).
pub fn canvas_json(items: &[CanvasItem]) -> String {
    let file = CanvasFile {
        version: 1,
        items: items
            .iter()
            .map(|c| CanvasEntry {
                item_slug: &c.item_ref,
                x: c.x,
                y: c.y,
                scale: c.scale,
                rotation: c.rotation,
                z_index: c.z_index,
                text_scale: c.text_scale,
                width: c.width,
                height: c.height,
            })
            .collect(),
    };
    serde_json::to_string_pretty(&file).unwrap_or_else(|_| "{\"version\":1,\"items\":[]}".to_string())
}

/// Schrijft `_canvas.json` in de eventmap. Schrijft atomair (temp + rename).
pub fn write_canvas(
    vault_root: &Path,
    folder_path: &str,
    items: &[CanvasItem],
) -> std::io::Result<()> {
    let dir = vault_root.join(folder_path);
    std::fs::create_dir_all(&dir)?;
    let target = dir.join("_canvas.json");
    let tmp = dir.join(format!("_canvas.json.tmp.{}", std::process::id()));
    std::fs::write(&tmp, canvas_json(items))?;
    std::fs::rename(&tmp, &target)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(reference: &str, x: f64, y: f64) -> CanvasItem {
        CanvasItem {
            event_id: "ev".into(),
            item_ref: reference.into(),
            x,
            y,
            scale: 1.0,
            rotation: 0.0,
            z_index: 0,
            text_scale: None,
            width: None,
            height: None,
        }
    }

    #[test]
    fn canvas_json_uses_v1_shape() {
        let json = canvas_json(&[item("foto", 10.0, -5.0)]);
        assert!(json.contains("\"version\": 1"));
        assert!(json.contains("\"itemSlug\": \"foto\""));
        assert!(json.contains("\"zIndex\": 0"));
    }

    #[test]
    fn slug_is_ascii_safe_and_unique() {
        assert_eq!(generate_slug("Café op 't Plein!", 40), "caf-op-t-plein");
        assert_eq!(generate_slug("", 40), "untitled");
        let u = generate_unique_slug("Mooie dag", "66586b1f-bde2-4a1f");
        assert!(u.starts_with("mooie-dag_"));
        assert!(u.ends_with("66586b1f"));
    }

    #[test]
    fn text_item_markdown_is_parseable() {
        let md = text_item_markdown("id1", Some("Titel: met dubbele punt"), "De body.\n", None);
        let parsed = crate::vault::frontmatter::parse(&md);
        assert_eq!(parsed.get_str("id").unwrap(), "id1");
        assert_eq!(parsed.get_str("type").unwrap(), "text");
        assert_eq!(parsed.get_str("caption").unwrap(), "Titel: met dubbele punt");
        assert_eq!(parsed.body, "De body.");
    }

    #[test]
    fn media_item_type_follows_extension() {
        // §9.3-regressie: video-extensies moeten `type: video` krijgen, foto's
        // `type: photo`, onbekende vallen tolerant terug op `photo`.
        assert_eq!(media_type_for_ext("mp4"), "video");
        assert_eq!(media_type_for_ext("MOV"), "video");
        assert_eq!(media_type_for_ext("jpg"), "photo");
        assert_eq!(media_type_for_ext("heic"), "photo");
        assert_eq!(media_type_for_ext("xyz"), "photo");

        let md = media_item_markdown("id1", media_type_for_ext("mp4"), "clip_ab12cd34.mp4", None, Some("2026-07-11T12:00:05Z"));
        let parsed = crate::vault::frontmatter::parse(&md);
        assert_eq!(parsed.get_str("type").unwrap(), "video");
        assert_eq!(parsed.get_str("media").unwrap(), "clip_ab12cd34.mp4");
        assert_eq!(parsed.get_str("happenedAt").unwrap(), "2026-07-11T12:00:05Z");
    }

    #[test]
    fn create_text_item_writes_readable_file() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("2024/ev")).unwrap();
        let (id, slug) = create_text_item(root, "2024/ev", Some("Notitie"), "Hallo").unwrap();
        let content = std::fs::read_to_string(root.join(format!("2024/ev/{slug}.md"))).unwrap();
        let parsed = crate::vault::frontmatter::parse(&content);
        assert_eq!(parsed.get_str("id").unwrap(), id);
        assert_eq!(parsed.body, "Hallo");
    }

    #[test]
    fn update_item_preserves_other_fields() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("2024/ev")).unwrap();
        // Een foto-item met extra velden die behouden moeten blijven.
        std::fs::write(
            root.join("2024/ev/foto.md"),
            "---\nid: p1\ntype: photo\nmedia: foto.jpg\ncaption: Oud\ncategory: reizen\ncreatedAt: 2020-01-01T00:00:00.000Z\n---\n",
        )
        .unwrap();

        // Caption wijzigen, body ongemoeid.
        update_item(root, "2024/ev", "foto", Some("Nieuw bijschrift"), None).unwrap();
        let content = std::fs::read_to_string(root.join("2024/ev/foto.md")).unwrap();
        let p = crate::vault::frontmatter::parse(&content);
        assert_eq!(p.get_str("id").unwrap(), "p1");
        assert_eq!(p.get_str("type").unwrap(), "photo");
        assert_eq!(p.get_str("media").unwrap(), "foto.jpg");
        assert_eq!(p.get_str("category").unwrap(), "reizen");
        assert_eq!(p.get_str("createdAt").unwrap(), "2020-01-01T00:00:00.000Z");
        assert_eq!(p.get_str("caption").unwrap(), "Nieuw bijschrift");
        assert!(p.get_str("updatedAt").is_some(), "updatedAt moet gezet zijn");
    }

    #[test]
    fn update_item_preserves_nested_fields_and_does_not_touch_nested_caption() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("2024/ev")).unwrap();
        // Item ZONDER top-level caption, mét een geneste `caption:` binnen `place:`
        // en block-sequences (`people:`/`tags:`). De geneste caption is een valstrik:
        // een naïeve `trim_start().starts_with("caption:")` zou die un-indenten en de
        // map breken.
        std::fs::write(
            root.join("2024/ev/foto.md"),
            "---\nid: p1\ntype: photo\nmedia: foto.jpg\nplace:\n  lat: 52.37\n  label: Amsterdam\n  caption: Stad aan het water\npeople:\n  - Jim\n  - Wout\ntags:\n  - strand\n---\n",
        )
        .unwrap();

        update_item(root, "2024/ev", "foto", Some("Nieuw bijschrift"), None).unwrap();
        let content = std::fs::read_to_string(root.join("2024/ev/foto.md")).unwrap();
        let p = crate::vault::frontmatter::parse(&content);

        // Top-level caption is nieuw toegevoegd.
        assert_eq!(p.get_str("caption").unwrap(), "Nieuw bijschrift");
        // De geneste map is volledig intact — inclusief de geneste `caption:`.
        let place = p.get("place").unwrap().as_map().unwrap();
        assert_eq!(place.get("lat").unwrap().as_f64().unwrap(), 52.37);
        assert_eq!(place.get("label").unwrap().as_str().unwrap(), "Amsterdam");
        assert_eq!(
            place.get("caption").unwrap().as_str().unwrap(),
            "Stad aan het water",
            "geneste caption mag niet aangeraakt zijn"
        );
        // Block-sequences blijven behouden.
        assert_eq!(
            p.get("people").unwrap().as_string_list(),
            vec!["Jim".to_string(), "Wout".to_string()]
        );
        assert_eq!(p.get("tags").unwrap().as_string_list(), vec!["strand".to_string()]);
    }

    #[test]
    fn update_item_replaces_body_and_can_clear_caption() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("2024/ev")).unwrap();
        let (_id, slug) =
            create_text_item(root, "2024/ev", Some("Titel"), "Oude tekst").unwrap();

        // Body vervangen én caption verwijderen (lege string).
        update_item(root, "2024/ev", &slug, Some(""), Some("Nieuwe, langere tekst.")).unwrap();
        let content = std::fs::read_to_string(root.join(format!("2024/ev/{slug}.md"))).unwrap();
        let p = crate::vault::frontmatter::parse(&content);
        assert_eq!(p.body, "Nieuwe, langere tekst.");
        assert!(p.get_str("caption").is_none(), "caption moet verwijderd zijn");
        assert_eq!(p.get_str("type").unwrap(), "text");
    }

    #[test]
    fn update_item_meta_writes_fields_and_replaces_nested_place() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("2024/ev")).unwrap();
        // Item met een GENESTE place-map + een te behouden veld (media).
        std::fs::write(
            root.join("2024/ev/foto.md"),
            "---\nid: p1\ntype: photo\nmedia: foto.jpg\nplace:\n  lat: 52.37\n  lng: 4.89\n  label: Amsterdam\n---\n",
        )
        .unwrap();

        update_item_meta(
            root,
            "2024/ev",
            "foto",
            "Op het strand",
            "2024-08-15",
            "Scheveningen",
            &["Jim".into(), "Wout".into()],
            &["strand".into(), "zomer".into()],
        )
        .unwrap();

        let content = std::fs::read_to_string(root.join("2024/ev/foto.md")).unwrap();
        let p = crate::vault::frontmatter::parse(&content);
        // Behouden veld.
        assert_eq!(p.get_str("media").unwrap(), "foto.jpg");
        assert_eq!(p.get_str("id").unwrap(), "p1");
        // Nieuwe scalars.
        assert_eq!(p.get_str("caption").unwrap(), "Op het strand");
        assert_eq!(p.get_str("date").unwrap(), "2024-08-15");
        // De geneste place-map is VERVANGEN door een scalar (geen orphaned lat/lng).
        assert_eq!(p.get_str("place").unwrap(), "Scheveningen");
        assert!(!content.contains("lat:"), "oude geneste place-regels moeten weg zijn");
        // Lijsten round-trippen.
        assert_eq!(p.get("people").unwrap().as_string_list(), vec!["Jim", "Wout"]);
        assert_eq!(p.get("tags").unwrap().as_string_list(), vec!["strand", "zomer"]);

        // Leegmaken verwijdert de velden weer.
        update_item_meta(root, "2024/ev", "foto", "", "", "", &[], &[]).unwrap();
        let p2 = crate::vault::frontmatter::parse(
            &std::fs::read_to_string(root.join("2024/ev/foto.md")).unwrap(),
        );
        assert!(p2.get_str("place").is_none());
        assert!(p2.get("people").is_none());
        assert!(p2.get_str("caption").is_none());
        assert_eq!(p2.get_str("media").unwrap(), "foto.jpg");
    }

    #[test]
    fn update_item_meta_roundtrips_special_chars_in_people_tags() {
        // Namen/tags met een quote, komma of dubbele punt moeten via de
        // eigen writer→parser round-trippen zonder corruptie.
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("2024/ev")).unwrap();
        std::fs::write(
            root.join("2024/ev/foto.md"),
            "---\nid: p1\ntype: photo\nmedia: foto.jpg\n---\n",
        )
        .unwrap();

        let people = vec!["O'Brien".to_string(), "van \"Loon\"".to_string(), "a,b".to_string()];
        let tags = vec!["tijd: 12:00".to_string(), "zee, strand".to_string()];
        update_item_meta(root, "2024/ev", "foto", "", "", "", &people, &tags).unwrap();

        let content = std::fs::read_to_string(root.join("2024/ev/foto.md")).unwrap();
        let p = crate::vault::frontmatter::parse(&content);
        assert_eq!(p.get("people").unwrap().as_string_list(), people);
        assert_eq!(p.get("tags").unwrap().as_string_list(), tags);
    }

    #[test]
    fn update_item_meta_drains_nested_block_with_blank_line() {
        // Regressie: een handmatig/v1-bewerkt bestand kan een LEGE regel midden in
        // een geneste `place:`-map hebben. `set_fm_block` mocht de drain daar niet
        // te vroeg stoppen — anders bleef `label: Amsterdam` verweesd achter en
        // brak de reconstructie (of ging stil verloren bij herparsen).
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("2024/ev")).unwrap();
        std::fs::write(
            root.join("2024/ev/foto.md"),
            "---\nid: p1\ntype: photo\nmedia: foto.jpg\nplace:\n  lat: 52.37\n\n  label: Amsterdam\ncategory: reizen\n---\n",
        )
        .unwrap();

        update_item_meta(root, "2024/ev", "foto", "", "", "Scheveningen", &[], &[]).unwrap();
        let content = std::fs::read_to_string(root.join("2024/ev/foto.md")).unwrap();
        // De oude geneste regels (incl. die na de lege regel) moeten volledig weg.
        assert!(!content.contains("lat:"), "oude geneste regel moet weg: {content}");
        assert!(!content.contains("label:"), "verweesde regel na lege regel moet weg: {content}");
        let p = crate::vault::frontmatter::parse(&content);
        assert_eq!(p.get_str("place").unwrap(), "Scheveningen");
        // Velden vóór en ná het blok blijven behouden.
        assert_eq!(p.get_str("media").unwrap(), "foto.jpg");
        assert_eq!(p.get_str("category").unwrap(), "reizen");
    }

    #[test]
    fn update_item_meta_drains_nested_block_as_last_field() {
        // Het geneste blok is het LAATSTE veld in de frontmatter (drain tot einde).
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("2024/ev")).unwrap();
        std::fs::write(
            root.join("2024/ev/foto.md"),
            "---\nid: p1\ntype: photo\nmedia: foto.jpg\nplace:\n  lat: 52.37\n  label: Amsterdam\n---\nEen bewaarde beschrijving.\n",
        )
        .unwrap();

        update_item_meta(root, "2024/ev", "foto", "Bijschrift", "", "Scheveningen", &[], &[]).unwrap();
        let content = std::fs::read_to_string(root.join("2024/ev/foto.md")).unwrap();
        assert!(!content.contains("lat:"), "oude geneste regels moeten weg: {content}");
        let p = crate::vault::frontmatter::parse(&content);
        assert_eq!(p.get_str("place").unwrap(), "Scheveningen");
        assert_eq!(p.get_str("caption").unwrap(), "Bijschrift");
        assert_eq!(p.get_str("media").unwrap(), "foto.jpg");
        // Body blijft behouden.
        assert_eq!(p.body, "Een bewaarde beschrijving.");
    }

    #[test]
    fn bracket_title_roundtrips_via_frontmatter() {
        // `[done]` zou zonder quotes als flow-seq gelezen worden → titel weg.
        let md = event_markdown("id1", "[done]", "2024-07-01", None, None);
        let parsed = crate::vault::frontmatter::parse(&md);
        assert_eq!(parsed.get_str("title").unwrap(), "[done]");
        // Ook letterlijke quotes in een titel moeten overleven.
        let md2 = event_markdown("id2", "\"Zomer\"", "2024-07-01", None, None);
        let parsed2 = crate::vault::frontmatter::parse(&md2);
        assert_eq!(parsed2.get_str("title").unwrap(), "\"Zomer\"");
    }

    #[test]
    fn update_event_sets_title_dates_and_can_clear_end() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let (_id, folder) =
            create_event(root, "2024", "Reis", "2024-07-01", Some("2024-07-10"), None).unwrap();
        // Bevestig dat de einddatum geschreven is.
        let c0 = std::fs::read_to_string(root.join(&folder).join("_event.md")).unwrap();
        assert_eq!(crate::vault::frontmatter::parse(&c0).get_str("endAt").unwrap(), "2024-07-10");

        // Titel + startdatum wijzigen, einddatum wissen (None).
        update_event(root, &folder, "Reis naar Spanje", "2024-07-02", None).unwrap();
        let c1 = std::fs::read_to_string(root.join(&folder).join("_event.md")).unwrap();
        let p = crate::vault::frontmatter::parse(&c1);
        assert_eq!(p.get_str("title").unwrap(), "Reis naar Spanje");
        assert_eq!(p.get_str("startAt").unwrap(), "2024-07-02");
        assert!(p.get_str("endAt").is_none(), "einddatum moet gewist zijn");
        assert_eq!(p.get_str("type").unwrap(), "event");

        // Einddatum weer zetten.
        update_event(root, &folder, "Reis naar Spanje", "2024-07-02", Some("2024-07-12")).unwrap();
        let c2 = std::fs::read_to_string(root.join(&folder).join("_event.md")).unwrap();
        assert_eq!(crate::vault::frontmatter::parse(&c2).get_str("endAt").unwrap(), "2024-07-12");
    }

    #[test]
    fn update_event_preserves_unknown_fields() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("2024/ev")).unwrap();
        // _event.md met velden die de UI niet kent maar die behouden moeten blijven.
        std::fs::write(
            root.join("2024/ev/_event.md"),
            "---\nid: ev1\ntype: event\ntitle: Oud\nstartAt: 2024-07-01\ncategory: reizen\ncoverPhoto: strand.jpg\nfeaturedPhoto: strand.jpg\ncreatedAt: 2020-01-01T00:00:00.000Z\n---\nEen bewaarde beschrijving.\n",
        )
        .unwrap();

        update_event(root, "2024/ev", "Nieuw", "2024-07-05", None).unwrap();
        let c = std::fs::read_to_string(root.join("2024/ev/_event.md")).unwrap();
        let p = crate::vault::frontmatter::parse(&c);
        assert_eq!(p.get_str("title").unwrap(), "Nieuw");
        assert_eq!(p.get_str("startAt").unwrap(), "2024-07-05");
        // Onbekende/behouden velden overleven de edit.
        assert_eq!(p.get_str("category").unwrap(), "reizen");
        assert_eq!(p.get_str("coverPhoto").unwrap(), "strand.jpg");
        assert_eq!(p.get_str("featuredPhoto").unwrap(), "strand.jpg");
        assert_eq!(p.get_str("createdAt").unwrap(), "2020-01-01T00:00:00.000Z");
        // Body blijft behouden.
        assert_eq!(p.body, "Een bewaarde beschrijving.");
    }

    #[test]
    fn update_event_relocates_to_matching_year_on_year_change() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let (id, folder) =
            create_event(root, "2024", "Reis", "2024-07-01", None, None).unwrap();
        assert!(folder.starts_with("2024/"));

        // Startdatum naar 2025 → de event-map moet naar de 2025-jaarmap verhuizen.
        let new_folder = update_event(root, &folder, "Reis", "2025-03-01", None).unwrap();
        assert!(new_folder.starts_with("2025/"), "map moet in 2025 liggen, was: {new_folder}");
        assert!(!root.join(&folder).exists(), "oude map mag niet meer bestaan");
        let c = std::fs::read_to_string(root.join(&new_folder).join("_event.md")).unwrap();
        let p = crate::vault::frontmatter::parse(&c);
        assert_eq!(p.get_str("id").unwrap(), id);
        assert_eq!(p.get_str("startAt").unwrap(), "2025-03-01");

        // Een volledige scan wijst het event nu aan het JAAR 2025 toe.
        let model = crate::vault::scan(root);
        let ev = model.events.iter().find(|e| e.id == id).unwrap();
        let year = model.years.iter().find(|y| y.id == ev.year_id).unwrap();
        assert_eq!(year.year, 2025, "event moet in jaar 2025 vallen na de datum-edit");
    }

    #[test]
    fn update_event_within_same_year_keeps_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let (_id, folder) =
            create_event(root, "2024", "Reis", "2024-07-01", None, None).unwrap();
        // Datum binnen hetzelfde jaar → map blijft (identiteit in frontmatter).
        let same = update_event(root, &folder, "Reis", "2024-09-09", None).unwrap();
        assert_eq!(same, folder, "binnen hetzelfde jaar blijft de mapnaam gelijk");
    }

    #[test]
    fn update_event_does_not_relocate_when_target_exists() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let (_id, folder) = create_event(root, "2024", "Reis", "2024-07-01", None, None).unwrap();
        // Zet een botsende map klaar in 2025 met exact dezelfde basisnaam.
        let base = folder.split_once('/').unwrap().1;
        std::fs::create_dir_all(root.join(format!("2025/{base}"))).unwrap();
        // Verhuizing zou botsen → event blijft staan, geen overschrijving.
        let result = update_event(root, &folder, "Reis", "2025-01-01", None).unwrap();
        assert_eq!(result, folder, "bij een botsend doel blijft het event op zijn plek");
        assert!(root.join(&folder).join("_event.md").exists());
    }

    #[test]
    fn update_event_materializes_missing_event_md_in_subfolder() {
        // Regressie (ENOENT "os error 2"): een memory-map ZONDER _event.md (bijv. een
        // pure foto-map uit een bestaand archief) mag niet crashen bij een titel-/
        // datum-edit; we materialiseren dan een _event.md i.p.v. te lezen-en-falen.
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let folder = "2024/2024-08-01 strand";
        std::fs::create_dir_all(root.join(folder)).unwrap();
        std::fs::write(root.join(folder).join("foto.jpg"), b"x").unwrap(); // geen _event.md

        let result = update_event(root, folder, "Strand", "2024-08-01", None).unwrap();
        assert_eq!(result, folder);
        let md = root.join(folder).join("_event.md");
        assert!(md.exists(), "_event.md is gematerialiseerd i.p.v. crash");
        let parsed = crate::vault::frontmatter::parse(&std::fs::read_to_string(&md).unwrap());
        assert_eq!(parsed.get_str("title").unwrap(), "Strand");
        assert_eq!(parsed.get_str("startAt").unwrap(), "2024-08-01");
        // De stabiele id (uit het pad) is vastgelegd → blijft matchen na een scan.
        assert_eq!(
            parsed.get_str("id").unwrap(),
            crate::vault::scanner::stable_id("event", folder)
        );
    }

    #[test]
    fn update_event_cross_year_on_missing_event_md_keeps_stable_id() {
        // Regressie-edge: datum-edit over een jaargrens op een memory ZONDER _event.md
        // verhuist de map. De id moet gelijk blijven aan wat de scanner uit het ORIGINELE
        // pad afleidde, zodat een vervolg-setEventSize(oude id) de event nog vindt.
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let orig = "2024/2024-12-30 oud-en-nieuw";
        std::fs::create_dir_all(root.join(orig)).unwrap();
        std::fs::write(root.join(orig).join("foto.jpg"), b"x").unwrap(); // geen _event.md
        let orig_id = crate::vault::scanner::stable_id("event", orig);

        // Datum naar 2025 → map verhuist naar 2025/…
        let moved = update_event(root, orig, "Oud en nieuw", "2025-01-01", None).unwrap();
        assert!(moved.starts_with("2025/"), "verhuisd naar 2025, was: {moved}");
        let parsed = crate::vault::frontmatter::parse(
            &std::fs::read_to_string(root.join(&moved).join("_event.md")).unwrap(),
        );
        assert_eq!(parsed.get_str("id").unwrap(), orig_id, "id blijft de originele stabiele id");
    }

    #[test]
    fn update_event_on_loose_year_folder_is_noop() {
        // Een losse-media "bundel" op jaarniveau (geen subfolder, geen _event.md) kan
        // geen event-bestand persisteren → netjes overslaan i.p.v. crashen.
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("2024")).unwrap();
        let result = update_event(root, "2024", "Losse", "2024-01-01", None).unwrap();
        assert_eq!(result, "2024");
        assert!(
            !root.join("2024").join("_event.md").exists(),
            "geen _event.md in een losse jaarmap"
        );
    }

    #[test]
    fn ensure_event_md_creates_when_missing_and_is_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let folder = "2024/2024-08-01 strand";
        std::fs::create_dir_all(root.join(folder)).unwrap();

        // Ontbreekt → aangemaakt (zonder id), tweede keer → no-op.
        assert!(ensure_event_md(root, folder).unwrap(), "eerste keer aangemaakt");
        let md = root.join(folder).join("_event.md");
        let content = std::fs::read_to_string(&md).unwrap();
        let parsed = crate::vault::frontmatter::parse(&content);
        assert_eq!(parsed.get_str("type").unwrap(), "event");
        assert!(parsed.get_str("id").is_none(), "geen id (scanner leidt 'm af)");

        assert!(!ensure_event_md(root, folder).unwrap(), "tweede keer no-op");
        assert_eq!(std::fs::read_to_string(&md).unwrap(), content, "bestaand bestand ongemoeid");
    }

    #[test]
    fn ensure_year_md_creates_when_missing_without_id() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("2024")).unwrap();

        assert!(ensure_year_md(root, "2024").unwrap());
        let parsed =
            crate::vault::frontmatter::parse(&std::fs::read_to_string(root.join("2024/_year.md")).unwrap());
        assert_eq!(parsed.get_str("type").unwrap(), "year");
        assert_eq!(parsed.get_str("startAt").unwrap(), "2024-01-01");
        assert!(parsed.get_str("id").is_none(), "jaar-id blijft folder-derived");

        assert!(!ensure_year_md(root, "2024").unwrap(), "tweede keer no-op");
    }

    #[test]
    fn create_event_with_empty_year_folder_creates_year_from_date() {
        // Het "eerste memory in een lege vault"-pad: geen jaar-hint, alleen datum.
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let (_id, folder) =
            create_event(root, "", "Eerste memory", "2026-07-10", None, Some(50)).unwrap();
        assert!(folder.starts_with("2026/"), "jaarmap uit de datum, was: {folder}");
        assert!(root.join(&folder).join("_event.md").exists());
    }

    #[test]
    fn create_event_uses_year_from_start_at() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        // Bekeken jaar = 2024, maar de gekozen startdatum ligt in 2023.
        let (_id, folder) = create_event(root, "2024", "Terugblik", "2023-12-30", None, None).unwrap();
        assert!(folder.starts_with("2023/"), "event hoort in 2023, was: {folder}");
        assert!(root.join(&folder).join("_event.md").exists());
    }

    #[test]
    fn set_event_featured_sets_and_clears() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let (_id, folder) = create_event(root, "2024", "Reis", "2024-07-01", None, None).unwrap();

        set_event_featured(root, &folder, Some("mooie-foto_ab12cd34")).unwrap();
        let c1 = std::fs::read_to_string(root.join(&folder).join("_event.md")).unwrap();
        let p1 = crate::vault::frontmatter::parse(&c1);
        assert_eq!(p1.get_str("featuredPhoto").unwrap(), "mooie-foto_ab12cd34");
        assert_eq!(p1.get_str("title").unwrap(), "Reis"); // overige velden intact

        set_event_featured(root, &folder, None).unwrap();
        let c2 = std::fs::read_to_string(root.join(&folder).join("_event.md")).unwrap();
        assert!(crate::vault::frontmatter::parse(&c2).get_str("featuredPhoto").is_none());
    }

    #[test]
    fn set_event_featured_materializes_missing_event_md() {
        // Een gescande/geïmporteerde memory-submap met foto's maar ZONDER _event.md
        // (bijv. een bestaand foto-archief). De eerste curatie-actie moet de
        // _event.md aanmaken i.p.v. crashen (de ENOENT-bug), ZONDER `id` zodat de
        // scanner hetzelfde stable_id uit de mapnaam blijft afleiden.
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let folder = "2024/ijsland";
        std::fs::create_dir_all(root.join(folder)).unwrap();
        std::fs::write(root.join(folder).join("foto.jpg"), b"x").unwrap();
        assert!(!root.join(folder).join("_event.md").exists());

        set_event_featured(root, folder, Some("foto_ab12cd34")).unwrap();

        let c = std::fs::read_to_string(root.join(folder).join("_event.md")).unwrap();
        let p = crate::vault::frontmatter::parse(&c);
        assert_eq!(p.get_str("featuredPhoto").unwrap(), "foto_ab12cd34");
        assert_eq!(p.get_str("type").unwrap(), "event");
        assert!(
            p.get_str("id").is_none(),
            "geen id → scanner leidt hetzelfde id uit de mapnaam af"
        );
    }

    #[test]
    fn set_event_curation_is_noop_for_loose_year_folder() {
        // Losse foto's direct in een JAARmap (folder_path zonder submap): daar mag
        // geen _event.md komen — dat zou de jaarmap tot event maken. Geen crash, en
        // geen loos bestand.
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("2024")).unwrap();

        set_event_featured(root, "2024", Some("foto_ab12")).unwrap();
        set_event_size(root, "2024", Some(80)).unwrap();

        assert!(!root.join("2024/_event.md").exists());
    }

    #[test]
    fn set_event_size_clamps_sets_and_clears() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        // Created met een startwaarde in de frontmatter.
        let (_id, folder) = create_event(root, "2024", "Reis", "2024-07-01", None, Some(70)).unwrap();
        let c0 = std::fs::read_to_string(root.join(&folder).join("_event.md")).unwrap();
        assert_eq!(crate::vault::frontmatter::parse(&c0).get_str("size").unwrap(), "70");

        // Buiten bereik → geklemd op 1..=100.
        set_event_size(root, &folder, Some(999)).unwrap();
        let c1 = std::fs::read_to_string(root.join(&folder).join("_event.md")).unwrap();
        let p1 = crate::vault::frontmatter::parse(&c1);
        assert_eq!(p1.get_str("size").unwrap(), "100");
        assert_eq!(p1.get_str("title").unwrap(), "Reis"); // overige velden intact

        // None → veld verdwijnt.
        set_event_size(root, &folder, None).unwrap();
        let c2 = std::fs::read_to_string(root.join(&folder).join("_event.md")).unwrap();
        assert!(crate::vault::frontmatter::parse(&c2).get_str("size").is_none());
    }

    #[test]
    fn set_event_under_construction_sets_and_clears() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let (_id, folder) = create_event(root, "2024", "Reis", "2024-07-01", None, None).unwrap();
        // Standaard afwezig.
        let c0 = std::fs::read_to_string(root.join(&folder).join("_event.md")).unwrap();
        assert!(crate::vault::frontmatter::parse(&c0).get_str("underConstruction").is_none());

        // Aan → veld "true".
        set_event_under_construction(root, &folder, true).unwrap();
        let c1 = std::fs::read_to_string(root.join(&folder).join("_event.md")).unwrap();
        let p1 = crate::vault::frontmatter::parse(&c1);
        assert_eq!(p1.get_str("underConstruction").unwrap(), "true");
        assert_eq!(p1.get_str("title").unwrap(), "Reis"); // overige velden intact

        // Uit → veld verdwijnt (afwezig = false).
        set_event_under_construction(root, &folder, false).unwrap();
        let c2 = std::fs::read_to_string(root.join(&folder).join("_event.md")).unwrap();
        assert!(crate::vault::frontmatter::parse(&c2).get_str("underConstruction").is_none());
    }

    #[test]
    fn set_year_size_factor_writes_clamps_and_clears() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("2024")).unwrap();

        // Schrijft de factor; maakt `_year.md` ZONDER id (jaar-id blijft stabiel).
        set_year_size_factor(root, "2024", Some(0.75)).unwrap();
        let c1 = std::fs::read_to_string(root.join("2024/_year.md")).unwrap();
        let p1 = crate::vault::frontmatter::parse(&c1);
        assert_eq!(p1.get_str("sizeFactor").unwrap(), "0.7500");
        assert!(p1.get_str("id").is_none(), "geen id → scanner leidt stable_id af");

        // Buiten bereik → geklemd op [0.1, 5.0].
        set_year_size_factor(root, "2024", Some(99.0)).unwrap();
        let c2 = std::fs::read_to_string(root.join("2024/_year.md")).unwrap();
        assert_eq!(
            crate::vault::frontmatter::parse(&c2).get_str("sizeFactor").unwrap(),
            "5.0000"
        );

        // ≈1.0 (de standaard) wist het veld — geen clutter in de vault.
        set_year_size_factor(root, "2024", Some(1.0)).unwrap();
        let c3 = std::fs::read_to_string(root.join("2024/_year.md")).unwrap();
        assert!(crate::vault::frontmatter::parse(&c3).get_str("sizeFactor").is_none());
    }

    #[test]
    fn set_year_size_factor_preserves_existing_id_and_cover() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("2024")).unwrap();
        // Bestaand `_year.md` MÉT id en cover → die moeten behouden blijven.
        std::fs::write(
            root.join("2024/_year.md"),
            "---\nid: vast-jaar-id\ntype: year\ntitle: \"2024\"\ncover: mooie-foto\n---\n",
        )
        .unwrap();
        set_year_size_factor(root, "2024", Some(1.4)).unwrap();
        let c = std::fs::read_to_string(root.join("2024/_year.md")).unwrap();
        let p = crate::vault::frontmatter::parse(&c);
        assert_eq!(p.get_str("id").unwrap(), "vast-jaar-id");
        assert_eq!(p.get_str("cover").unwrap(), "mooie-foto");
        assert_eq!(p.get_str("sizeFactor").unwrap(), "1.4000");
    }

    #[test]
    fn set_year_size_factor_no_file_and_default_is_noop() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("2024")).unwrap();
        // Geen `_year.md` + standaardfactor → geen loos bestand aanmaken.
        set_year_size_factor(root, "2024", Some(1.0)).unwrap();
        assert!(!root.join("2024/_year.md").exists());
        set_year_size_factor(root, "2024", None).unwrap();
        assert!(!root.join("2024/_year.md").exists());
    }

    #[test]
    fn set_year_theme_roundtrips_via_scanner_and_clears() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("2024")).unwrap();
        std::fs::write(
            root.join("2024/_year.md"),
            "---\nid: y24\ntype: year\ntitle: \"2024\"\nstartAt: 2024-01-01\ncover: mooie-foto\n---\nEen jaarnotitie.\n",
        )
        .unwrap();

        // Schrijven: alleen gevulde subvelden, accent met '#' moet round-trippen.
        let theme = ThemeChoice {
            id: Some("warm-linen".into()),
            accent: Some("#c47b4f".into()),
            background: None,
            title_font: Some("typewriter".into()),
        };
        set_year_theme(root, "2024", Some(&theme)).unwrap();
        let c1 = std::fs::read_to_string(root.join("2024/_year.md")).unwrap();
        assert!(
            c1.contains("theme: {id: warm-linen, accent: \"#c47b4f\", titleFont: typewriter}"),
            "één inline flow-map-regel, vaste volgorde: {c1}"
        );
        // De scanner leest exact dezelfde ThemeChoice terug.
        let model = crate::vault::scan(root);
        assert_eq!(model.years[0].theme.as_ref(), Some(&theme));
        // Overige velden + body intact.
        let p1 = crate::vault::frontmatter::parse(&c1);
        assert_eq!(p1.get_str("id").unwrap(), "y24");
        assert_eq!(p1.get_str("cover").unwrap(), "mooie-foto");
        assert_eq!(p1.body, "Een jaarnotitie.");

        // None → veld volledig weg ("geërfd"), rest intact.
        set_year_theme(root, "2024", None).unwrap();
        let c2 = std::fs::read_to_string(root.join("2024/_year.md")).unwrap();
        assert!(!c2.contains("theme"), "geen spoor van theme na wissen: {c2}");
        let p2 = crate::vault::frontmatter::parse(&c2);
        assert_eq!(p2.get_str("cover").unwrap(), "mooie-foto");
        assert_eq!(p2.body, "Een jaarnotitie.");
        let model2 = crate::vault::scan(root);
        assert!(model2.years[0].theme.is_none());
    }

    #[test]
    fn set_year_theme_with_empty_subfields_clears_like_none() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("2024")).unwrap();
        std::fs::write(
            root.join("2024/_year.md"),
            "---\ntype: year\ntitle: \"2024\"\nstartAt: 2024-01-01\ntheme: {id: warm-linen}\n---\n",
        )
        .unwrap();
        // Alle subvelden leeg → zelfde als None: veld weg.
        set_year_theme(root, "2024", Some(&ThemeChoice::default())).unwrap();
        let c = std::fs::read_to_string(root.join("2024/_year.md")).unwrap();
        assert!(!c.contains("theme"), "lege ThemeChoice wist het veld: {c}");
    }

    #[test]
    fn set_year_theme_materializes_missing_year_md_without_id() {
        // `_year.md` ontbreekt → aanmaken zoals set_year_cover (ZONDER id).
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("2024")).unwrap();

        let theme = ThemeChoice { id: Some("kraft".into()), ..ThemeChoice::default() };
        set_year_theme(root, "2024", Some(&theme)).unwrap();
        let c = std::fs::read_to_string(root.join("2024/_year.md")).unwrap();
        let p = crate::vault::frontmatter::parse(&c);
        assert_eq!(p.get_str("type").unwrap(), "year");
        assert_eq!(p.get_str("startAt").unwrap(), "2024-01-01");
        assert!(p.get_str("id").is_none(), "geen id → scanner leidt stable_id af");
        let model = crate::vault::scan(root);
        assert_eq!(model.years[0].theme.as_ref(), Some(&theme));

        // Wissen zonder bestand blijft een no-op (geen loos bestand).
        std::fs::remove_file(root.join("2024/_year.md")).unwrap();
        set_year_theme(root, "2024", None).unwrap();
        assert!(!root.join("2024/_year.md").exists());
    }

    #[test]
    fn set_event_theme_roundtrips_and_clears() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let (_id, folder) = create_event(root, "2024", "Reis", "2024-07-01", None, Some(70)).unwrap();

        let theme = ThemeChoice {
            id: Some("kodachrome".into()),
            accent: Some("#aa3311".into()),
            background: Some("kraft".into()),
            title_font: None,
        };
        set_event_theme(root, &folder, Some(&theme)).unwrap();
        let c1 = std::fs::read_to_string(root.join(&folder).join("_event.md")).unwrap();
        assert!(
            c1.contains("theme: {id: kodachrome, accent: \"#aa3311\", background: kraft}"),
            "flow-map-regel met alleen gevulde subvelden: {c1}"
        );
        // Scanner leest exact dezelfde ThemeChoice terug; overige velden intact.
        let model = crate::vault::scan(root);
        let ev = model.events.iter().find(|e| !e.synthetic).unwrap();
        assert_eq!(ev.theme.as_ref(), Some(&theme));
        assert_eq!(ev.title.as_deref(), Some("Reis"));
        assert_eq!(ev.size, Some(70));

        // None → veld weg, rest intact.
        set_event_theme(root, &folder, None).unwrap();
        let c2 = std::fs::read_to_string(root.join(&folder).join("_event.md")).unwrap();
        assert!(!c2.contains("theme"), "geen spoor van theme na wissen: {c2}");
        let p2 = crate::vault::frontmatter::parse(&c2);
        assert_eq!(p2.get_str("title").unwrap(), "Reis");
        assert_eq!(p2.get_str("size").unwrap(), "70");
    }

    #[test]
    fn set_event_theme_replaces_handwritten_nested_block() {
        // Een handgeschreven GENEST theme-blok (met onbekend subveld) moet door
        // een set-aanroep volledig gedraind en vervangen worden door de ene
        // flow-map-regel — geen verweesde geïndenteerde regels.
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("2024/ev")).unwrap();
        std::fs::write(
            root.join("2024/ev/_event.md"),
            "---\nid: ev1\ntype: event\ntitle: Reis\nstartAt: 2024-07-01\ntheme:\n  id: oud-thema\n  glitter: veel\ncategory: reizen\n---\nBeschrijving blijft.\n",
        )
        .unwrap();

        let theme = ThemeChoice { id: Some("warm-linen".into()), ..ThemeChoice::default() };
        set_event_theme(root, "2024/ev", Some(&theme)).unwrap();
        let c = std::fs::read_to_string(root.join("2024/ev/_event.md")).unwrap();
        assert!(c.contains("theme: {id: warm-linen}"), "vervangen door flow-map: {c}");
        assert!(!c.contains("oud-thema"), "oude geneste regels weg: {c}");
        assert!(!c.contains("glitter"), "onbekend subveld mee gedraind: {c}");
        let p = crate::vault::frontmatter::parse(&c);
        assert_eq!(p.get_str("id").unwrap(), "ev1");
        assert_eq!(p.get_str("category").unwrap(), "reizen");
        assert_eq!(p.body, "Beschrijving blijft.");
        // En de scanner leest de nieuwe keuze.
        let model = crate::vault::scan(root);
        let ev = model.events.iter().find(|e| !e.synthetic).unwrap();
        assert_eq!(ev.theme.as_ref(), Some(&theme));
    }

    #[test]
    fn set_event_theme_is_noop_for_loose_year_folder() {
        // Losse-media bundel op jaarniveau: geen _event.md aanmaken (zoals de
        // bestaande curatie-setters).
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("2024")).unwrap();
        let theme = ThemeChoice { id: Some("kraft".into()), ..ThemeChoice::default() };
        set_event_theme(root, "2024", Some(&theme)).unwrap();
        assert!(!root.join("2024/_event.md").exists());
    }

    #[test]
    fn set_item_frame_roundtrips_via_scanner_and_clears() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("2024/ev")).unwrap();
        std::fs::write(
            root.join("2024/_year.md"),
            "---\ntype: year\ntitle: \"2024\"\nstartAt: 2024-01-01\n---\n",
        )
        .unwrap();
        std::fs::write(
            root.join("2024/ev/_event.md"),
            "---\nid: ev1\ntype: event\ntitle: Reis\nstartAt: 2024-07-01\n---\n",
        )
        .unwrap();
        std::fs::write(
            root.join("2024/ev/foto.md"),
            "---\nid: p1\ntype: photo\nmedia: foto.jpg\ncaption: Strand\ncategory: reizen\n---\nBodytekst blijft.\n",
        )
        .unwrap();

        set_item_frame(root, "2024/ev", "foto", Some("polaroid")).unwrap();
        let c1 = std::fs::read_to_string(root.join("2024/ev/foto.md")).unwrap();
        assert!(c1.contains("frame: polaroid"), "frame-regel geschreven: {c1}");
        // Scanner leest de stijl terug; overige velden + body intact.
        let model = crate::vault::scan(root);
        let it = model.items.iter().find(|i| i.id == "p1").unwrap();
        assert_eq!(it.frame.as_deref(), Some("polaroid"));
        assert_eq!(it.caption.as_deref(), Some("Strand"));
        assert_eq!(it.category.as_deref(), Some("reizen"));
        assert_eq!(it.body_text.as_deref(), Some("Bodytekst blijft."));

        // None → regel weg, rest intact.
        set_item_frame(root, "2024/ev", "foto", None).unwrap();
        let c2 = std::fs::read_to_string(root.join("2024/ev/foto.md")).unwrap();
        assert!(!c2.contains("frame"), "geen spoor van frame na wissen: {c2}");
        let p2 = crate::vault::frontmatter::parse(&c2);
        assert_eq!(p2.get_str("caption").unwrap(), "Strand");
        assert_eq!(p2.get_str("category").unwrap(), "reizen");
        assert_eq!(p2.get_str("media").unwrap(), "foto.jpg");
        assert_eq!(p2.body, "Bodytekst blijft.");
    }

    #[test]
    fn set_item_frame_empty_clears_like_none() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("2024/ev")).unwrap();
        std::fs::write(
            root.join("2024/ev/foto.md"),
            "---\nid: p1\ntype: photo\nmedia: foto.jpg\n---\n",
        )
        .unwrap();

        set_item_frame(root, "2024/ev", "foto", Some("rounded")).unwrap();
        assert!(std::fs::read_to_string(root.join("2024/ev/foto.md"))
            .unwrap()
            .contains("frame: rounded"));

        // Lege/whitespace-string wist net als None.
        set_item_frame(root, "2024/ev", "foto", Some("  ")).unwrap();
        let c = std::fs::read_to_string(root.join("2024/ev/foto.md")).unwrap();
        assert!(!c.contains("frame"), "leeg = wissen: {c}");
        let p = crate::vault::frontmatter::parse(&c);
        assert_eq!(p.get_str("media").unwrap(), "foto.jpg");
    }

    #[test]
    fn create_event_does_not_overwrite_existing_event() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let (id1, folder1) = create_event(root, "2024", "Verjaardag", "2024-07-01", None, None).unwrap();
        let (id2, folder2) = create_event(root, "2024", "Verjaardag", "2024-07-01", None, None).unwrap();
        assert_ne!(folder1, folder2, "tweede event mag niet dezelfde map delen");
        // Beide _event.md's bestaan nog met hun eigen identiteit.
        let c1 = std::fs::read_to_string(root.join(&folder1).join("_event.md")).unwrap();
        let c2 = std::fs::read_to_string(root.join(&folder2).join("_event.md")).unwrap();
        assert!(c1.contains(&id1));
        assert!(c2.contains(&id2));
    }

    #[test]
    fn trash_file_rejects_path_outside_vault() {
        let tmp = tempfile::tempdir().unwrap();
        let vault = tmp.path().join("vault");
        std::fs::create_dir_all(vault.join("2024/ev")).unwrap();
        // Bestand buiten de vault dat een gecraft media-veld zou willen trashen.
        std::fs::write(tmp.path().join("secret.txt"), "geheim").unwrap();
        let res = trash_file(&vault, "2024/ev/../../../secret.txt");
        assert!(res.is_err(), "pad buiten de vault moet geweigerd worden");
        assert!(
            tmp.path().join("secret.txt").exists(),
            "het externe bestand mag niet getrasht zijn"
        );
    }

    #[test]
    fn create_event_makes_folder_and_md() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let (id, folder) = create_event(root, "2024", "Vakantie: Spanje", "2024-07-01", None, None).unwrap();
        assert_eq!(folder, "2024/2024-07-01 Vakantie_ Spanje");
        let content = std::fs::read_to_string(root.join(&folder).join("_event.md")).unwrap();
        let parsed = crate::vault::frontmatter::parse(&content);
        assert_eq!(parsed.get_str("id").unwrap(), id);
        assert_eq!(parsed.get_str("title").unwrap(), "Vakantie: Spanje");
    }

    #[test]
    fn import_photo_copies_and_writes_item() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("2024/ev")).unwrap();
        // Nep-bronbestand buiten de vault.
        let src = tmp.path().join("Vakantie Foto.JPG");
        std::fs::write(&src, b"\xFF\xD8\xFF\xD9").unwrap();

        let id = import_photo(root, "2024/ev", &src).unwrap();

        // Precies één media + één .md in de eventmap.
        let entries: Vec<_> = std::fs::read_dir(root.join("2024/ev")).unwrap().collect();
        assert_eq!(entries.len(), 2);
        // Het .md verwijst naar het gekopieerde mediabestand en herleest correct.
        let md = std::fs::read_dir(root.join("2024/ev"))
            .unwrap()
            .filter_map(|e| e.ok())
            .find(|e| e.path().extension().and_then(|x| x.to_str()) == Some("md"))
            .unwrap();
        let content = std::fs::read_to_string(md.path()).unwrap();
        let parsed = crate::vault::frontmatter::parse(&content);
        assert_eq!(parsed.get_str("id").unwrap(), id);
        assert_eq!(parsed.get_str("type").unwrap(), "photo");
        let media = parsed.get_str("media").unwrap();
        assert!(media.ends_with(".jpg"));
        assert!(root.join("2024/ev").join(&media).exists());
    }

    #[test]
    fn import_photo_cleans_up_on_copy_failure() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("2024/ev")).unwrap();
        // Bron bestaat niet → kopie faalt; er mag geen half media-bestand blijven.
        let src = tmp.path().join("bestaat-niet.jpg");
        let res = import_photo(root, "2024/ev", &src);
        assert!(res.is_err(), "ontbrekende bron moet een fout geven");
        let leftovers: Vec<_> = std::fs::read_dir(root.join("2024/ev"))
            .unwrap()
            .filter_map(|e| e.ok())
            .collect();
        assert!(
            leftovers.is_empty(),
            "geen achtergebleven media/.md na een mislukte kopie, vond: {leftovers:?}"
        );
    }

    #[test]
    fn write_and_reparse_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("2024/ev")).unwrap();
        write_canvas(root, "2024/ev", &[item("a", 1.0, 2.0), item("b", 3.0, 4.0)]).unwrap();

        let content = std::fs::read_to_string(root.join("2024/ev/_canvas.json")).unwrap();
        let parsed = crate::vault::canvas::read_canvas(&content, "ev").unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].item_ref, "a");
        assert_eq!(parsed[1].x, 3.0);
    }
}
