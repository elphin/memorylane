// IndexedDB-based media storage for large files (photos, videos)
// This avoids localStorage quota issues by using IndexedDB which has much larger limits

const DB_NAME = 'memorylane_media'
const DB_VERSION = 1
const STORE_NAME = 'media'

let dbPromise: Promise<IDBDatabase> | null = null

function openDatabase(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onerror = () => {
      console.error('Failed to open IndexedDB:', request.error)
      reject(request.error)
    }

    request.onsuccess = () => {
      console.log('IndexedDB opened successfully')
      resolve(request.result)
    }

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' })
        console.log('IndexedDB media store created')
      }
    }
  })

  return dbPromise
}

/**
 * Store media content in IndexedDB
 * @param id - Unique identifier (usually the item ID)
 * @param content - Base64 data URL or blob data
 * @returns Promise that resolves when stored
 */
export async function storeMedia(id: string, content: string): Promise<void> {
  const db = await openDatabase()

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], 'readwrite')
    const store = transaction.objectStore(STORE_NAME)

    const request = store.put({ id, content, timestamp: Date.now() })

    request.onsuccess = () => {
      console.log('Media stored in IndexedDB:', id)
      resolve()
    }

    request.onerror = () => {
      console.error('Failed to store media:', request.error)
      reject(request.error)
    }
  })
}

/**
 * Retrieve media content from IndexedDB
 * @param id - The media identifier
 * @returns Promise with the content string or null if not found
 */
export async function getMedia(id: string): Promise<string | null> {
  const db = await openDatabase()

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], 'readonly')
    const store = transaction.objectStore(STORE_NAME)

    const request = store.get(id)

    request.onsuccess = () => {
      if (request.result) {
        resolve(request.result.content)
      } else {
        resolve(null)
      }
    }

    request.onerror = () => {
      console.error('Failed to get media:', request.error)
      reject(request.error)
    }
  })
}

/**
 * Delete media from IndexedDB
 * @param id - The media identifier
 */
export async function deleteMedia(id: string): Promise<void> {
  const db = await openDatabase()

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], 'readwrite')
    const store = transaction.objectStore(STORE_NAME)

    const request = store.delete(id)

    request.onsuccess = () => {
      console.log('Media deleted from IndexedDB:', id)
      resolve()
    }

    request.onerror = () => {
      console.error('Failed to delete media:', request.error)
      reject(request.error)
    }
  })
}

/**
 * Check if media exists in IndexedDB
 * @param id - The media identifier
 */
export async function hasMedia(id: string): Promise<boolean> {
  const content = await getMedia(id)
  return content !== null
}

/**
 * Get total size of all media in IndexedDB (approximate)
 */
export async function getMediaStorageSize(): Promise<number> {
  const db = await openDatabase()

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], 'readonly')
    const store = transaction.objectStore(STORE_NAME)

    const request = store.getAll()

    request.onsuccess = () => {
      const items = request.result || []
      let totalSize = 0
      for (const item of items) {
        totalSize += item.content?.length || 0
      }
      resolve(totalSize)
    }

    request.onerror = () => {
      reject(request.error)
    }
  })
}
