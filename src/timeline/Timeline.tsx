import { useEffect, useRef, useCallback, forwardRef, useImperativeHandle, useState } from 'react'
import { Application, Container, Graphics, Text, TextStyle, Sprite, Texture } from 'pixi.js'
import { Event, ZoomLevel, ViewState, Item, CanvasItem, ItemType } from '../models/types'
import { getItemsByEvent, getCanvasItems, upsertCanvasItem, getMemoriesForYear, getEventClustersForYear, getItemById } from '../db/database'
import { updateCanvasItemWithFiles, saveCanvasLayout } from '../db/sync/writer'
import { hasStorageFolder, readFileAsBlob } from '../db/fileStorage'
import { getThumbnail, type ThumbnailSize } from '../db/thumbnailCache'
import { ViewportCullingManager, calculateViewportBounds } from './viewportCulling'

// Ref type for external navigation control
export interface TimelineRef {
  navigateToLevel: (level: ZoomLevel, eventId?: string) => void
  fitToView: () => void  // Scale canvas to show all items
  arrangeItems: () => void  // Toggle between arranged and scattered positions
  rebuildView: () => void  // Rebuild current view (e.g. after adding items via drag&drop)
  getViewportCenter: () => { x: number; y: number } | null  // Get center of current viewport in canvas coordinates
}

// Layout constants
const YEAR_WIDTH = 200
const YEAR_HEIGHT = 80
const YEAR_GAP = 20

// L1 Density View constants
const L1_YEAR_TIMELINE_WIDTH = 3000      // Full year width at scale 1.0
const L1_DENSITY_BAR_HEIGHT = 60         // Height of the density bar
const L1_MONTH_LABEL_HEIGHT = 24         // Height of month label row

// L1 Continuous zoom constants
const L1_MIN_SCALE = 0.5                 // Whole year visible
const L1_MAX_SCALE = 4.0                 // Zoomed in for more detail
const L1_SLICE_MIN_WIDTH = 4             // Minimum slice width
const L1_SLICE_MAX_WIDTH = 24            // Maximum slice width when zoomed in

// L1 Item type colors for density bar
const ITEM_TYPE_COLORS: Record<ItemType, number> = {
  photo: 0x4CAF50,   // Green
  text: 0x9C27B0,    // Purple
  video: 0xFF9800,   // Orange
  link: 0x2196F3,    // Blue
  audio: 0xE91E63,   // Pink
}

// L2 Canvas constants
const CANVAS_ITEM_WIDTH = 200
const CANVAS_ITEM_HEIGHT = 150

// Physics constants
const FRICTION = 0.92
const MIN_VELOCITY = 0.1
const DRAG_THRESHOLD = 5
const ELASTIC_FACTOR = 0.15  // How much resistance when dragging past bounds
const BOUNCE_BACK_SPEED = 0.12  // How fast it bounces back

// Transition timing
const TRANSITION_SPEED = 0.08 // Lower = slower, smoother
const ZOOM_IN_SCALE = 2.5 // How much to zoom in during enter transition
const ZOOM_OUT_SCALE = 1.3 // How much to zoom out from during exit transition

// Text resolution for sharp scaling
const TEXT_RESOLUTION = 3

interface DropPosition {
  x: number
  y: number
}

interface TimelineProps {
  years: Event[]
  events?: Event[]
  onEventSelect?: (event: Event, level: ZoomLevel) => void
  onZoomLevelChange?: (level: ZoomLevel) => void
  onAddClick?: () => void  // Called when empty state + is clicked
  onDeleteItem?: (item: Item) => void  // Called when delete button is clicked
  onEditItem?: (item: Item) => void  // Called when edit button is clicked
  onDropPhotos?: (files: File[], position: DropPosition, eventId: string) => void  // Called when photos are dropped on canvas
  onViewPhoto?: (item: Item, eventId: string) => void  // Called when photo is clicked to open viewer
}

// Container state for transitions
interface ContainerState {
  container: Container
  alpha: number
  targetAlpha: number
  scale: number
  targetScale: number
  x: number
  targetX: number
  y: number
  targetY: number
  zoomLevel: ZoomLevel
  focusedEventId?: string
}

