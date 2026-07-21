// Cascade-resolver (personalisatie-plan §4.2): app-default → jaar → event.
// Elk niveau kan een ThemeChoice hebben: eerst wordt (indien aanwezig en
// bekend) het `id` toegepast — de volledige tokenset van dat thema — en
// daarna de losse overrides van dát niveau (accent, titleFont, background).
// Onbekende id's of waarden vallen stil terug (tolerantie-principe:
// oudere/nieuwere vault-data mag nooit crashen).
//
// Geen cache: resolutie gebeurt alleen bij scene-(her)bouw — hooguit enkele
// tientallen aanroepen per navigatie, elk een paar object-spreads.

import { THEMES, themeById } from './registry'
import { BACKGROUNDS, BACKGROUND_NONE } from './textures'
import { THEME, cloneTheme, type FrameStyle, type ResolvedTheme } from './tokens'

/** Structureel gelijk aan `ThemeChoice` uit de backend (frontmatter-wire);
 * hier los gedefinieerd zodat de theme-laag niet aan de backend hangt. */
export interface ThemeChoiceLike {
  id?: string
  accent?: string
  background?: string
  titleFont?: string
}

/** Gecureerde titel-font-opties voor de override-kiezer (id's zijn de
 * waarden die in de frontmatter belanden). */
export const TITLE_FONTS: { id: string; name: string; stack: string }[] = [
  { id: 'sans', name: 'Modern', stack: 'Segoe UI, sans-serif' },
  { id: 'serif', name: 'Serif', stack: 'Lora, Georgia, serif' },
  { id: 'typewriter', name: 'Typemachine', stack: 'Courier Prime, Courier New, monospace' },
  { id: 'handwriting', name: 'Handschrift', stack: 'Caveat, Segoe Script, cursive' },
]

/** Gecureerde accent-swatches voor de override-kiezer ('#rrggbb'). */
// Gecureerd accent-palet: warm → koel → warm, met genoeg variatie (rood, oranje,
// amber/goud, groen, groenblauw, blauw, paars, roze, bruin). Iets gedempt zodat
// ze bij de fotoalbum-sfeer passen maar toch duidelijk als accent leesbaar zijn.
export const ACCENT_SWATCHES: string[] = [
  '#c0392b', // baksteenrood
  '#d1553f', // terracotta
  '#e07b39', // oranje
  '#d98e32', // amber
  '#d4a13a', // goud
  '#b8a24a', // mosterd
  '#7fa05e', // olijf
  '#4a9e6f', // groen
  '#2fa88f', // smaragd
  '#39b8a6', // groenblauw
  '#3b82c4', // blauw
  '#6ea8ff', // lavendelblauw
  '#7c66f0', // paars
  '#9b6dd4', // lavendel
  '#b45fa8', // orchidee
  '#c26d84', // roze
  '#d1637a', // framboos
  '#a0664a', // bruin
]

/** '#rrggbb' → Pixi-hex, of null bij een ongeldige waarde (stil negeren). */
function parseHex(s: string | undefined): number | null {
  if (!s || !/^#[0-9a-fA-F]{6}$/.test(s)) return null
  return parseInt(s.slice(1), 16)
}

/** Past één ThemeChoice toe op een basis-thema (kloont alleen bij effect). */
export function applyChoice(base: ResolvedTheme, choice?: ThemeChoiceLike | null): ResolvedTheme {
  if (!choice) return base
  let t = base
  if (choice.id && THEMES.some((x) => x.id === choice.id)) t = themeById(choice.id)
  const accent = parseHex(choice.accent)
  const font = TITLE_FONTS.find((f) => f.id === choice.titleFont)?.stack
  // `background`-override: 'none' dwingt effen af; een gecureerde textuur-id
  // kiest die textuur (getint met de appBg); onbekende waarden stil negeren.
  const bg = choice.background
  const bgValid = bg === BACKGROUND_NONE || BACKGROUNDS.some((b) => b.id === bg)
  if (accent === null && !font && t === base && !bgValid) return base
  const out = cloneTheme(t)
  if (accent !== null) out.colors.accent = accent
  if (font) {
    out.fonts.title = font
    out.fonts.display = font
  }
  if (bgValid) {
    out.background =
      bg === BACKGROUND_NONE ? { kind: 'solid' } : { kind: 'texture', textureId: bg!, tint: out.colors.appBg }
  }
  return out
}

/** Resolven vanaf het actieve app-thema, met de keuzes van boven naar
 * beneden (jaar eerst, dan event). */
export function resolveTheme(...choices: (ThemeChoiceLike | undefined | null)[]): ResolvedTheme {
  let t: ResolvedTheme = THEME
  for (const c of choices) t = applyChoice(t, c)
  return t
}

/** Gecureerde kader-stijlen voor de per-item-kiezer (fase 5). */
export const FRAME_STYLES: { id: FrameStyle; name: string }[] = [
  { id: 'plain', name: 'Kader' },
  { id: 'polaroid', name: 'Polaroid' },
  { id: 'rounded', name: 'Afgerond' },
  { id: 'none', name: 'Geen' },
]

/** Kader-stijl van een item: geldige item-keuze wint, anders de thema-default.
 * Onbekende waarden (oudere/nieuwere data) vallen stil terug op het thema. */
export function resolveFrameStyle(itemFrame: string | undefined | null, t: ResolvedTheme): FrameStyle {
  return FRAME_STYLES.some((f) => f.id === itemFrame) ? (itemFrame as FrameStyle) : t.frameStyle
}
