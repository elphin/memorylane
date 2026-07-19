// Gebundelde thema-fonts (alle onder de SIL Open Font License, zie
// src/assets/fonts/OFL-LICENSES.md). Eager geladen bij app-start — bewust
// niet lazy: vanaf fase 3 rendert één lifeline-scene fonts uit meerdere
// jaar-thema's tegelijk en zou een lazy geladen font geen herteken-trigger
// hebben. Lora en Caveat zijn variable fonts (één bestand dekt weight
// 400–700); Courier Prime heeft losse 400/700-cuts.

interface BundledFont {
  family: string
  url: string
  weight: string
  style: string
}

const FONT_FILES: BundledFont[] = [
  {
    family: 'Lora',
    url: new URL('../assets/fonts/lora-400-700.woff2', import.meta.url).href,
    weight: '400 700',
    style: 'normal',
  },
  {
    family: 'Lora',
    url: new URL('../assets/fonts/lora-italic-400.woff2', import.meta.url).href,
    weight: '400',
    style: 'italic',
  },
  {
    family: 'Courier Prime',
    url: new URL('../assets/fonts/courier-prime-400.woff2', import.meta.url).href,
    weight: '400',
    style: 'normal',
  },
  {
    family: 'Courier Prime',
    url: new URL('../assets/fonts/courier-prime-700.woff2', import.meta.url).href,
    weight: '700',
    style: 'normal',
  },
  {
    family: 'Caveat',
    url: new URL('../assets/fonts/caveat-400-700.woff2', import.meta.url).href,
    weight: '400 700',
    style: 'normal',
  },
]

let loading: Promise<void> | null = null

/** Laadt alle gebundelde thema-fonts (idempotent). Een font-fout mag de app
 * nooit blokkeren: dan rendert de systeem-fallback uit de font-stack. De
 * aanroeper wacht hierop (met een korte timeout-race) vóór de eerste
 * scene-opbouw, zodat Pixi `Text` meteen met de juiste metrics meet. */
export function loadThemeFonts(): Promise<void> {
  if (!loading) {
    loading = Promise.all(
      FONT_FILES.map(async (f) => {
        const face = new FontFace(f.family, `url(${f.url})`, {
          weight: f.weight,
          style: f.style,
        })
        await face.load()
        document.fonts.add(face)
      }),
    ).then(
      () => undefined,
      () => undefined,
    )
  }
  return loading
}
