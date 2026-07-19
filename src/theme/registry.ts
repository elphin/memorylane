// Thema-registry: de gecureerde thema-pakketten (personalisatie-plan §4.1).
// Elk thema definieert álle tokens (geen gedeeltelijke thema's), zodat de
// resolver simpel blijft. De vault verwijst straks (fase 3) alleen naar een
// `id`; onbekende id's vallen hier stil terug op CLASSIC_DARK.
//
// Fonts: gebundelde OFL-fonts (Lora, Courier Prime, Caveat — zie
// src/assets/fonts) met systeem-fallbacks in de stack. Thema's met
// `background.kind: 'texture'` (warm-linen, kraft) krijgen hun tiling-textuur
// van de engine-achtergrondlaag (zie theme/textures.ts).

import { CLASSIC_DARK, type ResolvedTheme } from './tokens'

const SANS = 'Segoe UI, sans-serif'
const SERIF = 'Lora, Georgia, serif'
const TYPEWRITER = 'Courier Prime, Courier New, monospace'
const HANDWRITING = 'Caveat, Segoe Script, cursive'

/** Klassiek licht: dezelfde opzet als klassiek donker, maar op ivoor. */
const CLASSIC_LIGHT: ResolvedTheme = {
  id: 'classic-light',
  name: 'Klassiek licht',
  uiMode: 'light',
  background: { kind: 'solid' },
  colors: {
    appBg: 0xf2efe8,
    surface: 0xffffff,
    surfaceStroke: 0xd9d2c2,
    paper: 0xfffdf5,
    paperStroke: 0xd8d1bd,
    paperInk: 0x2b2b2b,
    frame: 0xffffff,
    text: 0x22283a,
    textBright: 0x2e3650,
    textSoft: 0x4a5468,
    textMuted: 0x77808f,
    textFaint: 0x9aa2ae,
    cardTitle: 0x2e3650,
    placeholderText: 0xf4f6fa,
    leader: 0x8f99ad,
    axis: 0xbfb8a6,
    axisTick: 0xd3ccba,
    accent: 0x3b82c4,
    thumbLoading: 0xdcd6c8,
    coverLoading: 0xe6e1d4,
    focusLoading: 0xd8d2c4,
    focusBackdropDim: 0xb8b8b8,
    spanPalette: [
      0xd94f4f, 0x2fa8a8, 0xd9ae2f, 0x9b4fd9, 0x53b653, 0xd94fa4, 0x4f78d9, 0xd9862f,
      0x2fa082, 0xc74534,
    ],
    placeholderPalette: [
      0x8593a8, 0x93859f, 0xa08590, 0x85a08e, 0xa09585, 0x85a0a0, 0x9a9285, 0x8d85a0,
    ],
  },
  fonts: {
    title: SANS,
    body: SANS,
    caption: SANS,
    display: 'Georgia, serif',
    paper: 'Georgia, serif',
  },
}

/** Warm linnen: crème album met serif-titels en handschrift-captions. */
const WARM_LINEN: ResolvedTheme = {
  id: 'warm-linen',
  name: 'Warm linnen',
  uiMode: 'light',
  background: { kind: 'texture', textureId: 'linen', tint: 0xefe7d6 },
  colors: {
    appBg: 0xefe7d6,
    surface: 0xf8f2e5,
    surfaceStroke: 0xd8cbae,
    paper: 0xfdf9ee,
    paperStroke: 0xd8cbae,
    paperInk: 0x3d3527,
    frame: 0xfffaf0,
    text: 0x3d3527,
    textBright: 0x54452f,
    textSoft: 0x6d5f48,
    textMuted: 0x8f8168,
    textFaint: 0xaca186,
    cardTitle: 0x54452f,
    placeholderText: 0xfaf6ea,
    leader: 0xb3a685,
    axis: 0xc8bb9a,
    axisTick: 0xd8cdb2,
    accent: 0xc47b4f,
    thumbLoading: 0xe0d7c2,
    coverLoading: 0xe6ddc9,
    focusLoading: 0xddd3bd,
    focusBackdropDim: 0xb5ab97,
    spanPalette: [
      0xc06a4a, 0x6f9a8d, 0xc9a24a, 0x9a6f8d, 0x7fa05e, 0xbb6a7c, 0x6a83a8, 0xc98c4a,
      0x5e9a80, 0xb35a44,
    ],
    placeholderPalette: [
      0xa8977a, 0x9a8d70, 0xa88b7a, 0x8d9a7a, 0xa89e7a, 0x8fa08e, 0xa09076, 0x97887c,
    ],
  },
  fonts: {
    title: SERIF,
    body: SANS,
    caption: HANDWRITING,
    display: SERIF,
    paper: SERIF,
  },
}

