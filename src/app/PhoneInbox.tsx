// Telefoon-brievenbus in de hoofd-UI: een melding als er memories van je
// telefoon klaarstaan (met waarschuwing als de eerste bijna verloopt), en —
// als dat aan staat — automatisch importeren bij het opstarten.
//
// Waarom hier en niet alleen in Instellingen: de brievenbus ruimt klaarstaande
// memories na 30 dagen op. Wie Instellingen niet opent, merkte dat niet.

import { useEffect, useRef, useState } from 'react'
import type { Backend, ImportProgress } from '../lib/backend'
import { ui } from '../theme/ui'

// Vanaf zoveel dagen vóór het verloop kleurt de melding als waarschuwing.
const WARN_DAYS = 7
// Bij terugkeer naar het venster niet vaker dan dit opnieuw bij de server kijken.
const FOCUS_RECHECK_MS = 10 * 60 * 1000

export type InboxBanner =
  | { kind: 'pending'; count: number; daysLeft: number | null; note?: string }
  | { kind: 'importing'; progress: ImportProgress | null }
  | { kind: 'imported'; count: number }
  | { kind: 'error'; message: string }

function errMsg(e: unknown): string {
  if (typeof e === 'string') return e
  if (e instanceof Error) return e.message
  return String(e)
}

const plural = (n: number): string => (n === 1 ? 'memory' : 'memories')

/**
 * @param ready        de tijdlijn staat (vault geladen) — pas dan kijken we.
 * @param autoImport   instelling "automatisch importeren bij opstarten".
 * @param onImported   tijdlijn herbouwen zodat de nieuwe memories verschijnen.
 * @param onLifeline   staat de gebruiker nu op het overzicht (niveau lifeline)?
 * @param notify       korte toast.
 */
