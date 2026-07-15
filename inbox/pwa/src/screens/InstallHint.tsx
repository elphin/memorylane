// "Zet op je beginscherm"-hint (§6.1). Doel: dead-simpel, Don't-Make-Me-Think.
// - Al geïnstalleerd (standalone)? → toont niets.
// - Android/Chrome: vangt het native install-event → één knop "Toevoegen".
// - iPhone (Safari kan dit niet programmatisch): glashelder 2-stappen-instructie.
// - Weggeklikt wordt onthouden, zodat het niet blijft zeuren.

import { useEffect, useState } from 'react'

const DISMISS_KEY = 'ml-install-hint-dismissed'

/** Het Chromium-installatie-event (niet in de standaard TS-lib). */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  )
}

function isIOS(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent)
}

export function InstallHint() {
  const [installed, setInstalled] = useState(isStandalone)
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === '1'
    } catch {
      return false
    }
  })
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null)

  useEffect(() => {
    const onPrompt = (e: Event): void => {
      e.preventDefault() // wij tonen zelf een knop
      setDeferred(e as BeforeInstallPromptEvent)
    }
    const onInstalled = (): void => setInstalled(true)
    window.addEventListener('beforeinstallprompt', onPrompt)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  if (installed || dismissed) return null

  function dismiss(): void {
    setDismissed(true)
    try {
      localStorage.setItem(DISMISS_KEY, '1')
    } catch {
      /* privémodus e.d. — dan gewoon voor deze sessie weg */
    }
  }

  async function install(): Promise<void> {
    if (!deferred) return
    await deferred.prompt()
    try {
      await deferred.userChoice
    } catch {
      /* keuze niet leesbaar — geeft niet */
    }
    setDeferred(null)
    dismiss() // het event vuurt maar één keer
  }

  const ios = isIOS()

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        padding: '12px 14px',
        borderRadius: 12,
        background: 'var(--accent-soft)',
        border: '1px solid var(--accent)',
      }}
    >
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 600 }}>📲 Zet MemoryLane op je beginscherm</div>
        {ios ? (
          <div className="muted" style={{ fontSize: 13, marginTop: 4, lineHeight: 1.45 }}>
            1. Tik onderin op het <b>deel-knopje</b> (een vierkantje met een pijltje omhoog ⬆︎).
            <br />
            2. Kies <b>‘Zet op beginscherm’</b> en tik op <b>Voeg toe</b>.
            <br />
            Daarna open je MemoryLane als een gewone app — geen adres meer nodig.
          </div>
        ) : deferred ? (
          <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
            Eén tik en je opent 'm voortaan als een gewone app — geen adres meer nodig.
          </div>
        ) : (
          <div className="muted" style={{ fontSize: 13, marginTop: 4, lineHeight: 1.45 }}>
            Open het menu van je browser (het <b>⋮</b>-knopje) en kies <b>‘App installeren’</b> of{' '}
            <b>‘Toevoegen aan startscherm’</b>.
          </div>
        )}
        {deferred && !ios && (
          <button className="btn btn-primary" style={{ marginTop: 10 }} onClick={() => void install()}>
            Op beginscherm zetten
          </button>
        )}
      </div>
      <button
        aria-label="Verbergen"
        onClick={dismiss}
        style={{ background: 'none', border: 0, color: 'var(--ink)', fontSize: 20, lineHeight: 1, cursor: 'pointer', padding: 2 }}
      >
        ×
      </button>
    </div>
  )
}
