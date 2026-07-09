// Full-screen diavoorstelling. Twee weergaven (instelling `diaMode`):
// - 'kenburns': langzame, doorlopende zoom/pan + crossfade.
// - 'crossfade': stilstaande full-screen foto die naar de volgende overvloeit.
//
// De crossfade speelt ALTIJD over een geladen afbeelding: bij het wisselen preloaden
// we de volgende foto en wisselen we pas als die klaar is. Zo "popt" een trage foto
// niet meer in beeld (de bug waarbij sommige overgangen niet mooi infaden).
//
// Sluit alleen met Escape (het is een diavoorstelling; muisbeweging sluit 'm niet).

import { useEffect, useRef, useState } from 'react'
import type { Backend } from '../lib/backend'

interface Props {
  photoIds: string[]
  thumb: Backend['thumb']
  speedMs: number
  mode: 'kenburns' | 'crossfade'
  onClose: () => void
}

// Ken Burns-varianten (begin/eind transform), per foto afgewisseld.
const KB = [
  { from: 'scale(1) translate(0%, 0%)', to: 'scale(1.14) translate(-2.5%, -2%)' },
  { from: 'scale(1.14) translate(2.5%, 1.5%)', to: 'scale(1) translate(0%, 0%)' },
  { from: 'scale(1.02) translate(1%, -1%)', to: 'scale(1.16) translate(2.5%, -1.5%)' },
  { from: 'scale(1.16) translate(-1.5%, 2%)', to: 'scale(1.04) translate(1.5%, -2%)' },
]

function shuffle<T>(a: T[]): T[] {
  const r = [...a]
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[r[i], r[j]] = [r[j], r[i]]
  }
  return r
}

export function Screensaver({ photoIds, thumb, speedMs, mode, onClose }: Props) {
  const [order] = useState(() => shuffle(photoIds))
  const [cur, setCur] = useState(0)
  const [prev, setPrev] = useState<number | null>(null)
  const [tick, setTick] = useState(0) // forceert een verse animatie per wissel
  const curRef = useRef(0)
  curRef.current = cur

  const dur = Math.max(2000, speedMs)
  const kbDur = Math.round(dur * 1.6) // beweging loopt langer dan het interval
  const fadeMs = Math.min(1600, Math.round(dur * 0.5))

  const url = (i: number): string => {
    const id = order[i]
    return (id ? thumb(id, 2048).url : '') ?? ''
  }

  // Rotatie: preload de volgende foto, wissel PAS bij load (of error) → de crossfade
  // speelt altijd over een geladen afbeelding. Timer los van image-load.
  useEffect(() => {
    if (order.length <= 1) return
    let cancelled = false
    let timer = 0
    const advance = (): void => {
      const next = (curRef.current + 1) % order.length
      const pre = new Image()
      const go = (): void => {
        if (cancelled) return
        setPrev(curRef.current)
        setCur(next)
        setTick((t) => t + 1)
        timer = window.setTimeout(advance, dur)
      }
      pre.onload = go
      pre.onerror = go // niet blijven hangen op een kapotte foto
      pre.src = url(next)
    }
    timer = window.setTimeout(advance, dur)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order.length, dur])

  // Sluiten: alleen Escape (capture + stop, geen onderliggende navigatie).
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
  const kb = KB[tick % KB.length]!
  const kenburns = mode === 'kenburns'
  const curAnim = kenburns
    ? `ml-kb ${kbDur}ms linear both, ml-fade ${fadeMs}ms ease-out both`
    : `ml-fade ${fadeMs}ms ease-out both`

  return (
    <div style={overlay}>
      {prev !== null && <img key={`p${tick}`} src={url(prev)} alt="" style={{ ...imgBase, zIndex: 0 }} />}
      <img
        key={`c${tick}`}
        src={url(cur)}
        alt=""
        onError={(e) => {
          e.currentTarget.style.visibility = 'hidden'
        }}
        style={{
          ...imgBase,
          zIndex: 1,
          animation: curAnim,
          ['--kb-from' as string]: kb.from,
          ['--kb-to' as string]: kb.to,
        }}
      />
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