export const Timeline = forwardRef<TimelineRef, TimelineProps>(function Timeline(
  { years, events = [], onEventSelect, onZoomLevelChange, onAddClick, onDeleteItem, onEditItem, onDropPhotos, onViewPhoto },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const appRef = useRef<Application | null>(null)
  const initializingRef = useRef(false)

  // Two containers for cross-fade transitions
  const containerARef = useRef<ContainerState | null>(null)
  const containerBRef = useRef<ContainerState | null>(null)
  const activeContainerRef = useRef<'A' | 'B'>('A')

  // Transition state
  const isTransitioningRef = useRef(false)
  const transitionCallbackRef = useRef<(() => void) | null>(null)

  // View state for the ACTIVE container (used for pan/zoom interaction)
  const viewStateRef = useRef<ViewState>({
    zoomLevel: ZoomLevel.L0_Lifeline,
    centerX: 0,
    centerY: 0,
    scale: 1,
  })

  // Pan/drag state
  const velocityRef = useRef({ x: 0, y: 0 })
  const isDraggingRef = useRef(false)
  const isPotentialDragRef = useRef(false)
  const lastPointerRef = useRef({ x: 0, y: 0 })
  const pointerDownPosRef = useRef({ x: 0, y: 0 })
  const pointerIdRef = useRef<number | null>(null)

  // Current focused year for L1 view
  const focusedYearRef = useRef<Event | null>(null)
  const focusedYearPosRef = useRef<number>(0)

  // Current focused event for L2 view
  const focusedEventRef = useRef<Event | null>(null)
  const focusedEventPosRef = useRef<number>(0)

  // Current focused item for L3 view
  const focusedItemRef = useRef<Item | null>(null)

  // Track if we're dragging a canvas item (to prevent canvas pan)
  const isDraggingItemRef = useRef(false)

  // L1 internal zoom state (for continuous zoom within L1)
  const l1InternalScaleRef = useRef(1.0)
  const l1RebuildTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Content bounds for elastic scrolling (half-width from center)
  const contentBoundsRef = useRef({ minX: -500, maxX: 500 })

  // Refs for data (to avoid stale closures)
  const yearsRef = useRef(years)
  const eventsRef = useRef(events)
  yearsRef.current = years
  eventsRef.current = events

  // Handler refs to avoid circular dependencies
  const handleYearClickRef = useRef<((year: Event, yearCenterX: number) => void) | null>(null)
  const handleEventClickRef = useRef<((event: Event, eventCenterX: number) => void) | null>(null)
  const handleItemClickRef = useRef<((item: Item) => void) | null>(null)
  const handleAddClickRef = useRef<(() => void) | null>(null)
  const handleDeleteItemRef = useRef<((item: Item) => void) | null>(null)
  const handleEditItemRef = useRef<((item: Item) => void) | null>(null)

  // Viewport culling for L2 canvas
  const cullingManagerRef = useRef<ViewportCullingManager | null>(null)
  const itemDataRef = useRef<Map<string, { item: Item; canvasItem: CanvasItem | null; textScale?: number }>>(new Map())

  // Get the active container state
  const getActiveState = useCallback((): ContainerState | null => {
    return activeContainerRef.current === 'A' ? containerARef.current : containerBRef.current
  }, [])

  // Get the inactive container state
  const getInactiveState = useCallback((): ContainerState | null => {
    return activeContainerRef.current === 'A' ? containerBRef.current : containerARef.current
  }, [])

  // Build view content into a container
  const buildViewContent = useCallback((
    state: ContainerState,
    level: ZoomLevel,
    focusedYear: Event | null,
    focusedEvent: Event | null,
    focusedItem: Item | null = null
  ) => {
    state.container.removeChildren()
    state.zoomLevel = level

    if (level === ZoomLevel.L0_Lifeline) {
      const bounds = buildL0View(state.container, yearsRef.current, (year, centerX) => {
        handleYearClickRef.current?.(year, centerX)
      })
      contentBoundsRef.current = bounds
    } else if (level === ZoomLevel.L1_Year && focusedYear) {
      const childEvents = eventsRef.current.filter(e => e.parentId === focusedYear.id)
      // Reset L1 internal scale when entering L1
      l1InternalScaleRef.current = 1.0
      const bounds = buildL1View(state.container, focusedYear, childEvents, 1.0, (event, centerX) => {
        handleEventClickRef.current?.(event, centerX)
      })
      contentBoundsRef.current = bounds
      state.focusedEventId = focusedYear.id
    } else if (level === ZoomLevel.L2_Canvas && focusedEvent) {
      // Set up culling manager for viewport culling
      const createItemBlockById = (id: string): Container | null => {
        const data = itemDataRef.current.get(id)
        if (!data) return null
        return createCanvasItemBlock(
          data.item,
          focusedEvent.id,
          isDraggingItemRef,
          (item) => handleItemClickRef.current?.(item),
          (item) => handleDeleteItemRef.current?.(item),
          (item) => handleEditItemRef.current?.(item),
          data.textScale,
          data.canvasItem?.scale ?? 1,
          data.canvasItem?.zIndex ?? 0,
          data.canvasItem?.width ?? CANVAS_ITEM_WIDTH,
          data.canvasItem?.height ?? CANVAS_ITEM_HEIGHT
        )
      }

      cullingManagerRef.current = new ViewportCullingManager(state.container, createItemBlockById)

      buildL2View(state.container, focusedEvent, isDraggingItemRef, (item) => {
        handleItemClickRef.current?.(item)
      }, () => {
        handleAddClickRef.current?.()
      }, (item) => {
        handleDeleteItemRef.current?.(item)
      }, (item) => {
        handleEditItemRef.current?.(item)
      }, cullingManagerRef.current, itemDataRef.current)

      // Trigger initial viewport update to render visible items
      if (appRef.current && cullingManagerRef.current) {
        const app = appRef.current
        const viewport = calculateViewportBounds(
          state.x,
          state.y,
          state.scale,
          app.screen.width,
          app.screen.height
        )
        cullingManagerRef.current.update(viewport)
      }
      state.focusedEventId = focusedEvent.id
    } else if (level === ZoomLevel.L3_Focus && focusedItem && focusedEvent) {
      buildL3View(state.container, focusedItem, focusedEvent)
      state.focusedEventId = focusedEvent.id
    }
  }, [])

  // Start a cross-fade transition
  const startTransition = useCallback((
    direction: 'enter' | 'exit',
    targetLevel: ZoomLevel,
    targetYear: Event | null,
    targetEvent: Event | null,
    targetItem: Item | null,
    localX: number, // Local X position of clicked item (in container coordinates)
    onComplete?: () => void
  ) => {
    const activeState = getActiveState()
    const inactiveState = getInactiveState()
    if (!activeState || !inactiveState || !appRef.current) return

    isTransitioningRef.current = true
    const screenCenterX = appRef.current.screen.width / 2
    const screenCenterY = appRef.current.screen.height / 2

    if (direction === 'enter') {
      // === ENTERING A DEEPER LEVEL ===
      // Outgoing: zoom in with clicked item staying at its screen position, then fade out
      const currentScreenPos = activeState.x + localX * activeState.scale
      activeState.targetAlpha = 0
      activeState.targetScale = ZOOM_IN_SCALE
      activeState.targetX = currentScreenPos - localX * ZOOM_IN_SCALE
      activeState.targetY = screenCenterY

      // Incoming: start small and centered, zoom in to normal, fade in
      if (targetLevel === ZoomLevel.L1_Year && targetYear) {
        buildViewContent(inactiveState, ZoomLevel.L1_Year, targetYear, null)
        inactiveState.zoomLevel = ZoomLevel.L1_Year
        inactiveState.focusedEventId = targetYear.id
        focusedYearRef.current = targetYear
      } else if (targetLevel === ZoomLevel.L2_Canvas && targetEvent) {
        buildViewContent(inactiveState, ZoomLevel.L2_Canvas, null, targetEvent)
        inactiveState.zoomLevel = ZoomLevel.L2_Canvas
        inactiveState.focusedEventId = targetEvent.id
      } else if (targetLevel === ZoomLevel.L3_Focus && targetItem && focusedEventRef.current) {
        buildViewContent(inactiveState, ZoomLevel.L3_Focus, null, focusedEventRef.current, targetItem)
        inactiveState.zoomLevel = ZoomLevel.L3_Focus
        inactiveState.focusedEventId = focusedEventRef.current.id
        focusedItemRef.current = targetItem
      }

      inactiveState.alpha = 0
      inactiveState.targetAlpha = 1
      inactiveState.scale = 0.5 // Start small
      inactiveState.targetScale = 1
      inactiveState.x = screenCenterX
      inactiveState.targetX = screenCenterX
      inactiveState.y = screenCenterY
      inactiveState.targetY = screenCenterY

    } else {
      // === EXITING BACK TO PREVIOUS LEVEL ===
      // Outgoing: zoom out, fade out
      activeState.targetAlpha = 0
      activeState.targetScale = 0.5 // Zoom out
      activeState.targetX = screenCenterX
      activeState.targetY = screenCenterY

      // Incoming: start zoomed in with item centered, zoom out to normal, fade in
      if (targetLevel === ZoomLevel.L0_Lifeline) {
        buildViewContent(inactiveState, ZoomLevel.L0_Lifeline, null, null)
        inactiveState.zoomLevel = ZoomLevel.L0_Lifeline
        inactiveState.focusedEventId = undefined
        inactiveState.x = screenCenterX - focusedYearPosRef.current * ZOOM_OUT_SCALE
        inactiveState.targetX = screenCenterX - focusedYearPosRef.current
        focusedYearRef.current = null
      } else if (targetLevel === ZoomLevel.L1_Year && focusedYearRef.current) {
        buildViewContent(inactiveState, ZoomLevel.L1_Year, focusedYearRef.current, null)
        inactiveState.zoomLevel = ZoomLevel.L1_Year
        inactiveState.focusedEventId = focusedYearRef.current.id
        inactiveState.x = screenCenterX - focusedEventPosRef.current * ZOOM_OUT_SCALE
        inactiveState.targetX = screenCenterX - focusedEventPosRef.current
        focusedEventRef.current = null
      } else if (targetLevel === ZoomLevel.L2_Canvas && focusedEventRef.current) {
        buildViewContent(inactiveState, ZoomLevel.L2_Canvas, null, focusedEventRef.current)
        inactiveState.zoomLevel = ZoomLevel.L2_Canvas
        inactiveState.focusedEventId = focusedEventRef.current.id
        inactiveState.x = screenCenterX
        inactiveState.targetX = screenCenterX
        focusedItemRef.current = null
      }

      inactiveState.alpha = 0
      inactiveState.targetAlpha = 1
      inactiveState.scale = ZOOM_OUT_SCALE // Start zoomed in
      inactiveState.targetScale = 1
      inactiveState.y = screenCenterY
      inactiveState.targetY = screenCenterY
    }

    transitionCallbackRef.current = () => {
      // Swap active container
      activeContainerRef.current = activeContainerRef.current === 'A' ? 'B' : 'A'

      // Clear the now-inactive container
      const oldState = getInactiveState()
      if (oldState) {
        oldState.container.removeChildren()
        oldState.alpha = 0
        oldState.container.alpha = 0
      }

      // Update view state to match new active container
      const newActiveState = getActiveState()
      if (newActiveState) {
        viewStateRef.current.zoomLevel = newActiveState.zoomLevel
        viewStateRef.current.focusedEventId = newActiveState.focusedEventId
        viewStateRef.current.scale = newActiveState.scale
        viewStateRef.current.centerX = newActiveState.x - (appRef.current?.screen.width || 0) / 2
        viewStateRef.current.centerY = newActiveState.y - (appRef.current?.screen.height || 0) / 2
      }

      isTransitioningRef.current = false
      onComplete?.()
    }
  }, [getActiveState, getInactiveState, buildViewContent])

  // Handle year click - start enter transition to L1
  const handleYearClick = useCallback((year: Event, yearCenterX: number) => {
    if (isTransitioningRef.current) return

    const activeState = getActiveState()
    if (!activeState || !appRef.current) return

    // Store for back navigation (local position)
    focusedYearPosRef.current = yearCenterX

    startTransition('enter', ZoomLevel.L1_Year, year, null, null, yearCenterX, () => {
      onEventSelect?.(year, ZoomLevel.L1_Year)
      onZoomLevelChange?.(ZoomLevel.L1_Year)
    })
  }, [getActiveState, startTransition, onEventSelect, onZoomLevelChange])

  // Handle event click - start enter transition to L2
  const handleEventClick = useCallback((event: Event, eventCenterX: number) => {
    if (isTransitioningRef.current) return

    const activeState = getActiveState()
    if (!activeState || !appRef.current) return

    // Store for back navigation (local position)
    focusedEventPosRef.current = eventCenterX
    focusedEventRef.current = event

    startTransition('enter', ZoomLevel.L2_Canvas, null, event, null, eventCenterX, () => {
      onEventSelect?.(event, ZoomLevel.L2_Canvas)
      onZoomLevelChange?.(ZoomLevel.L2_Canvas)
    })
  }, [getActiveState, startTransition, onEventSelect, onZoomLevelChange])

  // Handle item click - open viewer/editor based on type
  const handleItemClick = useCallback((item: Item) => {
    if (isTransitioningRef.current) return
    if (!focusedEventRef.current) return

    // For photo/video items, open the photo viewer overlay
    if (item.itemType === 'photo' || item.itemType === 'video') {
      onViewPhoto?.(item, focusedEventRef.current.id)
    } else if (item.itemType === 'text' || item.itemType === 'link' || item.itemType === 'audio') {
      // For text/link/audio items, open the edit dialog
      onEditItem?.(item)
    }
  }, [onViewPhoto, onEditItem])

  // Update handler refs
  handleYearClickRef.current = handleYearClick
  handleEventClickRef.current = handleEventClick
  handleItemClickRef.current = handleItemClick
  handleAddClickRef.current = onAddClick || null
  handleDeleteItemRef.current = onDeleteItem || null
  handleEditItemRef.current = onEditItem || null

  // Navigate to level (exposed via ref)
  const navigateToLevel = useCallback((level: ZoomLevel, eventId?: string) => {
    if (isTransitioningRef.current) return

    const currentLevel = viewStateRef.current.zoomLevel

    // Direct navigation to an event (from search or external)
    if (level === ZoomLevel.L2_Canvas && eventId) {
      const targetEvent = events.find(e => e.id === eventId)
      if (!targetEvent) {
        console.warn('Event not found for navigation:', eventId)
        return
      }

      // Store for view management
      focusedEventRef.current = targetEvent
      focusedEventPosRef.current = 0  // Center position

      // Start enter transition to the event canvas
      startTransition('enter', ZoomLevel.L2_Canvas, null, targetEvent, null, 0, () => {
        onEventSelect?.(targetEvent, ZoomLevel.L2_Canvas)
        onZoomLevelChange?.(ZoomLevel.L2_Canvas)
      })
      return
    }

    // Normal back navigation
    if (level === ZoomLevel.L0_Lifeline && currentLevel !== ZoomLevel.L0_Lifeline) {
      startTransition('exit', ZoomLevel.L0_Lifeline, null, null, null, 0, () => {
        onZoomLevelChange?.(ZoomLevel.L0_Lifeline)
      })
    } else if (level === ZoomLevel.L1_Year && currentLevel === ZoomLevel.L2_Canvas) {
      startTransition('exit', ZoomLevel.L1_Year, null, null, null, 0, () => {
        onZoomLevelChange?.(ZoomLevel.L1_Year)
      })
    } else if (level === ZoomLevel.L2_Canvas && currentLevel === ZoomLevel.L3_Focus) {
      startTransition('exit', ZoomLevel.L2_Canvas, null, null, null, 0, () => {
        onZoomLevelChange?.(ZoomLevel.L2_Canvas)
      })
    }
  }, [events, startTransition, onEventSelect, onZoomLevelChange])

  // Fit canvas to show all items
  const fitToView = useCallback(() => {
    const activeState = getActiveState()
    if (!activeState || activeState.zoomLevel !== ZoomLevel.L2_Canvas) return
    if (!focusedEventRef.current || !containerRef.current) return

    // Get all items for this event
    const items = getItemsByEvent(focusedEventRef.current.id)
    const canvasItems = getCanvasItems(focusedEventRef.current.id)

    if (items.length === 0) return

    // Calculate bounding box of all items
    // Items are positioned at their CENTER (x, y) due to pivot being centered
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity

    items.forEach(item => {
      const canvasItem = canvasItems.find(ci => ci.itemId === item.id)
      const x = canvasItem?.x ?? 0
      const y = canvasItem?.y ?? 0
      const scale = canvasItem?.scale ?? 1
      const halfWidth = (CANVAS_ITEM_WIDTH * scale) / 2
      const halfHeight = (CANVAS_ITEM_HEIGHT * scale) / 2

      // x,y is CENTER of item, so bounds extend from center
      minX = Math.min(minX, x - halfWidth)
      maxX = Math.max(maxX, x + halfWidth)
      minY = Math.min(minY, y - halfHeight)
      maxY = Math.max(maxY, y + halfHeight)
    })

    // Add padding
    const padding = 80
    minX -= padding
    minY -= padding
    maxX += padding
    maxY += padding

    // Calculate required scale to fit all items
    const containerRect = containerRef.current.getBoundingClientRect()
    const contentWidth = maxX - minX
    const contentHeight = maxY - minY

    const scaleX = containerRect.width / contentWidth
    const scaleY = containerRect.height / contentHeight
    const newScale = Math.min(scaleX, scaleY, 2)  // Max scale 2 for better overview

    // Center the view on the center of all items
    const centerX = (minX + maxX) / 2
    const centerY = (minY + maxY) / 2

    activeState.scale = newScale
    activeState.targetScale = newScale
    activeState.x = -centerX * newScale
    activeState.y = -centerY * newScale
    activeState.targetX = activeState.x
    activeState.targetY = activeState.y
    activeState.container.scale.set(newScale)
    activeState.container.x = containerRect.width / 2 + activeState.x
    activeState.container.y = containerRect.height / 2 + activeState.y
  }, [getActiveState])

  // Arrange items as collage or restore to original positions
  const arrangedPositionsRef = useRef<Map<string, { x: number; y: number; scale: number; rotation: number; zIndex: number; textScale?: number }> | null>(null)
  const isArrangedRef = useRef(false)

  // Generate a beautiful photo collage layout - no overlap, no rotation
  const generateCollageLayout = (itemCount: number, _seed: number = 42) => {
    const positions: Array<{ x: number; y: number; scale: number; rotation: number; zIndex: number }> = []

    if (itemCount === 0) return positions

    // Base item size with gap
    const itemW = CANVAS_ITEM_WIDTH + 16  // 216
    const itemH = CANVAS_ITEM_HEIGHT + 16  // 166
    const gap = 12

    // Single item - centered, larger
    if (itemCount === 1) {
      positions.push({ x: 0, y: 0, scale: 1.3, rotation: 0, zIndex: 0 })
      return positions
    }

    // Two items - side by side
    if (itemCount === 2) {
      const totalW = itemW * 2 + gap
      positions.push({ x: -totalW/4, y: 0, scale: 1, rotation: 0, zIndex: 0 })
      positions.push({ x: totalW/4, y: 0, scale: 1, rotation: 0, zIndex: 1 })
      return positions
    }

    // Three items - 1 large on left, 2 stacked on right
    if (itemCount === 3) {
      positions.push({ x: -itemW/2 - gap/2, y: 0, scale: 1.2, rotation: 0, zIndex: 0 })  // Large left
      positions.push({ x: itemW/2 + gap/2, y: -itemH/2 - gap/2, scale: 0.9, rotation: 0, zIndex: 1 })  // Top right
      positions.push({ x: itemW/2 + gap/2, y: itemH/2 + gap/2, scale: 0.9, rotation: 0, zIndex: 2 })   // Bottom right
      return positions
    }

    // Four items - 2x2 grid
    if (itemCount === 4) {
      const offsetX = itemW/2 + gap/2
      const offsetY = itemH/2 + gap/2
      positions.push({ x: -offsetX, y: -offsetY, scale: 1, rotation: 0, zIndex: 0 })
      positions.push({ x: offsetX, y: -offsetY, scale: 1, rotation: 0, zIndex: 1 })
      positions.push({ x: -offsetX, y: offsetY, scale: 1, rotation: 0, zIndex: 2 })
      positions.push({ x: offsetX, y: offsetY, scale: 1, rotation: 0, zIndex: 3 })
      return positions
    }

    // Five items - 1 large center top, 4 smaller below
    if (itemCount === 5) {
      const smallScale = 0.8
      const smallW = itemW * smallScale
      positions.push({ x: 0, y: -itemH/2 - gap, scale: 1.2, rotation: 0, zIndex: 4 })  // Large top center
      // 4 smaller items below
      const row2Y = itemH/2 + gap
      const row2Spacing = smallW + gap
      positions.push({ x: -row2Spacing * 1.5, y: row2Y, scale: smallScale, rotation: 0, zIndex: 0 })
      positions.push({ x: -row2Spacing * 0.5, y: row2Y, scale: smallScale, rotation: 0, zIndex: 1 })
      positions.push({ x: row2Spacing * 0.5, y: row2Y, scale: smallScale, rotation: 0, zIndex: 2 })
      positions.push({ x: row2Spacing * 1.5, y: row2Y, scale: smallScale, rotation: 0, zIndex: 3 })
      return positions
    }

    // Six items - 2 rows of 3
    if (itemCount === 6) {
      const offsetY = itemH/2 + gap/2
      const spacing = itemW + gap
      for (let row = 0; row < 2; row++) {
        for (let col = 0; col < 3; col++) {
          const x = (col - 1) * spacing
          const y = (row === 0 ? -offsetY : offsetY)
          positions.push({ x, y, scale: 1, rotation: 0, zIndex: row * 3 + col })
        }
      }
      return positions
    }

    // 7+ items - creative masonry-style layout with varying sizes
    // Use a pseudo-random but deterministic pattern based on item count
    const patterns = [
      // Pattern 1: Large hero + scattered smaller items
      () => {
        // First item is large hero in center-left
        positions.push({ x: -itemW * 0.6, y: 0, scale: 1.4, rotation: -2, zIndex: itemCount - 1 })

        // Distribute remaining items around the hero
        const remaining = itemCount - 1
        const angleStep = (Math.PI * 1.5) / remaining
        const baseRadius = itemW * 1.2

        for (let i = 0; i < remaining; i++) {
          const angle = -Math.PI * 0.75 + i * angleStep
          const radius = baseRadius + (i % 2) * itemW * 0.3
          const x = Math.cos(angle) * radius + itemW * 0.2
          const y = Math.sin(angle) * radius
          const scale = 0.7 + (i % 3) * 0.15
          const rotation = (i % 2 === 0 ? 1 : -1) * (2 + i % 3)
          positions.push({ x, y, scale, rotation, zIndex: i })
        }
      },

      // Pattern 2: Pinterest-style staggered columns (3 columns)
      () => {
        const colHeights = [0, 0, 0]
        const colX = [-itemW - gap, 0, itemW + gap]

        for (let i = 0; i < itemCount; i++) {
          // Find shortest column
          const minCol = colHeights.indexOf(Math.min(...colHeights))
          const scale = 0.8 + (i % 4) * 0.15
          const scaledH = itemH * scale

          const x = colX[minCol]
          const y = colHeights[minCol] + scaledH / 2 - itemH * 1.5
          const rotation = (i % 3 - 1) * 1.5

          positions.push({ x, y, scale, rotation, zIndex: i })
          colHeights[minCol] += scaledH + gap
        }
      },

      // Pattern 3: Scattered organic layout
      () => {
        // Golden ratio spiral-ish placement
        const phi = 1.618033988749

        for (let i = 0; i < itemCount; i++) {
          const angle = i * phi * Math.PI * 0.5
          const radius = Math.sqrt(i + 1) * itemW * 0.4
          const x = Math.cos(angle) * radius
          const y = Math.sin(angle) * radius * 0.7
          const scale = 1.2 - (i / itemCount) * 0.4
          const rotation = (i % 2 === 0 ? 1 : -1) * (i % 5)

          positions.push({ x, y, scale, rotation, zIndex: itemCount - 1 - i })
        }
      },

      // Pattern 4: Diagonal cascade
      () => {
        const diagStep = itemW * 0.7
        const startX = -(itemCount / 2) * diagStep * 0.5
        const startY = -(itemCount / 2) * diagStep * 0.3

        for (let i = 0; i < itemCount; i++) {
          const x = startX + i * diagStep * 0.5
          const y = startY + i * diagStep * 0.3
          const scale = 1.1 - (i % 3) * 0.15
          const rotation = -3 + (i % 4) * 1.5

          positions.push({ x, y, scale, rotation, zIndex: i })
        }
      },

      // Pattern 5: Two rows with alternating sizes
      () => {
        const itemsPerRow = Math.ceil(itemCount / 2)
        const rowGap = itemH * 0.9

        for (let i = 0; i < itemCount; i++) {
          const row = i < itemsPerRow ? 0 : 1
          const col = row === 0 ? i : i - itemsPerRow
          const colsInRow = row === 0 ? itemsPerRow : itemCount - itemsPerRow

          const offsetX = (col - (colsInRow - 1) / 2) * (itemW * 0.85)
          const offsetY = (row - 0.5) * rowGap
          const scale = (row === 0 ? 1 : 0.85) + (col % 2) * 0.1
          const rotation = (col % 2 === 0 ? 1 : -1) * 2

          positions.push({ x: offsetX, y: offsetY, scale, rotation, zIndex: i })
        }
      }
    ]

    // Select pattern based on item count for variety
    const patternIndex = itemCount % patterns.length
    patterns[patternIndex]()

    return positions
  }

  const arrangeItems = useCallback(() => {
    const activeState = getActiveState()
    if (!activeState || activeState.zoomLevel !== ZoomLevel.L2_Canvas) return
    if (!focusedEventRef.current) return

    const items = getItemsByEvent(focusedEventRef.current.id)
    const canvasItems = getCanvasItems(focusedEventRef.current.id)

    if (items.length === 0) return

    if (!isArrangedRef.current) {
      // Save current positions, scale, rotation and textScale
      arrangedPositionsRef.current = new Map()

      items.forEach(item => {
        const canvasItem = canvasItems.find(ci => ci.itemId === item.id)
        arrangedPositionsRef.current!.set(item.id, {
          x: canvasItem?.x ?? 0,
          y: canvasItem?.y ?? 0,
          scale: canvasItem?.scale ?? 1,
          rotation: canvasItem?.rotation ?? 0,
          zIndex: canvasItem?.zIndex ?? 0,
          textScale: canvasItem?.textScale,
        })
      })

      // Sort items: photos/videos first (they look better as heroes), then others
      const sortedItems = [...items].sort((a, b) => {
        const aIsMedia = a.itemType === 'photo' || a.itemType === 'video'
        const bIsMedia = b.itemType === 'photo' || b.itemType === 'video'
        if (aIsMedia && !bIsMedia) return -1
        if (!aIsMedia && bIsMedia) return 1
        return 0
      })

      // Generate collage layout
      const seed = focusedEventRef.current.id.charCodeAt(0) + items.length
      const collagePositions = generateCollageLayout(items.length, seed)

      sortedItems.forEach((item, index) => {
        const pos = collagePositions[index]
        const canvasItem = canvasItems.find(ci => ci.itemId === item.id)

        upsertCanvasItem({
          eventId: focusedEventRef.current!.id,
          itemId: item.id,
          x: pos.x,
          y: pos.y,
          scale: pos.scale,
          rotation: pos.rotation * (Math.PI / 180),  // Convert to radians
          zIndex: pos.zIndex,
          textScale: canvasItem?.textScale,
        })
      })

      isArrangedRef.current = true
    } else {
      // Restore original positions, scale, rotation, zIndex and textScale
      if (arrangedPositionsRef.current) {
        items.forEach(item => {
          const saved = arrangedPositionsRef.current!.get(item.id)
          if (saved) {
            upsertCanvasItem({
              eventId: focusedEventRef.current!.id,
              itemId: item.id,
              x: saved.x,
              y: saved.y,
              scale: saved.scale,
              rotation: saved.rotation,
              zIndex: saved.zIndex,
              textScale: saved.textScale,
            })
          }
        })
      }
      isArrangedRef.current = false
    }

    // Save all canvas positions to files (single batch save)
    if (hasStorageFolder() && focusedEventRef.current) {
      saveCanvasLayout(focusedEventRef.current.id).catch(err => {
        console.error('Failed to save canvas layout:', err)
      })
    }

    // Rebuild the view with culling manager
    activeState.container.removeChildren()
    if (cullingManagerRef.current) {
      cullingManagerRef.current.clearItems()
    }
    const focusedEvt = focusedEventRef.current
    const createItemBlockById = (id: string): Container | null => {
      const data = itemDataRef.current.get(id)
      if (!data) return null
      return createCanvasItemBlock(
        data.item,
        focusedEvt.id,
        isDraggingItemRef,
        (item) => handleItemClickRef.current?.(item),
        (item) => handleDeleteItemRef.current?.(item),
        (item) => handleEditItemRef.current?.(item),
        data.textScale,
        data.canvasItem?.scale ?? 1,
        data.canvasItem?.zIndex ?? 0,
        data.canvasItem?.width ?? CANVAS_ITEM_WIDTH,
        data.canvasItem?.height ?? CANVAS_ITEM_HEIGHT
      )
    }
    cullingManagerRef.current = new ViewportCullingManager(activeState.container, createItemBlockById)
    buildL2View(activeState.container, focusedEvt, isDraggingItemRef, (item) => {
      handleItemClickRef.current?.(item)
    }, () => {
      handleAddClickRef.current?.()
    }, (item) => {
      handleDeleteItemRef.current?.(item)
    }, (item) => {
      handleEditItemRef.current?.(item)
    }, cullingManagerRef.current, itemDataRef.current)
  }, [getActiveState])

  // Rebuild the current view (useful after adding items via drag&drop)
  const rebuildView = useCallback(() => {
    const activeState = getActiveState()
    if (!activeState || activeState.zoomLevel !== ZoomLevel.L2_Canvas) return
    if (!focusedEventRef.current) return

    // Clear and rebuild L2 view with culling manager
    activeState.container.removeChildren()
    if (cullingManagerRef.current) {
      cullingManagerRef.current.clearItems()
    }
    const focusedEvt = focusedEventRef.current
    const createItemBlockById = (id: string): Container | null => {
      const data = itemDataRef.current.get(id)
      if (!data) return null
      return createCanvasItemBlock(
        data.item,
        focusedEvt.id,
        isDraggingItemRef,
        (item) => handleItemClickRef.current?.(item),
        (item) => handleDeleteItemRef.current?.(item),
        (item) => handleEditItemRef.current?.(item),
        data.textScale,
        data.canvasItem?.scale ?? 1,
        data.canvasItem?.zIndex ?? 0,
        data.canvasItem?.width ?? CANVAS_ITEM_WIDTH,
        data.canvasItem?.height ?? CANVAS_ITEM_HEIGHT
      )
    }
    cullingManagerRef.current = new ViewportCullingManager(activeState.container, createItemBlockById)
    buildL2View(activeState.container, focusedEvt, isDraggingItemRef, (item) => {
      handleItemClickRef.current?.(item)
    }, () => {
      handleAddClickRef.current?.()
    }, (item) => {
      handleDeleteItemRef.current?.(item)
    }, (item) => {
      handleEditItemRef.current?.(item)
    }, cullingManagerRef.current, itemDataRef.current)
  }, [getActiveState])

  // Get viewport center in canvas coordinates
  const getViewportCenter = useCallback(() => {
    const activeState = getActiveState()
    if (!activeState || !containerRef.current) return null

    const rect = containerRef.current.getBoundingClientRect()
    const screenCenterX = rect.width / 2
    const screenCenterY = rect.height / 2

    // Convert screen center to canvas coordinates
    // The container is positioned at (containerX, containerY) and scaled
    const containerX = activeState.container.x
    const containerY = activeState.container.y
    const scale = activeState.scale

    // Canvas coordinate at screen center
    const canvasX = (screenCenterX - containerX) / scale
    const canvasY = (screenCenterY - containerY) / scale

    return { x: canvasX, y: canvasY }
  }, [getActiveState])

  useImperativeHandle(ref, () => ({
    navigateToLevel,
    fitToView,
    arrangeItems,
    rebuildView,
    getViewportCenter,
  }), [navigateToLevel, fitToView, arrangeItems, rebuildView, getViewportCenter])

  // Initialize PixiJS
  useEffect(() => {
    if (!containerRef.current) return
    if (appRef.current || initializingRef.current) return

    initializingRef.current = true
    const container = containerRef.current
    let mounted = true

    const initApp = async () => {
      try {
        const app = new Application()

        await app.init({
          background: '#0a0a0f',
          resizeTo: container,
          antialias: true,
          resolution: window.devicePixelRatio || 1,
          autoDensity: true,
        })

        if (!mounted) {
          app.destroy(true)
          return
        }

        container.appendChild(app.canvas as HTMLCanvasElement)
        appRef.current = app

        const screenCenterX = app.screen.width / 2
        const screenCenterY = app.screen.height / 2

        // Create container A
        const containerA = new Container()
        app.stage.addChild(containerA)
        containerARef.current = {
          container: containerA,
          alpha: 1,
          targetAlpha: 1,
          scale: 1,
          targetScale: 1,
          x: screenCenterX,
          targetX: screenCenterX,
          y: screenCenterY,
          targetY: screenCenterY,
          zoomLevel: ZoomLevel.L0_Lifeline,
        }

        // Create container B (initially invisible)
        const containerB = new Container()
        containerB.alpha = 0
        app.stage.addChild(containerB)
        containerBRef.current = {
          container: containerB,
          alpha: 0,
          targetAlpha: 0,
          scale: 1,
          targetScale: 1,
          x: screenCenterX,
          targetX: screenCenterX,
          y: screenCenterY,
          targetY: screenCenterY,
          zoomLevel: ZoomLevel.L0_Lifeline,
        }

        // Build initial L0 view in container A
        const bounds = buildL0View(containerA, yearsRef.current, (year, centerX) => {
          handleYearClickRef.current?.(year, centerX)
        })
        contentBoundsRef.current = bounds

        // Animation loop
        app.ticker.add(() => {
          const stateA = containerARef.current
          const stateB = containerBRef.current
          if (!stateA || !stateB) return

          // Animate both containers with smooth interpolation
          // Use a minimum step to avoid endless asymptotic approach
          const ALPHA_SNAP = 0.005
          const SCALE_SNAP = 0.005
          const POS_SNAP = 0.3

          for (const state of [stateA, stateB]) {
            // Interpolate alpha
            const alphaDiff = state.targetAlpha - state.alpha
            if (Math.abs(alphaDiff) > ALPHA_SNAP) {
              state.alpha += alphaDiff * TRANSITION_SPEED * 2.5
            } else {
              state.alpha = state.targetAlpha
            }
            state.container.alpha = state.alpha

            // Interpolate scale
            const scaleDiff = state.targetScale - state.scale
            if (Math.abs(scaleDiff) > SCALE_SNAP) {
              state.scale += scaleDiff * TRANSITION_SPEED * 1.2
            } else {
              state.scale = state.targetScale
            }
            state.container.scale.set(state.scale)

            // Interpolate position
            const xDiff = state.targetX - state.x
            const yDiff = state.targetY - state.y
            if (Math.abs(xDiff) > POS_SNAP) {
              state.x += xDiff * TRANSITION_SPEED * 1.2
            } else {
              state.x = state.targetX
            }
            if (Math.abs(yDiff) > POS_SNAP) {
              state.y += yDiff * TRANSITION_SPEED * 1.2
            } else {
              state.y = state.targetY
            }
            state.container.x = state.x
            state.container.y = state.y
          }

          // Check if transition is complete
          // Only complete when values have been snapped to exact targets
          if (isTransitioningRef.current && transitionCallbackRef.current) {
            const activeState = getActiveState()
            const inactiveState = getInactiveState()

            // Check that incoming container has reached exact target values
            // (after snapping in the animation loop above)
            const incomingAtTarget = inactiveState &&
                inactiveState.alpha === inactiveState.targetAlpha &&
                inactiveState.scale === inactiveState.targetScale &&
                inactiveState.x === inactiveState.targetX &&
                inactiveState.y === inactiveState.targetY

            // Check that outgoing is faded
            const outgoingFaded = activeState && activeState.alpha === activeState.targetAlpha

            if (incomingAtTarget && outgoingFaded) {
              const callback = transitionCallbackRef.current
              transitionCallbackRef.current = null
              callback()
            }
          }

          // Apply momentum and elastic bounds to active container when not transitioning
          if (!isTransitioningRef.current) {
            const activeState = getActiveState()
            if (activeState && app) {
              const screenWidth = app.screen.width
              const screenCenterX = screenWidth / 2
              const bounds = contentBoundsRef.current
              const scale = activeState.scale  // Account for zoom level

              // Calculate the allowed range for container X position
              // When container.x = screenCenterX, content center is at screen center
              // Content extends from -bounds.maxX to +bounds.maxX (relative to container origin)
              // Multiply by scale because content is visually larger when zoomed in
              const minContainerX = screenCenterX - bounds.maxX * scale  // Right edge of content at right edge of screen
              const maxContainerX = screenCenterX - bounds.minX * scale  // Left edge of content at left edge of screen

              if (!isDraggingRef.current) {
                // Apply momentum
                if (Math.abs(velocityRef.current.x) > MIN_VELOCITY) {
                  activeState.targetX += velocityRef.current.x
                  activeState.x = activeState.targetX
                  velocityRef.current.x *= FRICTION
                } else {
                  velocityRef.current.x = 0
                }

                // Y momentum (for L2 canvas)
                if (Math.abs(velocityRef.current.y) > MIN_VELOCITY) {
                  activeState.targetY += velocityRef.current.y
                  activeState.y = activeState.targetY
                  velocityRef.current.y *= FRICTION
                } else {
                  velocityRef.current.y = 0
                }

                // Elastic bounce back when past bounds
                if (activeState.x > maxContainerX) {
                  const overscroll = activeState.x - maxContainerX
                  activeState.targetX = maxContainerX + overscroll * (1 - BOUNCE_BACK_SPEED)
                  activeState.x = activeState.targetX
                  velocityRef.current.x *= 0.5  // Dampen velocity
                  if (overscroll < 1) {
                    activeState.x = maxContainerX
                    activeState.targetX = maxContainerX
                  }
                } else if (activeState.x < minContainerX) {
                  const overscroll = minContainerX - activeState.x
                  activeState.targetX = minContainerX - overscroll * (1 - BOUNCE_BACK_SPEED)
                  activeState.x = activeState.targetX
                  velocityRef.current.x *= 0.5  // Dampen velocity
                  if (overscroll < 1) {
                    activeState.x = minContainerX
                    activeState.targetX = minContainerX
                  }
                }
              }

              // Viewport culling for L2 canvas
              if (activeState.zoomLevel === ZoomLevel.L2_Canvas && cullingManagerRef.current) {
                const viewport = calculateViewportBounds(
                  activeState.x,
                  activeState.y,
                  activeState.scale,
                  screenWidth,
                  app.screen.height
                )
                // Only update if viewport changed significantly (to avoid unnecessary work)
                if (cullingManagerRef.current.hasViewportChanged(viewport)) {
                  cullingManagerRef.current.update(viewport)
                }
              }
            }
          }
        })

        console.log('PixiJS initialized with dual-container system')
      } catch (err) {
        console.error('Failed to initialize PixiJS:', err)
        initializingRef.current = false
      }
    }

    initApp()

    return () => {
      mounted = false
      if (appRef.current) {
        try {
          appRef.current.destroy(true, { children: true })
        } catch (e) {
          console.warn('Error destroying PixiJS app:', e)
        }
        appRef.current = null
        containerARef.current = null
        containerBRef.current = null
      }
      initializingRef.current = false
    }
  }, []) // Empty deps - only run once on mount

  // Rebuild active view when data changes (but not during transitions)
  useEffect(() => {
    if (isTransitioningRef.current) return
    const activeState = activeContainerRef.current === 'A' ? containerARef.current : containerBRef.current
    if (!activeState) return

    if (viewStateRef.current.zoomLevel === ZoomLevel.L0_Lifeline) {
      activeState.container.removeChildren()
      const bounds = buildL0View(activeState.container, years, (year, centerX) => {
        handleYearClickRef.current?.(year, centerX)
      })
      contentBoundsRef.current = bounds
    } else if (viewStateRef.current.zoomLevel === ZoomLevel.L1_Year && focusedYearRef.current) {
      const childEvents = events.filter(e => e.parentId === focusedYearRef.current?.id)
      activeState.container.removeChildren()
      const bounds = buildL1View(activeState.container, focusedYearRef.current, childEvents, l1InternalScaleRef.current, (event, centerX) => {
        handleEventClickRef.current?.(event, centerX)
      })
      contentBoundsRef.current = bounds
    } else if (viewStateRef.current.zoomLevel === ZoomLevel.L2_Canvas && focusedEventRef.current) {
      // Rebuild L2 view when items change (e.g., after adding, deleting, or editing a memory)
      activeState.container.removeChildren()
      if (cullingManagerRef.current) {
        cullingManagerRef.current.clearItems()
      }
      const focusedEvt = focusedEventRef.current
      const createItemBlockById = (id: string): Container | null => {
        const data = itemDataRef.current.get(id)
        if (!data) return null
        return createCanvasItemBlock(
          data.item,
          focusedEvt.id,
          isDraggingItemRef,
          (item) => handleItemClickRef.current?.(item),
          (item) => handleDeleteItemRef.current?.(item),
          (item) => handleEditItemRef.current?.(item),
          data.textScale,
          data.canvasItem?.scale ?? 1,
          data.canvasItem?.zIndex ?? 0,
          data.canvasItem?.width ?? CANVAS_ITEM_WIDTH,
          data.canvasItem?.height ?? CANVAS_ITEM_HEIGHT
        )
      }
      cullingManagerRef.current = new ViewportCullingManager(activeState.container, createItemBlockById)
      buildL2View(activeState.container, focusedEvt, isDraggingItemRef, (item) => {
        handleItemClickRef.current?.(item)
      }, () => {
        handleAddClickRef.current?.()
      }, (item) => {
        handleDeleteItemRef.current?.(item)
      }, (item) => {
        handleEditItemRef.current?.(item)
      }, cullingManagerRef.current, itemDataRef.current)
    }
  }, [years, events]) // Only rebuild when data changes

  // Keyboard handler for Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isTransitioningRef.current) {
        const currentLevel = viewStateRef.current.zoomLevel
        if (currentLevel === ZoomLevel.L3_Focus) {
          navigateToLevel(ZoomLevel.L2_Canvas)
        } else if (currentLevel === ZoomLevel.L2_Canvas) {
          navigateToLevel(ZoomLevel.L1_Year)
        } else if (currentLevel === ZoomLevel.L1_Year) {
          navigateToLevel(ZoomLevel.L0_Lifeline)
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [navigateToLevel])

  // Rebuild L1 view with current internal scale (debounced)
  const rebuildL1View = useCallback(() => {
    const activeState = getActiveState()
    if (!activeState || activeState.zoomLevel !== ZoomLevel.L1_Year) return
    if (!focusedYearRef.current) return

    const childEvents = eventsRef.current.filter(e => e.parentId === focusedYearRef.current?.id)
    activeState.container.removeChildren()
    const bounds = buildL1View(
      activeState.container,
      focusedYearRef.current,
      childEvents,
      l1InternalScaleRef.current,
      (event, centerX) => {
        handleEventClickRef.current?.(event, centerX)
      }
    )
    contentBoundsRef.current = bounds
  }, [getActiveState])

  // Wheel handler for pan/zoom
  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault()
    if (isTransitioningRef.current) return

    const activeState = getActiveState()
    if (!activeState) return

    if (e.ctrlKey || e.metaKey) {
      // Zoom behavior depends on current level
      if (activeState.zoomLevel === ZoomLevel.L1_Year) {
        // L1: Zoom spreads out the timeline, doesn't scale elements
        const zoomFactor = e.deltaY > 0 ? 0.92 : 1.08
        const newScale = Math.max(L1_MIN_SCALE, Math.min(L1_MAX_SCALE, l1InternalScaleRef.current * zoomFactor))
        l1InternalScaleRef.current = newScale

        // Don't change container scale - only rebuild with new width
        // Debounced rebuild for performance
        if (l1RebuildTimeoutRef.current) {
          clearTimeout(l1RebuildTimeoutRef.current)
        }
        l1RebuildTimeoutRef.current = setTimeout(() => {
          rebuildL1View()
        }, 30)
      } else {
        // Other levels: standard zoom
        const zoomFactor = e.deltaY > 0 ? 0.95 : 1.05
        const newScale = Math.max(0.3, Math.min(5, activeState.scale * zoomFactor))
        activeState.targetScale = newScale
        activeState.scale = newScale
      }
    } else {
      // Pan
      velocityRef.current.x -= e.deltaY * 0.5
    }
  }, [getActiveState, rebuildL1View])

  // Rebuild L1 view when events change (e.g., after adding a new event)
  useEffect(() => {
    const activeState = getActiveState()
    if (activeState?.zoomLevel === ZoomLevel.L1_Year && focusedYearRef.current) {
      rebuildL1View()
    }
  }, [events, getActiveState, rebuildL1View])

  // Pointer handlers for drag-to-pan
  const handlePointerDown = useCallback((e: PointerEvent) => {
    if (isTransitioningRef.current) return
    if (isDraggingItemRef.current) return // Don't start canvas pan if dragging an item

    if ((e.target as HTMLElement).tagName === 'CANVAS') {
      isPotentialDragRef.current = true
      isDraggingRef.current = false
      pointerDownPosRef.current = { x: e.clientX, y: e.clientY }
      lastPointerRef.current = { x: e.clientX, y: e.clientY }
      pointerIdRef.current = e.pointerId
      velocityRef.current = { x: 0, y: 0 }
    }
  }, [])

  const handlePointerMove = useCallback((e: PointerEvent) => {
    if (!isPotentialDragRef.current) return
    if (isDraggingItemRef.current) return // Don't pan canvas if dragging an item

    const dx = e.clientX - pointerDownPosRef.current.x
    const dy = e.clientY - pointerDownPosRef.current.y
    const distance = Math.sqrt(dx * dx + dy * dy)

    if (!isDraggingRef.current && distance > DRAG_THRESHOLD) {
      isDraggingRef.current = true
      if (pointerIdRef.current !== null) {
        containerRef.current?.setPointerCapture(pointerIdRef.current)
      }
    }

    if (isDraggingRef.current) {
      const moveDx = e.clientX - lastPointerRef.current.x
      const moveDy = e.clientY - lastPointerRef.current.y
      const activeState = getActiveState()
      if (activeState && appRef.current) {
        const screenWidth = appRef.current.screen.width
        const screenCenterX = screenWidth / 2
        const bounds = contentBoundsRef.current
        const scale = activeState.scale  // Account for zoom level
        const minContainerX = screenCenterX - bounds.maxX * scale
        const maxContainerX = screenCenterX - bounds.minX * scale

        // Apply elastic resistance when dragging past bounds
        let effectiveDx = moveDx
        if (activeState.x > maxContainerX && moveDx > 0) {
          effectiveDx = moveDx * ELASTIC_FACTOR
        } else if (activeState.x < minContainerX && moveDx < 0) {
          effectiveDx = moveDx * ELASTIC_FACTOR
        }

        activeState.targetX += effectiveDx
        activeState.x = activeState.targetX
        velocityRef.current.x = effectiveDx * 0.8

        // Allow Y panning for L2 canvas
        if (viewStateRef.current.zoomLevel === ZoomLevel.L2_Canvas) {
          activeState.targetY += moveDy
          activeState.y = activeState.targetY
          velocityRef.current.y = moveDy * 0.8
        }
      }
      lastPointerRef.current = { x: e.clientX, y: e.clientY }
    }
  }, [getActiveState])

  const handlePointerUp = useCallback((e: PointerEvent) => {
    const wasDragging = isDraggingRef.current
    const wasPotentialDrag = isPotentialDragRef.current

    if (wasDragging && pointerIdRef.current !== null) {
      containerRef.current?.releasePointerCapture(pointerIdRef.current)
    }
    isPotentialDragRef.current = false
    isDraggingRef.current = false
    pointerIdRef.current = null

    // Click-to-go-back: if it was a click (not a drag) and we're not on L0
    if (wasPotentialDrag && !wasDragging && !isTransitioningRef.current) {
      const currentLevel = viewStateRef.current.zoomLevel

      // Check if click was on empty area (canvas background)
      // The pointer events on interactive objects will stop propagation
      if ((e.target as HTMLElement).tagName === 'CANVAS') {
        if (currentLevel === ZoomLevel.L3_Focus) {
          navigateToLevel(ZoomLevel.L2_Canvas)
        } else if (currentLevel === ZoomLevel.L2_Canvas) {
          navigateToLevel(ZoomLevel.L1_Year)
        } else if (currentLevel === ZoomLevel.L1_Year) {
          navigateToLevel(ZoomLevel.L0_Lifeline)
        }
      }
    }
  }, [navigateToLevel])

  // Attach event listeners
  useEffect(() => {
    const cont = containerRef.current
    if (!cont) return

    cont.addEventListener('wheel', handleWheel, { passive: false })
    cont.addEventListener('pointerdown', handlePointerDown)
    cont.addEventListener('pointermove', handlePointerMove)
    cont.addEventListener('pointerup', handlePointerUp)
    cont.addEventListener('pointerleave', handlePointerUp)

    return () => {
      cont.removeEventListener('wheel', handleWheel)
      cont.removeEventListener('pointerdown', handlePointerDown)
      cont.removeEventListener('pointermove', handlePointerMove)
      cont.removeEventListener('pointerup', handlePointerUp)
      cont.removeEventListener('pointerleave', handlePointerUp)
    }
  }, [handleWheel, handlePointerDown, handlePointerMove, handlePointerUp])

  // Drag-and-drop state
  const [isDragOver, setIsDragOver] = useState(false)

  // Handle drag-and-drop for photos
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    // Only accept files when in L2 canvas view
    if (viewStateRef.current.zoomLevel === ZoomLevel.L2_Canvas && focusedEventRef.current) {
      e.dataTransfer.dropEffect = 'copy'
      setIsDragOver(true)
    }
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)

    // Only accept drops when in L2 canvas view
    if (viewStateRef.current.zoomLevel !== ZoomLevel.L2_Canvas || !focusedEventRef.current) {
      return
    }

    const files = Array.from(e.dataTransfer.files)
    console.log('Files dropped:', files.map(f => ({ name: f.name, type: f.type })))

    // Filter to only image files (including HEIC)
    const imageFiles = files.filter(file => {
      const name = file.name.toLowerCase()
      return file.type.startsWith('image/') ||
        name.endsWith('.jpg') ||
        name.endsWith('.jpeg') ||
        name.endsWith('.png') ||
        name.endsWith('.gif') ||
        name.endsWith('.webp') ||
        name.endsWith('.heic') ||
        name.endsWith('.heif')
    })

    console.log('Image files after filter:', imageFiles.length)

    if (imageFiles.length === 0) return

    // Get drop position relative to container
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return

    // Convert screen coordinates to canvas coordinates
    const activeState = getActiveState()
    if (!activeState) return

    const screenX = e.clientX - rect.left - rect.width / 2
    const screenY = e.clientY - rect.top - rect.height / 2

    // Adjust for current view position and scale
    const canvasX = (screenX - activeState.x) / activeState.scale
    const canvasY = (screenY - activeState.y) / activeState.scale

    onDropPhotos?.(imageFiles, { x: canvasX, y: canvasY }, focusedEventRef.current.id)
  }, [onDropPhotos, getActiveState])

  return (
    <div
      ref={containerRef}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      style={{
        width: '100%',
        height: '100%',
        cursor: isDraggingRef.current ? 'grabbing' : 'grab',
        touchAction: 'none',
        outline: isDragOver ? '3px dashed #5d7aa0' : 'none',
        outlineOffset: '-3px',
        backgroundColor: isDragOver ? 'rgba(93, 122, 160, 0.1)' : 'transparent',
        transition: 'outline 0.2s, background-color 0.2s',
      }}
    />
  )
})

