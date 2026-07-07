//! Vault: de mappenstructuur op schijf is de bron van waarheid
//! (Obsidian-model). Deze module is strikt read-only tijdens indexeren;
//! schrijven gebeurt alleen via het expliciete schrijfpad (fase 8).

pub mod canvas;
pub mod frontmatter;
pub mod scanner;
pub mod writer;

pub use scanner::scan;

#[cfg(test)]
mod fixture_tests;
