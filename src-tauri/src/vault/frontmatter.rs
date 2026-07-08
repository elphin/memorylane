//! Tolerante frontmatter-parser.
//!
//! v1's `generator.ts` schrijft handgeschreven YAML met eigenaardigheden die
//! een strikte YAML-parser zou weigeren (alleen `"` wordt geëscaped, niet `\`;
//! waarden met `[`-prefix worden ongequote weggeschreven). Een strikte parser
//! zou daarop falen → stil dataverlies. Deze parser is daarom **tolerant by
//! design**: hij spiegelt de semantiek van v1's `parseYaml`/`parseValue` en
//! valt bij twijfel terug op "lees het als string" i.p.v. te crashen.
//!
//! Ondersteunt: scalars (null/bool/number/string), gequote strings met
//! `\"`-unescaping, block-sequences (`- item`), geneste mappings (indent), en
//! inline flow (`[a, b]` / `{k: v}`) voor voorwaartse compatibiliteit met de
//! v2-`featuredPhotos`-structuur.

use std::collections::BTreeMap;

/// Een geparste YAML-waarde uit de frontmatter.
#[derive(Debug, Clone, PartialEq)]
pub enum Yaml {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Seq(Vec<Yaml>),
    Map(BTreeMap<String, Yaml>),
}

impl Yaml {
    /// Waarde als string (Str direct, Num/Bool gecoerced). None bij Null/Seq/Map.
    pub fn as_str(&self) -> Option<String> {
        match self {
            Yaml::Str(s) => Some(s.clone()),
            Yaml::Num(n) => Some(format_num(*n)),
            Yaml::Bool(b) => Some(b.to_string()),
            _ => None,
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Yaml::Num(n) => Some(*n),
            Yaml::Str(s) => s.trim().parse::<f64>().ok(),
            _ => None,
        }
    }

    // Gebruikt door tests en (fase 2) de featuredPhotos-reader.
    #[allow(dead_code)]
    pub fn as_seq(&self) -> Option<&[Yaml]> {
        match self {
            Yaml::Seq(v) => Some(v),
            _ => None,
        }
    }

    pub fn as_map(&self) -> Option<&BTreeMap<String, Yaml>> {
        match self {
            Yaml::Map(m) => Some(m),
            _ => None,
        }
    }

    /// String-lijst: een echte Seq, of een enkele scalar als 1-elements lijst.
    pub fn as_string_list(&self) -> Vec<String> {
        match self {
            Yaml::Seq(v) => v.iter().filter_map(|x| x.as_str()).collect(),
            Yaml::Null => Vec::new(),
            other => other.as_str().into_iter().collect(),
        }
    }
}

/// Een geparst markdown-document: frontmatter-map + de body eronder.
#[derive(Debug, Clone)]
pub struct Parsed {
    pub frontmatter: BTreeMap<String, Yaml>,
    pub body: String,
    /// True als er een openende `---` was zonder sluitende `---`. De scanner
    /// logt dit als indexfout (nooit stil dataverlies) i.p.v. het te negeren.
    pub unterminated: bool,
}

impl Parsed {
    pub fn get(&self, key: &str) -> Option<&Yaml> {
        self.frontmatter.get(key)
    }

    /// String-veld ophalen; lege strings tellen als afwezig.
    pub fn get_str(&self, key: &str) -> Option<String> {
        self.frontmatter
            .get(key)
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
    }
}

/// Splitst frontmatter (tussen `---`-fences) van de body en parseert de YAML.
/// Zonder geldige fences: lege frontmatter, hele inhoud als body.
pub fn parse(content: &str) -> Parsed {
    let normalized = content.replace("\r\n", "\n");
    let lines: Vec<&str> = normalized.split('\n').collect();

    // Eerste niet-lege regel moet '---' zijn.
    let first_idx = lines.iter().position(|l| !l.trim().is_empty());
    let Some(first_idx) = first_idx else {
        return Parsed {
            frontmatter: BTreeMap::new(),
            body: normalized.trim().to_string(),
            unterminated: false,
        };
    };
    if lines[first_idx].trim() != "---" {
        return Parsed {
            frontmatter: BTreeMap::new(),
            body: normalized.trim().to_string(),
            unterminated: false,
        };
    }

    // Sluitende '---'.
    let end_idx = lines
        .iter()
        .enumerate()
        .skip(first_idx + 1)
        .find(|(_, l)| l.trim() == "---")
        .map(|(i, _)| i);
    let Some(end_idx) = end_idx else {
        // Openende fence zonder sluiter → onafgesloten frontmatter (gemeld).
        return Parsed {
            frontmatter: BTreeMap::new(),
            body: normalized.trim().to_string(),
            unterminated: true,
        };
    };

    let yaml_lines = &lines[first_idx + 1..end_idx];
    let frontmatter = parse_yaml(yaml_lines);
    let body = lines[end_idx + 1..].join("\n").trim().to_string();

    Parsed {
        frontmatter,
        body,
        unterminated: false,
    }
}

