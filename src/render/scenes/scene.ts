// Gemeenschappelijke scene-interface. De app-shell houdt één actieve scene aan;
// de engine roept elke frame `update` aan en routeert taps naar `hitTest`.

import type { Container } from 'pixi.js'
import type { Item } from '../../lib/backend'
import type { FrameContext } from '../core/engine'
import type { DragHandle } from '../core/gestures'

/** Positie/rotatie/z van één canvas-item — voor het onthouden van een
 * scatter/grid-opstelling per event (los van de vault-`_canvas.json`). */
export interface NodePosition {
  ref: string
  x: number
  y: number
  rot: number
  z: number
}

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
  /** Herfit de camera op het huidige item (alleen L3-focus), bv. na (uit)
   * fullscreen gaan. */
  refitToViewport?(): void
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
  /** Roteer/schaal de foto onder het wereldpunt (Alt-/Shift-slepen, alleen L2 in de
   * eigen layout). Geeft een DragHandle of null als er niets te pakken is. */
  beginTransform?(worldX: number, worldY: number, kind: 'rotate' | 'scale'): DragHandle | null
  /** Shift-slepen op een event-kaart wijzigt zijn belang/grootte (alleen L1-jaar).
   * Geeft een DragHandle of null als er geen kaart onder het punt zit. */
  beginResize?(worldX: number, worldY: number): DragHandle | null
  /** Zet de uitgelichte foto (op ref) en werk de markering bij (alleen L2). */
  setFeatured?(ref: string | null): void
  /** Zet de vaste jaar-cover (op item-id) en werk de blauwe rand bij (alleen L2). */
  setYearFeatured?(itemId: string | null): void
  /** Toon de featured-randen alleen terwijl de bijbehorende toets(en) ingedrukt
   * zijn: Ctrl = gouden memory-cover, Ctrl+Shift = blauwe jaar-cover (alleen L2). */
  setRingKeys?(ctrl: boolean, shift: boolean): void
  /** Ref (slug/id) van de foto onder een wereldpunt, of null (alleen L2). */
  refAt?(worldX: number, worldY: number): string | null
  /** Herschik het event-canvas: 'custom' (eigen posities), 'grid' (chronologisch,
   * vierkant) of 'scatter' (speels kriskras — elke aanroep opnieuw). `snap` zet de
   * kaarten meteen op hun plek (geen animatie), voor de eerste opbouw. Alleen L2. */
  applyLayout?(mode: 'custom' | 'grid' | 'scatter', snap?: boolean, scatterRotate?: boolean): void
  /** Herstel expliciete posities (een onthouden scatter/grid per event). Items
   * zonder opgeslagen positie (later toegevoegd) worden bij het zwaartepunt
   * geplaatst. Geeft terug hoeveel er matchten en het totaal. Alleen L2. */
  applyPositions?(
    mode: 'grid' | 'scatter',
    positions: NodePosition[],
    snap?: boolean,
  ): { matched: number; total: number }
  /** Huidige layout-stand + doelposities + grid-sortering (voor het onthouden per
   * event). Alleen L2. */
  layoutState?(): {
    mode: 'custom' | 'grid' | 'scatter'
    positions: NodePosition[]
    gridSort: 'date' | 'name' | 'random'
    gridSeed: number
  }
  /** Herstel een onthouden grid-sortering (sort + seed) zonder te herpakken (L2). */
  restoreGridSort?(sort: 'date' | 'name' | 'random', seed: number): void
  /** Zet de scatter-kaarten recht of licht scheef, posities ongemoeid (alleen L2). */
  setScatterRotation?(rotate: boolean): void
  /** Zet de grid-sorteervolgorde (datum/naam/willekeurig) en herpak; 'random'
   * schudt elke aanroep opnieuw (alleen L2). */
  setGridSort?(sort: 'date' | 'name' | 'random'): void
  /** Wereldgrenzen van alle inhoud (voor fit-to-view), of null als leeg. Alleen L2. */
  contentBounds?(): { minX: number; minY: number; maxX: number; maxY: number } | null
  /** Zoom/pan de camera zo dat alle inhoud precies past (alleen L2). */
  fitToView?(): void
  /** Leg de huidige opstelling vast als de eigen layout (alleen L2). */
  saveAsCustom?(): void
  /** Laatst gefitte zoom (alleen L3): referentie voor de terug-uitzoom-drempel,
   * zodat sibling-nav naar grotere inhoud (lange notitie) niet meteen uitzoomt. */
  readonly baseZoom?: number
  /** Id van het momenteel gefocuste item (alleen L3), voor bijv. verwijderen. */
  currentId?(): string | null
  /** Het momenteel gefocuste item (alleen L3) — voor de video-overlay (type). */
  currentItem?(): Item | null
  /** CSS-schermrechthoek van het gefocuste item (alleen L3), of null. Alleen
   * betrouwbaar buiten een transitie. Voor het plaatsen van de DOM-video. */
  screenRect?(): { left: number; top: number; width: number; height: number } | null
  /** Zet de werkelijke video-verhouding (b/h) voor een exacte overlay (alleen L3). */
  setVideoAspect?(aspect: number | null): void
  /** Verberg/toon de Pixi-inhoud tijdens DOM-video-afspelen (alleen L3). */
  setContentHidden?(hidden: boolean): void
  /** Muis-hover op een wereldpunt (of null bij verlaten) — voor micro-animaties. */
  onHover?(worldX: number | null, worldY: number): void
  destroy(): void
}
