import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { Pairing } from '../store/db'
import { deleteDraft, listDrafts, putMedia, saveDraft, type Draft } from '../store/db'
import { formatBytes, formatDateShort, todayISO, uuid } from '../util'
import { DatePicker } from './DatePicker'
import { UploadView } from './UploadView'

const MAX_FILE_BYTES = 500 * 1024 * 1024 // 500 MB praktische PWA-limiet (§6.5)

function emptyDraft(): Draft {
  const now = new Date().toISOString()
  return { id: uuid(), title: '', startAt: todayISO(), note: '', media: [], createdAt: now, updatedAt: now }
}

export function NewMemoryScreen({
  pairing,
  onExpired,
  nav,
}: {
  pairing: Pairing
  onExpired: () => void
  nav: ReactNode
}) {
  const [draft, setDraft] = useState<Draft>(emptyDraft)
  const [thumbs, setThumbs] = useState<Record<string, string>>({}) // fileId → object-URL
  const [picker, setPicker] = useState<null | 'start' | 'end'>(null)
  const [phase, setPhase] = useState<'form' | 'uploading'>('form')
  const [online, setOnline] = useState(navigator.onLine)
  const [fileError, setFileError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  // Herstel het laatste openstaande concept bij openen.
  useEffect(() => {
    void listDrafts().then((all) => {
      if (all[0]) setDraft(all[0])
    })
  }, [])

  // Online/offline.
  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])

  // Debounced concept-opslag (~300 ms).
  useEffect(() => {
    const t = setTimeout(() => void saveDraft({ ...draft, updatedAt: new Date().toISOString() }), 300)
    return () => clearTimeout(t)
  }, [draft])

  const patch = (p: Partial<Draft>): void => setDraft((d) => ({ ...d, ...p }))

  async function addFiles(files: FileList | null): Promise<void> {
    if (!files) return
    setFileError(null)
    const additions: Draft['media'] = []
    const newThumbs: Record<string, string> = {}
    for (const f of Array.from(files)) {
      if (f.size > MAX_FILE_BYTES) {
        setFileError(`"${f.name}" is groter dan 500 MB — dat past niet in de brievenbus.`)
        continue
      }
      if (f.size === 0) continue // 0-byte bestand overslaan
      const fileId = uuid()
      await putMedia(draft.id, fileId, f)
      additions.push({ fileId, name: f.name, mime: f.type || 'application/octet-stream', plainBytes: f.size })
      newThumbs[fileId] = URL.createObjectURL(f)
    }
    if (additions.length) {
      setThumbs((t) => ({ ...t, ...newThumbs }))
      patch({ media: [...draft.media, ...additions] })
    }
    if (fileInput.current) fileInput.current.value = ''
  }

  function removeMedia(fileId: string): void {
    patch({ media: draft.media.filter((m) => m.fileId !== fileId) })
    // media-blob laten staan tot draft-delete; hier alleen uit de lijst.
  }

  const totalBytes = draft.media.reduce((s, m) => s + m.plainBytes, 0)
  const videoCount = draft.media.filter((m) => m.mime.startsWith('video/')).length
  const photoCount = draft.media.length - videoCount
  const canSave = draft.title.trim().length > 0 && !!draft.startAt

  const summary = useMemo(() => {
    const parts: string[] = []
    if (photoCount) parts.push(`${photoCount} foto${photoCount === 1 ? '' : "'s"}`)
    if (videoCount) parts.push(`${videoCount} video${videoCount === 1 ? '' : "'s"}`)
    if (draft.media.length) parts.push(formatBytes(totalBytes))
    return parts.join(' · ')
  }, [photoCount, videoCount, totalBytes, draft.media.length])

  if (phase === 'uploading') {
    return (
      <>
        {nav}
        <UploadView
          draft={draft}
          pairing={pairing}
          onExpired={onExpired}
          onDone={async () => {
            await deleteDraft(draft.id)
            for (const url of Object.values(thumbs)) URL.revokeObjectURL(url)
            setThumbs({})
            setDraft(emptyDraft())
            setPhase('form')
          }}
          onKeepDraft={() => setPhase('form')}
        />
      </>
    )
  }

  return (
    <>
      {nav}
      {!online && (
        <div className="offline-banner">
          Geen verbinding — je concept wordt lokaal bewaard; versturen kan zodra je online bent.
        </div>
      )}
      <div className="screen stack">
        <div>
          <label className="label" htmlFor="titel">
            Titel
          </label>
          <input
            id="titel"
            className="field title-input"
            value={draft.title}
            onChange={(e) => patch({ title: e.target.value })}
            placeholder="Weekend in de Ardennen…"
            enterKeyHint="next"
          />
        </div>

        <div>
          <label className="label">Wanneer</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="chip" onClick={() => setPicker('start')}>
              📅 {formatDateShort(draft.startAt)}
            </button>
            {draft.endAt ? (
              <button className="chip" onClick={() => setPicker('end')}>
                → {formatDateShort(draft.endAt)}
              </button>
            ) : (
              <button className="chip" onClick={() => setPicker('end')}>
                + einddatum
              </button>
            )}
          </div>
        </div>

        <div>
          <label className="label" htmlFor="verhaal">
            Verhaal
          </label>
          <textarea
            id="verhaal"
            className="field"
            value={draft.note}
            onChange={(e) => patch({ note: e.target.value })}
            placeholder="Schrijf je verhaal…"
            rows={4}
            style={{ resize: 'vertical', minHeight: 96 }}
          />
        </div>

        <div>
          <label className="label">Foto’s &amp; video’s</label>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
            <button
              className="card"
              onClick={() => fileInput.current?.click()}
              style={{ aspectRatio: '1', display: 'grid', placeItems: 'center', fontSize: 28, color: 'var(--accent)' }}
            >
              +
            </button>
            {draft.media.map((m) => (
              <div key={m.fileId} className="card" style={{ position: 'relative', aspectRatio: '1', padding: 0, overflow: 'hidden' }}>
                {m.mime.startsWith('image/') && thumbs[m.fileId] ? (
                  <img src={thumbs[m.fileId]} alt={m.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  <div style={{ width: '100%', height: '100%', display: 'grid', placeItems: 'center', background: 'var(--accent-soft)' }}>
                    {m.mime.startsWith('video/') ? '▶' : '📄'}
                  </div>
                )}
                <button
                  onClick={() => removeMedia(m.fileId)}
                  aria-label="Verwijderen"
                  style={{ position: 'absolute', top: 4, right: 4, border: 'none', borderRadius: '50%', width: 26, height: 26, background: 'rgba(0,0,0,0.55)', color: '#fff' }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          {fileError && <div className="err" style={{ marginTop: 8 }}>{fileError}</div>}
          <input
            ref={fileInput}
            type="file"
            accept="image/*,video/*"
            multiple
            hidden
            onChange={(e) => void addFiles(e.target.files)}
          />
        </div>

        <div className="sticky-cta">
          <button
            className="btn btn-primary"
            style={{ width: '100%' }}
            disabled={!canSave || !online}
            onClick={() => setPhase('uploading')}
          >
            Bewaar in MemoryLane
            {summary && <div style={{ fontWeight: 400, fontSize: 13, opacity: 0.9 }}>{summary}</div>}
          </button>
          {!canSave && <div className="muted" style={{ textAlign: 'center', marginTop: 6 }}>Geef je herinnering een titel.</div>}
        </div>
      </div>

      {picker && (
        <DatePicker
          mode={picker}
          startAt={draft.startAt}
          endAt={draft.endAt}
          onChange={(startAt, endAt) => patch({ startAt, endAt })}
          onClose={() => setPicker(null)}
        />
      )}
    </>
  )
}