// ============ L0 View: Lifeline (Years) ============

function buildL0View(
  container: Container,
  years: Event[],
  onYearClick: (year: Event, yearCenterX: number) => void
): { minX: number; maxX: number } {
  const totalWidth = years.length * (YEAR_WIDTH + YEAR_GAP) - YEAR_GAP
  const padding = 100 // Extra space on edges

  // Timeline line
  const line = new Graphics()
  line.moveTo(-totalWidth / 2 + YEAR_WIDTH / 2, 0)
  line.lineTo(totalWidth / 2 - YEAR_WIDTH / 2, 0)
  line.stroke({ width: 2, color: 0x333344 })
  container.addChild(line)

  // Year blocks
  years.forEach((year, index) => {
    const x = -totalWidth / 2 + index * (YEAR_WIDTH + YEAR_GAP)
    const centerX = x + YEAR_WIDTH / 2
    const block = createYearBlock(year, x, () => onYearClick(year, centerX))
    container.addChild(block)
  })

  // Return content bounds (from center)
  return {
    minX: -totalWidth / 2 - padding,
    maxX: totalWidth / 2 + padding
  }
}

function createYearBlock(event: Event, x: number, onClick: () => void): Container {
  const cont = new Container()
  cont.x = x
  cont.y = -YEAR_HEIGHT / 2
  cont.eventMode = 'static'
  cont.cursor = 'pointer'
  cont.on('pointertap', onClick)

  const bg = new Graphics()
  bg.roundRect(0, 0, YEAR_WIDTH, YEAR_HEIGHT, 12)
  bg.fill({ color: 0x1a1a2e })
  bg.stroke({ width: 1, color: 0x333355 })
  cont.addChild(bg)

  cont.on('pointerover', () => {
    bg.clear()
    bg.roundRect(0, 0, YEAR_WIDTH, YEAR_HEIGHT, 12)
    bg.fill({ color: 0x252545 })
    bg.stroke({ width: 2, color: 0x5555aa })
  })

  cont.on('pointerout', () => {
    bg.clear()
    bg.roundRect(0, 0, YEAR_WIDTH, YEAR_HEIGHT, 12)
    bg.fill({ color: 0x1a1a2e })
    bg.stroke({ width: 1, color: 0x333355 })
  })

  const textStyle = new TextStyle({
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    fontSize: 28,
    fontWeight: 'bold',
    fill: 0xffffff,
  })
  const text = new Text({ text: event.title || '', style: textStyle, resolution: TEXT_RESOLUTION })
  text.x = YEAR_WIDTH / 2 - text.width / 2
  text.y = YEAR_HEIGHT / 2 - text.height / 2
  cont.addChild(text)

  return cont
}