/// Regel met berekende indent (spaties), lege regels overgeslagen.
struct IndentLine {
    indent: usize,
    content: String,
}

fn parse_yaml(lines: &[&str]) -> BTreeMap<String, Yaml> {
    let prepared: Vec<IndentLine> = lines
        .iter()
        .filter(|l| !l.trim().is_empty())
        .map(|l| IndentLine {
            indent: l.len() - l.trim_start().len(),
            content: l.trim().to_string(),
        })
        .collect();

    let mut pos = 0;
    match parse_node(&prepared, &mut pos, prepared.first().map(|l| l.indent).unwrap_or(0)) {
        Yaml::Map(m) => m,
        _ => BTreeMap::new(),
    }
}

/// Parseert een blok op `indent`: sequence als de regels met `- ` beginnen,
/// anders een mapping.
fn parse_node(lines: &[IndentLine], pos: &mut usize, indent: usize) -> Yaml {
    if *pos < lines.len()
        && lines[*pos].indent == indent
        && is_seq_marker(&lines[*pos].content)
    {
        parse_seq(lines, pos, indent)
    } else {
        parse_map(lines, pos, indent)
    }
}

fn is_seq_marker(content: &str) -> bool {
    content == "-" || content.starts_with("- ")
}

fn parse_map(lines: &[IndentLine], pos: &mut usize, indent: usize) -> Yaml {
    let mut map = BTreeMap::new();
    while *pos < lines.len() && lines[*pos].indent == indent {
        let content = lines[*pos].content.clone();
        // In map-context is een seq-marker onverwacht → stoppen (tolerant).
        if is_seq_marker(&content) {
            break;
        }
        let Some(colon) = content.find(':') else {
            // Regel zonder ':' → overslaan (voorkomt vastlopen).
            *pos += 1;
            continue;
        };
        let key = content[..colon].trim().to_string();
        let rest = content[colon + 1..].trim().to_string();
        *pos += 1;

        if rest.is_empty() {
            // Child-blok op diepere indent (nested map of seq).
            if *pos < lines.len() && lines[*pos].indent > indent {
                let child_indent = lines[*pos].indent;
                let node = parse_node(lines, pos, child_indent);
                map.insert(key, node);
            } else {
                map.insert(key, Yaml::Null);
            }
        } else {
            map.insert(key, parse_scalar(&rest));
        }
    }
    Yaml::Map(map)
}

fn parse_seq(lines: &[IndentLine], pos: &mut usize, indent: usize) -> Yaml {
    let mut seq = Vec::new();
    while *pos < lines.len() && lines[*pos].indent == indent && is_seq_marker(&lines[*pos].content) {
        let content = lines[*pos].content.clone();
        if content == "-" {
            // Bare dash: genest blok op diepere indent volgt.
            *pos += 1;
            if *pos < lines.len() && lines[*pos].indent > indent {
                let child_indent = lines[*pos].indent;
                seq.push(parse_node(lines, pos, child_indent));
            } else {
                seq.push(Yaml::Null);
            }
        } else {
            let rest = content[2..].trim().to_string();
            *pos += 1;
            seq.push(parse_scalar(&rest));
        }
    }
    Yaml::Seq(seq)
}

