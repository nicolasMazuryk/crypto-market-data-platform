import { readGzipLines } from './gz-stream.js'
import { readTarGzipLines } from './tar-gz-stream.js'
import { readZipLines } from './zip-stream.js'

export function readArchiveLines(filePath: string): AsyncIterable<string> {
  if (filePath.endsWith('.tar.gz')) {
    return readTarGzipLines(filePath)
  }

  if (filePath.endsWith('.csv.gz') || filePath.endsWith('.gz')) {
    return readGzipLines(filePath)
  }

  if (filePath.endsWith('.zip')) {
    return readZipLines(filePath)
  }

  throw new Error(`Unsupported file extension: ${filePath}`)
}
