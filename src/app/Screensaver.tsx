// Full-screen Ken Burns-diavoorstelling (screensaver). Toont de meegegeven
// foto's in willekeurige volgorde met een langzame zoom/pan + crossfade. Sluit op
// Esc / een toets / muisbeweging / klik — alle pas ná een korte grace-periode,
// zodat de actie die 'm opende 'm niet meteen weer sluit. De rotatie-timer draait
// los van het laden van de afbeelding: een kapotte thumbnail blokkeert 'm niet.

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
  { from: 'scale(1) translate(0%, 0%)', to: 'scale(1.12) translate(-2%, -2%)' },
  { from: 'scale(1.1) translate(2%, 1%)', to: 'scale(1) translate(0%, 0%)' },
  { from: 'scale(1) translate(0%, 0%)', to: 'scale(1.12) translate(2%, -1%)' },
  { from: 'scale(1.08) translate(-1%, 2%)', to: 'scale(1.14) translate(1%, -2%)' },
]

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
  const [cur, setCur] = useState(0)
  // De vorige foto blijft eronder staan zodat de nieuwe eroverheen kan infaden
  // (crossfade). null bij de eerste foto.
  const [prev, setPrev] = useState<number | null>(null)
  const dur = Math.max(2000, speedMs)

  // Rotatie-timer, ontkoppeld van image-load.
  useEffect(() => {
    if (order.length <= 1) return
    const t = window.setInterval(() => {
      setCur((c) => {
        setPrev(c)
        return (c + 1) % order.length
      })
    }, dur)
    return () => window.clearInterval(t)
  }, [order.length, dur])

  // Sluit-triggers, alle pas na de grace-periode.
  useEffect(() => {
    let armed = false
    const arm = window.setTimeout(() => {
      armed = true
    }, 800)
    const close = (): void => {
      if (armed) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (!armed) return
      // Capture + stop: geen onderliggende app-sneltoets (Esc→terug, 'e'→view-modus).
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('mousemove', close)
    window.addEventListener('click', close)
    const prevCursor = document.body.style.cursor
    document.body.style.cursor = 'none'
    return () => {
      window.clearTimeout(arm)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('mousemove', close)
      window.removeEventListener('click', close)
      document.body.style.cursor = prevCursor
    }
  }, [onClose])

  if (order.length === 0) return null
  const kb = KB[cur % KB.length] ?? KB[0]!
  const url = (i: number): string => {
    const id = order[i]
    return (id ? thumb(id, 2048).url : '') ?? ''
  }

  return (
    <div style={overlay}>
      {prev !== null && <img src={url(prev)} alt="" style={{ ...imgBase, opacity: 1 }} />}
      <img
        key={cur}
        src={url(cur)}
        alt=""
        onError={(e) => {
          // Kapotte thumbnail: verberg 'm; de timer schuift vanzelf door.
          e.currentTarget.style.visibility = 'hidden'
        }}
        style={{
          ...imgBase,
          animation: `ml-kenburns ${dur}ms ease-out forwards`,
          ['--kb-from' as string]: kb.from,
          ['--kb-to' as string]: kb.to,
        }}
      />
      <div style={hint}>Esc om te sluiten</div>
      <style>{`
        @keyframes ml-kenburns {
          0%   { opacity: 0; transform: var(--kb-from); }
          12%  { opacity: 1; }
          100% { opacity: 1; transform: var(--kb-to); }
        }
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
}
