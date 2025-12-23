// Parse markdown files with YAML frontmatter (Obsidian-style)

import type {
  EventFrontmatter,
  ItemFrontmatter,
  ParsedMarkdown,
  CanvasJson
} from './schema'

/**
 * Parse YAML frontmatter from markdown content
 * Frontmatter is enclosed between --- markers at the start of the file
 */
export function parseFrontmatter<T>(content: string): ParsedMarkdown<T> {
  const lines = content.split('\n')

  // Check for frontmatter start
  if (lines[0]?.trim() !== '---') {
    return {
      frontmatter: {} as T,
      body: content
    }
  }

  // Find frontmatter end
  let endIndex = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') {
      endIndex = i
      break
    }
  }

  if (endIndex === -1) {
    return {
      frontmatter: {} as T,
      body: content
    }
  }

  // Parse YAML content
  const yamlContent = lines.slice(1, endIndex).join('\n')
  const frontmatter = parseYaml(yamlContent) as T

  // Extract body (everything after frontmatter)
  const body = lines.slice(endIndex + 1).join('\n').trim()

  return { frontmatter, body }
}

/**
 * Simple YAML parser for frontmatter
 * Supports: strings, numbers, booleans, arrays, nested objects
 */
function parseYaml(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const lines = yaml.split('\n')

  let currentKey = ''
  let currentIndent = 0
  let arrayBuffer: unknown[] = []
  let inArray = false
  let objectBuffer: Record<string, unknown> = {}
  let inNestedObject = false
  let nestedObjectKey = ''

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line || line.trim() === '') continue

    const indent = line.length - line.trimStart().length
    const trimmed = line.trim()

    // Array item
    if (trimmed.startsWith('- ')) {
      const value = trimmed.substring(2).trim()
      if (inArray && currentKey) {
        arrayBuffer.push(parseValue(value))
      }
      continue
    }

    // Check if previous was an array that ended
    if (inArray && indent <= currentIndent && !trimmed.startsWith('-')) {
      result[currentKey] = arrayBuffer
      arrayBuffer = []
      inArray = false
    }

    // Check if previous was a nested object that ended
    if (inNestedObject && indent <= currentIndent && trimmed.includes(':')) {
      result[nestedObjectKey] = objectBuffer
      objectBuffer = {}
      inNestedObject = false
    }

    // Key-value pair
    const colonIndex = trimmed.indexOf(':')
    if (colonIndex > 0) {
      const key = trimmed.substring(0, colonIndex).trim()
      const valueStr = trimmed.substring(colonIndex + 1).trim()

      // Nested object property
      if (inNestedObject && indent > currentIndent) {
        objectBuffer[key] = parseValue(valueStr)
        continue
      }

      // Empty value - might be array or object start
      if (valueStr === '') {
        // Look ahead to determine type
        const nextLine = lines[i + 1]
        if (nextLine) {
          const nextTrimmed = nextLine.trim()
          if (nextTrimmed.startsWith('- ')) {
            // Array
            currentKey = key
            currentIndent = indent
            inArray = true
            arrayBuffer = []
          } else if (nextTrimmed.includes(':')) {
            // Nested object
            nestedObjectKey = key
            currentIndent = indent
            inNestedObject = true
            objectBuffer = {}
          }
        }
        continue
      }

      // Regular value
      if (!inNestedObject) {
        result[key] = parseValue(valueStr)
      } else {
        objectBuffer[key] = parseValue(valueStr)
      }
    }
  }

  // Flush remaining array/object
  if (inArray && currentKey) {
    result[currentKey] = arrayBuffer
  }
  if (inNestedObject && nestedObjectKey) {
    result[nestedObjectKey] = objectBuffer
  }

  return result
}

/**
 * Parse a YAML value string into the appropriate type
 */
function parseValue(value: string): unknown {
  if (!value || value === '~' || value === 'null') return null
  if (value === 'true') return true
  if (value === 'false') return false

  // Quoted string
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }

  // Number
  const num = Number(value)
  if (!isNaN(num) && value !== '') return num

  // Plain string
  return value
}

/**
 * Parse an event markdown file (_event.md)
 */
export function parseEventMarkdown(content: string): ParsedMarkdown<EventFrontmatter> {
  return parseFrontmatter<EventFrontmatter>(content)
}

/**
 * Parse an item markdown file ([slug].md)
 */
export function parseItemMarkdown(content: string): ParsedMarkdown<ItemFrontmatter> {
  return parseFrontmatter<ItemFrontmatter>(content)
}

/**
 * Parse _canvas.json file
 */
export function parseCanvasJson(content: string): CanvasJson | null {
  try {
    const parsed = JSON.parse(content)
    return parsed as CanvasJson
  } catch {
    console.error('Failed to parse canvas.json')
    return null
  }
}

/**
 * Extract the slug from a markdown filename
 * e.g., "strand-selfie.md" -> "strand-selfie"
 */
export function getSlugFromFilename(filename: string): string {
  // Remove extension
  const withoutExt = filename.replace(/\.[^/.]+$/, '')
  return withoutExt
}

/**
 * Check if a filename is a media file (photo/video)
 */
export function isMediaFile(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase()
  const mediaExtensions = [
    'jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'avif',
    'mp4', 'mov', 'avi', 'mkv', 'webm'
  ]
  return mediaExtensions.includes(ext || '')
}

/**
 * Check if a filename is a markdown file
 */
export function isMarkdownFile(filename: string): boolean {
  return filename.endsWith('.md')
}

/**
 * Check if a filename is a special file (starts with _)
 */
export function isSpecialFile(filename: string): boolean {
  return filename.startsWith('_')
}

/**
 * Parse a date string into ISO format
 * Accepts: YYYY-MM-DD, YYYY-MM-DDTHH:MM:SS, full ISO
 */
export function parseDate(dateStr: string | undefined): string | undefined {
  if (!dateStr) return undefined

  // Already ISO format
  if (dateStr.includes('T')) {
    return dateStr
  }

  // YYYY-MM-DD format - add time component
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return `${dateStr}T00:00:00.000Z`
  }

  return dateStr
}

/**
 * Infer event metadata from folder name
 * Format: "YYYY-MM Title" or "YYYY-MM-DD Title"
 */
export function inferEventFromFolderName(folderName: string): Partial<EventFrontmatter> {
  // Match patterns like "2024-03 Vakantie Spanje" or "2024-03-15 Verjaardag"
  const match = folderName.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?\s+(.+)$/)

  if (match) {
    const [, year, month, day, title] = match
    const startAt = day
      ? `${year}-${month}-${day}`
      : `${year}-${month}-01`

    return {
      type: 'event',
      title,
      startAt
    }
  }

  // Fallback - just use folder name as title
  return {
    type: 'event',
    title: folderName
  }
}

/**
 * Check if a folder name looks like a year (e.g., "2024")
 */
export function isYearFolder(folderName: string): boolean {
  return /^\d{4}$/.test(folderName)
}
