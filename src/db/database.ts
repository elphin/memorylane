import { Event, Item, CanvasItem, L1Memory, L1EventCluster, ItemType } from '../models/types'
import { v4 as uuidv4 } from 'uuid'

// sql.js types (loaded via script tag)
interface SqlJsDatabase {
  run(sql: string, params?: unknown[]): void
  exec(sql: string): { columns: string[]; values: unknown[][] }[]
  prepare(sql: string): SqlJsStatement
  export(): Uint8Array
}

interface SqlJsStatement {
  bind(params?: unknown[]): void
  step(): boolean
  get(): unknown[]
  free(): void
}

interface SqlJsStatic {
  Database: new (data?: Uint8Array) => SqlJsDatabase
}

declare global {
  interface Window {
    initSqlJs: (config?: { locateFile?: (file: string) => string }) => Promise<SqlJsStatic>
  }
}

let db: SqlJsDatabase | null = null

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK(type IN ('year', 'period', 'event', 'item')),
    title TEXT,
    description TEXT,
    featured_photo_id TEXT,
    featured_photo_slug TEXT,
    featured_photo_data TEXT,
    location_lat REAL,
    location_lng REAL,
    location_label TEXT,
    start_at TEXT NOT NULL,
    end_at TEXT,
    parent_id TEXT REFERENCES events(id),
    cover_media_id TEXT,
    tags TEXT,
    file_path TEXT,
    folder_path TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES events(id),
    item_type TEXT NOT NULL CHECK(item_type IN ('text', 'photo', 'video', 'link')),
    content TEXT NOT NULL,
    caption TEXT,
    happened_at TEXT,
    place_lat REAL,
    place_lng REAL,
    place_label TEXT,
    people TEXT,
    tags TEXT,
    url TEXT,
    body_text TEXT,
    slug TEXT,
    file_path TEXT,
    media_path TEXT
  );

  CREATE TABLE IF NOT EXISTS canvas_items (
    event_id TEXT NOT NULL REFERENCES events(id),
    item_id TEXT NOT NULL REFERENCES items(id),
    item_slug TEXT,
    x REAL NOT NULL DEFAULT 0,
    y REAL NOT NULL DEFAULT 0,
    scale REAL NOT NULL DEFAULT 1,
    rotation REAL NOT NULL DEFAULT 0,
    z_index INTEGER NOT NULL DEFAULT 0,
    text_scale REAL,
    PRIMARY KEY (event_id, item_id)
  );

  -- File tracking for change detection (file-based storage)
  CREATE TABLE IF NOT EXISTS file_index (
    path TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK(type IN ('event', 'item', 'canvas', 'year')),
    mtime_ms INTEGER NOT NULL,
    size INTEGER NOT NULL,
    hash TEXT,
    last_indexed_at TEXT NOT NULL
  );

  -- Metadata storage
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_events_parent ON events(parent_id);
  CREATE INDEX IF NOT EXISTS idx_events_start ON events(start_at);
  CREATE INDEX IF NOT EXISTS idx_events_folder ON events(folder_path);
  CREATE INDEX IF NOT EXISTS idx_items_event ON items(event_id);
  CREATE INDEX IF NOT EXISTS idx_items_slug ON items(slug);
  CREATE INDEX IF NOT EXISTS idx_canvas_event ON canvas_items(event_id);
