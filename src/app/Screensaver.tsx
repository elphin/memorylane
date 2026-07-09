// Full-screen diavoorstelling (Ken Burns). Toont de meegegeven foto's in
// willekeurige volgorde met een langzame, doorlopende zoom/pan en een crossfade
// tussen de foto's. Sluit alleen met Escape (het is een diavoorstelling, geen
// screensaver — muisbeweging sluit 'm niet). De rotatie-timer draait los van het
// laden van de afbeelding: een kapotte thumbnail blokkeert 'm niet.
//
// Elke foto is een eigen <img> met een STABIELE key, zodat de uitgaande foto zijn
// animatie behoudt (geen terugsprong naar de beginstand). Twee losse animaties:
// - ml-kb: de Ken Burns-transform (loopt langer dan het slide-interval, dus de
//   beweging staat nooit stil vóór de wissel).
// - ml-fade: de opacity-crossfade waarmee de nieuwe foto over de vorige infadet.

import { useEffect, useState } from 'react'
import type { Backend } from '../lib/backend'

interface Props {
  photoIds: string[]
  thumb: Backend['thumb']
  speedMs: number
  onClose: () => void
}

// Ken Burns-varianten: begin- en eind-transform (scale + translate). Per foto
// afgewisseld zodat de beweging niet elke keer identiek is.
const KB = [
  { from: 'scale(1) translate(0%, 0%)', to: 'scale(1.14) translate(-2.5%, -2%)' },
  { from: 'scale(1.14) translate(2.5%, 1.5%)', to: 'scale(1) translate(0%, 0%)' },
  { from: 'scale(1.02) translate(1%, -1%)', to: 'scale(1.16) translate(2.5%, -1.5%)' },
  { from: 'scale(1.16) translate(-1.5%, 2%)', to: 'scale(1.04) translate(1.5%, -2%)' },
]

interface Slide {
  id: number // stabiele key → de uitgaande foto behoudt zijn animatie
  idx: number // index in `order`
  kb: number // Ken Burns-variant
}

function shuffle<T>(a: T[]): T[] {
  const r = [...a]
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[r[i], r[j]] = [r[j], r[i]]
  }
  return r
}

export function Screensaver({ photoIds, thumb, speedMs, onClose }: Props) {
  const [order] = useState(() => shuffle(photoIds))
  const [slides, setSlides] = useState<Slide[]>(() => [{ id: 0, idx: 0, kb: 0 }])
  const dur = Math.max(2500, speedMs)
  // De Ken Burns-beweging loopt langer dan het interval → altijd nog in beweging
  // bij de wissel (geen "stilstand" aan het eind). De crossfade is korter.
  const kbDur = Math.round(dur * 1.6)
  const fadeMs = Math.min(1400, Math.round(dur * 0.45))

  // Rotatie-timer, ontkoppeld van image-load. Houd alleen de laatste twee foto's
  // in beeld (de uitgaande onder de infadende nieuwe).
  useEffect(() => {
    if (order.length <= 1) return
    const t = window.setInterval(() => {
      setSlides((s) => {
        const last = s[s.length - 1]!
        const id = last.id + 1
        return [last, { id, idx: (last.idx + 1) % order.length, kb: id % KB.length }]
      })
    }, dur)
    return () => window.clearInterval(t)
  }, [order.length, dur])

  // Sluiten: uitsluitend met Escape (capture + stop, zodat niets eronder navigeert).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    const prevCursor = document.body.style.cursor
    document.body.style.cursor = 'none'
    return () => {
      window.removeEventListener('keydown', onKey, true)
      document.body.style.cursor = prevCursor
    }
  }, [onClose])

  if (order.length === 0) return null
  const url = (i: number): string => {
    const id = order[i]
    return (id ? thumb(id, 2048).url : '') ?? ''
  }

  return (
    <div style={overlay}>
      {slides.map((s, i) => {
        const kb = KB[s.kb] ?? KB[0]!
        return (
          <img
            key={s.id}
            src={url(s.idx)}
            alt=""
            onError={(e) => {
              e.currentTarget.style.visibility = 'hidden'
            }}
            style={{
              ...imgBase,
              zIndex: i, // nieuwste bovenop → fadet over de vorige
              animation: `ml-kb ${kbDur}ms linear both, ml-fade ${fadeMs}ms ease-out both`,
              ['--kb-from' as string]: kb.from,
              ['--kb-to' as string]: kb.to,
            }}
          />
        )
      })}
      <div style={hint}>Esc om te sluiten</div>
      <style>{`
        @keyframes ml-kb { from { transform: var(--kb-from); } to { transform: var(--kb-to); } }
        @keyframes ml-fade { from { opacity: 0; } to { opacity: 1; } }
      `}</style>
    </div>
  )
}

const overlay: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 1000,
  background: '#000',
  overflow: 'hidden',
}

const imgBase: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
  objectFit: 'cover',
  willChange: 'transform, opacity',
}

const hint: React.CSSProperties = {
  position: 'absolute',
  bottom: 24,
  left: '50%',
  transform: 'translateX(-50%)',
  padding: '6px 14px',
  borderRadius: 999,
  background: 'rgba(0,0,0,0.45)',
  color: 'rgba(255,255,255,0.75)',
  fontSize: 13,
  letterSpacing: 0.3,
  pointerEvents: 'none',
  zIndex: 10,
}
