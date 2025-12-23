/**
 * EXIF metadata extraction utility
 * Extracts GPS coordinates and date taken from JPEG images
 */

export interface ExifData {
  dateTaken?: string      // ISO date string
  location?: {
    lat: number
    lng: number
  }
  orientation?: number    // 1-8, for rotation correction
}

// Read a 32-bit unsigned int (big endian or little endian)
function readUint32(dataView: DataView, offset: number, littleEndian: boolean): number {
  return dataView.getUint32(offset, littleEndian)
}

// Read a 16-bit unsigned int (big endian or little endian)
function readUint16(dataView: DataView, offset: number, littleEndian: boolean): number {
  return dataView.getUint16(offset, littleEndian)
}

// Convert GPS coordinate from degrees/minutes/seconds to decimal
function convertGpsToDecimal(
  degrees: number,
  minutes: number,
  seconds: number,
  ref: string
): number {
  let decimal = degrees + minutes / 60 + seconds / 3600
  if (ref === 'S' || ref === 'W') {
    decimal = -decimal
  }
  return decimal
}

// Read a rational value (two 32-bit integers: numerator/denominator)
function readRational(dataView: DataView, offset: number, littleEndian: boolean): number {
  const numerator = readUint32(dataView, offset, littleEndian)
  const denominator = readUint32(dataView, offset + 4, littleEndian)
  return denominator !== 0 ? numerator / denominator : 0
}

// Read an ASCII string from the buffer
function readAsciiString(dataView: DataView, offset: number, length: number): string {
  let str = ''
  for (let i = 0; i < length; i++) {
    const charCode = dataView.getUint8(offset + i)
    if (charCode === 0) break // Null terminator
    str += String.fromCharCode(charCode)
  }
  return str
}

// Parse EXIF date string (YYYY:MM:DD HH:MM:SS) to ISO format
function parseExifDate(exifDate: string): string | undefined {
  // Format: "2024:08:15 14:30:00"
  const match = exifDate.match(/^(\d{4}):(\d{2}):(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/)
  if (!match) return undefined

  const [, year, month, day, hour, minute, second] = match
  return `${year}-${month}-${day}T${hour}:${minute}:${second}`
}

// IFD Tag IDs
const TAG_ORIENTATION = 0x0112
const TAG_EXIF_IFD = 0x8769
const TAG_GPS_IFD = 0x8825
const TAG_DATE_TIME_ORIGINAL = 0x9003
const TAG_GPS_LATITUDE_REF = 0x0001
const TAG_GPS_LATITUDE = 0x0002
const TAG_GPS_LONGITUDE_REF = 0x0003
const TAG_GPS_LONGITUDE = 0x0004

interface IfdEntry {
  tag: number
  type: number
  count: number
  valueOffset: number
}

function readIfdEntry(dataView: DataView, offset: number, littleEndian: boolean): IfdEntry {
  return {
    tag: readUint16(dataView, offset, littleEndian),
    type: readUint16(dataView, offset + 2, littleEndian),
    count: readUint32(dataView, offset + 4, littleEndian),
    valueOffset: offset + 8,
  }
}

function getEntryValue(
  dataView: DataView,
  entry: IfdEntry,
  tiffOffset: number,
  littleEndian: boolean
): number | string | number[] | undefined {
  const { type, count, valueOffset } = entry

  // Type sizes: 1=BYTE, 2=ASCII, 3=SHORT, 4=LONG, 5=RATIONAL
  const typeSizes: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8 }
  const totalSize = (typeSizes[type] || 0) * count

  // If total size > 4 bytes, valueOffset contains a pointer
  const dataOffset = totalSize > 4
    ? tiffOffset + readUint32(dataView, valueOffset, littleEndian)
    : valueOffset

  switch (type) {
    case 2: // ASCII
      return readAsciiString(dataView, dataOffset, count)
    case 3: // SHORT
      return readUint16(dataView, dataOffset, littleEndian)
    case 4: // LONG
      return readUint32(dataView, dataOffset, littleEndian)
    case 5: // RATIONAL (array of rationals for GPS)
      if (count === 3) {
        // GPS coordinates: degrees, minutes, seconds
        return [
          readRational(dataView, dataOffset, littleEndian),
          readRational(dataView, dataOffset + 8, littleEndian),
          readRational(dataView, dataOffset + 16, littleEndian),
        ]
      }
      return readRational(dataView, dataOffset, littleEndian)
    default:
      return undefined
  }
}

function parseIfd(
  dataView: DataView,
  ifdOffset: number,
  tiffOffset: number,
  littleEndian: boolean
): Map<number, number | string | number[] | undefined> {
  const entries = new Map<number, number | string | number[] | undefined>()

  const entryCount = readUint16(dataView, ifdOffset, littleEndian)

  for (let i = 0; i < entryCount; i++) {
    const entryOffset = ifdOffset + 2 + i * 12
    const entry = readIfdEntry(dataView, entryOffset, littleEndian)
    const value = getEntryValue(dataView, entry, tiffOffset, littleEndian)
    entries.set(entry.tag, value)
  }

  return entries
}

