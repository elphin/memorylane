// UI-palet voor de DOM-overlay-chrome (panelen, knoppen, formulieren).
// Volgt uitsluitend `THEME.uiMode` van het APP-thema (niet het thema van het
// jaar/event waar je toevallig bent — anders flipt een open overlay van donker
// naar licht tijdens het navigeren). UI_DARK bevat exact de kleuren die vóór
// deze refactor hardcoded in AppShell/SettingsPhone stonden; UI_LIGHT is de
// lichte tegenhanger. De diavoorstelling (Screensaver) en de video-laag
// (FocusVideoLayer) blijven bewust theme-onafhankelijk zwart.

import { THEME } from './tokens'

export interface UiPalette {
  /** Halfdoorzichtige backdrop achter modals/overlays. */
  backdrop: string
  /** Paneel-/kaartvlak (instellingen, dialogen, zoekpaneel). */
  card: string
  /** Iets lichter vlak binnen een kaart (previews, rijen, chips). */
  cardAlt: string
  /** Scheidingslijnen + rustige randen. */
  border: string
  /** Primaire tekst. */
  text: string
  /** Secundaire tekst (beschrijvingen, hints). */
  textMuted: string
  /** Nog stiller (placeholders, disabled). */
  textFaint: string
  /** Invoervelden. */
  inputBg: string
  inputBorder: string
  /** Neutrale (ghost-)knoppen. */
  btnBorder: string
  btnText: string
  /** Primaire actieknop (blauw) — in beide modes gelijk gehouden. */
  primary: string
  primaryText: string
  /** Destructieve acties. */
  danger: string
  /** Zwevende ronde knoppen op het canvas (terug/tandwiel/zoek). */
  floatBtnBg: string
  floatBtnText: string
  /** Toast-melding. */
  toastBg: string
  toastText: string

  // — Extra chrome-tokens (substap 2b): exact de bestaande dark-waarden, zodat
  //   de donkere chrome pixel-identiek blijft. —
  /** Iets lichtere backdrop (zoekpaneel). */
  backdropSoft: string
  /** Iets zwaardere backdrop (materialisatie-overzicht). */
  backdropHeavy: string
  /** Lopende tekst op kaarten + ghost-knop-tekst. */
  textSoft: string
  /** Heldere invoertekst (tagfilter-velden). */
  textBright: string
  /** Kbd-toetsen + zoekresultaat-tekst. */
  textCrisp: string
  /** Thema-tegel-label (niet-actief). */
  tileText: string
  /** Formulierlabels (dia-tagfilter). */
  labelMuted: string
  /** "Hoe bijzonder?"-label in de memory-dialog. */
  hintLabel: string
  /** Hint-/subtekst in de memory-dialog. */
  hintMuted: string
  /** Belang-knoppen (memory-dialog): niet-actief vlak/rand/tekst + actief. */
  choiceBg: string
  borderSoft: string
  chipText: string
  primarySoft: string
  primaryFaintBg: string
  /** Status-kaart op de Telefoon-tab. */
  statusCardBg: string
  /** Invoervelden op de Telefoon-tab. */
  phoneInputBg: string
  /** Halfdoorzichtig invoer-/infovlak (tagfilter-input, vault-pad-box). */
  inputBgSoft: string
  /** "Alles passend"-/zoomknop (zwevende pill op het canvas). */
  fitBtnBg: string
  fitBtnBorder: string
  fitBtnText: string
  /** Rand + gedempte tekst van de zwevende ronde knoppen (zoek/tandwiel). */
  floatBtnBorder: string
  floatBtnSoftText: string
  /** Terugknop in rust (vage cirkel) + pijl-kleur. */
  backRestBg: string
  backRestBorder: string
  backArrow: string
  /** Titel bovenin (zweeft over het canvas). */
  canvasTitleText: string
  canvasTitleShadow: string
  /** Kbd-toets-chip (sneltoetsen-tab). */
  kbdBg: string
  kbdBorder: string
  kbdShadow: string
  /** Rood-varianten. */
  errorText: string
  errorListText: string
  errorTitle: string
  dangerMutedBorder: string
  dangerMutedText: string
  dangerDeep: string
  /** Groen: "Opslaan als Eigen"-knop. */
  okDeep: string
  /** Fab-rij op het canvas: neutrale pills + sorteer-pills + "Sorteer"-hint. */
  fabNeutralBg: string
  fabSortBg: string
  fabHint: string
  /** Amber-varianten (telefoon-tab: pending-badge + rotate-waarschuwing). */
  warnSoft: string
  warnBg: string
  warnBorder: string
  warnText: string
}