/** Kraft: scrapbook op pakpapier, typewriter-titels. */
const KRAFT: ResolvedTheme = {
  id: 'kraft',
  name: 'Kraft',
  uiMode: 'light',
  background: { kind: 'texture', textureId: 'kraft', tint: 0xb7906a },
  colors: {
    appBg: 0xb7906a,
    surface: 0xc49d75,
    surfaceStroke: 0x96714c,
    paper: 0xfdf6e6,
    paperStroke: 0xd6c3a0,
    paperInk: 0x3b2f21,
    frame: 0xfdf6e9,
    text: 0x33281b,
    textBright: 0x453623,
    textSoft: 0x594732,
    textMuted: 0x6f5a41,
    textFaint: 0x866f52,
    cardTitle: 0x453623,
    placeholderText: 0xf7efdd,
    leader: 0x8a6c49,
    axis: 0x96774f,
    axisTick: 0xa5875f,
    accent: 0x8c3b2e,
    thumbLoading: 0xa8845f,
    coverLoading: 0xa07c58,
    focusLoading: 0x9c7853,
    focusBackdropDim: 0x9a8468,
    spanPalette: [
      0x9c3f30, 0x4a7a6e, 0xb0812e, 0x7a4a6e, 0x5f7a3f, 0x9c4f63, 0x4a5f8a, 0xb06a2e,
      0x3f7a63, 0x8f3527,
    ],
    placeholderPalette: [
      0x9a7550, 0x8f6c48, 0xa07a52, 0x87704c, 0x94714a, 0x8a6f52, 0x9d7d58, 0x836747,
    ],
  },
  fonts: {
    title: TYPEWRITER,
    body: SANS,
    caption: HANDWRITING,
    display: TYPEWRITER,
    paper: SERIF,
  },
}

/** Kodachrome: warme jaren-'70/'80-film op donkerbruin. */
const KODACHROME: ResolvedTheme = {
  id: 'kodachrome',
  name: 'Kodachrome',
  uiMode: 'dark',
  background: { kind: 'solid' },
  colors: {
    appBg: 0x1d1712,
    surface: 0x33281c,
    surfaceStroke: 0x4d3d28,
    paper: 0xf6ecd8,
    paperStroke: 0xd6c5a4,
    paperInk: 0x3a2f22,
    frame: 0xf3ead6,
    text: 0xf3e5cc,
    textBright: 0xe8d4ae,
    textSoft: 0xcbb492,
    textMuted: 0xa8916c,
    textFaint: 0x81704f,
    cardTitle: 0xf0dfbd,
    placeholderText: 0xf3e8d0,
    leader: 0xbfa87e,
    axis: 0x59492f,
    axisTick: 0x453823,
    accent: 0xd98e32,
    thumbLoading: 0x453728,
    coverLoading: 0x362a1d,
    focusLoading: 0x3d3021,
    focusBackdropDim: 0x6a6052,
    spanPalette: [
      0xd9532f, 0x3f8f7a, 0xe0a52f, 0x8f5a3f, 0x8fa03f, 0xc75a6a, 0x4a6f8f, 0xe0742f,
      0x5f8f5a, 0xc7402a,
    ],
    placeholderPalette: [
      0x5c4a33, 0x5c5233, 0x4d5233, 0x5c3d33, 0x52463a, 0x46523d, 0x5c5540, 0x4f4433,
    ],
  },
  fonts: {
    title: SERIF,
    body: SANS,
    caption: TYPEWRITER,
    display: SERIF,
    paper: 'Georgia, serif',
  },
}

/** Oceaan: fris, koel blauwgroen op donker. */
const OCEAN: ResolvedTheme = {
  id: 'ocean',
  name: 'Oceaan',
  uiMode: 'dark',
  background: { kind: 'solid' },
  colors: {
    appBg: 0x0a1420,
    surface: 0x142a3d,
    surfaceStroke: 0x25455f,
    paper: 0xf4faf9,
    paperStroke: 0xc5d8d5,
    paperInk: 0x22333a,
    frame: 0xf0f6f7,
    text: 0xeaf4fb,
    textBright: 0xd3e7f2,
    textSoft: 0xa9c4d4,
    textMuted: 0x7f9aab,
    textFaint: 0x5f7889,
    cardTitle: 0xdcecf5,
    placeholderText: 0xe8f2f8,
    leader: 0xa4c0cf,
    axis: 0x2e4b63,
    axisTick: 0x223a4e,
    accent: 0x39b8a6,
    thumbLoading: 0x1e3548,
    coverLoading: 0x14283a,
    focusLoading: 0x1a2f42,
    focusBackdropDim: 0x5f6f78,
    spanPalette: [
      0x39b8a6, 0x4f8fd9, 0x62c46a, 0x3fa8c9, 0x8a6fd9, 0x4fd9c0, 0x5a78d9, 0x3f8f8f,
      0x6ab8d9, 0x2f9c8a,
    ],
    placeholderPalette: [
      0x2e4a5c, 0x2e5c55, 0x3d4a5c, 0x2e555c, 0x3d5c50, 0x35485a, 0x2f5266, 0x3a5560,
    ],
  },
  fonts: {
    title: SANS,
    body: SANS,
    caption: SANS,
    display: SANS,
    paper: 'Georgia, serif',
  },
}

