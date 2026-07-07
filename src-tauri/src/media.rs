//! Media-pipeline: thumbnails, content-hashing en (fase 3c/3d) HEIC/video.
//!
//! Thumbnails worden vooraf gegenereerd op schijf en via het `thumb://`-protocol
//! geserveerd — nooit door IPC. De cache-sleutel is een content-hash zodat
//! map-/bestandshernoemingen geen regeneratie-storm geven.

pub mod cache;
pub mod hash;
pub mod thumbs;

#[cfg(test)]
mod media_tests;
