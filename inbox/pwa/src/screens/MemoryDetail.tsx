// Eén verstuurde memory inzien: titel, data, verhaal, foto's/video's en de
// status in de brievenbus, met de acties die op dat moment kunnen.

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { getMedia, getOutbox, type OutboxEntry, type Pairing } from '../store/db'
import { removeEntry } from '../upload/queue'
import { ApiError } from '../api/client'
import { formatDateShort } from '../util'
import { IconFile, IconPlay } from '../icons'
import { statusView } from './status'

interface Shown {
  fileId: string
  name: string
  mime: string
  url: string | null // origineel (zolang op de telefoon), anders de thumb
  original: boolean
}

function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  )
}

export function MemoryDetail({
  memoryId,
  pairing,
  onBack,
  onEdit,
  onResend,
  onExpired,
  nav,
}: {
  memoryId: string
  pairing: Pairing
  onBack: () => void
  onEdit: (e: OutboxEntry) => void
  onResend: (e: OutboxEntry) => void
  onExpired: () => void
  nav: ReactNode
}) {
  const [entry, setEntry] = useState<OutboxEntry | null | undefined>(undefined)
  const [media, setMedia] = useState<Shown[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const urls: string[] = []
    let alive = true
    void (async () => {
      const e = await getOutbox(memoryId)
      if (!alive) return
      setEntry(e)
      if (!e?.draft) return
      const shown: Shown[] = []
      for (const m of e.draft.media) {
        const blob = await getMedia(e.draft.id, m.fileId)
        const src = blob ?? e.thumbs?.[m.fileId] ?? null
        const url = src ? URL.createObjectURL(src) : null
        if (url) urls.push(url)
        shown.push({ fileId: m.fileId, name: m.name, mime: m.mime, url, original: !!blob })
      }
      if (alive) setMedia(shown)
    })()
    return () => {
      alive = false
      for (const u of urls) URL.revokeObjectURL(u)
    }
  }, [memoryId])

  if (entry === undefined) return <>{nav}</>
  if (entry === null) {
    return (
      <>
        {nav}
        <div className="screen stack">
          <p className="muted">Deze memory staat niet meer op je telefoon.</p>
          <button className="btn btn-primary" onClick={onBack}>Naar overzicht</button>
        </div>
      </>
    )
  }

  const s = statusView(entry)
  const d = entry.edit ?? entry.draft
  const note = entry.draft?.note.trim()

  async function remove(): Promise<void> {
    if (!entry) return
    const msg =
      entry.status === 'imported'
        ? 'Uit dit overzicht halen? In MemoryLane thuis blijft hij gewoon bestaan.'
        : 'Deze memory verwijderen? Hij wordt uit je brievenbus gehaald en komt thuis niet meer binnen. De foto’s en tekst op deze telefoon worden gewist.'
    if (!confirm(msg)) return
    setBusy(true)
    setError('')
    try {
      await removeEntry(pairing, entry)
      onBack()
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return onExpired()
      setError('Verwijderen lukte niet — de brievenbus is niet bereikbaar. Probeer het straks opnieuw.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {nav}
      <div className="screen stack">
        <button className="link-back" onClick={onBack}>‹ Overzicht</button>
        <div>
          <h2 className="serif dash-title">{entry.title || '(zonder titel)'}</h2>
          <div className="muted" style={{ marginTop: 4 }}>
            {formatDateShort(entry.draft?.startAt ?? entry.startAt)}
            {entry.draft?.endAt && ` → ${formatDateShort(entry.draft.endAt)}`}
          </div>
          <div className={`status status-${s.kind}`}>
            <s.Icon size={15} /> {s.label}
          </div>
          {entry.edit && entry.status !== 'imported' && (
            <div className="status status-warn">Je hebt wijzigingen die nog niet verstuurd zijn.</div>
          )}
        </div>

        {!entry.draft ? (
          <div className="card muted">
            Van deze memory is alleen de titel bewaard: hij is verstuurd met een oudere versie van de app,
            die de inhoud na het versturen wiste.
          </div>
        ) : (
          <>
            {note && (
              <div className="card" style={{ whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
                {note}
              </div>
            )}
            {media.length > 0 && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
                {media.map((m) => (
                  <div key={m.fileId} className="card" style={{ aspectRatio: '1', padding: 0, overflow: 'hidden' }}>
                    {m.url && m.mime.startsWith('video/') && m.original ? (
                      <video src={m.url} controls playsInline preload="metadata" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    ) : m.url && (m.mime.startsWith('image/') || !m.original) ? (
                      <img src={m.url} alt={m.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    ) : (
                      <div style={{ width: '100%', height: '100%', display: 'grid', placeItems: 'center', background: 'var(--accent-soft)', color: 'var(--accent)' }}>
                        {m.mime.startsWith('video/') ? <IconPlay size={26} /> : <IconFile size={24} />}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
            {entry.status === 'imported' && media.length > 0 && (
              <p className="muted" style={{ margin: 0 }}>
                De originele bestanden staan nu thuis in MemoryLane; hier zie je kleine voorbeelden.
              </p>
            )}
            {entry.status !== 'imported' && !isStandalone() && (
              <p className="muted" style={{ margin: 0 }}>
                Tip: zet deze app op je beginscherm. Anders kan je telefoon de bewaarde kopie na een week opruimen.
              </p>
            )}
          </>
        )}

        {error && <div className="err">{error}</div>}

        {s.canResend && !entry.edit && (
          <button className="btn btn-primary" style={{ width: '100%' }} disabled={busy} onClick={() => onResend(entry)}>
            Opnieuw versturen
          </button>
        )}
        {s.canEdit && d && (
          <button
            className={s.canResend && !entry.edit ? 'btn btn-ghost' : 'btn btn-primary'}
            style={{ width: '100%' }}
            disabled={busy}
            onClick={() => onEdit(entry)}
          >
            {entry.edit ? 'Verder met aanpassen' : 'Aanpassen'}
          </button>
        )}
        {entry.status === 'imported' && entry.edit && (
          <div className="card stack">
            <div className="status status-warn" style={{ marginTop: 0 }}>
              Deze wijzigingen waren nog niet verstuurd toen hij thuis binnenkwam — neem ze daar over:
            </div>
            <div style={{ fontWeight: 600 }}>{entry.edit.title}</div>
            {entry.edit.note.trim() && <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{entry.edit.note}</div>}
          </div>
        )}
        {entry.status === 'imported' && entry.draft && (
          <p className="muted" style={{ margin: 0 }}>Aanpassen doe je nu thuis in MemoryLane.</p>
        )}
        <button
          className="muted"
          disabled={busy}
          onClick={() => void remove()}
          style={{ background: 'none', border: 0, textDecoration: 'underline', cursor: 'pointer', fontSize: 13, padding: 4, alignSelf: 'center', display: 'block', marginLeft: 'auto', marginRight: 'auto' }}
        >
          {entry.status === 'imported' ? 'Uit overzicht halen' : 'Verwijderen'}
        </button>
      </div>
    </>
  )
}