`

const DB_STORAGE_KEY = 'memorylane_db'

// Convert Uint8Array to base64 in chunks (avoids stack overflow for large data)
function uint8ArrayToBase64(bytes: Uint8Array): string {
  const CHUNK_SIZE = 32768  // Process 32KB at a time
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const chunk = bytes.subarray(i, i + CHUNK_SIZE)
    binary += String.fromCharCode.apply(null, Array.from(chunk))
  }
  return btoa(binary)
}

// Save database to localStorage
function saveToStorage(): void {
  if (!db) return
  try {
    const data = db.export()
    const base64 = uint8ArrayToBase64(data)

    // Check if we might exceed quota (estimate)
    const sizeInMB = (base64.length * 2) / (1024 * 1024)  // UTF-16 encoding
    console.log(`Database size: ${sizeInMB.toFixed(2)}MB`)

    localStorage.setItem(DB_STORAGE_KEY, base64)

    // Verify save was successful
    const savedData = localStorage.getItem(DB_STORAGE_KEY)
    if (savedData === base64) {
      console.log('Database saved to localStorage successfully (verified)')
    } else if (savedData) {
      console.error('Database save verification FAILED - data mismatch!', {
        expectedLength: base64.length,
        actualLength: savedData.length
      })
    } else {
      console.error('Database save verification FAILED - data not found in localStorage!')
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'QuotaExceededError') {
      console.error('localStorage quota exceeded! Database not saved. Size may be too large for localStorage.')
      // Don't throw - let the app continue working with in-memory data
    } else {
      console.error('Failed to save database to localStorage:', err)
    }
  }
}

// Load database from localStorage
function loadFromStorage(SQL: SqlJsStatic): SqlJsDatabase | null {
  try {
    const base64 = localStorage.getItem(DB_STORAGE_KEY)
    if (!base64) return null

    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    return new SQL.Database(bytes)
  } catch (err) {
    console.warn('Failed to load database from localStorage:', err)
    return null
  }
}

// Migrate existing database to add new columns
function migrateDatabase(database: SqlJsDatabase): void {
  // Check if description column exists in events table
  const eventsInfo = database.exec("PRAGMA table_info(events)")
  const eventColumns = eventsInfo[0]?.values.map(row => row[1] as string) || []

  // Add new event columns if they don't exist
  if (!eventColumns.includes('description')) {
    console.log('Migrating: adding description column')
    database.run('ALTER TABLE events ADD COLUMN description TEXT')
  }
  if (!eventColumns.includes('featured_photo_id')) {
    console.log('Migrating: adding featured_photo_id column')
    database.run('ALTER TABLE events ADD COLUMN featured_photo_id TEXT')
  }
  if (!eventColumns.includes('featured_photo_data')) {
    console.log('Migrating: adding featured_photo_data column')
    database.run('ALTER TABLE events ADD COLUMN featured_photo_data TEXT')
  }
  if (!eventColumns.includes('location_lat')) {
    console.log('Migrating: adding location columns')
    database.run('ALTER TABLE events ADD COLUMN location_lat REAL')
    database.run('ALTER TABLE events ADD COLUMN location_lng REAL')
    database.run('ALTER TABLE events ADD COLUMN location_label TEXT')
  }
  // New file-based storage columns
  if (!eventColumns.includes('featured_photo_slug')) {
    console.log('Migrating: adding featured_photo_slug column')
    database.run('ALTER TABLE events ADD COLUMN featured_photo_slug TEXT')
  }
  if (!eventColumns.includes('tags')) {
    console.log('Migrating: adding tags column to events')
    database.run('ALTER TABLE events ADD COLUMN tags TEXT')
  }
  if (!eventColumns.includes('file_path')) {
    console.log('Migrating: adding file_path column to events')
    database.run('ALTER TABLE events ADD COLUMN file_path TEXT')
  }
  if (!eventColumns.includes('folder_path')) {
    console.log('Migrating: adding folder_path column to events')
    database.run('ALTER TABLE events ADD COLUMN folder_path TEXT')
  }

  // Check items table for people column
  const itemsInfo = database.exec("PRAGMA table_info(items)")
  const itemColumns = itemsInfo[0]?.values.map(row => row[1] as string) || []

  if (!itemColumns.includes('people')) {
    console.log('Migrating: adding people column to items')
    database.run('ALTER TABLE items ADD COLUMN people TEXT')
  }
  // New file-based storage columns for items
  if (!itemColumns.includes('tags')) {
    console.log('Migrating: adding tags column to items')
    database.run('ALTER TABLE items ADD COLUMN tags TEXT')
  }
  if (!itemColumns.includes('url')) {
    console.log('Migrating: adding url column to items')
    database.run('ALTER TABLE items ADD COLUMN url TEXT')
  }
  if (!itemColumns.includes('body_text')) {
    console.log('Migrating: adding body_text column to items')
    database.run('ALTER TABLE items ADD COLUMN body_text TEXT')
  }
  if (!itemColumns.includes('slug')) {
    console.log('Migrating: adding slug column to items')
    database.run('ALTER TABLE items ADD COLUMN slug TEXT')
  }
  if (!itemColumns.includes('file_path')) {
    console.log('Migrating: adding file_path column to items')
    database.run('ALTER TABLE items ADD COLUMN file_path TEXT')
  }
  if (!itemColumns.includes('media_path')) {
    console.log('Migrating: adding media_path column to items')
    database.run('ALTER TABLE items ADD COLUMN media_path TEXT')
  }

  // Check canvas_items table for text_scale column
  const canvasInfo = database.exec("PRAGMA table_info(canvas_items)")
  const canvasColumns = canvasInfo[0]?.values.map(row => row[1] as string) || []

  if (!canvasColumns.includes('text_scale')) {
    console.log('Migrating: adding text_scale column to canvas_items')
    database.run('ALTER TABLE canvas_items ADD COLUMN text_scale REAL')
  }
  if (!canvasColumns.includes('item_slug')) {
    console.log('Migrating: adding item_slug column to canvas_items')
    database.run('ALTER TABLE canvas_items ADD COLUMN item_slug TEXT')
  }

  // Create new tables if they don't exist
  try {
    database.run(`
      CREATE TABLE IF NOT EXISTS file_index (
        path TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN ('event', 'item', 'canvas', 'year')),
        mtime_ms INTEGER NOT NULL,
        size INTEGER NOT NULL,
        hash TEXT,
        last_indexed_at TEXT NOT NULL
      )
    `)
    database.run(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `)
    // Create indexes if not exist
    database.run('CREATE INDEX IF NOT EXISTS idx_events_folder ON events(folder_path)')
    database.run('CREATE INDEX IF NOT EXISTS idx_items_slug ON items(slug)')
    database.run('CREATE INDEX IF NOT EXISTS idx_canvas_event ON canvas_items(event_id)')
  } catch (err) {
    // Tables might already exist
    console.log('Tables/indexes already exist or migration skipped')
  }
}

export async function initDatabase(): Promise<SqlJsDatabase> {
  if (db) return db

  // Wait for sql.js to be available (loaded via script tag)
  if (typeof window.initSqlJs !== 'function') {
    throw new Error('sql.js not loaded. Make sure the script is included in index.html')
  }

  const SQL = await window.initSqlJs({
    locateFile: (file: string) => `https://sql.js.org/dist/${file}`,
  })

  // Try to load existing database from localStorage
  const loadedDb = loadFromStorage(SQL)
  if (loadedDb) {
    db = loadedDb
    console.log('Loaded database from localStorage')
    // Run migrations on existing database
    migrateDatabase(db)
    saveToStorage()
    return db
  }

  // Create new database
  db = new SQL.Database()
  db.run(SCHEMA)

  // Generate year events if none exist
  const result = db.exec("SELECT COUNT(*) FROM events WHERE type = 'year'")
  if (result[0]?.values[0]?.[0] === 0) {
    generateYearEvents(db)
    generateTestEvents(db)
  }

  saveToStorage()
  return db
}

