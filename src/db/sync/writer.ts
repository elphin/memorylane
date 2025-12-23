// Sync Engine: Writer
// Write-through operations: write to files first, then update index

import { v4 as uuidv4 } from 'uuid'
import type { Event, Item, CanvasItem } from '../../models/types'
import {
  writeFile,
  writeImageFromDataURL,
  deleteFile,
  readFile,
  getDirectory,
  hasStorageFolder,
  renameFile,
  deleteDirectory,
} from '../fileStorage'
import {
  insertEventFromFile,
  insertItemFromFile,
  upsertCanvasItem,
  deleteItem as deleteItemFromDb,
  deleteEvent as deleteEventFromDb,
  getEventById,
  getItemById,
  getCanvasItems,
  exportDatabase,
} from '../database'
import { writeDatabaseFile } from '../fileStorage'
import {
  generateEventMarkdown,
  generateItemMarkdown,
  generateCanvasJson,
  generateSlug,
  generateEventFolderName,
  generateMediaFilename,
  getExtensionFromDataUrl,
} from '../markdown/generator'
import { parseEventMarkdown, parseItemMarkdown } from '../markdown/parser'
import type { EventFrontmatter, ItemFrontmatter, CanvasJson } from '../markdown/schema'

// ============================================================================
// Year Operations
// ============================================================================

/**
 * Get or create a year with folder structure
 * Creates the year folder and _year.md if it doesn't exist
 */
export async function createYearWithFiles(dateStr: string): Promise<Event> {
  if (!hasStorageFolder()) {
    throw new Error('No storage folder configured')
  }

  // Import getYearForDate to check if year exists
  const { getYearForDate } = await import('../database')

  // Check if year already exists in database
  const existingYear = getYearForDate(dateStr)
  if (existingYear) {
    return existingYear
  }

  // Extract year from date string
  const year = dateStr.split('-')[0]
  const now = new Date().toISOString()
  const id = uuidv4()

  // Create year folder
  await getDirectory(year)

  // Create year event object
  const yearEvent: Event = {
    id,
    type: 'year',
    title: year,
    startAt: `${year}-01-01`,
    endAt: `${year}-12-31`,
    folderPath: year,
    filePath: `${year}/_year.md`,
    createdAt: now,
    updatedAt: now,
  }

  // Generate markdown for _year.md
  const frontmatter: EventFrontmatter = {
    id: yearEvent.id,
    type: 'year',
    title: year,
    startAt: yearEvent.startAt,
    endAt: yearEvent.endAt,
    createdAt: now,
    updatedAt: now,
  }

  const markdown = generateEventMarkdown(frontmatter)

  // Write _year.md
  await writeFile([year], '_year.md', markdown)

  // Update database index
  insertEventFromFile(yearEvent)

  // Save database
  await saveDatabaseToFile()

  console.log('Year created:', year)
  return yearEvent
}

// ============================================================================
// Event Operations
// ============================================================================

export interface CreateEventInput {
  type: Event['type']
  title: string
  description?: string
  startAt: string
  endAt?: string
  location?: { lat: number; lng: number; label?: string }
  parentId?: string
  tags?: string[]
}

/**
 * Create a new event with files
 */
export async function createEventWithFiles(input: CreateEventInput): Promise<Event> {
  if (!hasStorageFolder()) {
    throw new Error('No storage folder configured')
  }

  const now = new Date().toISOString()
  const id = uuidv4()

  // Determine folder path
  const year = input.startAt.substring(0, 4)
  const folderName = generateEventFolderName(input.title, input.startAt, input.endAt)
  const folderPath = [year, folderName]

  // Create folder
  await getDirectory(...folderPath)

  // Create event object
  const event: Event = {
    id,
    type: input.type,
    title: input.title,
    description: input.description,
    startAt: input.startAt,
    endAt: input.endAt,
    location: input.location,
    parentId: input.parentId,
    tags: input.tags,
    filePath: [...folderPath, '_event.md'].join('/'),
    folderPath: folderPath.join('/'),
    createdAt: now,
    updatedAt: now,
  }

  // Generate markdown
  const frontmatter: EventFrontmatter = {
    id: event.id,
    type: event.type,
    title: event.title,
    description: event.description,
    startAt: event.startAt,
    endAt: event.endAt,
    location: event.location,
    tags: event.tags,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
  }

  const markdown = generateEventMarkdown(frontmatter, event.description)

  // Write _event.md
  await writeFile(folderPath, '_event.md', markdown)

  // Update database index
  insertEventFromFile(event)

  // Save database
  await saveDatabaseToFile()

  console.log('Event created:', event.title, 'at', folderPath.join('/'))
  return event
}

