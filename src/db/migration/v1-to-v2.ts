// Migration: Convert localStorage-based data to file-based storage (v1 -> v2)

import type { Event, Item } from '../../models/types'
import {
  getAllEvents,
  getAllItems,
  getItemsByEvent,
  getCanvasItems,
  getEventById,
  exportDatabase,
} from '../database'
import {
  hasStorageFolder,
  getDirectory,
  writeFile,
  writeImageFromDataURL,
  writeDatabaseFile,
} from '../fileStorage'
import {
  generateEventMarkdown,
  generateItemMarkdown,
  generateCanvasJson,
  generateSlug,
  generateEventFolderName,
  getExtensionFromDataUrl,
} from '../markdown/generator'
import type { EventFrontmatter, ItemFrontmatter, CanvasJson } from '../markdown/schema'

export interface MigrationResult {
  eventsCreated: number
  itemsMigrated: number
  mediaFilesCopied: number
  errors: { type: string; id: string; error: string }[]
}

export interface MigrationProgress {
  current: number
  total: number
  status: string
  phase: 'events' | 'items' | 'canvas' | 'complete'
}

/**
 * Migrate all data from localStorage/IndexedDB to file-based storage
 */
export async function migrateToFileBasedStorage(
  onProgress?: (progress: MigrationProgress) => void
): Promise<MigrationResult> {
  if (!hasStorageFolder()) {
    throw new Error('No storage folder configured. Please select a folder first.')
  }

  const result: MigrationResult = {
    eventsCreated: 0,
    itemsMigrated: 0,
    mediaFilesCopied: 0,
    errors: [],
  }

  const allEvents = getAllEvents()
  const allItems = getAllItems()

  // Filter to get year events and non-year events
  const yearEvents = allEvents.filter(e => e.type === 'year')
  const childEvents = allEvents.filter(e => e.type !== 'year')

  const totalItems = allItems.length
  let processedItems = 0

  // Phase 1: Create year folders
  onProgress?.({ current: 0, total: yearEvents.length, status: 'Creating year folders...', phase: 'events' })

  for (const yearEvent of yearEvents) {
    try {
      const yearName = yearEvent.title || yearEvent.id.substring(0, 4)
      await getDirectory(yearName)
      console.log(`Created year folder: ${yearName}`)
    } catch (err) {
      result.errors.push({
        type: 'year',
        id: yearEvent.id,
        error: (err as Error).message,
      })
    }
  }

  // Phase 2: Migrate events and their items
  for (let i = 0; i < childEvents.length; i++) {
    const event = childEvents[i]
    onProgress?.({
      current: i + 1,
      total: childEvents.length,
      status: `Migrating event: ${event.title || 'Unnamed'}`,
      phase: 'events',
    })

    try {
      await migrateEvent(event, result, (itemProgress) => {
        processedItems++
        onProgress?.({
          current: processedItems,
          total: totalItems,
          status: itemProgress,
          phase: 'items',
        })
      })
      result.eventsCreated++
    } catch (err) {
      console.error(`Failed to migrate event: ${event.id}`, err)
      result.errors.push({
        type: 'event',
        id: event.id,
        error: (err as Error).message,
      })
    }

    // Small delay to prevent UI freezing
    await new Promise(resolve => setTimeout(resolve, 10))
  }

  // Phase 3: Save database to file
  onProgress?.({
    current: 1,
    total: 1,
    status: 'Saving database index...',
    phase: 'complete',
  })

  const dbData = exportDatabase()
  if (dbData) {
    await writeDatabaseFile(dbData)
  }

  console.log('Migration complete:', result)
  return result
}

/**
 * Migrate a single event and its items
 */