function generateYearEvents(database: SqlJsDatabase): void {
  const currentYear = new Date().getFullYear()
  const startYear = currentYear - 10

  for (let year = startYear; year <= currentYear; year++) {
    const now = new Date().toISOString()
    database.run(
      `INSERT INTO events (id, type, title, start_at, end_at, created_at, updated_at)
       VALUES (?, 'year', ?, ?, ?, ?, ?)`,
      [uuidv4(), String(year), `${year}-01-01`, `${year}-12-31`, now, now]
    )
  }
}

function generateTestEvents(database: SqlJsDatabase): void {
  const now = new Date().toISOString()
  const currentYear = new Date().getFullYear()

  // Get year IDs
  const yearsResult = database.exec("SELECT id, title FROM events WHERE type = 'year'")
  if (!yearsResult[0]) return

  const yearMap = new Map<string, string>()
  yearsResult[0].values.forEach(row => {
    yearMap.set(row[1] as string, row[0] as string)
  })

  // Test events for current year
  const thisYearId = yearMap.get(String(currentYear))
  if (thisYearId) {
    const testEvents = [
      { title: 'New Year Celebration', date: `${currentYear}-01-01` },
      { title: 'Weekend Trip to Amsterdam', date: `${currentYear}-03-16` },
      { title: 'Birthday Party', date: `${currentYear}-04-22` },
      { title: 'Summer Vacation', date: `${currentYear}-07-15` },
      { title: 'Concert Night', date: `${currentYear}-09-08` },
      { title: 'Family Dinner', date: `${currentYear}-11-24` },
    ]

    testEvents.forEach(event => {
      const eventId = uuidv4()
      database.run(
        `INSERT INTO events (id, type, title, start_at, parent_id, created_at, updated_at)
         VALUES (?, 'event', ?, ?, ?, ?, ?)`,
        [eventId, event.title, event.date, thisYearId, now, now]
      )

      // Add test items to some events
      if (event.title === 'Weekend Trip to Amsterdam') {
        const items = [
          { type: 'photo', content: '/photos/amsterdam-canal.jpg', caption: 'Beautiful canal view' },
          { type: 'photo', content: '/photos/amsterdam-museum.jpg', caption: 'Visiting the Rijksmuseum' },
          { type: 'text', content: 'Had an amazing weekend exploring the city. The weather was perfect and the food was delicious!', caption: null },
          { type: 'link', content: 'https://maps.google.com/amsterdam', caption: 'Our walking route' },
        ]
        items.forEach(item => {
          database.run(
            `INSERT INTO items (id, event_id, item_type, content, caption)
             VALUES (?, ?, ?, ?, ?)`,
            [uuidv4(), eventId, item.type, item.content, item.caption]
          )
        })
      } else if (event.title === 'Birthday Party') {
        const items = [
          { type: 'photo', content: '/photos/birthday-cake.jpg', caption: 'The amazing cake!' },
          { type: 'video', content: '/videos/birthday-song.mp4', caption: 'Singing happy birthday' },
          { type: 'text', content: 'Turned 30 today! Best party ever with all my friends and family.', caption: null },
        ]
        items.forEach(item => {
          database.run(
            `INSERT INTO items (id, event_id, item_type, content, caption)
             VALUES (?, ?, ?, ?, ?)`,
            [uuidv4(), eventId, item.type, item.content, item.caption]
          )
        })
      } else if (event.title === 'Summer Vacation') {
        const items = [
          { type: 'photo', content: '/photos/beach-sunset.jpg', caption: 'Sunset at the beach' },
          { type: 'photo', content: '/photos/hotel-view.jpg', caption: 'View from our room' },
          { type: 'photo', content: '/photos/local-food.jpg', caption: 'Trying local cuisine' },
          { type: 'video', content: '/videos/swimming.mp4', caption: 'First swim of the trip' },
          { type: 'text', content: 'Two weeks of pure relaxation. Finally got some rest!', caption: null },
          { type: 'link', content: 'https://booking.com/myhotel', caption: 'The hotel we stayed at' },
        ]
        items.forEach(item => {
          database.run(
            `INSERT INTO items (id, event_id, item_type, content, caption)
             VALUES (?, ?, ?, ?, ?)`,
            [uuidv4(), eventId, item.type, item.content, item.caption]
          )
        })
      }
    })
  }

  // Test events for last year
  const lastYearId = yearMap.get(String(currentYear - 1))
  if (lastYearId) {
    const testEvents = [
      { title: 'Christmas Eve', date: `${currentYear - 1}-12-24` },
      { title: 'Graduation Day', date: `${currentYear - 1}-06-15` },
      { title: 'Road Trip', date: `${currentYear - 1}-08-20` },
    ]

    testEvents.forEach(event => {
      database.run(
        `INSERT INTO events (id, type, title, start_at, parent_id, created_at, updated_at)
         VALUES (?, 'event', ?, ?, ?, ?, ?)`,
        [uuidv4(), event.title, event.date, lastYearId, now, now]
      )
    })
  }

  // Test events for 2 years ago
  const twoYearsAgoId = yearMap.get(String(currentYear - 2))
  if (twoYearsAgoId) {
    const testEvents = [
      { title: 'Wedding', date: `${currentYear - 2}-05-10` },
      { title: 'House Warming', date: `${currentYear - 2}-09-01` },
    ]

    testEvents.forEach(event => {
      database.run(
        `INSERT INTO events (id, type, title, start_at, parent_id, created_at, updated_at)
         VALUES (?, 'event', ?, ?, ?, ?, ?)`,
        [uuidv4(), event.title, event.date, twoYearsAgoId, now, now]
      )
    })
  }
}

