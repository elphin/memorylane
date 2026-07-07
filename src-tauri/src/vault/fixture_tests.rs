//! Integratietests voor de scanner met volledig **synthetische** fixture-vaults
//! (geen echte persoonlijke data). Dekt de structuur van de echte vault plus de
//! rot-cases uit het rebuild-plan.

use std::fs;
use std::path::Path;

use crate::model::{ItemType, Severity};
use crate::vault::scan;

/// Bouwt een fixture-vault in een tijdelijke map.
fn write(root: &Path, rel: &str, content: &str) {
    let path = root.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
}

/// 1x1 witte JPEG (minimale geldige bytes zijn niet nodig — de scanner leest de
/// media niet, alleen de aanwezigheid telt).
fn write_media(root: &Path, rel: &str) {
    let path = root.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, b"\xFF\xD8\xFF\xD9").unwrap();
}

#[test]
fn scans_basic_year_event_item_structure() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();

    write(
        root,
        "2024/_year.md",
        "---\nid: year-2024\ntype: year\ntitle: \"2024\"\nstartAt: 2024-01-01\n---\n",
    );
    write(
        root,
        "2024/2024-11-23 palermo/_event.md",
        "---\nid: ev-palermo\ntype: event\ntitle: Palermo\nstartAt: 2024-11-23\n---\n",
    );
    write(
        root,
        "2024/2024-11-23 palermo/strand.md",
        "---\nid: it-strand\ntype: photo\nmedia: strand.jpg\ncaption: Strand\nhappenedAt: 2024-11-23\n---\n",
    );
    write_media(root, "2024/2024-11-23 palermo/strand.jpg");

    let model = scan(root);

    assert_eq!(model.years.len(), 1);
    assert_eq!(model.years[0].year, 2024);
    assert_eq!(model.events.len(), 1);
    assert_eq!(model.events[0].id, "ev-palermo");
    assert_eq!(model.events[0].year_id, "year-2024");
    assert_eq!(model.items.len(), 1);
    assert_eq!(model.items[0].id, "it-strand");
    assert_eq!(model.items[0].item_type, ItemType::Photo);
    assert!(!model.items[0].synthetic);
    assert!(model.items[0].timestamp_ms.is_some());
}

#[test]
fn dedupes_duplicate_item_markdowns_for_same_media() {
    // v1-bug in het wild: twee .md's, zelfde media, verschillende ids.
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();

    write(root, "1969/_year.md", "---\nid: y69\ntype: year\ntitle: \"1969\"\nstartAt: 1969-01-01\n---\n");
    let ev = "1969/1969-07-01 Jim geboren";
    write(root, &format!("{ev}/_event.md"), "---\nid: ev69\ntype: event\ntitle: Jim geboren\nstartAt: 1969-07-01\n---\n");
    // Rijk record (caption + happenedAt) — moet winnen.
    write(
        root,
        &format!("{ev}/jim-geboren.md"),
        "---\nid: rich\ntype: photo\nmedia: jim-geboren_66586b1f.jpg\ncaption: Jim geboren\nhappenedAt: 1969-07-01\ncreatedAt: \"2025-12-23T21:27:59.407Z\"\n---\n",
    );
    // Arm duplicaat (alleen caption), nieuwere createdAt en langere slug.
    write(
        root,
        &format!("{ev}/jim-geboren66586b1f.md"),
        "---\nid: poor\ntype: photo\nmedia: jim-geboren_66586b1f.jpg\ncaption: jim geboren 66586b1f\ncreatedAt: \"2025-12-27T09:49:53.377Z\"\n---\n",
    );
    write_media(root, &format!("{ev}/jim-geboren_66586b1f.jpg"));

    let model = scan(root);

    // Slechts één item overleeft; het rijke record wint.
    assert_eq!(model.items.len(), 1);
    assert_eq!(model.items[0].id, "rich");
    // Duplicaat is als warning gelogd, niet stil.
    assert!(model
        .errors
        .iter()
        .any(|e| e.severity == Severity::Warning && e.reason.contains("duplicaat")));
}

