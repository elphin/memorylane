//! Reader voor `_canvas.json` — de layout van items op het event-canvas.
//!
//! Tolerant conform het plan: `itemSlug` kan een UUID zijn; `viewport`/
//! `updatedAt` zijn optioneel; `textScale`/`width`/`height` mogen `null` zijn;
//! dangling verwijzingen worden pas bij het koppelen (scanner) afgehandeld.

use serde::Deserialize;

use crate::model::CanvasItem;

#[derive(Debug, Deserialize)]
struct CanvasFile {
    #[serde(default)]
    items: Vec<CanvasEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CanvasEntry {
    #[serde(default)]
    item_slug: String,
    #[serde(default)]
    x: f64,
    #[serde(default)]
    y: f64,
    #[serde(default = "one")]
    scale: f64,
    #[serde(default)]
    rotation: f64,
    #[serde(default)]
    z_index: i64,
    #[serde(default)]
    text_scale: Option<f64>,
    #[serde(default)]
    width: Option<f64>,
    #[serde(default)]
    height: Option<f64>,
}

fn one() -> f64 {
    1.0
}

/// Parseert `_canvas.json` naar canvas-items voor een event. Bij een JSON-fout
/// geeft dit `Err(reden)` terug zodat de scanner het als indexfout kan loggen.
pub fn read_canvas(content: &str, event_id: &str) -> Result<Vec<CanvasItem>, String> {
    let file: CanvasFile =
        serde_json::from_str(content).map_err(|e| format!("ongeldige _canvas.json: {e}"))?;

    let items = file
        .items
        .into_iter()
        .filter(|e| !e.item_slug.trim().is_empty())
        .map(|e| CanvasItem {
            event_id: event_id.to_string(),
            item_ref: e.item_slug,
            x: e.x,
            y: e.y,
            scale: e.scale,
            rotation: e.rotation,
            z_index: e.z_index,
            text_scale: e.text_scale,
            width: e.width,
            height: e.height,
        })
        .collect();

    Ok(items)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_canvas_with_uuid_slug_and_nulls() {
        let json = r#"{
            "version": 1,
            "items": [
                { "itemSlug": "981eba95-93bb-4ca6-9bd0-ec9127474f8a", "x": -460, "y": 0,
                  "scale": 1, "rotation": 0, "zIndex": 0,
                  "textScale": null, "width": null, "height": null },
                { "itemSlug": "40caa2a9-3777-4491-bc71-ac9e429242bf", "x": 292.1, "y": -440.8,
                  "scale": 1, "rotation": 0, "zIndex": 0,
                  "textScale": null, "width": 200, "height": 150 }
            ],
            "viewport": { "centerX": 0, "centerY": 0, "zoom": 1 },
            "updatedAt": "2025-12-23T22:00:00.000Z"
        }"#;
        let items = read_canvas(json, "event-1").unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].item_ref, "981eba95-93bb-4ca6-9bd0-ec9127474f8a");
        assert_eq!(items[0].width, None);
        assert_eq!(items[1].width, Some(200.0));
        assert_eq!(items[1].event_id, "event-1");
    }

    #[test]
    fn missing_fields_use_defaults() {
        let items = read_canvas(r#"{"items":[{"itemSlug":"a"}]}"#, "e").unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].scale, 1.0);
        assert_eq!(items[0].z_index, 0);
    }

    #[test]
    fn empty_slug_is_skipped() {
        let items = read_canvas(r#"{"items":[{"itemSlug":""},{"itemSlug":"ok"}]}"#, "e").unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].item_ref, "ok");
    }

    #[test]
    fn invalid_json_is_error() {
        assert!(read_canvas("{not json", "e").is_err());
    }

    #[test]
    fn missing_items_array_is_ok() {
        let items = read_canvas(r#"{"version":1}"#, "e").unwrap();
        assert!(items.is_empty());
    }
}
