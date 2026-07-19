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

/** Het actieve UI-palet. Aanroepen tijdens render (niet op module-scope
 * cachen): React her-rendert de overlays bij een themawissel omdat de
 * settings-state wijzigt, en leest dan hier de nieuwe mode. */
export function ui(): UiPalette {
  return THEME.uiMode === 'light' ? UI_LIGHT : UI_DARK
}
