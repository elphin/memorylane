//! Tests voor de media-pipeline met gegenereerde afbeeldingen (geen echte data).

use std::path::Path;

use image::{ImageReader, RgbImage};

use super::cache::{thumb_path, Tier};
use super::hash::{hash_bytes, hash_file};
use super::thumbs::{ensure_thumb, generate_jpeg};

/// Schrijft een gegenereerde JPEG van `w x h` naar `path`.
fn write_test_jpeg(path: &Path, w: u32, h: u32) {
    let img = RgbImage::from_fn(w, h, |x, y| {
        image::Rgb([(x % 256) as u8, (y % 256) as u8, 128])
    });
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    img.save(path).unwrap();
}

fn dimensions_of(bytes: &[u8]) -> (u32, u32) {
    let img = ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .unwrap()
        .decode()
        .unwrap();
    (img.width(), img.height())
}

#[test]
fn tier_max_dims_and_parsing() {
    assert_eq!(Tier::Micro.max_dim(), 64);
    assert_eq!(Tier::Small.max_dim(), 256);
    assert_eq!(Tier::Large.max_dim(), 1024);
    assert_eq!(Tier::Full.max_dim(), 2048);
    assert_eq!(Tier::parse("256"), Some(Tier::Small));
    assert_eq!(Tier::parse("999"), None);
}

#[test]
fn thumb_path_layout() {
    let p = thumb_path(Path::new("/cache"), "abcdef123", Tier::Small);
    let s = p.to_string_lossy().replace('\\', "/");
    assert!(s.ends_with("thumbs/ab/abcdef123_256.jpg"), "kreeg {s}");
}

#[test]
fn downscales_landscape_preserving_aspect() {
    let tmp = tempfile::tempdir().unwrap();
    let src = tmp.path().join("foto.jpg");
    write_test_jpeg(&src, 800, 400);

    let bytes = generate_jpeg(&src, 256).unwrap();
    let (w, h) = dimensions_of(&bytes);
    assert_eq!(w.max(h), 256, "lange zijde moet 256 zijn");
    assert_eq!(h, 128, "aspect 2:1 moet behouden blijven");
}

#[test]
fn does_not_upscale_small_source() {
    let tmp = tempfile::tempdir().unwrap();
    let src = tmp.path().join("klein.jpg");
    write_test_jpeg(&src, 40, 30);

    let bytes = generate_jpeg(&src, 256).unwrap();
    let (w, h) = dimensions_of(&bytes);
    assert_eq!((w, h), (40, 30), "kleine bron mag niet opgeschaald worden");
}

#[test]
fn ensure_thumb_creates_and_is_idempotent() {
    let tmp = tempfile::tempdir().unwrap();
    let src = tmp.path().join("foto.jpg");
    write_test_jpeg(&src, 600, 600);
    let cache = tmp.path().join("cache");
    let hash = hash_file(&src).unwrap();

    let p1 = ensure_thumb(&src, Tier::Micro, &cache, &hash).unwrap();
    assert!(p1.exists());
    let modified1 = std::fs::metadata(&p1).unwrap().modified().unwrap();

    // Tweede aanroep: cache-hit, zelfde pad, bestand niet opnieuw geschreven.
    let p2 = ensure_thumb(&src, Tier::Micro, &cache, &hash).unwrap();
    assert_eq!(p1, p2);
    let modified2 = std::fs::metadata(&p2).unwrap().modified().unwrap();
    assert_eq!(modified1, modified2, "cache-hit mag niet regenereren");

    let (w, h) = dimensions_of(&std::fs::read(&p1).unwrap());
    assert_eq!(w.max(h), 64);
}

#[test]
fn transparent_png_composites_on_white_not_black() {
    let tmp = tempfile::tempdir().unwrap();
    let src = tmp.path().join("transparant.png");
    // Volledig transparante pixels met RGB=0 (zou zwart worden zonder compositing).
    let img = image::RgbaImage::from_fn(64, 64, |_, _| image::Rgba([0, 0, 0, 0]));
    img.save(&src).unwrap();

    let bytes = generate_jpeg(&src, 64).unwrap();
    let decoded = ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .unwrap()
        .decode()
        .unwrap()
        .to_rgb8();
    let px = decoded.get_pixel(32, 32);
    assert!(
        px[0] > 240 && px[1] > 240 && px[2] > 240,
        "transparante pixel moet wit worden, kreeg {px:?}"
    );
}

#[test]
fn hash_is_content_addressed() {
    // Zelfde inhoud → zelfde hash; andere inhoud → andere hash.
    assert_eq!(hash_bytes(b"hallo"), hash_bytes(b"hallo"));
    assert_ne!(hash_bytes(b"hallo"), hash_bytes(b"wereld"));

    let tmp = tempfile::tempdir().unwrap();
    let a = tmp.path().join("a.jpg");
    let b = tmp.path().join("b.jpg");
    write_test_jpeg(&a, 100, 100);
    std::fs::copy(&a, &b).unwrap();
    // Identieke inhoud onder andere naam → identieke hash.
    assert_eq!(hash_file(&a).unwrap(), hash_file(&b).unwrap());
}