// ============ L1 View: Year Density Bar ============

function buildL1View(
  container: Container,
  year: Event,
  childEvents: Event[],
  scale: number,
  onEventClick: (event: Event, eventCenterX: number) => void
): { minX: number; maxX: number } {
  // Get memories and event clusters for this year
  const memories = getMemoriesForYear(year.id)
  const clusters = getEventClustersForYear(year.id)


  // Scale affects the effective timeline width - elements stay same size, just spread out
  const effectiveWidth = L1_YEAR_TIMELINE_WIDTH * scale

  // Slice width scales slightly with zoom for better visibility
  const sliceWidth = Math.min(L1_SLICE_MAX_WIDTH, L1_SLICE_MIN_WIDTH + (scale - 1) * 6)

  // Empty state
  if (memories.length === 0 && childEvents.length === 0) {
    const emptyContainer = new Container()

    const icon = new Graphics()
    const iconSize = 24
    const iconColor = 0x555566

    icon.circle(0, 0, iconSize)
    icon.stroke({ width: 2, color: iconColor })
    icon.moveTo(-iconSize * 0.4, 0)
    icon.lineTo(iconSize * 0.4, 0)
    icon.stroke({ width: 2, color: iconColor })
    icon.moveTo(0, -iconSize * 0.4)
    icon.lineTo(0, iconSize * 0.4)
    icon.stroke({ width: 2, color: iconColor })

    icon.y = -30
    emptyContainer.addChild(icon)

    const emptyTitle = new Text({
      text: 'No memories yet',
      style: new TextStyle({
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        fontSize: 20,
        fontWeight: '600',
        fill: 0x555566,
      }),
      resolution: TEXT_RESOLUTION,
    })
    emptyTitle.x = -emptyTitle.width / 2
    emptyTitle.y = 10
    emptyContainer.addChild(emptyTitle)

    const emptyHint = new Text({
      text: 'Add your first memory to this year',
      style: new TextStyle({
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        fontSize: 14,
        fill: 0x444455,
      }),
      resolution: TEXT_RESOLUTION,
    })
    emptyHint.x = -emptyHint.width / 2
    emptyHint.y = 40
    emptyContainer.addChild(emptyHint)

    container.addChild(emptyContainer)
    return { minX: -200, maxX: 200 }
  }

  // Calculate year time range
  const yearNum = parseInt(year.title || new Date().getFullYear().toString())
  const yearStart = new Date(yearNum, 0, 1).getTime()
  const yearEnd = new Date(yearNum, 11, 31, 23, 59, 59).getTime()
  const yearDuration = yearEnd - yearStart

  // Helper to convert timestamp to X position (uses effectiveWidth for spreading)
  const timestampToX = (timestamp: number): number => {
    const progress = (timestamp - yearStart) / yearDuration
    return -effectiveWidth / 2 + progress * effectiveWidth
  }

  // Calculate layout positions
  const densityBarY = 0
  const monthLabelY = densityBarY + L1_DENSITY_BAR_HEIGHT / 2 + 12
  const eventLabelY = densityBarY - L1_DENSITY_BAR_HEIGHT / 2 - 28  // Labels above density bar

  // Map to store label containers by event ID (for hover visibility)
  const labelContainersByEventId = new Map<string, Container>()

  // ======= Layer 1: Month Labels & Separators =======
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

  monthNames.forEach((monthName, monthIndex) => {
    const monthStart = new Date(yearNum, monthIndex, 1).getTime()
    const monthEnd = new Date(yearNum, monthIndex + 1, 0, 23, 59, 59).getTime()
    const monthX = timestampToX(monthStart)
    const monthEndX = timestampToX(monthEnd)
    const monthCenterX = (monthX + monthEndX) / 2

    // Month label
    const monthLabel = new Text({
      text: monthName,
      style: new TextStyle({
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        fontSize: 13,
        fontWeight: '500',
        fill: 0x666677,
      }),
      resolution: TEXT_RESOLUTION,
    })
    monthLabel.x = monthCenterX - monthLabel.width / 2
    monthLabel.y = monthLabelY
    container.addChild(monthLabel)

    // Month separator line (except for first month)
    if (monthIndex > 0) {
      const separator = new Graphics()
      separator.moveTo(monthX, densityBarY - L1_DENSITY_BAR_HEIGHT / 2 - 4)
      separator.lineTo(monthX, monthLabelY + L1_MONTH_LABEL_HEIGHT + 4)
      separator.stroke({ width: 1, color: 0x333344, alpha: 0.6 })
      container.addChild(separator)
    }
  })

  // ======= Layer 2: Density Bar Background =======
  const densityBg = new Graphics()
  densityBg.roundRect(
    -effectiveWidth / 2 - 10,
    densityBarY - L1_DENSITY_BAR_HEIGHT / 2,
    effectiveWidth + 20,
    L1_DENSITY_BAR_HEIGHT,
    8
  )
  densityBg.fill({ color: 0x111118 })
  densityBg.stroke({ width: 1, color: 0x222233 })
  container.addChild(densityBg)

  // ======= Layer 3: Interactive Memory Slices =======
  // First, identify multi-day events (events that span more than 1 day)
  // These will be shown as event blocks, not as individual memory slices
  const multiDayEventIds = new Set<string>()
  childEvents.forEach(event => {
    if (event.startAt && event.endAt) {
      const startDate = new Date(event.startAt)
      const endDate = new Date(event.endAt)
      // Check if the event spans multiple days
      const daysDiff = Math.floor((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24))
      if (daysDiff >= 1) {
        multiDayEventIds.add(event.id)
      }
    }
  })

  // Filter out memories from multi-day events - they'll be shown as event blocks instead
  const singleDayMemories = memories.filter(m => !multiDayEventIds.has(m.eventId))
  const sortedMemories = [...singleDayMemories].sort((a, b) => a.timestamp - b.timestamp)

  // Create a tooltip layer that will be added LAST (on top of everything)
  const tooltipLayer = new Container()

  // Calculate slice positions - date ranges use actual width, single dates use fixed width
  const slicePositions: { memory: typeof sortedMemories[0], x: number, width: number, endX: number }[] = []

  sortedMemories.forEach((memory) => {
    const startX = timestampToX(memory.timestamp)

    // Calculate width based on date range or use default slice width
    let memoryWidth: number
    let endX: number
    if (memory.endTimestamp && memory.endTimestamp > memory.timestamp) {
      // Date range memory - calculate width based on duration
      endX = timestampToX(memory.endTimestamp)
      memoryWidth = Math.max(sliceWidth, endX - startX)
    } else {
      // Single date memory - use fixed slice width
      memoryWidth = sliceWidth
      endX = startX + sliceWidth
    }

    // For collision detection, use the midpoint for positioning
    const midX = startX + memoryWidth / 2
    let finalMidX = midX

    // Check for overlaps and shift right (only for single-day memories to avoid breaking date ranges)
    if (!memory.endTimestamp) {
      for (const placed of slicePositions) {
        const placedMidX = placed.x + placed.width / 2
        const minGap = (memoryWidth + placed.width) / 2 + 2
        if (Math.abs(finalMidX - placedMidX) < minGap) {
          finalMidX = placed.endX + memoryWidth / 2 + 2
        }
      }
    }

    const finalStartX = finalMidX - memoryWidth / 2
    slicePositions.push({
      memory,
      x: finalStartX,
      width: memoryWidth,
      endX: finalStartX + memoryWidth
    })
  })

  // Render interactive slices
  slicePositions.forEach(({ memory, x, width }) => {
    const color = ITEM_TYPE_COLORS[memory.itemType] || 0x888888
    const isDateRange = memory.endTimestamp && memory.endTimestamp > memory.timestamp

    // Slice container for interactivity
    const sliceContainer = new Container()
    sliceContainer.x = x
    sliceContainer.eventMode = 'static'
    sliceContainer.cursor = 'pointer'

    // The slice graphic - wider for date ranges
    const slice = new Graphics()
    slice.roundRect(
      0,
      densityBarY - L1_DENSITY_BAR_HEIGHT / 2 + 4,
      width,
      L1_DENSITY_BAR_HEIGHT - 8,
      isDateRange ? 4 : 2
    )
    slice.fill({ color, alpha: isDateRange ? 0.9 : 0.85 })

    // Add subtle border for date range blocks to make them more visible
    if (isDateRange) {
      slice.stroke({ width: 1, color: 0xffffff, alpha: 0.2 })
    }
    sliceContainer.addChild(slice)

    // Hit area slightly larger for easier clicking
    const hitArea = new Graphics()
    hitArea.rect(-4, densityBarY - L1_DENSITY_BAR_HEIGHT / 2, width + 8, L1_DENSITY_BAR_HEIGHT)
    hitArea.fill({ color: 0x000000, alpha: 0 })
    sliceContainer.addChild(hitArea)

    // Tooltip (hidden by default)
    const tooltip = new Container()
    tooltip.visible = false

    // Tooltip content
    const tooltipTitle = memory.eventTitle || 'Memory'
    const tooltipContent = memory.content.length > 40 ? memory.content.slice(0, 40) + '...' : memory.content
    const tooltipType = memory.itemType.toUpperCase()
    const tooltipDescription = memory.eventDescription
      ? (memory.eventDescription.length > 60 ? memory.eventDescription.slice(0, 60) + '...' : memory.eventDescription)
      : ''
    const tooltipLocation = memory.eventLocation || ''

    const tooltipBg = new Graphics()
    const tooltipTextStyle = new TextStyle({
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      fontSize: 11,
      fill: 0xffffff,
      wordWrap: true,
      wordWrapWidth: 180,
    })

    let currentY = 8

    const titleText = new Text({
      text: tooltipTitle,
      style: new TextStyle({
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        fontSize: 12,
        fontWeight: '600',
        fill: 0xffffff,
      }),
      resolution: TEXT_RESOLUTION,
    })
    titleText.x = 8
    titleText.y = currentY
    currentY += titleText.height + 4

    // Location label (if available)
    let locationText: Text | null = null
    if (tooltipLocation) {
      locationText = new Text({
        text: `📍 ${tooltipLocation}`,
        style: new TextStyle({
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
          fontSize: 10,
          fill: 0x888888,
        }),
        resolution: TEXT_RESOLUTION,
      })
      locationText.x = 8
      locationText.y = currentY
      currentY += locationText.height + 4
    }

    // Description (if available)
    let descriptionText: Text | null = null
    if (tooltipDescription) {
      descriptionText = new Text({
        text: tooltipDescription,
        style: new TextStyle({
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
          fontSize: 10,
          fontStyle: 'italic',
          fill: 0xaaaaaa,
          wordWrap: true,
          wordWrapWidth: 180,
        }),
        resolution: TEXT_RESOLUTION,
      })
      descriptionText.x = 8
      descriptionText.y = currentY
      currentY += descriptionText.height + 6
    }

    // Type badge
    const typeText = new Text({
      text: tooltipType,
      style: new TextStyle({
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        fontSize: 9,
        fontWeight: 'bold',
        fill: color,
      }),
      resolution: TEXT_RESOLUTION,
    })
    typeText.x = 8
    typeText.y = currentY
    currentY += typeText.height + 4

    // Content preview
    const contentText = new Text({
      text: tooltipContent,
      style: tooltipTextStyle,
      resolution: TEXT_RESOLUTION,
    })
    contentText.x = 8
    contentText.y = currentY
    currentY += contentText.height + 8

    const tooltipWidth = 200
    const tooltipHeight = currentY

    tooltipBg.roundRect(0, 0, tooltipWidth, tooltipHeight, 6)
    tooltipBg.fill({ color: 0x1a1a2e })
    tooltipBg.stroke({ width: 1, color })

    tooltip.addChild(tooltipBg)
    tooltip.addChild(titleText)
    if (locationText) tooltip.addChild(locationText)
    if (descriptionText) tooltip.addChild(descriptionText)
    tooltip.addChild(typeText)
    tooltip.addChild(contentText)
    tooltip.x = x + width / 2 - tooltipWidth / 2  // Center tooltip above the block
    tooltip.y = densityBarY - L1_DENSITY_BAR_HEIGHT / 2 - tooltipHeight - 8

    // Add tooltip to the tooltip layer (rendered last, on top of everything)
    tooltipLayer.addChild(tooltip)

    // Hover effects - use the actual width for this memory
    sliceContainer.on('pointerover', () => {
      slice.clear()
      slice.roundRect(0, densityBarY - L1_DENSITY_BAR_HEIGHT / 2 + 4, width, L1_DENSITY_BAR_HEIGHT - 8, isDateRange ? 4 : 2)
      slice.fill({ color, alpha: 1 })
      slice.stroke({ width: 1, color: 0xffffff, alpha: 0.5 })
      tooltip.visible = true

      // Show event label (accessed from Map created after labels are rendered)
      const labelContainer = labelContainersByEventId.get(memory.eventId)
      if (labelContainer) {
        labelContainer.alpha = 1
      }
    })

    sliceContainer.on('pointerout', () => {
      slice.clear()
      slice.roundRect(0, densityBarY - L1_DENSITY_BAR_HEIGHT / 2 + 4, width, L1_DENSITY_BAR_HEIGHT - 8, isDateRange ? 4 : 2)
      slice.fill({ color, alpha: isDateRange ? 0.9 : 0.85 })
      if (isDateRange) {
        slice.stroke({ width: 1, color: 0xffffff, alpha: 0.2 })
      }
      tooltip.visible = false

      // Hide event label
      const labelContainer = labelContainersByEventId.get(memory.eventId)
      if (labelContainer) {
        labelContainer.alpha = 0
      }
    })

    // Click to open parent event
    sliceContainer.on('pointertap', () => {
      const parentEvent = clusters.find(c => c.event.id === memory.eventId)?.event
      if (parentEvent) {
        onEventClick(parentEvent, x + width / 2)  // Use center of block
      }
    })

    container.addChild(sliceContainer)
  })

  // ======= Layer 4: Event Labels (simple text, no boxes) =======
  const clustersWithMemories = clusters.filter(c => c.memories.length > 0)

  // ======= Layer 4.5: Background blocks for period events WITH memories =======
  // Show a subtle background block for events that span multiple days
  clustersWithMemories.forEach((cluster) => {
    const event = cluster.event
    if (!event.endAt || event.startAt === event.endAt) return  // Skip single-day events

    const startTimestamp = new Date(event.startAt).getTime()
    const endTimestamp = new Date(event.endAt).getTime()
    const startX = timestampToX(startTimestamp)
    const endX = timestampToX(endTimestamp)
    const blockWidth = Math.max(sliceWidth, endX - startX)
    const centerX = startX + blockWidth / 2

    // Subtle background block behind the memory slices
    const bgBlock = new Graphics()
    bgBlock.roundRect(
      centerX - blockWidth / 2,
      densityBarY - L1_DENSITY_BAR_HEIGHT / 2 + 2,
      blockWidth,
      L1_DENSITY_BAR_HEIGHT - 4,
      6
    )
    bgBlock.fill({ color: 0x3d5a80, alpha: 0.2 })  // Very subtle
    bgBlock.stroke({ width: 1, color: 0x3d5a80, alpha: 0.4 })
    container.addChild(bgBlock)
  })

  // Calculate label positions with collision detection
  const labelPositions: { cluster: typeof clustersWithMemories[0], x: number, y: number }[] = []
  const labelSpacing = 8

  clustersWithMemories.forEach((cluster) => {
    const clusterCenterX = timestampToX((cluster.startTimestamp + cluster.endTimestamp) / 2)

    // Create label text
    const labelText = new Text({
      text: cluster.event.title || 'Untitled',
      style: new TextStyle({
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        fontSize: 12,
        fontWeight: '500',
        fill: 0x88aacc,
      }),
      resolution: TEXT_RESOLUTION,
    })

    const labelWidth = labelText.width
    let finalY = eventLabelY

    // Check for collisions with already placed labels and stack upward
    let hasCollision = true
    let attempts = 0
    const maxAttempts = 10

    while (hasCollision && attempts < maxAttempts) {
      hasCollision = false
      for (const placed of labelPositions) {
        const overlapX = Math.abs(clusterCenterX - placed.x) < (labelWidth / 2 + 50)  // ~50px per label
        const overlapY = Math.abs(finalY - placed.y) < (labelSpacing + 14)

        if (overlapX && overlapY) {
          finalY = placed.y - labelSpacing - 14
          hasCollision = true
          break
        }
      }
      attempts++
    }

    labelPositions.push({ cluster, x: clusterCenterX, y: finalY })
  })

  // Render event labels (hidden by default, shown on slice hover)
  labelPositions.forEach(({ cluster, x, y }) => {
    const labelContainer = new Container()
    labelContainer.x = x
    labelContainer.y = y
    labelContainer.eventMode = 'static'
    labelContainer.cursor = 'pointer'
    labelContainer.alpha = 0  // Hidden by default

    const labelText = new Text({
      text: cluster.event.title || 'Untitled',
      style: new TextStyle({
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        fontSize: 12,
        fontWeight: '500',
        fill: 0x88aacc,
      }),
      resolution: TEXT_RESOLUTION,
    })
    labelText.x = -labelText.width / 2
    labelContainer.addChild(labelText)

    // Hover effect (when label itself is hovered)
    labelContainer.on('pointerover', () => {
      labelText.style.fill = 0xaaccee
      labelContainer.alpha = 1  // Keep visible while hovering the label itself
    })
    labelContainer.on('pointerout', () => {
      labelText.style.fill = 0x88aacc
      labelContainer.alpha = 0  // Hide when mouse leaves label
    })

    // Click to open event
    labelContainer.on('pointertap', () => {
      onEventClick(cluster.event, x)
    })

    // Store in Map for slice hover access
    labelContainersByEventId.set(cluster.event.id, labelContainer)

    container.addChild(labelContainer)
  })

  // ======= Layer 4.5: Multi-day events (shown as clickable blocks instead of individual items) =======
  const multiDayEventColor = 0x6b8cae  // Blue color for multi-day events
  const multiDayEvents = childEvents.filter(e => multiDayEventIds.has(e.id))

  multiDayEvents.forEach((event) => {
    const startTimestamp = new Date(event.startAt).getTime()
    const endTimestamp = event.endAt ? new Date(event.endAt).getTime() : startTimestamp
    const startX = timestampToX(startTimestamp)
    const endX = timestampToX(endTimestamp)
    const blockWidth = Math.max(sliceWidth * 2, endX - startX)
    const centerX = startX + blockWidth / 2

    const sliceContainer = new Container()
    sliceContainer.x = centerX
    sliceContainer.eventMode = 'static'
    sliceContainer.cursor = 'pointer'

    // Block with filled style - this is a multi-day event container
    const slice = new Graphics()
    slice.roundRect(
      -blockWidth / 2,
      densityBarY - L1_DENSITY_BAR_HEIGHT / 2 + 4,
      blockWidth,
      L1_DENSITY_BAR_HEIGHT - 8,
      6  // Rounded corners
    )
    slice.fill({ color: multiDayEventColor, alpha: 0.7 })
    slice.stroke({ width: 2, color: multiDayEventColor, alpha: 1 })
    sliceContainer.addChild(slice)

    // Event title inside the block (if it fits)
    if (blockWidth > 60) {
      const titleText = new Text({
        text: event.title || 'Event',
        style: new TextStyle({
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
          fontSize: 10,
          fontWeight: '600',
          fill: 0xffffff,
        }),
        resolution: TEXT_RESOLUTION,
      })
      // Truncate if too long
      const maxTextWidth = blockWidth - 12
      if (titleText.width > maxTextWidth) {
        const chars = Math.floor((maxTextWidth / titleText.width) * (event.title?.length || 5)) - 2
        titleText.text = (event.title || 'Event').slice(0, Math.max(3, chars)) + '...'
      }
      titleText.x = -titleText.width / 2
      titleText.y = densityBarY - titleText.height / 2
      sliceContainer.addChild(titleText)
    }

    // Hit area
    const hitArea = new Graphics()
    hitArea.rect(-blockWidth / 2 - 4, densityBarY - L1_DENSITY_BAR_HEIGHT / 2, blockWidth + 8, L1_DENSITY_BAR_HEIGHT)
    hitArea.fill({ color: 0x000000, alpha: 0 })
    sliceContainer.addChild(hitArea)

    // Tooltip for multi-day event
    const tooltip = new Container()
    tooltip.visible = false

    const startDate = new Date(event.startAt).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' })
    const endDate = event.endAt ? new Date(event.endAt).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' }) : startDate
    const dateRangeText = startDate === endDate ? startDate : `${startDate} - ${endDate}`

    // Count items in this event
    const itemCount = memories.filter(m => m.eventId === event.id).length

    let currentY = 8

    const tooltipTitle = new Text({
      text: event.title || 'Untitled',
      style: new TextStyle({
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        fontSize: 12,
        fontWeight: '600',
        fill: 0xffffff,
      }),
      resolution: TEXT_RESOLUTION,
    })
    tooltipTitle.x = 8
    tooltipTitle.y = currentY
    currentY += tooltipTitle.height + 4

    const dateText = new Text({
      text: `📅 ${dateRangeText}`,
      style: new TextStyle({
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        fontSize: 10,
        fill: 0x88aacc,
      }),
      resolution: TEXT_RESOLUTION,
    })
    dateText.x = 8
    dateText.y = currentY
    currentY += dateText.height + 4

    const countText = new Text({
      text: `📷 ${itemCount} item${itemCount !== 1 ? 's' : ''}`,
      style: new TextStyle({
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        fontSize: 10,
        fill: 0x888888,
      }),
      resolution: TEXT_RESOLUTION,
    })
    countText.x = 8
    countText.y = currentY
    currentY += countText.height + 8

    const tooltipWidth = 180
    const tooltipHeight = currentY

    const tooltipBg = new Graphics()
    tooltipBg.roundRect(0, 0, tooltipWidth, tooltipHeight, 6)
    tooltipBg.fill({ color: 0x1a1a2e })
    tooltipBg.stroke({ width: 1, color: multiDayEventColor })

    tooltip.addChild(tooltipBg)
    tooltip.addChild(tooltipTitle)
    tooltip.addChild(dateText)
    tooltip.addChild(countText)
    tooltip.x = centerX - tooltipWidth / 2
    tooltip.y = densityBarY - L1_DENSITY_BAR_HEIGHT / 2 - tooltipHeight - 8

    tooltipLayer.addChild(tooltip)

    // Hover effects
    sliceContainer.on('pointerover', () => {
      slice.clear()
      slice.roundRect(-blockWidth / 2, densityBarY - L1_DENSITY_BAR_HEIGHT / 2 + 4, blockWidth, L1_DENSITY_BAR_HEIGHT - 8, 6)
      slice.fill({ color: multiDayEventColor, alpha: 0.9 })
      slice.stroke({ width: 2, color: 0xffffff, alpha: 0.8 })
      tooltip.visible = true

      // Show event label
      const labelContainer = labelContainersByEventId.get(event.id)
      if (labelContainer) {
        labelContainer.alpha = 1
      }
    })

    sliceContainer.on('pointerout', () => {
      slice.clear()
      slice.roundRect(-blockWidth / 2, densityBarY - L1_DENSITY_BAR_HEIGHT / 2 + 4, blockWidth, L1_DENSITY_BAR_HEIGHT - 8, 6)
      slice.fill({ color: multiDayEventColor, alpha: 0.7 })
      slice.stroke({ width: 2, color: multiDayEventColor, alpha: 1 })
      tooltip.visible = false

      // Hide event label
      const labelContainer = labelContainersByEventId.get(event.id)
      if (labelContainer) {
        labelContainer.alpha = 0
      }
    })

    // Click to open event
    sliceContainer.on('pointertap', () => {
      onEventClick(event, centerX)
    })

    container.addChild(sliceContainer)
  })

  // ======= Layer 5: Events without memories (show as blocks - they're containers) =======
  // Events with date ranges show as wider blocks spanning their duration
  const clustersWithMemoriesIds = new Set(clustersWithMemories.map(c => c.event.id))
  const eventsWithoutMemories = childEvents.filter(e => !clustersWithMemoriesIds.has(e.id) && !multiDayEventIds.has(e.id))


  // Render empty events as blocks (different color to indicate they're containers)
  const emptyEventColor = 0x5d7aa0  // Blue-ish to differentiate from memory types

  eventsWithoutMemories.forEach((event) => {
    const startTimestamp = new Date(event.startAt).getTime()
    const startX = timestampToX(startTimestamp)

    // If event has endAt, calculate width to span the date range
    let blockWidth = sliceWidth  // Default to slice width
    let centerX = startX

    if (event.endAt) {
      const endTimestamp = new Date(event.endAt).getTime()
      const endX = timestampToX(endTimestamp)
      blockWidth = Math.max(sliceWidth, endX - startX)  // At least slice width
      centerX = startX + blockWidth / 2
    }

    const sliceContainer = new Container()
    sliceContainer.x = centerX
    sliceContainer.eventMode = 'static'
    sliceContainer.cursor = 'pointer'

    // Block with outlined style to indicate it's a container
    const slice = new Graphics()
    slice.roundRect(
      -blockWidth / 2,
      densityBarY - L1_DENSITY_BAR_HEIGHT / 2 + 4,
      blockWidth,
      L1_DENSITY_BAR_HEIGHT - 8,
      blockWidth > sliceWidth ? 6 : 2  // Rounder corners for wider blocks
    )
    slice.fill({ color: emptyEventColor, alpha: 0.4 })
    slice.stroke({ width: 1, color: emptyEventColor, alpha: 0.8 })
    sliceContainer.addChild(slice)

    // Hit area
    const hitArea = new Graphics()
    hitArea.rect(-blockWidth / 2 - 4, densityBarY - L1_DENSITY_BAR_HEIGHT / 2, blockWidth + 8, L1_DENSITY_BAR_HEIGHT)
    hitArea.fill({ color: 0x000000, alpha: 0 })
    sliceContainer.addChild(hitArea)

    // Tooltip
    const tooltip = new Container()
    tooltip.visible = false

    const tooltipTitle = event.title || 'Untitled'
    const tooltipLocation = event.location?.label || ''
    const tooltipDescription = event.description
      ? (event.description.length > 60 ? event.description.slice(0, 60) + '...' : event.description)
      : ''

    // Show date range in tooltip if event spans multiple days
    let dateRangeText = 'Lege container'
    if (event.endAt && event.startAt !== event.endAt) {
      const startDate = new Date(event.startAt).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' })
      const endDate = new Date(event.endAt).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' })
      dateRangeText = `${startDate} - ${endDate}`
    }

    let currentY = 8

    const titleText = new Text({
      text: tooltipTitle,
      style: new TextStyle({
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        fontSize: 12,
        fontWeight: '600',
        fill: 0xffffff,
      }),
      resolution: TEXT_RESOLUTION,
    })
    titleText.x = 8
    titleText.y = currentY
    currentY += titleText.height + 4

    // Location label (if available)
    let locationText: Text | null = null
    if (tooltipLocation) {
      locationText = new Text({
        text: `📍 ${tooltipLocation}`,
        style: new TextStyle({
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
          fontSize: 10,
          fill: 0x888888,
        }),
        resolution: TEXT_RESOLUTION,
      })
      locationText.x = 8
      locationText.y = currentY
      currentY += locationText.height + 4
    }

    // Description (if available)
    let descriptionText: Text | null = null
    if (tooltipDescription) {
      descriptionText = new Text({
        text: tooltipDescription,
        style: new TextStyle({
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
          fontSize: 10,
          fontStyle: 'italic',
          fill: 0xaaaaaa,
          wordWrap: true,
          wordWrapWidth: 180,
        }),
        resolution: TEXT_RESOLUTION,
      })
      descriptionText.x = 8
      descriptionText.y = currentY
      currentY += descriptionText.height + 4
    }

    // Date range text
    const emptyText = new Text({
      text: dateRangeText,
      style: new TextStyle({
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        fontSize: 10,
        fill: 0x888899,
      }),
      resolution: TEXT_RESOLUTION,
    })
    emptyText.x = 8
    emptyText.y = currentY
    currentY += emptyText.height + 8

    const tooltipWidth = Math.max(120, Math.max(titleText.width, descriptionText?.width || 0) + 16, 200)
    const tooltipHeight = currentY

    const tooltipBg = new Graphics()
    tooltipBg.roundRect(0, 0, tooltipWidth, tooltipHeight, 6)
    tooltipBg.fill({ color: 0x1a1a2e })
    tooltipBg.stroke({ width: 1, color: emptyEventColor })

    tooltip.addChild(tooltipBg)
    tooltip.addChild(titleText)
    if (locationText) tooltip.addChild(locationText)
    if (descriptionText) tooltip.addChild(descriptionText)
    tooltip.addChild(emptyText)
    tooltip.x = centerX - tooltipWidth / 2  // Position relative to main container
    tooltip.y = densityBarY - L1_DENSITY_BAR_HEIGHT / 2 - tooltipHeight - 8

    // Add to tooltip layer (on top of everything)
    tooltipLayer.addChild(tooltip)

    // Hover effects
    sliceContainer.on('pointerover', () => {
      slice.clear()
      slice.roundRect(-blockWidth / 2, densityBarY - L1_DENSITY_BAR_HEIGHT / 2 + 4, blockWidth, L1_DENSITY_BAR_HEIGHT - 8, blockWidth > sliceWidth ? 6 : 2)
      slice.fill({ color: emptyEventColor, alpha: 0.6 })
      slice.stroke({ width: 1, color: 0xffffff, alpha: 0.5 })
      tooltip.visible = true
    })

    sliceContainer.on('pointerout', () => {
      slice.clear()
      slice.roundRect(-blockWidth / 2, densityBarY - L1_DENSITY_BAR_HEIGHT / 2 + 4, blockWidth, L1_DENSITY_BAR_HEIGHT - 8, blockWidth > sliceWidth ? 6 : 2)
      slice.fill({ color: emptyEventColor, alpha: 0.4 })
      slice.stroke({ width: 1, color: emptyEventColor, alpha: 0.8 })
      tooltip.visible = false
    })

    // Click to open event
    sliceContainer.on('pointertap', () => {
      onEventClick(event, centerX)
    })

    container.addChild(sliceContainer)
  })

  // ======= Layer 6: Tooltip Layer (on top of everything) =======
  container.addChild(tooltipLayer)

  // Return content bounds (based on effective width)
  const padding = 100
  return {
    minX: -effectiveWidth / 2 - padding,
    maxX: effectiveWidth / 2 + padding
  }
}

