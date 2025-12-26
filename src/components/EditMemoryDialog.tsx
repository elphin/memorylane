import { useState, useEffect, useCallback } from 'react'
import { Clock } from 'lucide-react'
import { Item, Event } from '../models/types'
import { TagInput } from './TagInput'
import { CategorySelect } from './CategorySelect'

interface EditMemoryDialogProps {
  item: Item | null
  parentEvent: Event | null
  isOpen: boolean
  onSave: (itemId: string, eventId: string, updates: {
    caption?: string
    happenedAt?: string
    content?: string
    eventStartAt?: string
    tags?: string[]
    category?: string
  }) => void
  onCancel: () => void
}

export function EditMemoryDialog({ item, parentEvent, isOpen, onSave, onCancel }: EditMemoryDialogProps) {
  const [caption, setCaption] = useState('')
  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [showTime, setShowTime] = useState(false)
  const [content, setContent] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [category, setCategory] = useState<string | undefined>(undefined)

  // Reset form when item changes
  useEffect(() => {
    if (item && parentEvent) {
      setCaption(item.caption || '')
      // For text items, content is in bodyText (file-based) or content (legacy)
      setContent(item.itemType === 'text' ? (item.bodyText || item.content || '') : '')
      setTags(item.tags || [])
      setCategory(item.category)

      // Use item's happenedAt first, then fallback to event's startAt
      const dateSource = item.happenedAt || parentEvent.startAt
      if (dateSource) {
        if (dateSource.includes('T')) {
          const dateObj = new Date(dateSource)
          setDate(dateSource.split('T')[0])
          const hours = dateObj.getUTCHours()
          const minutes = dateObj.getUTCMinutes()
          if (hours !== 0 || minutes !== 0) {
            setShowTime(true)
            setTime(`${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`)
          } else {
            setShowTime(false)
            setTime('')
          }
        } else {
          setDate(dateSource)
          setShowTime(false)
          setTime('')
        }
      }
    }
  }, [item, parentEvent])

  // Handle escape key
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      onCancel()
    }
  }, [onCancel])

  useEffect(() => {
    if (isOpen) {
      window.addEventListener('keydown', handleKeyDown)
      return () => window.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen, handleKeyDown])

  const handleSave = () => {
    if (!item || !parentEvent) return

    const updates: {
      caption?: string
      happenedAt?: string
      content?: string
      eventStartAt?: string
      tags?: string[]
      category?: string
    } = {}

    // Caption
    if (caption !== (item.caption || '')) {
      updates.caption = caption
    }

    // Build happenedAt from date/time
    if (date) {
      const happenedAt = showTime && time
        ? `${date}T${time}:00.000Z`
        : `${date}T12:00:00.000Z`

      // Compare with original
      const originalHappenedAt = item.happenedAt || parentEvent.startAt
      if (happenedAt !== originalHappenedAt) {
        updates.happenedAt = happenedAt
      }
    }

    // Content (only for text items)
    // Compare with bodyText (file-based) or content (legacy)
    const originalContent = item.bodyText || item.content || ''
    if (item.itemType === 'text' && content !== originalContent) {
      updates.content = content
    }

    // Tags
    const originalTags = item.tags || []
    if (JSON.stringify(tags) !== JSON.stringify(originalTags)) {
      updates.tags = tags
    }

    // Category
    if (category !== item.category) {
      updates.category = category
    }

    onSave(item.id, parentEvent.id, updates)
  }

  if (!isOpen || !item || !parentEvent) return null

  return (
    <>
      {/* Backdrop */}
      <div style={styles.backdrop} onClick={onCancel} />

      {/* Dialog */}
      <div style={styles.dialog}>
        <h3 style={styles.title}>Herinnering bewerken</h3>

        {/* Content (only editable for text items) */}
        {item.itemType === 'text' && (
          <div style={styles.field}>
            <label style={styles.label}>Tekst</label>
            <textarea
              style={styles.textarea}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={4}
            />
          </div>
        )}

        {/* Caption - hide for text items (text content IS the description) */}
        {item.itemType !== 'text' && (
          <div style={styles.field}>
            <label style={styles.label}>Beschrijving</label>
            <input
              type="text"
              style={styles.input}
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              placeholder="Voeg een beschrijving toe..."
            />
          </div>
        )}

        {/* Tags */}
        <div style={styles.field}>
          <TagInput tags={tags} onChange={setTags} />
        </div>

        {/* Category */}
        <div style={styles.field}>
          <CategorySelect value={category} onChange={setCategory} />
        </div>

        {/* Start Date */}
        <div style={styles.field}>
          <label style={styles.label}>Startdatum</label>
          <div style={styles.dateRow}>
            <input
              type="date"
              style={styles.dateInput}
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
            <button
              type="button"
              style={{
                ...styles.timeToggle,
                color: showTime ? '#5d7aa0' : '#666'
              }}
              onClick={() => {
                setShowTime(!showTime)
                if (!showTime) setTime('12:00')
              }}
              title={showTime ? 'Tijd verbergen' : 'Tijd toevoegen'}
            >
              <Clock size={18} />
            </button>
          </div>
          {showTime && (
            <input
              type="time"
              style={{ ...styles.input, marginTop: 8 }}
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
          )}
        </div>

        {/* Preview for media */}
        {(item.itemType === 'photo' || item.itemType === 'video') && item.content.startsWith('data:') && (
          <div style={styles.mediaPreview}>
            <img
              src={item.content}
              alt="Preview"
              style={styles.mediaImage}
            />
          </div>
        )}

        {/* Actions */}
        <div style={styles.actions}>
          <button style={styles.cancelButton} onClick={onCancel}>
            Annuleren
          </button>
          <button style={styles.saveButton} onClick={handleSave}>
            Opslaan
          </button>
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
    zIndex: 2000,
  },
  dialog: {
    position: 'fixed',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    backgroundColor: '#1a1a2e',
    borderRadius: 16,
    padding: 24,
    minWidth: 360,
    maxWidth: 480,
    maxHeight: '80vh',
    overflowY: 'auto',
    zIndex: 2001,
    boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5)',
  },
  title: {
    margin: 0,
    marginBottom: 20,
    fontSize: 18,
    fontWeight: 600,
    color: '#fff',
  },
  field: {
    marginBottom: 16,
  },
  label: {
    display: 'block',
    fontSize: 12,
    fontWeight: 500,
    color: '#888',
    marginBottom: 6,
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
  },
  input: {
    width: '100%',
    backgroundColor: '#252545',
    border: '1px solid #333',
    borderRadius: 8,
    color: '#fff',
    fontSize: 14,
    padding: '10px 12px',
    outline: 'none',
    fontFamily: 'inherit',
    boxSizing: 'border-box',
  },
  textarea: {
    width: '100%',
    backgroundColor: '#252545',
    border: '1px solid #333',
    borderRadius: 8,
    color: '#fff',
    fontSize: 14,
    padding: '10px 12px',
    outline: 'none',
    fontFamily: 'inherit',
    resize: 'vertical',
    minHeight: 80,
    boxSizing: 'border-box',
  },
  dateRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  dateInput: {
    flex: 1,
    backgroundColor: '#252545',
    border: '1px solid #333',
    borderRadius: 8,
    color: '#fff',
    fontSize: 14,
    padding: '10px 12px',
    outline: 'none',
    fontFamily: 'inherit',
    colorScheme: 'dark',
  } as React.CSSProperties,
  timeToggle: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    padding: 8,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 4,
  },
  endDateToggle: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 500,
    padding: '4px 0',
  },
  mediaPreview: {
    marginBottom: 16,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#111',
    display: 'flex',
    justifyContent: 'center',
  },
  mediaImage: {
    maxWidth: '100%',
    maxHeight: 150,
    objectFit: 'contain',
  },
  actions: {
    display: 'flex',
    gap: 12,
    justifyContent: 'flex-end',
    marginTop: 20,
  },
  cancelButton: {
    padding: '10px 20px',
    backgroundColor: '#252545',
    border: 'none',
    borderRadius: 8,
    color: '#aaa',
    fontSize: 14,
    fontWeight: 500,
    cursor: 'pointer',
  },
  saveButton: {
    padding: '10px 24px',
    backgroundColor: '#5d7aa0',
    border: 'none',
    borderRadius: 8,
    color: '#fff',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
  },
}
