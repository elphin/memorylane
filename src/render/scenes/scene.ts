// Gemeenschappelijke scene-interface. De app-shell houdt één actieve scene aan;
// de engine roept elke frame `update` aan en routeert taps naar `hitTest`.

import type { Container } from 'pixi.js'
import type { Item } from '../../lib/backend'
import type { FrameContext } from '../core/engine'

export interface Scene {
  /** Root-container van de scene (voor de reveal-transitie). */
  readonly root: Container
  update(ctx: FrameContext): void
  /** Geeft het id terug van het item onder het wereldpunt, of null bij lege
   * ruimte. Puur (geen neveneffecten): de app-shell beslist wat een treffer of
   * een klik-in-het-luchtledige betekent. */
  hitTest?(worldX: number, worldY: number): string | null
  /** Ga naar de vorige/volgende sibling (alleen L3-focus). */
  step?(delta: number): void
  /** Ververs de item-data in-place (alleen L3-focus), na een bewerking. */
  refresh?(items: Item[]): void
  /** Laatst gefitte zoom (alleen L3): referentie voor de terug-uitzoom-drempel,
   * zodat sibling-nav naar grotere inhoud (lange notitie) niet meteen uitzoomt. */
  readonly baseZoom?: number
  /** Id van het momenteel gefocuste item (alleen L3), voor bijv. verwijderen. */
  currentId?(): string | null
  /** Muis-hover op een wereldpunt (of null bij verlaten) — voor micro-animaties. */
  onHover?(worldX: number | null, worldY: number): void
  destroy(): void
}