/** Exact de bestaande donkere chrome (geen visuele wijziging in dark-mode). */
export const UI_DARK: UiPalette = {
  backdrop: 'rgba(0,0,0,0.55)',
  card: '#161c28',
  cardAlt: '#1c2432',
  border: '#2c3650',
  text: '#ffffff',
  textMuted: '#8a97b0',
  textFaint: '#6a7690',
  inputBg: '#0e1420',
  inputBorder: '#2c3650',
  btnBorder: '#2c3650',
  btnText: '#dfe7f5',
  primary: '#3b82f6',
  primaryText: '#ffffff',
  danger: '#e0574f',
  floatBtnBg: 'rgba(22,28,40,0.85)',
  floatBtnText: '#ffffff',
  toastBg: 'rgba(22,28,40,0.95)',
  toastText: '#e6eaf2',

  backdropSoft: 'rgba(0,0,0,0.5)',
  backdropHeavy: 'rgba(0,0,0,0.6)',
  textSoft: '#cfd6e4',
  textBright: '#e6eaf2',
  textCrisp: '#e6ebf5',
  tileText: '#bcc5d6',
  labelMuted: '#9aa6c0',
  hintLabel: '#9aa6bd',
  hintMuted: '#8794aa',
  choiceBg: '#1b2230',
  borderSoft: '#2a3345',
  chipText: '#aab4c8',
  primarySoft: '#6ea8ff',
  primaryFaintBg: 'rgba(110,168,255,0.16)',
  statusCardBg: '#1b2233',
  phoneInputBg: '#0f1420',
  inputBgSoft: 'rgba(12,16,24,0.6)',
  fitBtnBg: 'rgba(22,28,40,0.6)',
  fitBtnBorder: 'rgba(255,255,255,0.18)',
  fitBtnText: '#e6eaf2',
  floatBtnBorder: '#2c3650',
  floatBtnSoftText: '#cfd6e4',
  backRestBg: 'rgba(255,255,255,0.06)',
  backRestBorder: 'rgba(255,255,255,0.10)',
  backArrow: 'rgba(255,255,255,0.45)',
  canvasTitleText: 'rgba(245,247,251,0.92)',
  canvasTitleShadow: '0 2px 12px rgba(0,0,0,0.6)',
  kbdBg: '#232c3d',
  kbdBorder: '#3a465e',
  kbdShadow: '#10151f',
  errorText: '#f0a0a0',
  errorListText: '#f3b0b0',
  errorTitle: '#ff8a8a',
  dangerMutedBorder: '#7a3b3b',
  dangerMutedText: '#ffb4b4',
  dangerDeep: '#7f1d1d',
  okDeep: '#166534',
  fabNeutralBg: '#1f2734',
  fabSortBg: '#141a24',
  fabHint: '#7f8aa0',
  warnSoft: '#e0b34f',
  warnBg: '#2a2410',
  warnBorder: '#5a4c1e',
  warnText: '#e6d9a8',
}

