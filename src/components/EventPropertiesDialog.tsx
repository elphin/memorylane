import { useState, useEffect, useCallback, useRef } from 'react'
import { Event, Item } from '../models/types'
import heic2any from 'heic2any'
import { MapPin, Clock } from 'lucide-react'
import { readFileAsBlob } from '../db/fileStorage'

// Check if file is HEIC format
function isHeicFile(file: File): boolean {
  const name = file.name.toLowerCase()
  return name.endsWith('.heic') || name.endsWith('.heif') ||
         file.type === 'image/heic' || file.type === 'image/heif'
}

// Convert HEIC to JPEG
async function convertHeicToJpeg(file: File): Promise<Blob> {
  console.log('Converting HEIC to JPEG:', file.name)
  const blob = await heic2any({
    blob: file,
    toType: 'image/jpeg',
    quality: 0.9,
  })
  return Array.isArray(blob) ? blob[0] : blob
}

interface EventPropertiesDialogProps {
  event: Event | null
  photoItems: Item[]  // Photo/video items in this event for dropdown
  isOpen: boolean
  requireEndDate?: boolean  // If true, end date is required (for new events)
  onSave: (eventId: string, updates: {
    title?: string
    description?: string | null
    featuredPhotoId?: string | null
    featuredPhotoData?: string | null
    location?: { lat: number; lng: number; label?: string } | null
    startAt?: string
    endAt?: string | null
  }) => void
  onCancel: () => void
  onDelete?: (eventId: string) => void  // Optional delete handler
}

type FeaturedPhotoSource = 'none' | 'item' | 'custom'

