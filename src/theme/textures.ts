// Gecureerde achtergrond-texturen (fase 4): kleine naadloze, bijna-witte
// tiles (webp, procedureel gegenereerd — licentievrij) die door de engine als
// TilingSprite achter de wereld worden gelegd en met de thema-appBg worden
// getint. Ze worden geladen via Pixi Assets en blijven in bezit van deze
// module-cache — bewust NIET via de TextureManager (dat is een LRU met
// eviction voor item-thumbnails; een geëvicte achtergrond zou flitsen).

import { Assets, Texture } from 'pixi.js'

export const BACKGROUNDS: { id: string; name: string; url: string }[] = [
  { id: 'linen', name: 'Linnen', url: new URL('../assets/textures/linen.webp', import.meta.url).href },
  { id: 'kraft', name: 'Kraft-papier', url: new URL('../assets/textures/kraft.webp', import.meta.url).href },
  { id: 'watercolor', name: 'Aquarel', url: new URL('../assets/textures/watercolor.webp', import.meta.url).href },
  { id: 'grain', name: 'Korrel', url: new URL('../assets/textures/grain.webp', import.meta.url).href },
]

/** Geldige waarde voor de `background`-override náást de textuur-id's:
 * dwingt effen af, ook als het thema zelf een textuur heeft. */
export const BACKGROUND_NONE = 'none'

const cache = new Map<string, Promise<Texture | null>>()

/** Laadt (en cachet) een achtergrondtextuur; onbekende id of laad-fout →
 * null (de effen appBg blijft dan gewoon staan — nooit een kapotte laag). */
export function loadBackgroundTexture(id: string): Promise<Texture | null> {
  let p = cache.get(id)
  if (!p) {
    const def = BACKGROUNDS.find((b) => b.id === id)
    p = def
      ? Assets.load<Texture>(def.url).then(
          (tex) => {
            // Naadloos tilen vereist wrap-modus repeat op de bron.
            tex.source.addressMode = 'repeat'
            return tex
          },
          () => {
            // Transiente laad-fout niet permanent cachen: een volgende
            // navigatie probeert het gewoon opnieuw.
            cache.delete(id)
            return null
          },
        )
      : Promise.resolve<Texture | null>(null)
    cache.set(id, p)
  }
  return p
}
