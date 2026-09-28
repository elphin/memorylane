import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { Draft, OutboxEntry, Pairing } from '../store/db'
import { listDrafts, listOutbox } from '../store/db'
import { ApiError } from '../api/client'
import { syncOutbox } from '../upload/queue'
import { formatDateShort } from '../util'
import { IconPlay, IconPlus } from '../icons'
import { statusView } from './status'

/** Kleine voorvertoning (eerste foto/video-thumb) voor een kaart. */
function CardThumb({ entry }: { entry: OutboxEntry }) {
  const [url, setUrl] = useState<string | null>(null)
  const first = entry.draft?.media[0]
  const blob = first ? entry.thumbs?.[first.fileId] : undefined
  useEffect(() => {
    if (!blob) return
    const u = URL.createObjectURL(blob)
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [blob])
  if (!first) return null
  return (
    <div className="memory-thumb" aria-hidden>
      {url ? <img src={url} alt="" /> : first.mime.startsWith('video/') ? <IconPlay size={20} /> : null}
    </div>
  )
}

export function DashboardScreen({
  pairing,
  onNew,
  onOpen,
  onExpired,
  nav,
}: {
  pairing: Pairing
  onNew: () => void
  onOpen: (memoryId: string) => void
  onExpired: () => void
  nav: ReactNode
}) {
  const [items, setItems] = useState<OutboxEntry[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [loaded, setLoaded] = useState(false)

  async function refresh(): Promise<void> {
    setItems(await listOutbox())
    // Openstaand concept (met inhoud) bovenaan tonen als "verder schrijven".
    const drafts = await listDrafts()
    setDraft(drafts.find((d) => d.title.trim() !== '' || d.note.trim() !== '' || d.media.length > 0) ?? null)
    setLoaded(true)
    try {
      await syncOutbox(pairing)
      setItems(await listOutbox())
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onExpired()
    }
  }

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const views = items.map((m) => ({ m, s: statusView(m) }))
  const groups = [
    { key: 'attention', title: 'Aandacht nodig', items: views.filter((v) => v.s.kind === 'fail' || v.s.kind === 'warn') },
    { key: 'pending', title: 'Nog te importeren', items: views.filter((v) => v.s.kind === 'pending') },
    { key: 'imported', title: 'Geïmporteerd', items: views.filter((v) => v.s.kind === 'done') },
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
            {g.items.map(({ m, s }) => (
              <button key={m.memoryId} className="card memory-card memory-card-link" onClick={() => onOpen(m.memoryId)}>
                <CardThumb entry={m} />
                <div className="memory-main" style={{ flex: 1 }}>
                  <div className="memory-title">{m.title || '(zonder titel)'}</div>
                  <div className="muted">
                    {formatDateShort(m.startAt)} · {m.mediaCount} bestand{m.mediaCount === 1 ? '' : 'en'}
                  </div>
                  <div className={`status status-${s.kind}`}>
                    <s.Icon size={15} /> {s.label}
                  </div>
                </div>
                <span className="memory-cta" aria-hidden>›</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </>
  )
}
