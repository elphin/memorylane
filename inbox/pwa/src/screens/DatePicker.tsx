import { useState } from 'react'
import { daysBetween, formatDateShort } from '../util'

const MONTHS_FULL = [
  'januari', 'februari', 'maart', 'april', 'mei', 'juni',
  'juli', 'augustus', 'september', 'oktober', 'november', 'december',
]
const WD = ['ma', 'di', 'wo', 'do', 'vr', 'za', 'zo']

const iso = (y: number, m: number, d: number): string =>
  `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
const parse = (s: string): [number, number, number] => {
  const [y, m, d] = s.split('-').map(Number)
  return [y, m - 1, d]
}
function addDaysISO(s: string, delta: number): string {
  const [y, m, d] = parse(s)
  const dt = new Date(y, m, d + delta)
  return iso(dt.getFullYear(), dt.getMonth(), dt.getDate())
}
function todayLocalISO(): string {
  const d = new Date()
  return iso(d.getFullYear(), d.getMonth(), d.getDate())
}
// Maandag-index (0=ma) van de 1e van de maand.
const firstWeekday = (y: number, m: number): number => (new Date(y, m, 1).getDay() + 6) % 7
const daysInMonth = (y: number, m: number): number => new Date(y, m + 1, 0).getDate()

/** Bottom-sheet datumkiezer. `mode='start'` kiest de begindatum; `mode='end'`
 * kiest de einddatum (range). */
export function DatePicker({
  mode,
  startAt,
  endAt,
  onChange,
  onClose,
}: {
  mode: 'start' | 'end'
  startAt: string
  endAt?: string
  onChange: (startAt: string, endAt?: string) => void
  onClose: () => void
}) {
  const anchor = mode === 'end' ? (endAt ?? startAt) : startAt
  const [[vy, vm], setView] = useState<[number, number]>(() => {
    const [y, m] = parse(anchor)
    return [y, m]
  })
  const [yearGrid, setYearGrid] = useState(false)

  const pick = (dayISO: string): void => {
    if (mode === 'start') {
      // einddatum meeschuiven als die vóór de nieuwe begindatum valt.
      const end = endAt && endAt < dayISO ? undefined : endAt
      onChange(dayISO, end)
    } else {
      // einddatum: minimaal = begindatum.
      onChange(startAt, dayISO < startAt ? startAt : dayISO)
    }
  }

  const shiftMonth = (delta: number): void => {
    let y = vy
    let m = vm + delta
    if (m < 0) {
      m = 11
      y--
    } else if (m > 11) {
      m = 0
      y++
    }
    setView([y, m])
  }

  const today = todayLocalISO()
  const inRange = (dayISO: string): boolean =>
    !!endAt && dayISO >= startAt && dayISO <= endAt
  const isStart = (dayISO: string): boolean => dayISO === startAt
  const isEnd = (dayISO: string): boolean => !!endAt && dayISO === endAt

  const chips: { label: string; run: () => void }[] = [
    { label: 'Vandaag', run: () => pick(today) },
    { label: 'Gisteren', run: () => pick(addDaysISO(today, -1)) },
    { label: 'Eergisteren', run: () => pick(addDaysISO(today, -2)) },
  ]

  const summary = endAt
    ? `${formatDateShort(startAt)} – ${formatDateShort(endAt)} · ${daysBetween(startAt, endAt) + 1} dagen`
    : formatDateShort(startAt)

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet stack" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <button className="btn btn-ghost" onClick={() => shiftMonth(-1)} aria-label="Vorige maand">
            ‹
          </button>
          <button className="chip serif" onClick={() => setYearGrid((v) => !v)} style={{ fontSize: 18 }}>
            {MONTHS_FULL[vm]} {vy}
          </button>
          <button className="btn btn-ghost" onClick={() => shiftMonth(1)} aria-label="Volgende maand">
            ›
          </button>
        </div>

        {yearGrid ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
            {Array.from({ length: 16 }, (_, i) => vy - 11 + i).map((y) => (
              <button
                key={y}
                className="chip"
                style={{ justifyContent: 'center', background: y === vy ? 'var(--accent-soft)' : undefined }}
                onClick={() => {
                  setView([y, vm])
                  setYearGrid(false)
                }}
              >
                {y}
              </button>
            ))}
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {chips.map((c) => (
                <button key={c.label} className="chip" onClick={c.run}>
                  {c.label}
                </button>
              ))}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4, textAlign: 'center' }}>
              {WD.map((w) => (
                <div key={w} className="muted" style={{ fontSize: 12, padding: '4px 0' }}>
                  {w}
                </div>
              ))}
              {Array.from({ length: firstWeekday(vy, vm) }, (_, i) => (
                <div key={`e${i}`} />
              ))}
              {Array.from({ length: daysInMonth(vy, vm) }, (_, i) => {
                const d = i + 1
                const dayISO = iso(vy, vm, d)
                const sel = isStart(dayISO) || isEnd(dayISO)
                return (
                  <button
                    key={d}
                    aria-label={`${d} ${MONTHS_FULL[vm]} ${vy}`}
                    onClick={() => pick(dayISO)}
                    style={{
                      minHeight: 44,
                      border: 'none',
                      borderRadius: 10,
                      background: sel ? 'var(--accent)' : inRange(dayISO) ? 'var(--accent-soft)' : 'transparent',
                      color: sel ? '#fff' : 'var(--ink)',
                      fontWeight: sel ? 600 : 400,
                      outline: dayISO === today && !sel ? '2px solid var(--accent)' : 'none',
                    }}
                  >
                    {d}
                  </button>
                )
              })}
            </div>
          </>
        )}

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <span className="muted">{summary}</span>
          <div style={{ display: 'flex', gap: 8 }}>
            {mode === 'end' && endAt && (
              <button className="btn btn-ghost" onClick={() => onChange(startAt, undefined)}>
                Geen einddatum
              </button>
            )}
            <button className="btn btn-primary" onClick={onClose}>
              Klaar
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
