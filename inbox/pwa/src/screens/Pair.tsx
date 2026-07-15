import { useState } from 'react'
import type { PairLink } from '../App'
import { setPairing, type Pairing } from '../store/db'
import { verifyPairing } from '../api/client'

export function PairScreen({
  link,
  existing,
  expiredNotice,
  onPaired,
  onCancel,
}: {
  link: PairLink | null
  existing: Pairing | null
  expiredNotice?: boolean
  onPaired: (p: Pairing) => void
  onCancel: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function confirm(): Promise<void> {
    if (!link) return
    setBusy(true)
    setError(null)
    const p: Pairing = {
      serverUrl: location.origin,
      mailboxId: link.mailboxId,
      uploadToken: link.token,
      masterKeyHex: link.masterKeyHex,
    }
    try {
      await verifyPairing(p) // controleer token + server
      await setPairing(p)
      onPaired(p)
    } catch {
      setError('Koppelen mislukte. Klopt de code en heb je internet?')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="screen stack" style={{ paddingTop: 32 }}>
      <img src="/icon.svg" width={72} height={72} alt="" style={{ borderRadius: 18 }} />
      <h1 className="serif" style={{ margin: 0 }}>
        MemoryLane Onderweg
      </h1>

      {expiredNotice && (
        <div className="card" style={{ borderColor: 'var(--accent)' }}>
          De koppeling is op de computer vernieuwd. Scan de nieuwe code om weer te verbinden — je
          concepten blijven bewaard.
        </div>
      )}

      {link ? (
        <>
          <p className="muted">
            {existing ? 'Wil je de bestaande koppeling vervangen door deze nieuwe code?' : 'Koppel deze telefoon aan je MemoryLane op de computer.'}
          </p>
          <div className="card muted">Brievenbus: {link.mailboxId.slice(0, 8)}…</div>
          {error && <div className="err">{error}</div>}
          <button className="btn btn-primary" onClick={() => void confirm()} disabled={busy}>
            {busy ? 'Koppelen…' : existing ? 'Vervang koppeling' : 'Koppel deze telefoon'}
          </button>
          {existing && (
            <button className="btn btn-ghost" onClick={onCancel} disabled={busy}>
              Annuleren
            </button>
          )}
        </>
      ) : (
        <>
          <p className="muted">
            Nog niet gekoppeld. Open op je computer <b>Instellingen → Telefoon</b> in MemoryLane en
            scan daar de QR-code met de camera van je telefoon. Deze pagina opent dan vanzelf met de
            koppelcode.
          </p>
          <div className="card muted">
            Tip: zodra je gekoppeld bent, zet je deze app op je beginscherm (deelknop → “Zet op
            beginscherm”) zodat 'ie snel bij de hand is.
          </div>
        </>
      )}
    </div>
  )
}
