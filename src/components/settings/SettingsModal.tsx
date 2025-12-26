import { useState, useEffect, useCallback } from 'react'
import { X, HardDrive, Folder, Palette, Info } from 'lucide-react'
import { SettingsStorage } from './SettingsStorage'
import { SettingsCategories } from './SettingsCategories'
import { SettingsAppearance } from './SettingsAppearance'
import { SettingsAbout } from './SettingsAbout'

type SettingsTab = 'storage' | 'categories' | 'appearance' | 'about'

interface SettingsModalProps {
  isOpen: boolean
  onClose: () => void
  storageConfigured: boolean
  darkMode: boolean
  onToggleDarkMode: () => void
  onSelectStorageFolder: () => Promise<void>
  onMigratePhotos: () => void
  onExportDatabase: () => void
  onRebuildIndex: () => void
  onRecoverFromPhotos: () => void
}

const TABS: { id: SettingsTab; label: string; icon: typeof HardDrive }[] = [
  { id: 'storage', label: 'Opslag', icon: HardDrive },
  { id: 'categories', label: 'Categorieën', icon: Folder },
  { id: 'appearance', label: 'Weergave', icon: Palette },
  { id: 'about', label: 'Over', icon: Info },
]

export function SettingsModal({
  isOpen,
  onClose,
  storageConfigured,
  darkMode,
  onToggleDarkMode,
  onSelectStorageFolder,
  onMigratePhotos,
  onExportDatabase,
  onRebuildIndex,
  onRecoverFromPhotos,
}: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('storage')

  // Handle escape key
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose()
    }
  }, [onClose])

  useEffect(() => {
    if (isOpen) {
      window.addEventListener('keydown', handleKeyDown)
      return () => window.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen, handleKeyDown])

  if (!isOpen) return null

  return (
    <>
      {/* Backdrop */}
      <div style={styles.backdrop} onClick={onClose} />

      {/* Modal */}
      <div style={styles.modal}>
        {/* Header */}
        <div style={styles.header}>
          <h2 style={styles.title}>Instellingen</h2>
          <button style={styles.closeButton} onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        {/* Tabs */}
        <div style={styles.tabs}>
          {TABS.map((tab) => {
            const Icon = tab.icon
            return (
              <button
                key={tab.id}
                style={{
                  ...styles.tab,
                  ...(activeTab === tab.id ? styles.tabActive : {}),
                }}
                onClick={() => setActiveTab(tab.id)}
              >
                <Icon size={16} />
                {tab.label}
              </button>
            )
          })}
        </div>

        {/* Content */}
        <div style={styles.content}>
          {activeTab === 'storage' && (
            <SettingsStorage
              storageConfigured={storageConfigured}
              onSelectStorageFolder={onSelectStorageFolder}
              onMigratePhotos={onMigratePhotos}
              onExportDatabase={onExportDatabase}
              onRebuildIndex={onRebuildIndex}
              onRecoverFromPhotos={onRecoverFromPhotos}
            />
          )}
          {activeTab === 'categories' && <SettingsCategories />}
          {activeTab === 'appearance' && (
            <SettingsAppearance
              darkMode={darkMode}
              onToggleDarkMode={onToggleDarkMode}
            />
          )}
          {activeTab === 'about' && <SettingsAbout />}
        </div>
      </div>
    </>
  )
}

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    zIndex: 9998,
  },
  modal: {
    position: 'fixed',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    width: '90%',
    maxWidth: 600,
    maxHeight: '80vh',
    backgroundColor: '#1a1a2e',
    borderRadius: 12,
    boxShadow: '0 20px 60px rgba(0, 0, 0, 0.5)',
    zIndex: 9999,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '16px 20px',
    borderBottom: '1px solid #333',
  },
  title: {
    margin: 0,
    fontSize: 18,
    fontWeight: 600,
    color: '#fff',
  },
  closeButton: {
    background: 'none',
    border: 'none',
    color: '#888',
    cursor: 'pointer',
    padding: 4,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 4,
    transition: 'color 0.2s',
  },
  tabs: {
    display: 'flex',
    gap: 4,
    padding: '12px 20px',
    borderBottom: '1px solid #333',
    backgroundColor: '#161625',
  },
  tab: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '8px 14px',
    backgroundColor: 'transparent',
    border: 'none',
    borderRadius: 6,
    color: '#888',
    fontSize: 13,
    fontWeight: 500,
    cursor: 'pointer',
    transition: 'all 0.2s',
  },
  tabActive: {
    backgroundColor: '#252545',
    color: '#fff',
  },
  content: {
    flex: 1,
    padding: 20,
    overflowY: 'auto',
  },
}
