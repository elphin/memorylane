import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { Pairing } from '../store/db'
import { clearPairing, getKv, setKv } from '../store/db'

type Theme = 'system' | 'light' | 'dark'

export function applyTheme(t: Theme): void {
  const el = document.documentElement
  if (t === 'system') el.removeAttribute('data-theme')
  else el.setAttribute('data-theme', t)
}

export function SettingsScreen({
  pairing,
  onBack,
  onRepair,
  onUnpaired,
  nav,
}: {
  pairing: Pairing
  onBack: () => void
  onRepair: () => void
  onUnpaired: () => void
  nav: ReactNode
}) {
  const [theme, setTheme] = useState<Theme>('system')

  useEffect(() => {
    void getKv<Theme>('theme').then((t) => {
      if (t) {
        setTheme(t)
        applyTheme(t)
      }
    })
  }, [])

  function chooseTheme(t: Theme): void {
    setTheme(t)
    applyTheme(t)
    void setKv('theme', t)
  }

  async function unpair(): Promise<void> {
    if (!confirm('Deze telefoon ontkoppelen? Je concepten blijven bewaard. Op de computer kun je het upload-token vernieuwen.')) return
    await clearPairing()
    onUnpaired()
  }

  return (
    <>
      {nav}
      <div className="screen stack">
        <h2 className="serif" style={{ margin: 0 }}>
          Instellingen
        </h2>

        <div className="card">
          <div className="label">Gekoppelde brievenbus</div>
          <div style={{ fontVariantNumeric: 'tabular-nums' }}>{pairing.mailboxId.slice(0, 8)}…</div>
          <div className="muted" style={{ wordBreak: 'break-all' }}>{pairing.serverUrl}</div>
        </div>

        <div className="card stack">
          <div className="label">Thema</div>
          <div style={{ display: 'flex', gap: 8 }}>
            {(['system', 'light', 'dark'] as Theme[]).map((t) => (
              <button
                key={t}
                className="chip"
                style={{ flex: 1, justifyContent: 'center', background: theme === t ? 'var(--accent-soft)' : undefined }}
                onClick={() => chooseTheme(t)}
              >
                {t === 'system' ? 'Systeem' : t === 'light' ? 'Licht' : 'Donker'}
              </button>
            ))}
          </div>
        </div>

        <button className="btn" onClick={onBack}>
          Terug
        </button>
        <button className="btn btn-ghost" onClick={onRepair}>
          Opnieuw koppelen (scan code)
        </button>
        <div className="muted" style={{ fontSize: 12, marginTop: -4 }}>
          Nieuwe koppelcode op de computer gemaakt, of deze app zonder koppeling geopend? Scan hier de
          QR-code opnieuw — je concepten blijven bewaard.
        </div>
        <button className="btn btn-ghost" style={{ color: 'var(--danger)' }} onClick={() => void unpair()}>
          Ontkoppelen
        </button>
        <div className="muted" style={{ textAlign: 'center' }}>MemoryLane Onderweg · v0.1.0</div>
      </div>
    </>
  )
}