export function getDatabase(): SqlJsDatabase {
  if (!db) throw new Error('Database not initialized')
  return db
}

// Event operations
export function getAllEvents(): Event[] {
  if (!db) {
    console.warn('Database not initialized, returning empty events')
    return []
  }
  const result = db.exec(`
    SELECT id, type, title, description, featured_photo_id, featured_photo_data,
           location_lat, location_lng, location_label,
           start_at, end_at, parent_id, cover_media_id, created_at, updated_at
    FROM events ORDER BY start_at
  `)
  if (!result[0]) return []

  return result[0].values.map((row) => ({
    id: row[0] as string,
    type: row[1] as Event['type'],
    title: row[2] as string | undefined,
    description: row[3] as string | undefined,
    featuredPhotoId: row[4] as string | undefined,
    featuredPhotoData: row[5] as string | undefined,
    location: row[6] != null ? {
      lat: row[6] as number,
      lng: row[7] as number,
      label: row[8] as string | undefined,
    } : undefined,
    startAt: row[9] as string,
    endAt: row[10] as string | undefined,
    parentId: row[11] as string | undefined,
    coverMediaId: row[12] as string | undefined,
    createdAt: row[13] as string,
    updatedAt: row[14] as string,
  }))
}

export function getYearForDate(dateStr: string): Event | null {
  if (!db) return null

  // Extract year from date string (handles both "2024-08-02" and "2024-08-02T12:00:00.000Z")
  const year = dateStr.split('-')[0]

  const stmt = db.prepare(`
    SELECT id, type, title, description, featured_photo_id, featured_photo_data,
           location_lat, location_lng, location_label,
           start_at, end_at, parent_id, cover_media_id, created_at, updated_at
    FROM events WHERE type = 'year' AND title = ?
  `)
  stmt.bind([year])

  if (stmt.step()) {
    const row = stmt.get()
    stmt.free()
    return {
      id: row[0] as string,
      type: row[1] as Event['type'],
      title: row[2] as string | undefined,
      description: row[3] as string | undefined,
      featuredPhotoId: row[4] as string | undefined,
      featuredPhotoData: row[5] as string | undefined,
      location: row[6] != null ? {
        lat: row[6] as number,
        lng: row[7] as number,
        label: row[8] as string | undefined,
      } : undefined,
      startAt: row[9] as string,
      endAt: row[10] as string | undefined,
      parentId: row[11] as string | undefined,
      coverMediaId: row[12] as string | undefined,
      createdAt: row[13] as string,
      updatedAt: row[14] as string,
    }
  }

  stmt.free()
  return null
}

/**
 * Get or create a year event for a given date
 * If the year doesn't exist, creates it automatically
 */
export function getOrCreateYear(dateStr: string): Event {
  // First try to find existing year
  const existingYear = getYearForDate(dateStr)
  if (existingYear) {
    return existingYear
  }

  // Extract year from date string
  const year = dateStr.split('-')[0]
  const now = new Date().toISOString()
  const id = uuidv4()

  // Create new year event
  db!.run(
    `INSERT INTO events (id, type, title, description, featured_photo_id, featured_photo_data,
                         location_lat, location_lng, location_label,
                         start_at, end_at, parent_id, cover_media_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      'year',
      year,  // Title is just the year number
      null,
      null,
      null,
      null,
      null,
      null,
      `${year}-01-01`,  // startAt
      `${year}-12-31`,  // endAt
      null,  // No parent for year
      null,
      now,
      now,
    ]
  )

  console.log(`Created new year: ${year}`)

  return {
    id,
    type: 'year',
    title: year,
    startAt: `${year}-01-01`,
    endAt: `${year}-12-31`,
    createdAt: now,
    updatedAt: now,
  }
}

export function getEventsByType(type: Event['type']): Event[] {
  if (!db) {
    console.warn('Database not initialized, returning empty events')
    return []
  }
  const stmt = db.prepare(`
    SELECT id, type, title, description, featured_photo_id, featured_photo_data,
           location_lat, location_lng, location_label,
           start_at, end_at, parent_id, cover_media_id, created_at, updated_at
    FROM events WHERE type = ? ORDER BY start_at
  `)
  stmt.bind([type])

  const events: Event[] = []
  while (stmt.step()) {
    const row = stmt.get()
    events.push({
      id: row[0] as string,
      type: row[1] as Event['type'],
      title: row[2] as string | undefined,
      description: row[3] as string | undefined,
      featuredPhotoId: row[4] as string | undefined,
      featuredPhotoData: row[5] as string | undefined,
      location: row[6] != null ? {
        lat: row[6] as number,
        lng: row[7] as number,
        label: row[8] as string | undefined,
      } : undefined,
      startAt: row[9] as string,
      endAt: row[10] as string | undefined,
      parentId: row[11] as string | undefined,
      coverMediaId: row[12] as string | undefined,
      createdAt: row[13] as string,
      updatedAt: row[14] as string,
    })
  }
  stmt.free()
  return events
}

export function createEvent(event: Omit<Event, 'id' | 'createdAt' | 'updatedAt'>): Event {
  const id = uuidv4()
  const now = new Date().toISOString()

  db!.run(
    `INSERT INTO events (id, type, title, description, featured_photo_id, featured_photo_data,
                         location_lat, location_lng, location_label,
                         start_at, end_at, parent_id, cover_media_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      event.type,
      event.title ?? null,
      event.description ?? null,
      event.featuredPhotoId ?? null,
      event.featuredPhotoData ?? null,
      event.location?.lat ?? null,
      event.location?.lng ?? null,
      event.location?.label ?? null,
      event.startAt,
      event.endAt ?? null,
      event.parentId ?? null,
      event.coverMediaId ?? null,
      now,
      now
    ]
  )

  saveToStorage()
  return { ...event, id, createdAt: now, updatedAt: now }
}

