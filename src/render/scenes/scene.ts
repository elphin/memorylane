// Gemeenschappelijke scene-interface. De app-shell houdt één actieve scene aan;
// de engine roept elke frame `update` aan en routeert taps naar `hitTest`.

import type { Container } from 'pixi.js'
import type { Item } from '../../lib/backend'
import type { FrameContext } from '../core/engine'
import type { DragHandle } from '../core/gestures'

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
  /** Toon/verberg de Ctrl-dag-indicator (alleen L1-jaar). */
  setDayPicker?(active: boolean): void
  /** Datum (`YYYY-MM-DD`) onder een wereld-x op de as (alleen L1-jaar). */
  dateAt?(worldX: number): string
  /** Toon/verberg de Ctrl-sleep-selectie (begin→eind) op de as (alleen L1-jaar). */
  setRange?(startWorldX: number | null, endWorldX: number | null): void
  /** Sleepbaar object onder het wereldpunt (bijv. een canvas-item op L2). */
  beginDrag?(worldX: number, worldY: number): DragHandle | null
  /** Zet de uitgelichte foto (op ref) en werk de markering bij (alleen L2). */
  setFeatured?(ref: string | null): void
  /** Ref (slug/id) van de foto onder een wereldpunt, of null (alleen L2). */
  refAt?(worldX: number, worldY: number): string | null
  /** Herschik het event-canvas: 'custom' (eigen posities), 'grid' (chronologisch,
   * vierkant) of 'scatter' (speels kriskras — elke aanroep opnieuw). Alleen L2. */
  applyLayout?(mode: 'custom' | 'grid' | 'scatter'): void
  /** Laatst gefitte zoom (alleen L3): referentie voor de terug-uitzoom-drempel,
   * zodat sibling-nav naar grotere inhoud (lange notitie) niet meteen uitzoomt. */
  readonly baseZoom?: number
  /** Id van het momenteel gefocuste item (alleen L3), voor bijv. verwijderen. */
  currentId?(): string | null
  /** Muis-hover op een wereldpunt (of null bij verlaten) — voor micro-animaties. */
  onHover?(worldX: number | null, worldY: number): void
  destroy(): void
}
