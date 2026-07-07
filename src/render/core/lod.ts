// Level-of-detail: vertaalt continue zoom naar discrete banden (L0–L3) met
// hysterese (verschillende op-/afschakeldrempels) zodat een band niet flikkert
// rond een grens, plus een crossfade bij een bandwissel.

export type Band = 0 | 1 | 2 | 3

// Zoom (pixels per wereld-eenheid) waarbij naar een hogere band wordt geschakeld.
// Afschakelen gebeurt lager → hysterese. Waarden worden in fase 5 op echte
// content afgestemd.
const UP = [0.15, 0.6, 3.0] // band i → i+1 als zoom ≥ UP[i]
const DOWN = [0.1, 0.4, 2.0] // band i → i-1 als zoom < DOWN[i-1]

export class LodManager {
  band: Band = 0
  prevBand: Band = 0
  /** 1 = volledig op `band`; <1 = `prevBand` faadt nog uit. */
  fade = 1
  private fadeSpeed = 0.12

  update(zoom: number): void {
    const next = this.resolve(zoom)
    if (next !== this.band) {
      this.prevBand = this.band
      this.band = next
      this.fade = 0
    }
    if (this.fade < 1) {
      this.fade = Math.min(1, this.fade + this.fadeSpeed)
    }
  }

  get transitioning(): boolean {
    return this.fade < 1
  }

  /** Bepaalt de doelband met hysterese, vertrekkend vanaf de huidige band. */
  private resolve(zoom: number): Band {
    let b: number = this.band
    // Omhoog schakelen zolang de bovengrens overschreden wordt.
    while (b < 3 && zoom >= UP[b]) b++
    // Omlaag schakelen zolang onder de (lagere) ondergrens.
    while (b > 0 && zoom < DOWN[b - 1]) b--
    return b as Band
  }
}
