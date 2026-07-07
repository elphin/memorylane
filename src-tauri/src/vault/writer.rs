//! Schrijfpad naar de vault. Tot nu toe was alles read-only; dit is de eerste
//! mutatie: de canvas-layout (`_canvas.json`) van een event persisteren als de
//! gebruiker items versleept. Schrijft in het v1-compatibele formaat.
//!
//! (Echo-suppressie voor de file-watcher komt in fase 9; er is nu nog geen
//! watcher, dus een directe schrijf is veilig.)

use std::path::Path;

use serde::Serialize;

use crate::model::CanvasItem;

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