/// Parseert een scalar-waarde (of inline flow). Tolerant: onbekende vormen
/// worden een plain string i.p.v. een fout.
fn parse_scalar(s: &str) -> Yaml {
    let s = s.trim();
    if s.is_empty() || s == "~" || s == "null" {
        return Yaml::Null;
    }
    if s == "true" {
        return Yaml::Bool(true);
    }
    if s == "false" {
        return Yaml::Bool(false);
    }
    // Dubbel-gequote string.
    if s.len() >= 2 && s.starts_with('"') && s.ends_with('"') {
        return Yaml::Str(unescape_double(&s[1..s.len() - 1]));
    }
    // Enkel-gequote string (v1 produceert dit niet, maar tolereer het).
    if s.len() >= 2 && s.starts_with('\'') && s.ends_with('\'') {
        return Yaml::Str(s[1..s.len() - 1].replace("''", "'"));
    }
    // Inline flow-sequence — alleen als het hele token bracketed is.
    if s.starts_with('[') && s.ends_with(']') {
        if let Some(seq) = parse_flow_seq(s) {
            return seq;
        }
        return Yaml::Str(s.to_string());
    }
    // Inline flow-mapping.
    if s.starts_with('{') && s.ends_with('}') {
        if let Some(map) = parse_flow_map(s) {
            return map;
        }
        return Yaml::Str(s.to_string());
    }
    // Getal — alleen als het volledige token als f64 parseert (dates met '-'
    // falen hier en blijven string).
    if let Ok(n) = s.parse::<f64>() {
        if n.is_finite() {
            return Yaml::Num(n);
        }
    }
    Yaml::Str(s.to_string())
}

