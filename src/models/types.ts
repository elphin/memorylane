export type EventType = 'year' | 'period' | 'event' | 'item'
export type ItemType = 'text' | 'photo' | 'video' | 'link' | 'audio'
export type ItemCategory = 'persoonlijk' | 'werk' | 'familie' | 'creatief' | 'vakantie'

// Category configuration with colors
export interface CategoryConfig {
  id: string
  label: string
  color: string  // HEX kleur, bijv. "#4CAF50"
}

// Default category colors
export const DEFAULT_CATEGORY_COLORS: Record<string, string> = {
  'persoonlijk': '#64B5F6',  // Blauw
  'werk': '#81C784',         // Groen
  'familie': '#FFB74D',      // Oranje
  'creatief': '#BA68C8',     // Paars
  'vakantie': '#4DD0E1',     // Cyan
}

export const ITEM_CATEGORIES: CategoryConfig[] = [
  { id: 'persoonlijk', label: 'Persoonlijk', color: '#64B5F6' },
  { id: 'werk', label: 'Werk', color: '#81C784' },
  { id: 'familie', label: 'Familie', color: '#FFB74D' },
  { id: 'creatief', label: 'Creatief', color: '#BA68C8' },
  { id: 'vakantie', label: 'Vakantie', color: '#4DD0E1' },
]

export interface Location {
  lat: number
  lng: number
  label?: string
}

export interface Event {
  id: string
  type: EventType
  title?: string
  description?: string
  featuredPhotoId?: string     // Reference to an Item id (legacy)
  featuredPhotoSlug?: string   // Reference to an Item slug (file-based)
  featuredPhotoData?: string   // Base64 of separately uploaded photo
  location?: Location
  startAt: string // ISO date
  endAt?: string // ISO date
  parentId?: string
  coverMediaId?: string
  tags?: string[]              // Tags for categorization
  // File-based storage fields
  filePath?: string            // Path to _event.md relative to root
  folderPath?: string          // Path to event folder relative to root
  createdAt: string
  updatedAt: string
}

export interface Item {
  id: string
  eventId: string
  itemType: ItemType
  content: string // text content or media path (base64, file: reference, or plain text)
  caption?: string
  happenedAt?: string
  place?: Location
  people?: string[]            // Tagged people names
  tags?: string[]              // Tags for categorization
  category?: string             // Category ID (dynamic, configured in settings)
  url?: string                 // URL for link items
  bodyText?: string            // Markdown body text (for full-text search)
  // File-based storage fields
  slug?: string                // URL-safe identifier (filename without extension)
  filePath?: string            // Path to [slug].md relative to root
  mediaPath?: string           // Path to media file relative to event folder
}

export interface CanvasItem {
  eventId: string
  itemId: string              // Item ID (for database lookups)
  itemSlug?: string           // Item slug (for file-based storage)
  x: number
  y: number
  scale: number
  rotation: number
  zIndex: number
  textScale?: number          // For text items: inner text scale (used with ctrl+resize)
  width?: number              // Custom card width (default: 200)
  height?: number             // Custom card height (default: 150)
}

// Zoom levels as defined in PRD
export enum ZoomLevel {
  L0_Lifeline = 0,  // Years/decades
  L1_Year = 1,      // Highlights + periods
  L2_Canvas = 2,    // Free canvas with items
  L3_Focus = 3,     // Single item focus
}

export interface ViewState {
  zoomLevel: ZoomLevel
  centerX: number      // Timeline position (in time units)
  centerY: number      // Vertical offset
  scale: number        // Current zoom scale
  focusedEventId?: string
}

// L1 Density View types
export interface L1Memory {
  id: string
  itemId: string
  eventId: string
  itemType: ItemType
  timestamp: number      // Unix timestamp (resolved from happenedAt or event.startAt)
  endTimestamp?: number  // Unix timestamp for end date (from event.endAt) - if present, render as block
  eventTitle?: string
  eventDescription?: string       // Event description for tooltip
  eventLocation?: string          // Event location label for tooltip
  eventFeaturedPhoto?: string     // Base64 of featured photo (from item or custom upload)
  content: string
  caption?: string
}

export interface L1EventCluster {
  event: Event
  memories: L1Memory[]
  startTimestamp: number
  endTimestamp: number
}

// Year Timeline Featured Photos
export interface YearFeaturedPhoto {
  id: string
  yearId: string           // Year event ID
  eventId: string          // Source event ID (for connection line)
  itemId?: string          // Optional specific item ID
  x: number                // X position relative to year timeline center
  y: number                // Y position (positive = above, negative = below)
  scale: number            // Size scale (1 = default)
  width: number            // Rendered width
  height: number           // Rendered height
  createdAt: string
  updatedAt: string
}

// Timeline filter settings (stored in localStorage)
export interface TimelineFilterSettings {
  categories: string[]     // Enabled category IDs (empty = all)
  tags: string[]           // Enabled tags (empty = all)
  people: string[]         // Enabled people (empty = all)
  showRandomFill: boolean  // Enable random photo fill
  maxRandomPhotos: number  // Max random photos per year (default: 20)
}

// Default timeline filter settings
export const DEFAULT_TIMELINE_FILTERS: TimelineFilterSettings = {
  categories: [],          // Empty = show all
  tags: [],
  people: [],
  showRandomFill: true,
  maxRandomPhotos: 20,
}