#[test]
fn dedupe_remaps_canvas_reference_to_winner() {
    // Reproductie van de echte 'palermo'-case: canvas verwijst naar het
    // duplicaat dat gededupliceerd wordt; de link moet naar de winnaar hangen.
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    write(root, "2024/_year.md", "---\nid: y24\ntype: year\ntitle: \"2024\"\nstartAt: 2024-01-01\n---\n");
    let ev = "2024/2024-11-23 palermo";
    write(root, &format!("{ev}/_event.md"), "---\nid: evp\ntype: event\ntitle: Palermo\nstartAt: 2024-11-23\n---\n");
    // Rijke winnaar (schone slug 'palermo').
    write(
        root,
        &format!("{ev}/palermo.md"),
        "---\nid: rich\ntype: photo\nmedia: palermo_92d6f09f.jpg\ncaption: Palermo\nhappenedAt: 2024-11-23\ncreatedAt: \"2025-12-23T10:00:00.000Z\"\n---\n\nMooie reis.\n",
    );
    // Arm duplicaat (lange slug) — dit is waar het canvas naar wijst.
    write(
        root,
        &format!("{ev}/palermo92d6f09f.md"),
        "---\nid: poor\ntype: photo\nmedia: palermo_92d6f09f.jpg\ncaption: palermo\ncreatedAt: \"2025-12-27T10:00:00.000Z\"\n---\n",
    );
    write_media(root, &format!("{ev}/palermo_92d6f09f.jpg"));
    write(
        root,
        &format!("{ev}/_canvas.json"),
        r#"{"version":1,"items":[
            {"itemSlug":"palermo92d6f09f","x":0,"y":0,"scale":1,"rotation":0,"zIndex":0},
            {"itemSlug":"palermo92d6f09f","x":100,"y":50,"scale":1,"rotation":0,"zIndex":1}
        ]}"#,
    );

    let model = scan(root);

    // Winnaar overleeft.
    assert_eq!(model.items.len(), 1);
    assert_eq!(model.items[0].slug.as_deref(), Some("palermo"));
    // Beide canvas-plaatsingen wijzen nu naar de winnaar-slug, niet naar het
    // gedropte duplicaat.
    assert_eq!(model.canvas_items.len(), 2);
    assert!(
        model.canvas_items.iter().all(|c| c.item_ref == "palermo"),
        "canvas-refs niet omgehangen: {:?}",
        model.canvas_items.iter().map(|c| &c.item_ref).collect::<Vec<_>>()
    );
}

#[test]
fn unterminated_frontmatter_is_logged() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    write(root, "2024/_year.md", "---\nid: y24\ntype: year\ntitle: \"2024\"\nstartAt: 2024-01-01\n---\n");
    let ev = "2024/2024-05-01 kapot";
    write(root, &format!("{ev}/_event.md"), "---\nid: evk\ntype: event\ntitle: Kapot\nstartAt: 2024-05-01\n---\n");
    // Item met openende fence zonder sluiter.
    write(
        root,
        &format!("{ev}/corrupt.md"),
        "---\nid: c1\ntype: photo\nmedia: foto.jpg\ncaption: dit sluit niet af\n",
    );
    write_media(root, &format!("{ev}/foto.jpg"));

    let model = scan(root);
    assert!(
        model
            .errors
            .iter()
            .any(|e| e.severity == Severity::Warning && e.reason.contains("niet afgesloten")),
        "onafgesloten frontmatter niet gelogd: {:?}",
        model.errors
    );
}

#[test]
fn loose_media_becomes_synthetic_item_with_stable_id() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    write(root, "2023/_year.md", "---\nid: y23\ntype: year\ntitle: \"2023\"\nstartAt: 2023-01-01\n---\n");
    let ev = "2023/2023-04-23 strand";
    write(root, &format!("{ev}/_event.md"), "---\nid: ev23\ntype: event\ntitle: Strand\nstartAt: 2023-04-23\n---\n");
    write_media(root, &format!("{ev}/losse-foto.jpg"));

    let model1 = scan(root);
    assert_eq!(model1.items.len(), 1);
    assert!(model1.items[0].synthetic);
    assert_eq!(model1.items[0].item_type, ItemType::Photo);
    let id1 = model1.items[0].id.clone();

    // Stabiel over een tweede scan heen.
    let model2 = scan(root);
    assert_eq!(model2.items[0].id, id1);
}

#[test]
fn underscore_files_are_never_items() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    write(root, "2025/_year.md", "---\nid: y25\ntype: year\ntitle: \"2025\"\nstartAt: 2025-01-01\n---\n");
    let ev = "2025/2025-07-01 jarig";
    write(root, &format!("{ev}/_event.md"), "---\nid: ev25\ntype: event\ntitle: Jarig\nstartAt: 2025-07-01\n---\n");
    // Custom featured-foto (v2 special) — mag geen item worden.
    write_media(root, &format!("{ev}/_featured.jpg"));

    let model = scan(root);
    assert_eq!(model.items.len(), 0, "_featured.jpg mag geen item zijn");
}

