import { useEffect, useRef, useState } from 'react'
import type { Pairing } from '../store/db'
import { AlreadyImportedError, runUpload, type Progress } from '../upload/queue'
import { ApiError } from '../api/client'
import { formatBytes } from '../util'
import { IconCheckCircle } from '../icons'

export function UploadView({
  pairing,
  prepare,
  onExpired,
  onDashboard,
  onDone,
  onBack,
}: {
  pairing: Pairing
  /** Zet de outbox-rij (met snapshot) klaar en geeft het memoryId. Wordt maar één
   * keer met succes aangeroepen; "Opnieuw proberen" hergebruikt het memoryId. */
  prepare: () => Promise<string>
  onExpired: () => void
  /** Naar het overzicht (dashboard). */
  onDashboard: () => void
  /** "Nog een memory" na succes (weggelaten = knop niet tonen). */
  onDone?: () => void
  /** Terug naar het formulier als voorbereiden mislukte (er is nog niets verplaatst). */
  onBack: () => void
}) {
  const [progress, setProgress] = useState<Progress | null>(null)
  const [state, setState] = useState<'running' | 'done' | 'error'>('running')
  const [error, setError] = useState('')
  const [final, setFinal] = useState(false) // fout waarbij opnieuw proberen geen zin heeft
  const memoryId = useRef<string | null>(null) // stabiel over retries → idempotent op de server
  // Eén voorbereiding per scherm, ook als React (StrictMode) het effect dubbel draait:
  // twee keer prepare() zou twee memories met elk een eigen id opleveren.
  const prepRef = useRef<Promise<string> | null>(null)
  const started = useRef(false)

  async function start(): Promise<void> {
    setState('running')
    setError('')
    try {
      if (!memoryId.current) {
        prepRef.current ??= prepare()
        try {
          memoryId.current = await prepRef.current
        } catch (e) {
          prepRef.current = null // mislukt → "Opnieuw proberen" mag opnieuw voorbereiden
          throw e
        }
      }
      await runUpload(pairing, memoryId.current, setProgress)
      setState('done')
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        onExpired()
        return
      }
      setFinal(e instanceof AlreadyImportedError)
      // fetch gooit een kale TypeError ("Failed to fetch"/"Load failed") als de
      // brievenbus onbereikbaar is; dat vertalen we naar gewone taal.
      setError(
        e instanceof TypeError
          ? 'Geen verbinding met de brievenbus. Controleer je internet en probeer het opnieuw.'
          : e instanceof Error
            ? e.message
            : String(e),
      )
      setState('error')
    }
  }

  useEffect(() => {
    if (started.current) return
    started.current = true
    void start()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const pct = progress && progress.bytesTotal > 0 ? Math.round((progress.bytesSent / progress.bytesTotal) * 100) : 0

  return (
    <div className="screen stack" style={{ paddingTop: 32 }}>
      {state === 'done' ? (
        <div className="card stack" style={{ textAlign: 'center' }}>
          <div className="upload-done-icon" aria-hidden>
            <IconCheckCircle size={52} />
          </div>
          <h2 className="serif" style={{ margin: 0 }}>
            Staat klaar voor je thuis-import
          </h2>
          <p className="muted">Je hoeft niets meer te doen. Thuis haal je 'm binnen in MemoryLane.</p>
          <button className="btn btn-primary" onClick={onDashboard}>
            Naar overzicht
          </button>
          {onDone && (
            <button className="btn btn-ghost" onClick={onDone}>
              Nog een memory
            </button>
          )}
        </div>
      ) : state === 'error' ? (
        <div className="card stack">
          <h2 className="serif" style={{ margin: 0 }}>
            {final ? 'Niet meer aan te passen' : 'Versturen onderbroken'}
          </h2>
          <div className="err">{error}</div>
          {!final && (
            <button className="btn btn-primary" onClick={() => void start()}>
              Opnieuw proberen
            </button>
          )}
          {memoryId.current || final ? (
            <>
              {!final && (
                <p className="muted" style={{ margin: 0 }}>
                  Je memory staat veilig op je telefoon. Je kunt 'm later vanuit het overzicht opnieuw versturen.
                </p>
              )}
              <button className={final ? 'btn btn-primary' : 'btn btn-ghost'} onClick={onDashboard}>
                Naar overzicht
              </button>
            </>
          ) : (
            <button className="btn btn-ghost" onClick={onBack}>
              Terug
            </button>
          )}
        </div>
      ) : (
        <div className="card stack">
          <h2 className="serif" style={{ margin: 0 }}>
            {progress?.phase === 'encrypt'
              ? 'Versleutelen…'
              : progress?.phase === 'finalize'
                ? 'Afronden…'
                : progress
                  ? 'Versturen…'
                  : 'Voorbereiden…'}
          </h2>
          <div style={{ height: 10, background: 'var(--accent-soft)', borderRadius: 999, overflow: 'hidden' }}>
            <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent)', transition: 'width .2s' }} />
          </div>
          <div className="muted">
            {pct}% {progress && progress.bytesTotal > 0 && `· ${formatBytes(progress.bytesSent)} / ${formatBytes(progress.bytesTotal)}`}
          </div>
          <p className="muted">Houd de app open tot de upload klaar is.</p>
        </div>
      )}
    </div>
  )
}
