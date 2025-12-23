// Sync Engine: Indexer
// Scans the file system and rebuilds the SQLite index from markdown files

import { v4 as uuidv4 } from 'uuid'
import type { Event, Item, CanvasItem } from '../../models/types'
import {
  listEntries,
  listDirectories,
  readFile,
  getFileStats,
  hasStorageFolder,
} from '../fileStorage'
import {
  createFreshDatabase,
  clearIndex,
  insertEventFromFile,
  insertItemFromFile,
  upsertCanvasItem,
  upsertFileIndexEntry,
  setMeta,
  getMeta,
  exportDatabase,
} from '../database'
import { writeDatabaseFile } from '../fileStorage'
import {
  parseEventMarkdown,
  parseItemMarkdown,
  parseCanvasJson,
  isYearFolder,
  inferEventFromFolderName,
  isMediaFile,
  isMarkdownFile,
  isSpecialFile,
  parseDate,
  getSlugFromFilename,
} from '../markdown/parser'
import type { CanvasJson } from '../markdown/schema'

export interface IndexResult {
  yearsIndexed: number
  eventsIndexed: number
  itemsIndexed: number
  errors: { path: string; error: string }[]
}

/**
 * Rebuild the entire index from files
 * This is called on startup or when files have changed significantly
 */
export async function rebuildFullIndex(): Promise<IndexResult> {
  if (!hasStorageFolder()) {
    throw new Error('No storage folder configured')
  }

  const result: IndexResult = {
    yearsIndexed: 0,
    eventsIndexed: 0,
    itemsIndexed: 0,
    errors: [],
  }

  console.log('Starting full index rebuild...')

  // Create fresh database
  await createFreshDatabase()
  clearIndex()

  // Scan year folders
  const yearFolders = await listDirectories([])
  const years = yearFolders.filter(name => isYearFolder(name)).sort()

  console.log(`Found ${years.length} year folders`)

  // Index each year
  for (const yearName of years) {
    try {
      const yearEvent = await indexYearFolder(yearName)
      result.yearsIndexed++

      // Index event folders within year
      const eventFolders = await listDirectories([yearName])

      for (const eventFolderName of eventFolders) {
        // Skip hidden folders
        if (eventFolderName.startsWith('.')) continue

        try {
          const itemCount = await indexEventFolder(
            [yearName, eventFolderName],
            yearEvent.id
          )
          result.eventsIndexed++
          result.itemsIndexed += itemCount
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err)
          result.errors.push({
            path: `${yearName}/${eventFolderName}`,
            error: errorMsg,
          })
          console.error(`Failed to index event folder: ${yearName}/${eventFolderName}`, err)
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      result.errors.push({
        path: yearName,
        error: errorMsg,
      })
      console.error(`Failed to index year folder: ${yearName}`, err)
    }
  }

  // Update meta
  setMeta('last_full_index', new Date().toISOString())
  setMeta('index_version', '2')

  // Save database to file
  const dbData = exportDatabase()
  if (dbData) {
    await writeDatabaseFile(dbData)
  }

  console.log('Index rebuild complete:', result)
  return result
}

/**
 * Index a year folder
 */
async function indexYearFolder(yearName: string): Promise<Event> {
  const now = new Date().toISOString()

  // Check if _year.md exists
  const yearMdContent = await readFile([yearName], '_year.md')

  let yearEvent: Event

  if (yearMdContent) {
    const parsed = parseEventMarkdown(yearMdContent)
    yearEvent = {
      id: parsed.frontmatter.id || uuidv4(),
      type: 'year',
      title: parsed.frontmatter.title || yearName,
      description: parsed.frontmatter.description,
      startAt: parsed.frontmatter.startAt || `${yearName}-01-01`,
      endAt: parsed.frontmatter.endAt || `${yearName}-12-31`,
      tags: parsed.frontmatter.tags,
      filePath: `${yearName}/_year.md`,
      folderPath: yearName,
      createdAt: parsed.frontmatter.createdAt || now,
      updatedAt: parsed.frontmatter.updatedAt || now,
    }
  } else {
    // Create year event from folder name
    yearEvent = {
      id: uuidv4(),
      type: 'year',
      title: yearName,
      startAt: `${yearName}-01-01`,
      endAt: `${yearName}-12-31`,
      folderPath: yearName,
      createdAt: now,
      updatedAt: now,
    }
  }

  insertEventFromFile(yearEvent)

  // Update file index
  const stats = await getFileStats([yearName], '_year.md')
  if (stats) {
    upsertFileIndexEntry({
      path: stats.path,
      type: 'year',
      mtimeMs: stats.mtime,
      size: stats.size,
      lastIndexedAt: now,
    })
  }

  console.log(`Indexed year: ${yearName}`)
  return yearEvent
}

/**
 * Index an event folder and all its items
 * Returns the number of items indexed
 */
async function indexEventFolder(
  folderPath: string[],
  parentYearId: string
): Promise<number> {
  const folderName = folderPath[folderPath.length - 1]
  const now = new Date().toISOString()

  // Read _event.md if exists
  const eventMdContent = await readFile(folderPath, '_event.md')

  let event: Event

  if (eventMdContent) {
    const parsed = parseEventMarkdown(eventMdContent)
    event = {
      id: parsed.frontmatter.id || uuidv4(),
      type: parsed.frontmatter.type || 'event',
      title: parsed.frontmatter.title,
      description: parsed.frontmatter.description,
      startAt: parseDate(parsed.frontmatter.startAt) || now,
      endAt: parsed.frontmatter.endAt ? parseDate(parsed.frontmatter.endAt) : undefined,
      location: parsed.frontmatter.location,
      featuredPhotoSlug: parsed.frontmatter.featuredPhoto,
      tags: parsed.frontmatter.tags,
      parentId: parentYearId,
      filePath: [...folderPath, '_event.md'].join('/'),
      folderPath: folderPath.join('/'),
      createdAt: parsed.frontmatter.createdAt || now,
      updatedAt: parsed.frontmatter.updatedAt || now,
    }
  } else {
    // Infer from folder name
    const inferred = inferEventFromFolderName(folderName)
    event = {
      id: uuidv4(),
      type: inferred.type || 'event',
      title: inferred.title,
      startAt: parseDate(inferred.startAt) || now,
      parentId: parentYearId,
      folderPath: folderPath.join('/'),
      createdAt: now,
      updatedAt: now,
    }
  }

  insertEventFromFile(event)

  // Update file index for event
  const eventStats = await getFileStats(folderPath, '_event.md')
  if (eventStats) {
    upsertFileIndexEntry({
      path: eventStats.path,
      type: 'event',
      mtimeMs: eventStats.mtime,
      size: eventStats.size,
      lastIndexedAt: now,
    })
  }

  // Index items
  const entries = await listEntries(folderPath)
  const mdFiles = entries.filter(e =>
    e.kind === 'file' &&
    isMarkdownFile(e.name) &&
    !isSpecialFile(e.name)
  )

  // Build map of media files (slug -> filename)
  const mediaFiles = new Map<string, string>()
  for (const entry of entries) {
    if (entry.kind === 'file' && isMediaFile(entry.name)) {
      const slug = getSlugFromFilename(entry.name)
      mediaFiles.set(slug, entry.name)
    }
  }

  let itemCount = 0

  for (const mdFile of mdFiles) {
    try {
      await indexItemFile(folderPath, mdFile.name, event.id, mediaFiles)
      itemCount++
    } catch (err) {
      console.error(`Failed to index item: ${mdFile.path}`, err)
    }
  }

  // Index canvas layout
  const canvasContent = await readFile(folderPath, '_canvas.json')
  if (canvasContent) {
    const canvas = parseCanvasJson(canvasContent)
    if (canvas) {
      await indexCanvasLayout(event.id, canvas, folderPath)
    }
  }

  console.log(`Indexed event: ${folderPath.join('/')} with ${itemCount} items`)
  return itemCount
}

/**
 * Index a single item file
 */
async function indexItemFile(
  folderPath: string[],
  fileName: string,
  eventId: string,
  mediaFiles: Map<string, string>
): Promise<void> {
  const content = await readFile(folderPath, fileName)
  if (!content) return

  const parsed = parseItemMarkdown(content)
  const slug = getSlugFromFilename(fileName)
  const now = new Date().toISOString()

  // Determine content based on item type
  let itemContent = ''
  let mediaPath: string | undefined

  if (parsed.frontmatter.type === 'text') {
    // Text items: content is the markdown body
    itemContent = parsed.body || ''
  } else if (parsed.frontmatter.type === 'link') {
    // Link items: content is the URL
    itemContent = parsed.frontmatter.url || ''
  } else if (parsed.frontmatter.type === 'photo' || parsed.frontmatter.type === 'video') {
    // Media items: look for matching media file
    const media = parsed.frontmatter.media || mediaFiles.get(slug)
    if (media) {
      mediaPath = media
      // Content is a file reference
      itemContent = `file:${[...folderPath, media].join('/')}`
    }
  }

  const item: Item = {
    id: parsed.frontmatter.id || uuidv4(),
    eventId,
    itemType: parsed.frontmatter.type || 'text',
    content: itemContent,
    caption: parsed.frontmatter.caption,
    happenedAt: parsed.frontmatter.happenedAt ? parseDate(parsed.frontmatter.happenedAt) : undefined,
    place: parsed.frontmatter.place,
    people: parsed.frontmatter.people,
    tags: parsed.frontmatter.tags,
    url: parsed.frontmatter.url,
    bodyText: parsed.body,
    slug,
    filePath: [...folderPath, fileName].join('/'),
    mediaPath,
  }

  insertItemFromFile(item)

  // Update file index
  const stats = await getFileStats(folderPath, fileName)
  if (stats) {
    upsertFileIndexEntry({
      path: stats.path,
      type: 'item',
      mtimeMs: stats.mtime,
      size: stats.size,
      lastIndexedAt: now,
    })
  }
}

/**
 * Index canvas layout from _canvas.json
 */
async function indexCanvasLayout(
  eventId: string,
  canvas: CanvasJson,
  folderPath: string[]
): Promise<void> {
  const now = new Date().toISOString()

  for (const item of canvas.items) {
    // We need to find the item ID from the slug
    // For now, we'll store the slug and resolve later if needed
    const canvasItem: CanvasItem = {
      eventId,
      itemId: '', // Will be resolved when needed
      itemSlug: item.itemSlug,
      x: item.x,
      y: item.y,
      scale: item.scale,
      rotation: item.rotation,
      zIndex: item.zIndex,
      textScale: item.textScale,
    }

    // Try to find the item by slug to get the ID
    // This is a temporary lookup - in a real implementation we'd batch this
    const { getItemBySlug } = await import('../database')
    const foundItem = getItemBySlug(eventId, item.itemSlug)
    if (foundItem) {
      canvasItem.itemId = foundItem.id
      upsertCanvasItem(canvasItem)
    }
  }

  // Update file index
  const stats = await getFileStats(folderPath, '_canvas.json')
  if (stats) {
    upsertFileIndexEntry({
      path: stats.path,
      type: 'canvas',
      mtimeMs: stats.mtime,
      size: stats.size,
      lastIndexedAt: now,
    })
  }
}

/**
 * Check if a full rebuild is needed
 */
export function needsFullRebuild(): boolean {
  const indexVersion = getMeta('index_version')

  // Rebuild if no version or old version
  if (!indexVersion || indexVersion !== '2') {
    return true
  }

  return false
}

/**
 * Recovery function: Create markdown files for existing photos that don't have them
 * This is useful when photos exist but metadata files are missing
 */
export async function recoverFromPhotos(): Promise<{
  eventsCreated: number
  itemsCreated: number
  errors: string[]
}> {
  const { writeFile } = await import('../fileStorage')
  const { generateEventMarkdown, generateItemMarkdown } = await import('../markdown/generator')

  const result = {
    eventsCreated: 0,
    itemsCreated: 0,
    errors: [] as string[],
  }

  if (!hasStorageFolder()) {
    result.errors.push('No storage folder configured')
    return result
  }

  console.log('Starting photo recovery...')

  // Scan year folders
  const yearFolders = await listDirectories([])
  const years = yearFolders.filter(name => isYearFolder(name)).sort()

  for (const yearName of years) {
    console.log(`Scanning year: ${yearName}`)

    // Scan event folders within year
    const eventFolders = await listDirectories([yearName])

    for (const eventFolderName of eventFolders) {
      if (eventFolderName.startsWith('.')) continue

      const folderPath = [yearName, eventFolderName]

      try {
        // Check if _event.md exists
        const existingEventMd = await readFile(folderPath, '_event.md')

        if (!existingEventMd) {
          // Create _event.md from folder name
          console.log(`Creating _event.md for: ${folderPath.join('/')}`)

          const inferred = inferEventFromFolderName(eventFolderName)
          const now = new Date().toISOString()
          const eventId = uuidv4()

          const eventMd = generateEventMarkdown({
            id: eventId,
            type: 'event',
            title: inferred.title || eventFolderName,
            startAt: inferred.startAt || `${yearName}-01-01`,
            createdAt: now,
            updatedAt: now,
          })

          await writeFile(folderPath, '_event.md', eventMd)
          result.eventsCreated++
        }

        // Scan for photos without markdown files
        const entries = await listEntries(folderPath)
        const mediaFiles = entries.filter(e => e.kind === 'file' && isMediaFile(e.name))
        const mdFiles = new Set(
          entries
            .filter(e => e.kind === 'file' && isMarkdownFile(e.name))
            .map(e => getSlugFromFilename(e.name))
        )

        for (const mediaFile of mediaFiles) {
          const mediaSlug = getSlugFromFilename(mediaFile.name)

          // Check if a corresponding .md file exists
          if (!mdFiles.has(mediaSlug)) {
            console.log(`Creating markdown for: ${mediaFile.name}`)

            const now = new Date().toISOString()
            const itemId = uuidv4()
            const isVideo = mediaFile.name.match(/\.(mp4|mov|avi|webm)$/i)

            // Try to extract date from filename or use now
            const itemMd = generateItemMarkdown({
              id: itemId,
              type: isVideo ? 'video' : 'photo',
              media: mediaFile.name,
              caption: mediaSlug.replace(/-/g, ' ').replace(/_/g, ' '),
              createdAt: now,
              updatedAt: now,
            })

            await writeFile(folderPath, `${mediaSlug}.md`, itemMd)
            result.itemsCreated++
          }
        }
      } catch (err) {
        const errorMsg = `Error processing ${folderPath.join('/')}: ${(err as Error).message}`
        console.error(errorMsg)
        result.errors.push(errorMsg)
      }
    }
  }

  console.log('Recovery complete:', result)

  // Now rebuild the index to pick up the new files
  if (result.eventsCreated > 0 || result.itemsCreated > 0) {
    console.log('Rebuilding index after recovery...')
    await rebuildFullIndex()
  }

  return result
}