// ============ L2 View: Event Canvas ============

function buildL2View(
  container: Container,
  event: Event,
  isDraggingItemRef: React.MutableRefObject<boolean>,
  onItemClick?: (item: Item) => void,
  onAddClick?: () => void,
  onDeleteItem?: (item: Item) => void,
  onEditItem?: (item: Item) => void,
  cullingManager?: ViewportCullingManager | null,
  itemDataMap?: Map<string, { item: Item; canvasItem: CanvasItem | null; textScale?: number }>
) {
  // Get items for this event
  const items = getItemsByEvent(event.id)
  const canvasItems = getCanvasItems(event.id)

  // Create a map for quick canvas item lookup
  const canvasMap = new Map<string, CanvasItem>()
  canvasItems.forEach(ci => canvasMap.set(ci.itemId, ci))

  // Empty state
  if (items.length === 0) {
    const emptyContainer = new Container()

    // Plus icon - make it interactive
    const iconContainer = new Container()
    iconContainer.eventMode = 'static'
    iconContainer.cursor = 'pointer'

    const icon = new Graphics()
    const iconSize = 32
    const iconColor = 0x555566
    const iconHoverColor = 0x5d7aa0

    const drawIcon = (color: number) => {
      icon.clear()
      icon.circle(0, 0, iconSize)
      icon.stroke({ width: 2, color })
      icon.moveTo(-iconSize * 0.4, 0)
      icon.lineTo(iconSize * 0.4, 0)
      icon.stroke({ width: 2, color })
      icon.moveTo(0, -iconSize * 0.4)
      icon.lineTo(0, iconSize * 0.4)
      icon.stroke({ width: 2, color })
    }

    drawIcon(iconColor)
    iconContainer.addChild(icon)

    // Hit area for easier clicking
    const hitArea = new Graphics()
    hitArea.circle(0, 0, iconSize + 10)
    hitArea.fill({ color: 0x000000, alpha: 0 })
    iconContainer.addChild(hitArea)

    iconContainer.on('pointerover', () => drawIcon(iconHoverColor))
    iconContainer.on('pointerout', () => drawIcon(iconColor))

    // Prevent the click from propagating to canvas (which would navigate back)
    iconContainer.on('pointerdown', (e) => {
      e.stopPropagation()
      isDraggingItemRef.current = true  // Prevents handlePointerUp from navigating
    })
    iconContainer.on('pointertap', (e) => {
      e.stopPropagation()
      isDraggingItemRef.current = false
      if (onAddClick) onAddClick()
    })
    iconContainer.on('pointerup', () => {
      isDraggingItemRef.current = false
    })
    iconContainer.on('pointerupoutside', () => {
      isDraggingItemRef.current = false
    })

    iconContainer.y = -50
    emptyContainer.addChild(iconContainer)

    const emptyTitle = new Text({
      text: 'No items yet',
      style: new TextStyle({
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        fontSize: 24,
        fontWeight: '600',
        fill: 0x555566,
      }),
      resolution: TEXT_RESOLUTION,
    })
    emptyTitle.x = -emptyTitle.width / 2
    emptyTitle.y = 10
    emptyContainer.addChild(emptyTitle)

    const emptyHint = new Text({
      text: 'Click + to add your first memory',
      style: new TextStyle({
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        fontSize: 16,
        fill: 0x444455,
      }),
      resolution: TEXT_RESOLUTION,
    })
    emptyHint.x = -emptyHint.width / 2
    emptyHint.y = 50
    emptyContainer.addChild(emptyHint)

    container.addChild(emptyContainer)
    return
  }

  // Layout items on canvas
  // If no canvas positions, create a simple grid layout
  const cols = Math.ceil(Math.sqrt(items.length))
  const gridWidth = cols * (CANVAS_ITEM_WIDTH + 24)
  const gridHeight = Math.ceil(items.length / cols) * (CANVAS_ITEM_HEIGHT + 24)

  // Clear existing item data
  if (itemDataMap) {
    itemDataMap.clear()
  }

  // If culling manager is available, use viewport culling
  if (cullingManager && itemDataMap) {
    cullingManager.clearItems()

    items.forEach((item, index) => {
      const canvasItem = canvasMap.get(item.id) || null

      let x: number, y: number, scale: number, textScale: number | undefined

      if (canvasItem) {
        x = canvasItem.x
        y = canvasItem.y
        scale = canvasItem.scale
        textScale = canvasItem.textScale
      } else {
        const col = index % cols
        const row = Math.floor(index / cols)
        x = -gridWidth / 2 + col * (CANVAS_ITEM_WIDTH + 24) + CANVAS_ITEM_WIDTH / 2
        y = -gridHeight / 2 + row * (CANVAS_ITEM_HEIGHT + 24) + CANVAS_ITEM_HEIGHT / 2
        scale = 1
        textScale = undefined
      }

      // Store item data for later block creation
      itemDataMap.set(item.id, { item, canvasItem, textScale })

      // Register item bounds with culling manager
      cullingManager.registerItem({
        id: item.id,
        x,
        y,
        width: CANVAS_ITEM_WIDTH,
        height: CANVAS_ITEM_HEIGHT,
        scale,
      })
    })

    // Items will be rendered by culling manager on viewport update
    return
  }

  // Fallback: render all items immediately (no culling)
  items.forEach((item, index) => {
    const canvasItem = canvasMap.get(item.id)

    let x: number, y: number, scale: number, rotation: number, textScale: number | undefined

    if (canvasItem) {
      // Use stored position
      x = canvasItem.x
      y = canvasItem.y
      scale = canvasItem.scale
      rotation = canvasItem.rotation
      textScale = canvasItem.textScale
    } else {
      // Default grid layout
      const col = index % cols
      const row = Math.floor(index / cols)
      x = -gridWidth / 2 + col * (CANVAS_ITEM_WIDTH + 24) + CANVAS_ITEM_WIDTH / 2
      y = -gridHeight / 2 + row * (CANVAS_ITEM_HEIGHT + 24) + CANVAS_ITEM_HEIGHT / 2
      scale = 1
      rotation = 0
      textScale = undefined
    }

    const zIndex = canvasItem?.zIndex ?? 0
    const cardWidth = canvasItem?.width ?? CANVAS_ITEM_WIDTH
    const cardHeight = canvasItem?.height ?? CANVAS_ITEM_HEIGHT
    const itemBlock = createCanvasItemBlock(item, event.id, isDraggingItemRef, onItemClick, onDeleteItem, onEditItem, textScale, scale, zIndex, cardWidth, cardHeight)
    itemBlock.x = x
    itemBlock.y = y
    itemBlock.scale.set(scale)
    itemBlock.rotation = rotation
    container.addChild(itemBlock)
  })
}