#[test]
fn year_folder_without_year_md_is_synthesized() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    // Geen _year.md (zoals 1969 in de echte vault).
    let ev = "1969/1969-07-01 Jim geboren";
    write(root, &format!("{ev}/_event.md"), "---\nid: ev69\ntype: event\ntitle: Jim geboren\nstartAt: 1969-07-01\n---\n");

    let model = scan(root);
    assert_eq!(model.years.len(), 1);
    assert_eq!(model.years[0].year, 1969);
    assert_eq!(model.years[0].title, "1969");
    assert_eq!(model.events.len(), 1);
}

#[test]
fn event_without_event_md_is_inferred_from_folder() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    write(root, "2022/_year.md", "---\nid: y22\ntype: year\ntitle: \"2022\"\nstartAt: 2022-01-01\n---\n");
    let ev = "2022/2022-09-13 Test item in 2022";
    write_media(root, &format!("{ev}/foto.jpg"));

    let model = scan(root);
    assert_eq!(model.events.len(), 1);
    assert_eq!(model.events[0].title.as_deref(), Some("Test item in 2022"));
    assert_eq!(model.events[0].start_at, "2022-09-13");
    // Losse foto → synthetisch item.
    assert_eq!(model.items.len(), 1);
    assert!(model.items[0].synthetic);
}

#[test]
fn canvas_json_is_linked_to_event() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    write(root, "2024/_year.md", "---\nid: y24\ntype: year\ntitle: \"2024\"\nstartAt: 2024-01-01\n---\n");
    let ev = "2024/2024-01-01 canvas";
    write(root, &format!("{ev}/_event.md"), "---\nid: evc\ntype: event\ntitle: Canvas\nstartAt: 2024-01-01\n---\n");
    write(
        root,
        &format!("{ev}/_canvas.json"),
        r#"{"version":1,"items":[{"itemSlug":"981eba95-uuid","x":-460,"y":0,"scale":1,"rotation":0,"zIndex":0}]}"#,
    );

    let model = scan(root);
    assert_eq!(model.canvas_items.len(), 1);
    assert_eq!(model.canvas_items[0].event_id, "evc");
    assert_eq!(model.canvas_items[0].item_ref, "981eba95-uuid");
}

#[test]
fn ignores_hidden_dirs_and_index_db() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    write(root, "2024/_year.md", "---\nid: y24\ntype: year\ntitle: \"2024\"\nstartAt: 2024-01-01\n---\n");
    write(root, ".memorylane/settings.json", "{}");
    fs::write(root.join("index.db"), b"binary").unwrap();

    let model = scan(root);
    assert_eq!(model.years.len(), 1);
    // Geen fouten door index.db of .memorylane.
    assert!(model.errors.is_empty(), "onverwachte fouten: {:?}", model.errors);
}

/// Lokale smoke-test tegen een echte vault (niet in CI). Draai met:
/// `MEMORYLANE_SMOKE_VAULT=L:\Jim\MemoryLane cargo test smoke_real_vault -- --ignored --nocapture`
#[test]
#[ignore = "vereist MEMORYLANE_SMOKE_VAULT env var; alleen lokaal"]
fn smoke_real_vault() {
    let Ok(path) = std::env::var("MEMORYLANE_SMOKE_VAULT") else {
        return;
    };
    let model = scan(Path::new(&path));
    eprintln!(
        "SMOKE: {} jaren, {} events, {} items ({} synthetisch), {} canvas-items, {} fouten",
        model.years.len(),
        model.events.len(),
        model.items.len(),
        model.items.iter().filter(|i| i.synthetic).count(),
        model.canvas_items.len(),
        model.errors.len(),
    );
    for e in model.errors.iter().take(20) {
        eprintln!("  [{:?}] {} — {}", e.severity, e.path, e.reason);
    }
    // Sanity: er is minstens één jaar en het scannen crasht niet.
    assert!(!model.years.is_empty(), "verwacht minstens één jaar in de vault");
}

#[test]
fn text_item_without_media_is_kept() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    write(root, "2024/_year.md", "---\nid: y24\ntype: year\ntitle: \"2024\"\nstartAt: 2024-01-01\n---\n");
    let ev = "2024/2024-05-01 tekst";
    write(root, &format!("{ev}/_event.md"), "---\nid: evt\ntype: event\ntitle: Tekst\nstartAt: 2024-05-01\n---\n");
    write(
        root,
        &format!("{ev}/gedachte.md"),
        "---\nid: txt1\ntype: text\ncaption: Een gedachte\n---\n\nDit was een mooie dag.\n",
    );

    let model = scan(root);
    assert_eq!(model.items.len(), 1);
    assert_eq!(model.items[0].item_type, ItemType::Text);
    assert_eq!(model.items[0].body_text.as_deref(), Some("Dit was een mooie dag."));
    assert!(model.items[0].media.is_none());
}