/**
 * Extract EXIF metadata from a File object
 * Returns GPS coordinates, date taken, and orientation
 */
export async function extractExifData(file: File): Promise<ExifData> {
  const result: ExifData = {}

  // Only process JPEG files
  if (!file.type.startsWith('image/jpeg') && !file.name.toLowerCase().endsWith('.jpg') && !file.name.toLowerCase().endsWith('.jpeg')) {
    return result
  }

  try {
    const buffer = await file.arrayBuffer()
    const dataView = new DataView(buffer)

    // Check for JPEG magic bytes
    if (dataView.getUint16(0) !== 0xFFD8) {
      return result
    }

    // Find EXIF segment (APP1 marker: 0xFFE1)
    let offset = 2
    while (offset < dataView.byteLength - 4) {
      const marker = dataView.getUint16(offset)

      if (marker === 0xFFE1) {
        // Found APP1 segment
        // Note: segmentLength could be used for bounds checking but we rely on try/catch
        const _segmentLength = dataView.getUint16(offset + 2)
        void _segmentLength  // Acknowledge unused for now

        // Check for "Exif\0\0" header
        const exifHeader = readAsciiString(dataView, offset + 4, 4)
        if (exifHeader === 'Exif') {
          const tiffOffset = offset + 10 // Start of TIFF header

          // Check TIFF byte order
          const byteOrder = dataView.getUint16(tiffOffset)
          const littleEndian = byteOrder === 0x4949 // 'II' = Intel = little endian

          // Verify TIFF magic number (42)
          if (readUint16(dataView, tiffOffset + 2, littleEndian) !== 42) {
            return result
          }

          // Get IFD0 offset
          const ifd0Offset = tiffOffset + readUint32(dataView, tiffOffset + 4, littleEndian)

          // Parse IFD0
          const ifd0 = parseIfd(dataView, ifd0Offset, tiffOffset, littleEndian)

          // Get orientation
          const orientation = ifd0.get(TAG_ORIENTATION)
          if (typeof orientation === 'number') {
            result.orientation = orientation
          }

          // Get EXIF IFD offset and parse it
          const exifIfdPointer = ifd0.get(TAG_EXIF_IFD)
          if (typeof exifIfdPointer === 'number') {
            const exifIfdOffset = tiffOffset + exifIfdPointer
            const exifIfd = parseIfd(dataView, exifIfdOffset, tiffOffset, littleEndian)

            // Get DateTimeOriginal
            const dateTimeOriginal = exifIfd.get(TAG_DATE_TIME_ORIGINAL)
            if (typeof dateTimeOriginal === 'string') {
              result.dateTaken = parseExifDate(dateTimeOriginal)
            }
          }

          // Get GPS IFD offset and parse it
          const gpsIfdPointer = ifd0.get(TAG_GPS_IFD)
          if (typeof gpsIfdPointer === 'number') {
            const gpsIfdOffset = tiffOffset + gpsIfdPointer
            const gpsIfd = parseIfd(dataView, gpsIfdOffset, tiffOffset, littleEndian)

            const latRef = gpsIfd.get(TAG_GPS_LATITUDE_REF)
            const lat = gpsIfd.get(TAG_GPS_LATITUDE)
            const lngRef = gpsIfd.get(TAG_GPS_LONGITUDE_REF)
            const lng = gpsIfd.get(TAG_GPS_LONGITUDE)

            if (
              typeof latRef === 'string' &&
              Array.isArray(lat) &&
              typeof lngRef === 'string' &&
              Array.isArray(lng)
            ) {
              result.location = {
                lat: convertGpsToDecimal(lat[0], lat[1], lat[2], latRef),
                lng: convertGpsToDecimal(lng[0], lng[1], lng[2], lngRef),
              }
            }
          }
        }
        break
      }

      // Move to next segment
      if ((marker & 0xFF00) !== 0xFF00) {
        break
      }

      const segmentLength = dataView.getUint16(offset + 2)
      offset += 2 + segmentLength
    }
  } catch (error) {
    console.warn('Failed to extract EXIF data:', error)
  }

  return result
}

/**
 * Get a human-readable location label from coordinates using reverse geocoding
 * Uses OpenStreetMap Nominatim API (free, no API key required)
 */
export async function reverseGeocode(lat: number, lng: number): Promise<string | undefined> {
  try {
    const response = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=14`,
      {
        headers: {
          'User-Agent': 'MemoryLane/1.0',
        },
      }
    )

    if (!response.ok) return undefined

    const data = await response.json()

    // Build a short label from the address
    const address = data.address || {}
    const parts: string[] = []

    // Try to get a meaningful short name
    if (address.city || address.town || address.village) {
      parts.push(address.city || address.town || address.village)
    }
    if (address.country) {
      parts.push(address.country)
    }

    return parts.length > 0 ? parts.join(', ') : data.display_name?.split(',').slice(0, 2).join(',')
  } catch (error) {
    console.warn('Reverse geocoding failed:', error)
    return undefined
  }
}
