import { useEffect, useRef, useState } from 'react'
import type { Draft, Pairing } from '../store/db'
import { runUpload, type Progress } from '../upload/queue'
import { ApiError } from '../api/client'
import { formatBytes, uuid } from '../util'

export function UploadView({
  draft,
  pairing,
  onExpired,
  onUploaded,
  onDone,
  onKeepDraft,
}: {
  draft: Draft
  pairing: Pairing
  onExpired: () => void
  /** Vuurt zodra de upload IS geslaagd — ruim het concept hier op zodat het na
   * een herlaad niet opnieuw als bewerkbaar/verstuurbaar concept opduikt. */
  onUploaded: () => void | Promise<void>
  onDone: () => void
  onKeepDraft: () => void
}) {
  const [progress, setProgress] = useState<Progress | null>(null)
  const [state, setState] = useState<'running' | 'done' | 'error'>('running')
  const [error, setError] = useState('')
  const memoryId = useRef(uuid()) // stabiel over retries → idempotent op de server

  async function start(): Promise<void> {
    setState('running')
    setError('')
    try {
      await runUpload(draft, pairing, memoryId.current, setProgress)
      setState('done')
      // Geslaagd → concept opruimen (best-effort; faalt dit zelden, dan blijft het
      // concept staan maar is de upload al veilig binnen).
      try {
        await onUploaded()
      } catch {
        /* opruimen mislukt — niet fataal */
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        onExpired()
        return
      }
      setError(e instanceof Error ? e.message : String(e))
      setState('error')
    }
  }

  useEffect(() => {
    void start()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const pct = progress && progress.bytesTotal > 0 ? Math.round((progress.bytesSent / progress.bytesTotal) * 100) : 0

  return (
    <div className="screen stack" style={{ paddingTop: 32 }}>
      {state === 'done' ? (
        <div className="card stack" style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 48 }}>✓</div>
          <h2 className="serif" style={{ margin: 0 }}>
            Staat klaar voor je thuis-import
          </h2>
          <p className="muted">Je hoeft niets meer te doen. Thuis haal je 'm binnen in MemoryLane.</p>
          <button className="btn btn-primary" onClick={onDone}>
            Nog een memory
          </button>
        </div>
      ) : state === 'error' ? (
        <div className="card stack">
          <h2 className="serif" style={{ margin: 0 }}>
            Versturen onderbroken
          </h2>
          <div className="err">{error}</div>
          <button className="btn btn-primary" onClick={() => void start()}>
            Opnieuw proberen
          </button>
          <button className="btn btn-ghost" onClick={onKeepDraft}>
            Bewaar als concept
          </button>
        </div>
      ) : (
        <div className="card stack">
          <h2 className="serif" style={{ margin: 0 }}>
            {progress?.phase === 'encrypt'
              ? 'Versleutelen…'
              : progress?.phase === 'finalize'
                ? 'Afronden…'
                : 'Versturen…'}
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
