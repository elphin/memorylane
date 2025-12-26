import { CheckCircle, AlertCircle, FolderOpen, RefreshCw, Download, Upload, ImageIcon } from 'lucide-react'

interface SettingsStorageProps {
  storageConfigured: boolean
  onSelectStorageFolder: () => Promise<void>
  onMigratePhotos: () => void
  onExportDatabase: () => void
  onRebuildIndex: () => void
  onRecoverFromPhotos: () => void
}

export function SettingsStorage({
  storageConfigured,
  onSelectStorageFolder,
  onMigratePhotos,
  onExportDatabase,
  onRebuildIndex,
  onRecoverFromPhotos,
}: SettingsStorageProps) {
  return (
    <div style={styles.container}>
      {/* Status Section */}
      <div style={styles.section}>
        <h3 style={styles.sectionTitle}>Opslaglocatie</h3>
        <div style={styles.statusCard}>
          {storageConfigured ? (
            <>
              <CheckCircle size={20} color="#4ade80" />
              <div>
                <div style={styles.statusText}>Bestandsopslag actief</div>
                <div style={styles.statusHint}>Foto's en data worden lokaal opgeslagen</div>
              </div>
            </>
          ) : (
            <>
              <AlertCircle size={20} color="#f59e0b" />
              <div>
                <div style={styles.statusText}>Niet geconfigureerd</div>
                <div style={styles.statusHint}>Kies een map om te beginnen</div>
              </div>
            </>
          )}
        </div>
        <button style={styles.primaryButton} onClick={onSelectStorageFolder}>
          <FolderOpen size={16} />
          {storageConfigured ? 'Wijzig opslaglocatie' : 'Kies opslaglocatie'}
        </button>
      </div>

      {/* Tools Section */}
      {storageConfigured && (
        <>
          <div style={styles.section}>
            <h3 style={styles.sectionTitle}>Beheer</h3>
            <div style={styles.buttonGroup}>
              <button style={styles.secondaryButton} onClick={onRebuildIndex}>
                <RefreshCw size={16} />
                Index opnieuw opbouwen
              </button>
              <button style={styles.secondaryButton} onClick={onExportDatabase}>
                <Download size={16} />
                Database exporteren
              </button>
            </div>
          </div>

          <div style={styles.section}>
            <h3 style={styles.sectionTitle}>Migratie</h3>
            <div style={styles.buttonGroup}>
              <button style={styles.secondaryButton} onClick={onMigratePhotos}>
                <Upload size={16} />
                Bestaande foto's migreren
              </button>
              <button style={styles.secondaryButton} onClick={onRecoverFromPhotos}>
                <ImageIcon size={16} />
                Herstel van foto's
              </button>
            </div>
          </div>
        </>
      )}
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
  statusCard: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: 16,
    backgroundColor: '#252545',
    borderRadius: 8,
  },
  statusText: {
    fontSize: 14,
    fontWeight: 500,
    color: '#fff',
  },
  statusHint: {
    fontSize: 12,
    color: '#888',
    marginTop: 2,
  },
  primaryButton: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: '12px 16px',
    backgroundColor: '#3d5a80',
    border: 'none',
    borderRadius: 8,
    color: '#fff',
    fontSize: 14,
    fontWeight: 500,
    cursor: 'pointer',
    transition: 'background-color 0.2s',
  },
  buttonGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  secondaryButton: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '10px 14px',
    backgroundColor: 'transparent',
    border: '1px solid #444',
    borderRadius: 8,
    color: '#ccc',
    fontSize: 13,
    fontWeight: 500,
    cursor: 'pointer',
    transition: 'all 0.2s',
    textAlign: 'left',
  },
}