// Item operations
export function getAllItems(): Item[] {
  if (!db) return []

  const stmt = db.prepare(`
    SELECT id, event_id, item_type, content, caption, happened_at, place_lat, place_lng, place_label, people
    FROM items
  `)

  const items: Item[] = []
  while (stmt.step()) {
    const row = stmt.get()
    const peopleJson = row[9] as string | null
    items.push({
      id: row[0] as string,
      eventId: row[1] as string,
      itemType: row[2] as Item['itemType'],
      content: row[3] as string,
      caption: row[4] as string | undefined,
      happenedAt: row[5] as string | undefined,
      place: row[6] != null ? {
        lat: row[6] as number,
        lng: row[7] as number,
        label: row[8] as string | undefined,
      } : undefined,
      people: peopleJson ? JSON.parse(peopleJson) : undefined,
    })
  }
  stmt.free()
  return items
}

export function updateItemContent(itemId: string, content: string): void {
  if (!db) throw new Error('Database not initialized')

  db.run('UPDATE items SET content = ? WHERE id = ?', [content, itemId])
  saveToStorage()
  console.log('Item content updated:', itemId, 'new content type:', content.startsWith('file:') ? 'file reference' : 'base64')
}

export function getItemsByEvent(eventId: string): Item[] {
  const stmt = db!.prepare(`
    SELECT id, event_id, item_type, content, caption, happened_at, place_lat, place_lng, place_label, people
    FROM items WHERE event_id = ?
  `)
  stmt.bind([eventId])

  const items: Item[] = []
  while (stmt.step()) {
    const row = stmt.get()
    const peopleJson = row[9] as string | null
    items.push({
      id: row[0] as string,
      eventId: row[1] as string,
      itemType: row[2] as Item['itemType'],
      content: row[3] as string,
      caption: row[4] as string | undefined,
      happenedAt: row[5] as string | undefined,
      place: row[6] != null ? {
        lat: row[6] as number,
        lng: row[7] as number,
        label: row[8] as string | undefined,
      } : undefined,
      people: peopleJson ? JSON.parse(peopleJson) : undefined,
    })
  }
  stmt.free()
  return items
}

