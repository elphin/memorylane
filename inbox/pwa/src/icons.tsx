// Strakke lijn-iconen voor de telefoon-PWA (stroke = currentColor, dus ze volgen
// de tekst-/knopkleur). Vervangen alle emoji's — één consistente, premium stijl.
import type { CSSProperties } from 'react'

interface IconProps {
  size?: number
  style?: CSSProperties
  strokeWidth?: number
}

const base = (style?: CSSProperties): CSSProperties => ({ display: 'block', flex: '0 0 auto', ...style })

function Svg({
  size = 22,
  strokeWidth = 1.7,
  style,
  children,
}: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={base(style)}
    >
      {children}
    </svg>
  )
}

/** Instellingen (tandwiel). */
export function IconGear(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </Svg>
  )
}

/** Plus (nieuwe memory). */
export function IconPlus(p: IconProps) {
  return (
    <Svg strokeWidth={2} {...p}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  )
}

/** Kalender (datum). */
export function IconCalendar(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="3" y="4.5" width="18" height="16" rx="2.5" />
      <path d="M3 9.5h18M8 2.5v4M16 2.5v4" />
    </Svg>
  )
}

/** Afspelen (video). */
export function IconPlay(p: IconProps) {
  return (
    <svg
      width={p.size ?? 22}
      height={p.size ?? 22}
      viewBox="0 0 24 24"
      fill="currentColor"
      style={base(p.style)}
    >
      <path d="M8 5.14v13.72a1 1 0 0 0 1.53.85l10.75-6.86a1 1 0 0 0 0-1.7L9.53 4.29A1 1 0 0 0 8 5.14Z" />
    </svg>
  )
}

/** Bestand (niet-beeld media). */
export function IconFile(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M6.5 2.5H14l5 5v13a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 20.5V4A1.5 1.5 0 0 1 6.5 2.5Z" />
      <path d="M14 2.5V8h5" />
    </Svg>
  )
}

/** Klok (onderweg / wacht op import). */
export function IconClock(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </Svg>
  )
}

/** Vinkje (geïmporteerd / klaar). */
export function IconCheck(p: IconProps) {
  return (
    <Svg strokeWidth={2} {...p}>
      <path d="M4.5 12.5l5 5 10.5-11" />
    </Svg>
  )
}

/** Vinkje in een cirkel (grote "gelukt"-bevestiging). */
export function IconCheckCircle(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9.2" />
      <path d="M8 12.3l2.8 2.8L16.2 9.5" />
    </Svg>
  )
}

/** Waarschuwing (mislukt). */
export function IconAlert(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 3.6 21.5 20a1 1 0 0 1-.87 1.5H3.37A1 1 0 0 1 2.5 20z" />
      <path d="M12 9.5v4.5M12 17.6v.01" />
    </Svg>
  )
}

/** Camera (koppelcode scannen). */
export function IconCamera(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2l1.1-1.8a1 1 0 0 1 .85-.47h5.1a1 1 0 0 1 .85.47L16.5 7h2A1.5 1.5 0 0 1 20 8.5v9A1.5 1.5 0 0 1 18.5 19h-13A1.5 1.5 0 0 1 4 17.5z" />
      <circle cx="12" cy="12.5" r="3.4" />
    </Svg>
  )
}

/** Delen / naar beginscherm (iOS-deelknop-stijl: pijl uit een vak omhoog). */
export function IconShare(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 3v12" />
      <path d="M8.5 6.5 12 3l3.5 3.5" />
      <path d="M7 10.5H6a2 2 0 0 0-2 2v6.5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6.5a2 2 0 0 0-2-2h-1" />
    </Svg>
  )
}

/** Prullenbak (verwijderen). */
export function IconTrash(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4.5 6.5h15" />
      <path d="M9 6.5V5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5v1.5" />
      <path d="M6.5 6.5l.8 13A1.5 1.5 0 0 0 8.8 21h6.4a1.5 1.5 0 0 0 1.5-1.4l.8-13" />
    </Svg>
  )
}
