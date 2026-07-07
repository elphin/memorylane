//! Thumbnail-generatie voor rasterafbeeldingen (JPEG/PNG/…).
//!
//! Past EXIF-oriëntatie toe (staande iPhone-foto's), schaalt naar de lange-zijde
//! van de tier met behoud van aspect, en encodeert als JPEG q85. HEIC wordt in
//! fase 3c toegevoegd (via een aparte decode-stap vóór dit pad).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use image::{DynamicImage, ImageDecoder, ImageReader, Rgb, RgbImage};

use super::cache::{self, Tier};

/// Bovengrens op brondimensies bij decode (DoS/OOM-bescherming). `image`'s
/// `Limits` begrenzen standaard alloc tot 512 MiB; hier ook de pixelmaten.
const MAX_SOURCE_DIM: u32 = 30000;

/// Teller voor unieke temp-bestandsnamen (voorkomt botsingen tussen threads).
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// Fout tijdens thumbnail-generatie (geconverteerd naar String aan de command-rand).
#[derive(Debug)]
pub struct ThumbError(pub String);

impl std::fmt::Display for ThumbError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}
impl std::error::Error for ThumbError {}
impl From<image::ImageError> for ThumbError {
    fn from(e: image::ImageError) -> Self {
        ThumbError(e.to_string())
    }
}
impl From<std::io::Error> for ThumbError {
    fn from(e: std::io::Error) -> Self {
        ThumbError(e.to_string())
    }
}

/// Zorgt dat de thumbnail voor `(hash, tier)` op schijf staat en geeft het pad
/// terug. Genereert alleen bij een cache-miss (idempotent, goedkoop bij hit).
pub fn ensure_thumb(
    src: &Path,
    tier: Tier,
    cache_root: &Path,
    hash: &str,
) -> Result<PathBuf, ThumbError> {
    let out = cache::thumb_path(cache_root, hash, tier);
    if out.exists() {
        return Ok(out);
    }
    let bytes = generate_jpeg(src, tier.max_dim())?;
    if let Some(parent) = out.parent() {
        fs::create_dir_all(parent)?;
    }
    // Atomair: schrijf naar een unieke temp + rename, zodat gelijktijdige
    // requests geen half geschreven bestand zien én elkaars temp niet raken.
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = out.with_extension(format!("tmp.{}.{seq}", std::process::id()));
    fs::write(&tmp, bytes)?;
    // rename overschrijft een bestaande `out` (winnaar-race is prima).
    fs::rename(&tmp, &out)?;
    Ok(out)
}

/// Decodeert `src`, past EXIF-oriëntatie toe, schaalt naar `max_dim` en geeft
/// JPEG-bytes terug.
pub fn generate_jpeg(src: &Path, max_dim: u32) -> Result<Vec<u8>, ThumbError> {
    let mut reader = ImageReader::open(src)?.with_guessed_format()?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_SOURCE_DIM);
    limits.max_image_height = Some(MAX_SOURCE_DIM);
    reader.limits(limits);

    let mut decoder = reader.into_decoder()?;
    let orientation = decoder
        .orientation()
        .unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut img = DynamicImage::from_decoder(decoder)?;
    img.apply_orientation(orientation);

    let img = downscale(img, max_dim);
    encode_jpeg(&img)
}

/// Schaalt naar de lange-zijde `max_dim` met behoud van aspect. Kleinere
/// bronnen worden nooit opgeschaald.
fn downscale(img: DynamicImage, max_dim: u32) -> DynamicImage {
    let (w, h) = (img.width(), img.height());
    let longest = w.max(h);
    if longest == 0 || longest <= max_dim {
        return img;
    }
    let scale = max_dim as f32 / longest as f32;
    let nw = ((w as f32 * scale).round() as u32).max(1);
    let nh = ((h as f32 * scale).round() as u32).max(1);
    img.resize(nw, nh, image::imageops::FilterType::Lanczos3)
}

fn encode_jpeg(img: &DynamicImage) -> Result<Vec<u8>, ThumbError> {
    // JPEG kent geen alpha; transparante bronnen (PNG) worden over wit
    // gecompositet i.p.v. het alfakanaal zwart weg te gooien.
    let rgb = if img.color().has_alpha() {
        composite_on_white(img)
    } else {
        img.to_rgb8()
    };
    let mut buf = Vec::new();
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 85);
    encoder.encode(
        rgb.as_raw(),
        rgb.width(),
        rgb.height(),
        image::ExtendedColorType::Rgb8,
    )?;
    Ok(buf)
}

/// Blendt een afbeelding met alfa over een witte achtergrond.
fn composite_on_white(img: &DynamicImage) -> RgbImage {
    let rgba = img.to_rgba8();
    let mut out = RgbImage::new(rgba.width(), rgba.height());
    for (x, y, px) in rgba.enumerate_pixels() {
        let a = px[3] as u32;
        let blend = |c: u8| ((c as u32 * a + 255 * (255 - a)) / 255) as u8;
        out.put_pixel(x, y, Rgb([blend(px[0]), blend(px[1]), blend(px[2])]));
    }
    out
}
