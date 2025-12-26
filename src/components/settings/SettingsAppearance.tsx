import { Moon, Sun } from 'lucide-react'

interface SettingsAppearanceProps {
  darkMode: boolean
  onToggleDarkMode: () => void
}

export function SettingsAppearance({ darkMode, onToggleDarkMode }: SettingsAppearanceProps) {
  return (
    <div style={styles.container}>
      <div style={styles.section}>
        <h3 style={styles.sectionTitle}>Thema</h3>
        <div style={styles.themeOptions}>
          <button
            style={{
              ...styles.themeOption,
              ...(darkMode ? styles.themeOptionActive : {}),
            }}
            onClick={() => !darkMode && onToggleDarkMode()}
          >
            <Moon size={20} />
            <span>Donker</span>
          </button>
          <button
            style={{
              ...styles.themeOption,
              ...(!darkMode ? styles.themeOptionActive : {}),
            }}
            onClick={() => darkMode && onToggleDarkMode()}
          >
            <Sun size={20} />
            <span>Licht</span>
          </button>
        </div>
      </div>

      <div style={styles.section}>
        <h3 style={styles.sectionTitle}>Taal</h3>
        <div style={styles.languageInfo}>
          <span style={styles.languageLabel}>Nederlands</span>
          <span style={styles.languageHint}>Meer talen komen later</span>
        </div>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: 24,
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  sectionTitle: {
    margin: 0,
    fontSize: 12,
    fontWeight: 600,
    color: '#888',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
  },
  themeOptions: {
    display: 'flex',
    gap: 12,
  },
  themeOption: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 8,
    padding: '16px',
    backgroundColor: '#252545',
    border: '2px solid transparent',
    borderRadius: 12,
    color: '#888',
    fontSize: 14,
    fontWeight: 500,
    cursor: 'pointer',
    transition: 'all 0.2s',
  },
  themeOptionActive: {
    borderColor: '#3d5a80',
    color: '#fff',
  },
  languageInfo: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    padding: 16,
    backgroundColor: '#252545',
    borderRadius: 8,
  },
  languageLabel: {
    fontSize: 14,
    color: '#fff',
    fontWeight: 500,
  },
  languageHint: {
    fontSize: 12,
    color: '#666',
  },
}
