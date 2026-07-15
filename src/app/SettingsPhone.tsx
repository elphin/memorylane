// Settings-onderdeel "Telefoon" (§9.1): koppel een telefoon aan de brievenbus,
// toon de QR-code, en beheer de koppeling (nieuwe koppelcode / ontkoppelen).
// Alle geheimen leven in de Windows Credential Manager (Rust); deze UI ziet
// alleen de niet-geheime status + de eenmalig teruggegeven QR-payload.

import { useEffect, useRef, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import type { Backend, ImportProgress, ImportReport, InboxStatus } from '../lib/backend'

const C = {
  ink: '#fff',
  sub: '#8a97b0',
  faint: '#6a7690',
  line: '#2c3650',
  card: '#1b2233',
  accent: '#3b82f6',
  danger: '#e0574f',
}

const STEP_LABEL: Record<ImportProgress['step'], string> = {
  download: 'downloaden',
  decrypt: 'ontsleutelen',
  write: 'wegschrijven',
  ack: 'afronden',
}

/** Tauri geeft een Err(String) terug als een kale string; normaliseer naar tekst. */
function errMsg(e: unknown): string {
  if (typeof e === 'string') return e
  if (e instanceof Error) return e.message
  return String(e)
}

function formatDate(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const MND = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec']
  return `${d.getDate()} ${MND[d.getMonth()]} ${d.getFullYear()}`
}

const btn: React.CSSProperties = {
  padding: '9px 14px',
  borderRadius: 8,
  border: `1px solid ${C.line}`,
  background: 'transparent',
  color: C.ink,
  font: '13px sans-serif',
  cursor: 'pointer',
}
const btnPrimary: React.CSSProperties = { ...btn, background: C.accent, borderColor: C.accent }
const field: React.CSSProperties = {
  width: '100%',
  padding: '9px 11px',
  borderRadius: 8,
  border: `1px solid ${C.line}`,
  background: '#0f1420',
  color: C.ink,
  font: '13px sans-serif',
  boxSizing: 'border-box',
}
const label: React.CSSProperties = { fontSize: 12, color: C.sub, margin: '10px 0 5px' }
const desc: React.CSSProperties = { fontSize: 12, color: C.faint, marginTop: 6 }

// Ingebakken standaard-brievenbus (build-time, uit .env). Zijn beide gezet, dan
// hoeft de gebruiker niets in te vullen — alleen op "Koppel telefoon" klikken.
const DEFAULT_SERVER = ((import.meta.env.VITE_INBOX_SERVER_URL as string | undefined) ?? '').trim()
const DEFAULT_INVITE = ((import.meta.env.VITE_INBOX_INVITE_CODE as string | undefined) ?? '').trim()
const HAS_DEFAULTS = DEFAULT_SERVER !== '' && DEFAULT_INVITE !== ''

export function SettingsPhone({ backend, onImported }: { backend: Backend; onImported?: () => void }) {
  const [status, setStatus] = useState<InboxStatus | null>(null)
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER)
  const [inviteCode, setInviteCode] = useState(DEFAULT_INVITE)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [pending, setPending] = useState<number | null>(null)
  const [qr, setQr] = useState<string | null>(null) // QR-payload na pair/rotate
  const [importing, setImporting] = useState(false)
  const [progress, setProgress] = useState<ImportProgress | null>(null)
  const [report, setReport] = useState<ImportReport | null>(null)
  const mounted = useRef(true)

  async function refresh(): Promise<void> {
    try {
      const s = await backend.inboxStatus()
      if (!mounted.current) return
      setStatus(s)
      if (s.serverUrl) setServerUrl(s.serverUrl)
      if (s.configured) {
        // Badge best-effort; fouten (offline) negeren.
        backend
          .inboxPendingCount()
          .then((n) => mounted.current && setPending(n))
          .catch(() => mounted.current && setPending(null))
      }
    } catch (e) {
      if (mounted.current) setError(errMsg(e))
    }
  }

  useEffect(() => {
    mounted.current = true
    void refresh()
    return () => {
      mounted.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function pair(): Promise<void> {
    setError('')
    setBusy(true)
    try {
      const r = await backend.inboxPair(serverUrl.trim(), inviteCode.trim())
      setQr(r.qrPayload)
      setInviteCode('') // invite-code niet bewaren (§9.1)
      await refresh()
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  async function rotate(discardFirst: boolean): Promise<void> {
    setError('')
    setBusy(true)
    try {
      if (discardFirst) await backend.inboxDiscardPending()
      const r = await backend.inboxRotateUploadToken()
      setQr(r.qrPayload)
      setPending(null)
      await refresh()
    } catch (e) {
      const msg = errMsg(e)
      const m = /^pending:(\d+)$/.exec(msg)
      if (m) {
        // Nog te importeren memories onder de oude sleutel → bevestiging vragen.
        setPending(Number(m[1]))
        setError('')
      } else {
        setError(msg)
      }
    } finally {
      setBusy(false)
    }
  }

  async function showQr(): Promise<void> {
    setError('')
    try {
      const r = await backend.inboxShowQr()
      setQr(r.qrPayload)
    } catch (e) {
      setError(errMsg(e))
    }
  }

  async function unpair(): Promise<void> {
    setError('')
    // Verse telling ophalen (§9.1 eist een expliciete waarschuwing) — niet op de
    // mogelijk verouderde/lege badge-state leunen, want `DELETE /api/mailboxes`
    // vernietigt eventuele klaarstaande memories onherroepelijk.
    let live: number | null = null
    try {
      live = await backend.inboxPendingCount()
    } catch {
      live = null
    }
    let msg = 'Deze telefoon-koppeling verwijderen? De oude QR/telefoon werkt daarna niet meer.'
    if (live && live > 0) {
      msg = `Er staan nog ${live} memory${live === 1 ? '' : "'s"} klaar die je nog niet hebt geïmporteerd — die gaan definitief verloren. Toch ontkoppelen?`
    } else if (live === null) {
      msg =
        'Deze telefoon-koppeling verwijderen? Ik kon niet controleren of er nog memories klaarstaan — als die er zijn, gaan ze definitief verloren. Doorgaan?'
    }
    if (!confirm(msg)) return
    setBusy(true)
    try {
      await backend.inboxUnpair()
      setQr(null)
      setPending(null)
      setInviteCode('')
      await refresh()
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  async function doImport(): Promise<void> {
    setError('')
    setReport(null)
    setImporting(true)
    setProgress(null)
    let unlisten: (() => void) | null = null
    try {
      unlisten = await backend.onInboxProgress((p) => mounted.current && setProgress(p))
      const r = await backend.inboxImport()
      if (!mounted.current) return
      setReport(r)
      if (r.imported > 0) onImported?.() // tijdlijn verversen
      await refresh()
    } catch (e) {
      if (mounted.current) setError(errMsg(e))
    } finally {
      if (unlisten) unlisten()
      if (mounted.current) {
        setImporting(false)
        setProgress(null)
      }
    }
  }

  if (!status) {
    return <div style={{ color: C.sub, fontSize: 13 }}>Laden…</div>
  }

  // ---- QR-weergave (na pairen of roteren) ----
  if (qr) {
    return (
      <div>
        <div style={{ fontSize: 15, fontWeight: 600, color: C.ink }}>Scan met je telefoon</div>
        <div style={{ ...desc, marginBottom: 12 }}>
          Open de <b>camera-app</b> van je telefoon en richt 'm op de code. Tik op de melding om de
          MemoryLane-brievenbus te openen en op je beginscherm te zetten.
        </div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            padding: 16,
            background: '#fff',
            borderRadius: 12,
            width: 'fit-content',
            margin: '0 auto',
          }}
        >
          <QRCodeSVG value={qr} size={232} level="M" />
        </div>
        <div style={{ ...desc, textAlign: 'center', marginTop: 12 }}>
          De code bevat je geheime sleutel — deel 'm met niemand en maak er geen foto van.
        </div>
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 14 }}>
          <button style={btnPrimary} onClick={() => setQr(null)}>
            Klaar
          </button>
        </div>
      </div>
    )
  }

  // ---- Niet gekoppeld: pair-formulier ----
  if (!status.configured) {
    // Eén-klik als er een ingebakken brievenbus is (en de gebruiker niet expliciet
    // "andere server" koos): geen velden, alleen een koppelknop.
    const oneClick = HAS_DEFAULTS && !showAdvanced
    return (
      <div>
        <div style={{ fontSize: 15, fontWeight: 600, color: C.ink }}>Telefoon koppelen</div>
        <div style={desc}>
          Leg onderweg memories vast op je telefoon; thuis haal je ze met één knop binnen. Alles is
          end-to-end versleuteld — de server ziet nooit je foto's of tekst.
        </div>

        {oneClick ? (
          <>
            {error && <div style={{ color: C.danger, fontSize: 12, marginTop: 12 }}>{error}</div>}
            <div style={{ marginTop: 14 }}>
              <button style={{ ...btnPrimary, opacity: busy ? 0.5 : 1 }} disabled={busy} onClick={() => void pair()}>
                {busy ? 'Bezig…' : 'Koppel telefoon'}
              </button>
            </div>
            <button
              className="link"
              style={{ marginTop: 12, background: 'none', border: 0, color: C.sub, fontSize: 12, cursor: 'pointer', padding: 0 }}
              onClick={() => setShowAdvanced(true)}
            >
              Een andere server gebruiken…
            </button>
          </>
        ) : (
          <>
            <div style={label}>Server-URL</div>
            <input
              style={field}
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              placeholder="https://…workers.dev"
              spellCheck={false}
              autoCapitalize="off"
            />
            <div style={label}>Invite-code</div>
            <input
              style={field}
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value)}
              placeholder="De code uit je Cloudflare-instellingen"
              spellCheck={false}
              autoCapitalize="off"
            />

            {error && <div style={{ color: C.danger, fontSize: 12, marginTop: 10 }}>{error}</div>}

            <div style={{ marginTop: 14 }}>
              <button
                style={{ ...btnPrimary, opacity: busy || !serverUrl.trim() || !inviteCode.trim() ? 0.5 : 1 }}
                disabled={busy || !serverUrl.trim() || !inviteCode.trim()}
                onClick={() => void pair()}
              >
                {busy ? 'Bezig…' : 'Koppel telefoon'}
              </button>
            </div>
          </>
        )}
      </div>
    )
  }

  // ---- Gekoppeld: status + beheer ----
  return (
    <div>
      <div style={{ fontSize: 15, fontWeight: 600, color: C.ink }}>Telefoon gekoppeld</div>
      <div
        style={{
          marginTop: 10,
          padding: '12px 14px',
          background: C.card,
          border: `1px solid ${C.line}`,
          borderRadius: 10,
        }}
      >
        <div style={{ fontSize: 13, color: C.ink }}>
          Brievenbus <b style={{ fontFamily: 'ui-monospace, monospace' }}>{status.mailboxShortId}…</b>
        </div>
        {status.pairedAt && (
          <div style={{ fontSize: 12, color: C.sub, marginTop: 3 }}>Sinds {formatDate(status.pairedAt)}</div>
        )}
        {status.serverUrl && (
          <div style={{ fontSize: 11, color: C.faint, marginTop: 3, wordBreak: 'break-all' }}>{status.serverUrl}</div>
        )}
        {pending !== null && (
          <div style={{ fontSize: 12, color: pending > 0 ? '#e0b34f' : C.sub, marginTop: 6 }}>
            {pending > 0 ? `📥 ${pending} memory${pending === 1 ? '' : "'s"} onderweg — klaar om te importeren` : 'Geen memories onderweg'}
          </div>
        )}
      </div>

      {/* Importeren */}
      <div style={{ marginTop: 12 }}>
        <button
          style={{ ...btnPrimary, width: '100%', opacity: importing ? 0.6 : 1 }}
          disabled={importing}
          onClick={() => void doImport()}
        >
          {importing ? 'Bezig met importeren…' : 'Importeer openstaande memories'}
        </button>
        {importing && progress && (
          <div style={{ marginTop: 10 }}>
            <div style={{ height: 8, background: C.line, borderRadius: 999, overflow: 'hidden' }}>
              <div
                style={{
                  width: `${progress.memoryCount ? Math.round(((progress.memoryIndex + 1) / progress.memoryCount) * 100) : 0}%`,
                  height: '100%',
                  background: C.accent,
                  transition: 'width .2s',
                }}
              />
            </div>
            <div style={{ fontSize: 12, color: C.sub, marginTop: 6 }}>
              Memory {progress.memoryIndex + 1} van {progress.memoryCount} · {STEP_LABEL[progress.step]}
              {progress.fileCount > 0 && progress.step !== 'ack' ? ` (bestand ${progress.fileIndex + 1}/${progress.fileCount})` : ''}
            </div>
          </div>
        )}
        {report && (
          <div style={{ marginTop: 10, fontSize: 13, color: C.ink }}>
            ✓ {report.imported} geïmporteerd
            {report.skipped > 0 && <span style={{ color: '#e0b34f' }}> · {report.skipped} overgeslagen</span>}
            {report.errors.length > 0 && (
              <ul style={{ margin: '6px 0 0', paddingLeft: 18, color: C.danger, fontSize: 12 }}>
                {report.errors.slice(0, 5).map((er) => (
                  <li key={er.memoryId}>{er.message}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {/* Rotate-bevestiging bij nog-pending memories */}
      {pending !== null && pending > 0 && (
        <div
          style={{
            marginTop: 12,
            padding: '12px 14px',
            background: '#2a2410',
            border: '1px solid #5a4c1e',
            borderRadius: 10,
          }}
        >
          <div style={{ fontSize: 13, color: '#e6d9a8' }}>
            Een nieuwe koppelcode maakt de {pending} klaarstaande memory{pending === 1 ? '' : "'s"} onbruikbaar
            (die zijn met de oude sleutel versleuteld). Importeer ze eerst, of gooi ze weg.
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button
              style={{ ...btn, borderColor: C.danger, color: C.danger }}
              disabled={busy}
              onClick={() => void rotate(true)}
            >
              Weggooien en nieuwe code
            </button>
          </div>
        </div>
      )}

      {error && <div style={{ color: C.danger, fontSize: 12, marginTop: 10 }}>{error}</div>}

      <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
        <button style={btn} disabled={busy} onClick={() => void showQr()}>
          Toon QR-code
        </button>
        <button style={btn} disabled={busy} onClick={() => void rotate(false)}>
          Nieuwe koppelcode
        </button>
        <button
          style={{ ...btn, borderColor: C.danger, color: C.danger }}
          disabled={busy}
          onClick={() => void unpair()}
        >
          Ontkoppelen
        </button>
      </div>
      <div style={desc}>
        "Toon QR-code" laat dezelfde koppeling opnieuw zien (om te heropenen of een tweede telefoon te
        koppelen). "Nieuwe koppelcode" vervángt je oude koppeling (bijv. als je telefoon kwijt is).
      </div>
    </div>
  )
}
