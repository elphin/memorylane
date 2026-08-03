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

/** Foto's toevoegen: een foto met een pijl omhoog erboven — het universele
 * upload-gebaar, zodat de knop niet leest als "foto's bekijken". */
export function IconImage({ size = 20, style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" style={svgBase(style)}>
      {/* Upload-pijl */}
      <path d="M12 7.2V2M9.2 4.6L12 1.8l2.8 2.8" />
      {/* Foto */}
      <rect x="3" y="8.5" width="18" height="13" rx="2.4" />
      <circle cx="8" cy="13" r="1.6" />
      <path d="M4 19l3.8-3.6 2.5 2.4 3.2-3.1L20 18.6" />
    </svg>
  )
}

/** Notitie toevoegen: een blad met geschreven regels (de laatste als krabbel) en
 * een plus-badge — "hier schrijf je iets nieuws", niet "hier staat een document". */
export function IconNote({ size = 20, style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" style={svgBase(style)}>
      {/* Blad met omgevouwen hoek; rechtsonder open voor de badge */}
      <path d="M4.6 5.6A1.6 1.6 0 0 1 6.2 4h7.2l4.4 4.4v3.4" />
      <path d="M4.6 5.6v13A1.6 1.6 0 0 0 6.2 20.2h6.4" />
      <path d="M13.2 4v4.6h4.6" />
      {/* Regels: twee recht, de derde met een handschrift-krul */}
      <path d="M7.8 11.2h6.2M7.8 14h4.2" />
      <path d="M7.8 16.8c.8-.9 1.4.9 2.2 0" />
      {/* Toevoegen */}
      <circle cx="18.2" cy="17.8" r="3.9" />
      <path d="M18.2 16v3.6M16.4 17.8h3.6" />
    </svg>
  )
}

/** Weergave aanpassen: de indeling van een canvas (één grote + twee kleine kaarten)
 * met een herschik-pijl eronder. Bewust géén schuifjes: die lezen als "algemene
 * instellingen", terwijl deze knop de indeling van dít canvas bijstelt. */
export function IconSliders({ size = 20, style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" style={svgBase(style)}>
      <rect x="2.6" y="3.4" width="8.6" height="11" rx="1.6" />
      <rect x="13.4" y="3.4" width="8" height="5" rx="1.5" />
      <rect x="13.4" y="10" width="8" height="4.4" rx="1.5" />
      {/* Herschikken */}
      <path d="M4.4 18.8h15.2M6.8 16.4l-2.4 2.4 2.4 2.4M17.2 16.4l2.4 2.4-2.4 2.4" />
    </svg>
  )
}

/** Thumbnail selecteren: een stapeltje foto's waarvan de voorste is aangevinkt —
 * "welke van deze foto's is de omslag?". */
export function IconCover({ size = 20, style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" style={svgBase(style)}>
      {/* Achterste foto's van het stapeltje */}
      <path d="M8 3.4h11a1.8 1.8 0 0 1 1.8 1.8v9.4" />
      <path d="M5.4 6.4h11a1.8 1.8 0 0 1 1.8 1.8v9.4" />
      {/* Voorste foto */}
      <rect x="2.6" y="9.4" width="13" height="11.2" rx="1.8" />
      {/* Vinkje = deze is gekozen */}
      <path d="M5.6 15.2l2.6 2.6 4.6-5" />
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

/** Vierkant bijsnijden: crop-hoeken. */
export function IconCrop({ size = 18, style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" style={svgBase(style)}>
      <path d="M6 2v14a2 2 0 0 0 2 2h14" />
      <path d="M2 6h14a2 2 0 0 1 2 2v14" />
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
