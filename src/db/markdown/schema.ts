// TypeScript types for markdown frontmatter (Obsidian-style)

export interface Location {
  lat: number
  lng: number
  label?: string
}

// Event frontmatter (stored in _event.md)
export interface EventFrontmatter {
  id: string
  type: 'year' | 'period' | 'event' | 'item'
  title?: string
  description?: string
  startAt: string  // ISO date or YYYY-MM-DD
  endAt?: string
  location?: Location
  featuredPhoto?: string  // slug reference to item
  parentYear?: string     // year folder name
  tags?: string[]
  createdAt: string
  updatedAt: string
}

// Item frontmatter (stored in [slug].md)
export interface ItemFrontmatter {
  id: string
  type: 'photo' | 'video' | 'text' | 'link'
  media?: string          // filename for photo/video (e.g., "strand-selfie.jpg")
  url?: string            // URL for link items
  caption?: string
  happenedAt?: string     // ISO date or YYYY-MM-DD
  place?: Location
  people?: string[]
  tags?: string[]
  exif?: {
    camera?: string
    aperture?: string
    iso?: number
    focalLength?: string
  }
  createdAt: string
  updatedAt: string
}

// Canvas layout (stored in _canvas.json)
export interface CanvasItemLayout {
  itemSlug: string
  x: number
  y: number
  scale: number
  rotation: number
  zIndex: number
  textScale?: number
}

export interface CanvasJson {
  version: number
  items: CanvasItemLayout[]
  viewport?: {
    centerX: number
    centerY: number
    zoom: number
  }
  updatedAt?: string
}

// Parsed markdown document
export interface ParsedMarkdown<T> {
  frontmatter: T
  body: string  // markdown content after frontmatter
}

// File info for indexing
export interface FileInfo {
  path: string
  name: string
  mtime: number  // modification time in ms
  size: number
}
