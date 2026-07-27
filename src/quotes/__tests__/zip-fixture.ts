const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)

  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }

  return table
})()

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff

  for (const byte of buffer) {
    crc = (crc >>> 8) ^ (CRC32_TABLE[(crc ^ byte) & 0xff] ?? 0)
  }

  return (crc ^ 0xffffffff) >>> 0
}

/**
 * Builds a single-entry ZIP archive with STORED (uncompressed) content, so parser
 * tests can exercise the real zip reader without pulling in a zip-writing dependency.
 */
export function createStoredZip(entryName: string, content: string): Buffer {
  const nameBytes = Buffer.from(entryName, 'utf8')
  const data = Buffer.from(content, 'utf8')
  const checksum = crc32(data)

  const localHeader = Buffer.alloc(30)
  localHeader.writeUInt32LE(0x04034b50, 0) // local file header signature
  localHeader.writeUInt16LE(20, 4) // version needed
  localHeader.writeUInt16LE(0, 6) // flags
  localHeader.writeUInt16LE(0, 8) // compression method: stored
  localHeader.writeUInt16LE(0, 10) // mod time
  localHeader.writeUInt16LE(0, 12) // mod date
  localHeader.writeUInt32LE(checksum, 14)
  localHeader.writeUInt32LE(data.length, 18) // compressed size
  localHeader.writeUInt32LE(data.length, 22) // uncompressed size
  localHeader.writeUInt16LE(nameBytes.length, 26)
  localHeader.writeUInt16LE(0, 28) // extra field length

  const centralHeader = Buffer.alloc(46)
  centralHeader.writeUInt32LE(0x02014b50, 0) // central directory header signature
  centralHeader.writeUInt16LE(20, 4) // version made by
  centralHeader.writeUInt16LE(20, 6) // version needed
  centralHeader.writeUInt16LE(0, 8) // flags
  centralHeader.writeUInt16LE(0, 10) // compression method: stored
  centralHeader.writeUInt16LE(0, 12) // mod time
  centralHeader.writeUInt16LE(0, 14) // mod date
  centralHeader.writeUInt32LE(checksum, 16)
  centralHeader.writeUInt32LE(data.length, 20) // compressed size
  centralHeader.writeUInt32LE(data.length, 24) // uncompressed size
  centralHeader.writeUInt16LE(nameBytes.length, 28)
  centralHeader.writeUInt16LE(0, 30) // extra field length
  centralHeader.writeUInt16LE(0, 32) // comment length
  centralHeader.writeUInt16LE(0, 34) // disk number start
  centralHeader.writeUInt16LE(0, 36) // internal attributes
  centralHeader.writeUInt32LE(0, 38) // external attributes
  centralHeader.writeUInt32LE(0, 42) // local header offset

  const centralDirectoryOffset = localHeader.length + nameBytes.length + data.length
  const centralDirectorySize = centralHeader.length + nameBytes.length

  const endOfCentralDirectory = Buffer.alloc(22)
  endOfCentralDirectory.writeUInt32LE(0x06054b50, 0) // EOCD signature
  endOfCentralDirectory.writeUInt16LE(0, 4) // disk number
  endOfCentralDirectory.writeUInt16LE(0, 6) // central directory start disk
  endOfCentralDirectory.writeUInt16LE(1, 8) // entries on this disk
  endOfCentralDirectory.writeUInt16LE(1, 10) // total entries
  endOfCentralDirectory.writeUInt32LE(centralDirectorySize, 12)
  endOfCentralDirectory.writeUInt32LE(centralDirectoryOffset, 16)
  endOfCentralDirectory.writeUInt16LE(0, 20) // comment length

  return Buffer.concat([localHeader, nameBytes, data, centralHeader, nameBytes, endOfCentralDirectory])
}
