//! Schrijfpad naar de vault. Tot nu toe was alles read-only; dit is de eerste
//! mutatie: de canvas-layout (`_canvas.json`) van een event persisteren als de
//! gebruiker items versleept. Schrijft in het v1-compatibele formaat.
//!
//! (Echo-suppressie voor de file-watcher komt in fase 9; er is nu nog geen
//! watcher, dus een directe schrijf is veilig.)

use std::path::Path;

use serde::Serialize;

use crate::model::CanvasItem;

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

/// Markdown voor een foto-item (`<slug>.md`) dat naar een mediabestand wijst.
pub fn photo_item_markdown(id: &str, media: &str, caption: Option<&str>) -> String {
    let now = now_iso();
    let mut fm = format!("---\nid: {id}\ntype: photo\nmedia: {}\n", yaml_str(media));
    if let Some(c) = caption {
        fm.push_str(&format!("caption: {}\n", yaml_str(c)));
    }
    fm.push_str(&format!("createdAt: {}\n", yaml_str(&now)));
    fm.push_str(&format!("updatedAt: {}\n", yaml_str(&now)));
    fm.push_str("---\n");
    fm
}

/// Markdown voor een event (`_event.md`).
pub fn event_markdown(id: &str, title: &str, start_at: &str) -> String {
    let now = now_iso();
    format!(
        "---\nid: {id}\ntype: event\ntitle: {}\nstartAt: {}\ncreatedAt: {}\nupdatedAt: {}\n---\n",
        yaml_str(title),
        yaml_str(start_at),
        yaml_str(&now),
        yaml_str(&now),
    )
}

// ---- Schrijf-operaties ---------------------------------------------------

fn write_atomic(path: &Path, content: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension(format!("tmp.{}", std::process::id()));
    std::fs::write(&tmp, content)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
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
) -> std::io::Result<(String, String)> {
    let id = uuid::Uuid::new_v4().to_string();
    let base_name = format!("{start_at} {}", sanitize_folder(title));
    let folder_path = unique_event_folder(vault_root, year_folder, &base_name, &id);
    let md = event_markdown(&id, title, start_at);
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

/// Importeert een foto: kopieert het bronbestand de eventmap in met een unieke
/// naam en schrijft een bijbehorend item-`.md`. Geeft het nieuwe item-id terug.
pub fn import_photo(
    vault_root: &Path,
    folder_path: &str,
    source: &Path,
) -> Result<String, String> {
    let ext = source
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_else(|| "jpg".to_string());
    let stem = source
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("foto");
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

    let md = photo_item_markdown(&id, &media, Some(stem));
    write_atomic(&dir.join(format!("{slug}.md")), &md).map_err(|e| e.to_string())?;
    Ok(id)
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
    fn bracket_title_roundtrips_via_frontmatter() {
        // `[done]` zou zonder quotes als flow-seq gelezen worden → titel weg.
        let md = event_markdown("id1", "[done]", "2024-07-01");
        let parsed = crate::vault::frontmatter::parse(&md);
        assert_eq!(parsed.get_str("title").unwrap(), "[done]");
        // Ook letterlijke quotes in een titel moeten overleven.
        let md2 = event_markdown("id2", "\"Zomer\"", "2024-07-01");
        let parsed2 = crate::vault::frontmatter::parse(&md2);
        assert_eq!(parsed2.get_str("title").unwrap(), "\"Zomer\"");
    }

    #[test]
    fn create_event_does_not_overwrite_existing_event() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let (id1, folder1) = create_event(root, "2024", "Verjaardag", "2024-07-01").unwrap();
        let (id2, folder2) = create_event(root, "2024", "Verjaardag", "2024-07-01").unwrap();
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
        let (id, folder) = create_event(root, "2024", "Vakantie: Spanje", "2024-07-01").unwrap();
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
