// Lijn-iconen voor de bediening-dock (designer-concept). Allemaal
// stroke=currentColor zodat ze de knop-tekstkleur volgen (wit op actief/primair,
// gedempt op neutraal). De segment-iconen (Eigen/Grid/Scatter) komen exact uit
// het concept; de actie-iconen zijn in dezelfde lijnstijl getekend.

import type { CSSProperties } from 'react'

interface IconProps {
  size?: number
  style?: CSSProperties
}

const svgBase = (style?: CSSProperties): CSSProperties => ({ display: 'block', ...style })

/** Eigen indeling: één grote + twee kleine kaarten (vrije opstelling). */
export function IconEigen({ size = 20, style }: IconProps) {
  return (
    <svg width={size} height={(size * 18) / 22} viewBox="0 0 22 18" fill="none" stroke="currentColor" strokeWidth={1.5} style={svgBase(style)}>
      <rect x="1.5" y="1.5" width="11" height="15" rx="1.5" />
      <rect x="14.5" y="1.5" width="6" height="7" rx="1.5" />
      <rect x="14.5" y="10" width="6" height="6.5" rx="1.5" />
    </svg>
  )
}

/** Raster: 2×2. */
export function IconGrid({ size = 18, style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth={1.5} style={svgBase(style)}>
      <rect x="1.5" y="1.5" width="6.5" height="6.5" rx="1.3" />
      <rect x="10" y="1.5" width="6.5" height="6.5" rx="1.3" />
      <rect x="1.5" y="10" width="6.5" height="6.5" rx="1.3" />
      <rect x="10" y="10" width="6.5" height="6.5" rx="1.3" />
    </svg>
  )
}

/** Verspreid: schuin geplaatste kaarten. */
export function IconScatter({ size = 20, style }: IconProps) {
  return (
    <svg width={size} height={(size * 18) / 22} viewBox="0 0 22 18" fill="none" stroke="currentColor" strokeWidth={1.5} style={svgBase(style)}>
      <rect x="1" y="4" width="8.5" height="8.5" rx="1.3" transform="rotate(-10 5.25 8.25)" />
      <rect x="11.5" y="2" width="8.5" height="8.5" rx="1.3" transform="rotate(11 15.75 6.25)" />
    </svg>
  )
}

/** Scatter recht/gedraaid-schakelaar (een licht gekantelde kaart). */
export function IconRotate({ size = 16, style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} style={svgBase(style)}>
      <rect x="4" y="4" width="8" height="8" rx="1.3" transform="rotate(12 8 8)" />
    </svg>
  )
}

/** Opslaan-als-Eigen: kopieer de huidige opstelling (twee gestapelde kaarten). */
export function IconCopy({ size = 18, style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.5} style={svgBase(style)}>
      <rect x="6.5" y="6.5" width="11" height="11" rx="2.2" />
      <path d="M13.5 6.5V4.2A1.7 1.7 0 0 0 11.8 2.5H4.2A1.7 1.7 0 0 0 2.5 4.2v7.6a1.7 1.7 0 0 0 1.7 1.7h2.3" />
    </svg>
  )
}

/** Foto's toevoegen: afbeelding met zon en bergen. */
export function IconImage({ size = 20, style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} style={svgBase(style)}>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <circle cx="8.5" cy="9.5" r="1.9" />
      <path d="M4 17.5l4.5-4.5 3.2 3.2 3.3-3.3L20 16.5" />
    </svg>
  )
}

/** Notitie toevoegen: kaart met tekstregels. */
export function IconNote({ size = 20, style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} style={svgBase(style)}>
      <path d="M4.5 5.5A1.5 1.5 0 0 1 6 4h8l5 5v9.5A1.5 1.5 0 0 1 17.5 20h-11A1.5 1.5 0 0 1 5 18.5z" />
      <path d="M13.5 4v5h5" />
      <path d="M8.5 13h7M8.5 16.5h4.5" strokeLinecap="round" />
    </svg>
  )
}

/** Weergave aanpassen: schuifjes. */
export function IconSliders({ size = 20, style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} style={svgBase(style)}>
      <path d="M4 7h9M18 7h2" strokeLinecap="round" />
      <circle cx="15.5" cy="7" r="2.1" />
      <path d="M4 12h3M11.5 12h8.5" strokeLinecap="round" />
      <circle cx="9" cy="12" r="2.1" />
      <path d="M4 17h9M18 17h2" strokeLinecap="round" />
      <circle cx="15.5" cy="17" r="2.1" />
    </svg>
  )
}

/** Thema & sfeer: palet met kleurstippen. */
export function IconPalette({ size = 20, style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} style={svgBase(style)}>
      <path d="M12 3.5c-4.7 0-8.5 3.6-8.5 8s3.5 6.7 6 6.7c1.4 0 1.9-.9 1.9-1.8 0-.6-.4-1-.4-1.6 0-.7.6-1.2 1.4-1.2h1.9c3 0 5.2-2.1 5.2-5C19 6.6 15.9 3.5 12 3.5Z" />
      <circle cx="8" cy="10" r="1.05" fill="currentColor" stroke="none" />
      <circle cx="12" cy="8" r="1.05" fill="currentColor" stroke="none" />
      <circle cx="15.5" cy="10" r="1.05" fill="currentColor" stroke="none" />
    </svg>
  )
}

/** Bewerk memory: potlood. */
export function IconPencil({ size = 18, style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinejoin="round" style={svgBase(style)}>
      <path d="M14.5 5.5l4 4" />
      <path d="M4 20l1.2-4.2 10.3-10.3a1.7 1.7 0 0 1 2.4 0l1.3 1.3a1.7 1.7 0 0 1 0 2.4L8.9 19.5 4 20Z" />
    </svg>
  )
}

/** Plus (voor toevoeg-knoppen). */
export function IconPlus({ size = 15, style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" style={svgBase(style)}>
      <path d="M10 4v12M4 10h12" />
    </svg>
  )
}

/** Verwijderen: prullenbak. */
export function IconTrash({ size = 18, style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" style={svgBase(style)}>
      <path d="M4.5 6.5h15" />
      <path d="M9 6.5V5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5v1.5" />
      <path d="M6.5 6.5l.9 12A1.5 1.5 0 0 0 8.9 20h6.2a1.5 1.5 0 0 0 1.5-1.4l.9-12" />
      <path d="M10 10.5v5.5M14 10.5v5.5" />
    </svg>
  )
}