/** Dusty rose: zachte pastels, serif. */
const DUSTY_ROSE: ResolvedTheme = {
  id: 'dusty-rose',
  name: 'Dusty rose',
  uiMode: 'light',
  background: { kind: 'solid' },
  colors: {
    appBg: 0xf3e9e6,
    surface: 0xfbf4f1,
    surfaceStroke: 0xdcc5be,
    paper: 0xfffbf8,
    paperStroke: 0xdcc9c2,
    paperInk: 0x453338,
    frame: 0xfffafa,
    text: 0x453338,
    textBright: 0x5a4149,
    textSoft: 0x77585f,
    textMuted: 0x97757e,
    textFaint: 0xb298a0,
    cardTitle: 0x5a4149,
    placeholderText: 0xfaf3f4,
    leader: 0xbb9aa2,
    axis: 0xd3b8b2,
    axisTick: 0xe0cac5,
    accent: 0xc26d84,
    thumbLoading: 0xe4d5d1,
    coverLoading: 0xe9dcd8,
    focusLoading: 0xe0d1cd,
    focusBackdropDim: 0xbcaeab,
    spanPalette: [
      0xc26d84, 0x7a9a8d, 0xcda05a, 0x9a7ab0, 0x8aa877, 0xb0677a, 0x7a8ab0, 0xcd8a5a,
      0x6f9a8a, 0xb85a6a,
    ],
    placeholderPalette: [
      0xb0908f, 0xa8909d, 0x9d90a8, 0x90a89b, 0xa89f90, 0x90a0a8, 0xab9689, 0x9e8f96,
    ],
  },
  fonts: {
    title: SERIF,
    body: SANS,
    caption: HANDWRITING,
    display: SERIF,
    paper: SERIF,
  },
}

/** Noir: minimaal zwart-wit. */
const NOIR: ResolvedTheme = {
  id: 'noir',
  name: 'Noir',
  uiMode: 'dark',
  background: { kind: 'solid' },
  colors: {
    appBg: 0x0d0d0d,
    surface: 0x1c1c1c,
    surfaceStroke: 0x343434,
    paper: 0xfafafa,
    paperStroke: 0xd4d4d4,
    paperInk: 0x1f1f1f,
    frame: 0xf5f5f5,
    text: 0xffffff,
    textBright: 0xe8e8e8,
    textSoft: 0xc4c4c4,
    textMuted: 0x8f8f8f,
    textFaint: 0x666666,
    cardTitle: 0xededed,
    placeholderText: 0xf0f0f0,
    leader: 0xbdbdbd,
    axis: 0x3d3d3d,
    axisTick: 0x2c2c2c,
    accent: 0xd0d0d0,
    thumbLoading: 0x2a2a2a,
    coverLoading: 0x161616,
    focusLoading: 0x222222,
    focusBackdropDim: 0x5c5c5c,
    spanPalette: [
      0xb8b8b8, 0x8a8a8a, 0xd4d4d4, 0x767676, 0xa0a0a0, 0xc6c6c6, 0x828282, 0xaeaeae,
      0x929292, 0xbcbcbc,
    ],
    placeholderPalette: [
      0x3a3a3a, 0x444444, 0x505050, 0x2f2f2f, 0x484848, 0x3e3e3e, 0x545454, 0x353535,
    ],
  },
  fonts: {
    title: SANS,
    body: SANS,
    caption: SANS,
    display: SANS,
    paper: 'Georgia, serif',
  },
}

/** Alle thema's, in de volgorde van de kiezer (ingetogen → sfeervol). */
export const THEMES: ResolvedTheme[] = [
  CLASSIC_DARK,
  CLASSIC_LIGHT,
  WARM_LINEN,
  KRAFT,
  KODACHROME,
  OCEAN,
  DUSTY_ROSE,
  NOIR,
]

/** Thema op id, met stille fallback naar de default (tolerantie-principe:
 * een onbekende id uit oudere/nieuwere data mag nooit crashen). */
export function themeById(id: string | undefined | null): ResolvedTheme {
  return THEMES.find((t) => t.id === id) ?? CLASSIC_DARK
}
