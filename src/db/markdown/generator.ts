// Generate markdown files with YAML frontmatter (Obsidian-style)

import type {
  EventFrontmatter,
  ItemFrontmatter,
  CanvasJson,
} from './schema'

/**
 * Generate YAML from an object
 */
function generateYaml(obj: Record<string, unknown>, indent = 0): string {
  const lines: string[] = []
  const prefix = '  '.repeat(indent)

  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue

    if (Array.isArray(value)) {
      if (value.length === 0) continue
      lines.push(`${prefix}${key}:`)
      for (const item of value) {
        if (typeof item === 'object' && item !== null) {
          // Array of objects (not currently used, but supported)
          lines.push(`${prefix}  -`)
          lines.push(generateYaml(item as Record<string, unknown>, indent + 2))
        } else {
          lines.push(`${prefix}  - ${formatYamlValue(item)}`)
        }
      }
    } else if (typeof value === 'object') {
      lines.push(`${prefix}${key}:`)
      lines.push(generateYaml(value as Record<string, unknown>, indent + 1))
    } else {
      lines.push(`${prefix}${key}: ${formatYamlValue(value)}`)
    }
  }

  return lines.join('\n')
}

/**
 * Format a value for YAML output
 */
function formatYamlValue(value: unknown): string {
  if (typeof value === 'string') {
    // Quote strings that might be interpreted as other types or contain special chars
    if (value.includes(':') || value.includes('#') || value.includes('\n') ||
        value.startsWith(' ') || value.endsWith(' ') ||
        value === 'true' || value === 'false' || value === 'null' ||
        !isNaN(Number(value))) {
      return `"${value.replace(/"/g, '\\"')}"`
    }
    return value
  }
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return String(value)
  return String(value)
}

/**
 * Generate a complete markdown document with frontmatter
 */
function generateMarkdown(frontmatter: Record<string, unknown>, body?: string): string {
  const yaml = generateYaml(frontmatter)
  const parts = ['---', yaml, '---']

  if (body && body.trim()) {
    parts.push('', body.trim())
  }

  return parts.join('\n') + '\n'
}

/**
 * Generate an event markdown file (_event.md)
 */
export function generateEventMarkdown(event: EventFrontmatter, body?: string): string {
  const frontmatter: Record<string, unknown> = {
    id: event.id,
    type: event.type,
    title: event.title,
    description: event.description,
    startAt: formatDate(event.startAt),
    endAt: event.endAt ? formatDate(event.endAt) : undefined,
    location: event.location,
    featuredPhoto: event.featuredPhoto,
    tags: event.tags,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt
  }

  // Remove undefined values
  Object.keys(frontmatter).forEach(key => {
    if (frontmatter[key] === undefined) delete frontmatter[key]
  })

  return generateMarkdown(frontmatter, body)
}

/**
 * Generate an item markdown file ([slug].md)
 */
export function generateItemMarkdown(item: ItemFrontmatter, body?: string): string {
  const frontmatter: Record<string, unknown> = {
    id: item.id,
    type: item.type,
    media: item.media,
    url: item.url,
    caption: item.caption,
    happenedAt: item.happenedAt ? formatDate(item.happenedAt) : undefined,
    place: item.place,
    people: item.people,
    tags: item.tags,
    exif: item.exif,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  }

  // Remove undefined values
  Object.keys(frontmatter).forEach(key => {
    if (frontmatter[key] === undefined) delete frontmatter[key]
  })

  return generateMarkdown(frontmatter, body)
}

/**
 * Generate _canvas.json content
 */
export function generateCanvasJson(canvas: CanvasJson): string {
  return JSON.stringify(canvas, null, 2)
}

/**
 * Generate a URL-safe slug from text
 */
export function generateSlug(text: string, maxLength = 50): string {
  if (!text) return 'untitled'

  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Remove diacritics
    .replace(/[^a-z0-9\s-]/g, '')    // Remove special chars
    .replace(/\s+/g, '-')            // Spaces to hyphens
    .replace(/-+/g, '-')             // Multiple hyphens to single
    .replace(/^-|-$/g, '')           // Trim hyphens
    .substring(0, maxLength)
    || 'untitled'
}

/**
 * Generate a unique slug by appending a short ID if needed
 */
export function generateUniqueSlug(text: string, id: string, maxLength = 50): string {
  const baseSlug = generateSlug(text, maxLength - 9) // Leave room for _xxxxxxxx
  const shortId = id.substring(0, 8)
  return `${baseSlug}_${shortId}`
}

/**
 * Generate an event folder name
 * Format: "YYYY-MM Title" or "YYYY-MM-DD Title"
 */
export function generateEventFolderName(
  title: string,
  startAt: string,
  endAt?: string
): string {
  // Parse the date
  const date = new Date(startAt)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')

  // Sanitize title
  const safeTitle = sanitizeFolderName(title)

  // If event spans multiple days, use YYYY-MM format
  // If single day, use YYYY-MM-DD format
  if (endAt) {
    const endDate = new Date(endAt)
    const sameDay = date.toDateString() === endDate.toDateString()
    if (!sameDay) {
      return `${year}-${month} ${safeTitle}`
    }
  }

  return `${year}-${month}-${day} ${safeTitle}`
}

/**
 * Sanitize a string for use as a folder/file name
 */
export function sanitizeFolderName(name: string): string {
  return name
    .replace(/[<>:"/\\|?*]/g, '_')  // Invalid chars for Windows
    .replace(/\s+/g, ' ')           // Multiple spaces to single
    .trim()
    .substring(0, 100)              // Limit length
    || 'unnamed'
}

/**
 * Generate a photo filename from original name and item ID
 */
export function generateMediaFilename(
  originalName: string,
  caption: string | undefined,
  id: string
): string {
  const ext = originalName.split('.').pop()?.toLowerCase() || 'jpg'

  // Use caption-based slug if available, otherwise use ID
  if (caption) {
    const slug = generateSlug(caption, 40)
    const shortId = id.substring(0, 8)
    return `${slug}_${shortId}.${ext}`
  }

  // Use original name + short ID
  const baseName = originalName.replace(/\.[^/.]+$/, '').substring(0, 40)
  const safeBase = sanitizeFolderName(baseName)
  const shortId = id.substring(0, 8)
  return `${safeBase}_${shortId}.${ext}`
}

/**
 * Format a date for YAML output
 * Converts full ISO to YYYY-MM-DD when time is midnight
 */
function formatDate(dateStr: string): string {
  if (!dateStr) return dateStr

  // If it's already short format, return as-is
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return dateStr
  }

  // Parse ISO date
  const date = new Date(dateStr)
  if (isNaN(date.getTime())) return dateStr

  // Check if time is midnight (00:00:00)
  const hours = date.getUTCHours()
  const minutes = date.getUTCMinutes()
  const seconds = date.getUTCSeconds()

  if (hours === 0 && minutes === 0 && seconds === 0) {
    // Return short format
    const year = date.getUTCFullYear()
    const month = String(date.getUTCMonth() + 1).padStart(2, '0')
    const day = String(date.getUTCDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }

  // Return full ISO format
  return dateStr
}

/**
 * Get extension from a data URL
 */
export function getExtensionFromDataUrl(dataUrl: string): string {
  const match = dataUrl.match(/^data:image\/(\w+);/)
  if (match) {
    const ext = match[1]
    return ext === 'jpeg' ? 'jpg' : ext
  }
  return 'jpg'
}
