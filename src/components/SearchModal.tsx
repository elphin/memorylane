import { useState, useEffect, useCallback, useRef } from 'react'
import { Search, X, Calendar, Image, FileText, Link2, MapPin, Users, Video } from 'lucide-react'
import { searchMemories, SearchResult } from '../db/database'

interface SearchModalProps {
  isOpen: boolean
  onClose: () => void
  onSelectResult: (result: SearchResult) => void
}

export function SearchModal({ isOpen, onClose, onSelectResult }: SearchModalProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [isSearching, setIsSearching] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const resultsRef = useRef<HTMLDivElement>(null)

  // Debounced search
  useEffect(() => {
    if (!query.trim()) {
      setResults([])
      setSelectedIndex(0)
      return
    }

    setIsSearching(true)
    const timer = setTimeout(() => {
      const searchResults = searchMemories(query)
      setResults(searchResults)
      setSelectedIndex(0)
      setIsSearching(false)
    }, 200)

    return () => clearTimeout(timer)
  }, [query])

  // Focus input when modal opens
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 50)
    } else {
      setQuery('')
      setResults([])
      setSelectedIndex(0)
    }
  }, [isOpen])

  // Keyboard navigation
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose()
      return
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex(prev => Math.min(prev + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex(prev => Math.max(prev - 1, 0))
    } else if (e.key === 'Enter' && results.length > 0) {
      e.preventDefault()
      onSelectResult(results[selectedIndex])
    }
  }, [results, selectedIndex, onClose, onSelectResult])

  useEffect(() => {
    if (isOpen) {
      window.addEventListener('keydown', handleKeyDown)
      return () => window.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen, handleKeyDown])

  // Scroll selected item into view
  useEffect(() => {
    if (resultsRef.current && results.length > 0) {
      const selectedEl = resultsRef.current.children[selectedIndex] as HTMLElement
      if (selectedEl) {
        selectedEl.scrollIntoView({ block: 'nearest' })
      }
    }
  }, [selectedIndex, results.length])

  // Get icon for item type
  const getItemIcon = (result: SearchResult) => {
    if (result.type === 'event') {
      return <Calendar size={16} style={{ color: '#5d7aa0' }} />
    }
    switch (result.itemType) {
      case 'photo':
        return <Image size={16} style={{ color: '#7aa05d' }} />
      case 'video':
        return <Video size={16} style={{ color: '#a07a5d' }} />
      case 'text':
        return <FileText size={16} style={{ color: '#a05d7a' }} />
      case 'link':
        return <Link2 size={16} style={{ color: '#5da0a0' }} />
      default:
        return <FileText size={16} style={{ color: '#888' }} />
    }
  }

  // Get matched field indicator
  const getMatchIndicator = (result: SearchResult) => {
    switch (result.matchedField) {
      case 'location':
        return <MapPin size={12} style={{ color: '#666' }} />
      case 'people':
        return <Users size={12} style={{ color: '#666' }} />
      default:
        return null
    }
  }

  // Group results by type
  const eventResults = results.filter(r => r.type === 'event')
  const itemResults = results.filter(r => r.type === 'item')

  if (!isOpen) return null

  return (
    <>
      {/* Backdrop */}
      <div style={styles.backdrop} onClick={onClose} />

      {/* Modal */}
      <div style={styles.modal}>
        {/* Search Input */}
        <div style={styles.searchHeader}>
          <Search size={20} style={{ color: '#666', flexShrink: 0 }} />
          <input
            ref={inputRef}
            type="text"
            style={styles.searchInput}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Zoek in herinneringen..."
          />
          {query && (
            <button
              style={styles.clearButton}
              onClick={() => setQuery('')}
              title="Wissen"
            >
              <X size={16} />
            </button>
          )}
          <button style={styles.closeButton} onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        {/* Results */}
        <div style={styles.resultsContainer} ref={resultsRef}>
          {isSearching && (
            <div style={styles.loading}>Zoeken...</div>
          )}

          {!isSearching && query && results.length === 0 && (
            <div style={styles.noResults}>
              <Search size={32} style={{ color: '#444', marginBottom: 8 }} />
              <div>Geen resultaten voor "{query}"</div>
              <div style={styles.noResultsHint}>
                Zoek op titel, beschrijving, locatie of personen
              </div>
            </div>
          )}

          {!query && (
            <div style={styles.placeholder}>
              <Search size={32} style={{ color: '#444', marginBottom: 8 }} />
              <div>Begin met typen om te zoeken</div>
              <div style={styles.shortcut}>
                Druk <kbd style={styles.kbd}>Esc</kbd> om te sluiten
              </div>
            </div>
          )}

          {/* Event Results */}
          {eventResults.length > 0 && (
            <div style={styles.resultSection}>
              <div style={styles.sectionHeader}>
                <Calendar size={14} />
                Events ({eventResults.length})
              </div>
              {eventResults.map((result, index) => {
                const globalIndex = index
                return (
                  <div
                    key={result.id}
                    style={{
                      ...styles.resultItem,
                      backgroundColor: selectedIndex === globalIndex ? '#2a2a4a' : 'transparent',
                    }}
                    onClick={() => onSelectResult(result)}
                    onMouseEnter={() => setSelectedIndex(globalIndex)}
                  >
                    <div style={styles.resultIcon}>
                      {getItemIcon(result)}
                    </div>
                    <div style={styles.resultContent}>
                      <div style={styles.resultTitle}>{result.title}</div>
                      <div style={styles.resultMeta}>
                        {result.date && <span>{result.date}</span>}
                        {result.preview && (
                          <>
                            {result.date && <span style={styles.metaSeparator}>•</span>}
                            <span style={styles.preview}>{result.preview}</span>
                          </>
                        )}
                      </div>
                    </div>
                    {getMatchIndicator(result)}
                  </div>
                )
              })}
            </div>
          )}

          {/* Item Results */}
          {itemResults.length > 0 && (
            <div style={styles.resultSection}>
              <div style={styles.sectionHeader}>
                <Image size={14} />
                Herinneringen ({itemResults.length})
              </div>
              {itemResults.map((result, index) => {
                const globalIndex = eventResults.length + index
                return (
                  <div
                    key={result.id}
                    style={{
                      ...styles.resultItem,
                      backgroundColor: selectedIndex === globalIndex ? '#2a2a4a' : 'transparent',
                    }}
                    onClick={() => onSelectResult(result)}
                    onMouseEnter={() => setSelectedIndex(globalIndex)}
                  >
                    <div style={styles.resultIcon}>
                      {result.thumbnailContent && result.thumbnailContent.startsWith('data:') ? (
                        <img
                          src={result.thumbnailContent}
                          alt=""
                          style={styles.thumbnail}
                        />
                      ) : (
                        getItemIcon(result)
                      )}
                    </div>
                    <div style={styles.resultContent}>
                      <div style={styles.resultTitle}>{result.title}</div>
                      <div style={styles.resultMeta}>
                        {result.eventTitle && (
                          <span style={styles.eventTag}>{result.eventTitle}</span>
                        )}
                        {result.date && (
                          <>
                            {result.eventTitle && <span style={styles.metaSeparator}>•</span>}
                            <span>{result.date}</span>
                          </>
                        )}
                        {result.preview && (
                          <>
                            <span style={styles.metaSeparator}>•</span>
                            <span style={styles.preview}>{result.preview}</span>
                          </>
                        )}
                      </div>
                    </div>
                    {getMatchIndicator(result)}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        {results.length > 0 && (
          <div style={styles.footer}>
            <span>
              <kbd style={styles.kbd}>↑</kbd> <kbd style={styles.kbd}>↓</kbd> navigeren
            </span>
            <span>
              <kbd style={styles.kbd}>Enter</kbd> openen
            </span>
            <span>
              <kbd style={styles.kbd}>Esc</kbd> sluiten
            </span>
          </div>
        )}
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
    zIndex: 2000,
  },
  modal: {
    position: 'fixed',
    top: '15%',
    left: '50%',
    transform: 'translateX(-50%)',
    backgroundColor: '#1a1a2e',
    borderRadius: 16,
    width: '90%',
    maxWidth: 560,
    maxHeight: '70vh',
    display: 'flex',
    flexDirection: 'column',
    zIndex: 2001,
    boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5)',
    overflow: 'hidden',
  },
  searchHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '16px 20px',
    borderBottom: '1px solid #333',
  },
  searchInput: {
    flex: 1,
    backgroundColor: 'transparent',
    border: 'none',
    color: '#fff',
    fontSize: 16,
    outline: 'none',
    fontFamily: 'inherit',
  },
  clearButton: {
    background: 'none',
    border: 'none',
    color: '#666',
    cursor: 'pointer',
    padding: 4,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeButton: {
    background: 'none',
    border: 'none',
    color: '#666',
    cursor: 'pointer',
    padding: 4,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 8,
  },
  resultsContainer: {
    flex: 1,
    overflowY: 'auto',
    padding: '8px 0',
  },
  loading: {
    padding: 24,
    textAlign: 'center',
    color: '#666',
  },
  noResults: {
    padding: 40,
    textAlign: 'center',
    color: '#888',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
  },
  noResultsHint: {
    fontSize: 13,
    color: '#666',
    marginTop: 8,
  },
  placeholder: {
    padding: 40,
    textAlign: 'center',
    color: '#666',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
  },
  shortcut: {
    fontSize: 13,
    color: '#555',
    marginTop: 12,
  },
  resultSection: {
    marginBottom: 8,
  },
  sectionHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '8px 20px',
    fontSize: 12,
    fontWeight: 500,
    color: '#888',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
  },
  resultItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '10px 20px',
    cursor: 'pointer',
    transition: 'background-color 0.1s',
  },
  resultIcon: {
    width: 32,
    height: 32,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#252545',
    borderRadius: 6,
    flexShrink: 0,
  },
  thumbnail: {
    width: 32,
    height: 32,
    objectFit: 'cover',
    borderRadius: 6,
  },
  resultContent: {
    flex: 1,
    minWidth: 0,
  },
  resultTitle: {
    fontSize: 14,
    fontWeight: 500,
    color: '#fff',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  resultMeta: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 12,
    color: '#888',
    marginTop: 2,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
  },
  metaSeparator: {
    color: '#555',
  },
  preview: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  eventTag: {
    backgroundColor: '#252545',
    padding: '2px 6px',
    borderRadius: 4,
    fontSize: 11,
  },
  footer: {
    display: 'flex',
    gap: 20,
    padding: '12px 20px',
    borderTop: '1px solid #333',
    fontSize: 12,
    color: '#666',
  },
  kbd: {
    backgroundColor: '#252545',
    padding: '2px 6px',
    borderRadius: 4,
    fontSize: 11,
    fontFamily: 'inherit',
    border: '1px solid #333',
  },
}