/**
 * Update an existing event
 */
export async function updateEventWithFiles(
  eventId: string,
  updates: Partial<CreateEventInput>
): Promise<void> {
  const event = getEventById(eventId)
  if (!event || !event.folderPath) {
    throw new Error('Event not found or not file-based')
  }

  const folderPath = event.folderPath.split('/')
  const now = new Date().toISOString()

  // Read existing markdown
  const existingContent = await readFile(folderPath, '_event.md')
  const existing = existingContent
    ? parseEventMarkdown(existingContent)
    : { frontmatter: {} as EventFrontmatter, body: '' }

  // Merge updates
  const merged: EventFrontmatter = {
    ...existing.frontmatter,
    id: event.id,
    type: updates.type || event.type,
    title: updates.title ?? event.title,
    description: updates.description ?? event.description,
    startAt: updates.startAt || event.startAt,
    endAt: updates.endAt ?? event.endAt,
    location: updates.location ?? event.location,
    tags: updates.tags ?? event.tags,
    createdAt: event.createdAt,
    updatedAt: now,
  }

  // Generate new markdown
  const markdown = generateEventMarkdown(merged, merged.description || existing.body)

  // Write file
  await writeFile(folderPath, '_event.md', markdown)

  // Update database
  const updatedEvent: Event = {
    ...event,
    ...updates,
    updatedAt: now,
  }
  insertEventFromFile(updatedEvent)

  // Save database
  await saveDatabaseToFile()

  console.log('Event updated:', event.title)
}

/**
 * Delete an event and all its files
 */
export async function deleteEventWithFiles(eventId: string): Promise<void> {
  const event = getEventById(eventId)
  if (!event || !event.folderPath) {
    throw new Error('Event not found or not file-based')
  }

  const folderPath = event.folderPath.split('/')

  // Delete the entire folder
  await deleteDirectory(folderPath)

  // Delete from database
  deleteEventFromDb(eventId)

  // Save database
  await saveDatabaseToFile()

  console.log('Event deleted:', event.title)
}

// ============================================================================
// Item Operations
// ============================================================================

export interface CreateItemInput {
  eventId: string
  itemType: Item['itemType']
  content: string  // Text content, URL, or base64 data URL
  caption?: string
  happenedAt?: string
  place?: { lat: number; lng: number; label?: string }
  people?: string[]
  tags?: string[]
  originalFilename?: string  // For photo/video uploads
}

/**
 * Create a new item with files
 */
