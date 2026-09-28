// Hoe een outbox-rij zich presenteert (label + kleur + icoon). Gedeeld door het
// overzicht en het detailscherm.

import type { OutboxEntry } from '../store/db'
import { isUploading } from '../upload/queue'
import { daysLeft, expiryOf } from '../upload/reconcile'
import { formatDateShort } from '../util'
import { IconAlert, IconCheck, IconClock } from '../icons'

export type StatusKind = 'pending' | 'done' | 'fail' | 'warn'

export interface StatusView {
  label: string
  kind: StatusKind
  Icon: typeof IconClock
  /** Opnieuw versturen is zinvol (en mogelijk als de inhoud bewaard is). */
  canResend: boolean
  /** Nog aan te passen (niet geïmporteerd, geen lopende upload). */
  canEdit: boolean
}

// Vanaf zoveel dagen vóór het verloop waarschuwen.
export const WARN_DAYS = 7

function isoDay(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function statusView(e: OutboxEntry, now = Date.now()): StatusView {
  const hasContent = !!e.draft
  const running = e.status === 'uploading' && isUploading(e.memoryId)
  const editable = hasContent && e.status !== 'imported' && !running
  switch (e.status) {
    case 'uploading':
      return running
        ? { label: 'Bezig met versturen…', kind: 'pending', Icon: IconClock, canResend: false, canEdit: false }
        : { label: 'Versturen onderbroken', kind: 'fail', Icon: IconAlert, canResend: hasContent, canEdit: editable }
    case 'ready': {
      const left = daysLeft(e, now)
      if (left > WARN_DAYS)
        return {
          label: `Wacht op thuis-import · tot ${formatDateShort(isoDay(expiryOf(e)))}`,
          kind: 'pending',
          Icon: IconClock,
          canResend: false,
          canEdit: editable,
        }
      return {
        label: left <= 1 ? 'Verloopt vandaag — importeer thuis' : `Verloopt over ${left} dagen — importeer thuis`,
        kind: 'warn',
        Icon: IconAlert,
        canResend: false,
        canEdit: editable,
      }
    }
    case 'failed':
      return { label: 'Versturen mislukt', kind: 'fail', Icon: IconAlert, canResend: hasContent, canEdit: editable }
    case 'gone':
      return {
        // De brievenbus bewaart import-bevestigingen een jaar; kent hij de memory
        // niet meer en is de termijn voorbij, dan is hij (vrijwel zeker) verlopen.
        label: expiryOf(e) <= now ? 'Verlopen in de brievenbus' : 'Niet meer in de brievenbus — thuis verwijderd?',
        kind: 'fail',
        Icon: IconAlert,
        canResend: hasContent,
        canEdit: editable,
      }
    case 'imported':
      return { label: 'Geïmporteerd — veilig thuis', kind: 'done', Icon: IconCheck, canResend: false, canEdit: false }
  }
}
