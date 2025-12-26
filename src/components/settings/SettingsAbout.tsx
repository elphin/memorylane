import { Heart, Github, MessageCircle } from 'lucide-react'

export function SettingsAbout() {
  return (
    <div style={styles.container}>
      <div style={styles.logoSection}>
        <div style={styles.logo}>ML</div>
        <div style={styles.appInfo}>
          <h2 style={styles.appName}>MemoryLane</h2>
          <span style={styles.version}>Versie 0.1.0</span>
        </div>
      </div>

      <p style={styles.description}>
        Een lokale app voor het navigeren door persoonlijke herinneringen via een
        zoombare tijdlijn. Jouw foto's en data blijven altijd op jouw apparaat.
      </p>

      <div style={styles.linksSection}>
        <a
          href="https://github.com/anthropics/memorylane"
          target="_blank"
          rel="noopener noreferrer"
          style={styles.link}
        >
          <Github size={16} />
          Bekijk op GitHub
        </a>
        <a
          href="https://github.com/anthropics/memorylane/issues"
          target="_blank"
          rel="noopener noreferrer"
          style={styles.link}
        >
          <MessageCircle size={16} />
          Feedback geven
        </a>
      </div>

      <div style={styles.footer}>
        <span style={styles.madeWith}>
          Gemaakt met <Heart size={12} color="#e91e63" style={{ margin: '0 4px' }} /> in Nederland
        </span>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: 20,
    textAlign: 'center',
    padding: '20px 0',
  },
  logoSection: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 12,
  },
  logo: {
    width: 64,
    height: 64,
    borderRadius: 16,
    background: 'linear-gradient(135deg, #3d5a80, #5d7aa0)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 24,
    fontWeight: 700,
    color: '#fff',
  },
  appInfo: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  appName: {
    margin: 0,
    fontSize: 20,
    fontWeight: 600,
    color: '#fff',
  },
  version: {
    fontSize: 13,
    color: '#888',
  },
  description: {
    margin: 0,
    fontSize: 14,
    color: '#888',
    lineHeight: 1.6,
    maxWidth: 400,
    marginLeft: 'auto',
    marginRight: 'auto',
  },
  linksSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    alignItems: 'center',
  },
  link: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 16px',
    color: '#5d7aa0',
    fontSize: 13,
    fontWeight: 500,
    textDecoration: 'none',
    borderRadius: 6,
    transition: 'color 0.2s',
  },
  footer: {
    marginTop: 20,
    paddingTop: 20,
    borderTop: '1px solid #333',
  },
  madeWith: {
    display: 'inline-flex',
    alignItems: 'center',
    fontSize: 12,
    color: '#666',
  },
}
