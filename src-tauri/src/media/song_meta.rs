//! Metadata van een liedje ophalen: uit de tags van een audiobestand (lokaal,
//! geen netwerk) of uit een streaming-link (één netwerk-call bij het toevoegen).
//!
//! Kernidee van de feature: de IDENTITEIT van een liedje (titel, artiest, hoes)
//! is vault-data en rot niet. De link is maar één van de manieren om het af te
//! spelen. Daarom halen we bij een link de gegevens één keer op en slaan we ze op
//! als tekst + een lokaal hoesje -- daarna nooit meer netwerk.

use serde::{Deserialize, Serialize};
use std::path::Path;

/// Wat we over een liedje te weten zijn gekomen. Alles optioneel: de gebruiker
/// mag elk veld corrigeren, en een mislukte lookup mag nooit blokkeren.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SongMetaFound {
    pub title: Option<String>,
    pub artist: Option<String>,
    /// Internationale track-code. Komt alleen uit een lokale tag; noch de
    /// Spotify-oEmbed noch de iTunes-zoek-API levert er een.
    pub isrc: Option<String>,
    pub duration_secs: Option<u64>,
    /// Ruwe bytes van de albumhoes + extensie, klaar voor `writer::import_song`.
    #[serde(skip)]
    pub cover: Option<(Vec<u8>, String)>,
    /// True als er een hoes gevonden is (het enige wat de frontend hoeft te weten;
    /// de bytes zelf gaan nooit door de IPC-laag).
    pub has_cover: bool,
}

impl SongMetaFound {
    fn with_cover(mut self, bytes: Vec<u8>, ext: &str) -> Self {
        self.has_cover = !bytes.is_empty();
        if self.has_cover {
            self.cover = Some((bytes, ext.to_string()));
        }
        self
    }
}

/// Leeg/whitespace telt als afwezig, en te lange waarden worden afgekapt.
/// Tags en API-antwoorden zijn onvertrouwde invoer: een titel van 50 kB zou
/// anders in de frontmatter belanden.
fn clean(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().chars().take(300).collect::<String>())
        .filter(|s| !s.is_empty())
}

/// Leest titel/artiest/duur/ISRC en de ingebedde albumhoes uit een audiobestand.
/// Geen netwerk. Faalt nooit hard: een bestand zonder tags geeft gewoon `None`s.
pub fn read_tags(path: &Path) -> SongMetaFound {
    use lofty::file::{AudioFile, TaggedFileExt};
    use lofty::prelude::ItemKey;
    use lofty::probe::Probe;

    let Ok(tagged) = Probe::open(path).and_then(|p| p.read()) else {
        return SongMetaFound::default();
    };
    let duration_secs = Some(tagged.properties().duration().as_secs()).filter(|d| *d > 0);
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag());
    let Some(tag) = tag else {
        return SongMetaFound { duration_secs, ..Default::default() };
    };
    let get = |k: ItemKey| clean(tag.get_string(k).map(str::to_string));
    let found = SongMetaFound {
        title: get(ItemKey::TrackTitle),
        artist: get(ItemKey::TrackArtist).or_else(|| get(ItemKey::AlbumArtist)),
        isrc: get(ItemKey::Isrc),
        duration_secs,
        ..Default::default()
    };
    // Een ingebedde albumhoes heeft geen praktische bovengrens in het formaat;
    // zonder deze rem schrijven we een hoes van tientallen megabytes de vault in.
    const MAX_EMBEDDED_COVER: usize = 8 * 1024 * 1024;
    match tag.pictures().first().filter(|p| p.data().len() <= MAX_EMBEDDED_COVER) {
        Some(pic) => {
            let ext = pic.mime_type().map(mime_ext).unwrap_or("jpg");
            found.with_cover(pic.data().to_vec(), ext)
        }
        None => found,
    }
}

fn mime_ext(mime: &lofty::picture::MimeType) -> &'static str {
    use lofty::picture::MimeType;
    match mime {
        MimeType::Png => "png",
        MimeType::Gif => "gif",
        MimeType::Bmp => "bmp",
        MimeType::Tiff => "tiff",
        _ => "jpg",
    }
}

