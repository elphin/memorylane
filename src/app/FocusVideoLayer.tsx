// L3-video-overlay: een DOM-<video> exact over de gefocuste video, met bediening
// (native controls verschijnen op hover) en prev/next-chevrons aan de schermrand.
// De positie wordt imperatief bijgewerkt vanuit AppShell's frame-lus (via `ref`),
// zodat de speler aan de video "vastgeplakt" blijft. Pas gemount als de inzoom-
// animatie klaar is (anders zou de overlay verkeerd staan).

import { forwardRef, useEffect, useRef } from 'react'

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
    lineHeight: '50px',
    cursor: 'pointer',
    display: 'grid',
    placeItems: 'center',
  }
}

export const FocusVideoLayer = forwardRef<
  HTMLDivElement,
  {
    src: string
    poster: string
    canStep: boolean
    onPrev: () => void
    onNext: () => void
  }
>(function FocusVideoLayer({ src, poster, canStep, onPrev, onNext }, ref) {
  const videoRef = useRef<HTMLVideoElement>(null)
  // Bij het wisselen van bron (of verlaten): expliciet pauzeren en de media-
  // verbinding vrijgeven — niet blind op React-unmount vertrouwen.
  useEffect(() => {
    const el = videoRef.current
    return () => {
      if (el) {
        el.pause()
        el.removeAttribute('src')
        el.load()
      }
    }
  }, [src])
  return (
    // Volledig scherm, maar transparant voor muis — zo blijven klikken naast de
    // video (achtergrond) op het canvas landen (ver uitzoomen = terug).
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 40 }}>
      {/* Verborgen tot de frame-lus 'm voor het eerst positioneert (geen flits linksboven). */}
      <div ref={ref} style={{ position: 'absolute', pointerEvents: 'auto', visibility: 'hidden' }}>
        <video
          key={src}
          ref={videoRef}
          src={src || undefined}
          poster={poster || undefined}
          controls
          controlsList="nodownload noremoteplayback"
          preload="metadata"
          playsInline
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            background: '#000',
            borderRadius: 8,
            display: 'block',
          }}
        />
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
