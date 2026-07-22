// Service-worker-updatebeheer. In 'prompt'-modus (zie vite.config) wacht een
// nieuwe versie tot de gebruiker 'm toepast — geen verrassende auto-herlaad.
// Vervelend op een iPhone-beginscherm-PWA: geen adresbalk = geen pull-to-refresh,
// en de app blijft vaak in het geheugen. Daarom:
//  - bij het openen én zodra de app weer zichtbaar wordt checken we op updates;
//  - is er een nieuwe versie klaar? → de app toont een "Vernieuwen"-balk;
//  - er is ook een handmatige "App vernieuwen" (Instellingen) als vangnet.
import { registerSW } from 'virtual:pwa-register'

let updateSW: ((reload?: boolean) => Promise<void>) | null = null
let registered = false
let pending = false // er staat een update klaar (ook als er nog geen luisteraar was)
const listeners = new Set<() => void>()

/** Abonneer op "nieuwe versie beschikbaar". Krijgt 'ie meteen als er al één klaar
 * staat (voorkomt een gemiste melding als de SW-callback vóór React vuurde). */
export function onNeedRefresh(cb: () => void): () => void {
  listeners.add(cb)
  if (pending) cb()
  return () => listeners.delete(cb)
}

/** Eenmalig aanroepen bij het opstarten (vóór React). */
export function registerPwa(): void {
  if (registered) return
  registered = true
  updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      pending = true
      listeners.forEach((l) => l())
    },
    onRegisteredSW(_swUrl, reg) {
      if (!reg) return
      const check = (): void => {
        reg.update().catch(() => {
          /* offline of geen update — negeren */
        })
      }
      // Terug uit de achtergrond (iOS houdt de PWA in het geheugen) → opnieuw checken.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check()
      })
      // En af en toe terwijl de app open staat (rustig aan; iOS throttelt dit toch).
      setInterval(check, 5 * 60 * 1000)
    },
  })
}

/** Pas de klaarstaande nieuwe versie toe en herlaad (voor de "Vernieuwen"-balk). */
export function applyUpdate(): void {
  if (updateSW) void updateSW(true)
  else location.reload()
}

/** Handmatig vernieuwen: check op updates, wacht tot een nieuwe versie de controle
 * overneemt, en herlaad hoe dan ook zodat je zeker de laatste versie ziet. */
export async function refreshNow(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker?.getRegistration()
    if (reg) {
      await reg.update()
      if (reg.installing || reg.waiting) {
        reg.waiting?.postMessage({ type: 'SKIP_WAITING' })
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 3000) // vangnet als er geen controllerwissel komt
          navigator.serviceWorker.addEventListener(
            'controllerchange',
            () => {
              clearTimeout(t)
              resolve()
            },
            { once: true },
          )
        })
      }
    }
  } catch {
    /* geen SW / offline — dan gewoon herladen */
  }
  location.reload()
}
