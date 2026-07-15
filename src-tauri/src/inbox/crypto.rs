//! Versleuteld blobformaat (§8) — byte-identiek aan inbox/pwa/src/crypto/blob.ts.
//! Container: magic "MLI1" | version 1 | 3 reserved | plaintextSize u64 LE | chunks
//! (elk: nonce 12 || AES-256-GCM ct+tag16). AAD per chunk: "ml1|mem|file|i|n".
//! Sleutel per bestand via HKDF-SHA256 (§7.2).
//!
//! De functies worden pas in fase 5 (desktop-import) aangeroepen; nu bewezen met
//! de gedeelde testvectoren.
#![allow(dead_code)]

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use hkdf::Hkdf;
use sha2::Sha256;

const MAGIC: &[u8; 4] = b"MLI1";
const VERSION: u8 = 1;
pub const CHUNK: usize = 8 * 1024 * 1024;
const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;
const HEADER: usize = 16;

fn chunk_count(plaintext_size: usize) -> usize {
    plaintext_size.div_ceil(CHUNK).max(1)
}

/// Per-bestand sleutel (HKDF-SHA256). `file_id == "envelope"` voor de envelope.
fn file_key(master: &[u8; 32], memory_id: &str, file_id: &str) -> [u8; 32] {
    let info = if file_id == "envelope" {
        "ml-inbox:v1:envelope".to_string()
    } else {
        format!("ml-inbox:v1:file:{file_id}")
    };
    let hk = Hkdf::<Sha256>::new(Some(format!("ml-inbox:{memory_id}").as_bytes()), master);
    let mut okm = [0u8; 32];
    hk.expand(info.as_bytes(), &mut okm).expect("hkdf 32 bytes");
    okm
}

fn aad(memory_id: &str, file_id: &str, i: usize, n: usize) -> Vec<u8> {
    format!("ml1|{memory_id}|{file_id}|{i}|{n}").into_bytes()
}

/// Versleutel `plaintext`; `nonces[i]` is de (injecteerbare) nonce voor chunk i.
/// Leeg bestand is verboden (§8.1).
///
/// ⚠️ VEILIGHEID: elke `nonces[i]` MOET uniek + CSPRNG zijn onder dezelfde sleutel
/// (masterKey+memoryId+fileId). De desktop ontsleutelt alleen (B8), dus dit pad is
/// nu test-only met vaste vector-nonces; een toekomstige productie-aanroeper moet
/// `rand::rngs::OsRng` gebruiken. Nonce-hergebruik breekt AES-GCM volledig.
pub fn encrypt_blob(
    plaintext: &[u8],
    master: &[u8; 32],
    memory_id: &str,
    file_id: &str,
    nonces: &[[u8; 12]],
) -> Result<Vec<u8>, String> {
    if plaintext.is_empty() {
        return Err("leeg bestand is verboden".into());
    }
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&file_key(master, memory_id, file_id)));
    let n = chunk_count(plaintext.len());
    let mut out = Vec::with_capacity(HEADER + plaintext.len() + n * (NONCE_LEN + TAG_LEN));
    out.extend_from_slice(MAGIC);
    out.push(VERSION);
    out.extend_from_slice(&[0, 0, 0]);
    out.extend_from_slice(&(plaintext.len() as u64).to_le_bytes());
    for i in 0..n {
        let chunk = &plaintext[i * CHUNK..((i + 1) * CHUNK).min(plaintext.len())];
        let nonce = nonces.get(i).ok_or("te weinig nonces")?;
        let ct = cipher
            .encrypt(Nonce::from_slice(nonce), Payload { msg: chunk, aad: &aad(memory_id, file_id, i, n) })
            .map_err(|_| "encrypt".to_string())?;
        out.extend_from_slice(nonce);
        out.extend_from_slice(&ct);
    }
    Ok(out)
}

