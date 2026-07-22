import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { Draft, OutboxEntry, Pairing } from '../store/db'
import { deleteOutbox, listDrafts, listOutbox, putOutbox } from '../store/db'
import { ApiError, deleteMemory, fetchOutbox } from '../api/client'
import { formatDateShort } from '../util'
import { IconAlert, IconCheck, IconClock, IconPlus, IconTrash } from '../icons'

type StatusKind = 'pending' | 'done' | 'fail'
const STATUS: Record<OutboxEntry['status'], { label: string; kind: StatusKind; Icon: typeof IconClock }> = {
  uploading: { label: 'Bezig met versturen…', kind: 'pending', Icon: IconClock },
  ready: { label: 'Wacht op thuis-import', kind: 'pending', Icon: IconClock },
  imported: { label: 'Geïmporteerd — veilig thuis', kind: 'done', Icon: IconCheck },
  failed: { label: 'Versturen mislukt', kind: 'fail', Icon: IconAlert },
}

export function DashboardScreen({
  pairing,
  onNew,
  onExpired,
  nav,
}: {
  pairing: Pairing
  onNew: () => void
  onExpired: () => void
  nav: ReactNode
}) {
  const [items, setItems] = useState<OutboxEntry[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [loaded, setLoaded] = useState(false)

  async function refresh(): Promise<void> {
    const local = await listOutbox()
    setItems(local)
    // Openstaand concept (met inhoud) bovenaan tonen als "verder schrijven".
    const drafts = await listDrafts()
    setDraft(drafts.find((d) => d.title.trim() !== '' || d.note.trim() !== '' || d.media.length > 0) ?? null)
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

  const groups = [
    { key: 'pending', title: 'Nog te importeren', items: items.filter((i) => i.status === 'uploading' || i.status === 'ready') },
    { key: 'failed', title: 'Niet gelukt', items: items.filter((i) => i.status === 'failed') },
    { key: 'imported', title: 'Geïmporteerd', items: items.filter((i) => i.status === 'imported') },
  ].filter((g) => g.items.length > 0)

  const isEmpty = loaded && items.length === 0 && !draft

  return (
    <>
      {nav}
      <div className="screen stack">
        <div>
          <h2 className="serif dash-title">Jouw memories</h2>
          <p className="muted" style={{ marginTop: 2 }}>Wat je onderweg hebt vastgelegd en verstuurd.</p>
        </div>

        {draft && (
          <button className="card memory-card draft-card" onClick={onNew}>
            <div className="memory-main">
              <div className="memory-title">{draft.title.trim() || 'Naamloos concept'}</div>
              <div className="status status-pending">
                <span className="dot" /> Concept — tik om verder te schrijven
              </div>
            </div>
            <span className="memory-cta">Verder</span>
          </button>
        )}

        {isEmpty && (
          <div className="card empty-state stack">
            <div className="empty-plus" aria-hidden>
              <IconPlus size={26} />
            </div>
            <div>
              <div className="serif" style={{ fontSize: 19 }}>Nog niks verstuurd</div>
              <p className="muted" style={{ marginTop: 4 }}>
                Leg onderweg een herinnering vast — foto’s, video’s en een verhaaltje — en stuur 'm naar je MemoryLane thuis.
              </p>
            </div>
            <button className="btn btn-primary" onClick={onNew}>Nieuwe memory</button>
          </div>
        )}

        {groups.map((g) => (
          <div key={g.key} className="stack" style={{ marginTop: 4 }}>
            <div className="section-label">{g.title}</div>
            {g.items.map((m) => {
              const s = STATUS[m.status]
              return (
                <div key={m.memoryId} className="card memory-card">
                  <div className="memory-main">
                    <div className="memory-title">{m.title || '(zonder titel)'}</div>
                    <div className="muted">
                      {formatDateShort(m.startAt)} · {m.mediaCount} bestand{m.mediaCount === 1 ? '' : 'en'}
                    </div>
                    <div className={`status status-${s.kind}`}>
                      <s.Icon size={15} /> {s.label}
                    </div>
                  </div>
                  {m.status !== 'imported' && (
                    <button className="icon-btn" aria-label="Verwijderen" onClick={() => void remove(m)}>
                      <IconTrash size={19} />
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </>
  )
}
