import { useEffect, useState } from 'react'
import { getPairing, type Pairing } from './store/db'
import { parsePairFromLocation, type PairLink } from './pair'
import { PairScreen } from './screens/Pair'
import { NewMemoryScreen } from './screens/NewMemory'
import { OutboxScreen } from './screens/Outbox'
import { SettingsScreen } from './screens/Settings'

type View = 'loading' | 'pair' | 'new' | 'outbox' | 'settings'

export function App() {
  const [pairing, setPairing] = useState<Pairing | null>(null)
  const [view, setView] = useState<View>('loading')
  const [pairLink, setPairLink] = useState<PairLink | null>(null)
  const [expired, setExpired] = useState(false)

  useEffect(() => {
    const link = parsePairFromLocation()
    void (async () => {
      const existing = await getPairing()
      setPairing(existing)
      if (link) {
        setPairLink(link)
        setView('pair')
      } else {
        setView(existing ? 'new' : 'pair')
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
          setView('new')
        }}
        onCancel={() => setView(pairing ? 'new' : 'pair')}
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
          setView('new')
        }}
        onCancel={() => setExpired(false)}
      />
    )
  }

  const p = pairing!
  const nav = (
    <header className="topbar">
      <button className="link" onClick={() => setView('settings')} aria-label="Instellingen">
        ⚙
      </button>
      <div className="serif brand" onClick={() => setView('new')}>
        MemoryLane
      </div>
      <button className="link" onClick={() => setView('outbox')} aria-label="Onderweg">
        📤
      </button>
    </header>
  )

  if (view === 'outbox') return <OutboxScreen pairing={p} onBack={() => setView('new')} onExpired={onExpired} nav={nav} />
  if (view === 'settings')
    return (
      <SettingsScreen
        pairing={p}
        onBack={() => setView('new')}
        onRepair={() => setView('pair')}
        onUnpaired={() => {
          setPairing(null)
          setView('pair')
        }}
        nav={nav}
      />
    )
  return <NewMemoryScreen pairing={p} onExpired={onExpired} nav={nav} />
}