/** Lichte tegenhanger voor thema's met `uiMode: 'light'`. */
export const UI_LIGHT: UiPalette = {
  backdrop: 'rgba(40, 36, 28, 0.35)',
  card: '#fdfbf6',
  cardAlt: '#f2eee5',
  border: '#d9d2c2',
  text: '#2a2a30',
  textMuted: '#6f6a5e',
  textFaint: '#9a9486',
  inputBg: '#ffffff',
  inputBorder: '#cfc7b5',
  btnBorder: '#d9d2c2',
  btnText: '#3a3a40',
  primary: '#3b82f6',
  primaryText: '#ffffff',
  danger: '#c04040',
  floatBtnBg: 'rgba(60, 54, 44, 0.75)',
  floatBtnText: '#ffffff',
  toastBg: 'rgba(50, 46, 38, 0.95)',
  toastText: '#ffffff',

  backdropSoft: 'rgba(40, 36, 28, 0.3)',
  backdropHeavy: 'rgba(40, 36, 28, 0.42)',
  textSoft: '#4c4a42',
  textBright: '#2a2a30',
  textCrisp: '#2f2f36',
  tileText: '#5f5b50',
  labelMuted: '#6f6a5e',
  hintLabel: '#6f6a5e',
  hintMuted: '#8a8578',
  choiceBg: '#f2eee5',
  borderSoft: '#d9d2c2',
  chipText: '#6f6a5e',
  primarySoft: '#3b82f6',
  primaryFaintBg: 'rgba(59,130,246,0.10)',
  statusCardBg: '#f2eee5',
  phoneInputBg: '#ffffff',
  inputBgSoft: 'rgba(255,255,255,0.65)',
  fitBtnBg: 'rgba(60, 54, 44, 0.55)',
  fitBtnBorder: 'rgba(255,255,255,0.25)',
  fitBtnText: '#ffffff',
  floatBtnBorder: 'rgba(255,255,255,0.28)',
  floatBtnSoftText: '#ffffff',
  backRestBg: 'rgba(40, 36, 28, 0.08)',
  backRestBorder: 'rgba(40, 36, 28, 0.16)',
  backArrow: 'rgba(40, 36, 28, 0.55)',
  canvasTitleText: 'rgba(42, 42, 48, 0.9)',
  canvasTitleShadow: '0 2px 12px rgba(255,255,255,0.6)',
  kbdBg: '#e9e4d6',
  kbdBorder: '#c9c1ae',
  kbdShadow: '#b8b09c',
  errorText: '#b03030',
  errorListText: '#b03030',
  errorTitle: '#b03030',
  dangerMutedBorder: '#d3a3a3',
  dangerMutedText: '#a83434',
  dangerDeep: '#a12b2b',
  okDeep: '#2e7d52',
  fabNeutralBg: 'rgba(60, 54, 44, 0.75)',
  fabSortBg: 'rgba(60, 54, 44, 0.6)',
  fabHint: 'rgba(60, 54, 44, 0.8)',
  warnSoft: '#8a6420',
  warnBg: '#f5ecd2',
  warnBorder: '#d9c88f',
  warnText: '#6b5518',
}

// ── Thema-tinting van de chrome ──────────────────────────────────────────────
// De basis-paletten hierboven zijn koud blauwgrijs (dark) of warm beige
// (light). Om de chrome bij de rest van het thema te laten passen, worden de
// NEUTRALE tokens (vlakken, randen, invoervelden, gedempte tekst, canvas-pills)
// ge-herkleurd naar de temperatuur van het actieve thema — afgeleid uit zijn
// eigen `surfaceStroke` (de border-kleur die het thema zelf al voor de tegels
// gebruikt). Voor classic-dark/light is die stroke exact de bestaande
// chrome-rand, dus daar verandert niets; een warm thema (Kodachrome) krijgt
// warme panelen/randen, een koel thema (Oceaan) koele, Noir puur grijs.
//
// Semantische/accent-tokens (primary-blauw, danger-rood, ok-groen, amber,
// witte tekst, donkere backdrops) blijven vast — die dragen betekenis of
// contrast en horen niet mee te verkleuren.

const REHUE_KEYS: (keyof UiPalette)[] = [
  'card', 'cardAlt', 'border', 'borderSoft', 'inputBg', 'inputBorder', 'btnBorder',
  'choiceBg', 'statusCardBg', 'phoneInputBg', 'fabNeutralBg', 'fabSortBg', 'kbdBg',
  'kbdBorder', 'floatBtnBorder', 'floatBtnBg', 'toastBg', 'inputBgSoft', 'fitBtnBg',
  'text', 'textMuted', 'textFaint', 'textSoft', 'textBright', 'textCrisp', 'tileText',
  'btnText', 'labelMuted', 'hintLabel', 'hintMuted', 'chipText', 'fabHint',
  'floatBtnSoftText',
]

interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

function parseCss(css: string): Rgba {
  if (css[0] === '#') {
    let h = css.slice(1)
    if (h.length === 3) h = h.split('').map((c) => c + c).join('')
    const n = parseInt(h, 16)
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 }
  }
  const m = css.match(/rgba?\(([^)]+)\)/)
  if (m) {
    const p = m[1].split(',').map((s) => parseFloat(s.trim()))
    return { r: p[0] ?? 0, g: p[1] ?? 0, b: p[2] ?? 0, a: p[3] ?? 1 }
  }
  return { r: 0, g: 0, b: 0, a: 1 }
}

function formatCss({ r, g, b, a }: Rgba): string {
  const R = Math.round(r)
  const G = Math.round(g)
  const B = Math.round(b)
  if (a >= 1) return `#${((R << 16) | (G << 8) | B).toString(16).padStart(6, '0')}`
  return `rgba(${R},${G},${B},${a})`
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  r /= 255
  g /= 255
  b /= 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  let h = 0
  let s = 0
  const d = max - min
  if (d > 0) {
    s = d / (1 - Math.abs(2 * l - 1))
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h /= 6
    if (h < 0) h += 1
  }
  return { h, s, l }
}

function hslToRgb(h: number, s: number, l: number): Rgba {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const hp = h * 6
  const x = c * (1 - Math.abs((hp % 2) - 1))
  let r = 0
  let g = 0
  let b = 0
  if (hp < 1) [r, g, b] = [c, x, 0]
  else if (hp < 2) [r, g, b] = [x, c, 0]
  else if (hp < 3) [r, g, b] = [0, c, x]
  else if (hp < 4) [r, g, b] = [0, x, c]
  else if (hp < 5) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  const m = l - c / 2
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255, a: 1 }
}

/** Herkleur één chrome-token naar de thema-tint: behoud de eigen helderheid
 * (licht/donker-structuur blijft dus intact), zet de tint op de thema-hue en
 * de verzadiging op die van het thema. Alpha blijft behouden. */
function rehue(css: string, h: number, s: number): string {
  const { r, g, b, a } = parseCss(css)
  const hsl = rgbToHsl(r, g, b)
  const out = hslToRgb(h, s, hsl.l)
  return formatCss({ ...out, a })
}

function themedUi(base: UiPalette, strokeHex: number): UiPalette {
  const src = rgbToHsl((strokeHex >> 16) & 255, (strokeHex >> 8) & 255, strokeHex & 255)
  // Verzadiging aftoppen zodat de chrome "getinte grijs" blijft i.p.v.
  // uitgesproken gekleurd (Oceaan's stroke is bijv. fors blauw).
  const sat = Math.min(src.s, 0.3)
  const out: UiPalette = { ...base }
  for (const k of REHUE_KEYS) out[k] = rehue(base[k], src.h, sat)
  return out
}

// Memo: de chrome verandert alleen bij een app-themawissel (nieuwe uiMode of
// surfaceStroke). Zonder cache zou elke overlay-render 33 tokens herrekenen.
let uiCache: { key: string; pal: UiPalette } | null = null

/** Het actieve UI-palet — de basis (dark/light) ge-herkleurd naar de tint van
 * het actieve app-thema. Aanroepen tijdens render (niet op module-scope
 * cachen): React her-rendert de overlays bij een themawissel omdat de
 * settings-state wijzigt, en leest dan hier het nieuwe palet. */
export function ui(): UiPalette {
  const base = THEME.uiMode === 'light' ? UI_LIGHT : UI_DARK
  const key = `${THEME.uiMode}:${THEME.colors.surfaceStroke}`
  if (!uiCache || uiCache.key !== key) uiCache = { key, pal: themedUi(base, THEME.colors.surfaceStroke) }
  return uiCache.pal
}