/// Herkent de dienst achter een geplakte link en geeft het oEmbed-eindpunt.
///
/// Een ONBEKENDE dienst (Apple Music, Deezer, Tidal) levert `None` en daarmee een
/// volledig leeg opzoekresultaat: zonder titel is er ook niets om bij iTunes mee
/// te zoeken. De gebruiker typt titel en artiest dan zelf -- dat is een prima
/// uitkomst, want die twee zijn wat er in de vault belandt.
fn provider_oembed(url: &str) -> Option<String> {
    let u = url.to_ascii_lowercase();
    let enc = urlencode(url);
    if u.contains("open.spotify.com") {
        Some(format!("https://open.spotify.com/oembed?url={enc}"))
    } else if u.contains("youtube.com") || u.contains("youtu.be") {
        Some(format!("https://www.youtube.com/oembed?url={enc}&format=json"))
    } else {
        None
    }
}

/// Percent-encoding voor een query-waarde. Zonder dit levert een titel met een
/// spatie, `&` of accent een kapotte of verkeerde zoekopdracht op -- precies bij
/// de namen waar je de lookup nodig hebt.
fn urlencode(v: &str) -> String {
    use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
    utf8_percent_encode(v, NON_ALPHANUMERIC).to_string()
}

/// Splitst een oEmbed-titel als "Artiest - Titel" in twee stukken. YouTube levert
/// vrijwel altijd die vorm; bij Spotify is de titel meestal alleen de tracknaam.
fn split_dash(title: &str) -> Option<(String, String)> {
    for sep in [" - ", " – ", " — "] {
        if let Some((a, b)) = title.split_once(sep) {
            let (a, b) = (a.trim(), b.trim());
            if !a.is_empty() && !b.is_empty() {
                return Some((a.to_string(), b.to_string()));
            }
        }
    }
    None
}

/// Haalt de gegevens van een liedje op bij een geplakte link.
///
/// SYNCHROON (`reqwest::blocking`): de aanroeper draait dit in `spawn_blocking`,
/// net als de inbox-API. Blocking reqwest direct in een async context paniekt.
///
/// Faalt zacht: bij geen internet, een time-out of een rate-limit krijg je een
/// leeg resultaat terug, geen fout. De gebruiker houdt de URL en wat hij zelf
/// typte -- dat is het hele punt van "identiteit los van afspeelbron".
pub fn lookup_link(url: &str) -> SongMetaFound {
    let client = match http_client() {
        Some(c) => c,
        None => return SongMetaFound::default(),
    };

    let mut found = SongMetaFound::default();
    let mut thumb_url: Option<String> = None;

    if let Some(endpoint) = provider_oembed(url) {
        if let Some(v) = get_json(&client, &endpoint) {
            let raw_title = clean(v.get("title").and_then(|t| t.as_str()).map(str::to_string));
            let author = clean(v.get("author_name").and_then(|t| t.as_str()).map(str::to_string));
            // "Artiest - Titel" opsplitsen KRIJGT VOORRANG op het auteursveld.
            // YouTube levert altijd een `author_name`, maar dat is de KANAALnaam
            // ("TheWeekndVEVO"), niet de artiest -- en omdat de artiest daarmee
            // gevuld was, sloeg de iTunes-correctie hieronder ook nog eens over.
            // Het resultaat belandt permanent in de vault, dus de standaard moet
            // kloppen, ook al is hij achteraf te corrigeren.
            match raw_title.as_deref().and_then(split_dash) {
                Some((a, ti)) => {
                    found.artist = Some(a);
                    found.title = Some(ti);
                }
                None => {
                    found.title = raw_title.clone();
                    found.artist = author;
                }
            }
            thumb_url = v
                .get("thumbnail_url")
                .and_then(|t| t.as_str())
                .map(str::to_string);
        }
    }

    // Aanvullen via iTunes. Bij Spotify-links is dit géén uitzondering maar het
    // STANDAARDPAD: de oEmbed daar geeft zelden een apart artiestveld.
    if found.artist.is_none() {
        if let Some(term) = found.title.clone() {
            if let Some(v) = get_json(
                &client,
                &format!(
                    "https://itunes.apple.com/search?term={}&entity=song&limit=1",
                    urlencode(&term)
                ),
            ) {
                if let Some(r) = v.get("results").and_then(|r| r.get(0)) {
                    found.artist =
                        clean(r.get("artistName").and_then(|s| s.as_str()).map(str::to_string));
                    if found.title.is_none() {
                        found.title =
                            clean(r.get("trackName").and_then(|s| s.as_str()).map(str::to_string));
                    }
                    if thumb_url.is_none() {
                        // 100px is de standaard; 600 geeft een bruikbaar hoesje.
                        thumb_url = r
                            .get("artworkUrl100")
                            .and_then(|s| s.as_str())
                            .map(|s| s.replace("100x100", "600x600"));
                    }
                }
            }
        }
    }

    let found = match thumb_url.as_deref().and_then(|u| download_image(&client, u)) {
        Some((bytes, ext)) => found.with_cover(bytes, &ext),
        None => found,
    };
    cache_cover(url, &found.cover);
    found
}

