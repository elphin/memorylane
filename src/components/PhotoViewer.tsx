import { useState, useEffect, useCallback, useRef } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { Item } from '../models/types'
import { readFileAsDataURL, hasStorageFolder } from '../db/fileStorage'

// Transition effect types
type TransitionEffect = 'slide' | 'fade' | 'zoom' | 'kenburns' | 'flip' | 'blur'

// LocalStorage key for slideshow settings
const SLIDESHOW_SETTINGS_KEY = 'photoviewer-slideshow-settings'

// Load settings from localStorage
const loadSlideshowSettings = () => {
  try {
    const saved = localStorage.getItem(SLIDESHOW_SETTINGS_KEY)
    if (saved) {
      return JSON.parse(saved)
    }
  } catch (e) {
    console.warn('Failed to load slideshow settings:', e)
  }
  return null
}

// Save settings to localStorage
const saveSlideshowSettings = (settings: {
  transitionEffect: TransitionEffect
  slideshowInterval: number
  shuffleOrder: boolean
  loopSlideshow: boolean
  showCaptions: boolean
}) => {
  try {
    localStorage.setItem(SLIDESHOW_SETTINGS_KEY, JSON.stringify(settings))
  } catch (e) {
    console.warn('Failed to save slideshow settings:', e)
  }
}

// Animation variants for different effects
const getAnimationVariants = (effect: TransitionEffect, direction: 'left' | 'right', isSlideshow: boolean, _slideshowInterval: number) => {
  const isLeft = direction === 'left'

  switch (effect) {
    case 'slide':
      return {
        initial: { x: isLeft ? '100%' : '-100%', opacity: 0 },
        animate: { x: 0, opacity: 1 },
        exit: { x: isLeft ? '-100%' : '100%', opacity: 0 },
      }
    case 'fade':
      return {
        initial: { opacity: 0 },
        animate: { opacity: 1 },
        exit: { opacity: 0 },
      }
    case 'zoom':
      return {
        initial: { scale: 1.3, opacity: 0 },
        animate: { scale: 1, opacity: 1 },
        exit: { scale: 0.7, opacity: 0 },
      }
    case 'kenburns':
      // Ken Burns: start at scale 1, slowly zoom to 1.15 over the slideshow interval
      return {
        initial: { scale: 1, opacity: 0 },
        animate: {
          scale: isSlideshow ? 1.15 : 1,
          opacity: 1,
        },
        exit: { scale: 1.2, opacity: 0 },
      }
    case 'flip':
      return {
        initial: { rotateY: isLeft ? 90 : -90, opacity: 0 },
        animate: { rotateY: 0, opacity: 1 },
        exit: { rotateY: isLeft ? -90 : 90, opacity: 0 },
      }
    case 'blur':
      return {
        initial: { filter: 'blur(20px)', opacity: 0 },
        animate: { filter: 'blur(0px)', opacity: 1 },
        exit: { filter: 'blur(20px)', opacity: 0 },
      }
    default:
      return {
        initial: { opacity: 0 },
        animate: { opacity: 1 },
        exit: { opacity: 0 },
      }
  }
}

interface PhotoViewerProps {
  item: Item
  allItems: Item[]  // All photos in the same event for navigation
  eventTitle: string
  eventStartDate?: string  // Event's startAt date, used as default for happenedAt
  onClose: () => void
  onDelete: (item: Item) => void
  onSave: (item: Item, updates: { caption?: string; happenedAt?: string; place?: Item['place']; people?: string[] }) => void
  onNavigate: (item: Item) => void
}

// Preload adjacent images
function useImagePreloader(items: Item[], currentIndex: number) {
  useEffect(() => {
    const preloadIndexes = [currentIndex - 1, currentIndex + 1].filter(
      i => i >= 0 && i < items.length
    )

    preloadIndexes.forEach(async (idx) => {
      const item = items[idx]
      if (item.content.startsWith('data:')) {
        const img = new Image()
        img.src = item.content
      }
    })
  }, [items, currentIndex])
}

