// Settings-onderdeel "Telefoon" (§9.1): koppel een telefoon aan de brievenbus,
// toon de QR-code, en beheer de koppeling (nieuwe koppelcode / ontkoppelen).
// Alle geheimen leven in de Windows Credential Manager (Rust); deze UI ziet
// alleen de niet-geheime status + de eenmalig teruggegeven QR-payload.

import { useEffect, useRef, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import type { Backend, ImportProgress, ImportReport, InboxStatus } from '../lib/backend'
import { ui, type UiPalette } from '../theme/ui'

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

const btn = (u: UiPalette): React.CSSProperties => ({
  padding: '9px 14px',
  borderRadius: 8,
  border: `1px solid ${u.border}`,
  background: 'transparent',
  color: u.text,
  font: '13px sans-serif',
  cursor: 'pointer',
})
const btnPrimary = (u: UiPalette): React.CSSProperties => ({
  ...btn(u),
  background: u.primary,
  borderColor: u.primary,
  color: u.primaryText,
})
const field = (u: UiPalette): React.CSSProperties => ({
  width: '100%',
  padding: '9px 11px',
  borderRadius: 8,
  border: `1px solid ${u.border}`,
  background: u.phoneInputBg,
  color: u.text,
  font: '13px sans-serif',
  boxSizing: 'border-box',
})
const label = (u: UiPalette): React.CSSProperties => ({ fontSize: 12, color: u.textMuted, margin: '10px 0 5px' })
const desc = (u: UiPalette): React.CSSProperties => ({ fontSize: 12, color: u.textFaint, marginTop: 6 })

// Ingebakken standaard-brievenbus (build-time, uit .env). Zijn beide gezet, dan
// hoeft de gebruiker niets in te vullen — alleen op "Koppel telefoon" klikken.
const DEFAULT_SERVER = ((import.meta.env.VITE_INBOX_SERVER_URL as string | undefined) ?? '').trim()
const DEFAULT_INVITE = ((import.meta.env.VITE_INBOX_INVITE_CODE as string | undefined) ?? '').trim()
const HAS_DEFAULTS = DEFAULT_SERVER !== '' && DEFAULT_INVITE !== ''

export function SettingsPhone({ backend, onImported }: { backend: Backend; onImported?: () => void }) {
  // Actief UI-palet (volgt THEME.uiMode van het app-thema).
  const u = ui()
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
  const [copied, setCopied] = useState(false)
  const mounted = useRef(true)

  // De koppelcode (QR-payload) naar het klembord — bron voor de plak-terugval
  // in de telefoon-app. Clipboard kan falen (geen focus/rechten) → dan een
  // korte foutmelding i.p.v. stil falen.
  async function copyCode(): Promise<void> {
    if (!qr) return
    try {
      await navigator.clipboard.writeText(qr)
      setCopied(true)
      window.setTimeout(() => mounted.current && setCopied(false), 1800)
    } catch {
      setError('Kopiëren naar het klembord lukte niet.')
    }
  }

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
    return <div style={{ color: u.textMuted, fontSize: 13 }}>Laden…</div>
  }

  // ---- QR-weergave (na pairen of roteren) ----
  if (qr) {
    return (
      <div>
        <div style={{ fontSize: 15, fontWeight: 600, color: u.text }}>Scan met je telefoon</div>
        <div style={{ ...desc(u), marginBottom: 12 }}>
          <b>Nieuw:</b> zet de app eerst op je beginscherm (open de brievenbus één keer in je browser →
          deel-/menuknop → <b>op beginscherm</b>). Open 'm daar en tik op <b>Scan koppelcode</b> — richt op
          deze code. Zo koppelt óók de app op je beginscherm (die heeft zijn eigen geheugen).
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
        <div style={{ ...desc(u), textAlign: 'center', marginTop: 12 }}>
          De code bevat je geheime sleutel — deel 'm met niemand en maak er geen foto van.
        </div>
        <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 14 }}>
          <button style={btn(u)} onClick={() => void copyCode()}>
            {copied ? '✓ Gekopieerd' : 'Koppelcode kopiëren'}
          </button>
          <button style={btnPrimary(u)} onClick={() => setQr(null)}>
            Klaar
          </button>
        </div>
        <div style={{ ...desc(u), textAlign: 'center', marginTop: 8 }}>
          Lukt scannen niet? Kopieer de code en plak 'm in de app onder <b>Of plak de code</b>.
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
        <div style={{ fontSize: 15, fontWeight: 600, color: u.text }}>Telefoon koppelen</div>
        <div style={desc(u)}>
          Leg onderweg memories vast op je telefoon; thuis haal je ze met één knop binnen. Alles is
          end-to-end versleuteld — de server ziet nooit je foto's of tekst.
        </div>

        {oneClick ? (
          <>
            {error && <div style={{ color: u.danger, fontSize: 12, marginTop: 12 }}>{error}</div>}
            <div style={{ marginTop: 14 }}>
              <button style={{ ...btnPrimary(u), opacity: busy ? 0.5 : 1 }} disabled={busy} onClick={() => void pair()}>
                {busy ? 'Bezig…' : 'Koppel telefoon'}
              </button>
            </div>
            <button
              className="link"
              style={{ marginTop: 12, background: 'none', border: 0, color: u.textMuted, fontSize: 12, cursor: 'pointer', padding: 0 }}
              onClick={() => setShowAdvanced(true)}
            >
              Een andere server gebruiken…
            </button>
          </>
        ) : (
          <>
            <div style={label(u)}>Server-URL</div>
            <input
              style={field(u)}
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              placeholder="https://…workers.dev"
              spellCheck={false}
              autoCapitalize="off"
            />
            <div style={label(u)}>Invite-code</div>
            <input
              style={field(u)}
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value)}
              placeholder="De code uit je Cloudflare-instellingen"
              spellCheck={false}
              autoCapitalize="off"
            />

            {error && <div style={{ color: u.danger, fontSize: 12, marginTop: 10 }}>{error}</div>}

            <div style={{ marginTop: 14 }}>
              <button
                style={{ ...btnPrimary(u), opacity: busy || !serverUrl.trim() || !inviteCode.trim() ? 0.5 : 1 }}
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
      <div style={{ fontSize: 15, fontWeight: 600, color: u.text }}>Telefoon gekoppeld</div>
      <div
        style={{
          marginTop: 10,
          padding: '12px 14px',
          background: u.statusCardBg,
          border: `1px solid ${u.border}`,
          borderRadius: 10,
        }}
      >
        <div style={{ fontSize: 13, color: u.text }}>
          Brievenbus <b style={{ fontFamily: 'ui-monospace, monospace' }}>{status.mailboxShortId}…</b>
        </div>
        {status.pairedAt && (
          <div style={{ fontSize: 12, color: u.textMuted, marginTop: 3 }}>Sinds {formatDate(status.pairedAt)}</div>
        )}
        {status.serverUrl && (
          <div style={{ fontSize: 11, color: u.textFaint, marginTop: 3, wordBreak: 'break-all' }}>{status.serverUrl}</div>
        )}
        {pending !== null && (
          <div style={{ fontSize: 12, color: pending > 0 ? u.warnSoft : u.textMuted, marginTop: 6 }}>
            {pending > 0 ? `📥 ${pending} memory${pending === 1 ? '' : "'s"} onderweg — klaar om te importeren` : 'Geen memories onderweg'}
          </div>
        )}
      </div>

      {/* Importeren */}
      <div style={{ marginTop: 12 }}>
        <button
          style={{ ...btnPrimary(u), width: '100%', opacity: importing ? 0.6 : 1 }}
          disabled={importing}
          onClick={() => void doImport()}
        >
          {importing ? 'Bezig met importeren…' : 'Importeer openstaande memories'}
        </button>
        {importing && progress && (
          <div style={{ marginTop: 10 }}>
            <div style={{ height: 8, background: u.border, borderRadius: 999, overflow: 'hidden' }}>
              <div
                style={{
                  width: `${progress.memoryCount ? Math.round(((progress.memoryIndex + 1) / progress.memoryCount) * 100) : 0}%`,
                  height: '100%',
                  background: u.primary,
                  transition: 'width .2s',
                }}
              />
            </div>
            <div style={{ fontSize: 12, color: u.textMuted, marginTop: 6 }}>
              Memory {progress.memoryIndex + 1} van {progress.memoryCount} · {STEP_LABEL[progress.step]}
              {progress.fileCount > 0 && progress.step !== 'ack' ? ` (bestand ${progress.fileIndex + 1}/${progress.fileCount})` : ''}
            </div>
          </div>
        )}
        {report && (
          <div style={{ marginTop: 10, fontSize: 13, color: u.text }}>
            ✓ {report.imported} geïmporteerd
            {report.skipped > 0 && <span style={{ color: u.warnSoft }}> · {report.skipped} overgeslagen</span>}
            {report.errors.length > 0 && (
              <ul style={{ margin: '6px 0 0', paddingLeft: 18, color: u.danger, fontSize: 12 }}>
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
            background: u.warnBg,
            border: `1px solid ${u.warnBorder}`,
            borderRadius: 10,
          }}
        >
          <div style={{ fontSize: 13, color: u.warnText }}>
            Een nieuwe koppelcode maakt de {pending} klaarstaande memory{pending === 1 ? '' : "'s"} onbruikbaar
            (die zijn met de oude sleutel versleuteld). Importeer ze eerst, of gooi ze weg.
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button
              style={{ ...btn(u), borderColor: u.danger, color: u.danger }}
              disabled={busy}
              onClick={() => void rotate(true)}
            >
              Weggooien en nieuwe code
            </button>
          </div>
        </div>
      )}

      {error && <div style={{ color: u.danger, fontSize: 12, marginTop: 10 }}>{error}</div>}

      <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
        <button style={btn(u)} disabled={busy} onClick={() => void showQr()}>
          Toon QR-code
        </button>
        <button style={btn(u)} disabled={busy} onClick={() => void rotate(false)}>
          Nieuwe koppelcode
        </button>
        <button
          style={{ ...btn(u), borderColor: u.danger, color: u.danger }}
          disabled={busy}
          onClick={() => void unpair()}
        >
          Ontkoppelen
        </button>
      </div>
      <div style={desc(u)}>
        "Toon QR-code" laat dezelfde koppeling opnieuw zien (om te heropenen of een tweede telefoon te
        koppelen). "Nieuwe koppelcode" vervángt je oude koppeling (bijv. als je telefoon kwijt is).
      </div>
    </div>
  )
}
