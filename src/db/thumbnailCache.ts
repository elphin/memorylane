// Thumbnail Cache using IndexedDB
// Stores pre-generated thumbnails at different sizes for fast loading

const DB_NAME = 'memorylane_thumbnails'
const DB_VERSION = 1
const STORE_NAME = 'thumbnails'

// Thumbnail sizes for different zoom levels
export const THUMBNAIL_SIZES = {
  small: 64,    // L0/L1: Overview, minimal detail
  medium: 256,  // L2: Canvas view, good detail
  large: 1024,  // L3: Focus view, high detail
} as const

export type ThumbnailSize = keyof typeof THUMBNAIL_SIZES

interface ThumbnailEntry {
  key: string        // filePath + size
  filePath: string   // Original file path
  size: ThumbnailSize
  blob: Blob         // The thumbnail image data
  width: number      // Actual thumbnail dimensions
  height: number
  createdAt: number  // Timestamp for cache invalidation
}

let db: IDBDatabase | null = null

/**
 * Initialize the IndexedDB database
 */
async function initDB(): Promise<IDBDatabase> {
  if (db) return db

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onerror = () => reject(request.error)

    request.onsuccess = () => {
      db = request.result
      resolve(db)
    }

    request.onupgradeneeded = (event) => {
      const database = (event.target as IDBOpenDBRequest).result

      // Create object store with composite key
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: 'key' })
        store.createIndex('filePath', 'filePath', { unique: false })
        store.createIndex('createdAt', 'createdAt', { unique: false })
      }
    }
  })
}

/**
 * Generate a cache key from file path and size
 */
function getCacheKey(filePath: string, size: ThumbnailSize): string {
  return `${filePath}::${size}`
}

/**
 * Get a cached thumbnail
 */
export async function getCachedThumbnail(
  filePath: string,
  size: ThumbnailSize
): Promise<ImageBitmap | null> {
  try {
    const database = await initDB()
    const key = getCacheKey(filePath, size)

    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readonly')
      const store = transaction.objectStore(STORE_NAME)
      const request = store.get(key)

      request.onerror = () => reject(request.error)
      request.onsuccess = async () => {
        const entry = request.result as ThumbnailEntry | undefined
        if (entry?.blob) {
          try {
            // Convert blob back to ImageBitmap
            const bitmap = await createImageBitmap(entry.blob)
            resolve(bitmap)
          } catch {
            resolve(null)
          }
        } else {
          resolve(null)
        }
      }
    })
  } catch (err) {
    console.warn('Failed to get cached thumbnail:', err)
    return null
  }
}

/**
 * Store a thumbnail in the cache
 */
export async function cacheThumbnail(
  filePath: string,
  size: ThumbnailSize,
  bitmap: ImageBitmap
): Promise<void> {
  try {
    const database = await initDB()
    const key = getCacheKey(filePath, size)

    // Convert ImageBitmap to Blob using OffscreenCanvas
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.drawImage(bitmap, 0, 0)
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.85 })

    const entry: ThumbnailEntry = {
      key,
      filePath,
      size,
      blob,
      width: bitmap.width,
      height: bitmap.height,
      createdAt: Date.now(),
    }

    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite')
      const store = transaction.objectStore(STORE_NAME)
      const request = store.put(entry)

      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve()
    })
  } catch (err) {
    console.warn('Failed to cache thumbnail:', err)
  }
}

/**
 * Generate a thumbnail from a blob using createImageBitmap's resize options
 * This is hardware-accelerated and very fast
 */
export async function generateThumbnail(
  blob: Blob,
  size: ThumbnailSize
): Promise<ImageBitmap> {
  const maxDim = THUMBNAIL_SIZES[size]

  // First decode to get original dimensions
  const original = await createImageBitmap(blob)
  const { width, height } = original

  // Calculate scaled dimensions maintaining aspect ratio
  let targetWidth: number
  let targetHeight: number

  if (width > height) {
    targetWidth = Math.min(width, maxDim)
    targetHeight = Math.round((height / width) * targetWidth)
  } else {
    targetHeight = Math.min(height, maxDim)
    targetWidth = Math.round((width / height) * targetHeight)
  }

  // Close original bitmap to free memory
  original.close()

  // Generate resized bitmap - this uses hardware acceleration
  const thumbnail = await createImageBitmap(blob, {
    resizeWidth: targetWidth,
    resizeHeight: targetHeight,
    resizeQuality: 'medium', // 'low' | 'medium' | 'high'
  })

  return thumbnail
}

/**
 * Get or generate a thumbnail
 * Checks cache first, generates and caches if not found
 */
export async function getThumbnail(
  filePath: string,
  blob: Blob,
  size: ThumbnailSize
): Promise<ImageBitmap> {
  // Try cache first
  const cached = await getCachedThumbnail(filePath, size)
  if (cached) {
    return cached
  }

  // Generate new thumbnail
  const thumbnail = await generateThumbnail(blob, size)

  // Cache in background (don't await)
  cacheThumbnail(filePath, size, thumbnail).catch(() => {})

  return thumbnail
}

/**
 * Clear all cached thumbnails
 */
export async function clearThumbnailCache(): Promise<void> {
  try {
    const database = await initDB()

    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite')
      const store = transaction.objectStore(STORE_NAME)
      const request = store.clear()

      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        console.log('Thumbnail cache cleared')
        resolve()
      }
    })
  } catch (err) {
    console.warn('Failed to clear thumbnail cache:', err)
  }
}

/**
 * Get cache statistics
 */
export async function getCacheStats(): Promise<{
  count: number
  totalSize: number
}> {
  try {
    const database = await initDB()

    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readonly')
      const store = transaction.objectStore(STORE_NAME)
      const request = store.getAll()

      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const entries = request.result as ThumbnailEntry[]
        const totalSize = entries.reduce((sum, entry) => sum + entry.blob.size, 0)
        resolve({
          count: entries.length,
          totalSize,
        })
      }
    })
  } catch (err) {
    console.warn('Failed to get cache stats:', err)
    return { count: 0, totalSize: 0 }
  }
}

/**
 * Delete thumbnails for a specific file
 */
export async function deleteThumbnailsForFile(filePath: string): Promise<void> {
  try {
    const database = await initDB()

    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite')
      const store = transaction.objectStore(STORE_NAME)
      const index = store.index('filePath')
      const request = index.getAllKeys(filePath)

      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const keys = request.result
        keys.forEach(key => store.delete(key))
        resolve()
      }
    })
  } catch (err) {
    console.warn('Failed to delete thumbnails:', err)
  }
}
