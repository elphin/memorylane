//! Range-berekening + content-type voor het `media://`-protocol: het originele
//! mediabestand streamen naar een `<video>`. Puur en unit-getest; het echte I/O
//! zit in `lib.rs`. Elke response is begrensd op [`MAX_SLICE`], zodat een grote
//! video NOOIT in één keer in het geheugen wordt geladen (Tauri kan de body niet
//! streamen, dus we serveren bewust in stukjes; de `<video>`-client vraagt de
//! rest via vervolg-Range-requests op).

/// Maximaal aantal bytes per response (8 MiB).
pub const MAX_SLICE: u64 = 8 * 1024 * 1024;

/// Welk stuk van het bestand deze request serveert.
#[derive(Debug, PartialEq, Eq)]
pub struct Slice {
    pub status: u16, // 200, 206 of 416
    pub start: u64,
    pub len: u64, // aantal bytes vanaf `start` (0 bij 416)
    pub total: u64,
    pub partial: bool, // true → stuur een `Content-Range`-header mee
}

/// Content-type uit een bestandsextensie (zonder punt).
pub fn content_type_for_ext(ext: &str) -> &'static str {
    match ext.to_ascii_lowercase().as_str() {
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "avi" => "video/x-msvideo",
        "ogv" => "video/ogg",
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "heic" | "heif" => "image/heic",
        "mp3" => "audio/mpeg",
        "m4a" | "aac" => "audio/mp4",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "flac" => "audio/flac",
        _ => "application/octet-stream",
    }
}

/// Bepaal het te serveren stuk op basis van de (optionele) `Range`-header.
pub fn plan_slice(range_header: Option<&str>, total: u64) -> Slice {
    if total == 0 {
        return Slice { status: 200, start: 0, len: 0, total: 0, partial: false };
    }
    let last = total - 1;
    match range_header.and_then(parse_range) {
        // Geen (geldige) Range: klein bestand → hele 200; groot → 206 met een
        // gecapt kopstuk zodat de client de rest via ranges ophaalt.
        None => {
            if total <= MAX_SLICE {
                Slice { status: 200, start: 0, len: total, total, partial: false }
            } else {
                Slice { status: 206, start: 0, len: MAX_SLICE, total, partial: true }
            }
        }
        Some(RawRange::FromTo(start, end_opt)) => {
            if start > last {
                return unsatisfiable(total); // 416
            }
            // `end` is INCLUSIEF; geklemd op het laatste byte.
            let end = end_opt.map(|e| e.min(last)).unwrap_or(last);
            if end < start {
                return unsatisfiable(total);
            }
            let len = (end - start + 1).min(MAX_SLICE);
            Slice { status: 206, start, len, total, partial: true }
        }
        Some(RawRange::Suffix(n)) => {
            if n == 0 {
                return unsatisfiable(total);
            }
            let start = total.saturating_sub(n); // laatste n bytes (of hele bestand)
            let len = (total - start).min(MAX_SLICE);
            Slice { status: 206, start, len, total, partial: true }
        }
    }
}

fn unsatisfiable(total: u64) -> Slice {
    Slice { status: 416, start: 0, len: 0, total, partial: false }
}

enum RawRange {
    FromTo(u64, Option<u64>),
    Suffix(u64),
}

/// Parse één `bytes=...`-range. Meerdere ranges (komma-gescheiden) worden niet
/// ondersteund; we pakken dan alleen de eerste.
fn parse_range(header: &str) -> Option<RawRange> {
    let spec = header.trim().strip_prefix("bytes=")?;
    let first = spec.split(',').next()?.trim();
    let (a, b) = first.split_once('-')?;
    let (a, b) = (a.trim(), b.trim());
    if a.is_empty() {
        Some(RawRange::Suffix(b.parse().ok()?)) // bytes=-N
    } else {
        let start: u64 = a.parse().ok()?;
        let end = if b.is_empty() { None } else { Some(b.parse().ok()?) };
        Some(RawRange::FromTo(start, end))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_range_small_is_full_200() {
        assert_eq!(plan_slice(None, 100), Slice { status: 200, start: 0, len: 100, total: 100, partial: false });
    }

    #[test]
    fn no_range_large_is_capped_206() {
        let total = 20 * 1024 * 1024;
        assert_eq!(plan_slice(None, total), Slice { status: 206, start: 0, len: MAX_SLICE, total, partial: true });
    }

    #[test]
    fn closed_range_is_inclusive() {
        // bytes=0-99 → 100 bytes (INCLUSIEF eind).
        assert_eq!(plan_slice(Some("bytes=0-99"), 1000), Slice { status: 206, start: 0, len: 100, total: 1000, partial: true });
        // bytes=0-0 → precies 1 byte.
        assert_eq!(plan_slice(Some("bytes=0-0"), 1000).len, 1);
    }

    #[test]
    fn open_ended_range_is_capped() {
        let total = 100 * 1024 * 1024;
        let s = plan_slice(Some("bytes=0-"), total);
        assert_eq!(s.status, 206);
        assert_eq!(s.start, 0);
        assert_eq!(s.len, MAX_SLICE);
        // Klein open-eind serveert tot het eind.
        assert_eq!(plan_slice(Some("bytes=500-"), 1000), Slice { status: 206, start: 500, len: 500, total: 1000, partial: true });
    }

    #[test]
    fn suffix_range() {
        assert_eq!(plan_slice(Some("bytes=-100"), 1000), Slice { status: 206, start: 900, len: 100, total: 1000, partial: true });
        // Groter dan het bestand → hele bestand.
        assert_eq!(plan_slice(Some("bytes=-5000"), 1000), Slice { status: 206, start: 0, len: 1000, total: 1000, partial: true });
    }

    #[test]
    fn unsatisfiable_returns_416() {
        assert_eq!(plan_slice(Some("bytes=1000-"), 1000).status, 416);
        assert_eq!(plan_slice(Some("bytes=2000-3000"), 1000).status, 416);
    }

    #[test]
    fn empty_file() {
        assert_eq!(plan_slice(Some("bytes=0-"), 0), Slice { status: 200, start: 0, len: 0, total: 0, partial: false });
    }

    #[test]
    fn garbage_range_falls_back_to_none() {
        // Niet-parseerbaar → behandeld als geen Range.
        assert_eq!(plan_slice(Some("rubbish"), 100).status, 200);
        assert_eq!(plan_slice(Some("bytes=abc-def"), 100).status, 200);
    }

    #[test]
    fn content_types() {
        assert_eq!(content_type_for_ext("MP4"), "video/mp4");
        assert_eq!(content_type_for_ext("mov"), "video/quicktime");
        assert_eq!(content_type_for_ext("webm"), "video/webm");
        assert_eq!(content_type_for_ext("xyz"), "application/octet-stream");
    }
}
