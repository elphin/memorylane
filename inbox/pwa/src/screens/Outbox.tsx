import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { OutboxEntry, Pairing } from '../store/db'
import { deleteOutbox, listOutbox, putOutbox } from '../store/db'
import { ApiError, deleteMemory, fetchOutbox } from '../api/client'
import { formatDateShort } from '../util'

const STATUS_LABEL: Record<OutboxEntry['status'], string> = {
  uploading: '⏳ bezig / wacht op thuis-import',
  ready: '⏳ wacht op thuis-import',
  imported: '✓ geïmporteerd',
  failed: '⚠ mislukt',
}

export function OutboxScreen({
  pairing,
  onBack,
  onExpired,
  nav,
}: {
  pairing: Pairing
  onBack: () => void
  onExpired: () => void
  nav: ReactNode
}) {
  const [items, setItems] = useState<OutboxEntry[]>([])
  const [loaded, setLoaded] = useState(false)

  async function refresh(): Promise<void> {
    const local = await listOutbox()
    setItems(local)
    setLoaded(true)
    try {
      const remote = await fetchOutbox(pairing)
      const rmap = new Map(remote.map((r) => [r.memoryId, r.status]))
      for (const l of local) {
        const rs = rmap.get(l.memoryId)
        if (rs && rs !== l.status) {
          l.status = rs
          await putOutbox(l)
        }
      }
      setItems(await listOutbox())
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onExpired()
    }
  }

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function remove(m: OutboxEntry): Promise<void> {
    try {
      await deleteMemory(pairing, m.memoryId)
    } catch {
      /* al weg op de server → lokaal opruimen kan alsnog */
    }
    await deleteOutbox(m.memoryId)
    void refresh()
  }

  return (
    <>
      {nav}
      <div className="screen stack">
        <h2 className="serif" style={{ margin: 0 }}>
          Onderweg
        </h2>
        {loaded && items.length === 0 && (
          <div className="card stack" style={{ textAlign: 'center' }}>
            <p className="muted">Nog niets onderweg — je verstuurde memories verschijnen hier.</p>
            <button className="btn btn-primary" onClick={onBack}>
              Nieuwe memory
            </button>
          </div>
        )}
        {items.map((m) => (
          <div key={m.memoryId} className="card" style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
            <div>
              <div style={{ fontWeight: 600 }}>{m.title || '(zonder titel)'}</div>
              <div className="muted">
                {formatDateShort(m.startAt)} · {m.mediaCount} bestand{m.mediaCount === 1 ? '' : 'en'}
              </div>
              <div className="muted">{STATUS_LABEL[m.status]}</div>
            </div>
            {m.status !== 'imported' && (
              <button className="btn btn-ghost" style={{ color: 'var(--danger)' }} onClick={() => void remove(m)}>
                Verwijder
              </button>
            )}
          </div>
        ))}
      </div>
    </>
  )
}
