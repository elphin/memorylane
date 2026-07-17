//! Vault: de mappenstructuur op schijf is de bron van waarheid
//! (Obsidian-model). Deze module is strikt read-only tijdens indexeren;
//! schrijven gebeurt alleen via het expliciete schrijfpad (fase 8).

pub mod canvas;
pub mod frontmatter;
pub mod materialize;
pub mod scanner;
pub mod writer;

pub use materialize::{materialize_missing, MaterializationReport};
pub use scanner::scan;

#[cfg(test)]
mod fixture_tests;
