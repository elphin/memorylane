import { useEffect, useState, useRef, useCallback } from 'react'
import { Timeline, TimelineRef } from './timeline/Timeline'
import { initDatabase, getEventsByType, getAllEvents, deleteItem, updateItem, getEventById, updateEvent, getPhotoItemsForEvent, createItem, upsertCanvasItem, getAllItems, updateItemContent, getItemsByEvent } from './db/database'
import { Event, ZoomLevel, Item } from './models/types'
import { QuickAdd, QuickAddRef } from './components/QuickAdd'
import { ConfirmDialog } from './components/ConfirmDialog'
import { EditMemoryDialog } from './components/EditMemoryDialog'
import { PhotoViewer } from './components/PhotoViewer'
import { EventPropertiesDialog } from './components/EventPropertiesDialog'
import { SearchModal } from './components/SearchModal'
import { Search } from 'lucide-react'
import { extractExifData } from './utils/exif'
import { SearchResult } from './db/database'
import heic2any from 'heic2any'
import {
  isFileSystemSupported,
  selectStorageFolder,
  restoreStorageFolder,
  hasStorageFolder,
  writeImageFromDataURL,
  readDatabaseFile,
} from './db/fileStorage'
import { rebuildFullIndex, needsFullRebuild, recoverFromPhotos } from './db/sync/indexer'
import { updateEventWithFiles, createItemWithFiles, updateCanvasItemWithFiles } from './db/sync/writer'
import { importDatabase } from './db/database'
import { migrateToFileBasedStorage } from './db/migration'

// Check if file is HEIC format
function isHeicFile(file: File): boolean {
  const name = file.name.toLowerCase()
  return name.endsWith('.heic') || name.endsWith('.heif') ||
         file.type === 'image/heic' || file.type === 'image/heif'
}

// Convert HEIC to JPEG and return as File
async function convertHeicToJpeg(file: File): Promise<File> {
  console.log('Converting HEIC to JPEG:', file.name)
  const blob = await heic2any({
    blob: file,
    toType: 'image/jpeg',
    quality: 0.9,
  })
  const resultBlob = Array.isArray(blob) ? blob[0] : blob
  const newName = file.name.replace(/\.heic$/i, '.jpg').replace(/\.heif$/i, '.jpg')
  return new File([resultBlob], newName, { type: 'image/jpeg' })
}

// Breadcrumb item type
interface BreadcrumbItem {
  id: string
  title: string
  level: ZoomLevel
}