export async function createItemWithFiles(input: CreateItemInput): Promise<Item> {
  if (!hasStorageFolder()) {
    throw new Error('No storage folder configured')
  }

  const event = getEventById(input.eventId)
  if (!event || !event.folderPath) {
    throw new Error('Event not found or not file-based')
  }

  const now = new Date().toISOString()
  const id = uuidv4()
  const folderPath = event.folderPath.split('/')

  // Generate slug from caption or type
  const slugBase = input.caption || `${input.itemType}-${Date.now()}`
  const slug = generateSlug(slugBase)

  let content = input.content
  let mediaPath: string | undefined

  // Handle media files
  if ((input.itemType === 'photo' || input.itemType === 'video') &&
      input.content.startsWith('data:')) {
    // Save media file
    const ext = getExtensionFromDataUrl(input.content)
    const mediaFilename = generateMediaFilename(
      input.originalFilename || `${slug}.${ext}`,
      input.caption,
      id
    )

    await writeImageFromDataURL(folderPath, mediaFilename, input.content)

    // Update content to file reference
    content = `file:${[...folderPath, mediaFilename].join('/')}`
    mediaPath = mediaFilename
  }

  // Create item object
  const item: Item = {
    id,
    eventId: input.eventId,
    itemType: input.itemType,
    content,
    caption: input.caption,
    happenedAt: input.happenedAt,
    place: input.place,
    people: input.people,
    tags: input.tags,
    url: input.itemType === 'link' ? input.content : undefined,
    bodyText: input.itemType === 'text' ? input.content : undefined,
    slug,
    filePath: [...folderPath, `${slug}.md`].join('/'),
    mediaPath,
  }

  // Generate markdown
  const frontmatter: ItemFrontmatter = {
    id: item.id,
    type: item.itemType,
    media: mediaPath,
    url: item.url,
    caption: item.caption,
    happenedAt: item.happenedAt,
    place: item.place,
    people: item.people,
    tags: item.tags,
    createdAt: now,
    updatedAt: now,
  }

  const body = item.itemType === 'text' ? item.content : item.caption
  const markdown = generateItemMarkdown(frontmatter, body)

  // Write markdown file
  await writeFile(folderPath, `${slug}.md`, markdown)

  // Update database
  insertItemFromFile(item)

  // Save database
  await saveDatabaseToFile()

  console.log('Item created:', slug, 'in', folderPath.join('/'))
  return item
}

/**
 * Update an existing item
 */
export async function updateItemWithFiles(
  itemId: string,
  updates: Partial<Omit<CreateItemInput, 'eventId' | 'itemType'>>
): Promise<void> {
  const item = getItemById(itemId)
  if (!item || !item.filePath) {
    throw new Error('Item not found or not file-based')
  }

  const event = getEventById(item.eventId)
  if (!event || !event.folderPath) {
    throw new Error('Event not found')
  }

  const folderPath = event.folderPath.split('/')
  const now = new Date().toISOString()

  // Read existing markdown
  const existingContent = await readFile(folderPath, `${item.slug}.md`)
  const existing = existingContent
    ? parseItemMarkdown(existingContent)
    : { frontmatter: {} as ItemFrontmatter, body: '' }

  // Check if slug needs to change (caption changed significantly)
  let newSlug = item.slug!
  if (updates.caption && updates.caption !== item.caption) {
    const potentialNewSlug = generateSlug(updates.caption)
    if (potentialNewSlug !== item.slug) {
      newSlug = potentialNewSlug

      // Rename markdown file
      await renameFile(folderPath, `${item.slug}.md`, `${newSlug}.md`)

      // Rename media file if exists
      if (item.mediaPath) {
        const ext = item.mediaPath.split('.').pop()
        const newMediaName = `${newSlug}.${ext}`
        await renameFile(folderPath, item.mediaPath, newMediaName)
        updates.content = `file:${[...folderPath, newMediaName].join('/')}`
      }
    }
  }

  // Merge updates
  const merged: ItemFrontmatter = {
    ...existing.frontmatter,
    id: item.id,
    type: item.itemType,
    media: item.mediaPath,
    caption: updates.caption ?? item.caption,
    happenedAt: updates.happenedAt ?? item.happenedAt,
    place: updates.place ?? item.place,
    people: updates.people ?? item.people,
    tags: updates.tags ?? item.tags,
    createdAt: existing.frontmatter.createdAt || now,
    updatedAt: now,
  }

  // Determine body content
  let body = existing.body
  if (item.itemType === 'text' && updates.content) {
    body = updates.content
  }

  // Generate new markdown
  const markdown = generateItemMarkdown(merged, body)

  // Write file
  await writeFile(folderPath, `${newSlug}.md`, markdown)

  // Update database
  const updatedItem: Item = {
    ...item,
    content: updates.content ?? item.content,
    caption: updates.caption ?? item.caption,
    happenedAt: updates.happenedAt ?? item.happenedAt,
    place: updates.place ?? item.place,
    people: updates.people ?? item.people,
    tags: updates.tags ?? item.tags,
    slug: newSlug,
    filePath: [...folderPath, `${newSlug}.md`].join('/'),
  }
  insertItemFromFile(updatedItem)

  // Save database
  await saveDatabaseToFile()

  console.log('Item updated:', newSlug)
}

