// Koppel-link: mailbox-id + upload-token + masterKey. Komt binnen via het
// QR-fragment (browser opent de link), of — vanaf een op het beginscherm
// geïnstalleerde app — via de in-app QR-scanner of een geplakte code.
//
// SECURITY: de gescande/geplakte tekst is ONVERTROUWD en draagt de geheime
// masterKey. We halen hier BEWUST GEEN server-URL uit die tekst — de PairScreen
// zet `serverUrl` altijd op `location.origin` (de host die de PWA serveert, en
// dus de echte brievenbus-server). Zou de server wél uit de QR komen, dan kon
// een kwaadaardige code de telefoon naar een aanvallers-server laten uploaden.
// Laat dat zo: alleen mb/t/k worden gelezen; het server-deel wordt genegeerd.

import { b64urlToBytes, bytesToHex } from './util'

export interface PairLink {
  mailboxId: string
  token: string
  masterKeyHex: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Parse een koppelcode uit vrije tekst: een volledige URL
 * (`https://host/#v=1&mb=..&t=..&k=..`), een kaal fragment (`#v=1&..` of
 * `v=1&..`), met eventueel query-params vóór het `#`. Geeft null bij elke
 * afwijking — strenge validatie omdat dit onvertrouwde invoer met een
 * geheime sleutel is. */
export function parsePairText(text: string): PairLink | null {
  const s = text.trim()
  if (!s) return null
  // Isoleer het deel ná de eerste '#' (fragment); geen '#' → de hele string is
  // de parameter-string. Zo werken URL-, #fragment- en kale-params-vormen.
  const hash = s.includes('#') ? s.slice(s.indexOf('#') + 1) : s
  const p = new URLSearchParams(hash)
  if (p.get('v') !== '1') return null
  const mb = p.get('mb')
  const t = p.get('t')
  const k = p.get('k')
  if (!mb || !t || !k) return null
  if (!UUID_RE.test(mb) || t.length < 8) return null
  try {
    const key = b64urlToBytes(k)
    // De masterKey MOET 32 bytes zijn (§7.2). Een verminkt/afgekapt fragment
    // zou anders stil een niet-te-ontsleutelen upload opleveren — pas thuis bij
    // import merkbaar. Liever hier al weigeren.
    if (key.length !== 32) return null
    return { mailboxId: mb, token: t, masterKeyHex: bytesToHex(key) }
  } catch {
    return null
  }
}

/** De koppelcode uit de huidige URL (het `#`-fragment), of null. */
export function parsePairFromLocation(): PairLink | null {
  return parsePairText(location.hash)
}