/// Ontsleutel een container → plaintext. Valideert magic/version/plaintextSize +
/// elke GCM-tag; elke afwijking geeft een fout (geen half resultaat).
pub fn decrypt_blob(
    blob: &[u8],
    master: &[u8; 32],
    memory_id: &str,
    file_id: &str,
) -> Result<Vec<u8>, String> {
    if blob.len() < HEADER {
        return Err("te kort".into());
    }
    if &blob[0..4] != MAGIC {
        return Err("verkeerde magic".into());
    }
    if blob[4] != VERSION {
        return Err("verkeerde versie".into());
    }
    let plain_size = u64::from_le_bytes(blob[8..16].try_into().unwrap()) as usize;
    // Vijandige header: ciphertext ≥ plaintext (elke chunk voegt nonce+tag toe),
    // dus plain_size > blob.len() is per definitie kapot. Vroeg weigeren, VÓÓR de
    // allocatie, zodat een 16-byte-blob met een enorme plaintextSize niet met een
    // capacity-overflow panic't (DoS) maar netjes een fout geeft.
    if plain_size > blob.len() {
        return Err("plaintextSize groter dan de blob".into());
    }
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&file_key(master, memory_id, file_id)));
    let n = chunk_count(plain_size);
    let mut out = Vec::with_capacity(plain_size);
    let mut off = HEADER;
    for i in 0..n {
        let expected = CHUNK.min(plain_size - i * CHUNK);
        if off + NONCE_LEN + expected + TAG_LEN > blob.len() {
            return Err("getrunceerd".into());
        }
        let nonce = &blob[off..off + NONCE_LEN];
        off += NONCE_LEN;
        let ct = &blob[off..off + expected + TAG_LEN];
        off += expected + TAG_LEN;
        let pt = cipher
            .decrypt(Nonce::from_slice(nonce), Payload { msg: ct, aad: &aad(memory_id, file_id, i, n) })
            .map_err(|_| "auth-fout".to_string())?;
        out.extend_from_slice(&pt);
    }
    if off != blob.len() {
        return Err("bytes over aan het eind".into());
    }
    if out.len() != plain_size {
        return Err("plaintextSize klopt niet".into());
    }
    Ok(out)
}

