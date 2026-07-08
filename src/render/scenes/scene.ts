// Gemeenschappelijke scene-interface. De app-shell houdt één actieve scene aan;
// de engine roept elke frame `update` aan en routeert taps naar `hitTest`.

import type { FrameContext } from '../core/engine'

export interface Scene {
  update(ctx: FrameContext): void
  /** Geeft een id terug voor het geraakte object (jaar/event), of null. */
  hitTest?(worldX: number, worldY: number): string | null
  /** Id van het momenteel gefocuste item (alleen L3), voor bijv. verwijderen. */
  currentId?(): string | null
  destroy(): void
}
