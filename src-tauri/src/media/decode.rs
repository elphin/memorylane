//! Externe decode-stap voor formaten die de `image`-crate niet leest: HEIC
//! (HEVC-in-HEIF, iPhone-foto's) en video (frame op ~1s). Gebruikt ffmpeg als
//! sidecar en levert een tijdelijke PNG die daarna door de gewone
//! thumbnail-pipeline gaat.
//!
//! ffmpeg wordt nu van `PATH` gehaald; bundeling (LGPL-build) is een
//! packaging-stap voor fase 10 — daarvoor hoeft alleen [`ffmpeg_bin`] te wijzigen.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use super::thumbs::ThumbError;

static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// Harde limiet op een ffmpeg-decode; voorkomt dat een kapotte/pathologische
/// video de begrensde worker-pool laat opdrogen.
const FFMPEG_TIMEOUT_SECS: u64 = 20;

/// RAII-guard: ruimt het tijdelijke decode-bestand op, ook bij een panic.
pub struct TempPng(PathBuf);

impl TempPng {
    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempPng {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Formaten die een externe decoder vereisen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExternalKind {
    Heic,
    Video,
}

/// Bepaalt of een extensie externe decoding nodig heeft.
pub fn classify(ext: &str) -> Option<ExternalKind> {
    match ext.to_ascii_lowercase().as_str() {
        "heic" | "heif" => Some(ExternalKind::Heic),
        "mp4" | "mov" | "avi" | "mkv" | "webm" | "m4v" => Some(ExternalKind::Video),
        _ => None,
    }
}

/// Naam/pad van de ffmpeg-binary (nu van PATH; later bundelbaar).
fn ffmpeg_bin() -> &'static str {
    "ffmpeg"
}

/// Of ffmpeg beschikbaar is (eenmalig gecheckt en gecachet).
pub fn ffmpeg_available() -> bool {
    static AVAILABLE: OnceLock<bool> = OnceLock::new();
    *AVAILABLE.get_or_init(|| {
        Command::new(ffmpeg_bin())
            .arg("-version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    })
}

/// Decodeert `src` naar een tijdelijke PNG en geeft een [`TempPng`]-guard terug
/// die het bestand bij drop (ook bij panic) opruimt.
pub fn decode_to_png(
    src: &Path,
    kind: ExternalKind,
    tmp_dir: &Path,
) -> Result<TempPng, ThumbError> {
    if !ffmpeg_available() {
        return Err(ThumbError("ffmpeg niet beschikbaar voor HEIC/video".into()));
    }
    std::fs::create_dir_all(tmp_dir).map_err(|e| ThumbError(e.to_string()))?;
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let out = tmp_dir.join(format!("decode.{}.{seq}.png", std::process::id()));

    let ok = match kind {
        // NB: ffmpeg bakt voor HEIF-stills de irot/imir-oriëntatie meestal in;
        // te verifiëren met een echte staande iPhone-HEIC (geen sample in de
        // testvault). Zo niet, dan hier expliciet de HEIF-oriëntatie toepassen.
        ExternalKind::Heic => run_ffmpeg_frame(src, &out, None),
        // Video: probeer een frame op 1s; val terug op het eerste frame als de
        // clip korter is (seek voorbij EOF geeft exit 0 zónder output).
        ExternalKind::Video => {
            run_ffmpeg_frame(src, &out, Some(1.0)) || run_ffmpeg_frame(src, &out, Some(0.0))
        }
    };

    if ok {
        Ok(TempPng(out))
    } else {
        let _ = std::fs::remove_file(&out);
        Err(ThumbError(format!(
            "ffmpeg kon {} niet decoderen",
            src.display()
        )))
    }
}

/// Draait ffmpeg om één frame naar `out` (PNG) te schrijven, met timeout+kill.
/// `seek` (seconden) wordt vóór de input geplaatst voor snelle seek; autorotate
/// staat default aan. Geeft alleen `true` als het proces slaagde ÉN er een
/// niet-leeg outputbestand is (ffmpeg geeft bij seek voorbij EOF exit 0 zonder
/// bestand te schrijven).
fn run_ffmpeg_frame(src: &Path, out: &Path, seek: Option<f64>) -> bool {
    let mut cmd = Command::new(ffmpeg_bin());
    cmd.arg("-y").args(["-loglevel", "error"]);
    if let Some(s) = seek {
        cmd.args(["-ss", &format!("{s}")]);
    }
    cmd.arg("-i")
        .arg(src)
        .args(["-frames:v", "1", "-update", "1", "-f", "image2"])
        .arg(out)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(_) => return false,
    };
    let deadline = Instant::now() + Duration::from_secs(FFMPEG_TIMEOUT_SECS);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return false;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => return false,
        }
    };

    status.success() && out.metadata().map(|m| m.len() > 0).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_covers_heic_and_video() {
        assert_eq!(classify("heic"), Some(ExternalKind::Heic));
        assert_eq!(classify("HEIF"), Some(ExternalKind::Heic));
        assert_eq!(classify("mov"), Some(ExternalKind::Video));
        assert_eq!(classify("mp4"), Some(ExternalKind::Video));
        assert_eq!(classify("jpg"), None);
        assert_eq!(classify("png"), None);
    }
}
