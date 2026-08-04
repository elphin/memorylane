// App-brede muziekspeler. Eén DOM-`<audio>` boven het canvas, plus een klein
// "nu speelt"-balkje zodat je altijd ziet waar het geluid vandaan komt en het
// kunt stoppen.
//
// Er speelt NOOIT meer dan één liedje: dit is de enige speler in de app. Een
// nieuwe bron faadt in over ~400ms; stoppen en pauzeren zijn direct (een uitfade
// zou betekenen dat je op "stop" drukt en het nog een halve seconde doorklinkt).
//
// Een liedje zonder lokaal audiobestand is hier niet afspeelbaar -- dat toont
// zijn bronknop en gaat naar Spotify.

import { useEffect, useRef, useState } from 'react'

/** Wat er nu klinkt (of zou moeten klinken). */
export interface NowPlaying {
  itemId: string
  title: string
  artist: string | null
  /** Asset-URL van het lokale audiobestand. */
  src: string
}

const FADE_MS = 400

export function MusicLayer({
  now,
  volume,
  paused,
  hidden,
  onEnded,
  onTogglePause,
  onStop,
}: {
  now: NowPlaying | null
  /** 0..100 uit de instellingen. */
  volume: number
  paused: boolean
  /** Kijkmodus/chromeless of een open dialoog: het balkje faadt weg. */
  hidden: boolean
  onEnded: () => void
  onTogglePause: () => void
  onStop: () => void
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const fadeRef = useRef<number | null>(null)
  const [failed, setFailed] = useState(false)

  // Vangnet tegen een corrupte instellingen-opslag: `el.volume = NaN` gooit, en
  // dat gebeurt dan binnen een effect en sloopt de render.
  const target = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume / 100)) : 0.6
  const targetRef = useRef(target)
  targetRef.current = target

  /** `play()` verwerpt met AbortError zodra er gepauzeerd of herladen wordt vóór
   * het afspelen begon. Dat is normaal gedrag, geen fout -- als we dat als
   * mislukking tellen, meldt het balkje voorgoed "kan niet afspelen" terwijl de
   * muziek gewoon klinkt. */
  const safePlay = (el: HTMLAudioElement): void => {
    el.play()
      .then(() => setFailed(false))
      .catch((err: unknown) => {
        if ((err as DOMException | undefined)?.name !== 'AbortError') setFailed(true)
      })
  }

  // Het element blijft altijd gemount; alleen de bron wisselt. Zo is "stoppen"
  // een expliciete actie in plaats van een bijwerking van unmounten.
  const src = now?.src ?? ''
  // Key op item ÉN bron: twee liedjes kunnen naar hetzelfde bestand wijzen
  // (`media_shared` bestaat daar juist voor), en dan moet wisselen alsnog
  // opnieuw starten in plaats van stilletjes door te lopen.
  const key = now ? `${now.itemId}|${now.src}` : ''

  useEffect(() => {
    const el = audioRef.current
    if (!el) return
    if (fadeRef.current !== null) {
      window.clearInterval(fadeRef.current)
      fadeRef.current = null
    }
    setFailed(false)
    if (!key) {
      el.pause()
      return
    }
    el.currentTime = 0
    el.volume = 0
    safePlay(el)
    const started = performance.now()
    fadeRef.current = window.setInterval(() => {
      const t = Math.min(1, (performance.now() - started) / FADE_MS)
      // Uit de ref, niet uit de closure: anders faadt hij door naar het volume
      // van vóór een schuif-wijziging en blijft dat staan.
      el.volume = targetRef.current * t
      if (t >= 1 && fadeRef.current !== null) {
        window.clearInterval(fadeRef.current)
        fadeRef.current = null
      }
    }, 16)
    return () => {
      if (fadeRef.current !== null) {
        window.clearInterval(fadeRef.current)
        fadeRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  // Volume volgt de instelling zodra er niet gefade wordt.
  useEffect(() => {
    const el = audioRef.current
    if (el && fadeRef.current === null) el.volume = target
  }, [target])

  useEffect(() => {
    const el = audioRef.current
    if (!el || !now) return
    if (paused) {
      el.pause()
      setFailed(false) // pauzeren is geen mislukking
    } else {
      safePlay(el)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused, key])

  return (
    <>
      <audio ref={audioRef} src={src || undefined} onEnded={onEnded} preload="auto" />
      {now && (
        <div
          style={{
            position: 'fixed',
            left: 24,
            bottom: 24,
            zIndex: 60,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '8px 14px 8px 10px',
            borderRadius: 999,
            background: 'rgba(18,20,28,0.86)',
            border: '1px solid rgba(255,255,255,0.12)',
            backdropFilter: 'blur(10px)',
            color: '#eef1f7',
            maxWidth: 320,
            // In kijkmodus verdwijnt het balkje met de rest van het chroom.
            // Escape stopt de muziek dan nog steeds -- zie de toetsafhandeling in
            // AppShell; zonder die uitweg zou muziek daar onstopbaar zijn.
            opacity: hidden ? 0 : 1,
            pointerEvents: hidden ? 'none' : 'auto',
            transition: 'opacity 220ms ease',
          }}
        >
          <button
            type="button"
            onClick={onTogglePause}
            title={paused ? 'Afspelen' : 'Pauzeren'}
            style={iconBtn}
          >
            {paused ? <PlayIcon /> : <PauseIcon />}
          </button>
          <div style={{ minWidth: 0, lineHeight: 1.25 }}>
            <div style={{ fontSize: 13, fontWeight: 600, ...ellipsis }}>
              {failed ? 'Kan dit liedje niet afspelen' : now.title}
            </div>
            {now.artist && !failed && (
              <div style={{ fontSize: 12, opacity: 0.7, ...ellipsis }}>{now.artist}</div>
            )}
          </div>
          <button type="button" onClick={onStop} title="Stoppen" style={{ ...iconBtn, opacity: 0.7 }}>
            <CloseIcon />
          </button>
        </div>
      )}
    </>
  )
}

const ellipsis: React.CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const iconBtn: React.CSSProperties = {
  border: 'none',
  background: 'none',
  color: 'inherit',
  cursor: 'pointer',
  padding: 4,
  display: 'grid',
  placeItems: 'center',
  lineHeight: 0,
}

export function PlayIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M8 5.5v13l11-6.5z" />
    </svg>
  )
}

export function PauseIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M7 5h3.4v14H7zM13.6 5H17v14h-3.4z" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  )
}
