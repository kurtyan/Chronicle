/**
 * A deliberately small ZIP reader/writer for Chronicle backup bundles.
 *
 * We only emit and accept ZIP_STORED entries. That keeps the backup format
 * dependency-free and, more importantly, prevents compressed zip bombs during
 * import. A bundle is an interchange format owned by Chronicle rather than a
 * general-purpose archive extractor.
 */
import path from 'path'

export interface ZipEntry {
  name: string
  data: Buffer
}

const LOCAL_FILE_HEADER = 0x04034b50
const CENTRAL_DIRECTORY_HEADER = 0x02014b50
const END_OF_CENTRAL_DIRECTORY = 0x06054b50
const MAX_ENTRY_BYTES = 1024 * 1024 * 1024
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024

let crcTable: number[] | null = null

function crc32(data: Buffer): number {
  if (!crcTable) {
    crcTable = Array.from({ length: 256 }, (_, index) => {
      let value = index
      for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1)
      return value >>> 0
    })
  }
  let value = 0xffffffff
  for (const byte of data) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

function assertSafeEntryName(name: string): void {
  if (!name || name.includes('\0') || name.includes('\\')) throw new Error('Invalid backup entry path')
  const normalized = path.posix.normalize(name)
  if (normalized !== name || normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../')) {
    throw new Error('Unsafe backup entry path')
  }
}

function writeUInt16(buffer: Buffer, value: number, offset: number) {
  buffer.writeUInt16LE(value, offset)
}

function writeUInt32(buffer: Buffer, value: number, offset: number) {
  buffer.writeUInt32LE(value >>> 0, offset)
}

export function createStoredZip(entries: ZipEntry[]): Buffer {
  const names = new Set<string>()
  let total = 0
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    assertSafeEntryName(entry.name)
    if (names.has(entry.name)) throw new Error(`Duplicate backup entry: ${entry.name}`)
    if (entry.data.length > MAX_ENTRY_BYTES) throw new Error(`Backup entry is too large: ${entry.name}`)
    names.add(entry.name)
    total += entry.data.length
    if (total > MAX_TOTAL_BYTES) throw new Error('Backup is too large')

    const name = Buffer.from(entry.name, 'utf8')
    const checksum = crc32(entry.data)
    const local = Buffer.alloc(30)
    writeUInt32(local, LOCAL_FILE_HEADER, 0)
    writeUInt16(local, 20, 4)
    writeUInt16(local, 0, 6)
    writeUInt16(local, 0, 8) // stored; never compressed
    writeUInt16(local, 0, 10)
    writeUInt16(local, 0, 12)
    writeUInt32(local, checksum, 14)
    writeUInt32(local, entry.data.length, 18)
    writeUInt32(local, entry.data.length, 22)
    writeUInt16(local, name.length, 26)
    writeUInt16(local, 0, 28)
    localParts.push(local, name, entry.data)

    const central = Buffer.alloc(46)
    writeUInt32(central, CENTRAL_DIRECTORY_HEADER, 0)
    writeUInt16(central, 20, 4)
    writeUInt16(central, 20, 6)
    writeUInt16(central, 0, 8)
    writeUInt16(central, 0, 10)
    writeUInt16(central, 0, 12)
    writeUInt16(central, 0, 14)
    writeUInt32(central, checksum, 16)
    writeUInt32(central, entry.data.length, 20)
    writeUInt32(central, entry.data.length, 24)
    writeUInt16(central, name.length, 28)
    writeUInt16(central, 0, 30)
    writeUInt16(central, 0, 32)
    writeUInt16(central, 0, 34)
    writeUInt16(central, 0, 36)
    writeUInt32(central, 0, 38)
    writeUInt32(central, offset, 42)
    centralParts.push(central, name)
    offset += local.length + name.length + entry.data.length
  }

  const centralSize = centralParts.reduce((size, part) => size + part.length, 0)
  const footer = Buffer.alloc(22)
  writeUInt32(footer, END_OF_CENTRAL_DIRECTORY, 0)
  writeUInt16(footer, 0, 4)
  writeUInt16(footer, 0, 6)
  writeUInt16(footer, entries.length, 8)
  writeUInt16(footer, entries.length, 10)
  writeUInt32(footer, centralSize, 12)
  writeUInt32(footer, offset, 16)
  writeUInt16(footer, 0, 20)
  return Buffer.concat([...localParts, ...centralParts, footer])
}

export function readStoredZip(buffer: Buffer): Map<string, Buffer> {
  // EOCD must be within the final 64 KiB of a ZIP file.
  let eocdOffset = -1
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 0xffff - 22); offset -= 1) {
    if (buffer.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) {
      eocdOffset = offset
      break
    }
  }
  if (eocdOffset < 0 || eocdOffset + 22 > buffer.length) throw new Error('Invalid backup ZIP')

  const entriesCount = buffer.readUInt16LE(eocdOffset + 10)
  const centralSize = buffer.readUInt32LE(eocdOffset + 12)
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16)
  if (centralOffset + centralSize > eocdOffset) throw new Error('Invalid backup ZIP directory')

  const entries = new Map<string, Buffer>()
  let offset = centralOffset
  let total = 0
  for (let index = 0; index < entriesCount; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_DIRECTORY_HEADER) throw new Error('Invalid backup ZIP entry')
    const method = buffer.readUInt16LE(offset + 10)
    const checksum = buffer.readUInt32LE(offset + 16)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const uncompressedSize = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength
    if (nextOffset > buffer.length || method !== 0 || compressedSize !== uncompressedSize || uncompressedSize > MAX_ENTRY_BYTES) {
      throw new Error('Unsupported or unsafe backup ZIP entry')
    }
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    assertSafeEntryName(name)
    if (entries.has(name)) throw new Error(`Duplicate backup entry: ${name}`)
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL_FILE_HEADER) throw new Error('Invalid backup ZIP local entry')
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength
    if (dataOffset + uncompressedSize > buffer.length) throw new Error('Truncated backup ZIP entry')
    const data = buffer.subarray(dataOffset, dataOffset + uncompressedSize)
    if (crc32(data) !== checksum) throw new Error(`Corrupt backup entry: ${name}`)
    total += data.length
    if (total > MAX_TOTAL_BYTES) throw new Error('Backup is too large')
    entries.set(name, Buffer.from(data))
    offset = nextOffset
  }
  return entries
}
