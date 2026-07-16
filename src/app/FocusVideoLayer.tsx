// L3-video-overlay: een DOM-<video> exact over de gefocuste video, met een eigen
// (mooie) bediening i.p.v. de standaard-browserskin. Positie wordt imperatief
// bijgewerkt vanuit AppShell's frame-lus (via `ref`); pas gemount als de inzoom-
// animatie klaar is. De overlay-rect volgt de échte video-verhouding (via
// onAspect), zodat er geen zwarte klikbare randen zijn.

import { forwardRef, useEffect, useRef, useState } from 'react'

function fmt(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '0:00'
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

const iconBtn: React.CSSProperties = {
  border: 'none',
  background: 'none',
  color: '#fff',
  cursor: 'pointer',
  padding: 4,
  display: 'grid',
  placeItems: 'center',
  lineHeight: 0,
}

function chevron(side: 'left' | 'right'): React.CSSProperties {
  return {
    position: 'absolute',
    top: '50%',
    [side]: 22,
    transform: 'translateY(-50%)',
    pointerEvents: 'auto',
    width: 54,
    height: 54,
    borderRadius: '50%',
    border: 'none',
    background: 'rgba(18,22,32,0.55)',
    color: '#fff',
    fontSize: 30,
    cursor: 'pointer',
    display: 'grid',
    placeItems: 'center',
  }
}

// Kleine monochrome SVG-iconen (premium, consistent).
const Play = ({ s = 24 }: { s?: number }) => (
  <svg width={s} height={s} viewBox="0 0 24 24" fill="currentColor">
    <path d="M8 5v14l11-7z" />
  </svg>
)
const Pause = ({ s = 24 }: { s?: number }) => (
  <svg width={s} height={s} viewBox="0 0 24 24" fill="currentColor">
    <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
  </svg>
)
const VolOn = () => (
  <svg width={22} height={22} viewBox="0 0 24 24" fill="currentColor">
    <path d="M4 9v6h4l5 5V4L8 9H4zm12 3a4 4 0 00-2-3.46v6.92A4 4 0 0016 12z" />
  </svg>
)
const VolOff = () => (
  <svg width={22} height={22} viewBox="0 0 24 24" fill="currentColor">
    <path d="M4 9v6h4l5 5V4L8 9H4zm15.5 3l2-2-1-1-2 2-2-2-1 1 2 2-2 2 1 1 2-2 2 2 1-1-2-2z" />
  </svg>
)
const Full = () => (
  <svg width={20} height={20} viewBox="0 0 24 24" fill="currentColor">
    <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />
  </svg>
)

export const FocusVideoLayer = forwardRef<
  HTMLDivElement,
  {
    src: string
    poster: string
    canStep: boolean
    onPrev: () => void
    onNext: () => void
    onClose: () => void
    /** Werkelijke video-verhouding (b/h) na loadedmetadata, of null. */
    onAspect: (aspect: number | null) => void
  }
>(function FocusVideoLayer({ src, poster, canStep, onPrev, onNext, onClose, onAspect }, ref) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const [playing, setPlaying] = useState(false)
  const [cur, setCur] = useState(0)
  const [dur, setDur] = useState(0)
  const [muted, setMuted] = useState(false)
  const [hover, setHover] = useState(false)

  // Bij bronwissel: speler-staat resetten (nieuw item start gepauzeerd op 0), en
  // bij verlaten expliciet stoppen + de bron vrijgeven.
  useEffect(() => {
    setPlaying(false)
    setCur(0)
    setDur(0)
    const el = videoRef.current
    return () => {
      if (el) {
        el.pause()
        el.removeAttribute('src')
        el.load()
      }
    }
  }, [src])

  const setWrap = (el: HTMLDivElement | null): void => {
    wrapRef.current = el
    if (typeof ref === 'function') ref(el)
    else if (ref) ref.current = el
  }

  function toggle(): void {
    const v = videoRef.current
    if (!v) return
    if (v.paused) void v.play()
    else v.pause()
  }
  function seek(e: React.PointerEvent<HTMLDivElement>): void {
    const v = videoRef.current
    if (!v || !dur) return
    const rect = e.currentTarget.getBoundingClientRect()
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    v.currentTime = frac * dur
  }
  function toggleMute(): void {
    const v = videoRef.current
    if (!v) return
    v.muted = !v.muted
    setMuted(v.muted)
  }
  function fullscreen(): void {
    const w = wrapRef.current
    if (!w) return
    if (document.fullscreenElement) void document.exitFullscreen()
    else void w.requestFullscreen()
  }

  const showBar = hover || !playing
  const pct = dur ? (cur / dur) * 100 : 0

  return (
    // Volledig scherm, transparant voor muis — klikken náást de video landen op het
    // canvas (achtergrond = terug). De video + knoppen vangen hun eigen klikken.
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 40 }}>
      <div
        ref={setWrap}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{ position: 'absolute', pointerEvents: 'auto', visibility: 'hidden', overflow: 'hidden', borderRadius: 8, background: '#000' }}
      >
        <video
          key={src}
          ref={videoRef}
          src={src || undefined}
          poster={poster || undefined}
          playsInline
          preload="metadata"
          onClick={toggle}
          onLoadedMetadata={(e) => {
            const v = e.currentTarget
            setDur(v.duration || 0)
            onAspect(v.videoWidth && v.videoHeight ? v.videoWidth / v.videoHeight : null)
          }}
          onTimeUpdate={(e) => setCur(e.currentTarget.currentTime)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block', background: '#000' }}
        />

        {/* Center play-knop (klein) wanneer gepauzeerd. */}
        {!playing && (
          <button
            onClick={toggle}
            aria-label="Afspelen"
            style={{
              position: 'absolute',
              left: '50%',
              top: '50%',
              transform: 'translate(-50%,-50%)',
              width: 62,
              height: 62,
              borderRadius: '50%',
              border: 'none',
              cursor: 'pointer',
              background: 'rgba(15,18,26,0.5)',
              color: '#fff',
              display: 'grid',
              placeItems: 'center',
              paddingLeft: 4,
            }}
          >
            <Play s={26} />
          </button>
        )}

        {/* Sluitknop rechtsboven. */}
        <button
          onClick={onClose}
          aria-label="Sluiten"
          style={{
            position: 'absolute',
            top: 8,
            right: 8,
            width: 32,
            height: 32,
            borderRadius: '50%',
            border: 'none',
            background: 'rgba(15,18,26,0.5)',
            color: '#fff',
            fontSize: 18,
            cursor: 'pointer',
            opacity: showBar ? 1 : 0,
            transition: 'opacity .2s',
          }}
        >
          ×
        </button>

        {/* Bedieningsbalk (fade-in op hover / bij pauze). */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            padding: '14px 12px 10px',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            background: 'linear-gradient(transparent, rgba(0,0,0,0.65))',
            opacity: showBar ? 1 : 0,
            transition: 'opacity .2s',
          }}
        >
          <button onClick={toggle} style={iconBtn} aria-label={playing ? 'Pauze' : 'Afspelen'}>
            {playing ? <Pause s={22} /> : <Play s={22} />}
          </button>
          <div
            onPointerDown={seek}
            style={{ flex: 1, height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.3)', cursor: 'pointer', position: 'relative' }}
          >
            <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${pct}%`, background: '#fff', borderRadius: 3 }} />
          </div>
          <span style={{ color: '#fff', fontSize: 12, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
            {fmt(cur)} / {fmt(dur)}
          </span>
          <button onClick={toggleMute} style={iconBtn} aria-label="Geluid">
            {muted ? <VolOff /> : <VolOn />}
          </button>
          <button onClick={fullscreen} style={iconBtn} aria-label="Volledig scherm">
            <Full />
          </button>
        </div>
      </div>

      {canStep && (
        <>
          <button aria-label="Vorige" onClick={onPrev} style={chevron('left')}>
            ‹
          </button>
          <button aria-label="Volgende" onClick={onNext} style={chevron('right')}>
            ›
          </button>
        </>
      )}
    </div>
  )
})