async function migrateEvent(
  event: Event,
  result: MigrationResult,
  onItemProgress?: (status: string) => void
): Promise<void> {
  // Determine parent year
  const parentEvent = event.parentId ? getEventById(event.parentId) : null
  const yearName = parentEvent?.title || event.startAt?.substring(0, 4) || String(new Date().getFullYear())

  // Generate folder name
  const folderName = generateEventFolderName(
    event.title || 'Unnamed Event',
    event.startAt,
    event.endAt
  )
  const folderPath = [yearName, folderName]

  // Create folder
  await getDirectory(...folderPath)

  // Write _event.md
  const eventFrontmatter: EventFrontmatter = {
    id: event.id,
    type: event.type,
    title: event.title,
    description: event.description,
    startAt: event.startAt,
    endAt: event.endAt,
    location: event.location,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
  }

  const eventMd = generateEventMarkdown(eventFrontmatter, event.description)
  await writeFile(folderPath, '_event.md', eventMd)

  // Get items and canvas items for this event
  const items = getItemsByEvent(event.id)
  const canvasItems = getCanvasItems(event.id)
  const canvasData: CanvasJson = {
    version: 1,
    items: [],
    updatedAt: new Date().toISOString(),
  }

  // Migrate each item
  for (const item of items) {
    onItemProgress?.(`Migrating: ${item.caption || item.id.substring(0, 8)}`)

    try {
      const slug = await migrateItem(item, folderPath, result)

      // Add to canvas if position exists
      const canvasItem = canvasItems.find(ci => ci.itemId === item.id)
      if (canvasItem) {
        canvasData.items.push({
          itemSlug: slug,
          x: canvasItem.x,
          y: canvasItem.y,
          scale: canvasItem.scale,
          rotation: canvasItem.rotation,
          zIndex: canvasItem.zIndex,
          textScale: canvasItem.textScale,
        })
      }

      result.itemsMigrated++
    } catch (err) {
      console.error(`Failed to migrate item: ${item.id}`, err)
      result.errors.push({
        type: 'item',
        id: item.id,
        error: (err as Error).message,
      })
    }
  }

  // Write _canvas.json if there are items
  if (canvasData.items.length > 0) {
    const canvasJson = generateCanvasJson(canvasData)
    await writeFile(folderPath, '_canvas.json', canvasJson)
  }
}

/**
 * Migrate a single item, returns the slug
 */
async function migrateItem(
  item: Item,
  folderPath: string[],
  result: MigrationResult
): Promise<string> {
  // Generate slug from caption
  const slug = generateSlug(item.caption || item.id, 50)

  // Determine content and media
  let mediaPath: string | undefined

  // Handle media items
  if ((item.itemType === 'photo' || item.itemType === 'video') && item.content) {
    if (item.content.startsWith('data:')) {
      // Base64 data - write to file
      const ext = getExtensionFromDataUrl(item.content)
      mediaPath = `${slug}.${ext}`

      await writeImageFromDataURL(folderPath, mediaPath, item.content)
      result.mediaFilesCopied++

      console.log(`Migrated media: ${mediaPath}`)
    } else if (item.content.startsWith('file:')) {
      // Already a file reference - extract media path
      const filePath = item.content.substring(5)
      mediaPath = filePath.split('/').pop()
    }
  }

  // Build frontmatter
  const frontmatter: ItemFrontmatter = {
    id: item.id,
    type: item.itemType,
    media: mediaPath,
    url: item.itemType === 'link' ? item.content : undefined,
    caption: item.caption,
    happenedAt: item.happenedAt,
    place: item.place,
    people: item.people,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }

  // Generate markdown
  const body = item.itemType === 'text' ? item.content : item.caption
  const itemMd = generateItemMarkdown(frontmatter, body)

  // Write markdown file
  await writeFile(folderPath, `${slug}.md`, itemMd)

  return slug
}

/**
 * Check if migration is needed
 * Returns true if there is data in localStorage but no files in storage folder
 */
export function needsMigration(): boolean {
  if (!hasStorageFolder()) {
    return false
  }

  const allEvents = getAllEvents()
  const hasData = allEvents.length > 0

  // Check if any events have folderPath set (already migrated)
  const hasMigratedEvents = allEvents.some(e => e.folderPath)

  return hasData && !hasMigratedEvents
}
