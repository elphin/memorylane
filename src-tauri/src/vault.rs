//! Vault: de mappenstructuur op schijf is de bron van waarheid
//! (Obsidian-model). Deze module is strikt read-only tijdens indexeren;
//! schrijven gebeurt alleen via het expliciete schrijfpad (fase 8).
//!
//! Fase 1 implementeert hier: scanner, frontmatter-parser
//! (strikt + lenient fallback), `_canvas.json`-reader, ignore-regels
//! (`.memorylane/`, verborgen mappen, `index.db`, `_`-prefix = special).
