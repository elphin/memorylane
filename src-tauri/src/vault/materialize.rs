//! Materialisatie-pass: maakt ontbrekende `_year.md` / `_event.md` aan zodat elke
//! jaar-/memory-map zelf-beschrijvend wordt. Draait VÓÓR de (read-only) scan bij een
//! expliciete index-actie (vault kiezen / "opnieuw indexeren") — niet bij elke
//! na-edit rescan of de stille opstart-index, zodat de app niet ongevraagd bij elke
//! start in de vault schrijft.
//!
//! Eigenschappen:
//! - **Idempotent**: maakt alleen ontbrekende bestanden aan, overschrijft nooit.
//! - **Best-effort**: schrijffouten (read-only map, permissies) worden verzameld in
//!   het rapport en laten de index NOOIT crashen.
//! - Losse foto's direct in een jaarmap worden NIET gematerialiseerd (dat zou de
//!   jaarmap zelf tot memory maken); ze worden alleen gerapporteerd.

use std::path::Path;

use serde::Serialize;

use crate::vault::scanner::{
    is_ignored_dir, is_media_file, is_special, is_year_folder, rel_path, sorted_dir,
};
use crate::vault::writer::{ensure_event_md, ensure_year_md};

/// Een jaarmap met losse foto's die (nog) niet in een memory zitten.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LooseFolder {
    pub folder: String,
    pub count: usize,
}

/// Een map die niet gematerialiseerd kon worden (bijv. read-only).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MaterializeError {
    pub folder: String,
    pub reason: String,
}

/// Wat de materialisatie-pass deed/tegenkwam — voor een overzicht aan de gebruiker.
#[derive(Debug, Default, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MaterializationReport {
    pub years_created: usize,
    pub events_created: usize,
    pub loose_photo_folders: Vec<LooseFolder>,
    pub errors: Vec<MaterializeError>,
}

/// Loop de vault door en maak ontbrekende `_year.md` / `_event.md` aan. Geeft altijd
/// een rapport terug (nooit een fout — problemen komen in `report.errors`).
pub fn materialize_missing(root: &Path) -> MaterializationReport {
    let mut report = MaterializationReport::default();

    let entries = match sorted_dir(root) {
        Ok(e) => e,
        Err(e) => {
            report.errors.push(MaterializeError {
                folder: String::new(),
                reason: format!("kan vault-root niet lezen: {e}"),
            });
            return report;
        }
    };

    for entry in entries {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if is_ignored_dir(&name) || !is_year_folder(&name) {
            continue;
        }
        materialize_year(root, &path, &name, &mut report);
    }

    report
}

fn materialize_year(
    root: &Path,
    year_path: &Path,
    year_name: &str,
    report: &mut MaterializationReport,
) {
    // Ontbrekende _year.md aanmaken (idempotent).
    match ensure_year_md(root, year_name) {
        Ok(true) => report.years_created += 1,
        Ok(false) => {}
        Err(e) => report.errors.push(MaterializeError {
            folder: year_name.to_string(),
            reason: format!("kan _year.md niet aanmaken: {e}"),
        }),
    }

    let entries = match sorted_dir(year_path) {
        Ok(e) => e,
        Err(e) => {
            report.errors.push(MaterializeError {
                folder: rel_path(root, year_path),
                reason: format!("kan jaarmap niet lezen: {e}"),
            });
            return;
        }
    };

    let mut loose = 0usize;
    for entry in entries {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if path.is_dir() {
            // Elke niet-genegeerde submap = een memory (exact zoals de scanner:
            // `_`-prefix-mappen tellen dus óók mee, geen is_special-filter hier).
            if is_ignored_dir(&name) {
                continue;
            }
            let folder_path = rel_path(root, &path);
            match ensure_event_md(root, &folder_path) {
                Ok(true) => report.events_created += 1,
                Ok(false) => {}
                Err(e) => report.errors.push(MaterializeError {
                    folder: folder_path,
                    reason: format!("kan _event.md niet aanmaken: {e}"),
                }),
            }
        } else if !is_special(&name) && is_media_file(&name) {
            // Losse foto direct in de jaarmap → niet materialiseren (blijft de
            // synthetische "Losse foto's"-bundel), alleen tellen voor het overzicht.
            loose += 1;
        }
    }
    if loose > 0 {
        report.loose_photo_folders.push(LooseFolder {
            folder: rel_path(root, year_path),
            count: loose,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn materializes_missing_year_and_event_files_idempotently() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("2024/2024-08-01 strand")).unwrap();
        std::fs::write(root.join("2024/2024-08-01 strand/foto.jpg"), b"x").unwrap();
        std::fs::create_dir_all(root.join("2023/reis")).unwrap();

        let r1 = materialize_missing(root);
        assert_eq!(r1.years_created, 2, "twee jaarmappen kregen _year.md");
        assert_eq!(r1.events_created, 2, "twee memory-mappen kregen _event.md");
        assert!(r1.errors.is_empty());
        assert!(root.join("2024/_year.md").exists());
        assert!(root.join("2024/2024-08-01 strand/_event.md").exists());
        assert!(root.join("2023/reis/_event.md").exists());

        // Idempotent: tweede keer maakt niets aan.
        let r2 = materialize_missing(root);
        assert_eq!(r2.years_created, 0);
        assert_eq!(r2.events_created, 0);
        assert!(r2.errors.is_empty());
    }

    #[test]
    fn reports_loose_photos_in_year_folder_without_materializing() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("2024")).unwrap();
        std::fs::write(root.join("2024/a.jpg"), b"x").unwrap();
        std::fs::write(root.join("2024/b.png"), b"x").unwrap();

        let r = materialize_missing(root);
        assert_eq!(r.years_created, 1);
        assert_eq!(r.events_created, 0, "losse foto's worden geen event");
        assert_eq!(r.loose_photo_folders.len(), 1);
        assert_eq!(r.loose_photo_folders[0].folder, "2024");
        assert_eq!(r.loose_photo_folders[0].count, 2);
        // Geen _event.md op jaarniveau.
        assert!(!root.join("2024/_event.md").exists());
    }

    #[test]
    fn skips_hidden_and_dot_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("2024/.git")).unwrap();
        std::fs::create_dir_all(root.join(".memorylane")).unwrap();
        std::fs::create_dir_all(root.join("niet-een-jaar")).unwrap();

        let r = materialize_missing(root);
        assert_eq!(r.years_created, 1, "alleen 2024 telt");
        assert_eq!(r.events_created, 0, ".git-submap wordt genegeerd");
        assert!(!root.join("2024/.git/_event.md").exists());
        assert!(!root.join("niet-een-jaar/_year.md").exists());
    }
}
