import { useEffect, useState } from 'react'
import { getPairing, type Pairing } from './store/db'
import { b64urlToBytes, bytesToHex } from './util'
import { PairScreen } from './screens/Pair'
import { NewMemoryScreen } from './screens/NewMemory'
import { OutboxScreen } from './screens/Outbox'
import { SettingsScreen } from './screens/Settings'

export interface PairLink {
  mailboxId: string
  token: string
  masterKeyHex: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function parsePairLink(): PairLink | null {
  const h = location.hash.startsWith('#') ? location.hash.slice(1) : ''
  if (!h) return null
  const p = new URLSearchParams(h)
  if (p.get('v') !== '1') return null
  const mb = p.get('mb')
  const t = p.get('t')
  const k = p.get('k')
  if (!mb || !t || !k) return null
  if (!UUID_RE.test(mb) || t.length < 8) return null
  try {
    const key = b64urlToBytes(k)
    // De masterKey MOET 32 bytes zijn (§7.2). Een verminkt/afgekapt QR-fragment zou
    // anders stil een niet-te-ontsleutelen upload opleveren — pas thuis bij import
    // merkbaar. Liever hier al weigeren.
    if (key.length !== 32) return null
    return { mailboxId: mb, token: t, masterKeyHex: bytesToHex(key) }
  } catch {
    return null
  }
}

type View = 'loading' | 'pair' | 'new' | 'outbox' | 'settings'

export function App() {
  const [pairing, setPairing] = useState<Pairing | null>(null)
  const [view, setView] = useState<View>('loading')
  const [pairLink, setPairLink] = useState<PairLink | null>(null)
  const [expired, setExpired] = useState(false)

  useEffect(() => {
    const link = parsePairLink()
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
        onUnpaired={() => {
          setPairing(null)
          setView('pair')
        }}
        nav={nav}
      />
    )
  return <NewMemoryScreen pairing={p} onExpired={onExpired} nav={nav} />
}