export function PhotoViewer({
  item,
  allItems,
  eventTitle,
  eventStartDate,
  onClose,
  onDelete,
  onSave,
  onNavigate,
}: PhotoViewerProps) {
  // Helper to get default date from item or event
  const getDefaultDate = (itm: Item) => {
    if (itm.happenedAt) return itm.happenedAt.split('T')[0]
    if (eventStartDate) return eventStartDate.split('T')[0]
    return ''
  }

  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isEditing, setIsEditing] = useState(false)
  const [editCaption, setEditCaption] = useState(item.caption || '')
  const [showControls, setShowControls] = useState(true)

  // Metadata panel state
  const [showMetadata, setShowMetadata] = useState(false)
  const [isEditingMetadata, setIsEditingMetadata] = useState(false)
  const [editDate, setEditDate] = useState(getDefaultDate(item))
  const [editTime, setEditTime] = useState(item.happenedAt?.split('T')[1]?.substring(0, 5) || '')
  const [editLocationLabel, setEditLocationLabel] = useState(item.place?.label || '')
  const [editPeople, setEditPeople] = useState(item.people?.join(', ') || '')

  // Animation state
  const [slideDirection, setSlideDirection] = useState<'left' | 'right'>('left')

  // Slideshow state - load from localStorage
  const savedSettings = useRef(loadSlideshowSettings())
  const [isSlideshow, setIsSlideshow] = useState(false)
  const [slideshowPlaying, setSlideshowPlaying] = useState(false)
  const [slideshowInterval, setSlideshowInterval] = useState(savedSettings.current?.slideshowInterval || 4000)
  const [transitionEffect, setTransitionEffect] = useState<TransitionEffect>(savedSettings.current?.transitionEffect || 'slide')
  const [showSettings, setShowSettings] = useState(false)
  const [shuffleOrder, setShuffleOrder] = useState(savedSettings.current?.shuffleOrder || false)
  const [loopSlideshow, setLoopSlideshow] = useState(savedSettings.current?.loopSlideshow ?? true)
  const [showCaptions, setShowCaptions] = useState(savedSettings.current?.showCaptions ?? true)
  const [shuffledIndices, setShuffledIndices] = useState<number[]>([])

  // Refs
  const slideshowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const controlsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const settingsPanelRef = useRef<HTMLDivElement>(null)

  // Filter to only photo/video items for navigation
  const mediaItems = allItems.filter(i => i.itemType === 'photo' || i.itemType === 'video')
  const currentIndex = mediaItems.findIndex(i => i.id === item.id)
  const hasPrev = currentIndex > 0
  const hasNext = currentIndex < mediaItems.length - 1

  // Preload adjacent images
  useImagePreloader(mediaItems, currentIndex)

  // Load image
  useEffect(() => {
    const loadImage = async () => {
      setIsLoading(true)

      if (item.content.startsWith('data:')) {
        setImageUrl(item.content)
        setIsLoading(false)
      } else if (item.content.startsWith('file:') && hasStorageFolder()) {
        const filePath = item.content.substring(5)
        const parts = filePath.split('/')
        const fileName = parts.pop() || ''
        const dirPath = parts

        try {
          const dataUrl = await readFileAsDataURL(dirPath, fileName)
          setImageUrl(dataUrl)
        } catch (err) {
          console.error('Failed to load image:', err)
        }
        setIsLoading(false)
      } else {
        setIsLoading(false)
      }
    }

    loadImage()
    setEditCaption(item.caption || '')
    // Update metadata state when item changes - default to event start date if no happenedAt
    setEditDate(getDefaultDate(item))
    setEditTime(item.happenedAt?.split('T')[1]?.substring(0, 5) || '')
    setEditLocationLabel(item.place?.label || '')
    setEditPeople(item.people?.join(', ') || '')
  }, [item, eventStartDate])

  // Generate shuffled order when starting slideshow with shuffle
  useEffect(() => {
    if (isSlideshow && shuffleOrder && shuffledIndices.length === 0) {
      // Create shuffled array of indices
      const indices = Array.from({ length: mediaItems.length }, (_, i) => i)
      // Fisher-Yates shuffle
      for (let i = indices.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[indices[i], indices[j]] = [indices[j], indices[i]]
      }
      setShuffledIndices(indices)
    } else if (!isSlideshow) {
      setShuffledIndices([])
    }
  }, [isSlideshow, shuffleOrder, mediaItems.length])

  // Save slideshow settings to localStorage when they change
  useEffect(() => {
    saveSlideshowSettings({
      transitionEffect,
      slideshowInterval,
      shuffleOrder,
      loopSlideshow,
      showCaptions,
    })
  }, [transitionEffect, slideshowInterval, shuffleOrder, loopSlideshow, showCaptions])

  // Close settings panel when clicking outside
  useEffect(() => {
    if (!showSettings) return

    const handleClickOutside = (e: MouseEvent) => {
      if (settingsPanelRef.current && !settingsPanelRef.current.contains(e.target as Node)) {
        setShowSettings(false)
      }
    }

    // Delay to avoid immediate close from the button click
    const timer = setTimeout(() => {
      document.addEventListener('click', handleClickOutside)
    }, 100)

    return () => {
      clearTimeout(timer)
      document.removeEventListener('click', handleClickOutside)
    }
  }, [showSettings])

  // Get next item based on shuffle mode
  const getNextSlideshowItem = useCallback(() => {
    if (shuffleOrder && shuffledIndices.length > 0) {
      const currentShuffleIndex = shuffledIndices.indexOf(currentIndex)
      if (currentShuffleIndex < shuffledIndices.length - 1) {
        return mediaItems[shuffledIndices[currentShuffleIndex + 1]]
      } else if (loopSlideshow) {
        return mediaItems[shuffledIndices[0]]
      }
    } else {
      if (hasNext) {
        return mediaItems[currentIndex + 1]
      } else if (loopSlideshow) {
        return mediaItems[0]
      }
    }
    return null
  }, [shuffleOrder, shuffledIndices, currentIndex, mediaItems, hasNext, loopSlideshow])

  // Slideshow autoplay
  useEffect(() => {
    if (slideshowPlaying) {
      const nextItem = getNextSlideshowItem()
      if (nextItem) {
        slideshowTimerRef.current = setTimeout(() => {
          setSlideDirection('left')
          onNavigate(nextItem)
        }, slideshowInterval)
      } else {
        // No more items and no loop - stop
        setSlideshowPlaying(false)
      }
    }

    return () => {
      if (slideshowTimerRef.current) {
        clearTimeout(slideshowTimerRef.current)
      }
    }
  }, [slideshowPlaying, item.id, slideshowInterval, getNextSlideshowItem, onNavigate])

  // Auto-hide controls in slideshow mode
  useEffect(() => {
    if (isSlideshow && slideshowPlaying) {
      controlsTimerRef.current = setTimeout(() => {
        setShowControls(false)
      }, 2000)
    }

    return () => {
      if (controlsTimerRef.current) {
        clearTimeout(controlsTimerRef.current)
      }
    }
  }, [isSlideshow, slideshowPlaying, showControls])

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't navigate when editing text
      if (isEditing || isEditingMetadata) return

      switch (e.key) {
        case 'Escape':
          if (showSettings) {
            setShowSettings(false)
          } else if (isSlideshow) {
            exitSlideshow()
          } else if (showMetadata) {
            setShowMetadata(false)
          } else {
            onClose()
          }
          break
        case 'ArrowLeft':
          if (hasPrev) handlePrev()
          break
        case 'ArrowRight':
          if (hasNext) handleNext()
          break
        case ' ':
          e.preventDefault()
          if (isSlideshow) {
            setSlideshowPlaying(!slideshowPlaying)
          }
          break
        case 'f':
        case 'F':
          if (!isSlideshow) {
            enterSlideshow()
          }
          break
        case 'Delete':
        case 'Backspace':
          if ((e.metaKey || e.ctrlKey) && !isSlideshow) {
            handleDelete()
          }
          break
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isEditing, isEditingMetadata, hasPrev, hasNext, currentIndex, mediaItems, onClose, onNavigate, isSlideshow, slideshowPlaying, showSettings, showMetadata])

  const handleDelete = useCallback(() => {
    if (confirm('Weet je zeker dat je deze foto wilt verwijderen?')) {
      onDelete(item)
    }
  }, [item, onDelete])

  const handleSave = useCallback(() => {
    onSave(item, { caption: editCaption })
    setIsEditing(false)
  }, [item, editCaption, onSave])

  const handleSaveMetadata = useCallback(() => {
    const updates: Parameters<typeof onSave>[1] = {}

    // Build happenedAt from date and time
    if (editDate) {
      const time = editTime || '00:00'
      updates.happenedAt = `${editDate}T${time}:00`
    } else {
      updates.happenedAt = undefined
    }

    // Build place object
    if (editLocationLabel || item.place?.lat) {
      updates.place = {
        lat: item.place?.lat || 0,
        lng: item.place?.lng || 0,
        label: editLocationLabel || undefined,
      }
    }

    // Build people array
    if (editPeople.trim()) {
      updates.people = editPeople.split(',').map(p => p.trim()).filter(Boolean)
    } else {
      updates.people = undefined
    }

    onSave(item, updates)
    setIsEditingMetadata(false)
  }, [item, editDate, editTime, editLocationLabel, editPeople, onSave])

  // Format date for display
  const formatDate = (isoDate?: string) => {
    if (!isoDate) return null
    const date = new Date(isoDate)
    return date.toLocaleDateString('nl-NL', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })
  }

  const formatTime = (isoDate?: string) => {
    if (!isoDate || !isoDate.includes('T')) return null
    const date = new Date(isoDate)
    return date.toLocaleTimeString('nl-NL', {
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  // Generate Google Maps link
  const getMapLink = (lat: number, lng: number) => {
    return `https://www.google.com/maps?q=${lat},${lng}`
  }

  const handlePrev = useCallback(() => {
    if (hasPrev) {
      setSlideDirection('right')
      onNavigate(mediaItems[currentIndex - 1])
    }
  }, [hasPrev, currentIndex, mediaItems, onNavigate])

  const handleNext = useCallback(() => {
    if (hasNext) {
      setSlideDirection('left')
      onNavigate(mediaItems[currentIndex + 1])
    }
  }, [hasNext, currentIndex, mediaItems, onNavigate])

  const enterSlideshow = () => {
    setIsSlideshow(true)
    setSlideshowPlaying(true)
    setShowControls(false)
    // Request fullscreen
    document.documentElement.requestFullscreen?.()
  }

  const exitSlideshow = () => {
    setIsSlideshow(false)
    setSlideshowPlaying(false)
    setShowControls(true)
    setShowSettings(false)
    // Exit fullscreen
    document.exitFullscreen?.()
  }

  const handleMouseMove = () => {
    if (isSlideshow) {
      setShowControls(true)
      if (controlsTimerRef.current) {
        clearTimeout(controlsTimerRef.current)
      }
      if (slideshowPlaying) {
        controlsTimerRef.current = setTimeout(() => {
          setShowControls(false)
        }, 2000)
      }
    }
  }

  // Get transition config for different effects
  const getTransitionConfig = () => {
    if (transitionEffect === 'kenburns') {
      // Ken Burns: fast entry, slow zoom during display
      return {
        duration: 0.5,
        ease: [0.4, 0, 0.2, 1] as const,
      }
    }
    return {
      duration: 0.5,
      ease: [0.4, 0, 0.2, 1] as const,
    }
  }

  // Get Ken Burns animate config with slow zoom
  const getKenBurnsAnimateConfig = () => {
    if (transitionEffect === 'kenburns' && isSlideshow) {
      return {
        scale: 1.15,
        opacity: 1,
        transition: {
          opacity: { duration: 0.5 },
          scale: { duration: slideshowInterval / 1000, ease: 'linear' as const },
        },
      }
    }
    return undefined
  }

  // Get animation variants for current effect and direction
  const variants = getAnimationVariants(transitionEffect, slideDirection, isSlideshow, slideshowInterval)

  return (
    <div
      style={{
        ...styles.overlay,
        cursor: isSlideshow && !showControls ? 'none' : 'default',
      }}
      onClick={isSlideshow ? () => setShowControls(true) : onClose}
      onMouseMove={handleMouseMove}
    >

      <div
        style={{
          ...styles.container,
          maxWidth: isSlideshow ? '100%' : '1400px',
          padding: isSlideshow ? 0 : '20px',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header - hidden in slideshow mode when controls hidden */}
        {(!isSlideshow || showControls) && (
          <div style={{
            ...styles.header,
            opacity: showControls ? 1 : 0,
            transition: 'opacity 0.3s',
            position: isSlideshow ? 'absolute' : 'relative',
            top: isSlideshow ? 20 : 0,
            left: isSlideshow ? 20 : 0,
            right: isSlideshow ? 20 : 0,
            zIndex: 20,
            background: isSlideshow ? 'linear-gradient(to bottom, rgba(0,0,0,0.7) 0%, transparent 100%)' : 'transparent',
            padding: isSlideshow ? '20px 20px 40px' : '12px 0',
          }}>
            <div style={styles.headerLeft}>
              <span style={styles.badge}>PHOTO</span>
              <span style={styles.eventTitle}>{eventTitle}</span>
            </div>
            <div style={styles.headerRight}>
              <span style={styles.counter}>
                {currentIndex + 1} / {mediaItems.length}
              </span>
              {!isSlideshow && (
                <>
                  <button
                    style={{
                      ...styles.slideshowButton,
                      ...(showSettings ? { backgroundColor: '#3d8060', borderColor: '#3d8060' } : {}),
                    }}
                    onClick={(e) => { e.stopPropagation(); setShowSettings(!showSettings); }}
                    title="Slideshow instellingen"
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="3" />
                      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                    </svg>
                  </button>
                  <button style={styles.slideshowButton} onClick={enterSlideshow} title="Start slideshow (F)">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                  </button>
                </>
              )}
              <button style={styles.closeButton} onClick={isSlideshow ? exitSlideshow : onClose}>
                {isSlideshow ? 'EXIT' : 'ESC'}
              </button>
            </div>
          </div>
        )}

        {/* Main content */}
        <div
          style={{
            ...styles.content,
            height: isSlideshow ? '100vh' : undefined,
          }}
          onMouseEnter={() => !isSlideshow && setShowControls(true)}
          onMouseLeave={() => !isSlideshow && setShowControls(true)}
        >
          {/* Navigation arrows */}
          {hasPrev && (!isSlideshow || showControls) && (
            <button
              style={{
                ...styles.navButton,
                ...styles.navButtonLeft,
                opacity: showControls ? 1 : 0,
                transition: 'opacity 0.3s',
              }}
              onClick={(e) => { e.stopPropagation(); handlePrev(); }}
            >
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </button>
          )}

          {hasNext && (!isSlideshow || showControls) && (
            <button
              style={{
                ...styles.navButton,
                ...styles.navButtonRight,
                opacity: showControls ? 1 : 0,
                transition: 'opacity 0.3s',
              }}
              onClick={(e) => { e.stopPropagation(); handleNext(); }}
            >
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M9 18l6-6-6-6" />
              </svg>
            </button>
          )}

          {/* Image with AnimatePresence for smooth transitions */}
          <AnimatePresence mode="wait">
            {isLoading ? (
              <motion.div
                key="loading"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                style={styles.loading}
              >
                Laden...
              </motion.div>
            ) : imageUrl ? (
              <motion.img
                key={item.id}
                src={imageUrl}
                alt={item.caption || 'Photo'}
                initial={variants.initial}
                animate={getKenBurnsAnimateConfig() || variants.animate}
                exit={variants.exit}
                transition={getTransitionConfig()}
                style={{
                  ...styles.image,
                  maxHeight: isSlideshow ? '100vh' : '100%',
                  borderRadius: isSlideshow ? 0 : '8px',
                }}
              />
            ) : (
              <motion.div
                key="error"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                style={styles.error}
              >
                Foto kon niet worden geladen
                <div style={styles.errorPath}>{item.content}</div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Slideshow progress bar */}
          {isSlideshow && slideshowPlaying && (
            <div style={styles.progressBarContainer}>
              <div
                style={{
                  ...styles.progressBar,
                  animation: `progress ${slideshowInterval}ms linear`,
                }}
              />
              <style>{`
                @keyframes progress {
                  from { width: 0%; }
                  to { width: 100%; }
                }
              `}</style>
            </div>
          )}
        </div>

        {/* Slideshow controls */}
        {isSlideshow && showControls && (
          <div style={styles.slideshowControls}>
            <button
              style={styles.slideshowControlButton}
              onClick={() => setSlideshowPlaying(!slideshowPlaying)}
              title={slideshowPlaying ? 'Pause (Space)' : 'Play (Space)'}
            >
              {slideshowPlaying ? (
                <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="6" y="4" width="4" height="16" />
                  <rect x="14" y="4" width="4" height="16" />
                </svg>
              ) : (
                <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M8 5v14l11-7z" />
                </svg>
              )}
            </button>
            <button
              style={styles.slideshowControlButton}
              onClick={() => setShowSettings(!showSettings)}
              title="Settings"
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
          </div>
        )}

        {/* Settings panel - can show both in and outside slideshow mode */}
        <AnimatePresence>
          {showSettings && (
          <motion.div
            ref={settingsPanelRef}
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.95 }}
            transition={{ duration: 0.2 }}
            style={{
              ...styles.settingsPanel,
              ...(isSlideshow ? {} : styles.settingsPanelNormal),
            }}
            onClick={e => e.stopPropagation()}>
            <h3 style={styles.settingsTitle}>Slideshow instellingen</h3>

            <div style={styles.settingGroup}>
              <label style={styles.settingLabel}>Overgangseffect</label>
              <div style={styles.effectGrid}>
                {(['slide', 'fade', 'zoom', 'kenburns', 'flip', 'blur'] as TransitionEffect[]).map(effect => (
                  <button
                    key={effect}
                    style={{
                      ...styles.effectButton,
                      ...(transitionEffect === effect ? styles.effectButtonActive : {}),
                    }}
                    onClick={() => setTransitionEffect(effect)}
                  >
                    {effect === 'slide' && 'Schuiven'}
                    {effect === 'fade' && 'Vervagen'}
                    {effect === 'zoom' && 'Zoom'}
                    {effect === 'kenburns' && 'Ken Burns'}
                    {effect === 'flip' && 'Omdraaien'}
                    {effect === 'blur' && 'Blur'}
                  </button>
                ))}
              </div>
            </div>

            <div style={styles.settingGroup}>
              <label style={styles.settingLabel}>Snelheid: {slideshowInterval / 1000}s</label>
              <input
                type="range"
                min="2000"
                max="10000"
                step="500"
                value={slideshowInterval}
                onChange={e => setSlideshowInterval(Number(e.target.value))}
                style={styles.slider}
              />
              <div style={styles.sliderLabels}>
                <span>Snel</span>
                <span>Langzaam</span>
              </div>
            </div>

            <div style={styles.settingGroup}>
              <label style={styles.settingLabel}>Opties</label>
              <div style={styles.checkboxGroup}>
                <label style={styles.checkboxLabel}>
                  <input
                    type="checkbox"
                    checked={shuffleOrder}
                    onChange={e => {
                      setShuffleOrder(e.target.checked)
                      setShuffledIndices([]) // Reset to regenerate
                    }}
                    style={styles.checkbox}
                  />
                  <span style={styles.checkboxIcon}>{shuffleOrder ? '✓' : ''}</span>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="16 3 21 3 21 8" />
                    <line x1="4" y1="20" x2="21" y2="3" />
                    <polyline points="21 16 21 21 16 21" />
                    <line x1="15" y1="15" x2="21" y2="21" />
                    <line x1="4" y1="4" x2="9" y2="9" />
                  </svg>
                  Willekeurige volgorde
                </label>

                <label style={styles.checkboxLabel}>
                  <input
                    type="checkbox"
                    checked={loopSlideshow}
                    onChange={e => setLoopSlideshow(e.target.checked)}
                    style={styles.checkbox}
                  />
                  <span style={styles.checkboxIcon}>{loopSlideshow ? '✓' : ''}</span>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="17 1 21 5 17 9" />
                    <path d="M3 11V9a4 4 0 014-4h14" />
                    <polyline points="7 23 3 19 7 15" />
                    <path d="M21 13v2a4 4 0 01-4 4H3" />
                  </svg>
                  Herhalen (loop)
                </label>

                <label style={styles.checkboxLabel}>
                  <input
                    type="checkbox"
                    checked={showCaptions}
                    onChange={e => setShowCaptions(e.target.checked)}
                    style={styles.checkbox}
                  />
                  <span style={styles.checkboxIcon}>{showCaptions ? '✓' : ''}</span>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18" />
                    <line x1="7" y1="2" x2="7" y2="22" />
                    <line x1="17" y1="2" x2="17" y2="22" />
                    <line x1="2" y1="12" x2="22" y2="12" />
                    <line x1="2" y1="7" x2="7" y2="7" />
                    <line x1="2" y1="17" x2="7" y2="17" />
                    <line x1="17" y1="17" x2="22" y2="17" />
                    <line x1="17" y1="7" x2="22" y2="7" />
                  </svg>
                  Toon bijschriften
                </label>
              </div>
            </div>
          </motion.div>
        )}
        </AnimatePresence>

        {/* Footer with caption and actions - hidden in slideshow */}
        {!isSlideshow && (
          <div style={styles.footer}>
            {isEditing ? (
              <div style={styles.editForm}>
                <input
                  type="text"
                  value={editCaption}
                  onChange={e => setEditCaption(e.target.value)}
                  placeholder="Titel / beschrijving"
                  style={styles.editInput}
                  autoFocus
                  onKeyDown={e => {
                    if (e.key === 'Enter') handleSave()
                    if (e.key === 'Escape') setIsEditing(false)
                  }}
                />
                <button style={styles.saveButton} onClick={handleSave}>
                  Opslaan
                </button>
                <button style={styles.cancelButton} onClick={() => setIsEditing(false)}>
                  Annuleren
                </button>
              </div>
            ) : (
              <div style={styles.captionRow}>
                <span style={styles.caption} onClick={() => setIsEditing(true)}>
                  {item.caption || 'Klik om titel toe te voegen...'}
                </span>
                <div style={styles.actions}>
                  <button
                    style={{
                      ...styles.actionButton,
                      ...(showMetadata ? styles.actionButtonActive : {}),
                    }}
                    onClick={() => setShowMetadata(!showMetadata)}
                    title="Metadata"
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="10" />
                      <path d="M12 16v-4M12 8h.01" />
                    </svg>
                  </button>
                  <button
                    style={styles.actionButton}
                    onClick={() => {
                      setShowMetadata(true)
                      setIsEditingMetadata(true)
                    }}
                    title="Bewerken"
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                      <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                    </svg>
                  </button>
                  <button style={styles.actionButton} onClick={handleDelete} title="Verwijderen">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                    </svg>
                  </button>
                </div>
              </div>
            )}

            {/* Metadata Panel */}
            <AnimatePresence>
              {showMetadata && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.2 }}
                  style={{ overflow: 'hidden' }}
                >
                  <div style={styles.metadataPanel}>
                    <AnimatePresence mode="wait">
                      {isEditingMetadata ? (
                        // Edit mode
                        <motion.div
                          key="edit"
                          initial={{ opacity: 0, x: 20 }}
                          animate={{ opacity: 1, x: 0 }}
                          exit={{ opacity: 0, x: -20 }}
                          transition={{ duration: 0.2 }}
                          style={styles.metadataEditForm}
                        >
                    <div style={styles.metadataRow}>
                      <label style={styles.metadataLabel}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                          <line x1="16" y1="2" x2="16" y2="6" />
                          <line x1="8" y1="2" x2="8" y2="6" />
                          <line x1="3" y1="10" x2="21" y2="10" />
                        </svg>
                        Datum & tijd
                      </label>
                      <div style={styles.metadataInputRow}>
                        <input
                          type="date"
                          value={editDate}
                          onChange={e => setEditDate(e.target.value)}
                          style={styles.metadataInput}
                        />
                        <input
                          type="time"
                          value={editTime}
                          onChange={e => setEditTime(e.target.value)}
                          style={{ ...styles.metadataInput, width: '120px' }}
                        />
                      </div>
                    </div>

                    <div style={styles.metadataRow}>
                      <label style={styles.metadataLabel}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z" />
                          <circle cx="12" cy="10" r="3" />
                        </svg>
                        Locatie
                      </label>
                      <input
                        type="text"
                        value={editLocationLabel}
                        onChange={e => setEditLocationLabel(e.target.value)}
                        placeholder="bijv. Amsterdam, Nederland"
                        style={styles.metadataInput}
                      />
                      {item.place?.lat && (
                        <div style={styles.metadataCoords}>
                          GPS: {item.place.lat.toFixed(5)}, {item.place.lng.toFixed(5)}
                        </div>
                      )}
                    </div>

                    <div style={styles.metadataRow}>
                      <label style={styles.metadataLabel}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
                          <circle cx="9" cy="7" r="4" />
                          <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />
                        </svg>
                        Personen
                      </label>
                      <input
                        type="text"
                        value={editPeople}
                        onChange={e => setEditPeople(e.target.value)}
                        placeholder="Namen gescheiden door komma's"
                        style={styles.metadataInput}
                      />
                    </div>

                    <div style={styles.metadataActions}>
                      <button style={styles.metadataSaveButton} onClick={handleSaveMetadata}>
                        Opslaan
                      </button>
                      <button style={styles.metadataCancelButton} onClick={() => setIsEditingMetadata(false)}>
                        Annuleren
                      </button>
                    </div>
                        </motion.div>
                      ) : (
                        // View mode
                        <motion.div
                          key="view"
                          initial={{ opacity: 0, x: -20 }}
                          animate={{ opacity: 1, x: 0 }}
                          exit={{ opacity: 0, x: 20 }}
                          transition={{ duration: 0.2 }}
                          style={styles.metadataView}
                        >
                    {/* Date & Time */}
                    <div style={styles.metadataItem}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                        <line x1="16" y1="2" x2="16" y2="6" />
                        <line x1="8" y1="2" x2="8" y2="6" />
                        <line x1="3" y1="10" x2="21" y2="10" />
                      </svg>
                      <div style={styles.metadataContent}>
                        {item.happenedAt ? (
                          <>
                            <span style={styles.metadataValue}>{formatDate(item.happenedAt)}</span>
                            {formatTime(item.happenedAt) && (
                              <span style={styles.metadataSecondary}>{formatTime(item.happenedAt)}</span>
                            )}
                          </>
                        ) : (
                          <span style={styles.metadataEmpty}>Geen datum</span>
                        )}
                      </div>
                    </div>

                    {/* Location */}
                    <div style={styles.metadataItem}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z" />
                        <circle cx="12" cy="10" r="3" />
                      </svg>
                      <div style={styles.metadataContent}>
                        {item.place ? (
                          <>
                            {item.place.label && (
                              <span style={styles.metadataValue}>{item.place.label}</span>
                            )}
                            {item.place.lat && (
                              <a
                                href={getMapLink(item.place.lat, item.place.lng)}
                                target="_blank"
                                rel="noopener noreferrer"
                                style={styles.metadataLink}
                              >
                                {item.place.lat.toFixed(5)}, {item.place.lng.toFixed(5)} ↗
                              </a>
                            )}
                          </>
                        ) : (
                          <span style={styles.metadataEmpty}>Geen locatie</span>
                        )}
                      </div>
                    </div>

                    {/* People */}
                    <div style={styles.metadataItem}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
                        <circle cx="9" cy="7" r="4" />
                        <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />
                      </svg>
                      <div style={styles.metadataContent}>
                        {item.people && item.people.length > 0 ? (
                          <div style={styles.peopleTags}>
                            {item.people.map((person, i) => (
                              <span key={i} style={styles.personTag}>{person}</span>
                            ))}
                          </div>
                        ) : (
                          <span style={styles.metadataEmpty}>Geen personen getagd</span>
                        )}
                      </div>
                    </div>

                    <button
                      style={styles.editMetadataButton}
                      onClick={() => setIsEditingMetadata(true)}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                        <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                      </svg>
                      Metadata bewerken
                    </button>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Keyboard hints */}
            <div style={styles.hints}>
              <span style={styles.hint}>← → Navigeren</span>
              <span style={styles.hint}>F Slideshow</span>
              <span style={styles.hint}>ESC Sluiten</span>
            </div>
          </div>
        )}

        {/* Caption overlay in slideshow mode */}
        {isSlideshow && item.caption && showControls && showCaptions && (
          <div style={styles.slideshowCaption}>
            {item.caption}
          </div>
        )}
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.95)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  container: {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    height: '100%',
    maxWidth: '1400px',
    maxHeight: '100vh',
    padding: '20px',
    position: 'relative',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '12px 0',
    flexShrink: 0,
  },
  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
  },
  badge: {
    padding: '4px 12px',
    backgroundColor: '#3d8060',
    color: '#fff',
    borderRadius: '4px',
    fontSize: '12px',
    fontWeight: 600,
  },
  eventTitle: {
    color: '#888',
    fontSize: '16px',
  },
  headerRight: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
  },
  counter: {
    color: '#666',
    fontSize: '14px',
  },
  slideshowButton: {
    padding: '8px 12px',
    backgroundColor: 'transparent',
    border: '1px solid #444',
    borderRadius: '6px',
    color: '#888',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  },
  closeButton: {
    padding: '8px 16px',
    backgroundColor: 'transparent',
    border: '1px solid #444',
    borderRadius: '6px',
    color: '#888',
    cursor: 'pointer',
    fontSize: '14px',
  },
  content: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
    minHeight: 0,
    overflow: 'hidden',
  },
  navButton: {
    position: 'absolute',
    top: '50%',
    transform: 'translateY(-50%)',
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    border: 'none',
    borderRadius: '50%',
    width: '56px',
    height: '56px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    color: '#fff',
    transition: 'opacity 0.2s, background-color 0.2s',
    zIndex: 10,
  },
  navButtonLeft: {
    left: '20px',
  },
  navButtonRight: {
    right: '20px',
  },
  image: {
    maxWidth: '100%',
    maxHeight: '100%',
    objectFit: 'contain',
    borderRadius: '8px',
  },
  loading: {
    color: '#666',
    fontSize: '18px',
  },
  error: {
    color: '#ff6b6b',
    fontSize: '16px',
    textAlign: 'center',
  },
  errorPath: {
    color: '#555',
    fontSize: '12px',
    marginTop: '8px',
    wordBreak: 'break-all',
  },
  footer: {
    padding: '16px 0',
    flexShrink: 0,
  },
  captionRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '12px',
  },
  caption: {
    color: '#ccc',
    fontSize: '18px',
    cursor: 'pointer',
    flex: 1,
  },
  actions: {
    display: 'flex',
    gap: '8px',
  },
  actionButton: {
    padding: '8px',
    backgroundColor: 'transparent',
    border: '1px solid #333',
    borderRadius: '6px',
    color: '#888',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  editForm: {
    display: 'flex',
    gap: '12px',
    marginBottom: '12px',
  },
  editInput: {
    flex: 1,
    padding: '12px 16px',
    backgroundColor: '#1a1a2e',
    border: '1px solid #333',
    borderRadius: '8px',
    color: '#fff',
    fontSize: '16px',
    outline: 'none',
  },
  saveButton: {
    padding: '12px 24px',
    backgroundColor: '#3d8060',
    border: 'none',
    borderRadius: '8px',
    color: '#fff',
    cursor: 'pointer',
    fontSize: '14px',
    fontWeight: 500,
  },
  cancelButton: {
    padding: '12px 24px',
    backgroundColor: 'transparent',
    border: '1px solid #444',
    borderRadius: '8px',
    color: '#888',
    cursor: 'pointer',
    fontSize: '14px',
  },
  hints: {
    display: 'flex',
    gap: '24px',
    justifyContent: 'center',
  },
  hint: {
    color: '#555',
    fontSize: '12px',
  },
  // Slideshow specific styles
  progressBarContainer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: '3px',
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
  },
  progressBar: {
    height: '100%',
    backgroundColor: '#3d8060',
  },
  slideshowControls: {
    position: 'absolute',
    bottom: '30px',
    left: '50%',
    transform: 'translateX(-50%)',
    display: 'flex',
    gap: '12px',
    padding: '12px 20px',
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    borderRadius: '30px',
    zIndex: 20,
  },
  slideshowControlButton: {
    padding: '12px',
    backgroundColor: 'transparent',
    border: 'none',
    borderRadius: '50%',
    color: '#fff',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'background-color 0.2s',
  },
  slideshowCaption: {
    position: 'absolute',
    bottom: '100px',
    left: '50%',
    transform: 'translateX(-50%)',
    padding: '12px 24px',
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    borderRadius: '8px',
    color: '#fff',
    fontSize: '18px',
    maxWidth: '80%',
    textAlign: 'center',
    zIndex: 15,
  },
  settingsPanel: {
    position: 'absolute',
    bottom: '100px',
    left: '50%',
    transform: 'translateX(-50%)',
    padding: '24px',
    backgroundColor: 'rgba(20, 20, 30, 0.95)',
    borderRadius: '16px',
    border: '1px solid #333',
    zIndex: 25,
    minWidth: '320px',
  },
  settingsPanelNormal: {
    // Override for non-slideshow mode - position below the header
    top: '80px',
    right: '20px',
    bottom: 'auto',
    left: 'auto',
    transform: 'none',
  },
  settingsTitle: {
    margin: '0 0 20px 0',
    color: '#fff',
    fontSize: '18px',
    fontWeight: 600,
  },
  settingGroup: {
    marginBottom: '20px',
  },
  settingLabel: {
    display: 'block',
    color: '#888',
    fontSize: '14px',
    marginBottom: '10px',
  },
  effectGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: '8px',
  },
  effectButton: {
    padding: '10px 12px',
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    border: '1px solid #444',
    borderRadius: '8px',
    color: '#888',
    cursor: 'pointer',
    fontSize: '12px',
    transition: 'all 0.2s',
  },
  effectButtonActive: {
    backgroundColor: '#3d8060',
    borderColor: '#3d8060',
    color: '#fff',
  },
  slider: {
    width: '100%',
    height: '6px',
    borderRadius: '3px',
    appearance: 'none',
    backgroundColor: '#333',
    outline: 'none',
    cursor: 'pointer',
  },
  sliderLabels: {
    display: 'flex',
    justifyContent: 'space-between',
    marginTop: '6px',
    color: '#666',
    fontSize: '11px',
  },
  // Metadata panel styles
  actionButtonActive: {
    backgroundColor: '#3d8060',
    borderColor: '#3d8060',
    color: '#fff',
  },
  metadataPanel: {
    marginTop: '16px',
    padding: '16px',
    backgroundColor: '#1a1a2e',
    borderRadius: '12px',
    border: '1px solid #333',
  },
  metadataView: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  metadataItem: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '12px',
    color: '#888',
  },
  metadataContent: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    flex: 1,
  },
  metadataValue: {
    color: '#fff',
    fontSize: '14px',
  },
  metadataSecondary: {
    color: '#666',
    fontSize: '13px',
  },
  metadataEmpty: {
    color: '#555',
    fontSize: '14px',
    fontStyle: 'italic',
  },
  metadataLink: {
    color: '#5d9cec',
    fontSize: '12px',
    textDecoration: 'none',
  },
  peopleTags: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '6px',
  },
  personTag: {
    padding: '4px 10px',
    backgroundColor: '#2a2a4e',
    borderRadius: '12px',
    color: '#aaa',
    fontSize: '13px',
  },
  editMetadataButton: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '6px',
    marginTop: '8px',
    padding: '8px 16px',
    backgroundColor: 'transparent',
    border: '1px solid #444',
    borderRadius: '6px',
    color: '#888',
    cursor: 'pointer',
    fontSize: '13px',
    width: '100%',
  },
  metadataEditForm: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
  },
  metadataRow: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  metadataLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    color: '#888',
    fontSize: '13px',
  },
  metadataInputRow: {
    display: 'flex',
    gap: '8px',
  },
  metadataInput: {
    flex: 1,
    padding: '10px 12px',
    backgroundColor: '#0a0a1e',
    border: '1px solid #333',
    borderRadius: '6px',
    color: '#fff',
    fontSize: '14px',
    outline: 'none',
  },
  metadataCoords: {
    color: '#555',
    fontSize: '11px',
    marginTop: '4px',
  },
  metadataActions: {
    display: 'flex',
    gap: '12px',
    marginTop: '8px',
  },
  metadataSaveButton: {
    flex: 1,
    padding: '10px 16px',
    backgroundColor: '#3d8060',
    border: 'none',
    borderRadius: '6px',
    color: '#fff',
    cursor: 'pointer',
    fontSize: '14px',
    fontWeight: 500,
  },
  metadataCancelButton: {
    flex: 1,
    padding: '10px 16px',
    backgroundColor: 'transparent',
    border: '1px solid #444',
    borderRadius: '6px',
    color: '#888',
    cursor: 'pointer',
    fontSize: '14px',
  },
  // Checkbox styles for slideshow options
  checkboxGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
  },
  checkboxLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    color: '#ccc',
    fontSize: '14px',
    cursor: 'pointer',
    padding: '8px 12px',
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    borderRadius: '8px',
    transition: 'background-color 0.2s',
  },
  checkbox: {
    position: 'absolute',
    opacity: 0,
    width: 0,
    height: 0,
  },
  checkboxIcon: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '20px',
    height: '20px',
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    border: '2px solid #555',
    borderRadius: '4px',
    color: '#3d8060',
    fontSize: '14px',
    fontWeight: 'bold',
    transition: 'all 0.2s',
  },
}
