// Sync Service: Incremental file synchronization
// Detects changes since last sync and updates the database accordingly

import {
  listEntries,
  listDirectories,
  getFileStats,
  hasStorageFolder,
} from '../fileStorage'
import {
  getAllFileIndexEntries,
} from '../database'
import {
  isYearFolder,
  isMediaFile,
  isMarkdownFile,
  isSpecialFile,
} from '../markdown/parser'
import { rebuildFullIndex } from './indexer'

export interface SyncResult {
  added: number
  modified: number
  deleted: number
  errors: string[]
  hasChanges: boolean
}

export interface FileChange {
  path: string
  type: 'added' | 'modified' | 'deleted'
  fileType: 'year' | 'event' | 'item' | 'media' | 'canvas'
}

// Debounce timer for sync
let syncDebounceTimer: ReturnType<typeof setTimeout> | null = null
const SYNC_DEBOUNCE_MS = 500

// Last sync timestamp
let lastSyncTime: number = 0

/**
 * Perform incremental sync - detect and process changes since last sync
 * This is called on window focus or manually
 */
export async function syncOnFocus(): Promise<SyncResult> {
  if (!hasStorageFolder()) {
    return {
      added: 0,
      modified: 0,
      deleted: 0,
      errors: ['No storage folder configured'],
      hasChanges: false,
    }
  }

  console.log('Starting incremental sync...')
  const startTime = Date.now()

  const result: SyncResult = {
    added: 0,
    modified: 0,
    deleted: 0,
    errors: [],
    hasChanges: false,
  }

  try {
    const changes = await detectChanges()

    // If there are significant changes, do a full rebuild
    // This is simpler and more reliable than incremental updates for now
    if (changes.length > 0) {
      console.log(`Detected ${changes.length} changes, performing full rebuild`)

      // Count the types of changes
      for (const change of changes) {
        if (change.type === 'added') result.added++
        else if (change.type === 'modified') result.modified++
        else if (change.type === 'deleted') result.deleted++
      }

      // Full rebuild to ensure consistency
      await rebuildFullIndex()
      result.hasChanges = true
    }

    lastSyncTime = Date.now()

    const duration = Date.now() - startTime
    console.log(`Sync completed in ${duration}ms:`, result)

  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    result.errors.push(errorMsg)
    console.error('Sync failed:', err)
  }

  return result
}

/**
 * Detect all file changes by comparing current files with the file index
 */
async function detectChanges(): Promise<FileChange[]> {
  const changes: FileChange[] = []

  // Get all indexed files from database
  const indexedFiles = getAllFileIndexEntries()
  const indexedPaths = new Map(indexedFiles.map(f => [f.path, f]))

  // Scan current file system
  const currentFiles = await scanAllFiles()
  const currentPaths = new Set(currentFiles.map(f => f.path))

  // Check for new or modified files
  for (const file of currentFiles) {
    const indexed = indexedPaths.get(file.path)

    if (!indexed) {
      // New file
      changes.push({
        path: file.path,
        type: 'added',
        fileType: determineFileType(file.path),
      })
    } else if (file.mtime > indexed.mtimeMs) {
      // Modified file
      changes.push({
        path: file.path,
        type: 'modified',
        fileType: determineFileType(file.path),
      })
    }
  }

  // Check for deleted files
  for (const indexed of indexedFiles) {
    if (!currentPaths.has(indexed.path)) {
      changes.push({
        path: indexed.path,
        type: 'deleted',
        fileType: indexed.type as FileChange['fileType'],
      })
    }
  }

  return changes
}

/**
 * Scan all relevant files in the storage folder
 */
async function scanAllFiles(): Promise<{ path: string; mtime: number }[]> {
  const files: { path: string; mtime: number }[] = []

  // Scan year folders
  const yearFolders = await listDirectories([])
  const years = yearFolders.filter(name => isYearFolder(name))

  for (const yearName of years) {
    // Check _year.md
    const yearStats = await getFileStats([yearName], '_year.md')
    if (yearStats) {
      files.push({ path: yearStats.path, mtime: yearStats.mtime })
    }

    // Scan event folders within year
    const eventFolders = await listDirectories([yearName])

    for (const eventFolderName of eventFolders) {
      if (eventFolderName.startsWith('.')) continue

      const folderPath = [yearName, eventFolderName]

      // Check _event.md
      const eventStats = await getFileStats(folderPath, '_event.md')
      if (eventStats) {
        files.push({ path: eventStats.path, mtime: eventStats.mtime })
      }

      // Check _canvas.json
      const canvasStats = await getFileStats(folderPath, '_canvas.json')
      if (canvasStats) {
        files.push({ path: canvasStats.path, mtime: canvasStats.mtime })
      }

      // Scan item markdown files (NOT media files - those aren't in the index)
      const entries = await listEntries(folderPath)

      for (const entry of entries) {
        if (entry.kind !== 'file') continue

        // Only include markdown files (except special files like _event.md)
        // Media files are NOT tracked in file_index, so don't scan them here
        if (isMarkdownFile(entry.name) && !isSpecialFile(entry.name)) {
          const stats = await getFileStats(folderPath, entry.name)
          if (stats) {
            files.push({ path: stats.path, mtime: stats.mtime })
          }
        }
      }
    }
  }

  return files
}

/**
 * Determine the file type from its path
 */
function determineFileType(path: string): FileChange['fileType'] {
  const parts = path.split('/')
  const filename = parts[parts.length - 1]

  if (filename === '_year.md') return 'year'
  if (filename === '_event.md') return 'event'
  if (filename === '_canvas.json') return 'canvas'
  if (isMediaFile(filename)) return 'media'
  if (isMarkdownFile(filename)) return 'item'

  return 'item' // Default fallback
}

/**
 * Debounced sync - waits for activity to settle before syncing
 */
export function debouncedSync(): Promise<SyncResult> {
  return new Promise((resolve) => {
    if (syncDebounceTimer) {
      clearTimeout(syncDebounceTimer)
    }

    syncDebounceTimer = setTimeout(async () => {
      const result = await syncOnFocus()
      resolve(result)
    }, SYNC_DEBOUNCE_MS)
  })
}

/**
 * Force a full rebuild (for manual trigger)
 */
export async function forceFullRebuild(): Promise<SyncResult> {
  if (!hasStorageFolder()) {
    return {
      added: 0,
      modified: 0,
      deleted: 0,
      errors: ['No storage folder configured'],
      hasChanges: false,
    }
  }

  console.log('Forcing full rebuild...')

  try {
    const indexResult = await rebuildFullIndex()

    return {
      added: indexResult.itemsIndexed,
      modified: 0,
      deleted: 0,
      errors: indexResult.errors.map(e => `${e.path}: ${e.error}`),
      hasChanges: indexResult.itemsIndexed > 0 || indexResult.eventsIndexed > 0,
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    return {
      added: 0,
      modified: 0,
      deleted: 0,
      errors: [errorMsg],
      hasChanges: false,
    }
  }
}

/**
 * Get time since last sync in milliseconds
 */
export function getTimeSinceLastSync(): number {
  return lastSyncTime > 0 ? Date.now() - lastSyncTime : -1
}

/**
 * Check if a sync is needed (e.g., more than X minutes since last sync)
 */
export function shouldAutoSync(thresholdMs: number = 5 * 60 * 1000): boolean {
  const timeSince = getTimeSinceLastSync()
  return timeSince < 0 || timeSince > thresholdMs
}