export function usePhoneInbox({
  backend,
  ready,
  autoImport,
  onImported,
  onLifeline,
  notify,
}: {
  backend: Backend | null
  ready: boolean
  autoImport: boolean
  onImported: () => void
  onLifeline: () => boolean
  notify: (msg: string) => void
}) {
  const [banner, setBanner] = useState<InboxBanner | null>(null)
  const importing = useRef(false)
  const lastCheck = useRef(0)
  const startedUp = useRef(false)
  // Heeft de gebruiker sinds het opstarten iets aangeraakt? Dan herbouwen we de
  // tijdlijn na een automatische import NIET vanzelf (dat zou camera, filter en
  // muziek resetten midden in het kijken), maar bieden we "Tonen" aan.
  const interacted = useRef(false)
  // Laatste waarden voor de callbacks in listeners/async-vervolg.
  const live = useRef({ backend, autoImport, onImported, onLifeline, notify })
  live.current = { backend, autoImport, onImported, onLifeline, notify }

  useEffect(() => {
    const mark = (): void => {
      interacted.current = true
    }
    window.addEventListener('pointerdown', mark, true)
    window.addEventListener('wheel', mark, true)
    window.addEventListener('keydown', mark, true)
    return () => {
      window.removeEventListener('pointerdown', mark, true)
      window.removeEventListener('wheel', mark, true)
      window.removeEventListener('keydown', mark, true)
    }
  }, [])

  /** Haal de stand op. Geeft null als er niet gekoppeld is of de server onbereikbaar is. */
  async function summary(): Promise<{ count: number; daysLeft: number | null } | null> {
    const b = live.current.backend
    if (!b) return null
    try {
      const st = await b.inboxStatus()
      if (!st.configured) return null
      const s = await b.inboxPendingSummary()
      lastCheck.current = Date.now()
      const daysLeft = s.soonestExpiresAt
        ? Math.ceil((Date.parse(s.soonestExpiresAt) - Date.now()) / 86400000)
        : null
      return { count: s.count, daysLeft }
    } catch {
      return null // offline of niet gekoppeld: gewoon geen melding
    }
  }

  async function check(allowAuto: boolean): Promise<void> {
    if (importing.current) return
    const s = await summary()
    if (!s || importing.current) return
    if (s.count === 0) {
      setBanner((cur) => (cur?.kind === 'pending' ? null : cur))
      return
    }
    if (allowAuto && live.current.autoImport) await runImport(true)
    else setBanner({ kind: 'pending', count: s.count, daysLeft: s.daysLeft })
  }

  async function runImport(auto: boolean): Promise<void> {
    const b = live.current.backend
    if (!b || importing.current) return
    importing.current = true
    setBanner({ kind: 'importing', progress: null })
    let unlisten: (() => void) | null = null
    try {
      unlisten = await b.onInboxProgress((p) => setBanner({ kind: 'importing', progress: p }))
      const r = await b.inboxImport()
      let next: InboxBanner | null = null
      if (r.imported > 0) {
        // Handmatig geklikt, of automatisch terwijl je nog niets aanraakte en op
        // het overzicht staat: meteen tonen. Anders niet storen maar aanbieden.
        if (!auto || (!interacted.current && live.current.onLifeline())) {
          live.current.onImported()
          live.current.notify(`${r.imported} ${plural(r.imported)} van je telefoon binnengehaald`)
        } else {
          next = { kind: 'imported', count: r.imported }
        }
      }
      if (r.errors.length > 0) {
        // Wat niet lukte, staat nog in de brievenbus: opnieuw tonen, met de reden.
        const s = await summary()
        const note = `${r.errors.length} niet gelukt: ${r.errors[0].message}`
        next = s && s.count > 0 ? { kind: 'pending', count: s.count, daysLeft: s.daysLeft, note } : { kind: 'error', message: note }
      }
      setBanner(next)
    } catch (e) {
      setBanner({ kind: 'error', message: errMsg(e) })
    } finally {
      if (unlisten) unlisten()
      importing.current = false
    }
  }

  // Eén keer bij het opstarten, zodra de tijdlijn staat.
  useEffect(() => {
    if (!ready || startedUp.current) return
    startedUp.current = true
    void check(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready])

  // Terug naar het venster: stand bijwerken (nooit automatisch importeren: dat
  // zou je midden in het kijken uit je memory kunnen halen).
  useEffect(() => {
    const onFocus = (): void => {
      if (!startedUp.current || Date.now() - lastCheck.current < FOCUS_RECHECK_MS) return
      void check(false)
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return {
    banner,
    importNow: () => void runImport(false),
    showImported: () => {
      live.current.onImported()
      setBanner(null)
    },
    dismiss: () => setBanner(null),
    /** Opnieuw kijken (bv. na een import via Instellingen), zonder auto-import. */
    refresh: () => {
      lastCheck.current = 0
      void check(false)
    },
  }
}

export function PhoneInboxBanner({
  banner,
  onImport,
  onShow,
  onDismiss,
}: {
  banner: InboxBanner
  onImport: () => void
  onShow: () => void
  onDismiss: () => void
}) {
  const u = ui()
  const warn = banner.kind === 'pending' && banner.daysLeft !== null && banner.daysLeft <= WARN_DAYS
  const btn: React.CSSProperties = {
    padding: '6px 12px',
    borderRadius: 8,
    border: `1px solid ${u.primary}`,
    background: u.primary,
    color: u.primaryText,
    font: '12px sans-serif',
    cursor: 'pointer',
    flex: '0 0 auto',
  }

  let title: string
  let sub: string | null = null
  let action: React.ReactNode = null
  switch (banner.kind) {
    case 'pending':
      title = `📥 ${banner.count} ${plural(banner.count)} van je telefoon ${banner.count === 1 ? 'staat' : 'staan'} klaar`
      if (warn) {
        const d = banner.daysLeft!
        sub = d <= 1 ? 'De eerste verloopt vandaag in de brievenbus' : `De eerste verloopt over ${d} dagen in de brievenbus`
      }
      if (banner.note) sub = sub ? `${sub} · ${banner.note}` : banner.note
      action = (
        <button style={btn} onClick={onImport}>
          Importeren
        </button>
      )
      break
    case 'importing': {
      const p = banner.progress
      title = 'Memories van je telefoon importeren…'
      sub = p ? `Memory ${p.memoryIndex + 1} van ${p.memoryCount}` : null
      break
    }
    case 'imported':
      title = `✓ ${banner.count} ${plural(banner.count)} van je telefoon binnengehaald`
      action = (
        <button style={btn} onClick={onShow}>
          Tonen
        </button>
      )
      break
    case 'error':
      title = 'Importeren van je telefoon lukte niet'
      sub = banner.message
      break
  }

  return (
    <div
      role="status"
      style={{
        position: 'absolute',
        left: 16,
        bottom: 16,
        zIndex: 1050,
        maxWidth: 380,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 12px 10px 14px',
        borderRadius: 12,
        background: warn ? u.warnBg : u.toastBg,
        border: `1px solid ${warn ? u.warnBorder : u.border}`,
        color: u.toastText,
        font: '13px sans-serif',
        boxShadow: '0 6px 20px rgba(0,0,0,0.45)',
      }}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        <div>{title}</div>
        {sub && (
          <div style={{ fontSize: 12, marginTop: 3, color: warn || banner.kind === 'error' ? u.warnSoft : u.textMuted }}>{sub}</div>
        )}
      </div>
      {action}
      {banner.kind !== 'importing' && (
        <button
          aria-label="Verbergen"
          onClick={onDismiss}
          style={{ background: 'none', border: 0, color: u.textMuted, cursor: 'pointer', fontSize: 16, padding: '0 2px', flex: '0 0 auto' }}
        >
          ×
        </button>
      )}
    </div>
  )
}