export default function App() {
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [zoomLevel, setZoomLevel] = useState<ZoomLevel>(ZoomLevel.L0_Lifeline)
  const [years, setYears] = useState<Event[]>([])
  const [events, setEvents] = useState<Event[]>([])
  const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbItem[]>([])
  const [currentYearId, setCurrentYearId] = useState<string | undefined>()
  const [currentEventId, setCurrentEventId] = useState<string | undefined>()
  const [itemToDelete, setItemToDelete] = useState<Item | null>(null)
  const [itemToEdit, setItemToEdit] = useState<Item | null>(null)
  const [eventToEdit, setEventToEdit] = useState<Event | null>(null)
  const [eventToEditProperties, setEventToEditProperties] = useState<Event | null>(null)
  const [eventPhotoItems, setEventPhotoItems] = useState<Item[]>([])
  const [uploadProgress, setUploadProgress] = useState<{ current: number; total: number; fileName: string } | null>(null)
  const [storageConfigured, setStorageConfigured] = useState(false)
  const [, setShowStorageSetup] = useState(false)
  const [migrationProgress, setMigrationProgress] = useState<{ current: number; total: number; status: string } | null>(null)
  const [showProfileMenu, setShowProfileMenu] = useState(false)
  const [indexingProgress, setIndexingProgress] = useState<{ status: string } | null>(null)
  const [darkMode, setDarkMode] = useState(() => {
    // Load from localStorage or default to true (dark mode)
    const saved = localStorage.getItem('memorylane-dark-mode')
    return saved !== null ? saved === 'true' : true
  })
  const profileMenuRef = useRef<HTMLDivElement>(null)
  const [viewingPhoto, setViewingPhoto] = useState<{ item: Item; eventId: string } | null>(null)
  const [viewingPhotoItems, setViewingPhotoItems] = useState<Item[]>([])
  const [showSearch, setShowSearch] = useState(false)
  const timelineRef = useRef<TimelineRef>(null)
  const quickAddRef = useRef<QuickAddRef>(null)
  const isNavigatingRef = useRef(false) // Prevent duplicate history entries

  // All hooks must be before any early returns
  const handleZoomLevelChange = useCallback((level: ZoomLevel) => {
    setZoomLevel(level)
    if (level === ZoomLevel.L0_Lifeline) {
      setBreadcrumbs([])
      setCurrentYearId(undefined)
      setCurrentEventId(undefined)
    } else if (level === ZoomLevel.L1_Year) {
      setBreadcrumbs(prev => prev.filter(b => b.level === ZoomLevel.L1_Year))
      setCurrentEventId(undefined)  // Clear event when going back to year view
    } else if (level === ZoomLevel.L2_Canvas) {
      setBreadcrumbs(prev => prev.filter(b => b.level !== ZoomLevel.L3_Focus))
    }

    // Push history state (unless we're navigating via popstate)
    if (!isNavigatingRef.current) {
      window.history.pushState({ level }, '', null)
    }
  }, [])

  useEffect(() => {
    const init = async () => {
      try {
        // Try to restore storage folder first
        let hasFileStorage = false
        if (isFileSystemSupported()) {
          const restored = await restoreStorageFolder()
          if (restored) {
            hasFileStorage = true
            setStorageConfigured(true)
            console.log('Storage folder restored')

            // Try to load database from file
            const dbData = await readDatabaseFile()
            if (dbData) {
              console.log('Loading database from file (index.db)...')
              setIndexingProgress({ status: 'Loading database...' })
              await importDatabase(dbData)
              console.log('Database loaded from file')

              // Check if we need to rebuild (e.g., version mismatch)
              if (needsFullRebuild()) {
                console.log('Index version outdated, rebuilding...')
                setIndexingProgress({ status: 'Rebuilding index from files...' })
                await rebuildFullIndex()
                console.log('Index rebuilt')
              }
            } else {
              // No database file - rebuild from markdown files
              console.log('No index.db found, building index from files...')
              setIndexingProgress({ status: 'Building index from files...' })
              await rebuildFullIndex()
              console.log('Index built from files')
            }

            setIndexingProgress(null)
          } else {
            // No folder configured - show setup prompt
            setShowStorageSetup(true)
            // Initialize with localStorage database
            await initDatabase()
          }
        } else {
          // File System API not supported - use localStorage
          await initDatabase()
        }

        // If no file storage, use localStorage database
        if (!hasFileStorage) {
          await initDatabase()
        }

        const yearEvents = getEventsByType('year')
        const allEvents = getAllEvents()
        console.log('Loaded years:', yearEvents.length, 'events:', allEvents.length)

        // Filter years to only show those with content (child events)
        const yearsWithContent = yearEvents.filter(year => {
          const hasChildEvents = allEvents.some(e => e.parentId === year.id)
          return hasChildEvents
        })

        setYears(yearsWithContent)
        setEvents(allEvents.filter(e => e.type !== 'year'))
        setIsLoading(false)
      } catch (err) {
        console.error('Failed to initialize:', err)
        setError('Failed to initialize: ' + (err as Error).message)
        setIsLoading(false)
      }
    }

    init()
  }, [])

  // Handle browser back/forward buttons
  useEffect(() => {
    const handlePopState = (e: PopStateEvent) => {
      isNavigatingRef.current = true
      const targetLevel = e.state?.level ?? ZoomLevel.L0_Lifeline

      if (targetLevel < zoomLevel) {
        timelineRef.current?.navigateToLevel(targetLevel)
      }

      setTimeout(() => {
        isNavigatingRef.current = false
      }, 100)
    }

    window.addEventListener('popstate', handlePopState)

    if (!window.history.state) {
      window.history.replaceState({ level: ZoomLevel.L0_Lifeline }, '', null)
    }

    return () => window.removeEventListener('popstate', handlePopState)
  }, [zoomLevel])

  // Close profile menu on click outside
  useEffect(() => {
    if (!showProfileMenu) return

    const handleClickOutside = (e: MouseEvent) => {
      if (profileMenuRef.current && !profileMenuRef.current.contains(e.target as Node)) {
        setShowProfileMenu(false)
      }
    }

    const timer = setTimeout(() => {
      document.addEventListener('click', handleClickOutside)
    }, 100)

    return () => {
      clearTimeout(timer)
      document.removeEventListener('click', handleClickOutside)
    }
  }, [showProfileMenu])

  // Toggle dark/light mode
  const toggleDarkMode = useCallback(() => {
    setDarkMode(prev => {
      const newValue = !prev
      localStorage.setItem('memorylane-dark-mode', String(newValue))
      return newValue
    })
  }, [])

  // Global search shortcut (Ctrl+K)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setShowSearch(true)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  const handleBreadcrumbClick = (item: BreadcrumbItem, index: number) => {
    if (item.level === ZoomLevel.L0_Lifeline) {
      // Navigate to home (lifeline view)
      timelineRef.current?.navigateToLevel(ZoomLevel.L0_Lifeline)
      setBreadcrumbs([])
      setCurrentYearId(undefined)
      setCurrentEventId(undefined)
    } else if (item.level === ZoomLevel.L1_Year) {
      timelineRef.current?.navigateToLevel(ZoomLevel.L1_Year, item.id)
      setBreadcrumbs([item])
      setCurrentYearId(item.id)
      setCurrentEventId(undefined)
    } else if (item.level === ZoomLevel.L2_Canvas) {
      timelineRef.current?.navigateToLevel(ZoomLevel.L2_Canvas, item.id)
      setBreadcrumbs(breadcrumbs.slice(0, index + 1))
      setCurrentEventId(item.id)
    }
  }

  // Go back to home (L0)
  const handleGoHome = () => {
    timelineRef.current?.navigateToLevel(ZoomLevel.L0_Lifeline)
    setBreadcrumbs([])
    setCurrentYearId(undefined)
    setCurrentEventId(undefined)
  }

  const handleEventSelect = (event: Event, level: ZoomLevel) => {
    if (level === ZoomLevel.L1_Year) {
      setBreadcrumbs([{ id: event.id, title: event.title || '', level }])
      setCurrentYearId(event.id)
      setCurrentEventId(undefined)
    } else if (level === ZoomLevel.L2_Canvas) {
      setBreadcrumbs(prev => {
        const yearBreadcrumb = prev.find(b => b.level === ZoomLevel.L1_Year)
        if (yearBreadcrumb) {
          return [yearBreadcrumb, { id: event.id, title: event.title || '', level }]
        }
        return [{ id: event.id, title: event.title || '', level }]
      })
      setCurrentEventId(event.id)
    }
  }

  // Refresh data after adding a memory
  const handleMemoryAdded = useCallback(() => {
    const yearEvents = getEventsByType('year')
    const allEvents = getAllEvents()

    // Filter years to only show those with content (child events)
    const yearsWithContent = yearEvents.filter(year => {
      const hasChildEvents = allEvents.some(e => e.parentId === year.id)
      return hasChildEvents
    })

    setYears(yearsWithContent)
    setEvents(allEvents.filter(e => e.type !== 'year'))
  }, [])

  // Handle delete item request (shows confirmation)
  const handleDeleteItemRequest = useCallback((item: Item) => {
    setItemToDelete(item)
  }, [])

  // Confirm delete item
  const handleConfirmDelete = useCallback(() => {
    if (!itemToDelete) return

    try {
      deleteItem(itemToDelete.id)
      // Refresh events to trigger view rebuild
      const allEvents = getAllEvents()
      setEvents(allEvents.filter(e => e.type !== 'year'))
    } catch (err) {
      console.error('Failed to delete item:', err)
    }

    setItemToDelete(null)
  }, [itemToDelete])

  // Cancel delete
  const handleCancelDelete = useCallback(() => {
    setItemToDelete(null)
  }, [])

  // Handle edit item request
  const handleEditItemRequest = useCallback((item: Item) => {
    // Fetch the parent event to get its dates
    const parentEvent = getEventById(item.eventId)
    setItemToEdit(item)
    setEventToEdit(parentEvent)
  }, [])

  // Save edited item
  const handleSaveEdit = useCallback((itemId: string, eventId: string, updates: {
    caption?: string
    happenedAt?: string
    content?: string
    eventStartAt?: string
    eventEndAt?: string | null
  }) => {
    try {
      // Update item fields
      const itemUpdates: { caption?: string; happenedAt?: string; content?: string } = {}
      if (updates.caption !== undefined) itemUpdates.caption = updates.caption
      if (updates.happenedAt !== undefined) itemUpdates.happenedAt = updates.happenedAt
      if (updates.content !== undefined) itemUpdates.content = updates.content

      if (Object.keys(itemUpdates).length > 0) {
        updateItem(itemId, itemUpdates)
      }

      // Update event fields (dates)
      const eventUpdates: { startAt?: string; endAt?: string | null } = {}
      if (updates.eventStartAt !== undefined) eventUpdates.startAt = updates.eventStartAt
      if (updates.eventEndAt !== undefined) eventUpdates.endAt = updates.eventEndAt

      if (Object.keys(eventUpdates).length > 0) {
        updateEvent(eventId, eventUpdates)
      }

      // Refresh events to trigger view rebuild
      const allEvents = getAllEvents()
      setEvents(allEvents.filter(e => e.type !== 'year'))
    } catch (err) {
      console.error('Failed to update item:', err)
    }
    setItemToEdit(null)
    setEventToEdit(null)
  }, [])

  // Cancel edit
  const handleCancelEdit = useCallback(() => {
    setItemToEdit(null)
    setEventToEdit(null)
  }, [])

  // Handle edit event properties request
  const handleEditEventProperties = useCallback((eventId: string) => {
    const event = getEventById(eventId)
    if (event) {
      const photoItems = getPhotoItemsForEvent(eventId)
      setEventToEditProperties(event)
      setEventPhotoItems(photoItems)
    }
  }, [])

  // Save event properties
  const handleSaveEventProperties = useCallback(async (eventId: string, updates: Parameters<typeof updateEvent>[1]) => {
    try {
      // Check if event has a folderPath for file-based update
      const eventToUpdate = getEventById(eventId)
      const canUseFileBased = hasStorageFolder() && eventToUpdate?.folderPath

      if (canUseFileBased) {
        // Convert null to undefined for file-based update (null means "clear", undefined means "no change")
        const fileUpdates = {
          ...updates,
          description: updates.description === null ? undefined : updates.description,
          endAt: updates.endAt === null ? undefined : updates.endAt,
          location: updates.location === null ? undefined : updates.location,
          featuredPhotoId: updates.featuredPhotoId === null ? undefined : updates.featuredPhotoId,
          featuredPhotoData: updates.featuredPhotoData === null ? undefined : updates.featuredPhotoData,
        }
        await updateEventWithFiles(eventId, fileUpdates)
      } else {
        // Fallback to database-only update
        updateEvent(eventId, updates)
      }
      // Refresh events to trigger view rebuild
      const allEvents = getAllEvents()
      setEvents(allEvents.filter(e => e.type !== 'year'))
      // Update breadcrumb title if changed
      if (updates.title !== undefined) {
        setBreadcrumbs(prev => prev.map(b =>
          b.id === eventId ? { ...b, title: updates.title || '' } : b
        ))
      }
    } catch (err) {
      console.error('Failed to update event properties:', err)
      alert('Fout bij opslaan: ' + (err as Error).message)
    }
    setEventToEditProperties(null)
    setEventPhotoItems([])
  }, [])

  // Cancel event properties edit
  const handleCancelEventProperties = useCallback(() => {
    setEventToEditProperties(null)
    setEventPhotoItems([])
  }, [])

  // Handle opening photo viewer
  const handleViewPhoto = useCallback((item: Item, eventId: string) => {
    // Get all items in this event for navigation
    const eventItems = getItemsByEvent(eventId)
    const mediaItems = eventItems.filter(i => i.itemType === 'photo' || i.itemType === 'video')
    setViewingPhotoItems(mediaItems)
    setViewingPhoto({ item, eventId })
  }, [])

  // Handle photo viewer close
  const handleClosePhotoViewer = useCallback(() => {
    setViewingPhoto(null)
    setViewingPhotoItems([])
  }, [])

  // Handle photo viewer navigation
  const handlePhotoNavigate = useCallback((item: Item) => {
    if (viewingPhoto) {
      setViewingPhoto({ item, eventId: viewingPhoto.eventId })
    }
  }, [viewingPhoto])

  // Handle photo viewer save (caption and metadata update)
  const handlePhotoSave = useCallback((item: Item, updates: { caption?: string; happenedAt?: string; place?: Item['place']; people?: string[] }) => {
    try {
      updateItem(item.id, updates)
      // Update the item in the viewing state
      if (viewingPhoto && viewingPhoto.item.id === item.id) {
        setViewingPhoto({ ...viewingPhoto, item: { ...item, ...updates } })
      }
      // Update items list
      setViewingPhotoItems(prev =>
        prev.map(i => i.id === item.id ? { ...i, ...updates } : i)
      )
      // Refresh events to trigger view rebuild
      const allEvents = getAllEvents()
      setEvents(allEvents.filter(e => e.type !== 'year'))
    } catch (err) {
      console.error('Failed to save photo:', err)
    }
  }, [viewingPhoto])

  // Handle photo viewer delete
  const handlePhotoDelete = useCallback((item: Item) => {
    try {
      deleteItem(item.id)
      // Navigate to next/prev photo or close if last
      const currentIndex = viewingPhotoItems.findIndex(i => i.id === item.id)
      const remainingItems = viewingPhotoItems.filter(i => i.id !== item.id)

      if (remainingItems.length === 0) {
        // No more photos, close viewer
        handleClosePhotoViewer()
      } else {
        // Navigate to next or previous
        const nextIndex = Math.min(currentIndex, remainingItems.length - 1)
        setViewingPhotoItems(remainingItems)
        setViewingPhoto({ item: remainingItems[nextIndex], eventId: viewingPhoto?.eventId || '' })
      }

      // Refresh events to trigger view rebuild
      const allEvents = getAllEvents()
      setEvents(allEvents.filter(e => e.type !== 'year'))
    } catch (err) {
      console.error('Failed to delete photo:', err)
    }
  }, [viewingPhotoItems, viewingPhoto, handleClosePhotoViewer])

  // Handle search result selection
  const handleSearchResult = useCallback((result: SearchResult) => {
    setShowSearch(false)

    if (result.type === 'event') {
      // Navigate to event canvas
      timelineRef.current?.navigateToLevel(ZoomLevel.L2_Canvas, result.id)
    } else if (result.eventId) {
      // Navigate to parent event (the item is inside this event)
      timelineRef.current?.navigateToLevel(ZoomLevel.L2_Canvas, result.eventId)
      // If it's a photo/video, open it in photo viewer after a short delay
      if (result.thumbnailContent && (result.itemType === 'photo' || result.itemType === 'video')) {
        setTimeout(() => {
          const eventItems = getItemsByEvent(result.eventId!)
          const item = eventItems.find(i => i.id === result.id)
          if (item) {
            handleViewPhoto(item, result.eventId!)
          }
        }, 300)
      }
    }
  }, [handleViewPhoto])

  // Handle dropped photos on canvas
  const handleDropPhotos = useCallback(async (files: File[], position: { x: number; y: number }, eventId: string) => {
    console.log('handleDropPhotos called:', {
      fileCount: files.length,
      position,
      eventId,
      fileNames: files.map(f => f.name)
    })

    // Get event info
    const event = getEventById(eventId)
    if (!event) {
      console.error('Event not found:', eventId)
      return
    }

    // Check if we have file storage configured
    const useFileStorage = hasStorageFolder()
    if (!useFileStorage) {
      console.warn('No storage folder configured - photos will not persist!')
    }

    const ITEM_SPACING = 220  // Space between dropped items
    let offsetX = 0
    const totalFiles = files.length

    for (let i = 0; i < files.length; i++) {
      let file = files[i]
      try {
        // Show progress
        setUploadProgress({ current: i + 1, total: totalFiles, fileName: file.name })

        // Extract EXIF data BEFORE any conversion (HEIC conversion may lose EXIF)
        const exifData = await extractExifData(file)

        // Convert HEIC to JPEG if needed
        if (isHeicFile(file)) {
          console.log('Converting dropped HEIC file:', file.name)
          setUploadProgress({ current: i + 1, total: totalFiles, fileName: `Converting ${file.name}...` })
          file = await convertHeicToJpeg(file)
        }

        // Read file as base64 (needed for createItemWithFiles)
        const reader = new FileReader()
        const dataUrl = await new Promise<string>((resolve, reject) => {
          reader.onload = () => resolve(reader.result as string)
          reader.onerror = reject
          reader.readAsDataURL(file)
        })

        setUploadProgress({ current: i + 1, total: totalFiles, fileName: `Saving ${file.name}...` })

        // Use sync writer to create item with files (markdown + media + index)
        if (useFileStorage) {
          const newItem = await createItemWithFiles({
            eventId,
            itemType: 'photo',
            content: dataUrl,  // Will be saved as file and converted to file: reference
            caption: file.name.replace(/\.[^/.]+$/, ''),
            happenedAt: exifData.dateTaken,
            place: exifData.location ? {
              lat: exifData.location.lat,
              lng: exifData.location.lng,
              label: undefined
            } : undefined,
            originalFilename: file.name,
          })
          console.log('Item created with files:', newItem.id, newItem.slug)

          // Position on canvas and save to _canvas.json
          await updateCanvasItemWithFiles({
            eventId,
            itemId: newItem.id,
            itemSlug: newItem.slug,
            x: position.x + offsetX,
            y: position.y,
            scale: 1,
            rotation: 0,
            zIndex: i,  // Stack order based on drop order
          })
          console.log('Canvas item saved for:', newItem.id)
        } else {
          // Fallback: old behavior without persistence (for dev/testing)
          const newItem = createItem({
            eventId,
            itemType: 'photo',
            content: dataUrl,
            caption: file.name.replace(/\.[^/.]+$/, ''),
            happenedAt: exifData.dateTaken,
            place: exifData.location ? {
              lat: exifData.location.lat,
              lng: exifData.location.lng,
              label: undefined
            } : undefined
          })
          upsertCanvasItem({
            eventId,
            itemId: newItem.id,
            x: position.x + offsetX,
            y: position.y,
            scale: 1,
            rotation: 0,
            zIndex: i,
          })
          console.warn('Item created without file persistence:', newItem.id)
        }

        offsetX += ITEM_SPACING
      } catch (err) {
        console.error('Failed to add dropped photo:', err)
      }
    }

    // Clear progress
    setUploadProgress(null)

    // Refresh events to trigger view rebuild
    const allEvents = getAllEvents()
    setEvents(allEvents.filter(e => e.type !== 'year'))
    console.log('handleDropPhotos complete. Total events:', allEvents.length)

    // Rebuild the canvas view to show new items with all interactive elements
    timelineRef.current?.rebuildView()
  }, [])

  // Migrate existing base64 photos to file storage
  const migrateToFileStorage = useCallback(async () => {
    if (!hasStorageFolder()) {
      alert('Selecteer eerst een opslagmap via "Kies map"')
      return
    }

    const allItems = getAllItems()
    const itemsToMigrate = allItems.filter(item =>
      (item.itemType === 'photo' || item.itemType === 'video') &&
      item.content &&
      item.content.startsWith('data:')
    )

    if (itemsToMigrate.length === 0) {
      alert('Geen foto\'s gevonden om te migreren. Alles is al gemigreerd of er zijn geen foto\'s.')
      return
    }

    const confirmMigrate = confirm(`${itemsToMigrate.length} foto('s) gevonden. Wil je deze verplaatsen naar de bestandsopslag?`)
    if (!confirmMigrate) return

    setMigrationProgress({ current: 0, total: itemsToMigrate.length, status: 'Starting...' })

    let migrated = 0
    let failed = 0

    for (let i = 0; i < itemsToMigrate.length; i++) {
      const item = itemsToMigrate[i]

      try {
        setMigrationProgress({
          current: i + 1,
          total: itemsToMigrate.length,
          status: `Migreren: ${item.caption || item.id.substring(0, 8)}...`
        })

        // Get event info for folder structure
        const event = getEventById(item.eventId)
        if (!event) {
          console.warn('Event not found for item:', item.id)
          failed++
          continue
        }

        // Determine folder path
        const eventYear = event.startAt?.substring(0, 4) || new Date().getFullYear().toString()
        const eventTitle = event.title || `Event ${event.id.substring(0, 8)}`
        const folderPath = [eventYear, eventTitle]

        // Generate filename
        const ext = item.content.includes('image/png') ? 'png' :
                    item.content.includes('image/gif') ? 'gif' :
                    item.content.includes('image/webp') ? 'webp' : 'jpg'
        const baseName = item.caption?.substring(0, 50) || 'photo'
        const fileName = `${baseName}_${item.id.substring(0, 8)}.${ext}`

        // Save to file
        const saved = await writeImageFromDataURL(folderPath, fileName, item.content)

        if (saved) {
          // Update database with file reference
          const fileRef = `file:${folderPath.join('/')}/${fileName}`
          updateItemContent(item.id, fileRef)
          migrated++
          console.log('Migrated:', item.id, '->', fileRef)
        } else {
          failed++
          console.error('Failed to save file for item:', item.id)
        }

        // Small delay to prevent UI freezing
        await new Promise(resolve => setTimeout(resolve, 50))

      } catch (err) {
        console.error('Migration error for item:', item.id, err)
        failed++
      }
    }

    setMigrationProgress(null)

    // Rebuild view to show migrated items
    timelineRef.current?.rebuildView()

    alert(`Migratie voltooid!\n\n✓ ${migrated} foto('s) verplaatst\n${failed > 0 ? `✗ ${failed} mislukt` : ''}`)
  }, [])

  if (error) {
    return (
      <div style={styles.center}>
        <p style={{ color: '#ff6b6b' }}>{error}</p>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div style={styles.center}>
        <p>Loading...</p>
      </div>
    )
  }

  // Theme colors
  const theme = {
    bg: darkMode ? '#0a0a0f' : '#f5f5f5',
    headerBg: darkMode ? '#111118' : '#ffffff',
    text: darkMode ? '#fff' : '#1a1a1a',
    textMuted: darkMode ? '#888' : '#666',
    border: darkMode ? '#333' : '#e0e0e0',
    footerBg: darkMode ? 'rgba(17, 17, 24, 0.95)' : 'rgba(255, 255, 255, 0.95)',
  }

  return (
    <div style={{ ...styles.container, backgroundColor: theme.bg }}>
      <header style={{ ...styles.header, backgroundColor: theme.headerBg, borderBottomColor: theme.border }}>
        <h1
          style={{
            ...styles.title,
            color: theme.text,
            cursor: zoomLevel !== ZoomLevel.L0_Lifeline ? 'pointer' : 'default',
            opacity: zoomLevel !== ZoomLevel.L0_Lifeline ? 0.7 : 1,
            transition: 'opacity 0.15s',
          }}
          onClick={() => zoomLevel !== ZoomLevel.L0_Lifeline && handleGoHome()}
          onMouseEnter={(e) => {
            if (zoomLevel !== ZoomLevel.L0_Lifeline) {
              e.currentTarget.style.opacity = '1'
            }
          }}
          onMouseLeave={(e) => {
            if (zoomLevel !== ZoomLevel.L0_Lifeline) {
              e.currentTarget.style.opacity = '0.7'
            }
          }}
        >
          MemoryLane
        </h1>
      </header>


      {/* Migration progress */}
      {migrationProgress && (
        <div style={styles.uploadOverlay}>
          <div style={styles.uploadModal}>
            <div style={styles.uploadSpinner} />
            <div style={styles.uploadText}>
              Migreren ({migrationProgress.current}/{migrationProgress.total})
            </div>
            <div style={styles.uploadFileName}>{migrationProgress.status}</div>
            <div style={styles.uploadProgressBar}>
              <div
                style={{
                  ...styles.uploadProgressFill,
                  width: `${(migrationProgress.current / migrationProgress.total) * 100}%`
                }}
              />
            </div>
          </div>
        </div>
      )}

      {/* Indexing progress */}
      {indexingProgress && (
        <div style={styles.uploadOverlay}>
          <div style={styles.uploadModal}>
            <div style={styles.uploadSpinner} />
            <div style={styles.uploadText}>Index laden</div>
            <div style={styles.uploadFileName}>{indexingProgress.status}</div>
          </div>
        </div>
      )}

      {/* Breadcrumb bar - always reserve space to prevent canvas resize */}
      <div style={styles.breadcrumbBar}>
        <div style={styles.breadcrumbContent}>
          {breadcrumbs.length > 0 ? (
            <>
            {/* Year breadcrumb - clickable if not at L1 */}
            {breadcrumbs[0] && (
              <span
                style={{
                  ...styles.yearTitle,
                  cursor: breadcrumbs.length > 1 ? 'pointer' : 'default',
                  opacity: breadcrumbs.length > 1 ? 0.8 : 1,
                }}
                onClick={() => {
                  if (breadcrumbs.length > 1) {
                    handleBreadcrumbClick(breadcrumbs[0], 0)
                  }
                }}
                onMouseEnter={(e) => {
                  if (breadcrumbs.length > 1) {
                    e.currentTarget.style.opacity = '1'
                  }
                }}
                onMouseLeave={(e) => {
                  if (breadcrumbs.length > 1) {
                    e.currentTarget.style.opacity = '0.8'
                  }
                }}
              >
                {breadcrumbs[0].title}
              </span>
            )}
            {/* Event breadcrumbs - last one is not clickable */}
            {breadcrumbs.slice(1).map((item, index) => {
              const isLast = index === breadcrumbs.length - 2
              const isClickable = !isLast
              return (
                <span key={item.id} style={styles.breadcrumbPath}>
                  <span style={styles.breadcrumbSeparator}>/</span>
                  <span
                    style={{
                      ...styles.breadcrumbLink,
                      cursor: isClickable ? 'pointer' : 'default',
                      opacity: isClickable ? 0.8 : 1,
                    }}
                    onClick={() => {
                      if (isClickable) {
                        handleBreadcrumbClick(item, index + 1)
                      }
                    }}
                    onMouseEnter={(e) => {
                      if (isClickable) {
                        e.currentTarget.style.opacity = '1'
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (isClickable) {
                        e.currentTarget.style.opacity = '0.8'
                      }
                    }}
                  >
                    {item.title}
                  </span>
                  {/* Properties button for current event */}
                  {isLast && currentEventId && (
                    <button
                      style={styles.propertiesButton}
                      onClick={() => handleEditEventProperties(item.id)}
                      title="Event eigenschappen"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="12" cy="12" r="3" />
                        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                      </svg>
                    </button>
                  )}
                </span>
              )
            })}
          </>
        ) : (
          <span style={styles.yearTitle}>&nbsp;</span>
        )}
        </div>

        {/* Search & Profile buttons */}
        <div style={styles.headerActions}>
          <button
            style={styles.searchButton}
            onClick={() => setShowSearch(true)}
            title="Zoeken (Ctrl+K)"
          >
            <Search size={20} />
          </button>

          <div style={styles.profileContainer} ref={profileMenuRef}>
            <button
              style={styles.profileButton}
              onClick={() => setShowProfileMenu(!showProfileMenu)}
              title="Instellingen"
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
            </button>

          {/* Profile dropdown menu */}
          {showProfileMenu && (
            <div style={styles.profileMenu}>
              <div style={styles.profileMenuItem}>
                <div style={styles.profileMenuHeader}>Opslag</div>
                <div style={styles.profileMenuStatus}>
                  {storageConfigured ? (
                    <span style={styles.statusActive}>✓ Bestandsopslag actief</span>
                  ) : (
                    <span style={styles.statusInactive}>Niet geconfigureerd</span>
                  )}
                </div>
                <button
                  style={styles.profileMenuButton}
                  onClick={async () => {
                    const folder = await selectStorageFolder()
                    if (folder) {
                      setStorageConfigured(true)
                      setShowProfileMenu(false)

                      // Load data from the new folder
                      setIndexingProgress({ status: 'Loading database...' })
                      try {
                        const dbData = await readDatabaseFile()
                        if (dbData) {
                          await importDatabase(dbData)
                          if (needsFullRebuild()) {
                            setIndexingProgress({ status: 'Rebuilding index...' })
                            await rebuildFullIndex()
                          }
                        } else {
                          setIndexingProgress({ status: 'Building index from files...' })
                          await rebuildFullIndex()
                        }

                        // Refresh the UI with loaded data
                        const yearEvents = getEventsByType('year')
                        const allEvents = getAllEvents()
                        const yearsWithContent = yearEvents.filter(year =>
                          allEvents.some(e => e.parentId === year.id)
                        )
                        setYears(yearsWithContent)
                        setEvents(allEvents)
                        console.log('Loaded from new folder:', yearsWithContent.length, 'years,', allEvents.length, 'events')
                      } catch (err) {
                        console.error('Failed to load data:', err)
                        alert('Fout bij laden van data: ' + (err as Error).message)
                      }
                      setIndexingProgress(null)
                    }
                  }}
                >
                  {storageConfigured ? 'Wijzig opslaglocatie' : 'Kies opslaglocatie'}
                </button>
                {storageConfigured && (
                  <>
                    <button
                      style={styles.profileMenuButtonSecondary}
                      onClick={() => {
                        setShowProfileMenu(false)
                        migrateToFileStorage()
                      }}
                    >
                      Migreer bestaande foto's
                    </button>
                    <button
                      style={{...styles.profileMenuButtonSecondary, marginTop: '8px'}}
                      onClick={async () => {
                        setShowProfileMenu(false)
                        if (!confirm('Dit exporteert al je herinneringen naar markdown bestanden in je opslagmap. Doorgaan?')) {
                          return
                        }
                        setMigrationProgress({ current: 0, total: 100, status: 'Starting migration...' })
                        try {
                          const result = await migrateToFileBasedStorage((progress) => {
                            setMigrationProgress({
                              current: progress.current,
                              total: progress.total,
                              status: progress.status
                            })
                          })
                          alert(`Migratie voltooid!\n\n✓ ${result.eventsCreated} events\n✓ ${result.itemsMigrated} items\n✓ ${result.mediaFilesCopied} media bestanden\n${result.errors.length > 0 ? `✗ ${result.errors.length} fouten` : ''}`)
                          // Refresh data
                          await rebuildFullIndex()
                          const yearEvents = getEventsByType('year')
                          const allEvents = getAllEvents()
                          const yearsWithContent = yearEvents.filter(year =>
                            allEvents.some(e => e.parentId === year.id)
                          )
                          setYears(yearsWithContent)
                          setEvents(allEvents.filter(e => e.type !== 'year'))
                        } catch (err) {
                          console.error('Migration failed:', err)
                          alert('Migratie mislukt: ' + (err as Error).message)
                        }
                        setMigrationProgress(null)
                      }}
                    >
                      Exporteer naar bestanden
                    </button>
                    <button
                      style={{...styles.profileMenuButtonSecondary, marginTop: '8px'}}
                      onClick={async () => {
                        setShowProfileMenu(false)
                        setIndexingProgress({ status: 'Herbouwen van index...' })
                        try {
                          await rebuildFullIndex()
                          // Refresh data
                          const yearEvents = getEventsByType('year')
                          const allEvents = getAllEvents()
                          const yearsWithContent = yearEvents.filter(year =>
                            allEvents.some(e => e.parentId === year.id)
                          )
                          setYears(yearsWithContent)
                          setEvents(allEvents.filter(e => e.type !== 'year'))
                        } catch (err) {
                          console.error('Failed to rebuild index:', err)
                          alert('Index herbouwen mislukt: ' + (err as Error).message)
                        }
                        setIndexingProgress(null)
                      }}
                    >
                      Herbouw index
                    </button>
                    <button
                      style={{...styles.profileMenuButtonSecondary, marginTop: '8px', backgroundColor: '#10b981'}}
                      onClick={async () => {
                        setShowProfileMenu(false)
                        setIndexingProgress({ status: 'Herstellen van foto\'s...' })
                        try {
                          const result = await recoverFromPhotos()
                          // Refresh data
                          const yearEvents = getEventsByType('year')
                          const allEvents = getAllEvents()
                          const yearsWithContent = yearEvents.filter(year =>
                            allEvents.some(e => e.parentId === year.id)
                          )
                          setYears(yearsWithContent)
                          setEvents(allEvents.filter(e => e.type !== 'year'))
                          alert(`Herstel voltooid!\n\nEvents aangemaakt: ${result.eventsCreated}\nItems aangemaakt: ${result.itemsCreated}${result.errors.length > 0 ? '\n\nFouten: ' + result.errors.join(', ') : ''}`)
                        } catch (err) {
                          console.error('Failed to recover:', err)
                          alert('Herstel mislukt: ' + (err as Error).message)
                        }
                        setIndexingProgress(null)
                      }}
                    >
                      Herstel van foto's
                    </button>
                  </>
                )}
              </div>

              <div style={styles.profileMenuDivider} />

              <div style={styles.profileMenuItem}>
                <div style={styles.profileMenuHeader}>Thema</div>
                <button
                  style={styles.themeToggle}
                  onClick={toggleDarkMode}
                >
                  <span style={styles.themeToggleIcon}>{darkMode ? '🌙' : '☀️'}</span>
                  <span>{darkMode ? 'Donker' : 'Licht'}</span>
                  <span style={{
                    ...styles.themeToggleSwitch,
                    backgroundColor: darkMode ? '#3b82f6' : '#9ca3af',
                  }}>
                    <span style={{
                      ...styles.themeToggleDot,
                      transform: darkMode ? 'translateX(16px)' : 'translateX(2px)',
                    }} />
                  </span>
                </button>
              </div>

              <div style={styles.profileMenuDivider} />

              <div style={styles.profileMenuItem}>
                <div style={styles.profileMenuHeader}>Over</div>
                <div style={styles.profileMenuVersion}>MemoryLane v0.1</div>
              </div>
            </div>
          )}
          </div>
        </div>
      </div>

      <main style={styles.main}>
        <Timeline
          ref={timelineRef}
          years={years}
          events={events}
          onEventSelect={handleEventSelect}
          onZoomLevelChange={handleZoomLevelChange}
          onAddClick={() => quickAddRef.current?.open()}
          onDeleteItem={handleDeleteItemRequest}
          onEditItem={handleEditItemRequest}
          onDropPhotos={handleDropPhotos}
          onViewPhoto={handleViewPhoto}
        />
      </main>
      <footer style={{ ...styles.footer, backgroundColor: theme.footerBg, color: theme.textMuted }}>
        <span>
          {zoomLevel === ZoomLevel.L0_Lifeline
            ? 'Scroll to pan | Ctrl+Scroll to zoom | Click year to explore'
            : zoomLevel === ZoomLevel.L1_Year
            ? 'Click event to open | Press Escape or click MemoryLane to go back'
            : zoomLevel === ZoomLevel.L2_Canvas
            ? 'Drag to rearrange | Click to view | Press Escape to go back'
            : 'Press Escape to close'}
        </span>
      </footer>

      {/* Quick Add FAB */}
      <QuickAdd
        ref={quickAddRef}
        currentYearId={currentYearId}
        currentEventId={currentEventId}
        currentEventDate={
          currentEventId
            ? events.find(e => e.id === currentEventId)?.startAt?.split('T')[0]
            : undefined
        }
        onMemoryAdded={handleMemoryAdded}
      />

      {/* Canvas control buttons - only visible in L2 Canvas view */}
      {zoomLevel === ZoomLevel.L2_Canvas && (
        <div style={{
          position: 'fixed',
          bottom: 80,
          left: 20,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          zIndex: 100,
        }}>
          <button
            onClick={() => timelineRef.current?.fitToView()}
            style={{
              width: 44,
              height: 44,
              borderRadius: 22,
              backgroundColor: '#3d5a80',
              border: 'none',
              color: 'white',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
              fontSize: 18,
            }}
            title="Fit all items in view"
          >
            ⊞
          </button>
          <button
            onClick={() => timelineRef.current?.arrangeItems()}
            style={{
              width: 44,
              height: 44,
              borderRadius: 22,
              backgroundColor: '#5d7aa0',
              border: 'none',
              color: 'white',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
              fontSize: 18,
            }}
            title="Collage / Restore layout"
          >
            ⊟
          </button>
        </div>
      )}

      {/* Upload Progress Overlay */}
      {uploadProgress && (
        <div style={styles.uploadOverlay}>
          <div style={styles.uploadModal}>
            <div style={styles.uploadSpinner} />
            <div style={styles.uploadText}>
              {uploadProgress.total > 1
                ? `Uploading ${uploadProgress.current} / ${uploadProgress.total}`
                : 'Uploading...'}
            </div>
            <div style={styles.uploadFileName}>{uploadProgress.fileName}</div>
            {uploadProgress.total > 1 && (
              <div style={styles.uploadProgressBar}>
                <div
                  style={{
                    ...styles.uploadProgressFill,
                    width: `${(uploadProgress.current / uploadProgress.total) * 100}%`
                  }}
                />
              </div>
            )}
          </div>
        </div>
      )}

      {/* Delete Confirmation Dialog */}
      <ConfirmDialog
        isOpen={itemToDelete !== null}
        title="Herinnering verwijderen?"
        message={`Weet je zeker dat je deze ${itemToDelete?.itemType === 'photo' ? 'foto' : itemToDelete?.itemType === 'video' ? 'video' : itemToDelete?.itemType === 'text' ? 'tekst' : 'link'} wilt verwijderen? Dit kan niet ongedaan worden gemaakt.`}
        confirmLabel="Verwijderen"
        cancelLabel="Annuleren"
        danger={true}
        onConfirm={handleConfirmDelete}
        onCancel={handleCancelDelete}
      />

      {/* Edit Memory Dialog */}
      <EditMemoryDialog
        item={itemToEdit}
        parentEvent={eventToEdit}
        isOpen={itemToEdit !== null && eventToEdit !== null}
        onSave={handleSaveEdit}
        onCancel={handleCancelEdit}
      />

      {/* Event Properties Dialog */}
      <EventPropertiesDialog
        event={eventToEditProperties}
        photoItems={eventPhotoItems}
        isOpen={eventToEditProperties !== null}
        onSave={handleSaveEventProperties}
        onCancel={handleCancelEventProperties}
      />

      {/* Photo Viewer */}
      {viewingPhoto && (
        <PhotoViewer
          item={viewingPhoto.item}
          allItems={viewingPhotoItems}
          eventTitle={events.find(e => e.id === viewingPhoto.eventId)?.title || ''}
          eventStartDate={events.find(e => e.id === viewingPhoto.eventId)?.startAt}
          onClose={handleClosePhotoViewer}
          onDelete={handlePhotoDelete}
          onSave={handlePhotoSave}
          onNavigate={handlePhotoNavigate}
        />
      )}

      {/* Search Modal */}
      <SearchModal
        isOpen={showSearch}
        onClose={() => setShowSearch(false)}
        onSelectResult={handleSearchResult}
      />
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    width: '100%',
  },
  center: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    width: '100%',
  },
  header: {
    padding: '12px 24px',
    borderBottom: '1px solid #222',
    display: 'flex',
    alignItems: 'center',
  },
  title: {
    fontSize: '18px',
    fontWeight: 600,
    margin: 0,
    color: '#888',
  },
  storageBanner: {
    display: 'flex',
    alignItems: 'center',
    gap: '16px',
    padding: '12px 24px',
    backgroundColor: '#1a2a3a',
    borderBottom: '1px solid #2a3a4a',
  },
  storageBannerText: {
    flex: 1,
    color: '#8ab4d8',
    fontSize: '14px',
  },
  storageBannerButton: {
    padding: '8px 16px',
    backgroundColor: '#3a7ca5',
    color: '#fff',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '14px',
    fontWeight: 500,
  },
  storageBannerDismiss: {
    padding: '8px 12px',
    backgroundColor: 'transparent',
    color: '#666',
    border: '1px solid #333',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '14px',
  },
  breadcrumbBar: {
    padding: '16px 24px 20px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  breadcrumbContent: {
    display: 'flex',
    alignItems: 'baseline',
    gap: '12px',
  },
  headerActions: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  searchButton: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '40px',
    height: '40px',
    borderRadius: '50%',
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    border: 'none',
    color: '#888',
    cursor: 'pointer',
    transition: 'all 0.2s',
  },
  profileContainer: {
    position: 'relative',
  },
  profileButton: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '40px',
    height: '40px',
    borderRadius: '50%',
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    border: 'none',
    color: '#888',
    cursor: 'pointer',
    transition: 'all 0.2s',
  },
  profileMenu: {
    position: 'absolute',
    top: '48px',
    right: '0',
    minWidth: '250px',
    backgroundColor: 'rgba(30, 30, 40, 0.98)',
    borderRadius: '12px',
    border: '1px solid #333',
    boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
    zIndex: 1000,
    overflow: 'hidden',
  },
  profileMenuItem: {
    padding: '16px',
  },
  profileMenuHeader: {
    fontSize: '12px',
    fontWeight: 600,
    color: '#666',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
    marginBottom: '8px',
  },
  profileMenuStatus: {
    marginBottom: '12px',
  },
  statusActive: {
    color: '#3d8060',
    fontSize: '14px',
  },
  statusInactive: {
    color: '#888',
    fontSize: '14px',
  },
  profileMenuButton: {
    display: 'block',
    width: '100%',
    padding: '10px 16px',
    backgroundColor: '#3d8060',
    border: 'none',
    borderRadius: '8px',
    color: '#fff',
    fontSize: '14px',
    fontWeight: 500,
    cursor: 'pointer',
    marginBottom: '8px',
    transition: 'background-color 0.2s',
  },
  profileMenuButtonSecondary: {
    display: 'block',
    width: '100%',
    padding: '10px 16px',
    backgroundColor: 'transparent',
    border: '1px solid #444',
    borderRadius: '8px',
    color: '#888',
    fontSize: '14px',
    cursor: 'pointer',
    transition: 'all 0.2s',
  },
  profileMenuDivider: {
    height: '1px',
    backgroundColor: '#333',
  },
  profileMenuVersion: {
    fontSize: '14px',
    color: '#666',
  },
  themeToggle: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    width: '100%',
    padding: '10px 0',
    background: 'none',
    border: 'none',
    color: '#ccc',
    fontSize: '14px',
    cursor: 'pointer',
    textAlign: 'left' as const,
  },
  themeToggleIcon: {
    fontSize: '16px',
  },
  themeToggleSwitch: {
    marginLeft: 'auto',
    width: '36px',
    height: '20px',
    borderRadius: '10px',
    position: 'relative' as const,
    transition: 'background-color 0.2s',
  },
  themeToggleDot: {
    position: 'absolute' as const,
    top: '2px',
    width: '16px',
    height: '16px',
    borderRadius: '50%',
    backgroundColor: '#fff',
    transition: 'transform 0.2s',
  },
  yearTitle: {
    fontSize: '32px',
    fontWeight: 700,
    color: '#fff',
  },
  breadcrumbPath: {
    display: 'flex',
    alignItems: 'baseline',
    gap: '12px',
  },
  breadcrumbSeparator: {
    color: '#444',
    fontSize: '20px',
  },
  breadcrumbLink: {
    fontSize: '20px',
    fontWeight: 500,
    color: '#888',
  },
  propertiesButton: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    padding: 6,
    marginLeft: 8,
    color: '#666',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 4,
    transition: 'color 0.15s, background-color 0.15s',
  },
  main: {
    flex: 1,
    overflow: 'hidden',
  },
  footer: {
    padding: '8px 24px',
    borderTop: '1px solid #222',
    fontSize: '12px',
    color: '#666',
  },
  uploadOverlay: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 2000,
  },
  uploadModal: {
    backgroundColor: '#1a1a2e',
    borderRadius: 16,
    padding: '32px 48px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 16,
    minWidth: 280,
  },
  uploadSpinner: {
    width: 48,
    height: 48,
    border: '3px solid #333',
    borderTopColor: '#5d7aa0',
    borderRadius: '50%',
    animation: 'spin 1s linear infinite',
  },
  uploadText: {
    fontSize: 18,
    fontWeight: 500,
    color: '#fff',
  },
  uploadFileName: {
    fontSize: 14,
    color: '#888',
    maxWidth: 300,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  uploadProgressBar: {
    width: '100%',
    height: 6,
    backgroundColor: '#333',
    borderRadius: 3,
    overflow: 'hidden',
    marginTop: 8,
  },
  uploadProgressFill: {
    height: '100%',
    backgroundColor: '#5d7aa0',
    borderRadius: 3,
    transition: 'width 0.3s ease',
  },
}
