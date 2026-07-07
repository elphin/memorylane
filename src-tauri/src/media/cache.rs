//! Cache-paden voor gegenereerde thumbnails.
//!
//! Layout: `<cache_root>/thumbs/<hash[0:2]>/<hash>_<tier>.jpg`. De hash-prefix
//! als submap voorkomt mappen met tienduizenden bestanden. De cache staat in
//! `app_cache_dir`, nooit in de vault, en is volledig wegwerpbaar.

use std::path::{Path, PathBuf};

/// Thumbnail-formaten. De waarden zijn de maximale lange-zijde in pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tier {
    /// L0/L1 densiteit & collage-vulling.
    Micro,
    /// L1/L2 kaarten.
    Small,
    /// L2 grote weergave.
    Large,
    /// L3 focus (scherp op 4K).
    Full,
}

impl Tier {
    pub fn max_dim(self) -> u32 {
        match self {
            Tier::Micro => 64,
            Tier::Small => 256,
            Tier::Large => 1024,
            Tier::Full => 2048,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Tier::Micro => "64",
            Tier::Small => "256",
            Tier::Large => "1024",
            Tier::Full => "2048",
        }
    }

    /// Parseert een tier uit de query-parameter van een `thumb://`-URL.
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "64" => Some(Tier::Micro),
            "256" => Some(Tier::Small),
            "1024" => Some(Tier::Large),
            "2048" => Some(Tier::Full),
            _ => None,
        }
    }
}

/// Pad naar het thumbnail-bestand voor een gegeven content-hash + tier.
pub fn thumb_path(cache_root: &Path, hash: &str, tier: Tier) -> PathBuf {
    let prefix = &hash[..hash.len().min(2)];
    cache_root
        .join("thumbs")
        .join(prefix)
        .join(format!("{hash}_{}.jpg", tier.as_str()))
}
