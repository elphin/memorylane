import { describe, it, expect } from 'vitest'
import { parsePairText } from './pair'

// Een geldige masterKey: 32 bytes → base64url (44 tekens, geen padding). We
// nemen 32× 0xAB → 'q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6s'.
const KEY32 = btoa(String.fromCharCode(...new Array(32).fill(0xab)))
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=+$/, '')
const MB = '00000000-0000-4000-8000-000000000000'
const TOK = 'abcdefgh1234' // ≥8

// Precies de vorm die de Rust-backend genereert (src-tauri/.../inbox/mod.rs):
// `{server}/#v=1&mb=..&t=..&k=..`.
const RUST_URL = `https://x.workers.dev/#v=1&mb=${MB}&t=${TOK}&k=${KEY32}`

describe('parsePairText', () => {
  it('leest de volledige Rust-URL-vorm', () => {
    const p = parsePairText(RUST_URL)
    expect(p).not.toBeNull()
    expect(p!.mailboxId).toBe(MB)
    expect(p!.token).toBe(TOK)
    expect(p!.masterKeyHex).toBe('ab'.repeat(32))
  })

  it('leest een kaal #fragment', () => {
    expect(parsePairText(`#v=1&mb=${MB}&t=${TOK}&k=${KEY32}`)).not.toBeNull()
  })

  it('leest een kale params-string zonder #', () => {
    expect(parsePairText(`v=1&mb=${MB}&t=${TOK}&k=${KEY32}`)).not.toBeNull()
  })

  it('negeert query-params vóór het fragment', () => {
    expect(parsePairText(`https://x/?ref=mail#v=1&mb=${MB}&t=${TOK}&k=${KEY32}`)).not.toBeNull()
  })

  it('trimt witruimte', () => {
    expect(parsePairText(`  \n${RUST_URL}\n `)).not.toBeNull()
  })

  it('weigert een verkeerde versie', () => {
    expect(parsePairText(`#v=2&mb=${MB}&t=${TOK}&k=${KEY32}`)).toBeNull()
  })

  it('weigert een niet-UUID mailbox', () => {
    expect(parsePairText(`#v=1&mb=nietuuid&t=${TOK}&k=${KEY32}`)).toBeNull()
  })

  it('weigert een te kort token', () => {
    expect(parsePairText(`#v=1&mb=${MB}&t=short&k=${KEY32}`)).toBeNull()
  })

  it('weigert een sleutel die geen 32 bytes is', () => {
    const shortKey = btoa('te kort').replace(/=+$/, '')
    expect(parsePairText(`#v=1&mb=${MB}&t=${TOK}&k=${shortKey}`)).toBeNull()
  })

  it('weigert ontbrekende velden', () => {
    expect(parsePairText(`#v=1&mb=${MB}&t=${TOK}`)).toBeNull()
    expect(parsePairText(`#v=1&mb=${MB}&k=${KEY32}`)).toBeNull()
  })

  it('weigert rommel en leeg', () => {
    expect(parsePairText('')).toBeNull()
    expect(parsePairText('https://memorylane.app/gewoon-een-link')).toBeNull()
    expect(parsePairText('zomaar wat tekst')).toBeNull()
  })
})