// Helper to save canvas item both in-memory and to files (async)
function saveCanvasItemPosition(canvasItem: CanvasItem): void {
  // Always update in-memory SQLite immediately (for responsiveness)
  upsertCanvasItem(canvasItem)

  // If file storage is configured, also save to files asynchronously
  if (hasStorageFolder()) {
    // Get item slug for file-based storage
    const item = getItemById(canvasItem.itemId)
    const canvasItemWithSlug = {
      ...canvasItem,
      itemSlug: item?.slug,
    }
    updateCanvasItemWithFiles(canvasItemWithSlug).catch(err => {
      console.error('Failed to save canvas item to files:', err)
    })
  }
}

function createCanvasItemBlock(
  item: Item,
  eventId: string,
  isDraggingItemRef: React.MutableRefObject<boolean>,
  onItemClick?: (item: Item) => void,
  _onDeleteItem?: (item: Item) => void,  // Unused - delete is in detail view
  _onEditItem?: (item: Item) => void,    // Unused - edit is in detail view
  textScale?: number,  // For text items: inner text scale (used with ctrl+resize)
  itemScale: number = 1,  // Canvas item scale, used to determine thumbnail size
  initialZIndex: number = 0,  // Original zIndex to preserve when saving
  cardWidth: number = CANVAS_ITEM_WIDTH,  // Custom card width (default: 200)
  cardHeight: number = CANVAS_ITEM_HEIGHT  // Custom card height (default: 150)
): Container {
  const cont = new Container()
  cont.pivot.set(cardWidth / 2, cardHeight / 2)
  cont.eventMode = 'static'
  cont.cursor = 'pointer'

  // Current card dimensions (can be changed by edge resize)
  let currentWidth = cardWidth
  let currentHeight = cardHeight

  // References to controls that need to be on top after async image load
  let resizeHandleRef: Container | null = null

  // References for elements that need updating during resize
  let textMaskRef: Graphics | null = null
  let dateTextRef: Text | null = null

  // Store item type for reference
  const isPhotoOrVideo = item.itemType === 'photo' || item.itemType === 'video'

  // Background based on item type
  const bg = new Graphics()
  bg.roundRect(0, 0, cardWidth, cardHeight, 6)

  let bgColor = 0x1a2a3e
  let borderColor = 0x3d5a80

  if (item.itemType === 'text') {
    bgColor = 0x2a2a3e
    borderColor = 0x5d5a80
  } else if (item.itemType === 'photo') {
    bgColor = 0x111111  // Dark background for photos (shows during load)
    borderColor = 0x3d8060
  } else if (item.itemType === 'video') {
    bgColor = 0x111111
    borderColor = 0x806040
  } else if (item.itemType === 'link') {
    bgColor = 0x1a2a3a
    borderColor = 0x4080a0
  } else if (item.itemType === 'audio') {
    bgColor = 0x2a1a2a
    borderColor = 0xE91E63
  }

  bg.fill({ color: bgColor })
  if (!isPhotoOrVideo) {
    bg.stroke({ width: 1, color: borderColor })
  }
  cont.addChild(bg)

  // Hover overlay for photo/video - title/caption with drop shadow
  let hoverOverlay: Container | null = null
  if (isPhotoOrVideo) {
    hoverOverlay = new Container()
    hoverOverlay.alpha = 0  // Hidden by default

    // Gradient background at bottom
    const overlayBg = new Graphics()
    overlayBg.rect(0, cardHeight - 50, cardWidth, 50)
    overlayBg.fill({ color: 0x000000, alpha: 0.7 })
    hoverOverlay.addChild(overlayBg)

    // Title/caption text with drop shadow effect
    const displayText = item.caption || 'Foto'
    const truncatedText = displayText.length > 30 ? displayText.slice(0, 30) + '...' : displayText

    // Shadow text (black, offset)
    const shadowText = new Text({
      text: truncatedText,
      style: new TextStyle({
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        fontSize: 13,
        fontWeight: '600',
        fill: 0x000000,
      }),
      resolution: TEXT_RESOLUTION,
    })
    shadowText.x = 13
    shadowText.y = cardHeight - 35
    hoverOverlay.addChild(shadowText)

    // Main text (white)
    const mainText = new Text({
      text: truncatedText,
      style: new TextStyle({
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        fontSize: 13,
        fontWeight: '600',
        fill: 0xffffff,
      }),
      resolution: TEXT_RESOLUTION,
    })
    mainText.x = 12
    mainText.y = cardHeight - 36
    hoverOverlay.addChild(mainText)

    // Add after image is loaded (will be added later)
  }

  // Content preview - different display based on item type
  if (item.itemType === 'photo' || item.itemType === 'video') {
    // For media, try to load and display the actual image
    const isDataUrl = item.content && item.content.startsWith('data:')
    const isFileRef = item.content && item.content.startsWith('file:')

    if (isDataUrl || isFileRef) {
      // Create a placeholder container for the image (fills entire card)
      const imageContainer = new Container()
      imageContainer.x = 0
      imageContainer.y = 0
      cont.addChild(imageContainer)

      // Photo fills entire card - card will be sized to match photo's aspect ratio
      // Base area to maintain similar visual weight across different aspect ratios
      const BASE_CARD_AREA = CANVAS_ITEM_WIDTH * CANVAS_ITEM_HEIGHT  // 30000

      // Initial dimensions (will be updated after image loads)
      let cardWidth = CANVAS_ITEM_WIDTH
      let cardHeight = CANVAS_ITEM_HEIGHT

      // Function to display the image once bitmap is ready
      // Uses ImageBitmap which is hardware-accelerated and decoded on separate thread
      const displayImageFromBitmap = (bitmap: ImageBitmap) => {
        try {
          const texture = Texture.from(bitmap)
          const sprite = new Sprite(texture)

          // Get actual image dimensions from bitmap
          const imgWidth = bitmap.width
          const imgHeight = bitmap.height
          const aspectRatio = imgWidth / imgHeight

          console.log(`[Card] Image ${item.id}: ${imgWidth}x${imgHeight}, ratio=${aspectRatio.toFixed(2)}`)

          // Calculate card dimensions that match photo's aspect ratio
          // while maintaining similar total area for visual consistency
          // cardWidth * cardHeight = BASE_CARD_AREA
          // cardWidth / cardHeight = aspectRatio
          // => cardWidth = sqrt(BASE_CARD_AREA * aspectRatio)
          // => cardHeight = sqrt(BASE_CARD_AREA / aspectRatio)
          cardWidth = Math.round(Math.sqrt(BASE_CARD_AREA * aspectRatio))
          cardHeight = Math.round(Math.sqrt(BASE_CARD_AREA / aspectRatio))

          // Clamp to reasonable min/max dimensions
          const MIN_DIM = 100
          const MAX_DIM = 300
          if (cardWidth < MIN_DIM) {
            cardWidth = MIN_DIM
            cardHeight = Math.round(cardWidth / aspectRatio)
          } else if (cardWidth > MAX_DIM) {
            cardWidth = MAX_DIM
            cardHeight = Math.round(cardWidth / aspectRatio)
          }
          if (cardHeight < MIN_DIM) {
            cardHeight = MIN_DIM
            cardWidth = Math.round(cardHeight * aspectRatio)
          } else if (cardHeight > MAX_DIM) {
            cardHeight = MAX_DIM
            cardWidth = Math.round(cardHeight * aspectRatio)
          }

          console.log(`[Card] New dimensions: ${cardWidth}x${cardHeight}`)

          // Update container pivot for new dimensions
          cont.pivot.set(cardWidth / 2, cardHeight / 2)

          // Hide the initial background - the image fills the card with rounded mask
          // No need for a visible background behind the image
          bg.visible = false
          console.log(`[Card] Background hidden, image fills card`)

          // Update hover overlay position and size
          if (hoverOverlay) {
            const overlayBg = hoverOverlay.children[0] as Graphics
            if (overlayBg) {
              overlayBg.clear()
              overlayBg.rect(0, cardHeight - 50, cardWidth, 50)
              overlayBg.fill({ color: 0x000000, alpha: 0.7 })
            }
            // Move text elements
            for (let i = 1; i < hoverOverlay.children.length; i++) {
              const textEl = hoverOverlay.children[i] as Text
              if (textEl) {
                textEl.y = cardHeight - 36 + (i === 1 ? 1 : 0)
              }
            }
          }

          // Scale sprite to exactly fill the card (no cropping needed since aspect ratios match)
          sprite.width = cardWidth
          sprite.height = cardHeight
          sprite.x = 0
          sprite.y = 0

          // Add rounded corners mask for entire card
          const mask = new Graphics()
          mask.roundRect(0, 0, cardWidth, cardHeight, 6)
          mask.fill({ color: 0xffffff })
          sprite.mask = mask

          imageContainer.addChild(mask)
          imageContainer.addChild(sprite)

          // Add the hover overlay on top of the image
          if (hoverOverlay) {
            cont.addChild(hoverOverlay)
          }

          // Video play overlay
          if (item.itemType === 'video') {
            const playOverlay = new Graphics()
            const centerX = cardWidth / 2
            const centerY = cardHeight / 2
            playOverlay.circle(centerX, centerY, 24)
            playOverlay.fill({ color: 0x000000, alpha: 0.6 })
            playOverlay.moveTo(centerX - 8, centerY - 12)
            playOverlay.lineTo(centerX - 8, centerY + 12)
            playOverlay.lineTo(centerX + 12, centerY)
            playOverlay.closePath()
            playOverlay.fill({ color: 0xffffff })
            cont.addChild(playOverlay)
          }

          // Reposition resize handle for the actual card dimensions
          if (resizeHandleRef) {
            resizeHandleRef.x = cardWidth - 20
            resizeHandleRef.y = cardHeight - 20
          }

          // Re-add resize handle on top after image loads
          // This ensures it's always visible above the image and overlays
          if (resizeHandleRef) {
            cont.removeChild(resizeHandleRef)
            cont.addChild(resizeHandleRef)
          }
        } catch (err) {
          console.warn('Failed to create texture:', err)
        }
      }

      // Load and decode image using createImageBitmap for hardware-accelerated decoding
      // This happens on a separate thread and is much faster than new Image() + onload
      const loadImageAsync = async () => {
        try {
          let blob: Blob | null = null
          let filePath: string = ''

          if (isFileRef) {
            // Parse file path: "file:2024/Event/photo.jpg"
            filePath = item.content!.replace('file:', '')
            const pathParts = filePath.split('/')
            const fileName = pathParts.pop()!
            const dirPath = pathParts

            // Get blob directly from file system
            blob = await readFileAsBlob(dirPath, fileName)
          } else if (isDataUrl) {
            // Convert data URL to blob
            const response = await fetch(item.content!)
            blob = await response.blob()
            filePath = `dataurl:${item.id}`
          }

          if (!blob) {
            console.warn('Failed to load image blob for item:', item.id)
            return
          }

          // Determine thumbnail size based on canvas item scale
          // Small items use medium thumbnails, larger items use large thumbnails
          let thumbnailSize: ThumbnailSize = 'medium'  // 256px - good for most canvas views
          if (itemScale > 1.5) {
            thumbnailSize = 'large'  // 1024px - for zoomed in items
          }

          // Get thumbnail (from cache or generate new)
          // This is hardware-accelerated and cached in IndexedDB
          const bitmap = await getThumbnail(filePath, blob, thumbnailSize)
          displayImageFromBitmap(bitmap)
        } catch (err) {
          console.warn('Failed to decode image for item:', item.id, err)
        }
      }

      // Start async loading (don't await - let it complete in background)
      loadImageAsync()
    } else {
      // No content or not base64 - show placeholder
      const mediaIcon = new Graphics()
      const iconCenterX = cardWidth / 2
      const iconCenterY = 70

      if (item.itemType === 'photo') {
        mediaIcon.roundRect(iconCenterX - 24, iconCenterY - 16, 48, 32, 4)
        mediaIcon.stroke({ width: 2, color: borderColor })
        mediaIcon.circle(iconCenterX - 8, iconCenterY - 4, 4)
        mediaIcon.fill({ color: borderColor })
      } else {
        mediaIcon.circle(iconCenterX, iconCenterY, 20)
        mediaIcon.stroke({ width: 2, color: borderColor })
        mediaIcon.moveTo(iconCenterX - 6, iconCenterY - 10)
        mediaIcon.lineTo(iconCenterX - 6, iconCenterY + 10)
        mediaIcon.lineTo(iconCenterX + 10, iconCenterY)
        mediaIcon.closePath()
        mediaIcon.fill({ color: borderColor })
      }
      cont.addChild(mediaIcon)
    }
  }

  // Text content reference for resize modes (null for non-text items)
  let _contentTextRef: Text | null = null  // Will be used for ctrl+resize and auto-size
  const isTextItem = item.itemType === 'text'

  if (!isPhotoOrVideo) {
    // Text and link - show content preview
    // For text items, content is in bodyText (file-based) or content (legacy)
    const textContent = item.bodyText || item.content || ''

    // Use the actual text content for display
    const displayText = textContent || 'Geen tekst'

    const contentText = new Text({
      text: displayText,
      style: new TextStyle({
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        fontSize: 13,
        fill: 0xddddee,
        wordWrap: true,
        wordWrapWidth: cardWidth - 24,
        lineHeight: 18,
      }),
      resolution: TEXT_RESOLUTION,
    })
    contentText.x = 12
    contentText.y = 12

    // Create a mask to clip text content within card bounds
    // Leave space at bottom for resize handles
    const textMask = new Graphics()
    textMask.rect(0, 0, cardWidth, cardHeight - 20)
    textMask.fill({ color: 0xffffff })
    contentText.mask = textMask
    cont.addChild(textMask)
    cont.addChild(contentText)
    textMaskRef = textMask

    // Store reference for text items (will be used for ctrl+resize and auto-size)
    if (isTextItem) {
      _contentTextRef = contentText

      // Apply saved textScale if provided (from ctrl+resize)
      // Note: textScale can be null/undefined, only apply if it's a valid number different from 1
      if (textScale != null && textScale !== 1) {
        contentText.scale.set(textScale)
        // Also update wordWrapWidth to match (inverse relationship with textScale)
        // When textScale is small (e.g., 0.5), the card is big, so wordWrap should be wider
        const effectiveCardScale = 1 / textScale  // This is what the card scale was
        const newWordWrapWidth = (cardWidth - 24) * effectiveCardScale
        contentText.style.wordWrapWidth = newWordWrapWidth
      }
    }
  }

  // Bottom section: caption or date (not for photo/video - they have hover overlay)
  // For text-like items, use isTextLikeItem check
  const isTextLikeItem = item.itemType === 'text' || item.itemType === 'link' || item.itemType === 'audio'
  if (!isPhotoOrVideo) {
    const bottomY = cardHeight - 28

    // Only show caption for non-text items (text items show content directly)
    if (item.caption && !isTextLikeItem) {
      const captionText = new Text({
        text: item.caption.length > 30 ? item.caption.slice(0, 30) + '...' : item.caption,
        style: new TextStyle({
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
          fontSize: 11,
          fill: 0x888899,
          wordWrap: true,
          wordWrapWidth: cardWidth - 60,
        }),
        resolution: TEXT_RESOLUTION,
      })
      captionText.x = 12
      captionText.y = bottomY
      cont.addChild(captionText)
    }

    // Date indicator (bottom-right, moved left a bit to avoid resize handle)
    if (item.happenedAt) {
      const dateStr = new Date(item.happenedAt).toLocaleDateString('nl-NL', {
        day: 'numeric',
        month: 'short',
      })
      const dateText = new Text({
        text: dateStr,
        style: new TextStyle({
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
          fontSize: 10,
          fill: 0x666677,
        }),
        resolution: TEXT_RESOLUTION,
      })
      dateText.x = cardWidth - dateText.width - 35  // More space to avoid overlap
      dateText.y = bottomY + 2
      cont.addChild(dateText)
      dateTextRef = dateText
    }
  }

  // Resize handle (bottom-right corner) - for scale only
  const resizeHandle = new Container()
  resizeHandle.x = cardWidth - 20
  resizeHandle.y = cardHeight - 20
  resizeHandle.eventMode = 'static'
  resizeHandle.cursor = 'nwse-resize'
  resizeHandle.alpha = 0  // Hidden by default

  const resizeIcon = new Graphics()
  // Draw resize grip lines
  resizeIcon.moveTo(4, 16)
  resizeIcon.lineTo(16, 4)
  resizeIcon.stroke({ width: 2, color: 0x666688, alpha: 0.8 })
  resizeIcon.moveTo(8, 16)
  resizeIcon.lineTo(16, 8)
  resizeIcon.stroke({ width: 2, color: 0x666688, alpha: 0.8 })
  resizeIcon.moveTo(12, 16)
  resizeIcon.lineTo(16, 12)
  resizeIcon.stroke({ width: 2, color: 0x666688, alpha: 0.8 })
  resizeHandle.addChild(resizeIcon)

  // Hit area for resize handle
  const resizeHitArea = new Graphics()
  resizeHitArea.rect(0, 0, 20, 20)
  resizeHitArea.fill({ color: 0x000000, alpha: 0 })
  resizeHandle.addChild(resizeHitArea)

  // Resize drag data
  let resizeDragData: { startX: number; startY: number; startScale: number; ctrlKey: boolean } | null = null

  resizeHandle.on('pointerdown', (e) => {
    e.stopPropagation()
    if (!cont.parent) return
    const pos = e.getLocalPosition(cont.parent)
    resizeDragData = {
      startX: pos.x,
      startY: pos.y,
      startScale: cont.scale.x,
      ctrlKey: e.ctrlKey || e.metaKey,  // Track if ctrl/cmd was held at start
    }
    isDraggingItemRef.current = true
  })

  resizeHandle.on('globalpointermove', (e) => {
    if (resizeDragData && cont.parent) {
      const pos = e.getLocalPosition(cont.parent)
      // Calculate distance from start position
      const dx = pos.x - resizeDragData.startX
      const dy = pos.y - resizeDragData.startY
      // Use the average of dx and dy for uniform scaling
      const delta = (dx + dy) / 2
      // Scale factor: 100 pixels of drag = 0.5 scale change
      const newScale = Math.max(0.3, Math.min(3, resizeDragData.startScale + delta / 200))
      cont.scale.set(newScale)

      // Ctrl+resize for text items: keep text size constant by applying inverse scale
      // Also update wordWrapWidth to match the new card size
      if (resizeDragData.ctrlKey && isTextItem && _contentTextRef) {
        const inverseScale = 1 / newScale
        _contentTextRef.scale.set(inverseScale)

        // Update wordWrapWidth based on new effective card width
        // The card scales by newScale, text scales by inverseScale, so effective width is:
        // (currentWidth * newScale) / inverseScale = currentWidth * newScale * newScale
        const newWordWrapWidth = (currentWidth - 24) * newScale
        _contentTextRef.style.wordWrapWidth = newWordWrapWidth
      }
    }
  })

  resizeHandle.on('pointerup', () => {
    if (resizeDragData) {
      // Save the new scale (and text scale if ctrl+resize was used)
      saveCanvasItemPosition({
        eventId,
        itemId: item.id,
        x: cont.x,
        y: cont.y,
        scale: cont.scale.x,
        rotation: cont.rotation,
        zIndex: initialZIndex,
        textScale: _contentTextRef ? _contentTextRef.scale.x : undefined,
        width: currentWidth,
        height: currentHeight,
      })
      resizeDragData = null
      isDraggingItemRef.current = false
    }
  })

  resizeHandle.on('pointerupoutside', () => {
    if (resizeDragData) {
      saveCanvasItemPosition({
        eventId,
        itemId: item.id,
        x: cont.x,
        y: cont.y,
        scale: cont.scale.x,
        rotation: cont.rotation,
        zIndex: initialZIndex,
        textScale: _contentTextRef ? _contentTextRef.scale.x : undefined,
        width: currentWidth,
        height: currentHeight,
      })
      resizeDragData = null
      isDraggingItemRef.current = false
    }
  })

  cont.addChild(resizeHandle)
  resizeHandleRef = resizeHandle  // Store reference for async re-ordering

  // Right edge resize handle (for width only)
  const rightEdge = new Container()
  rightEdge.x = cardWidth - 6
  rightEdge.y = cardHeight / 2 - 20
  rightEdge.eventMode = 'static'
  rightEdge.cursor = 'ew-resize'
  rightEdge.alpha = 0  // Hidden by default

  const rightEdgeIcon = new Graphics()
  rightEdgeIcon.rect(0, 0, 6, 40)
  rightEdgeIcon.fill({ color: 0x666688, alpha: 0.6 })
  // Add grip lines
  rightEdgeIcon.moveTo(2, 10)
  rightEdgeIcon.lineTo(2, 30)
  rightEdgeIcon.stroke({ width: 1, color: 0x888899, alpha: 0.8 })
  rightEdgeIcon.moveTo(4, 10)
  rightEdgeIcon.lineTo(4, 30)
  rightEdgeIcon.stroke({ width: 1, color: 0x888899, alpha: 0.8 })
  rightEdge.addChild(rightEdgeIcon)

  // Right edge drag data
  let rightEdgeDragData: { startX: number; startWidth: number } | null = null

  rightEdge.on('pointerdown', (e) => {
    e.stopPropagation()
    if (!cont.parent) return
    const pos = e.getLocalPosition(cont.parent)
    rightEdgeDragData = {
      startX: pos.x,
      startWidth: currentWidth,
    }
    isDraggingItemRef.current = true
  })

  rightEdge.on('globalpointermove', (e) => {
    if (rightEdgeDragData && cont.parent) {
      const pos = e.getLocalPosition(cont.parent)
      const dx = pos.x - rightEdgeDragData.startX
      const newWidth = Math.max(100, Math.min(400, rightEdgeDragData.startWidth + dx / cont.scale.x))

      // Update current dimensions
      currentWidth = newWidth

      // Redraw background
      bg.clear()
      bg.roundRect(0, 0, currentWidth, currentHeight, 6)
      bg.fill({ color: bgColor + 0x111111 })
      if (!isPhotoOrVideo) {
        bg.stroke({ width: 2, color: borderColor + 0x222222 })
      }

      // Update pivot
      cont.pivot.set(currentWidth / 2, currentHeight / 2)

      // Reposition all handles
      resizeHandle.x = currentWidth - 20
      rightEdge.x = currentWidth - 6
      bottomEdge.x = currentWidth / 2 - 20  // Keep centered

      // Update text mask
      if (textMaskRef) {
        textMaskRef.clear()
        textMaskRef.rect(0, 0, currentWidth, currentHeight - 20)
        textMaskRef.fill({ color: 0xffffff })
      }

      // Update text word wrap if text item
      if (_contentTextRef) {
        _contentTextRef.style.wordWrapWidth = currentWidth - 24
      }

      // Update date position
      if (dateTextRef) {
        dateTextRef.x = currentWidth - dateTextRef.width - 35
      }
    }
  })

  rightEdge.on('pointerup', () => {
    if (rightEdgeDragData) {
      saveCanvasItemPosition({
        eventId,
        itemId: item.id,
        x: cont.x,
        y: cont.y,
        scale: cont.scale.x,
        rotation: cont.rotation,
        zIndex: initialZIndex,
        textScale: _contentTextRef ? _contentTextRef.scale.x : undefined,
        width: currentWidth,
        height: currentHeight,
      })
      rightEdgeDragData = null
      isDraggingItemRef.current = false
    }
  })

  rightEdge.on('pointerupoutside', () => {
    if (rightEdgeDragData) {
      saveCanvasItemPosition({
        eventId,
        itemId: item.id,
        x: cont.x,
        y: cont.y,
        scale: cont.scale.x,
        rotation: cont.rotation,
        zIndex: initialZIndex,
        textScale: _contentTextRef ? _contentTextRef.scale.x : undefined,
        width: currentWidth,
        height: currentHeight,
      })
      rightEdgeDragData = null
      isDraggingItemRef.current = false
    }
  })

  cont.addChild(rightEdge)

  // Bottom edge resize handle (for height only)
  const bottomEdge = new Container()
  bottomEdge.x = cardWidth / 2 - 20
  bottomEdge.y = cardHeight - 6
  bottomEdge.eventMode = 'static'
  bottomEdge.cursor = 'ns-resize'
  bottomEdge.alpha = 0  // Hidden by default

  const bottomEdgeIcon = new Graphics()
  bottomEdgeIcon.rect(0, 0, 40, 6)
  bottomEdgeIcon.fill({ color: 0x666688, alpha: 0.6 })
  // Add grip lines
  bottomEdgeIcon.moveTo(10, 2)
  bottomEdgeIcon.lineTo(30, 2)
  bottomEdgeIcon.stroke({ width: 1, color: 0x888899, alpha: 0.8 })
  bottomEdgeIcon.moveTo(10, 4)
  bottomEdgeIcon.lineTo(30, 4)
  bottomEdgeIcon.stroke({ width: 1, color: 0x888899, alpha: 0.8 })
  bottomEdge.addChild(bottomEdgeIcon)

  // Bottom edge drag data
  let bottomEdgeDragData: { startY: number; startHeight: number } | null = null

  bottomEdge.on('pointerdown', (e) => {
    e.stopPropagation()
    if (!cont.parent) return
    const pos = e.getLocalPosition(cont.parent)
    bottomEdgeDragData = {
      startY: pos.y,
      startHeight: currentHeight,
    }
    isDraggingItemRef.current = true
  })

  bottomEdge.on('globalpointermove', (e) => {
    if (bottomEdgeDragData && cont.parent) {
      const pos = e.getLocalPosition(cont.parent)
      const dy = pos.y - bottomEdgeDragData.startY
      const newHeight = Math.max(80, Math.min(400, bottomEdgeDragData.startHeight + dy / cont.scale.x))

      // Update current dimensions
      currentHeight = newHeight

      // Redraw background
      bg.clear()
      bg.roundRect(0, 0, currentWidth, currentHeight, 6)
      bg.fill({ color: bgColor + 0x111111 })
      if (!isPhotoOrVideo) {
        bg.stroke({ width: 2, color: borderColor + 0x222222 })
      }

      // Update pivot
      cont.pivot.set(currentWidth / 2, currentHeight / 2)

      // Reposition all handles
      resizeHandle.x = currentWidth - 20
      resizeHandle.y = currentHeight - 20
      bottomEdge.y = currentHeight - 6
      rightEdge.y = currentHeight / 2 - 20  // Keep centered

      // Update text mask
      if (textMaskRef) {
        textMaskRef.clear()
        textMaskRef.rect(0, 0, currentWidth, currentHeight - 20)
        textMaskRef.fill({ color: 0xffffff })
      }

      // Update date position
      if (dateTextRef) {
        dateTextRef.y = currentHeight - 26
      }
    }
  })

  bottomEdge.on('pointerup', () => {
    if (bottomEdgeDragData) {
      saveCanvasItemPosition({
        eventId,
        itemId: item.id,
        x: cont.x,
        y: cont.y,
        scale: cont.scale.x,
        rotation: cont.rotation,
        zIndex: initialZIndex,
        textScale: _contentTextRef ? _contentTextRef.scale.x : undefined,
        width: currentWidth,
        height: currentHeight,
      })
      bottomEdgeDragData = null
      isDraggingItemRef.current = false
    }
  })

  bottomEdge.on('pointerupoutside', () => {
    if (bottomEdgeDragData) {
      saveCanvasItemPosition({
        eventId,
        itemId: item.id,
        x: cont.x,
        y: cont.y,
        scale: cont.scale.x,
        rotation: cont.rotation,
        zIndex: initialZIndex,
        textScale: _contentTextRef ? _contentTextRef.scale.x : undefined,
        width: currentWidth,
        height: currentHeight,
      })
      bottomEdgeDragData = null
      isDraggingItemRef.current = false
    }
  })

  cont.addChild(bottomEdge)

  // Hover effect - show resize handles on hover
  cont.on('pointerover', () => {
    bg.clear()
    bg.roundRect(0, 0, currentWidth, currentHeight, 6)
    bg.fill({ color: bgColor + 0x111111 })
    if (!isPhotoOrVideo) {
      bg.stroke({ width: 2, color: borderColor + 0x222222 })
    }
    resizeHandle.alpha = 1  // Show corner resize handle
    rightEdge.alpha = 1     // Show right edge resize handle
    bottomEdge.alpha = 1    // Show bottom edge resize handle
    if (hoverOverlay) {
      hoverOverlay.alpha = 1  // Show caption overlay for photos
    }
  })

  cont.on('pointerout', () => {
    bg.clear()
    bg.roundRect(0, 0, currentWidth, currentHeight, 6)
    bg.fill({ color: bgColor })
    if (!isPhotoOrVideo) {
      bg.stroke({ width: 1, color: borderColor })
    }
    resizeHandle.alpha = 0  // Hide corner resize handle
    rightEdge.alpha = 0     // Hide right edge resize handle
    bottomEdge.alpha = 0    // Hide bottom edge resize handle
    if (hoverOverlay) {
      hoverOverlay.alpha = 0  // Hide caption overlay for photos
    }
  })

  // Dragging support with click detection
  let dragData: { offsetX: number; offsetY: number; startX: number; startY: number; hasMoved: boolean } | null = null
  const CLICK_THRESHOLD = 5

  // Double-click detection for text items
  let lastClickTime = 0
  const DOUBLE_CLICK_THRESHOLD = 300  // ms

  cont.on('pointerdown', (e) => {
    if (!cont.parent) return
    e.stopPropagation()
    const pos = e.getLocalPosition(cont.parent)
    dragData = {
      offsetX: pos.x - cont.x,
      offsetY: pos.y - cont.y,
      startX: pos.x,
      startY: pos.y,
      hasMoved: false,
    }
    isDraggingItemRef.current = true
  })

  cont.on('globalpointermove', (e) => {
    if (dragData && cont.parent) {
      const pos = e.getLocalPosition(cont.parent)
      const dx = pos.x - dragData.startX
      const dy = pos.y - dragData.startY
      const distance = Math.sqrt(dx * dx + dy * dy)

      if (distance > CLICK_THRESHOLD) {
        dragData.hasMoved = true
        cont.cursor = 'grabbing'
        cont.alpha = 0.9
      }

      if (dragData.hasMoved) {
        cont.x = pos.x - dragData.offsetX
        cont.y = pos.y - dragData.offsetY
      }
    }
  })

  cont.on('pointerup', () => {
    if (dragData) {
      if (dragData.hasMoved) {
        // Was a drag - save position (preserve textScale)
        cont.cursor = 'pointer'
        cont.alpha = 1
        saveCanvasItemPosition({
          eventId,
          itemId: item.id,
          x: cont.x,
          y: cont.y,
          scale: cont.scale.x,
          rotation: cont.rotation,
          zIndex: initialZIndex,
          textScale: _contentTextRef ? _contentTextRef.scale.x : undefined,
          width: currentWidth,
          height: currentHeight,
        })
      } else {
        // Was a click - check for double-click
        const now = Date.now()
        const timeSinceLastClick = now - lastClickTime

        if (timeSinceLastClick < DOUBLE_CLICK_THRESHOLD && isTextItem) {
          // Double-click on text item - reset to scale 1 (auto-size)
          cont.scale.set(1)
          // Reset text scale if it was modified by ctrl+resize
          if (_contentTextRef) {
            _contentTextRef.scale.set(1)
            // Also reset wordWrapWidth
            _contentTextRef.style.wordWrapWidth = currentWidth - 24
          }
          // Save the reset scale (textScale back to 1/undefined)
          saveCanvasItemPosition({
            eventId,
            itemId: item.id,
            x: cont.x,
            y: cont.y,
            scale: 1,
            rotation: cont.rotation,
            zIndex: initialZIndex,
            textScale: undefined,
            width: currentWidth,
            height: currentHeight,
          })
        } else {
          // Single click - open item detail
          onItemClick?.(item)
        }
        lastClickTime = now
      }
      dragData = null
      isDraggingItemRef.current = false
    }
  })

  cont.on('pointerupoutside', () => {
    if (dragData) {
      if (dragData.hasMoved) {
        cont.cursor = 'pointer'
        cont.alpha = 1
        saveCanvasItemPosition({
          eventId,
          itemId: item.id,
          x: cont.x,
          y: cont.y,
          scale: cont.scale.x,
          rotation: cont.rotation,
          zIndex: initialZIndex,
          textScale: _contentTextRef ? _contentTextRef.scale.x : undefined,
          width: currentWidth,
          height: currentHeight,
        })
      }
      dragData = null
      isDraggingItemRef.current = false
    }
  })

  return cont
}

