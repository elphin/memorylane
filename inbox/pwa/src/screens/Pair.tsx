import { useState } from 'react'
import type { PairLink } from '../pair'
import { parsePairText } from '../pair'
import { setPairing, type Pairing } from '../store/db'
import { verifyPairing } from '../api/client'
import { ScanQr } from './ScanQr'

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
  const [scanning, setScanning] = useState(false)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')

  // Koppel met een (uit fragment, scan of plak) verkregen koppelcode. De
  // serverUrl komt ALTIJD van location.origin — nooit uit de gescande tekst
  // (zie pair.ts). verifyPairing controleert token + server; pas daarna bewaren.
  async function pairWith(pl: PairLink): Promise<void> {
    if (busy) return
    setBusy(true)
    setError(null)
    const p: Pairing = {
      serverUrl: location.origin,
      mailboxId: pl.mailboxId,
      uploadToken: pl.token,
      masterKeyHex: pl.masterKeyHex,
    }
    try {
      await verifyPairing(p)
      await setPairing(p)
      onPaired(p)
    } catch {
      setError('Koppelen mislukte. Klopt de code en heb je internet?')
    } finally {
      setBusy(false)
    }
  }

  function onScanResult(text: string): void {
    setScanning(false)
    const pl = parsePairText(text)
    if (pl) void pairWith(pl)
    else setError('Dat is geen geldige MemoryLane-koppelcode.')
  }

  function submitPaste(): void {
    const pl = parsePairText(pasteText)
    if (pl) void pairWith(pl)
    else setError('Dat is geen geldige MemoryLane-koppelcode.')
  }

  return (
    <div className="screen stack" style={{ paddingTop: 32 }}>
      {scanning && (
        <ScanQr
          accept={(t) => parsePairText(t) !== null}
          onResult={onScanResult}
          onClose={() => setScanning(false)}
        />
      )}

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
        // Binnengekomen via de QR-link (browser): één bevestiging.
        <>
          <p className="muted">
            {existing
              ? 'Wil je de bestaande koppeling vervangen door deze nieuwe code?'
              : 'Koppel deze telefoon aan je MemoryLane op de computer.'}
          </p>
          <div className="card muted">Brievenbus: {link.mailboxId.slice(0, 8)}…</div>
          {error && <div className="err">{error}</div>}
          <button className="btn btn-primary" onClick={() => void pairWith(link)} disabled={busy}>
            {busy ? 'Koppelen…' : existing ? 'Vervang koppeling' : 'Koppel deze telefoon'}
          </button>
          {existing && (
            <button className="btn btn-ghost" onClick={onCancel} disabled={busy}>
              Annuleren
            </button>
          )}
        </>
      ) : (
        // Geen fragment (o.a. de op het beginscherm geïnstalleerde app): koppel
        // hier door de QR van de computer te scannen, of de code te plakken.
        <>
          <p className="muted">
            {existing
              ? 'Verbind opnieuw: scan de QR-code op je computer.'
              : 'Koppel deze telefoon aan je MemoryLane op de computer.'}
          </p>

          {error && <div className="err">{error}</div>}

          <button className="btn btn-primary" onClick={() => setScanning(true)} disabled={busy}>
            {busy ? 'Koppelen…' : '📷 Scan koppelcode'}
          </button>

          {!pasteOpen ? (
            <button
              className="btn btn-ghost"
              onClick={() => {
                setPasteOpen(true)
                setError(null)
              }}
              disabled={busy}
            >
              Of plak de code
            </button>
          ) : (
            <div className="card stack">
              <div className="label">Plak de koppelcode</div>
              <textarea
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                placeholder="Plak hier de code van je computer"
                rows={3}
                spellCheck={false}
                autoCapitalize="off"
                style={{ width: '100%', boxSizing: 'border-box', resize: 'vertical', font: '13px monospace' }}
              />
              <button className="btn btn-primary" onClick={submitPaste} disabled={busy || !pasteText.trim()}>
                {busy ? 'Koppelen…' : 'Koppel'}
              </button>
            </div>
          )}

          {existing && (
            <button className="btn btn-ghost" onClick={onCancel} disabled={busy}>
              Annuleren
            </button>
          )}

          <div className="card muted" style={{ fontSize: 13, lineHeight: 1.5 }}>
            Open op je computer <b>Instellingen → Telefoon</b> in MemoryLane en tik op{' '}
            <b>Toon QR-code</b>. Scan die met de knop hierboven.
            <br />
            <br />
            Tip: zet deze app op je beginscherm (deelknop → “Zet op beginscherm”), open 'm daar, en
            koppel dan één keer met <b>Scan koppelcode</b>. Op het beginscherm heeft de app zijn eigen
            geheugen, dus die koppeling doe je apart.
          </div>
        </>
      )}
    </div>
  )
}