/// Vervangt `\"` door `"`; laat andere backslashes staan (v1 escapet die niet,
/// dus `"C:\Users"` moet letterlijk teruggelezen worden).
fn unescape_double(inner: &str) -> String {
    let mut out = String::with_capacity(inner.len());
    let mut chars = inner.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' {
            if chars.peek() == Some(&'"') {
                out.push('"');
                chars.next();
            } else {
                out.push('\\');
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// Splitst een flow-collectie op komma's op diepte 0, respecteert quotes en
/// geneste `[]`/`{}`.
fn split_flow(inner: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut buf = String::new();
    let mut depth = 0i32;
    let mut in_quote: Option<char> = None;
    let mut escaped = false;
    for c in inner.chars() {
        match in_quote {
            Some(q) => {
                buf.push(c);
                // Binnen een dubbel-gequote token beschermt `\` het volgende
                // teken (spiegelt `unescape_double`), zodat een geëscapete `\"`
                // het token NIET vroeg afsluit — anders zou een naam met een
                // quote de komma-splitsing corrumperen (dataverlies bij
                // round-trip van `flow_seq`).
                if escaped {
                    escaped = false;
                } else if q == '"' && c == '\\' {
                    escaped = true;
                } else if c == q {
                    in_quote = None;
                }
            }
            None => match c {
                '"' | '\'' => {
                    in_quote = Some(c);
                    buf.push(c);
                }
                '[' | '{' => {
                    depth += 1;
                    buf.push(c);
                }
                ']' | '}' => {
                    depth -= 1;
                    buf.push(c);
                }
                ',' if depth == 0 => {
                    parts.push(buf.trim().to_string());
                    buf.clear();
                }
                _ => buf.push(c),
            },
        }
    }
    if !buf.trim().is_empty() {
        parts.push(buf.trim().to_string());
    }
    parts
}

fn parse_flow_seq(s: &str) -> Option<Yaml> {
    let inner = &s[1..s.len() - 1];
    if inner.trim().is_empty() {
        return Some(Yaml::Seq(Vec::new()));
    }
    let items = split_flow(inner).iter().map(|p| parse_scalar(p)).collect();
    Some(Yaml::Seq(items))
}

fn parse_flow_map(s: &str) -> Option<Yaml> {
    let inner = &s[1..s.len() - 1];
    if inner.trim().is_empty() {
        return Some(Yaml::Map(BTreeMap::new()));
    }
    let mut map = BTreeMap::new();
    for pair in split_flow(inner) {
        let colon = pair.find(':')?;
        let key = pair[..colon].trim().trim_matches(['"', '\'']).to_string();
        let val = parse_scalar(pair[colon + 1..].trim());
        map.insert(key, val);
    }
    Some(Yaml::Map(map))
}

/// Formatteert een getal zonder overbodige `.0` (zodat ids/jaren netjes blijven).
fn format_num(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_basic_event_frontmatter() {
        let content = "---\nid: 0344aebb-b5e0-44fc-bfbc-2ca2b8e5c855\ntype: event\ntitle: Jim geboren, eerste periode\nstartAt: 1969-07-01\nendAt: 1969-12-01\n---\n";
        let p = parse(content);
        assert_eq!(p.get_str("id").unwrap(), "0344aebb-b5e0-44fc-bfbc-2ca2b8e5c855");
        assert_eq!(p.get_str("type").unwrap(), "event");
        assert_eq!(p.get_str("title").unwrap(), "Jim geboren, eerste periode");
        // Datum met '-' blijft string, wordt geen getal.
        assert_eq!(p.get_str("startAt").unwrap(), "1969-07-01");
    }

    #[test]
    fn quoted_year_title_stays_string() {
        let p = parse("---\ntype: year\ntitle: \"1971\"\n---\n");
        assert_eq!(p.get_str("title").unwrap(), "1971");
    }

    #[test]
    fn rot_case_backslash_and_quote_in_caption() {
        // v1 escapet alleen `"`, niet `\`. Pad met backslashes + trigger-teken.
        let p = parse("---\ncaption: \"C:\\Users\\Jim\\foto: strand\"\n---\n");
        assert_eq!(p.get_str("caption").unwrap(), "C:\\Users\\Jim\\foto: strand");
    }

    #[test]
    fn rot_case_bracket_prefix_title_unquoted() {
        // Ongequote `[deel 1] Vakantie` is geen geldige flow-seq → plain string.
        let p = parse("---\ntitle: [deel 1] Vakantie\n---\n");
        assert_eq!(p.get_str("title").unwrap(), "[deel 1] Vakantie");
    }

    #[test]
    fn parses_nested_location() {
        let content =
            "---\nplace:\n  lat: 52.37\n  lng: 4.89\n  label: Amsterdam\n---\n";
        let p = parse(content);
        let place = p.get("place").unwrap().as_map().unwrap();
        assert_eq!(place.get("lat").unwrap().as_f64().unwrap(), 52.37);
        assert_eq!(place.get("label").unwrap().as_str().unwrap(), "Amsterdam");
    }

    #[test]
    fn parses_block_sequence() {
        let content = "---\ntags:\n  - vakantie\n  - strand\npeople:\n  - Jim\n---\n";
        let p = parse(content);
        assert_eq!(
            p.get("tags").unwrap().as_string_list(),
            vec!["vakantie".to_string(), "strand".to_string()]
        );
        assert_eq!(p.get("people").unwrap().as_string_list(), vec!["Jim".to_string()]);
    }

    #[test]
    fn parses_flow_map_sequence_for_featured_photos() {
        // Voorwaartse compat met v2 `featuredPhotos` als lijst van flow-maps.
        let content = "---\nfeaturedPhotos:\n  - {event: abc, x: 10, y: -5, scale: 1}\n  - {event: def, x: 0, y: 0, scale: 2}\n---\n";
        let p = parse(content);
        let seq = p.get("featuredPhotos").unwrap().as_seq().unwrap();
        assert_eq!(seq.len(), 2);
        let first = seq[0].as_map().unwrap();
        assert_eq!(first.get("event").unwrap().as_str().unwrap(), "abc");
        assert_eq!(first.get("x").unwrap().as_f64().unwrap(), 10.0);
        assert_eq!(first.get("y").unwrap().as_f64().unwrap(), -5.0);
    }

    #[test]
    fn flow_seq_with_quote_comma_colon_roundtrips() {
        // Namen/tags met een quote, komma of dubbele punt moeten door de
        // altijd-gequote `flow_seq` heen round-trippen (split_flow respecteert
        // de `\"`-escape, anders zou de komma-splitsing corrumperen).
        let content = "---\npeople: [\"c\\\"d\", \"e:f\", \"a,b\"]\n---\n";
        let p = parse(content);
        assert_eq!(
            p.get("people").unwrap().as_string_list(),
            vec!["c\"d".to_string(), "e:f".to_string(), "a,b".to_string()]
        );
    }

    #[test]
    fn no_frontmatter_returns_empty() {
        let p = parse("gewoon wat tekst\nzonder fences\n");
        assert!(p.frontmatter.is_empty());
        assert_eq!(p.body, "gewoon wat tekst\nzonder fences");
    }

    #[test]
    fn body_is_extracted() {
        let p = parse("---\nid: x\n---\n\nDit is de body.\n");
        assert_eq!(p.get_str("id").unwrap(), "x");
        assert_eq!(p.body, "Dit is de body.");
    }

    #[test]
    fn unterminated_frontmatter_is_flagged_not_silent() {
        let p = parse("---\nid: x\ntype: event\n");
        assert!(p.frontmatter.is_empty());
        assert!(p.unterminated, "onafgesloten frontmatter moet gemarkeerd worden");
    }

    #[test]
    fn well_formed_frontmatter_is_not_flagged() {
        let p = parse("---\nid: x\n---\n");
        assert!(!p.unterminated);
    }
}