export function EventPropertiesDialog({ event, photoItems, isOpen, requireEndDate, onSave, onCancel, onDelete }: EventPropertiesDialogProps) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [featuredPhotoSource, setFeaturedPhotoSource] = useState<FeaturedPhotoSource>('none')
  const [selectedPhotoItemId, setSelectedPhotoItemId] = useState<string | null>(null)
  const [customPhotoData, setCustomPhotoData] = useState<string | null>(null)
  const [locationLabel, setLocationLabel] = useState('')
  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [showTime, setShowTime] = useState(false)
  const [endDate, setEndDate] = useState('')
  const [endTime, setEndTime] = useState('')
  const [showEndDate, setShowEndDate] = useState(false)
  const [showEndTime, setShowEndTime] = useState(false)
  const [resolvedItemPreview, setResolvedItemPreview] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Reset form when event changes
  useEffect(() => {
    if (event) {
      setTitle(event.title || '')
      setDescription(event.description || '')
      setLocationLabel(event.location?.label || '')

      // Determine featured photo source
      if (event.featuredPhotoData) {
        setFeaturedPhotoSource('custom')
        setCustomPhotoData(event.featuredPhotoData)
        setSelectedPhotoItemId(null)
      } else if (event.featuredPhotoId) {
        setFeaturedPhotoSource('item')
        setSelectedPhotoItemId(event.featuredPhotoId)
        setCustomPhotoData(null)
      } else {
        setFeaturedPhotoSource('none')
        setSelectedPhotoItemId(null)
        setCustomPhotoData(null)
      }

      // Parse start date/time
      if (event.startAt) {
        const startStr = event.startAt
        if (startStr.includes('T')) {
          const dateObj = new Date(startStr)
          setDate(startStr.split('T')[0])
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
          setDate(startStr)
          setShowTime(false)
          setTime('')
        }
      }

      // Parse end date/time
      if (event.endAt) {
        setShowEndDate(true)
        const endStr = event.endAt
        if (endStr.includes('T')) {
          const dateObj = new Date(endStr)
          setEndDate(endStr.split('T')[0])
          const hours = dateObj.getUTCHours()
          const minutes = dateObj.getUTCMinutes()
          if (hours !== 0 || minutes !== 0) {
            setShowEndTime(true)
            setEndTime(`${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`)
          } else {
            setShowEndTime(false)
            setEndTime('')
          }
        } else {
          setEndDate(endStr)
          setShowEndTime(false)
          setEndTime('')
        }
      } else if (requireEndDate) {
        // For new events with requireEndDate, show end date with start date as default
        setShowEndDate(true)
        setEndDate(event.startAt?.split('T')[0] || '')
        setShowEndTime(false)
        setEndTime('')
      } else {
        setShowEndDate(false)
        setEndDate('')
        setShowEndTime(false)
        setEndTime('')
      }
    }
  }, [event, requireEndDate])

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

  // Resolve file reference for selected item preview
  useEffect(() => {
    if (featuredPhotoSource !== 'item' || !selectedPhotoItemId) {
      setResolvedItemPreview(null)
      return
    }

    const item = photoItems.find(i => i.id === selectedPhotoItemId)
    if (!item?.content) {
      setResolvedItemPreview(null)
      return
    }

    // Check if content is a file reference
    if (item.content.startsWith('file:')) {
      // Parse file path: "file:2024/Event/photo.jpg"
      const filePath = item.content.replace('file:', '')
      const parts = filePath.split('/')
      const fileName = parts.pop() || ''
      const dirPath = parts

      // Load the file
      readFileAsBlob(dirPath, fileName).then(blob => {
        if (blob) {
          const url = URL.createObjectURL(blob)
          setResolvedItemPreview(url)
        } else {
          setResolvedItemPreview(null)
        }
      }).catch(() => {
        setResolvedItemPreview(null)
      })

      // Cleanup URL on unmount or change
      return () => {
        setResolvedItemPreview(prev => {
          if (prev) URL.revokeObjectURL(prev)
          return null
        })
      }
    } else {
      // Content is already a data URL
      setResolvedItemPreview(item.content)
    }
  }, [featuredPhotoSource, selectedPhotoItemId, photoItems])

  // Handle custom photo upload
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    let file: File | Blob | undefined = e.target.files?.[0]
    if (!file) return

    // Convert HEIC to JPEG if needed
    if (file instanceof File && isHeicFile(file)) {
      try {
        file = await convertHeicToJpeg(file)
      } catch (err) {
        console.error('Failed to convert HEIC:', err)
        return
      }
    }

    // Read and resize the image
    const reader = new FileReader()
    reader.onload = (evt) => {
      const img = new Image()
      img.onload = () => {
        const canvas = document.createElement('canvas')
        const maxSize = 512
        const scale = Math.min(maxSize / img.width, maxSize / img.height, 1)
        canvas.width = img.width * scale
        canvas.height = img.height * scale
        const ctx = canvas.getContext('2d')
        if (ctx) {
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
          const dataUrl = canvas.toDataURL('image/jpeg', 0.85)
          setCustomPhotoData(dataUrl)
          setFeaturedPhotoSource('custom')
          setSelectedPhotoItemId(null)
        }
      }
      img.src = evt.target?.result as string
    }
    reader.readAsDataURL(file)

    // Reset file input
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  const handleSave = () => {
    if (!event) return

    const updates: Parameters<typeof onSave>[1] = {}

    // Title
    if (title !== (event.title || '')) {
      updates.title = title || undefined
    }

    // Description
    if (description !== (event.description || '')) {
      updates.description = description || null
    }

    // Featured photo
    if (featuredPhotoSource === 'none') {
      if (event.featuredPhotoId || event.featuredPhotoData) {
        updates.featuredPhotoId = null
        updates.featuredPhotoData = null
      }
    } else if (featuredPhotoSource === 'item') {
      if (selectedPhotoItemId !== event.featuredPhotoId) {
        updates.featuredPhotoId = selectedPhotoItemId
        updates.featuredPhotoData = null
      }
    } else if (featuredPhotoSource === 'custom') {
      if (customPhotoData !== event.featuredPhotoData) {
        updates.featuredPhotoId = null
        updates.featuredPhotoData = customPhotoData
      }
    }

    // Location (only label for now, lat/lng set to 0)
    const currentLabel = event.location?.label || ''
    if (locationLabel !== currentLabel) {
      if (locationLabel) {
        updates.location = { lat: 0, lng: 0, label: locationLabel }
      } else {
        updates.location = null
      }
    }

    // Build start date/time
    if (date) {
      const startAt = showTime && time
        ? `${date}T${time}:00.000Z`
        : date

      if (startAt !== event.startAt) {
        updates.startAt = startAt
      }
    }

    // Build end date/time
    if (showEndDate && endDate) {
      const endAt = showEndTime && endTime
        ? `${endDate}T${endTime}:00.000Z`
        : endDate

      if (endAt !== event.endAt) {
        updates.endAt = endAt
      }
    } else if (!showEndDate && event.endAt) {
      updates.endAt = null
    }

    onSave(event.id, updates)
  }

  // Get preview image
  const getPreviewImage = (): string | null => {
    if (featuredPhotoSource === 'custom' && customPhotoData) {
      return customPhotoData
    }
    if (featuredPhotoSource === 'item' && selectedPhotoItemId) {
      // Use resolved preview for file references
      return resolvedItemPreview
    }
    return null
  }

  if (!isOpen || !event) return null

  const previewImage = getPreviewImage()

  return (
    <>
      {/* Backdrop */}
      <div style={styles.backdrop} onClick={onCancel} />

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,.heic,.heif"
        style={{ display: 'none' }}
        onChange={handleFileSelect}
      />

      {/* Dialog */}
      <div style={styles.dialog}>
        <h3 style={styles.title}>Event Eigenschappen</h3>

        {/* Title */}
        <div style={styles.field}>
          <label style={styles.label}>Titel</label>
          <input
            type="text"
            style={styles.input}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Titel van dit event..."
          />
        </div>

        {/* Description */}
        <div style={styles.field}>
          <label style={styles.label}>Beschrijving</label>
          <textarea
            style={styles.textarea}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Beschrijf dit event..."
            rows={3}
          />
        </div>

        {/* Featured Photo */}
        <div style={styles.field}>
          <label style={styles.label}>Featured Foto</label>
          <div style={styles.featuredPhotoSection}>
            <select
              style={styles.select}
              value={featuredPhotoSource === 'item' ? selectedPhotoItemId || '' : featuredPhotoSource}
              onChange={(e) => {
                const value = e.target.value
                if (value === 'none') {
                  setFeaturedPhotoSource('none')
                  setSelectedPhotoItemId(null)
                } else if (value === 'custom') {
                  fileInputRef.current?.click()
                } else {
                  setFeaturedPhotoSource('item')
                  setSelectedPhotoItemId(value)
                  setCustomPhotoData(null)
                }
              }}
            >
              <option value="none">Geen</option>
              {photoItems.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.caption || `Foto ${photoItems.indexOf(item) + 1}`}
                </option>
              ))}
              <option value="custom">Eigen foto uploaden...</option>
            </select>

            {previewImage && (
              <div style={styles.previewContainer}>
                <img src={previewImage} alt="Preview" style={styles.previewImage} />
                <button
                  style={styles.removePreviewButton}
                  onClick={() => {
                    setFeaturedPhotoSource('none')
                    setSelectedPhotoItemId(null)
                    setCustomPhotoData(null)
                  }}
                >
                  Verwijderen
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Location */}
        <div style={styles.field}>
          <label style={styles.label}>Locatie</label>
          <div style={styles.locationRow}>
            <div style={styles.locationIcon}>
              <MapPin size={18} />
            </div>
            <input
              type="text"
              style={styles.locationInput}
              value={locationLabel}
              onChange={(e) => setLocationLabel(e.target.value)}
              placeholder="bijv. Amsterdam, Nederland"
            />
          </div>
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

        {/* End Date Toggle */}
        <div style={styles.field}>
          {!requireEndDate && (
            <button
              type="button"
              style={{
                ...styles.endDateToggle,
                color: showEndDate ? '#5d7aa0' : '#888'
              }}
              onClick={() => {
                setShowEndDate(!showEndDate)
                if (!showEndDate) {
                  setEndDate(date)
                }
              }}
            >
              {showEndDate ? '- Einddatum verwijderen' : '+ Einddatum toevoegen'}
            </button>
          )}

          {showEndDate && (
            <>
              <label style={{ ...styles.label, marginTop: requireEndDate ? 0 : 12 }}>Einddatum</label>
              <div style={styles.dateRow}>
                <input
                  type="date"
                  style={styles.dateInput}
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  min={date}
                />
                <button
                  type="button"
                  style={{
                    ...styles.timeToggle,
                    color: showEndTime ? '#5d7aa0' : '#666'
                  }}
                  onClick={() => {
                    setShowEndTime(!showEndTime)
                    if (!showEndTime) setEndTime('18:00')
                  }}
                  title={showEndTime ? 'Tijd verbergen' : 'Tijd toevoegen'}
                >
                  <Clock size={18} />
                </button>
              </div>
              {showEndTime && (
                <input
                  type="time"
                  style={{ ...styles.input, marginTop: 8 }}
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                />
              )}
            </>
          )}
        </div>

        {/* Actions */}
        <div style={styles.actions}>
          {onDelete && event && (
            <button
              style={styles.deleteButton}
              onClick={() => {
                if (confirm('Weet je zeker dat je dit event wilt verwijderen? Alle items in dit event worden ook verwijderd.')) {
                  onDelete(event.id)
                }
              }}
            >
              Verwijderen
            </button>
          )}
          <div style={{ flex: 1 }} />
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
    minWidth: 400,
    maxWidth: 500,
    maxHeight: '85vh',
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
    minHeight: 70,
    boxSizing: 'border-box',
  },
  select: {
    width: '100%',
    backgroundColor: '#252545',
    border: '1px solid #333',
    borderRadius: 8,
    color: '#fff',
    fontSize: 14,
    padding: '10px 12px',
    outline: 'none',
    fontFamily: 'inherit',
    cursor: 'pointer',
  },
  featuredPhotoSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  previewContainer: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: 8,
    backgroundColor: '#252545',
    borderRadius: 8,
  },
  previewImage: {
    width: 60,
    height: 60,
    objectFit: 'cover',
    borderRadius: 6,
  },
  removePreviewButton: {
    backgroundColor: 'transparent',
    border: '1px solid #555',
    borderRadius: 6,
    color: '#888',
    fontSize: 12,
    padding: '6px 12px',
    cursor: 'pointer',
  },
  locationRow: {
    display: 'flex',
    alignItems: 'center',
    backgroundColor: '#252545',
    borderRadius: 8,
    padding: '8px 12px',
    gap: 8,
  },
  locationIcon: {
    color: '#5d7aa0',
    display: 'flex',
    alignItems: 'center',
    flexShrink: 0,
  },
  locationInput: {
    flex: 1,
    backgroundColor: 'transparent',
    border: 'none',
    color: '#fff',
    fontSize: 14,
    outline: 'none',
    fontFamily: 'inherit',
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
  actions: {
    display: 'flex',
    gap: 12,
    justifyContent: 'flex-end',
    marginTop: 20,
  },
  deleteButton: {
    padding: '10px 20px',
    backgroundColor: '#d32f2f',
    border: 'none',
    borderRadius: 8,
    color: '#fff',
    fontSize: 14,
    fontWeight: 500,
    cursor: 'pointer',
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