export function createItem(item: Omit<Item, 'id'>): Item {
  const id = uuidv4()

  console.log('createItem called:', {
    id,
    eventId: item.eventId,
    itemType: item.itemType,
    contentLength: item.content?.length || 0
  })

  try {
    db!.run(
      `INSERT INTO items (id, event_id, item_type, content, caption, happened_at, place_lat, place_lng, place_label, people)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        item.eventId,
        item.itemType,
        item.content,
        item.caption ?? null,
        item.happenedAt ?? null,
        item.place?.lat ?? null,
        item.place?.lng ?? null,
        item.place?.label ?? null,
        item.people ? JSON.stringify(item.people) : null,
      ]
    )
    console.log('Item inserted successfully:', id)
  } catch (err) {
    console.error('Failed to insert item:', err)
    throw err
  }

  saveToStorage()
  return { ...item, id }
}

export function getEventById(eventId: string): Event | null {
  if (!db) return null

  const stmt = db.prepare(`
    SELECT id, type, title, description, featured_photo_id, featured_photo_data,
           location_lat, location_lng, location_label,
           start_at, end_at, parent_id, cover_media_id, created_at, updated_at,
           file_path, folder_path
    FROM events WHERE id = ?
  `)
  stmt.bind([eventId])

  if (stmt.step()) {
    const row = stmt.get()
    stmt.free()
    return {
      id: row[0] as string,
      type: row[1] as Event['type'],
      title: row[2] as string | undefined,
      description: row[3] as string | undefined,
      featuredPhotoId: row[4] as string | undefined,
      featuredPhotoData: row[5] as string | undefined,
      location: row[6] != null ? {
        lat: row[6] as number,
        lng: row[7] as number,
        label: row[8] as string | undefined,
      } : undefined,
      startAt: row[9] as string,
      endAt: row[10] as string | undefined,
      parentId: row[11] as string | undefined,
      coverMediaId: row[12] as string | undefined,
      createdAt: row[13] as string,
      updatedAt: row[14] as string,
      filePath: row[15] as string | undefined,
      folderPath: row[16] as string | undefined,
    }
  }

  stmt.free()
  return null
}

export function updateEvent(eventId: string, updates: {
  title?: string
  description?: string | null
  featuredPhotoId?: string | null
  featuredPhotoData?: string | null
  location?: { lat: number; lng: number; label?: string } | null
  startAt?: string
  endAt?: string | null
}): void {
  if (!db) throw new Error('Database not initialized')

  const setClauses: string[] = []
  const values: unknown[] = []

  if (updates.title !== undefined) {
    setClauses.push('title = ?')
    values.push(updates.title || null)
  }
  if (updates.description !== undefined) {
    setClauses.push('description = ?')
    values.push(updates.description || null)
  }
  if (updates.featuredPhotoId !== undefined) {
    setClauses.push('featured_photo_id = ?')
    values.push(updates.featuredPhotoId || null)
  }
  if (updates.featuredPhotoData !== undefined) {
    setClauses.push('featured_photo_data = ?')
    values.push(updates.featuredPhotoData || null)
  }
  if (updates.location !== undefined) {
    if (updates.location === null) {
      setClauses.push('location_lat = ?', 'location_lng = ?', 'location_label = ?')
      values.push(null, null, null)
    } else {
      setClauses.push('location_lat = ?', 'location_lng = ?', 'location_label = ?')
      values.push(updates.location.lat, updates.location.lng, updates.location.label ?? null)
    }
  }
  if (updates.startAt !== undefined) {
    setClauses.push('start_at = ?')
    values.push(updates.startAt)
  }
  if (updates.endAt !== undefined) {
    setClauses.push('end_at = ?')
    values.push(updates.endAt || null)
  }

  if (setClauses.length === 0) return

  setClauses.push('updated_at = ?')
  values.push(new Date().toISOString())

  values.push(eventId)
  db.run(`UPDATE events SET ${setClauses.join(', ')} WHERE id = ?`, values)

  saveToStorage()
  console.log('Event updated:', eventId)
}

// Get photo/video items for an event (for featured photo selection)
export function getPhotoItemsForEvent(eventId: string): Item[] {
  if (!db) return []

  const stmt = db.prepare(`
    SELECT id, event_id, item_type, content, caption, happened_at, place_lat, place_lng, place_label, people
    FROM items WHERE event_id = ? AND item_type IN ('photo', 'video')
  `)
  stmt.bind([eventId])

  const items: Item[] = []
  while (stmt.step()) {
    const row = stmt.get()
    const peopleJson = row[9] as string | null
    items.push({
      id: row[0] as string,
      eventId: row[1] as string,
      itemType: row[2] as Item['itemType'],
      content: row[3] as string,
      caption: row[4] as string | undefined,
      happenedAt: row[5] as string | undefined,
      place: row[6] != null ? {
        lat: row[6] as number,
        lng: row[7] as number,
        label: row[8] as string | undefined,
      } : undefined,
      people: peopleJson ? JSON.parse(peopleJson) : undefined,
    })
  }
  stmt.free()
  return items
}

export function getItemById(itemId: string): Item | null {
  if (!db) return null

  const stmt = db.prepare(`
    SELECT id, event_id, item_type, content, caption, happened_at, place_lat, place_lng, place_label, people
    FROM items WHERE id = ?
  `)
  stmt.bind([itemId])

  if (!stmt.step()) {
    stmt.free()
    return null
  }

  const row = stmt.get()
  const peopleJson = row[9] as string | null
  const item: Item = {
    id: row[0] as string,
    eventId: row[1] as string,
    itemType: row[2] as Item['itemType'],
    content: row[3] as string,
    caption: row[4] as string | undefined,
    happenedAt: row[5] as string | undefined,
    place: row[6] != null ? {
      lat: row[6] as number,
      lng: row[7] as number,
      label: row[8] as string | undefined,
    } : undefined,
    people: peopleJson ? JSON.parse(peopleJson) : undefined,
  }
  stmt.free()
  return item
}

export function updateItem(itemId: string, updates: {
  content?: string
  caption?: string | null
  happenedAt?: string | null
  place?: { lat: number; lng: number; label?: string } | null
  people?: string[] | null
}): void {
  if (!db) return

  const setClauses: string[] = []
  const values: unknown[] = []

  if ('content' in updates && updates.content !== undefined) {
    setClauses.push('content = ?')
    values.push(updates.content)
  }
  if ('caption' in updates) {
    setClauses.push('caption = ?')
    values.push(updates.caption ?? null)
  }
  if ('happenedAt' in updates) {
    setClauses.push('happened_at = ?')
    values.push(updates.happenedAt ?? null)
  }
  if ('place' in updates) {
    setClauses.push('place_lat = ?', 'place_lng = ?', 'place_label = ?')
    if (updates.place) {
      values.push(updates.place.lat, updates.place.lng, updates.place.label ?? null)
    } else {
      values.push(null, null, null)
    }
  }
  if ('people' in updates) {
    setClauses.push('people = ?')
    values.push(updates.people ? JSON.stringify(updates.people) : null)
  }

  if (setClauses.length === 0) return

  values.push(itemId)
  db.run(
    `UPDATE items SET ${setClauses.join(', ')} WHERE id = ?`,
    values
  )
  saveToStorage()
}

export function deleteItem(itemId: string): void {
  if (!db) throw new Error('Database not initialized')

  // Delete canvas position first (foreign key constraint)
  db.run('DELETE FROM canvas_items WHERE item_id = ?', [itemId])

  // Delete the item
  db.run('DELETE FROM items WHERE id = ?', [itemId])

  saveToStorage()
  console.log('Item deleted:', itemId)
}

export function deleteEvent(eventId: string): void {
  if (!db) throw new Error('Database not initialized')

  // Delete all canvas items for items in this event
  db.run(`
    DELETE FROM canvas_items
    WHERE item_id IN (SELECT id FROM items WHERE event_id = ?)
  `, [eventId])

  // Delete all items in this event
  db.run('DELETE FROM items WHERE event_id = ?', [eventId])

  // Delete the event itself
  db.run('DELETE FROM events WHERE id = ?', [eventId])

  saveToStorage()
  console.log('Event deleted:', eventId)
}

// Canvas operations
export function getCanvasItems(eventId: string): CanvasItem[] {
  const stmt = db!.prepare(`
    SELECT event_id, item_id, x, y, scale, rotation, z_index, text_scale
    FROM canvas_items WHERE event_id = ? ORDER BY z_index
  `)
  stmt.bind([eventId])

  const items: CanvasItem[] = []
  while (stmt.step()) {
    const row = stmt.get()
    items.push({
      eventId: row[0] as string,
      itemId: row[1] as string,
      x: row[2] as number,
      y: row[3] as number,
      scale: row[4] as number,
      rotation: row[5] as number,
      zIndex: row[6] as number,
      textScale: row[7] as number | undefined,
    })
  }
  stmt.free()
  return items
}

export function upsertCanvasItem(canvasItem: CanvasItem): void {
  db!.run(
    `INSERT OR REPLACE INTO canvas_items (event_id, item_id, x, y, scale, rotation, z_index, text_scale)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      canvasItem.eventId,
      canvasItem.itemId,
      canvasItem.x,
      canvasItem.y,
      canvasItem.scale,
      canvasItem.rotation,
      canvasItem.zIndex,
      canvasItem.textScale ?? null,
    ]
  )
  saveToStorage()
}

