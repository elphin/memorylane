import { useState, useRef, useEffect, useCallback, forwardRef, useImperativeHandle } from 'react'
import { ItemType } from '../models/types'
import heic2any from 'heic2any'
// EXIF extraction - will be used for batch upload feature
// import { extractExifData, reverseGeocode } from '../utils/exif'

// Check if file is HEIC format
function isHeicFile(file: File): boolean {
  const name = file.name.toLowerCase()
  return name.endsWith('.heic') || name.endsWith('.heif') ||
         file.type === 'image/heic' || file.type === 'image/heif'
}

// Convert HEIC to JPEG
async function convertHeicToJpeg(file: File): Promise<File> {
  console.log('Converting HEIC to JPEG:', file.name)
  const blob = await heic2any({
    blob: file,
    toType: 'image/jpeg',
    quality: 0.9,
  })
  // heic2any can return an array of blobs (for multi-image HEIC) or a single blob
  const resultBlob = Array.isArray(blob) ? blob[0] : blob
  const newName = file.name.replace(/\.heic$/i, '.jpg').replace(/\.heif$/i, '.jpg')
  return new File([resultBlob], newName, { type: 'image/jpeg' })
}

interface QuickAddProps {
  currentYearId?: string
  currentEventId?: string
  currentEventDate?: string  // ISO date string from parent event
  onMemoryAdded?: () => void
}

export interface QuickAddRef {
  open: () => void
}

type CaptureStep = 'closed' | 'context-select' | 'type-select' | 'text' | 'link' | 'photo' | 'preview'

interface MediaData {
  file: File
  thumbnail: string  // base64 data URL
  fullSize: string   // base64 data URL for storage
  isVideo: boolean
}

interface CaptureState {
  type: ItemType | null
  content: string
  caption: string
  media?: MediaData
  addToCurrentEvent: boolean  // true = add to current, false = create new root
  date: string  // ISO date string (YYYY-MM-DD)
  time: string  // HH:MM or empty
  showTime: boolean
  endDate: string  // ISO date string or empty
  endTime: string  // HH:MM or empty
  showEndDate: boolean
  showEndTime: boolean
}

// Get today's date in YYYY-MM-DD format
function getTodayString(): string {
  return new Date().toISOString().split('T')[0]
}

// Generate thumbnail from image or video
async function generateThumbnail(file: File, maxSize: number = 256): Promise<{ thumbnail: string; fullSize: string }> {
  return new Promise((resolve, reject) => {
    const isVideo = file.type.startsWith('video/')

    if (isVideo) {
      // Video thumbnail generation
      const video = document.createElement('video')
      video.preload = 'metadata'
      video.muted = true
      video.playsInline = true

      video.onloadeddata = () => {
        video.currentTime = Math.min(1, video.duration / 2) // Seek to 1s or middle
      }

      video.onseeked = () => {
        try {
          const canvas = document.createElement('canvas')
          const scale = Math.min(maxSize / video.videoWidth, maxSize / video.videoHeight)
          canvas.width = Math.max(1, video.videoWidth * scale)
          canvas.height = Math.max(1, video.videoHeight * scale)

          const ctx = canvas.getContext('2d')
          if (!ctx) {
            reject(new Error('Could not get canvas context'))
            return
          }
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
          const thumbnail = canvas.toDataURL('image/jpeg', 0.8)

          // For full size, read the original file
          const reader = new FileReader()
          reader.onload = () => {
            URL.revokeObjectURL(video.src)
            const fullSize = reader.result as string
            console.log('Video processed - thumbnail:', thumbnail.length, 'fullSize:', fullSize.length)
            if (!fullSize || fullSize.length < 100) {
              reject(new Error('Video file data is empty or too small'))
              return
            }
            resolve({ thumbnail, fullSize })
          }
          reader.onerror = () => reject(new Error('Failed to read video file'))
          reader.readAsDataURL(file)
        } catch (err) {
          reject(new Error(`Video processing error: ${err instanceof Error ? err.message : 'Unknown error'}`))
        }
      }

      video.onerror = () => reject(new Error('Failed to load video'))
      video.src = URL.createObjectURL(file)

    } else {
      // Image thumbnail generation
      const img = new Image()

      img.onload = () => {
        try {
          console.log('Image loaded - dimensions:', img.width, 'x', img.height)

          if (img.width === 0 || img.height === 0) {
            reject(new Error('Image has invalid dimensions'))
            return
          }

          // Generate thumbnail
          const canvas = document.createElement('canvas')
          const scale = Math.min(maxSize / img.width, maxSize / img.height)
          canvas.width = Math.max(1, Math.floor(img.width * scale))
          canvas.height = Math.max(1, Math.floor(img.height * scale))

          const ctx = canvas.getContext('2d')
          if (!ctx) {
            reject(new Error('Could not get canvas context for thumbnail'))
            return
          }
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
          const thumbnail = canvas.toDataURL('image/jpeg', 0.8)

          // Generate full size (max 1024px for storage)
          const fullCanvas = document.createElement('canvas')
          const fullScale = Math.min(1, 1024 / Math.max(img.width, img.height))
          fullCanvas.width = Math.max(1, Math.floor(img.width * fullScale))
          fullCanvas.height = Math.max(1, Math.floor(img.height * fullScale))

          const fullCtx = fullCanvas.getContext('2d')
          if (!fullCtx) {
            reject(new Error('Could not get canvas context for full size'))
            return
          }
          fullCtx.drawImage(img, 0, 0, fullCanvas.width, fullCanvas.height)
          const fullSize = fullCanvas.toDataURL('image/jpeg', 0.9)

          console.log('Image processed - thumbnail:', thumbnail.length, 'fullSize:', fullSize.length)

          if (!fullSize || fullSize.length < 100) {
            reject(new Error('Generated image data is empty or too small'))
            return
          }

          URL.revokeObjectURL(img.src)
          resolve({ thumbnail, fullSize })
        } catch (err) {
          reject(new Error(`Image processing error: ${err instanceof Error ? err.message : 'Unknown error'}`))
        }
      }

      img.onerror = () => {
        URL.revokeObjectURL(img.src)
        reject(new Error('Failed to load image - file may be corrupted or unsupported format'))
      }
      img.src = URL.createObjectURL(file)
    }
  })
}

