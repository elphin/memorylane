// Sync Engine: Indexer
// Scans the file system and rebuilds the SQLite index from markdown files

import { v4 as uuidv4 } from 'uuid'
import type { Event, Item, CanvasItem } from '../../models/types'
import {
  listEntries,
  listDirectories,
  readFile,
  writeFile,
  getFileStats,
  hasStorageFolder,
  readFileAsBlob,
  copyFile,
  deleteFile,
  getDirectory,
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
  getItemTypeFromFilename,
} from '../markdown/parser'
import {
  generateItemMarkdown,
  generateEventMarkdown,
  generateCanvasJson,
  generateSlug,
  generateEventFolderName,
} from '../markdown/generator'
import type { CanvasJson, ItemFrontmatter } from '../markdown/schema'
import { extractExifData } from '../../utils/exif'

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

      // Check for loose media files in year folder (not in event folders)
      const yearEntries = await listEntries([yearName])
      const looseMediaFiles = yearEntries.filter(e =>
        e.kind === 'file' && isMediaFile(e.name)
      )

      // Process loose media files - create event folders for them
      const createdEventFolders: string[] = []
      for (const mediaEntry of looseMediaFiles) {
        try {
          const eventFolderName = await createEventForLooseMedia(yearName, mediaEntry.name)
          if (eventFolderName) {
            createdEventFolders.push(eventFolderName)
          }
        } catch (err) {
          console.error(`Failed to create event for loose media: ${mediaEntry.name}`, err)
        }
      }

      if (looseMediaFiles.length > 0) {
        console.log(`Processed ${looseMediaFiles.length} loose media files in ${yearName}, created ${createdEventFolders.length} event folders`)
      }

      // Index event folders within year (including newly created ones)
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

  // Build map of media files (normalized slug -> filename)
  // Use lowercase slugs for case-insensitive comparison
  const mediaFiles = new Map<string, string>()
  for (const entry of entries) {
    if (entry.kind === 'file' && isMediaFile(entry.name)) {
      const slug = getSlugFromFilename(entry.name).toLowerCase()
      mediaFiles.set(slug, entry.name)
    }
  }

  // Build set of existing markdown slugs (lowercase for case-insensitive comparison)
  const existingMdSlugs = new Set(
    mdFiles.map(f => getSlugFromFilename(f.name).toLowerCase())
  )

  // Detect orphan media files (media without corresponding .md)
  const orphanMedia: string[] = []
  for (const [slug, filename] of mediaFiles.entries()) {
    if (!existingMdSlugs.has(slug)) {
      orphanMedia.push(filename)
    }
  }

  // Create markdown for orphan media files
  const canvasItemsForPositioning: CanvasItem[] = []
  for (const mediaFilename of orphanMedia) {
    try {
      const slug = await createMarkdownForOrphanMedia(
        folderPath,
        mediaFilename,
        event.id,
        canvasItemsForPositioning
      )
      // Add to mdFiles list so it gets indexed
      mdFiles.push({ kind: 'file', name: `${slug}.md`, path: `${folderPath.join('/')}/${slug}.md` })
      existingMdSlugs.add(slug)
    } catch (err) {
      console.error(`Failed to create markdown for orphan media: ${mediaFilename}`, err)
    }
  }

  if (orphanMedia.length > 0) {
    console.log(`Processed ${orphanMedia.length} orphan media files in ${folderPath.join('/')}`)
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
 * Create markdown file for an orphan media file (media without .md)
 * Returns the slug of the created item
 */
async function createMarkdownForOrphanMedia(
  folderPath: string[],
  mediaFilename: string,
  eventId: string,
  existingCanvasItems: CanvasItem[]
): Promise<string> {
  const now = new Date().toISOString()
  const itemId = uuidv4()
  const itemType = getItemTypeFromFilename(mediaFilename)

  if (!itemType) {
    throw new Error(`Unknown media type for: ${mediaFilename}`)
  }

  // Generate slug from filename
  const filenameWithoutExt = mediaFilename.replace(/\.[^/.]+$/, '')
  const slug = generateSlug(filenameWithoutExt)

  // Try to extract EXIF date for photos
  let happenedAt: string | undefined
  if (itemType === 'photo') {
    try {
      const blob = await readFileAsBlob(folderPath, mediaFilename)
      if (blob) {
        // Convert Blob to File for EXIF extraction
        const file = new File([blob], mediaFilename, { type: blob.type })
        const exifData = await extractExifData(file)
        if (exifData.dateTaken) {
          happenedAt = exifData.dateTaken
        }
      }
    } catch (err) {
      console.warn(`Could not extract EXIF from ${mediaFilename}:`, err)
    }
  }

  // Generate markdown frontmatter
  const frontmatter: ItemFrontmatter = {
    id: itemId,
    type: itemType,
    media: mediaFilename,
    caption: filenameWithoutExt.replace(/[-_]/g, ' '),
    happenedAt,
    createdAt: now,
    updatedAt: now,
  }

  const markdown = generateItemMarkdown(frontmatter)

  // Write the markdown file
  await writeFile(folderPath, `${slug}.md`, markdown)
  console.log(`Created markdown for orphan media: ${mediaFilename} -> ${slug}.md`)

  // Calculate auto-position for canvas (grid layout)
  const ITEM_WIDTH = 200
  const ITEM_HEIGHT = 150
  const GAP = 24
  const ITEMS_PER_ROW = 5

  const index = existingCanvasItems.length
  const row = Math.floor(index / ITEMS_PER_ROW)
  const col = index % ITEMS_PER_ROW

  const canvasItem: CanvasItem = {
    eventId,
    itemId,
    itemSlug: slug,
    x: col * (ITEM_WIDTH + GAP) - (ITEMS_PER_ROW * (ITEM_WIDTH + GAP)) / 2 + ITEM_WIDTH / 2,
    y: row * (ITEM_HEIGHT + GAP),
    scale: 1,
    rotation: 0,
    zIndex: index,
  }

  // Update canvas items array for next item positioning
  existingCanvasItems.push(canvasItem)

  // Update _canvas.json
  const canvasContent = await readFile(folderPath, '_canvas.json')
  let canvas: CanvasJson = canvasContent
    ? parseCanvasJson(canvasContent) || { version: 1, items: [] }
    : { version: 1, items: [] }

  canvas.items.push({
    itemSlug: slug,
    x: canvasItem.x,
    y: canvasItem.y,
    scale: canvasItem.scale,
    rotation: canvasItem.rotation,
    zIndex: canvasItem.zIndex,
  })
  canvas.updatedAt = now

  await writeFile(folderPath, '_canvas.json', generateCanvasJson(canvas))

  return slug
}

/**
 * Create an event folder for a loose media file in a year folder
 * Moves the media file into the new event folder and generates all necessary files
 * Returns the created event folder name
 */
async function createEventForLooseMedia(
  yearName: string,
  mediaFilename: string
): Promise<string | null> {
  const now = new Date().toISOString()
  const eventId = uuidv4()
  const itemId = uuidv4()
  const itemType = getItemTypeFromFilename(mediaFilename)

  if (!itemType) {
    console.warn(`Unknown media type for loose file: ${mediaFilename}`)
    return null
  }

  // Try to extract EXIF date for photos
  let mediaDate: Date | null = null
  if (itemType === 'photo') {
    try {
      const blob = await readFileAsBlob([yearName], mediaFilename)
      if (blob) {
        const file = new File([blob], mediaFilename, { type: blob.type })
        const exifData = await extractExifData(file)
        if (exifData.dateTaken) {
          mediaDate = new Date(exifData.dateTaken)
        }
      }
    } catch (err) {
      console.warn(`Could not extract EXIF from ${mediaFilename}:`, err)
    }
  }

  // Fallback to file modification time if no EXIF date
  if (!mediaDate) {
    const stats = await getFileStats([yearName], mediaFilename)
    if (stats) {
      mediaDate = new Date(stats.mtime)
    } else {
      mediaDate = new Date() // Fallback to now
    }
  }

  // Generate caption from filename
  const filenameWithoutExt = mediaFilename.replace(/\.[^/.]+$/, '')
  const caption = filenameWithoutExt.replace(/[-_]/g, ' ')

  // Generate event folder name: YYYY-MM-DD Caption
  const eventFolderName = generateEventFolderName(caption, mediaDate.toISOString())
  const eventFolderPath = [yearName, eventFolderName]

  console.log(`Creating event folder for loose media: ${yearName}/${mediaFilename} -> ${eventFolderName}`)

  // Create the event folder
  const eventDir = await getDirectory(...eventFolderPath)
  if (!eventDir) {
    console.error(`Failed to create event folder: ${eventFolderPath.join('/')}`)
    return null
  }

  // Move the media file to the new event folder
  const moveSuccess = await copyFile(
    [yearName],
    mediaFilename,
    eventFolderPath,
    mediaFilename
  )

  if (!moveSuccess) {
    console.error(`Failed to copy media file to event folder: ${mediaFilename}`)
    return null
  }

  // Delete the original file
  await deleteFile([yearName], mediaFilename)

  // Generate item slug
  const slug = generateSlug(filenameWithoutExt)

  // Create _event.md
  const eventMarkdown = generateEventMarkdown({
    id: eventId,
    type: 'event',
    title: caption,
    startAt: mediaDate.toISOString().split('T')[0],
    createdAt: now,
    updatedAt: now,
  })
  await writeFile(eventFolderPath, '_event.md', eventMarkdown)

  // Create item markdown file
  const itemFrontmatter: ItemFrontmatter = {
    id: itemId,
    type: itemType,
    media: mediaFilename,
    caption,
    happenedAt: mediaDate.toISOString(),
    createdAt: now,
    updatedAt: now,
  }
  const itemMarkdown = generateItemMarkdown(itemFrontmatter)
  await writeFile(eventFolderPath, `${slug}.md`, itemMarkdown)

  // Create _canvas.json with the item centered
  const canvas: CanvasJson = {
    version: 1,
    items: [{
      itemSlug: slug,
      x: 0,
      y: 0,
      scale: 1,
      rotation: 0,
      zIndex: 0,
    }],
    updatedAt: now,
  }
  await writeFile(eventFolderPath, '_canvas.json', generateCanvasJson(canvas))

  console.log(`Created event for loose media: ${eventFolderPath.join('/')}`)
  return eventFolderName
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
      width: item.width,
      height: item.height,
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
 * Cleanup function: Remove duplicate .md files created by orphan detection bug
 * Keeps the original .md (matching media filename) and removes auto-generated ones
 */
export async function cleanupDuplicateMarkdownFiles(): Promise<{
  duplicatesRemoved: number
  canvasUpdated: number
  errors: string[]
}> {
  const result = {
    duplicatesRemoved: 0,
    canvasUpdated: 0,
    errors: [] as string[],
  }

  if (!hasStorageFolder()) {
    result.errors.push('No storage folder configured')
    return result
  }

  console.log('Starting duplicate cleanup...')

  // Scan year folders
  const yearFolders = await listDirectories([])
  const years = yearFolders.filter(name => isYearFolder(name)).sort()

  for (const yearName of years) {
    // Scan event folders within year
    const eventFolders = await listDirectories([yearName])

    for (const eventFolderName of eventFolders) {
      if (eventFolderName.startsWith('.')) continue

      const folderPath = [yearName, eventFolderName]

      try {
        const entries = await listEntries(folderPath)

        // Get all media files and their expected slugs
        const mediaFiles = new Map<string, string>() // lowercase slug -> original filename
        for (const entry of entries) {
          if (entry.kind === 'file' && isMediaFile(entry.name)) {
            const slug = getSlugFromFilename(entry.name).toLowerCase()
            mediaFiles.set(slug, entry.name)
          }
        }

        // Get all markdown files
        const mdFiles = entries.filter(e =>
          e.kind === 'file' &&
          isMarkdownFile(e.name) &&
          !isSpecialFile(e.name)
        )

        // Group markdown files by their lowercase slug
        const mdBySlug = new Map<string, string[]>()
        for (const md of mdFiles) {
          const slug = getSlugFromFilename(md.name).toLowerCase()
          if (!mdBySlug.has(slug)) {
            mdBySlug.set(slug, [])
          }
          mdBySlug.get(slug)!.push(md.name)
        }

        // Find duplicates: multiple .md files for the same slug
        const toDelete: string[] = []
        const deletedSlugs: string[] = []

        for (const [slug, mdNames] of mdBySlug.entries()) {
          if (mdNames.length > 1) {
            // Sort: prefer the one that matches the media file name exactly
            const mediaFilename = mediaFiles.get(slug)
            const expectedMdName = mediaFilename
              ? getSlugFromFilename(mediaFilename) + '.md'
              : null

            // Keep the first match, delete others
            let kept = false
            for (const mdName of mdNames) {
              if (!kept && expectedMdName && mdName.toLowerCase() === expectedMdName.toLowerCase()) {
                // Keep this one
                kept = true
                console.log(`Keeping: ${folderPath.join('/')}/${mdName}`)
              } else if (!kept && !expectedMdName) {
                // No media file, keep the first one
                kept = true
                console.log(`Keeping (no media): ${folderPath.join('/')}/${mdName}`)
              } else {
                // Delete this duplicate
                toDelete.push(mdName)
                deletedSlugs.push(getSlugFromFilename(mdName))
                console.log(`Deleting duplicate: ${folderPath.join('/')}/${mdName}`)
              }
            }
          }
        }

        // Also find orphan .md files that don't have corresponding media
        // (auto-generated .md files where the media was later added properly)
        for (const md of mdFiles) {
          const mdSlug = getSlugFromFilename(md.name).toLowerCase()

          // Check if this looks like an auto-generated file (has UUID suffix)
          if (md.name.match(/_[a-f0-9]{8}\.md$/i)) {
            // Check if there's a non-UUID version
            const baseSlug = mdSlug.replace(/_[a-f0-9]{8}$/, '')
            if (mdBySlug.has(baseSlug) && !toDelete.includes(md.name)) {
              toDelete.push(md.name)
              deletedSlugs.push(getSlugFromFilename(md.name))
              console.log(`Deleting auto-generated: ${folderPath.join('/')}/${md.name}`)
            }
          }
        }

        // Delete the duplicate files
        for (const mdName of toDelete) {
          try {
            await deleteFile(folderPath, mdName)
            result.duplicatesRemoved++
          } catch (err) {
            result.errors.push(`Failed to delete ${folderPath.join('/')}/${mdName}: ${(err as Error).message}`)
          }
        }

        // Update _canvas.json to remove references to deleted items
        if (deletedSlugs.length > 0) {
          const canvasContent = await readFile(folderPath, '_canvas.json')
          if (canvasContent) {
            try {
              const canvas = JSON.parse(canvasContent) as { items: { itemSlug: string }[] }
              const originalCount = canvas.items.length

              // Filter out deleted items (case-insensitive)
              const deletedSlugsLower = new Set(deletedSlugs.map(s => s.toLowerCase()))
              canvas.items = canvas.items.filter(item =>
                !deletedSlugsLower.has(item.itemSlug.toLowerCase())
              )

              if (canvas.items.length < originalCount) {
                await writeFile(folderPath, '_canvas.json', JSON.stringify(canvas, null, 2))
                result.canvasUpdated++
                console.log(`Updated canvas: ${folderPath.join('/')}/_canvas.json (removed ${originalCount - canvas.items.length} items)`)
              }
            } catch (err) {
              result.errors.push(`Failed to update canvas ${folderPath.join('/')}: ${(err as Error).message}`)
            }
          }
        }

      } catch (err) {
        result.errors.push(`Error processing ${folderPath.join('/')}: ${(err as Error).message}`)
      }
    }
  }

  console.log('Cleanup complete:', result)
  return result
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