// L1 Density View operations

/**
 * Get all items/memories for a year with resolved timestamps.
 * Items are positioned based on happened_at or their parent event's start_at.
 */
export function getMemoriesForYear(yearId: string): L1Memory[] {
  if (!db) {
    console.warn('Database not initialized, returning empty memories')
    return []
  }

  const stmt = db.prepare(`
    SELECT
      i.id as item_id,
      i.event_id,
      i.item_type,
      i.content,
      i.caption,
      COALESCE(i.happened_at, e.start_at) as resolved_timestamp,
      e.title as event_title,
      e.end_at as event_end_at,
      e.description as event_description,
      e.location_label as event_location,
      COALESCE(e.featured_photo_data, fp.content) as featured_photo
    FROM items i
    INNER JOIN events e ON i.event_id = e.id
    LEFT JOIN items fp ON e.featured_photo_id = fp.id
    WHERE e.parent_id = ?
    ORDER BY resolved_timestamp
  `)
  stmt.bind([yearId])

  const memories: L1Memory[] = []
  while (stmt.step()) {
    const row = stmt.get()
    const timestampStr = row[5] as string
    // Note: Items are moments, not periods. They don't have endTimestamp.
    // The event's endAt is only used for empty event containers in L1 view.
    memories.push({
      id: `memory-${row[0]}`,
      itemId: row[0] as string,
      eventId: row[1] as string,
      itemType: row[2] as ItemType,
      content: row[3] as string,
      caption: row[4] as string | undefined,
      timestamp: new Date(timestampStr).getTime(),
      // Items are individual moments, not date ranges
      endTimestamp: undefined,
      eventTitle: row[6] as string | undefined,
      eventDescription: row[8] as string | undefined,
      eventLocation: row[9] as string | undefined,
      eventFeaturedPhoto: row[10] as string | undefined,
    })
  }
  stmt.free()
  return memories
}

/**
 * Get event clusters for a year, each containing their memories.
 * Used to show grouped events above the density bar.
 */
export function getEventClustersForYear(yearId: string): L1EventCluster[] {
  if (!db) {
    console.warn('Database not initialized, returning empty clusters')
    return []
  }

  // Get all events for this year
  const events = getAllEvents().filter(e => e.parentId === yearId && e.type === 'event')

  // Build clusters with their memories
  const clusters: L1EventCluster[] = events.map(event => {
    const items = getItemsByEvent(event.id)

    // Get featured photo content if needed
    let featuredPhotoContent: string | undefined
    if (event.featuredPhotoData) {
      featuredPhotoContent = event.featuredPhotoData
    } else if (event.featuredPhotoId) {
      const featuredItem = items.find(i => i.id === event.featuredPhotoId)
      featuredPhotoContent = featuredItem?.content
    }

    const memories: L1Memory[] = items.map(item => ({
      id: `memory-${item.id}`,
      itemId: item.id,
      eventId: event.id,
      itemType: item.itemType,
      content: item.content,
      caption: item.caption,
      timestamp: new Date(item.happenedAt || event.startAt).getTime(),
      // Items are individual moments, not date ranges
      endTimestamp: undefined,
      eventTitle: event.title,
      eventDescription: event.description,
      eventLocation: event.location?.label,
      eventFeaturedPhoto: featuredPhotoContent,
    }))

    // Calculate time range
    const timestamps = memories.length > 0
      ? memories.map(m => m.timestamp)
      : [new Date(event.startAt).getTime()]

    return {
      event,
      memories,
      startTimestamp: Math.min(...timestamps),
      endTimestamp: Math.max(...timestamps),
    }
  })

  // Sort by start time
  return clusters.sort((a, b) => a.startTimestamp - b.startTimestamp)
}

// ============================================================================
// File-based storage operations
// ============================================================================

/**
 * Export database as Uint8Array (for saving to file)
 */
export function exportDatabase(): Uint8Array | null {
  if (!db) return null
  return db.export()
}

/**
 * Import database from Uint8Array (for loading from file)
 */
export async function importDatabase(data: Uint8Array): Promise<void> {
  if (typeof window.initSqlJs !== 'function') {
    throw new Error('sql.js not loaded')
  }

  const SQL = await window.initSqlJs({
    locateFile: (file: string) => `https://sql.js.org/dist/${file}`,
  })

  db = new SQL.Database(data)
  migrateDatabase(db)
  console.log('Database imported from file')
}

/**
 * Create a fresh database (for rebuilding from files)
 */
export async function createFreshDatabase(): Promise<void> {
  if (typeof window.initSqlJs !== 'function') {
    throw new Error('sql.js not loaded')
  }

  const SQL = await window.initSqlJs({
    locateFile: (file: string) => `https://sql.js.org/dist/${file}`,
  })

  db = new SQL.Database()
  db.run(SCHEMA)
  console.log('Fresh database created')
}

/**
 * Clear all data from the index (for rebuilding)
 */
export function clearIndex(): void {
  if (!db) return

  db.run('DELETE FROM canvas_items')
  db.run('DELETE FROM items')
  db.run('DELETE FROM events')
  db.run('DELETE FROM file_index')
  console.log('Index cleared')
}