/// Client voor alle uitgaande calls van deze module.
///
/// Redirects blijven binnen https en zijn begrensd. Dat is geen theorie: de
/// `thumbnail_url` uit een oEmbed-antwoord is de enige URL in deze code die
/// volledig door een derde partij bepaald wordt, en zonder deze rem mag die
/// doorverwijzen naar een adres in het lokale netwerk of een metadata-endpoint.
fn http_client() -> Option<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .user_agent("MemoryLane")
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 {
                attempt.stop()
            } else if attempt.url().scheme() == "https" {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
        .build()
        .ok()
}

/// Leest hoogstens `limit` bytes uit een antwoord. `resp.bytes()` leest het HELE
/// lichaam in het geheugen en toetst pas daarna -- dat beschermt de vault, niet
/// het proces. Een antwoord van een derde partij hoort begrensd te zijn vóór de
/// allocatie, niet erna.
fn read_capped(resp: reqwest::blocking::Response, limit: usize) -> Option<Vec<u8>> {
    use std::io::Read;
    if resp.content_length().is_some_and(|n| n > limit as u64) {
        return None;
    }
    let mut buf = Vec::new();
    resp.take(limit as u64 + 1).read_to_end(&mut buf).ok()?;
    if buf.is_empty() || buf.len() > limit {
        return None;
    }
    Some(buf)
}

fn get_json(client: &reqwest::blocking::Client, url: &str) -> Option<serde_json::Value> {
    const MAX_JSON: usize = 256 * 1024;
    let resp = client.get(url).send().ok()?;
    if !resp.status().is_success() {
        return None;
    }
    serde_json::from_slice(&read_capped(resp, MAX_JSON)?).ok()
}

/// Haalt een albumhoes op. Alleen https, en met een harde groottegrens: dit is
/// een URL uit een antwoord van derden, dus geen onbeperkte download.
fn download_image(client: &reqwest::blocking::Client, url: &str) -> Option<(Vec<u8>, String)> {
    const MAX_BYTES: usize = 4 * 1024 * 1024;
    if !url.to_ascii_lowercase().starts_with("https://") {
        return None;
    }
    let resp = client.get(url).send().ok()?;
    if !resp.status().is_success() {
        return None;
    }
    // Het moet ECHT een afbeelding zijn. Zonder deze check belandt een antwoord
    // met text/html als `..._cover.jpg` in de vault: het liedje meldt dan
    // permanent "ik heb artwork" terwijl er nooit een thumbnail uit komt.
    let ct = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.split(';').next().unwrap_or("").trim().to_ascii_lowercase())
        .unwrap_or_default();
    let ext = match ct.as_str() {
        "image/png" => "png",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/jpeg" | "image/jpg" => "jpg",
        _ => return None,
    }
    .to_string();
    Some((read_capped(resp, MAX_BYTES)?, ext))
}

/// Laatst opgehaalde albumhoes, op URL gekeyd. Eén slot.
///
/// De dialoog zoekt de gegevens op en laat de gebruiker ze corrigeren; daarna
/// haalt `add_song` alleen nog de hoes op. Zonder deze cache is dat een tweede
/// volledige lookup (oEmbed + iTunes + afbeelding) voor exact dezelfde link --
/// een verdubbeling van de enige uitgaande verbinding die deze feature heeft, en
/// dat op een API die ~20 verzoeken per minuut toestaat.
static COVER_CACHE: std::sync::Mutex<Option<(String, Vec<u8>, String)>> =
    std::sync::Mutex::new(None);

fn cache_cover(url: &str, cover: &Option<(Vec<u8>, String)>) {
    if let Some((bytes, ext)) = cover {
        if let Ok(mut slot) = COVER_CACHE.lock() {
            *slot = Some((url.to_string(), bytes.clone(), ext.clone()));
        }
    }
}

