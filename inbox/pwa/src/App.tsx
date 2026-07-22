import { useEffect, useState } from 'react'
import { getPairing, type Pairing } from './store/db'
import { parsePairFromLocation, type PairLink } from './pair'
import { PairScreen } from './screens/Pair'
import { NewMemoryScreen } from './screens/NewMemory'
import { DashboardScreen } from './screens/Dashboard'
import { SettingsScreen } from './screens/Settings'
import { IconGear, IconPlus, IconRefresh } from './icons'
import { applyUpdate, onNeedRefresh } from './pwa'

type View = 'loading' | 'pair' | 'new' | 'dashboard' | 'settings'

export function App() {
  const [pairing, setPairing] = useState<Pairing | null>(null)
  const [view, setView] = useState<View>('loading')
  const [pairLink, setPairLink] = useState<PairLink | null>(null)
  const [expired, setExpired] = useState(false)
  const [updateReady, setUpdateReady] = useState(false)

  // "Nieuwe versie beschikbaar" — de service-worker heeft nieuwe app-bestanden
  // klaarstaan; een tik op de balk past ze toe en herlaadt.
  useEffect(() => onNeedRefresh(() => setUpdateReady(true)), [])

  useEffect(() => {
    const link = parsePairFromLocation()
    void (async () => {
      const existing = await getPairing()
      setPairing(existing)
      if (link) {
        setPairLink(link)
        setView('pair')
      } else {
        setView(existing ? 'dashboard' : 'pair')
      }
    })()
  }, [])

  const onExpired = (): void => setExpired(true)

  if (view === 'loading') return <div style={{ padding: 24 }} />

  if (view === 'pair' || (!pairing && !expired)) {
    return (
      <PairScreen
        link={pairLink}
        existing={pairing}
        onPaired={(p) => {
          setPairing(p)
          setPairLink(null)
          setExpired(false)
          history.replaceState(null, '', location.pathname) // fragment uit de adresbalk
          setView('dashboard')
        }}
        onCancel={() => setView(pairing ? 'dashboard' : 'pair')}
      />
    )
  }

  if (expired && pairing) {
    return (
      <PairScreen
        link={pairLink}
        existing={pairing}
        expiredNotice
        onPaired={(p) => {
          setPairing(p)
          setExpired(false)
          history.replaceState(null, '', location.pathname)
          setView('dashboard')
        }}
        onCancel={() => setExpired(false)}
      />
    )
  }

  const p = pairing!
  const updateToast = updateReady ? (
    <button className="update-toast" onClick={applyUpdate}>
      <IconRefresh size={18} />
      <span>Nieuwe versie beschikbaar</span>
      <span className="update-toast-cta">Vernieuwen</span>
    </button>
  ) : null
  // Header: instellingen LINKS (zelden nodig), merk in het MIDDEN (→ overzicht),
  // en de meest gebruikte actie — nieuwe memory — RECHTSBOVEN (best bereikbaar).
  const nav = (
    <>
      {updateToast}
      <header className="topbar">
      <button className="link" onClick={() => setView('settings')} aria-label="Instellingen">
        <IconGear />
      </button>
      <div
        className="serif brand"
        role="button"
        tabIndex={0}
        onClick={() => setView('dashboard')}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setView('dashboard')
          }
        }}
      >
        MemoryLane
      </div>
      <button className="link accent" onClick={() => setView('new')} aria-label="Nieuwe memory">
        <IconPlus />
      </button>
      </header>
    </>
  )

  if (view === 'settings')
    return (
      <SettingsScreen
        pairing={p}
        onBack={() => setView('dashboard')}
        onRepair={() => setView('pair')}
        onUnpaired={() => {
          setPairing(null)
          setView('pair')
        }}
        nav={nav}
      />
    )
  if (view === 'new')
    return (
      <NewMemoryScreen
        pairing={p}
        onExpired={onExpired}
        onFinished={() => setView('dashboard')}
        nav={nav}
      />
    )
  return <DashboardScreen pairing={p} onNew={() => setView('new')} onExpired={onExpired} nav={nav} />
}
