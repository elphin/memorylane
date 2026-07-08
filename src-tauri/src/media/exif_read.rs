//! Leest een curated set ingebedde EXIF-velden uit een fotobestand, voor de
//! read-only weergave in de metadata-UI. Tolerant: bij een onleesbaar bestand of
//! ontbrekende EXIF komt er gewoon een lege lijst terug (nooit een fout).

use std::path::Path;

use exif::{In, Tag};

/// Leest de belangrijkste EXIF-velden als (label, waarde)-paren. Lege lijst als
/// er geen (leesbare) EXIF is.
pub fn read_exif(path: &Path) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let Ok(file) = std::fs::File::open(path) else {
        return out;
    };
    let mut reader = std::io::BufReader::new(file);
    let Ok(exif) = exif::Reader::new().read_from_container(&mut reader) else {
        return out;
    };

    // Scalar-veld als weergavestring (met eenheid waar zinvol), getrimd.
    let field = |tag: Tag| {
        exif.get_field(tag, In::PRIMARY)
            .map(|f| trim_q(&f.display_value().with_unit(&exif).to_string()))
            .filter(|s| !s.is_empty())
    };

    if let Some(v) = field(Tag::DateTimeOriginal) {
        out.push(("Genomen op".into(), v));
    }

    // Camera = merk + model (samengevoegd).
    let make = field(Tag::Make);
    let model = field(Tag::Model);
    let camera = match (make, model) {
        (Some(a), Some(b)) => Some(format!("{a} {b}")),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    };
    if let Some(c) = camera {
        out.push(("Camera".into(), c));
    }
    if let Some(v) = field(Tag::LensModel) {
        out.push(("Lens".into(), v));
    }
    if let Some(v) = field(Tag::FNumber) {
        out.push(("Diafragma".into(), v));
    }
    if let Some(v) = field(Tag::ExposureTime) {
        out.push(("Sluitertijd".into(), v));
    }
    if let Some(v) = field(Tag::PhotographicSensitivity) {
        out.push(("ISO".into(), v));
    }
    if let Some(v) = field(Tag::FocalLength) {
        out.push(("Brandpuntsafstand".into(), v));
    }

    let w = field(Tag::PixelXDimension);
    let h = field(Tag::PixelYDimension);
    if let (Some(w), Some(h)) = (w, h) {
        out.push(("Afmeting".into(), format!("{w} × {h}")));
    }

    let lat = field(Tag::GPSLatitude);
    let lng = field(Tag::GPSLongitude);
    if let (Some(la), Some(lo)) = (lat, lng) {
        out.push(("Locatie (GPS)".into(), format!("{la}, {lo}")));
    }

    out
}

/// Strip omringende quotes die `display_value` soms om ASCII-strings zet.
fn trim_q(s: &str) -> String {
    s.trim().trim_matches('"').trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_yields_empty() {
        assert!(read_exif(std::path::Path::new("bestaat-niet.jpg")).is_empty());
    }

    #[test]
    fn image_without_exif_yields_empty() {
        // Een kale PNG zonder EXIF → geen velden, geen fout (tolerant).
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("plain.png");
        image::RgbImage::from_fn(8, 8, |_, _| image::Rgb([10u8, 20, 30]))
            .save(&p)
            .unwrap();
        assert!(read_exif(&p).is_empty());
    }
}
