// In-app QR-scanner. Belangrijk pad: dit is dé manier om een op het
// beginscherm geïnstalleerde app (aparte opslag, geen QR-link erin) te
// koppelen. Werkt op Android-Chrome en iOS-Safari standalone (iOS ≥13.4).
//
// getUserMedia vereist een secure context (https of localhost) — productie
// draait op https, dus ok; lokale http-dev heeft geen camera → dan de
// plak-optie gebruiken (de aanroeper toont die).
//
// iOS-eisen (verplicht, niet optioneel): <video> met playsInline + muted +
// autoPlay, en video.play() in een try/catch (autoplay-policy). De component
// mount pas na een gebruikers-tik ("Scan koppelcode"), dus dat is de
// gesture-context.

import { useEffect, useRef, useState } from 'react'
import jsQR from 'jsqr'

const MAX_DECODE_W = 720 // decode op ~720px breed (scherp genoeg, licht voor zwakke telefoons)

export function ScanQr({
  accept,
  onResult,
  onClose,
}: {
  /** Alleen codes waarvoor dit true geeft worden geaccepteerd; andere QR's in
   * beeld worden genegeerd (de loop blijft zoeken). */
  accept: (text: string) => boolean
  onResult: (text: string) => void
  onClose: () => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let stream: MediaStream | null = null
    let raf = 0
    let stopped = false
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d', { willReadFrequently: true })

    function stop(): void {
      stopped = true
      cancelAnimationFrame(raf)
      stream?.getTracks().forEach((t) => t.stop())
    }

    async function start(): Promise<void> {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('Deze browser geeft geen toegang tot de camera. Plak de code hieronder.')
        return
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        })
      } catch (e) {
        const name = (e as { name?: string })?.name
        setError(
          name === 'NotAllowedError'
            ? 'Geen toegang tot de camera. Sta het toe in je browser, of plak de code hieronder.'
            : 'Kon de camera niet openen. Plak de code hieronder.',
        )
        return
      }
      const video = videoRef.current
      if (!video || stopped) {
        stop()
        return
      }
      video.srcObject = stream
      try {
        await video.play()
      } catch {
        /* autoplay-policy — muted+playsInline dekt dit meestal al */
      }
      raf = requestAnimationFrame(tick)
    }

    function tick(): void {
      if (stopped) return
      const video = videoRef.current
      if (video && ctx && video.readyState >= 2 && video.videoWidth > 0) {
        const scale = Math.min(1, MAX_DECODE_W / video.videoWidth)
        const w = Math.round(video.videoWidth * scale)
        const h = Math.round(video.videoHeight * scale)
        canvas.width = w
        canvas.height = h
        ctx.drawImage(video, 0, 0, w, h)
        const img = ctx.getImageData(0, 0, w, h)
        const code = jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' })
        if (code && accept(code.data)) {
          stop()
          onResult(code.data)
          return
        }
      }
      raf = requestAnimationFrame(tick)
    }

    void start()
    return stop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100,
        background: '#000',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div style={{ position: 'relative', flex: 1, overflow: 'hidden' }}>
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
        {/* Richtkader */}
        {!error && (
          <div
            style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%,-50%)',
              width: 'min(66vw, 260px)',
              aspectRatio: '1 / 1',
              border: '3px solid rgba(255,255,255,0.9)',
              borderRadius: 16,
              boxShadow: '0 0 0 9999px rgba(0,0,0,0.45)',
            }}
          />
        )}
        {error && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 28,
              textAlign: 'center',
              color: '#fff',
              background: 'rgba(0,0,0,0.7)',
            }}
          >
            {error}
          </div>
        )}
      </div>
      <div style={{ padding: 16, background: '#000', textAlign: 'center' }}>
        {!error && (
          <div style={{ color: 'rgba(255,255,255,0.85)', fontSize: 14, marginBottom: 12 }}>
            Richt op de QR-code op je computer.
          </div>
        )}
        <button className="btn" onClick={onClose} style={{ width: '100%', maxWidth: 320 }}>
          Annuleren
        </button>
      </div>
    </div>
  )
}
