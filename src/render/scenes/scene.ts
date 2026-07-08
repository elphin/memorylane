// Gemeenschappelijke scene-interface. De app-shell houdt één actieve scene aan;
// de engine roept elke frame `update` aan en routeert taps naar `hitTest`.

import type { Container } from 'pixi.js'
import type { FrameContext } from '../core/engine'

export interface Scene {
  /** Root-container van de scene (voor de reveal-transitie). */
  readonly root: Container
  update(ctx: FrameContext): void
  /** Geeft een id terug voor het geraakte object (jaar/event), of null. */
  hitTest?(worldX: number, worldY: number): string | null
  /** Id van het momenteel gefocuste item (alleen L3), voor bijv. verwijderen. */
  currentId?(): string | null
  /** Muis-hover op een wereldpunt (of null bij verlaten) — voor micro-animaties. */
  onHover?(worldX: number | null, worldY: number): void
  destroy(): void
}