// ============ L3 View: Item Focus ============

function buildL3View(
  container: Container,
  item: Item,
  event: Event
) {
  // Full-screen item detail view
  const FOCUS_WIDTH = 600
  const FOCUS_HEIGHT = 400
  const FOCUS_PADDING = 32

  // Main container centered at origin
  const focusContainer = new Container()

  // Background card
  const bg = new Graphics()
  bg.roundRect(-FOCUS_WIDTH / 2, -FOCUS_HEIGHT / 2, FOCUS_WIDTH, FOCUS_HEIGHT, 16)

  let bgColor = 0x1a2a3e
  let borderColor = 0x3d5a80
  let accentColor = 0x5d7aa0

  if (item.itemType === 'text') {
    bgColor = 0x2a2a3e
    borderColor = 0x5d5a80
    accentColor = 0x7d7aa0
  } else if (item.itemType === 'photo') {
    bgColor = 0x1a3a2e
    borderColor = 0x3d8060
    accentColor = 0x5da080
  } else if (item.itemType === 'video') {
    bgColor = 0x3a2a1e
    borderColor = 0x806040
    accentColor = 0xa08060
  } else if (item.itemType === 'link') {
    bgColor = 0x1a2a3a
    borderColor = 0x4080a0
    accentColor = 0x60a0c0
  }

  bg.fill({ color: bgColor })
  bg.stroke({ width: 2, color: borderColor })
  focusContainer.addChild(bg)

  // Type badge
  const typeBadge = new Graphics()
  const badgeText = item.itemType.toUpperCase()
  const badgeWidth = badgeText.length * 10 + 16
  typeBadge.roundRect(-FOCUS_WIDTH / 2 + FOCUS_PADDING, -FOCUS_HEIGHT / 2 + FOCUS_PADDING, badgeWidth, 24, 4)
  typeBadge.fill({ color: accentColor })
  focusContainer.addChild(typeBadge)

  const typeLabel = new Text({
    text: badgeText,
    style: new TextStyle({
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      fontSize: 12,
      fontWeight: 'bold',
      fill: 0xffffff,
    }),
    resolution: TEXT_RESOLUTION,
  })
  typeLabel.x = -FOCUS_WIDTH / 2 + FOCUS_PADDING + 8
  typeLabel.y = -FOCUS_HEIGHT / 2 + FOCUS_PADDING + 4
  focusContainer.addChild(typeLabel)

  // Event title (context)
  const eventTitle = new Text({
    text: event.title || 'Untitled Event',
    style: new TextStyle({
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      fontSize: 14,
      fill: 0x888899,
    }),
    resolution: TEXT_RESOLUTION,
  })
  eventTitle.x = -FOCUS_WIDTH / 2 + FOCUS_PADDING + badgeWidth + 16
  eventTitle.y = -FOCUS_HEIGHT / 2 + FOCUS_PADDING + 3
  focusContainer.addChild(eventTitle)

  // Main content area
  const contentY = -FOCUS_HEIGHT / 2 + FOCUS_PADDING + 48
  const contentHeight = FOCUS_HEIGHT - FOCUS_PADDING * 2 - 80

  if (item.itemType === 'text') {
    // Text content - full display (bodyText for file-based, content for legacy)
    const contentText = new Text({
      text: item.bodyText || item.content || '',
      style: new TextStyle({
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        fontSize: 18,
        fill: 0xffffff,
        wordWrap: true,
        wordWrapWidth: FOCUS_WIDTH - FOCUS_PADDING * 2,
        lineHeight: 28,
      }),
      resolution: TEXT_RESOLUTION,
    })
    contentText.x = -FOCUS_WIDTH / 2 + FOCUS_PADDING
    contentText.y = contentY
    focusContainer.addChild(contentText)
  } else if (item.itemType === 'photo' || item.itemType === 'video') {
    // Media placeholder
    const mediaPlaceholder = new Graphics()
    const mediaWidth = FOCUS_WIDTH - FOCUS_PADDING * 2
    const mediaHeight = contentHeight - 20
    mediaPlaceholder.roundRect(-mediaWidth / 2, contentY, mediaWidth, mediaHeight, 8)
    mediaPlaceholder.fill({ color: 0x111122 })
    mediaPlaceholder.stroke({ width: 1, color: 0x333344 })
    focusContainer.addChild(mediaPlaceholder)

    // Media icon
    const iconSize = 48
    const iconY = contentY + mediaHeight / 2

    if (item.itemType === 'photo') {
      // Photo icon (simple image placeholder)
      const photoIcon = new Graphics()
      photoIcon.roundRect(-iconSize / 2, iconY - iconSize / 2, iconSize, iconSize, 4)
      photoIcon.stroke({ width: 2, color: 0x555566 })
      // Mountain/sun icon hint
      photoIcon.circle(-iconSize / 4, iconY - iconSize / 6, iconSize / 8)
      photoIcon.fill({ color: 0x555566 })
      photoIcon.moveTo(-iconSize / 2 + 6, iconY + iconSize / 4)
      photoIcon.lineTo(-iconSize / 6, iconY - iconSize / 8)
      photoIcon.lineTo(iconSize / 6, iconY + iconSize / 6)
      photoIcon.lineTo(iconSize / 2 - 6, iconY - iconSize / 6)
      photoIcon.stroke({ width: 2, color: 0x555566 })
      focusContainer.addChild(photoIcon)
    } else {
      // Video icon (play button)
      const playIcon = new Graphics()
      playIcon.circle(0, iconY, iconSize / 2)
      playIcon.stroke({ width: 2, color: 0x555566 })
      playIcon.moveTo(-iconSize / 6, iconY - iconSize / 4)
      playIcon.lineTo(-iconSize / 6, iconY + iconSize / 4)
      playIcon.lineTo(iconSize / 4, iconY)
      playIcon.closePath()
      playIcon.fill({ color: 0x555566 })
      focusContainer.addChild(playIcon)
    }

    // File path hint
    const pathText = new Text({
      text: item.content,
      style: new TextStyle({
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        fontSize: 12,
        fill: 0x555566,
      }),
      resolution: TEXT_RESOLUTION,
    })
    pathText.x = -pathText.width / 2
    pathText.y = iconY + iconSize / 2 + 16
    focusContainer.addChild(pathText)
  } else if (item.itemType === 'link') {
    // Link display
    const linkIcon = new Graphics()
    linkIcon.circle(0, contentY + 40, 24)
    linkIcon.stroke({ width: 2, color: accentColor })
    // Chain link symbol
    linkIcon.moveTo(-8, contentY + 40 - 4)
    linkIcon.lineTo(8, contentY + 40 + 4)
    linkIcon.stroke({ width: 2, color: accentColor })
    focusContainer.addChild(linkIcon)

    const linkText = new Text({
      text: item.content,
      style: new TextStyle({
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        fontSize: 16,
        fill: accentColor,
        wordWrap: true,
        wordWrapWidth: FOCUS_WIDTH - FOCUS_PADDING * 2,
      }),
      resolution: TEXT_RESOLUTION,
    })
    linkText.x = -FOCUS_WIDTH / 2 + FOCUS_PADDING
    linkText.y = contentY + 80
    focusContainer.addChild(linkText)
  } else if (item.itemType === 'audio') {
    // Audio display - mic icon
    const audioIcon = new Graphics()
    audioIcon.circle(0, contentY + 40, 28)
    audioIcon.fill({ color: 0xE91E63, alpha: 0.2 })
    audioIcon.stroke({ width: 2, color: 0xE91E63 })
    focusContainer.addChild(audioIcon)

    // Mic symbol (simple representation)
    const micShape = new Graphics()
    micShape.roundRect(-6, contentY + 28, 12, 18, 4)
    micShape.stroke({ width: 2, color: 0xE91E63 })
    micShape.moveTo(0, contentY + 46)
    micShape.lineTo(0, contentY + 52)
    micShape.stroke({ width: 2, color: 0xE91E63 })
    micShape.moveTo(-8, contentY + 52)
    micShape.lineTo(8, contentY + 52)
    micShape.stroke({ width: 2, color: 0xE91E63 })
    focusContainer.addChild(micShape)

    const audioLabel = new Text({
      text: 'Audio',
      style: new TextStyle({
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        fontSize: 16,
        fill: 0xE91E63,
      }),
      resolution: TEXT_RESOLUTION,
    })
    audioLabel.x = -audioLabel.width / 2
    audioLabel.y = contentY + 80
    focusContainer.addChild(audioLabel)
  }

  // Caption at bottom if present
  if (item.caption) {
    const captionText = new Text({
      text: item.caption,
      style: new TextStyle({
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        fontSize: 14,
        fontStyle: 'italic',
        fill: 0x888899,
        wordWrap: true,
        wordWrapWidth: FOCUS_WIDTH - FOCUS_PADDING * 2,
      }),
      resolution: TEXT_RESOLUTION,
    })
    captionText.x = -FOCUS_WIDTH / 2 + FOCUS_PADDING
    captionText.y = FOCUS_HEIGHT / 2 - FOCUS_PADDING - 24
    focusContainer.addChild(captionText)
  }

  // Escape hint at top right
  const escHint = new Text({
    text: 'ESC to close',
    style: new TextStyle({
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      fontSize: 12,
      fill: 0x555566,
    }),
    resolution: TEXT_RESOLUTION,
  })
  escHint.x = FOCUS_WIDTH / 2 - FOCUS_PADDING - escHint.width
  escHint.y = -FOCUS_HEIGHT / 2 + FOCUS_PADDING + 4
  focusContainer.addChild(escHint)

  container.addChild(focusContainer)
}
