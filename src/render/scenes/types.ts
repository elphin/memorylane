// Gedeelde types voor de tijdlijn-scenes.

export type ItemType = 'text' | 'photo' | 'video' | 'link' | 'audio'

/** Zoomniveaus (semantic zoom). */
export enum Level {
  Lifeline = 0, // L0: alle jaren
  Year = 1, // L1: één jaar
  Canvas = 2, // L2: één event (fase 6)
  Focus = 3, // L3: één item (fase 7)
}
