//! Domeinmodel: de typen die de vault beschrijven en die (als JSON) naar de
//! webview gaan. Dit spiegelt het bestaande vault-formaat (`schema.ts`) zodat
//! bestaande vaults 1:1 leesbaar blijven.

use serde::{Deserialize, Serialize};

/// Itemtype, zoals in de item-frontmatter (`type:`) of afgeleid uit de extensie.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ItemType {
    Text,
    Photo,
    Video,
    Link,
    Audio,
}

impl ItemType {
    pub fn as_str(self) -> &'static str {
        match self {
            ItemType::Text => "text",
            ItemType::Photo => "photo",
            ItemType::Video => "video",
            ItemType::Link => "link",
            ItemType::Audio => "audio",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "text" => Some(ItemType::Text),
            "photo" => Some(ItemType::Photo),
            "video" => Some(ItemType::Video),
            "link" => Some(ItemType::Link),
            "audio" => Some(ItemType::Audio),
            _ => None,
        }
    }

    /// Leidt het mediatype af uit een bestandsextensie (zonder punt).
    /// Spiegelt `getItemTypeFromFilename` in `parser.ts`.
    pub fn from_extension(ext: &str) -> Option<Self> {
        match ext.to_ascii_lowercase().as_str() {
            "jpg" | "jpeg" | "png" | "gif" | "webp" | "heic" | "heif" | "avif" => {
                Some(ItemType::Photo)
            }
            "mp4" | "mov" | "avi" | "mkv" | "webm" => Some(ItemType::Video),
            "mp3" | "wav" | "ogg" | "m4a" | "aac" | "flac" => Some(ItemType::Audio),
            _ => None,
        }
    }
}

/// Soort tijdlijn-event. Years staan apart (`Year`); hier alleen `event`/`period`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EventKind {
    Event,
    Period,
}

impl EventKind {
    pub fn as_str(self) -> &'static str {
        match self {
            EventKind::Event => "event",
            EventKind::Period => "period",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "event" => Some(EventKind::Event),
            "period" => Some(EventKind::Period),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Location {
    pub lat: f64,
    pub lng: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// Een jaar (`_year.md`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Year {
    pub id: String,
    /// Numeriek jaartal, afgeleid uit de mapnaam (bijv. 1971).
    pub year: i32,
    pub title: String,
    pub start_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_at: Option<String>,
    pub folder_name: String,
    /// Vaste cover-foto voor de jaartegel (item-id) — override op willekeurig/featured.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover: Option<String>,
    /// Globale schaalfactor voor álle event-kaarten in dit jaar (proportioneel
    /// "passend maken"). None = 1.0 (geen schaling). Laat de individuele
    /// event-`size`-ratings intact.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size_factor: Option<f64>,
}

/// Een gebeurtenis (`_event.md`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub id: String,
    pub kind: EventKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub start_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<Location>,
    /// Slug of id van het item dat als uitgelichte foto dient.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub featured_photo: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    /// Belang/grootte van het event op de jaar-tijdlijn (1–100). None = standaard (50).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<i64>,
    /// "In aanbouw" (under construction): memory nog niet af. Afwezig = false.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub under_construction: Option<bool>,
    /// Id van het jaar waaronder dit event valt.
    pub year_id: String,
    /// Vault-relatief pad naar de eventmap (forward slashes).
    pub folder_path: String,
    /// True = synthetische "Losse foto's"-bundel (losse media direct in een jaarmap,
    /// géén eigen `_event.md`). Curatie (uitlichten/grootte) is er niet mogelijk.
    #[serde(default)]
    pub synthetic: bool,
}

/// Een item: een foto/tekst/video/link/audio (`<slug>.md`) of een synthetisch
/// item afgeleid van los mediabestand zonder eigen `.md`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub event_id: String,
    pub item_type: ItemType,
    /// Bestandsnaam van de media binnen de eventmap (foto/video/audio).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub caption: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub happened_at: Option<String>,
    /// Genormaliseerde tijdstempel (ms sinds epoch) uit `happened_at`; als die
    /// ontbreekt valt de scanner terug op de start van het event.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub place: Option<Location>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub people: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    /// Markdown-body (voor full-text search).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body_text: Option<String>,
    /// Slug = bestandsnaam zonder extensie; None voor synthetische items.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slug: Option<String>,
    /// True als afgeleid van los mediabestand (geen `.md` in de vault).
    pub synthetic: bool,
}

/// Layout van één item op het event-canvas (`_canvas.json`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasItem {
    pub event_id: String,
    /// Verwijzing naar een item: slug óf id (kan een UUID zijn).
    pub item_ref: String,
    pub x: f64,
    pub y: f64,
    pub scale: f64,
    pub rotation: f64,
    pub z_index: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_scale: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<f64>,
}

/// Ernst van een indexeringsprobleem — getoond in het fouten-paneel (fase 8).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    /// Data is (deels) niet leesbaar — vergt aandacht.
    Error,
    /// Afwijking die getolereerd is (bijv. duplicaat geskipt).
    Warning,
}

/// Een gelogd probleem tijdens het indexeren. Nooit stil: dit wordt zichtbaar
/// gemaakt in de UI zodat er geen onvindbaar dataverlies ontstaat.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexError {
    /// Vault-relatief pad (forward slashes).
    pub path: String,
    pub severity: Severity,
    pub reason: String,
}

/// Het volledige, in-memory resultaat van een vault-scan. De SQLite-index wordt
/// hieruit opgebouwd; dit model is de weggooibare cache-bron.
#[derive(Debug, Default)]
pub struct VaultModel {
    pub years: Vec<Year>,
    pub events: Vec<Event>,
    pub items: Vec<Item>,
    pub canvas_items: Vec<CanvasItem>,
    pub errors: Vec<IndexError>,
}
