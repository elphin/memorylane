// File-based storage using File System Access API
// Organizes data in an Obsidian-style folder structure:
// /MemoryLane/
//   /2024/
//     /Vakantie Spanje/
//       event.json
//       photo1.jpg
//       photo2.jpg

// Type declarations for File System Access API (not fully typed in TypeScript's default types)
declare global {
  interface Window {
    showDirectoryPicker(options?: {
      id?: string
      mode?: 'read' | 'readwrite'
      startIn?: 'desktop' | 'documents' | 'downloads' | 'music' | 'pictures' | 'videos'
    }): Promise<FileSystemDirectoryHandle>
  }

  interface FileSystemDirectoryHandle {
    queryPermission(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>
    requestPermission(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>
    values(): AsyncIterableIterator<FileSystemHandle>
  }
}

const STORAGE_KEY = 'memorylane_folder_handle'

let rootHandle: FileSystemDirectoryHandle | null = null

/**
 * Check if File System Access API is supported
 */
export function isFileSystemSupported(): boolean {
  return 'showDirectoryPicker' in window
}

/**
 * Request user to select a folder for storage
 * Returns the folder handle or null if cancelled
 */
export async function selectStorageFolder(): Promise<FileSystemDirectoryHandle | null> {
  if (!isFileSystemSupported()) {
    console.error('File System Access API not supported')
    return null
  }

  try {
    const handle = await window.showDirectoryPicker({
      id: 'memorylane-storage',
      mode: 'readwrite',
      startIn: 'documents',
    })

    rootHandle = handle

    // Try to persist the handle for future sessions
    await persistHandle(handle)

    console.log('Storage folder selected:', handle.name)
    return handle
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      console.log('User cancelled folder selection')
      return null
    }
    console.error('Failed to select folder:', err)
    return null
  }
}

/**
 * Try to restore previously selected folder handle
 */
export async function restoreStorageFolder(): Promise<FileSystemDirectoryHandle | null> {
  if (!isFileSystemSupported()) return null

  try {
    // Check if we have a persisted handle in IndexedDB
    const handle = await getPersistedHandle()
    if (!handle) return null

    // Verify we still have permission
    const permission = await handle.queryPermission({ mode: 'readwrite' })
    if (permission === 'granted') {
      rootHandle = handle
      console.log('Restored storage folder:', handle.name)
      return handle
    }

    // Try to request permission again
    const newPermission = await handle.requestPermission({ mode: 'readwrite' })
    if (newPermission === 'granted') {
      rootHandle = handle
      console.log('Re-authorized storage folder:', handle.name)
      return handle
    }

    return null
  } catch (err) {
    console.warn('Could not restore folder handle:', err)
    return null
  }
}

/**
 * Get the current storage folder handle
 */
export function getStorageFolder(): FileSystemDirectoryHandle | null {
  return rootHandle
}

/**
 * Check if a storage folder is configured
 */
export function hasStorageFolder(): boolean {
  return rootHandle !== null
}

// IndexedDB for persisting the folder handle
const IDB_NAME = 'memorylane_handles'
const IDB_STORE = 'handles'

async function persistHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(IDB_NAME, 1)

    request.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE)
      }
    }

    request.onsuccess = () => {
      const db = request.result
      const tx = db.transaction(IDB_STORE, 'readwrite')
      const store = tx.objectStore(IDB_STORE)
      store.put(handle, STORAGE_KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    }

    request.onerror = () => reject(request.error)
  })
}

async function getPersistedHandle(): Promise<FileSystemDirectoryHandle | null> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(IDB_NAME, 1)

    request.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE)
      }
    }

    request.onsuccess = () => {
      const db = request.result
      const tx = db.transaction(IDB_STORE, 'readonly')
      const store = tx.objectStore(IDB_STORE)
      const getRequest = store.get(STORAGE_KEY)
      getRequest.onsuccess = () => resolve(getRequest.result || null)
      getRequest.onerror = () => reject(getRequest.error)
    }

    request.onerror = () => reject(request.error)
  })
}

/**
 * Get or create a directory within the storage folder
 */
export async function getDirectory(...pathParts: string[]): Promise<FileSystemDirectoryHandle | null> {
  if (!rootHandle) return null

  try {
    let current = rootHandle
    for (const part of pathParts) {
      // Sanitize folder name (remove invalid characters)
      const safeName = sanitizeName(part)
      current = await current.getDirectoryHandle(safeName, { create: true })
    }
    return current
  } catch (err) {
    console.error('Failed to get/create directory:', pathParts, err)
    return null
  }
}