export const QuickAdd = forwardRef<QuickAddRef, QuickAddProps>(function QuickAdd(
  { currentYearId, currentEventId, currentEventDate, onMemoryAdded },
  ref
) {
  // Use parent event date if available, otherwise today
  const getDefaultDate = useCallback(() => {
    return currentEventDate || getTodayString()
  }, [currentEventDate])

  const [step, setStep] = useState<CaptureStep>('closed')
  const [capture, setCapture] = useState<CaptureState>({
    type: null, content: '', caption: '',
    addToCurrentEvent: true,
    date: getDefaultDate(), time: '', showTime: false,
    endDate: '', endTime: '', showEndDate: false, showEndTime: false
  })
  const [isSaving, setIsSaving] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  // Batch progress - will be used for multi-file upload
  // const [batchProgress, setBatchProgress] = useState<{ current: number; total: number } | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Update default date when parent event changes
  useEffect(() => {
    if (step === 'closed') {
      setCapture(prev => ({
        ...prev,
        date: currentEventDate || getTodayString()
      }))
    }
  }, [currentEventDate, step])

  const linkInputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Expose open method via ref
  useImperativeHandle(ref, () => ({
    open: () => {
      // Skip context select since we're adding to current event
      setCapture(prev => ({ ...prev, addToCurrentEvent: true }))
      setStep('type-select')
    }
  }), [])

  // Focus input when entering capture mode
  useEffect(() => {
    if (step === 'text' && textareaRef.current) {
      textareaRef.current.focus()
    } else if (step === 'link' && linkInputRef.current) {
      linkInputRef.current.focus()
    }
  }, [step])

  // Keyboard shortcut: Cmd+N to open
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        e.preventDefault()
        if (step === 'closed') {
          setStep('type-select')
        }
      }
      if (e.key === 'Escape' && step !== 'closed') {
        handleClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [step])

  const handleClose = useCallback(() => {
    setStep('closed')
    setCapture({
      type: null, content: '', caption: '', media: undefined,
      addToCurrentEvent: true,
      date: getDefaultDate(), time: '', showTime: false,
      endDate: '', endTime: '', showEndDate: false, showEndTime: false
    })
    setIsProcessing(false)
  }, [getDefaultDate])

  const handleTypeSelect = (type: ItemType) => {
    setCapture({ ...capture, type })
    if (type === 'text') {
      setStep('text')
    } else if (type === 'link') {
      setStep('link')
    } else if (type === 'photo' || type === 'video') {
      setStep('photo')
      // Trigger file picker after a short delay (for UI transition)
      setTimeout(() => {
        fileInputRef.current?.click()
      }, 100)
    }
  }

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    let file = e.target.files?.[0]
    if (!file) return

    console.log('File selected:', file.name, 'type:', file.type, 'size:', file.size)
    console.log('Is HEIC?', isHeicFile(file))

    setIsProcessing(true)
    try {
      // Convert HEIC to JPEG if needed
      if (isHeicFile(file)) {
        console.log('Converting HEIC file...')
        setToast('HEIC converteren...')
        try {
          file = await convertHeicToJpeg(file)
          console.log('HEIC converted successfully:', file.name, 'type:', file.type)
        } catch (heicError) {
          console.error('HEIC conversion failed:', heicError)
          setToast('HEIC conversie mislukt')
          setTimeout(() => setToast(null), 3000)
          setIsProcessing(false)
          return
        }
        setToast(null)
      }

      const processedFile: File = file
      const isVideo = processedFile.type.startsWith('video/')
      const { thumbnail, fullSize } = await generateThumbnail(processedFile)

      setCapture(prev => ({
        ...prev,
        type: isVideo ? 'video' : 'photo',
        content: fullSize, // Store the full size image as content
        media: {
          file: processedFile,
          thumbnail,
          fullSize,
          isVideo,
        }
      }))
      setStep('preview')
    } catch (err) {
      console.error('Failed to process media:', err)
      setToast('Kon media niet verwerken')
      setTimeout(() => setToast(null), 2000)
    } finally {
      setIsProcessing(false)
      // Reset file input for next selection
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    }
  }

  const handleContentDone = () => {
    if (capture.content.trim() || capture.media) {
      setStep('preview')
    }
  }

  const handleSave = async () => {
    if (!capture.type || (!capture.content.trim() && !capture.media)) return

    setIsSaving(true)
    try {
      // Debug logging for photo saving
      console.log('handleSave called:', {
        type: capture.type,
        hasMedia: !!capture.media,
        contentLength: capture.content?.length,
        mediaFullSizeLength: capture.media?.fullSize?.length,
      })

      // Dynamic import to avoid circular deps
      const { createItem, createEvent, getOrCreateYear, updateEvent } = await import('../db/database')
      const { hasStorageFolder } = await import('../db/fileStorage')
      const { createEventWithFiles, createItemWithFiles, createYearWithFiles } = await import('../db/sync/writer')

      // Check if we have file-based storage configured
      const useFileBased = hasStorageFolder()

      // Determine content - validate it exists for media types
      let content: string
      if (capture.media) {
        if (!capture.media.fullSize || capture.media.fullSize.length === 0) {
          throw new Error('Media content is empty - photo may not have loaded correctly')
        }
        content = capture.media.fullSize
      } else {
        content = capture.content.trim()
      }

      // Final validation
      if (!content || content.length === 0) {
        throw new Error('No content to save')
      }

      console.log('Creating item with content length:', content.length, 'type:', capture.type)
      console.log('Content starts with:', content.substring(0, 50))
      console.log('Using file-based storage:', useFileBased)

      // Determine target event based on user choice
      let targetEventId = capture.addToCurrentEvent ? currentEventId : undefined
      let createdNewEvent = false

      // If no event context (or user chose to create new), create a new event in the correct year
      if (!targetEventId) {
        // Get or create the year matching the capture date
        // Always use the capture.date to determine the year, not the current context
        let yearId: string

        if (useFileBased) {
          // Create year folder if needed (file-based)
          const yearEvent = await createYearWithFiles(capture.date)
          yearId = yearEvent.id
        } else {
          // Database only
          const yearEvent = getOrCreateYear(capture.date)
          yearId = yearEvent.id
        }

        // Create a new event for this memory
        let eventTitle = ''
        if (capture.type === 'text') {
          eventTitle = capture.content.slice(0, 30) + (capture.content.length > 30 ? '...' : '')
        } else if (capture.media) {
          eventTitle = capture.caption.trim() || capture.media.file.name.replace(/\.[^/.]+$/, '')
        } else {
          eventTitle = `${capture.type.charAt(0).toUpperCase() + capture.type.slice(1)} memory`
        }

        // Build start timestamp with optional time
        const startTimestamp = capture.showTime && capture.time
          ? `${capture.date}T${capture.time}:00.000Z`
          : capture.date

        // Build end date with optional time
        const endAt = capture.showEndDate && capture.endDate
          ? (capture.showEndTime && capture.endTime
              ? `${capture.endDate}T${capture.endTime}:00.000Z`
              : capture.endDate)
          : undefined

        if (useFileBased) {
          // Create event with files
          const newEvent = await createEventWithFiles({
            type: 'event',
            title: eventTitle,
            startAt: startTimestamp,
            endAt,
            parentId: yearId,
          })
          targetEventId = newEvent.id
        } else {
          // Database only
          const newEvent = createEvent({
            type: 'event',
            title: eventTitle,
            startAt: startTimestamp,
            endAt,
            parentId: yearId,
          })
          targetEventId = newEvent.id
        }
        createdNewEvent = true
      }

      // Use the selected date for happenedAt (with optional time)
      const happenedAt = capture.showTime && capture.time
        ? `${capture.date}T${capture.time}:00.000Z`
        : `${capture.date}T12:00:00.000Z`

      // Check if target event is file-based (has folderPath)
      const { getEventById } = await import('../db/database')
      const targetEvent = getEventById(targetEventId)
      const eventIsFileBased = targetEvent?.folderPath != null

      let newItem
      if (useFileBased && eventIsFileBased) {
        // Create item with files
        newItem = await createItemWithFiles({
          eventId: targetEventId,
          itemType: capture.type,
          content,
          caption: capture.caption.trim() || undefined,
          happenedAt,
          originalFilename: capture.media?.file.name,
        })
      } else {
        // Database only (either no storage folder or event is not file-based)
        newItem = createItem({
          eventId: targetEventId,
          itemType: capture.type,
          content,
          caption: capture.caption.trim() || undefined,
          happenedAt,
        })
      }

      // If we created a new event with a photo/video, set it as the featured photo
      if (createdNewEvent && (capture.type === 'photo' || capture.type === 'video')) {
        updateEvent(targetEventId, {
          featuredPhotoId: newItem.id,
        })
      }

      // Show toast
      setToast('Herinnering opgeslagen')
      setTimeout(() => setToast(null), 1500)

      // Reset and close
      handleClose()
      onMemoryAdded?.()

    } catch (err) {
      console.error('Failed to save memory:', err)
      setToast(`Opslaan mislukt: ${err instanceof Error ? err.message : 'Onbekende fout'}`)
      setTimeout(() => setToast(null), 3000)
    } finally {
      setIsSaving(false)
    }
  }

  // Handle context selection (add to current event or create new)
  const handleContextSelect = (addToCurrent: boolean) => {
    setCapture({ ...capture, addToCurrentEvent: addToCurrent })
    setStep('type-select')
  }

  // Floating + Button
  if (step === 'closed') {
    return (
      <>
        <button
          style={styles.fab}
          onClick={() => setStep(currentEventId ? 'context-select' : 'type-select')}
          aria-label="Add memory"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
        {toast && <div style={styles.toast}>{toast}</div>}
      </>
    )
  }

  // Backdrop
  const renderBackdrop = () => (
    <div style={styles.backdrop} onClick={handleClose} />
  )

  // Context Selection Sheet (when inside an event)
  if (step === 'context-select') {
    return (
      <>
        {renderBackdrop()}
        <div style={styles.sheet}>
          <div style={styles.sheetHeader}>
            <span style={styles.sheetTitle}>Waar wil je deze herinnering toevoegen?</span>
            <button style={styles.closeButton} onClick={handleClose}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
          <div style={styles.contextOptions}>
            <button style={styles.contextButton} onClick={() => handleContextSelect(true)}>
              <div style={{ ...styles.contextIcon, backgroundColor: '#3d5a80' }}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </div>
              <div style={styles.contextText}>
                <span style={styles.contextTitle}>Aan deze herinnering toevoegen</span>
                <span style={styles.contextSubtitle}>Voeg toe aan de huidige groep</span>
              </div>
            </button>
            <button style={styles.contextButton} onClick={() => handleContextSelect(false)}>
              <div style={{ ...styles.contextIcon, backgroundColor: '#5d7aa0' }}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <path d="M12 8v8M8 12h8" />
                </svg>
              </div>
              <div style={styles.contextText}>
                <span style={styles.contextTitle}>Nieuwe losse herinnering</span>
                <span style={styles.contextSubtitle}>Maak een aparte herinnering in het jaar</span>
              </div>
            </button>
          </div>
        </div>
      </>
    )
  }

  // Type Selection Sheet
  if (step === 'type-select') {
    return (
      <>
        {renderBackdrop()}
        <div style={styles.sheet}>
          <div style={styles.sheetHeader}>
            <span style={styles.sheetTitle}>Leg vast wat nu belangrijk is.</span>
            <button style={styles.closeButton} onClick={handleClose}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
          <div style={styles.typeGrid}>
            <button style={styles.typeButton} onClick={() => handleTypeSelect('photo')}>
              <div style={{ ...styles.typeIcon, backgroundColor: '#4CAF50' }}>
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <circle cx="8.5" cy="8.5" r="1.5" />
                  <path d="M21 15l-5-5L5 21" />
                </svg>
              </div>
              <span style={styles.typeLabel}>Foto / Video</span>
            </button>
            <button style={styles.typeButton} onClick={() => handleTypeSelect('text')}>
              <div style={{ ...styles.typeIcon, backgroundColor: '#9C27B0' }}>
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
                  <line x1="17" y1="10" x2="3" y2="10" />
                  <line x1="21" y1="6" x2="3" y2="6" />
                  <line x1="21" y1="14" x2="3" y2="14" />
                  <line x1="17" y1="18" x2="3" y2="18" />
                </svg>
              </div>
              <span style={styles.typeLabel}>Tekst</span>
            </button>
            <button style={styles.typeButton} onClick={() => handleTypeSelect('link')}>
              <div style={{ ...styles.typeIcon, backgroundColor: '#2196F3' }}>
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                </svg>
              </div>
              <span style={styles.typeLabel}>Link</span>
            </button>
          </div>
        </div>
      </>
    )
  }

  // Text Capture
  if (step === 'text') {
    return (
      <>
        {renderBackdrop()}
        <div style={styles.captureSheet}>
          <div style={styles.captureHeader}>
            <button style={styles.cancelButton} onClick={handleClose}>Annuleren</button>
            <button
              style={{
                ...styles.doneButton,
                opacity: capture.content.trim() ? 1 : 0.5,
              }}
              onClick={handleContentDone}
              disabled={!capture.content.trim()}
            >
              Klaar
            </button>
          </div>
          <textarea
            ref={textareaRef}
            style={styles.textArea}
            placeholder="Wat wil je onthouden?"
            value={capture.content}
            onChange={(e) => setCapture({ ...capture, content: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                handleContentDone()
              }
            }}
          />
          <div style={styles.captureHint}>Ctrl+Enter om door te gaan</div>
        </div>
      </>
    )
  }

  // Link Capture
  if (step === 'link') {
    return (
      <>
        {renderBackdrop()}
        <div style={styles.captureSheet}>
          <div style={styles.captureHeader}>
            <button style={styles.cancelButton} onClick={handleClose}>Annuleren</button>
            <button
              style={{
                ...styles.doneButton,
                opacity: capture.content.trim() ? 1 : 0.5,
              }}
              onClick={handleContentDone}
              disabled={!capture.content.trim()}
            >
              Klaar
            </button>
          </div>
          <div style={styles.linkInputWrapper}>
            <input
              ref={linkInputRef}
              type="url"
              style={styles.linkInput}
              placeholder="https://..."
              value={capture.content}
              onChange={(e) => setCapture({ ...capture, content: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  handleContentDone()
                }
              }}
            />
          </div>
          <input
            type="text"
            style={styles.captionInput}
            placeholder="Beschrijving (optioneel)"
            value={capture.caption}
            onChange={(e) => setCapture({ ...capture, caption: e.target.value })}
          />
        </div>
      </>
    )
  }

  // Photo/Video Capture
  if (step === 'photo') {
    return (
      <>
        {renderBackdrop()}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,video/*,.heic,.heif"
          style={{ display: 'none' }}
          onChange={handleFileSelect}
        />
        <div style={styles.captureSheet}>
          <div style={styles.captureHeader}>
            <button style={styles.cancelButton} onClick={handleClose}>Annuleren</button>
          </div>
          <div style={styles.photoPlaceholder}>
            {isProcessing ? (
              <>
                <div style={styles.spinner} />
                <p style={styles.photoText}>Verwerken...</p>
              </>
            ) : (
              <>
                <div style={styles.photoIcon}>
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#666" strokeWidth="1.5">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <circle cx="8.5" cy="8.5" r="1.5" />
                    <path d="M21 15l-5-5L5 21" />
                  </svg>
                </div>
                <p style={styles.photoText}>Kies een foto of video</p>
                <button
                  style={styles.selectFileButton}
                  onClick={() => fileInputRef.current?.click()}
                >
                  Bladeren...
                </button>
                <button
                  style={styles.backToTypesButton}
                  onClick={() => setStep('type-select')}
                >
                  Kies ander type
                </button>
              </>
            )}
          </div>
        </div>
        {toast && <div style={styles.toast}>{toast}</div>}
      </>
    )
  }

  // Preview & Save
  if (step === 'preview') {
    return (
      <>
        {renderBackdrop()}
        <div style={styles.previewSheet}>
          <div style={styles.previewContent}>
            {capture.type === 'text' && (
              <div style={styles.previewText}>{capture.content}</div>
            )}
            {capture.type === 'link' && (
              <div style={styles.previewLink}>
                <div style={styles.linkIcon}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#2196F3" strokeWidth="2">
                    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                  </svg>
                </div>
                <span style={styles.previewLinkUrl}>{capture.content}</span>
                {capture.caption && <span style={styles.previewCaption}>{capture.caption}</span>}
              </div>
            )}
            {(capture.type === 'photo' || capture.type === 'video') && capture.media && (
              <div style={styles.mediaPreview}>
                <div style={styles.mediaImageContainer}>
                  <img
                    src={capture.media.thumbnail}
                    alt="Preview"
                    style={styles.mediaImage}
                  />
                  {capture.media.isVideo && (
                    <div style={styles.videoOverlay}>
                      <svg width="32" height="32" viewBox="0 0 24 24" fill="white">
                        <polygon points="5 3 19 12 5 21 5 3" />
                      </svg>
                    </div>
                  )}
                </div>
                <input
                  type="text"
                  style={styles.mediaCaptionInput}
                  placeholder="Voeg een beschrijving toe (optioneel)"
                  value={capture.caption}
                  onChange={(e) => setCapture({ ...capture, caption: e.target.value })}
                />
                <div style={styles.mediaFileName}>
                  {capture.media.file.name}
                </div>
              </div>
            )}
          </div>
          {/* Date & Time Picker */}
          <div style={styles.datePickerContainer}>
            <div style={styles.dateRow}>
              <label style={styles.datePickerLabel}>Datum</label>
              <div style={styles.dateInputRow}>
                <div style={styles.datePickerIcon}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                    <line x1="16" y1="2" x2="16" y2="6" />
                    <line x1="8" y1="2" x2="8" y2="6" />
                    <line x1="3" y1="10" x2="21" y2="10" />
                  </svg>
                </div>
                <input
                  type="date"
                  style={styles.dateInputVisible}
                  value={capture.date}
                  onChange={(e) => setCapture({ ...capture, date: e.target.value })}
                />
                {/* Time toggle button */}
                <button
                  type="button"
                  style={{
                    ...styles.timeToggle,
                    color: capture.showTime ? '#5d7aa0' : '#666'
                  }}
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    setCapture({ ...capture, showTime: !capture.showTime, time: capture.showTime ? '' : '12:00' })
                  }}
                  title={capture.showTime ? 'Tijd verbergen' : 'Tijd toevoegen'}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" />
                    <polyline points="12 6 12 12 16 14" />
                  </svg>
                </button>
              </div>
              {/* Time input (shown when toggled) */}
              {capture.showTime && (
                <div style={styles.timeInputWrapper}>
                  <input
                    type="time"
                    style={styles.timeInput}
                    value={capture.time}
                    onChange={(e) => setCapture({ ...capture, time: e.target.value })}
                  />
                </div>
              )}
            </div>

            {/* End date toggle and picker */}
            <div style={styles.endDateSection}>
              <button
                style={{
                  ...styles.endDateToggle,
                  color: capture.showEndDate ? '#5d7aa0' : '#888'
                }}
                onClick={() => setCapture({
                  ...capture,
                  showEndDate: !capture.showEndDate,
                  endDate: capture.showEndDate ? '' : capture.date
                })}
              >
                {capture.showEndDate ? '- Einddatum verwijderen' : '+ Einddatum toevoegen'}
              </button>

              {capture.showEndDate && (
                <div style={styles.dateRow}>
                  <label style={styles.datePickerLabel}>Einddatum</label>
                  <div style={styles.dateInputRow}>
                    <div style={styles.datePickerIcon}>
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                        <line x1="16" y1="2" x2="16" y2="6" />
                        <line x1="8" y1="2" x2="8" y2="6" />
                        <line x1="3" y1="10" x2="21" y2="10" />
                      </svg>
                    </div>
                    <input
                      type="date"
                      style={styles.dateInputVisible}
                      value={capture.endDate}
                      onChange={(e) => setCapture({ ...capture, endDate: e.target.value })}
                      min={capture.date}
                    />
                    <button
                      type="button"
                      style={{
                        ...styles.timeToggle,
                        color: capture.showEndTime ? '#5d7aa0' : '#666'
                      }}
                      onClick={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        setCapture({ ...capture, showEndTime: !capture.showEndTime, endTime: capture.showEndTime ? '' : '18:00' })
                      }}
                      title={capture.showEndTime ? 'Tijd verbergen' : 'Tijd toevoegen'}
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="12" cy="12" r="10" />
                        <polyline points="12 6 12 12 16 14" />
                      </svg>
                    </button>
                  </div>
                  {capture.showEndTime && (
                    <div style={styles.timeInputWrapper}>
                      <input
                        type="time"
                        style={styles.timeInput}
                        value={capture.endTime}
                        onChange={(e) => setCapture({ ...capture, endTime: e.target.value })}
                      />
                    </div>
                  )}
                </div>
              )}
            </div>

            {capture.date !== getTodayString() && (
              <button
                style={styles.todayButton}
                onClick={() => setCapture({ ...capture, date: getTodayString() })}
              >
                Vandaag
              </button>
            )}
          </div>
          <div style={styles.previewActions}>
            <button
              style={styles.secondaryButton}
              onClick={() => {
                if (capture.type === 'text') setStep('text')
                else if (capture.type === 'link') setStep('link')
                else setStep('photo')
              }}
            >
              {capture.media ? 'Andere kiezen' : 'Bewerken'}
            </button>
            <button
              style={styles.primaryButton}
              onClick={handleSave}
              disabled={isSaving}
            >
              {isSaving ? 'Opslaan...' : 'Opslaan'}
            </button>
          </div>
        </div>
        {toast && <div style={styles.toast}>{toast}</div>}
      </>
    )
  }

  return null
})

