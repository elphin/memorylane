// Design-tokens voor de render-laag (fase 1 van het personalisatie-plan).
// Eén ResolvedTheme beschrijft álle kleuren en fonts die de scenes gebruiken;
// CLASSIC_DARK bevat exact de waarden die vóór deze refactor hardcoded in de
// scenes stonden (de huidige look). In fase 2 komt hier een registry met
// meerdere thema's + een cascade-resolver bij; de scenes lezen dan een per
// scope geresolvede ResolvedTheme in plaats van deze constante.
//
// Bewust GEEN tokens (status-markers, betekenis moet in elk thema herkenbaar
// blijven): de gouden featured-ring (0xffc24b), de blauwe jaar-cover-ring
// (0x4b9bff), de amber "in aanbouw"-badge (0xe8a54a), de play-badge
// (zwart/wit) en de witte toetsenbord-focus-ringen.

export interface ThemeColors {
  /** App-/canvas-achtergrond (ook de blend-basis voor de span-balkjes). */
  appBg: number
  /** Donkere vlakken: L0-jaartegels. */
  surface: number
  surfaceStroke: number
  /** Tekstkaart-"papier" (L2/L3-notities). */
  paper: number
  paperStroke: number
  paperInk: number
  /** Fotorand (het "witte" kader om foto's, L1/L2/L3). */
  frame: number
  /** Primaire tekst (jaartitels, jaar-preview). */
  text: number
  /** Heldere accent-tekst (dag-label bij de dagkiezer). */
  textBright: number
  /** Zachte tekst (L3-caption, stip mét cover). */
  textSoft: number
  /** Gedempte tekst (tellers, maandlabels, stip zonder cover). */
  textMuted: number
  /** Vage tekst ("Geen memories in dit jaar"-hint). */
  textFaint: number
  /** Titel-overlay op een memory-kaart (L1, boven de foto). */
  cardTitle: number
  /** Titel ín een placeholder-tegel zonder foto (L1). */
  placeholderText: number
  /** Leader-lijntjes van de as naar de kaarten (L1). */
  leader: number
  /** Tijd-as (L1). */
  axis: number
  axisTick: number
  /** Selectie/datum-aanwijzing: dagkiezer-lijn en periode-band (L1). */
  accent: number
  /** Laad-tinten (sprite-kleur zolang de texture nog niet binnen is). */
  thumbLoading: number
  coverLoading: number
  focusLoading: number
  /** Tint over de geblurde L3-achtergrond (dempt 'm voor contrast). */
  focusBackdropDim: number
  /** Felle basiskleuren voor de meerdaagse-blokjes (worden tegen appBg
   * geblend, zie opaqueSpan in de jaar-scene). */
  spanPalette: number[]
  /** Gedempte vullingen voor memory-tegels zonder foto (L1). */
  placeholderPalette: number[]
}

export interface ThemeFonts {
  /** Tegel-/kaarttitels en labels (weights komen uit de scenes: 600/700). */
  title: string
  /** Overige UI-tekst: tellers, maandlabels, hints. */
  body: string
  /** Foto-captions (L3) — thema's kunnen hier bijv. een handschrift-font kiezen. */
  caption: string
  /** Grote sier-tekst: de jaar-naam bij de overscroll-preview (L1). */
  display: string
  /** Tekstkaart-inhoud (notities, L2/L3). */
  paper: string
}

export interface ResolvedTheme {
  id: string
  colors: ThemeColors
  fonts: ThemeFonts
}

/** De huidige look, 1-op-1 overgenomen uit de voorheen hardcoded waarden. */
export const CLASSIC_DARK: ResolvedTheme = {
  id: 'classic-dark',
  colors: {
    appBg: 0x0a0a0f,
    surface: 0x1a2030,
    surfaceStroke: 0x2c3650,
    paper: 0xfffdf5,
    paperStroke: 0xe0dccb,
    paperInk: 0x2b2b2b,
    frame: 0xf5f5f0,
    text: 0xffffff,
    textBright: 0xdfe7f5,
    textSoft: 0xcfd6e4,
    textMuted: 0x8a97b0,
    textFaint: 0x6a7690,
    cardTitle: 0xe8edf6,
    placeholderText: 0xeef1f7,
    leader: 0xbcc5d6,
    axis: 0x3a4256,
    axisTick: 0x2a3142,
    accent: 0x6ea8ff,
    thumbLoading: 0x2a3345,
    coverLoading: 0x0e1420,
    focusLoading: 0x1a1f2b,
    focusBackdropDim: 0x6a6a6a,
    spanPalette: [
      0xff5c5c, 0x3cd6d6, 0xffd93c, 0xb15cff, 0x6ee06e, 0xff5cc0, 0x5c8cff, 0xffa63c,
      0x38c9a0, 0xf05545,
    ],
    placeholderPalette: [
      0x3d4a5c, 0x4a3d5c, 0x5c3d4a, 0x3d5c4a, 0x5c4a3d, 0x3d5c5c, 0x504a3d, 0x473d5c,
    ],
  },
  fonts: {
    title: 'Segoe UI, sans-serif',
    body: 'Segoe UI, sans-serif',
    caption: 'Segoe UI, sans-serif',
    display: 'Georgia, serif',
    paper: 'Georgia, serif',
  },
}