/**
 * Write a file to a specific path within storage
 */
export async function writeFile(
  dirPath: string[],
  fileName: string,
  content: string | Blob | ArrayBuffer
): Promise<boolean> {
  const dir = await getDirectory(...dirPath)
  if (!dir) return false

  try {
    const safeFileName = sanitizeName(fileName)
    const fileHandle = await dir.getFileHandle(safeFileName, { create: true })
    const writable = await fileHandle.createWritable()

    if (typeof content === 'string') {
      await writable.write(content)
    } else {
      await writable.write(content)
    }

    await writable.close()
    console.log('File written:', [...dirPath, safeFileName].join('/'))
    return true
  } catch (err) {
    console.error('Failed to write file:', err)
    return false
  }
}

/**
 * Read a file from a specific path within storage
 */
export async function readFile(dirPath: string[], fileName: string): Promise<string | null> {
  const dir = await getDirectory(...dirPath)
  if (!dir) return null

  try {
    const safeFileName = sanitizeName(fileName)
    const fileHandle = await dir.getFileHandle(safeFileName)
    const file = await fileHandle.getFile()
    return await file.text()
  } catch (err) {
    // File doesn't exist is not an error
    if ((err as Error).name !== 'NotFoundError') {
      console.error('Failed to read file:', err)
    }
    return null
  }
}

/**
 * Read a file as a data URL (for images)
 */
export async function readFileAsDataURL(dirPath: string[], fileName: string): Promise<string | null> {
  const dir = await getDirectory(...dirPath)
  if (!dir) return null

  try {
    const safeFileName = sanitizeName(fileName)
    const fileHandle = await dir.getFileHandle(safeFileName)
    const file = await fileHandle.getFile()

    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(file)
    })
  } catch (err) {
    if ((err as Error).name !== 'NotFoundError') {
      console.error('Failed to read file as data URL:', err)
    }
    return null
  }
}

/**
 * Read a file and return an Object URL (much faster than data URL)
 * Object URLs are references to blobs and don't require encoding file to base64
 * IMPORTANT: Caller must revoke the URL when done using URL.revokeObjectURL()
 */
export async function readFileAsObjectURL(dirPath: string[], fileName: string): Promise<string | null> {
  const dir = await getDirectory(...dirPath)
  if (!dir) return null

  try {
    const safeFileName = sanitizeName(fileName)
    const fileHandle = await dir.getFileHandle(safeFileName)
    const file = await fileHandle.getFile()

    // Create an object URL - this is instant and doesn't encode the file
    return URL.createObjectURL(file)
  } catch (err) {
    if ((err as Error).name !== 'NotFoundError') {
      console.error('Failed to read file as object URL:', err)
    }
    return null
  }
}

/**
 * Read a file and return it as a Blob (for use with createImageBitmap)
 * This is the fastest way to get image data for hardware-accelerated decoding
 */
export async function readFileAsBlob(dirPath: string[], fileName: string): Promise<Blob | null> {
  const dir = await getDirectory(...dirPath)
  if (!dir) return null

  try {
    const safeFileName = sanitizeName(fileName)
    const fileHandle = await dir.getFileHandle(safeFileName)
    const file = await fileHandle.getFile()
    return file
  } catch (err) {
    if ((err as Error).name !== 'NotFoundError') {
      console.error('Failed to read file as blob:', err)
    }
    return null
  }
}

/**
 * Write a base64 data URL as an actual image file
 */
export async function writeImageFromDataURL(
  dirPath: string[],
  fileName: string,
  dataURL: string
): Promise<boolean> {
  try {
    // Convert data URL to blob
    const response = await fetch(dataURL)
    const blob = await response.blob()

    return await writeFile(dirPath, fileName, blob)
  } catch (err) {
    console.error('Failed to write image:', err)
    return false
  }
}

/**
 * Delete a file
 */
export async function deleteFile(dirPath: string[], fileName: string): Promise<boolean> {
  const dir = await getDirectory(...dirPath)
  if (!dir) return false

  try {
    const safeFileName = sanitizeName(fileName)
    await dir.removeEntry(safeFileName)
    console.log('File deleted:', [...dirPath, safeFileName].join('/'))
    return true
  } catch (err) {
    if ((err as Error).name !== 'NotFoundError') {
      console.error('Failed to delete file:', err)
    }
    return false
  }
}

/**
 * List all files in a directory
 */