/// Streaming-ontsleuteling: leest een container van `reader` en schrijft de
/// plaintext naar `writer`, chunk voor chunk — nooit meer dan één 8-MiB-chunk in
/// het geheugen (voor grote video's). Valideert magic/version + elke GCM-tag +
/// de totale grootte. Geeft het aantal plaintext-bytes terug.
pub fn decrypt_stream<R: std::io::Read, W: std::io::Write>(
    mut reader: R,
    mut writer: W,
    master: &[u8; 32],
    memory_id: &str,
    file_id: &str,
) -> Result<u64, String> {
    let mut header = [0u8; HEADER];
    reader.read_exact(&mut header).map_err(|_| "header lezen".to_string())?;
    if &header[0..4] != MAGIC {
        return Err("verkeerde magic".into());
    }
    if header[4] != VERSION {
        return Err("verkeerde versie".into());
    }
    let plain_size = u64::from_le_bytes(header[8..16].try_into().unwrap()) as usize;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&file_key(master, memory_id, file_id)));
    let n = chunk_count(plain_size);
    let mut buf = vec![0u8; NONCE_LEN + CHUNK + TAG_LEN];
    let mut written = 0usize;
    for i in 0..n {
        let expected = CHUNK.min(plain_size - i * CHUNK);
        let need = NONCE_LEN + expected + TAG_LEN;
        reader.read_exact(&mut buf[..need]).map_err(|_| "getrunceerd".to_string())?;
        let (nonce, ct) = buf[..need].split_at(NONCE_LEN);
        let pt = cipher
            .decrypt(Nonce::from_slice(nonce), Payload { msg: ct, aad: &aad(memory_id, file_id, i, n) })
            .map_err(|_| "auth-fout".to_string())?;
        writer.write_all(&pt).map_err(|_| "schrijven".to_string())?;
        written += pt.len();
    }
    // Er mogen geen bytes meer volgen (anders is de container niet wat hij beweert).
    if reader.read(&mut [0u8; 1]).map_err(|_| "lezen".to_string())? != 0 {
        return Err("bytes over aan het eind".into());
    }
    if written != plain_size {
        return Err("plaintextSize klopt niet".into());
    }
    writer.flush().map_err(|_| "flush".to_string())?;
    Ok(written as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use sha2::Digest;

    #[derive(Deserialize)]
    struct PlaintextSpec {
        kind: String,
        value: Option<String>,
        len: Option<usize>,
        seed: Option<usize>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct VectorSpec {
        name: String,
        memory_id: String,
        file_id: String,
        plaintext: PlaintextSpec,
        expected_sha256: String,
        expected_len: usize,
    }
    #[derive(Deserialize)]
    struct CorruptionSpec {
        name: String,
        base: String,
        mutation: String,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct VectorsFile {
        master_key_hex: String,
        vectors: Vec<VectorSpec>,
        corruptions: Vec<CorruptionSpec>,
    }

    fn hex_decode(s: &str) -> Vec<u8> {
        (0..s.len() / 2).map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap()).collect()
    }
    fn hex_encode(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }
    /// Zelfde deterministische nonce als de TS-kant: [i, 0x11, 0x22, …, 0xbb].
    fn fixed_nonces(count: usize) -> Vec<[u8; 12]> {
        (0..count)
            .map(|i| [i as u8, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb])
            .collect()
    }
    fn build_plaintext(spec: &PlaintextSpec) -> Vec<u8> {
        match spec.kind.as_str() {
            "utf8" => spec.value.clone().unwrap_or_default().into_bytes(),
            "hex" => hex_decode(spec.value.as_deref().unwrap_or("")),
            "pattern" => {
                let len = spec.len.unwrap_or(0);
                let seed = spec.seed.unwrap_or(1);
                (0..len).map(|j| ((j * seed + 0x5a) & 0xff) as u8).collect()
            }
            other => panic!("onbekende plaintext-kind: {other}"),
        }
    }
    fn mutate(container: &[u8], mutation: &str) -> Vec<u8> {
        let mut c = container.to_vec();
        match mutation {
            "flip_last_byte" => {
                let last = c.len() - 1;
                c[last] ^= 0x01;
            }
            "increment_plaintext_size" => {
                let v = u64::from_le_bytes(c[8..16].try_into().unwrap()) + 1;
                c[8..16].copy_from_slice(&v.to_le_bytes());
            }
            "swap_first_two_chunks" => {
                let full = NONCE_LEN + CHUNK + TAG_LEN;
                let a0 = HEADER;
                let a1 = HEADER + full;
                let chunk0 = c[a0..a0 + full].to_vec();
                let chunk1 = c[a1..a1 + full].to_vec();
                c[a0..a0 + full].copy_from_slice(&chunk1);
                c[a1..a1 + full].copy_from_slice(&chunk0);
            }
            other => panic!("onbekende mutatie: {other}"),
        }
        c
    }

    fn load() -> VectorsFile {
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../inbox/shared/test-vectors/vectors.json");
        serde_json::from_str(&std::fs::read_to_string(&p).expect("vectors.json")).expect("parse")
    }

    #[test]
    fn vectors_encrypt_byte_identical_and_roundtrip() {
        let f = load();
        let master: [u8; 32] = hex_decode(&f.master_key_hex).try_into().unwrap();
        for v in &f.vectors {
            let plaintext = build_plaintext(&v.plaintext);
            let n = plaintext.len().div_ceil(CHUNK).max(1);
            let container =
                encrypt_blob(&plaintext, &master, &v.memory_id, &v.file_id, &fixed_nonces(n)).unwrap();
            assert_eq!(container.len(), v.expected_len, "{} lengte", v.name);
            assert_eq!(hex_encode(&Sha256::digest(&container)), v.expected_sha256, "{} sha256", v.name);
            let back = decrypt_blob(&container, &master, &v.memory_id, &v.file_id).unwrap();
            assert_eq!(back, plaintext, "{} round-trip", v.name);
        }
    }

    #[test]
    fn corruptions_are_rejected() {
        let f = load();
        let master: [u8; 32] = hex_decode(&f.master_key_hex).try_into().unwrap();
        for cor in &f.corruptions {
            let base = f.vectors.iter().find(|v| v.name == cor.base).unwrap();
            let plaintext = build_plaintext(&base.plaintext);
            let n = plaintext.len().div_ceil(CHUNK).max(1);
            let container =
                encrypt_blob(&plaintext, &master, &base.memory_id, &base.file_id, &fixed_nonces(n)).unwrap();
            let bad = mutate(&container, &cor.mutation);
            assert!(
                decrypt_blob(&bad, &master, &base.memory_id, &base.file_id).is_err(),
                "{} zou moeten falen",
                cor.name
            );
        }
    }

    #[test]
    fn wrong_key_or_ids_rejected() {
        let f = load();
        let master: [u8; 32] = hex_decode(&f.master_key_hex).try_into().unwrap();
        let v = &f.vectors[0];
        let pt = build_plaintext(&v.plaintext);
        let container = encrypt_blob(&pt, &master, &v.memory_id, &v.file_id, &fixed_nonces(1)).unwrap();
        let mut wrong = master;
        wrong[0] ^= 0xff;
        assert!(decrypt_blob(&container, &wrong, &v.memory_id, &v.file_id).is_err());
        assert!(decrypt_blob(&container, &master, &v.memory_id, "ander-bestand").is_err());
        assert!(decrypt_blob(&container, &master, "99999999-9999-4999-8999-999999999999", &v.file_id).is_err());
    }

    #[test]
    fn decrypt_stream_matches_decrypt_blob() {
        let f = load();
        let master: [u8; 32] = hex_decode(&f.master_key_hex).try_into().unwrap();
        // Meerdere chunks (vector-02) is de interessante: streaming over de grens heen.
        let v = f.vectors.iter().find(|v| v.name == "vector-02-multichunk").unwrap();
        let plaintext = build_plaintext(&v.plaintext);
        let n = plaintext.len().div_ceil(CHUNK).max(1);
        let container = encrypt_blob(&plaintext, &master, &v.memory_id, &v.file_id, &fixed_nonces(n)).unwrap();
        let mut out = Vec::new();
        let written =
            decrypt_stream(std::io::Cursor::new(&container), &mut out, &master, &v.memory_id, &v.file_id).unwrap();
        assert_eq!(written as usize, plaintext.len());
        assert_eq!(out, plaintext);
        // Corrupte tag → auth-fout, geen half resultaat naar buiten.
        let bad = mutate(&container, "flip_last_byte");
        let mut sink = Vec::new();
        assert!(decrypt_stream(std::io::Cursor::new(&bad), &mut sink, &master, &v.memory_id, &v.file_id).is_err());
    }

    #[test]
    fn empty_plaintext_forbidden() {
        let master = [0u8; 32];
        assert!(encrypt_blob(&[], &master, "m", "x", &fixed_nonces(1)).is_err());
    }

    #[test]
    fn hostile_plaintext_size_does_not_panic() {
        // 16-byte blob met een enorme gelogen plaintextSize → nette Err, geen panic.
        let master = [0u8; 32];
        let mut blob = Vec::new();
        blob.extend_from_slice(b"MLI1");
        blob.push(1);
        blob.extend_from_slice(&[0, 0, 0]);
        blob.extend_from_slice(&u64::MAX.to_le_bytes());
        assert!(decrypt_blob(&blob, &master, "m", "x").is_err());
    }
}