const styles: Record<string, React.CSSProperties> = {
  // Floating Action Button
  fab: {
    position: 'fixed',
    bottom: 32,
    right: 32,
    width: 56,
    height: 56,
    borderRadius: '50%',
    backgroundColor: '#5d7aa0',
    border: 'none',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'white',
    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.4)',
    transition: 'transform 0.15s, background-color 0.15s',
    zIndex: 1000,
  },

  // Backdrop
  backdrop: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    zIndex: 1000,
  },

  // Type Selection Sheet
  sheet: {
    position: 'fixed',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: '#1a1a2e',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 24,
    zIndex: 1001,
  },
  sheetHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 24,
  },
  sheetTitle: {
    fontSize: 18,
    fontWeight: 500,
    color: '#aaa',
  },
  closeButton: {
    background: 'none',
    border: 'none',
    color: '#666',
    cursor: 'pointer',
    padding: 8,
  },
  typeGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: 16,
  },
  typeButton: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 12,
    padding: 16,
    backgroundColor: '#252545',
    border: 'none',
    borderRadius: 12,
    cursor: 'pointer',
    transition: 'background-color 0.15s',
  },
  typeIcon: {
    width: 56,
    height: 56,
    borderRadius: 12,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  typeLabel: {
    fontSize: 14,
    fontWeight: 500,
    color: '#ddd',
  },

  // Context Selection
  contextOptions: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  contextButton: {
    display: 'flex',
    alignItems: 'center',
    gap: 16,
    padding: 16,
    backgroundColor: '#252545',
    border: 'none',
    borderRadius: 12,
    cursor: 'pointer',
    transition: 'background-color 0.15s',
    textAlign: 'left',
  },
  contextIcon: {
    width: 48,
    height: 48,
    borderRadius: 10,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  contextText: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  contextTitle: {
    fontSize: 16,
    fontWeight: 500,
    color: '#fff',
  },
  contextSubtitle: {
    fontSize: 13,
    color: '#888',
  },

  // Date Picker
  datePickerContainer: {
    marginBottom: 20,
    paddingBottom: 16,
    borderBottom: '1px solid #333',
  },
  datePickerLabel: {
    display: 'block',
    fontSize: 12,
    fontWeight: 500,
    color: '#888',
    marginBottom: 8,
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
  },
  dateInputRow: {
    display: 'flex',
    alignItems: 'center',
    backgroundColor: '#252545',
    borderRadius: 10,
    padding: '8px 12px',
    gap: 8,
  },
  datePickerIcon: {
    color: '#5d7aa0',
    display: 'flex',
    alignItems: 'center',
    flexShrink: 0,
  },
  dateInputVisible: {
    flex: 1,
    backgroundColor: 'transparent',
    border: 'none',
    color: '#fff',
    fontSize: 16,
    fontWeight: 500,
    outline: 'none',
    cursor: 'pointer',
    fontFamily: 'inherit',
    padding: '4px 0',
    // Style the date input
    colorScheme: 'dark',
  } as React.CSSProperties,
  todayButton: {
    marginTop: 8,
    padding: '6px 12px',
    backgroundColor: 'transparent',
    border: '1px solid #5d7aa0',
    borderRadius: 6,
    color: '#5d7aa0',
    fontSize: 12,
    fontWeight: 500,
    cursor: 'pointer',
  },
  dateRow: {
    marginBottom: 8,
  },
  timeToggle: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    padding: 4,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 8,
    borderRadius: 4,
    transition: 'color 0.15s',
    position: 'relative',
    zIndex: 2,  // Above the invisible date input
  },
  timeInputWrapper: {
    marginTop: 8,
    marginLeft: 32,
  },
  timeInput: {
    backgroundColor: '#252545',
    border: '1px solid #333',
    borderRadius: 8,
    color: '#fff',
    fontSize: 14,
    padding: '8px 12px',
    outline: 'none',
    fontFamily: 'inherit',
  },
  endDateSection: {
    marginTop: 12,
    paddingTop: 12,
    borderTop: '1px solid #333',
  },
  endDateToggle: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 500,
    padding: '4px 0',
    marginBottom: 8,
  },

  // Capture Sheet
  captureSheet: {
    position: 'fixed',
    bottom: 0,
    left: 0,
    right: 0,
    top: '30%',
    backgroundColor: '#1a1a2e',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 20,
    display: 'flex',
    flexDirection: 'column',
    zIndex: 1001,
  },
  captureHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  cancelButton: {
    background: 'none',
    border: 'none',
    color: '#888',
    fontSize: 16,
    cursor: 'pointer',
    padding: '8px 0',
  },
  doneButton: {
    background: 'none',
    border: 'none',
    color: '#5d7aa0',
    fontSize: 16,
    fontWeight: 600,
    cursor: 'pointer',
    padding: '8px 0',
  },
  textArea: {
    flex: 1,
    backgroundColor: 'transparent',
    border: 'none',
    color: '#fff',
    fontSize: 18,
    lineHeight: 1.6,
    resize: 'none',
    outline: 'none',
    fontFamily: 'inherit',
  },
  captureHint: {
    fontSize: 12,
    color: '#555',
    textAlign: 'center',
    paddingTop: 12,
  },

  // Link capture
  linkInputWrapper: {
    marginBottom: 16,
  },
  linkInput: {
    width: '100%',
    backgroundColor: '#252545',
    border: '1px solid #333',
    borderRadius: 8,
    color: '#fff',
    fontSize: 16,
    padding: '12px 16px',
    outline: 'none',
    fontFamily: 'inherit',
  },
  captionInput: {
    width: '100%',
    backgroundColor: 'transparent',
    border: 'none',
    borderBottom: '1px solid #333',
    color: '#aaa',
    fontSize: 14,
    padding: '12px 0',
    outline: 'none',
    fontFamily: 'inherit',
  },

  // Photo placeholder
  photoPlaceholder: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
  },
  photoIcon: {
    width: 80,
    height: 80,
    borderRadius: 16,
    backgroundColor: '#252545',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  photoText: {
    fontSize: 16,
    color: '#888',
    margin: 0,
  },
  photoSubtext: {
    fontSize: 14,
    color: '#555',
    margin: 0,
  },
  backToTypesButton: {
    marginTop: 16,
    padding: '10px 20px',
    backgroundColor: '#252545',
    border: 'none',
    borderRadius: 8,
    color: '#aaa',
    fontSize: 14,
    cursor: 'pointer',
  },

  // Preview Sheet
  previewSheet: {
    position: 'fixed',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: '#1a1a2e',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 24,
    zIndex: 1001,
  },
  previewContent: {
    minHeight: 120,
    marginBottom: 16,
  },
  previewText: {
    fontSize: 18,
    lineHeight: 1.6,
    color: '#fff',
    whiteSpace: 'pre-wrap',
  },
  previewLink: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  linkIcon: {
    marginBottom: 4,
  },
  previewLinkUrl: {
    fontSize: 16,
    color: '#2196F3',
    wordBreak: 'break-all',
  },
  previewCaption: {
    fontSize: 14,
    color: '#888',
  },
  previewMeta: {
    display: 'flex',
    gap: 16,
    marginBottom: 20,
    paddingBottom: 16,
    borderBottom: '1px solid #333',
  },
  metaItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 13,
    color: '#666',
  },
  previewActions: {
    display: 'flex',
    gap: 12,
  },
  secondaryButton: {
    flex: 1,
    padding: '14px 20px',
    backgroundColor: '#252545',
    border: 'none',
    borderRadius: 10,
    color: '#aaa',
    fontSize: 16,
    fontWeight: 500,
    cursor: 'pointer',
  },
  primaryButton: {
    flex: 2,
    padding: '14px 20px',
    backgroundColor: '#5d7aa0',
    border: 'none',
    borderRadius: 10,
    color: '#fff',
    fontSize: 16,
    fontWeight: 600,
    cursor: 'pointer',
  },

  // Toast
  toast: {
    position: 'fixed',
    bottom: 100,
    left: '50%',
    transform: 'translateX(-50%)',
    backgroundColor: '#333',
    color: '#fff',
    padding: '12px 24px',
    borderRadius: 8,
    fontSize: 14,
    zIndex: 1002,
    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
  },

  // Spinner
  spinner: {
    width: 48,
    height: 48,
    border: '3px solid #333',
    borderTopColor: '#5d7aa0',
    borderRadius: '50%',
    animation: 'spin 1s linear infinite',
  },

  // Select file button
  selectFileButton: {
    padding: '12px 24px',
    backgroundColor: '#5d7aa0',
    border: 'none',
    borderRadius: 8,
    color: '#fff',
    fontSize: 16,
    fontWeight: 500,
    cursor: 'pointer',
  },

  // Media preview
  mediaPreview: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  mediaImageContainer: {
    position: 'relative',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#111',
    borderRadius: 12,
    overflow: 'hidden',
    maxHeight: 200,
  },
  mediaImage: {
    maxWidth: '100%',
    maxHeight: 200,
    objectFit: 'contain',
  },
  videoOverlay: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    width: 56,
    height: 56,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  mediaCaptionInput: {
    width: '100%',
    backgroundColor: 'transparent',
    border: 'none',
    borderBottom: '1px solid #333',
    color: '#fff',
    fontSize: 14,
    padding: '12px 0',
    outline: 'none',
    fontFamily: 'inherit',
  },
  mediaFileName: {
    fontSize: 12,
    color: '#555',
    textAlign: 'center',
  },
}