/// De hoes bij `url`, uit de cache als hij er is en anders via een verse lookup.
pub fn cover_for(url: &str) -> Option<(Vec<u8>, String)> {
    if let Ok(slot) = COVER_CACHE.lock() {
        if let Some((cached, bytes, ext)) = slot.as_ref() {
            if cached == url {
                return Some((bytes.clone(), ext.clone()));
            }
        }
    }
    lookup_link(url).cover
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_trims_and_caps() {
        assert_eq!(clean(Some("  Blinding Lights  ".into())).as_deref(), Some("Blinding Lights"));
        assert_eq!(clean(Some("   ".into())), None);
        assert_eq!(clean(None), None);
        let long = clean(Some("x".repeat(5000))).unwrap();
        assert_eq!(long.len(), 300, "onvertrouwde tags worden afgekapt");
    }

    #[test]
    fn urlencode_escapes_query_breaking_characters() {
        assert_eq!(urlencode("a b"), "a%20b");
        assert_eq!(urlencode("rock & roll"), "rock%20%26%20roll");
        assert_eq!(urlencode("Mötley Crüe"), "M%C3%B6tley%20Cr%C3%BCe");
        assert_eq!(urlencode("a=1&b=2"), "a%3D1%26b%3D2");
    }

    #[test]
    fn provider_is_recognised_and_url_is_encoded() {
        let sp = provider_oembed("https://open.spotify.com/track/abc?si=x").unwrap();
        assert!(sp.starts_with("https://open.spotify.com/oembed?url="));
        assert!(sp.contains("%3A%2F%2F"), "de doel-URL is encoded: {sp}");
        let yt = provider_oembed("https://youtu.be/xyz").unwrap();
        assert!(yt.starts_with("https://www.youtube.com/oembed?url="));
        assert!(yt.ends_with("&format=json"));
        assert!(provider_oembed("https://music.apple.com/nl/album/x").is_none());
    }

    #[test]
    fn split_dash_handles_the_common_youtube_title_forms() {
        assert_eq!(
            split_dash("The Weeknd - Blinding Lights"),
            Some(("The Weeknd".into(), "Blinding Lights".into()))
        );
        // Ook het en-streepje dat YouTube-titels vaak gebruiken.
        assert_eq!(
            split_dash("Toto – Africa"),
            Some(("Toto".into(), "Africa".into()))
        );
        // Een koppelteken ZONDER spaties is geen scheiding maar deel van de titel.
        assert_eq!(split_dash("Jay-Z"), None);
        assert_eq!(split_dash("Blinding Lights"), None);
        assert_eq!(split_dash(" - "), None, "lege helften tellen niet");
    }

    /// Een bestand zonder leesbare tags mag nooit een fout geven: de gebruiker
    /// typt dan gewoon zelf een titel.
    #[test]
    fn read_tags_on_a_non_audio_file_is_empty_not_an_error() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("geen-audio.mp3");
        std::fs::write(&p, b"dit is geen mp3").unwrap();
        let found = read_tags(&p);
        assert!(found.title.is_none() && found.artist.is_none() && found.cover.is_none());
        assert!(!found.has_cover);
    }

    /// Een YouTube-titel splitst op het streepje, ook al levert YouTube altijd
    /// een `author_name`: dat is de KANAALnaam, niet de artiest.
    #[test]
    fn a_dash_in_the_title_wins_from_the_channel_name() {
        // Deze test bewaakt de VOLGORDE in `lookup_link`; `split_dash` zelf wordt
        // hierboven al gedekt. Hier alleen de aanname die de volgorde rechtvaardigt.
        assert_eq!(
            split_dash("The Weeknd - Blinding Lights (Official Video)"),
            Some(("The Weeknd".into(), "Blinding Lights (Official Video)".into()))
        );
    }

    /// De hoes-cache mag alleen treffen op exact dezelfde URL.
    #[test]
    fn cover_cache_only_matches_the_same_url() {
        let url = "https://voorbeeld.test/track/1";
        cache_cover(url, &Some((vec![1, 2, 3], "png".into())));
        let slot = COVER_CACHE.lock().unwrap();
        let (cached, bytes, ext) = slot.as_ref().expect("gevuld");
        assert_eq!(cached, url);
        assert_eq!(bytes, &vec![1, 2, 3]);
        assert_eq!(ext, "png");
    }

    #[test]
    fn read_tags_on_a_missing_file_is_empty() {
        let found = read_tags(Path::new("bestaat-niet-12345.mp3"));
        assert!(found.title.is_none() && found.duration_secs.is_none());
    }
}