// ============================================================================
// Meta table operations
// ============================================================================

export function getMeta(key: string): string | null {
  if (!db) return null

  const stmt = db.prepare('SELECT value FROM meta WHERE key = ?')
  stmt.bind([key])

  if (stmt.step()) {
    const value = stmt.get()[0] as string
    stmt.free()
    return value
  }

  stmt.free()
  return null
}

export function setMeta(key: string, value: string): void {
  if (!db) return

  db.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [key, value])
  saveToStorage()
}

// ============================================================================
// File index operations
// ============================================================================

export interface FileIndexEntry {
  path: string
  type: 'event' | 'item' | 'canvas' | 'year'
  mtimeMs: number
  size: number
  hash?: string
  lastIndexedAt: string
}

export function getFileIndexEntry(path: string): FileIndexEntry | null {
  if (!db) return null

  const stmt = db.prepare('SELECT path, type, mtime_ms, size, hash, last_indexed_at FROM file_index WHERE path = ?')
  stmt.bind([path])

  if (stmt.step()) {
    const row = stmt.get()
    stmt.free()
    return {
      path: row[0] as string,
      type: row[1] as FileIndexEntry['type'],
      mtimeMs: row[2] as number,
      size: row[3] as number,
      hash: row[4] as string | undefined,
      lastIndexedAt: row[5] as string,
    }
  }

  stmt.free()
  return null
}

export function upsertFileIndexEntry(entry: FileIndexEntry): void {
  if (!db) return

  db.run(
    `INSERT OR REPLACE INTO file_index (path, type, mtime_ms, size, hash, last_indexed_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [entry.path, entry.type, entry.mtimeMs, entry.size, entry.hash ?? null, entry.lastIndexedAt]
  )
}

export function deleteFileIndexEntry(path: string): void {
  if (!db) return
  db.run('DELETE FROM file_index WHERE path = ?', [path])
}

export function getAllFileIndexEntries(): FileIndexEntry[] {
  if (!db) return []

  const result = db.exec('SELECT path, type, mtime_ms, size, hash, last_indexed_at FROM file_index')
  if (!result[0]) return []

  return result[0].values.map(row => ({
    path: row[0] as string,
    type: row[1] as FileIndexEntry['type'],
    mtimeMs: row[2] as number,
    size: row[3] as number,
    hash: row[4] as string | undefined,
    lastIndexedAt: row[5] as string,
  }))
}

// ============================================================================
// Extended insert operations for file-based storage
// ============================================================================

export function insertEventFromFile(event: Event): void {
  if (!db) throw new Error('Database not initialized')

  db.run(
    `INSERT OR REPLACE INTO events (
      id, type, title, description,
      featured_photo_id, featured_photo_slug, featured_photo_data,
      location_lat, location_lng, location_label,
      start_at, end_at, parent_id, cover_media_id,
      tags, file_path, folder_path,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      event.id,
      event.type,
      event.title ?? null,
      event.description ?? null,
      event.featuredPhotoId ?? null,
      event.featuredPhotoSlug ?? null,
      event.featuredPhotoData ?? null,
      event.location?.lat ?? null,
      event.location?.lng ?? null,
      event.location?.label ?? null,
      event.startAt,
      event.endAt ?? null,
      event.parentId ?? null,
      event.coverMediaId ?? null,
      event.tags ? JSON.stringify(event.tags) : null,
      event.filePath ?? null,
      event.folderPath ?? null,
      event.createdAt,
      event.updatedAt,
    ]
  )
}

export function insertItemFromFile(item: Item): void {
  if (!db) throw new Error('Database not initialized')

  db.run(
    `INSERT OR REPLACE INTO items (
      id, event_id, item_type, content, caption, happened_at,
      place_lat, place_lng, place_label,
      people, tags, url, body_text, slug, file_path, media_path
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      item.id,
      item.eventId,
      item.itemType,
      item.content,
      item.caption ?? null,
      item.happenedAt ?? null,
      item.place?.lat ?? null,
      item.place?.lng ?? null,
      item.place?.label ?? null,
      item.people ? JSON.stringify(item.people) : null,
      item.tags ? JSON.stringify(item.tags) : null,
      item.url ?? null,
      item.bodyText ?? null,
      item.slug ?? null,
      item.filePath ?? null,
      item.mediaPath ?? null,
    ]
  )
}

export function getItemBySlug(eventId: string, slug: string): Item | null {
  if (!db) return null

  const stmt = db.prepare(`
    SELECT id, event_id, item_type, content, caption, happened_at,
           place_lat, place_lng, place_label, people, tags, url, body_text, slug, file_path, media_path
    FROM items WHERE event_id = ? AND slug = ?
  `)
  stmt.bind([eventId, slug])

  if (!stmt.step()) {
    stmt.free()
    return null
  }

  const row = stmt.get()
  stmt.free()

  return {
    id: row[0] as string,
    eventId: row[1] as string,
    itemType: row[2] as Item['itemType'],
    content: row[3] as string,
    caption: row[4] as string | undefined,
    happenedAt: row[5] as string | undefined,
    place: row[6] != null ? {
      lat: row[6] as number,
      lng: row[7] as number,
      label: row[8] as string | undefined,
    } : undefined,
    people: row[9] ? JSON.parse(row[9] as string) : undefined,
    tags: row[10] ? JSON.parse(row[10] as string) : undefined,
    url: row[11] as string | undefined,
    bodyText: row[12] as string | undefined,
    slug: row[13] as string | undefined,
    filePath: row[14] as string | undefined,
    mediaPath: row[15] as string | undefined,
  }
}
