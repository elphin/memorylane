// Gedeelde types voor de tijdlijn-scenes.

export type ItemType = 'text' | 'photo' | 'video' | 'link' | 'audio' | 'song'

/** Itemtypes die geluid dragen: een liedje (`song`) of een losse opname (`audio`).
 *
 * Bepaalt of dit item AUDIO-UI krijgt (geluidskaart, afspeelknop, automatisch
 * starten). NOOIT gebruiken om te beslissen of er een afbeelding is — daarvoor is
 * uitsluitend `thumbRef` er. Die twee vragen lopen uiteen: een `song` met
 * `media: hoes.jpg` (link-only liedje, of een typefout) is wél geluid-UI en heeft
 * wél een plaatje. Op het type beslissen in plaats van op de bestandsextensie was
 * precies de bug die de review van fase 1a ving. */
export const isSound = (t: ItemType): boolean => t === 'song' || t === 'audio'

/** Zoomniveaus (semantic zoom). */
export enum Level {
  Lifeline = 0, // L0: alle jaren
  Year = 1, // L1: één jaar
  Canvas = 2, // L2: één event (fase 6)
  Focus = 3, // L3: één item (fase 7)
}