export async function listFiles(dirPath: string[]): Promise<string[]> {
  const dir = await getDirectory(...dirPath)
  if (!dir) return []

  try {
    const files: string[] = []
    for await (const entry of dir.values()) {
      if (entry.kind === 'file') {
        files.push(entry.name)
      }
    }
    return files
  } catch (err) {
    console.error('Failed to list files:', err)
    return []
  }
}

/**
 * List all subdirectories
 */
export async function listDirectories(dirPath: string[]): Promise<string[]> {
  let dir: FileSystemDirectoryHandle | null

  if (dirPath.length === 0) {
    dir = rootHandle
  } else {
    dir = await getDirectory(...dirPath)
  }

  if (!dir) return []

  try {
    const dirs: string[] = []
    for await (const entry of dir.values()) {
      if (entry.kind === 'directory') {
        dirs.push(entry.name)
      }
    }
    return dirs
  } catch (err) {
    console.error('Failed to list directories:', err)
    return []
  }
}

/**
 * Sanitize a string for use as a file/folder name
 */
function sanitizeName(name: string): string {
  // Remove or replace invalid characters
  return name
    .replace(/[<>:"/\\|?*]/g, '_')  // Invalid chars
    .replace(/\s+/g, ' ')           // Multiple spaces to single
    .trim()
    .substring(0, 200)              // Limit length
    || 'unnamed'
}

/**
 * Generate a unique filename for a photo
 */
export function generatePhotoFilename(originalName: string, itemId: string): string {
  const ext = originalName.split('.').pop()?.toLowerCase() || 'jpg'
  const baseName = originalName.replace(/\.[^/.]+$/, '').substring(0, 50)
  const shortId = itemId.substring(0, 8)
  return `${baseName}_${shortId}.${ext}`
}

// ============================================================================
// Extended file operations for sync engine
// ============================================================================

export interface FileStats {
  name: string
  path: string  // Relative path from root
  mtime: number // Modification time in ms
  size: number
}

export interface DirectoryEntry {
  name: string
  kind: 'file' | 'directory'
  path: string  // Relative path from root
}

/**
 * Get file stats (modification time, size)
 */
export async function getFileStats(
  dirPath: string[],
  fileName: string
): Promise<FileStats | null> {
  const dir = await getDirectory(...dirPath)
  if (!dir) return null

  try {
    const safeFileName = sanitizeName(fileName)
    const fileHandle = await dir.getFileHandle(safeFileName)
    const file = await fileHandle.getFile()

    return {
      name: safeFileName,
      path: [...dirPath, safeFileName].join('/'),
      mtime: file.lastModified,
      size: file.size,
    }
  } catch (err) {
    if ((err as Error).name !== 'NotFoundError') {
      console.error('Failed to get file stats:', err)
    }
    return null
  }
}

/**
 * List all entries (files and directories) in a directory
 */
export async function listEntries(dirPath: string[]): Promise<DirectoryEntry[]> {
  let dir: FileSystemDirectoryHandle | null

  if (dirPath.length === 0) {
    dir = rootHandle
  } else {
    dir = await getDirectory(...dirPath)
  }

  if (!dir) return []

  try {
    const entries: DirectoryEntry[] = []
    for await (const entry of dir.values()) {
      entries.push({
        name: entry.name,
        kind: entry.kind,
        path: [...dirPath, entry.name].join('/'),
      })
    }
    return entries
  } catch (err) {
    console.error('Failed to list entries:', err)
    return []
  }
}

/**
 * Scan a directory recursively and return all file stats
 */
export async function scanDirectoryRecursive(
  dirPath: string[],
  options?: {
    includeHidden?: boolean
    fileFilter?: (name: string) => boolean
    maxDepth?: number
  }
): Promise<FileStats[]> {
  const { includeHidden = false, fileFilter, maxDepth = 10 } = options || {}

  if (maxDepth <= 0) return []

  const files: FileStats[] = []
  const entries = await listEntries(dirPath)

  for (const entry of entries) {
    // Skip hidden files/folders unless requested
    if (!includeHidden && entry.name.startsWith('.')) continue

    if (entry.kind === 'file') {
      // Apply file filter if provided
      if (fileFilter && !fileFilter(entry.name)) continue

      const stats = await getFileStats(dirPath, entry.name)
      if (stats) {
        files.push(stats)
      }
    } else if (entry.kind === 'directory') {
      // Recurse into subdirectory
      const subFiles = await scanDirectoryRecursive(
        [...dirPath, entry.name],
        { includeHidden, fileFilter, maxDepth: maxDepth - 1 }
      )
      files.push(...subFiles)
    }
  }

  return files
}

/**
 * Check if a file exists
 */
export async function fileExists(dirPath: string[], fileName: string): Promise<boolean> {
  const dir = await getDirectory(...dirPath)
  if (!dir) return false

  try {
    const safeFileName = sanitizeName(fileName)
    await dir.getFileHandle(safeFileName)
    return true
  } catch {
    return false
  }
}

/**
 * Check if a directory exists
 */
export async function directoryExists(dirPath: string[]): Promise<boolean> {
  if (dirPath.length === 0) return rootHandle !== null

  try {
    const dir = await getDirectory(...dirPath)
    return dir !== null
  } catch {
    return false
  }
}

/**
 * Rename a file
 */
export async function renameFile(
  dirPath: string[],
  oldName: string,
  newName: string
): Promise<boolean> {
  const dir = await getDirectory(...dirPath)
  if (!dir) return false

  try {
    const safeOldName = sanitizeName(oldName)
    const safeNewName = sanitizeName(newName)

    // Read old file
    const oldHandle = await dir.getFileHandle(safeOldName)
    const oldFile = await oldHandle.getFile()
    const content = await oldFile.arrayBuffer()

    // Write to new file
    const newHandle = await dir.getFileHandle(safeNewName, { create: true })
    const writable = await newHandle.createWritable()
    await writable.write(content)
    await writable.close()

    // Delete old file
    await dir.removeEntry(safeOldName)

    console.log('File renamed:', safeOldName, '->', safeNewName)
    return true
  } catch (err) {
    console.error('Failed to rename file:', err)
    return false
  }
}

/**
 * Copy a file to a new location
 */
export async function copyFile(
  srcDirPath: string[],
  srcFileName: string,
  destDirPath: string[],
  destFileName: string
): Promise<boolean> {
  const srcDir = await getDirectory(...srcDirPath)
  const destDir = await getDirectory(...destDirPath)

  if (!srcDir || !destDir) return false

  try {
    const safeSrcName = sanitizeName(srcFileName)
    const safeDestName = sanitizeName(destFileName)

    // Read source file
    const srcHandle = await srcDir.getFileHandle(safeSrcName)
    const srcFile = await srcHandle.getFile()
    const content = await srcFile.arrayBuffer()

    // Write to destination
    const destHandle = await destDir.getFileHandle(safeDestName, { create: true })
    const writable = await destHandle.createWritable()
    await writable.write(content)
    await writable.close()

    console.log('File copied:', [...srcDirPath, safeSrcName].join('/'), '->', [...destDirPath, safeDestName].join('/'))
    return true
  } catch (err) {
    console.error('Failed to copy file:', err)
    return false
  }
}

/**
 * Delete a directory and all its contents
 */
export async function deleteDirectory(dirPath: string[]): Promise<boolean> {
  if (dirPath.length === 0) return false  // Can't delete root

  const parentPath = dirPath.slice(0, -1)
  const dirName = dirPath[dirPath.length - 1]

  let parentDir: FileSystemDirectoryHandle | null
  if (parentPath.length === 0) {
    parentDir = rootHandle
  } else {
    parentDir = await getDirectory(...parentPath)
  }

  if (!parentDir) return false

  try {
    await parentDir.removeEntry(sanitizeName(dirName), { recursive: true })
    console.log('Directory deleted:', dirPath.join('/'))
    return true
  } catch (err) {
    console.error('Failed to delete directory:', err)
    return false
  }
}

/**
 * Read the database file from storage folder
 */
export async function readDatabaseFile(): Promise<Uint8Array | null> {
  if (!rootHandle) return null

  try {
    const fileHandle = await rootHandle.getFileHandle('index.db')
    const file = await fileHandle.getFile()
    const buffer = await file.arrayBuffer()
    return new Uint8Array(buffer)
  } catch (err) {
    if ((err as Error).name !== 'NotFoundError') {
      console.error('Failed to read database file:', err)
    }
    return null
  }
}

/**
 * Write the database file to storage folder
 */
export async function writeDatabaseFile(data: Uint8Array): Promise<boolean> {
  if (!rootHandle) return false

  try {
    const fileHandle = await rootHandle.getFileHandle('index.db', { create: true })
    const writable = await fileHandle.createWritable()
    // Create a clean ArrayBuffer to avoid TypeScript issues with ArrayBufferLike
    const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
    await writable.write(buffer)
    await writable.close()
    console.log('Database file written to storage folder')
    return true
  } catch (err) {
    console.error('Failed to write database file:', err)
    return false
  }
}

/**
 * Export sanitizeName for use in other modules
 */
export { sanitizeName }