/**
 * Delete an item and its files
 */
export async function deleteItemWithFiles(itemId: string): Promise<void> {
  const item = getItemById(itemId)
  if (!item) {
    throw new Error('Item not found')
  }

  const event = getEventById(item.eventId)
  if (!event || !event.folderPath) {
    // Fall back to database-only delete
    deleteItemFromDb(itemId)
    await saveDatabaseToFile()
    return
  }

  const folderPath = event.folderPath.split('/')

  // Delete markdown file
  if (item.slug) {
    await deleteFile(folderPath, `${item.slug}.md`)
  }

  // Delete media file
  if (item.mediaPath) {
    await deleteFile(folderPath, item.mediaPath)
  }

  // Update canvas.json to remove item
  await updateCanvasAfterItemDelete(item.eventId, item.slug || item.id)

  // Delete from database
  deleteItemFromDb(itemId)

  // Save database
  await saveDatabaseToFile()

  console.log('Item deleted:', item.slug || item.id)
}

// ============================================================================
// Canvas Operations
// ============================================================================

/**
 * Save canvas layout for an event
 */
export async function saveCanvasLayout(eventId: string): Promise<void> {
  const event = getEventById(eventId)
  if (!event || !event.folderPath) {
    return // Not file-based, skip
  }

  const folderPath = event.folderPath.split('/')
  const canvasItems = getCanvasItems(eventId)

  const canvas: CanvasJson = {
    version: 1,
    items: canvasItems.map(ci => ({
      itemSlug: ci.itemSlug || ci.itemId, // Prefer slug
      x: ci.x,
      y: ci.y,
      scale: ci.scale,
      rotation: ci.rotation,
      zIndex: ci.zIndex,
      textScale: ci.textScale,
    })),
    updatedAt: new Date().toISOString(),
  }

  const json = generateCanvasJson(canvas)
  await writeFile(folderPath, '_canvas.json', json)

  console.log('Canvas layout saved for event:', event.title)
}

/**
 * Update canvas layout and save
 */
export async function updateCanvasItemWithFiles(canvasItem: CanvasItem): Promise<void> {
  // First update the database
  upsertCanvasItem(canvasItem)

  // Then save the canvas file
  await saveCanvasLayout(canvasItem.eventId)

  // Save database
  await saveDatabaseToFile()
}

/**
 * Remove an item from canvas.json after deletion
 */
async function updateCanvasAfterItemDelete(eventId: string, itemSlugOrId: string): Promise<void> {
  const event = getEventById(eventId)
  if (!event || !event.folderPath) return

  const folderPath = event.folderPath.split('/')
  const canvasContent = await readFile(folderPath, '_canvas.json')

  if (!canvasContent) return

  try {
    const canvas = JSON.parse(canvasContent) as CanvasJson
    canvas.items = canvas.items.filter(item =>
      item.itemSlug !== itemSlugOrId
    )
    canvas.updatedAt = new Date().toISOString()

    const json = generateCanvasJson(canvas)
    await writeFile(folderPath, '_canvas.json', json)
  } catch (err) {
    console.error('Failed to update canvas after item delete:', err)
  }
}

// ============================================================================
// Database persistence
// ============================================================================

/**
 * Save database to file in storage folder
 */
async function saveDatabaseToFile(): Promise<void> {
  const dbData = exportDatabase()
  if (dbData) {
    await writeDatabaseFile(dbData)
  }
}
